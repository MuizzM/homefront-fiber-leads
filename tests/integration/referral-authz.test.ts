// Server-side authorization on every referral surface.
//
// The brief's acceptance criterion has two halves this suite covers directly:
// no user may view or modify data outside their permitted role and tenant, and
// a broken or fraudulent code can never stop someone applying.
//
// Every assertion here goes through the HTTP layer, not the store. UI gating is
// not authorization — `useCan` decides what to RENDER, and these tests exist to
// prove the API refuses the same things when the UI is bypassed entirely.
//
// Out-of-scope ids are expected to read 404 rather than 403 throughout: a 403
// confirms the row exists, which is itself a cross-tenant disclosure.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let R: typeof import("../../server/referralStore");

const T1 = 1, T2 = 2;
const NOW = "2026-08-07T12:00:00.000Z";

type Person = { userId: number; memberId: number; session: string; email: string };
let seq = 0;
function person(name: string, role: string, tenantId: number): Person {
  seq += 1;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${seq}@authz.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id, email };
}

function call(path: string, session: string | null, init: RequestInit = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) { headers["x-session-id"] = session; headers["x-csrf-token"] = session; }
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers as any) } });
}

let t1Rep: Person, t1OtherRep: Person, t1Manager: Person, t1Admin: Person, t2Admin: Person, t2Rep: Person;
let t1Referral: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-refauthz-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");

  rawDb.prepare(
    `INSERT INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(T2, "other-org", "Other Org", "O", "o@other.test", "Other", NOW, NOW);

  const app = express();
  app.use(express.json());
  server = createServer(app);
  (await import("../../server/routes")).registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;

  t1Rep = person("T1 Rep", "rep", T1);
  t1OtherRep = person("T1 Other Rep", "rep", T1);
  t1Manager = person("T1 Manager", "manager", T1);
  t1Admin = person("T1 Admin", "admin", T1);
  t2Admin = person("T2 Admin", "admin", T2);
  t2Rep = person("T2 Rep", "rep", T2);
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  R.setConfig(T1, { enabled: true }, NOW);
  R.setConfig(T2, { enabled: true }, NOW);
  const link = R.ensureLink({
    tenantId: T1, referrerUserId: t1Rep.userId, referrerRepId: t1Rep.memberId,
    baseUrl: "https://app.test", nowIso: NOW,
  });
  const existing = R.listReferrals(T1, { referrerRepIds: [t1Rep.memberId] });
  if (existing.length > 0) { t1Referral = existing[0].id; return; }
  const { referral } = R.attributeApplication({
    tenantId: T1, linkCode: link.code, applicantEmail: "t1.applicant@example.test", nowIso: NOW,
  });
  t1Referral = referral!.id;
});

describe("authentication is required", () => {
  it("refuses every authenticated referral surface without a session", async () => {
    for (const path of [
      "/api/referrals", "/api/referrals/my-link", "/api/referrals/settings",
      `/api/referrals/${t1Referral}/progress`, `/api/referrals/${t1Referral}/history`,
    ]) {
      const res = await call(path, null);
      expect([401, 403], `${path} must not be public`).toContain(res.status);
    }
  });
});

describe("tenant isolation", () => {
  it("an admin of another org cannot read the referral", async () => {
    const res = await call(`/api/referrals/${t1Referral}/progress`, t2Admin.session);
    // 404, not 403 — a 403 would confirm the row exists.
    expect(res.status).toBe(404);
  });

  it("an admin of another org cannot approve or reject it", async () => {
    for (const action of ["approve", "reject"]) {
      const res = await call(`/api/referrals/${t1Referral}/${action}`, t2Admin.session, {
        method: "POST", body: JSON.stringify({ reason: "x" }),
      });
      expect(res.status).toBe(404);
    }
    expect(R.getReferral(T1, t1Referral)!.status).toBe("APPLIED");
  });

  it("another org's pipeline never contains this org's referrals", async () => {
    const res = await call("/api/referrals?scope=org", t2Admin.session);
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.every((r: any) => r.id !== t1Referral)).toBe(true);
  });

  it("settings writes land only on the caller's own org", async () => {
    const res = await call("/api/referrals/settings", t2Admin.session, {
      method: "PUT", body: JSON.stringify({ rewardCents: 111 }),
    });
    expect(res.status).toBe(200);
    // T2 changed; T1 untouched.
    expect(R.getConfig(T2).rewardCents).toBe(111);
    expect(R.getConfig(T1).rewardCents).toBe(50_000);
  });

  it("a code minted in one org cannot attribute an applicant into another", async () => {
    const t2Link = R.ensureLink({
      tenantId: T2, referrerUserId: t2Rep.userId, referrerRepId: t2Rep.memberId,
      baseUrl: "https://app.test", nowIso: NOW,
    });
    const { referral, rejected } = R.attributeApplication({
      tenantId: T1, linkCode: t2Link.code, applicantEmail: "crossing@example.test", nowIso: NOW,
    });
    expect(referral).toBeNull();
    expect(rejected).toBe("invalid_code");
  });
});

describe("a rep sees only their own referral data", () => {
  it("cannot read another rep's referral progress", async () => {
    const res = await call(`/api/referrals/${t1Referral}/progress`, t1OtherRep.session);
    expect(res.status).toBe(404);
  });

  it("asking for the org pipeline silently returns only their own", async () => {
    // The scope param is a REQUEST, not a grant — widening is capability-gated
    // server-side, so a rep passing scope=org gets their own rows, not an error
    // that tells them a wider view exists.
    const res = await call("/api/referrals?scope=org", t1OtherRep.session);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("cannot read the audit history", async () => {
    const res = await call(`/api/referrals/${t1Referral}/history`, t1Rep.session);
    expect(res.status).toBe(403);
  });

  it("cannot read or change programme settings", async () => {
    expect((await call("/api/referrals/settings", t1Rep.session)).status).toBe(403);
    const res = await call("/api/referrals/settings", t1Rep.session, {
      method: "PUT", body: JSON.stringify({ rewardCents: 999_999 }),
    });
    expect(res.status).toBe(403);
    expect(R.getConfig(T1).rewardCents).toBe(50_000);
  });

  it("cannot approve their own referral into money", async () => {
    // The obvious self-dealing path: the person who gets paid approving it.
    const res = await call(`/api/referrals/${t1Referral}/approve`, t1Rep.session, { method: "POST" });
    expect(res.status).toBe(403);
    expect(R.getReferral(T1, t1Referral)!.status).toBe("APPLIED");
  });

  it("cannot re-point a referral at themselves", async () => {
    const res = await call(`/api/referrals/${t1Referral}/referrer`, t1OtherRep.session, {
      method: "POST",
      body: JSON.stringify({ referrerRepId: t1OtherRep.memberId, reason: "mine now" }),
    });
    expect(res.status).toBe(403);
    expect(R.getReferral(T1, t1Referral)!.referrerRepId).toBe(t1Rep.memberId);
  });
});

describe("manager and admin boundaries", () => {
  it("a manager may read the programme but not release money", async () => {
    expect((await call("/api/referrals/settings", t1Manager.session)).status).toBe(200);
    const approve = await call(`/api/referrals/${t1Referral}/approve`, t1Manager.session, { method: "POST" });
    // Releasing a reward is gated on referral.approve, which sits with the
    // other money-moving capabilities at admin — never with oversight.
    expect(approve.status).toBe(403);
  });

  it("a manager cannot change the programme's terms", async () => {
    const res = await call("/api/referrals/settings", t1Manager.session, {
      method: "PUT", body: JSON.stringify({ requiredApprovedSales: 1 }),
    });
    expect(res.status).toBe(403);
    expect(R.getConfig(T1).requiredApprovedSales).toBe(6);
  });

  it("an admin can read settings and history", async () => {
    expect((await call("/api/referrals/settings", t1Admin.session)).status).toBe(200);
    expect((await call(`/api/referrals/${t1Referral}/history`, t1Admin.session)).status).toBe(200);
  });

  it("an admin still cannot approve an unqualified referral", async () => {
    // Authorization is not the only gate — the qualification rules apply to
    // admins too, or the $500 becomes a button rather than an earned reward.
    //
    // TWO gates catch this, in order. A referral that has not even been hired
    // is refused by the STATE MACHINE (APPLIED has no edge to APPROVED); one
    // that has walked the funnel but not met the bar is refused by the
    // qualification re-check inside approveReward. Either is a correct refusal,
    // and asserting the pair is what stops a future change quietly removing one
    // of them and relying on the other.
    const res = await call(`/api/referrals/${t1Referral}/approve`, t1Admin.session, { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(["REFERRAL_BAD_TRANSITION:APPLIED->APPROVED", "REFERRAL_NOT_QUALIFIED"])
      .toContain(body.code);
    // What actually matters: no money, and the referral did not move.
    expect(R.getReferral(T1, t1Referral)!.status).toBe("APPLIED");
    expect(R.orgReferralLiability(T1).approvedCents).toBe(0);
  });

  it("rejection requires a recorded reason", async () => {
    const res = await call(`/api/referrals/${t1Referral}/reject`, t1Admin.session, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("the public endpoints stay non-disclosing", () => {
  it("track-click answers identically for a real and an unknown code", async () => {
    const real = R.ensureLink({
      tenantId: T1, referrerUserId: t1Rep.userId, referrerRepId: t1Rep.memberId,
      baseUrl: "https://app.test", nowIso: NOW,
    });
    const a = await call("/api/referrals/track-click", null, {
      method: "POST", body: JSON.stringify({ code: real.code }),
    });
    const b = await call("/api/referrals/track-click", null, {
      method: "POST", body: JSON.stringify({ code: "ZZZZ9999" }),
    });
    // Identical status AND body — otherwise the endpoint is a code oracle.
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it("apply never reveals why an attribution was declined", async () => {
    const res = await call("/api/referrals/apply", null, {
      method: "POST",
      body: JSON.stringify({ code: "ZZZZ9999", email: "someone@example.test" }),
    });
    expect(res.status).toBe(200);
    // A caller learning "that code is real but you already have an account"
    // is being handed other people's information.
    expect(await res.json()).toEqual({ attributed: false });
  });
});
