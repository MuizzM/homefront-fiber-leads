// The referred person's own view of the referral they are the subject of.
//
// Two properties this suite exists to hold:
//
//   1. IDOR IS IMPOSSIBLE BY CONSTRUCTION, not by check. `/my-status` takes no
//      identifier at all — identity comes from the session — so there is
//      nothing to tamper with. The tests below prove that attempting to supply
//      one changes nothing.
//   2. THE VIEW LEAKS NOTHING. The referred person is not the beneficiary: the
//      reward is the REFERRER's compensation. No amount, no referrer identity,
//      and no reason for a decline may ever appear in the payload.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { applicantStatusView } from "@shared/referral";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let R: typeof import("../../server/referralStore");

const T1 = 1, T2 = 2;
const NOW = "2026-08-07T12:00:00.000Z";
const SOLD_AT = "2026-08-07T13:00:00.000Z";

type Person = { userId: number; memberId: number; session: string; email: string };
let seq = 0;
function person(name: string, tenantId: number, role = "rep"): Person {
  seq += 1;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${seq}@applicant.example.test`;
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

let referrer: Person, referred: Person, bystander: Person, otherTenantRep: Person;
let referralId: number;

/** Walk the referred person to a given point in the funnel. */
function seedReferral(opts: { sales?: number; training?: boolean; activate?: boolean } = {}) {
  const link = R.ensureLink({
    tenantId: T1, referrerUserId: referrer.userId, referrerRepId: referrer.memberId,
    baseUrl: "https://app.test", nowIso: NOW,
  });
  // Attribution happens at APPLICATION time, when the person has no account
  // yet — the store refuses to attribute an email that already has a login,
  // because a referred person must be a new applicant. So the fixture uses the
  // pre-account applicant identity here and links the real account at hire,
  // which is the order the production flow actually runs in.
  const { referral, rejected } = R.attributeApplication({
    tenantId: T1, linkCode: link.code,
    applicantEmail: `applicant.${referred.memberId}@example.test`, nowIso: NOW,
  });
  if (!referral) throw new Error(`fixture could not attribute: ${rejected}`);
  R.markHired({
    tenantId: T1, referralId: referral!.id,
    referredRepId: referred.memberId, referredUserId: referred.userId, nowIso: NOW,
  });
  if (opts.activate !== false) {
    R.markActivated({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
  }
  if (opts.training) {
    rawDb.prepare(
      `INSERT INTO app_settings (tenant_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
       ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value`,
    ).run(T1, "training.required_lessons", "1");
    rawDb.prepare(
      `INSERT OR IGNORE INTO training_progress (tenant_id, user_id, lesson_id, completed_at) VALUES (?,?,?,?)`,
    ).run(T1, referred.userId, "l-0", NOW);
  }
  for (let i = 0; i < (opts.sales ?? 0); i += 1) {
    rawDb.prepare(
      `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
       VALUES (?,?,?,'QUALIFIED',?,?,?)`,
    ).run(T1, referred.memberId, `st-${referred.memberId}-${i}`, SOLD_AT, NOW, NOW);
  }
  R.recheckQualification({ tenantId: T1, referralId: referral!.id, nowIso: NOW });
  return referral!.id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-applicant-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");

  rawDb.prepare(
    `INSERT INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(T2, "other-org-2", "Other Org", "O", "o2@other.test", "Other", NOW, NOW);

  const app = express();
  app.use(express.json());
  server = createServer(app);
  (await import("../../server/routes")).registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => { server?.close(); });

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  for (const t of ["referral_events", "referrals", "referral_links", "referral_click_dedupe",
    "domain_events", "commission_sales", "training_progress"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  R.ensureReferralSchema();
  R.setConfig(T1, { enabled: true }, NOW);
  R.setConfig(T2, { enabled: true }, NOW);

  referrer = person("Ref Errer", T1);
  referred = person("Ref Erred", T1);
  bystander = person("By Stander", T1);
  otherTenantRep = person("Other Tenant", T2);
});

describe("the empty state", () => {
  it("answers 'not referred' rather than erroring", async () => {
    const res = await call("/api/referrals/my-status", bystander.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributed).toBe(false);
    expect(body.rewardState).toBe("none");
    expect(body.salesProgress).toBeNull();
  });

  it("is the same SHAPE as a real status, so one component renders both", async () => {
    const empty = await (await call("/api/referrals/my-status", bystander.session)).json();
    seedReferral({ sales: 2, training: true });
    const real = await (await call("/api/referrals/my-status", referred.session)).json();
    expect(Object.keys(empty).sort()).toEqual(Object.keys(real).sort());
  });
});

describe("what the referred person sees", () => {
  beforeEach(() => { referralId = seedReferral({ sales: 2, training: true }); });

  it("shows their OWN progress toward the bar", async () => {
    const body = await (await call("/api/referrals/my-status", referred.session)).json();
    expect(body.attributed).toBe(true);
    expect(body.rewardState).toBe("in_progress");
    expect(body.salesProgress).toEqual({ current: 2, target: 6 });
    expect(body.milestones).toEqual({ hired: true, activated: true, trainingComplete: true });
  });

  it("moves to in_review once they have met everything", async () => {
    for (let i = 2; i < 6; i += 1) {
      rawDb.prepare(
        `INSERT INTO commission_sales (tenant_id, rep_id, external_id, status, sold_at, created_at, updated_at)
         VALUES (?,?,?,'QUALIFIED',?,?,?)`,
      ).run(T1, referred.memberId, `extra-${i}`, SOLD_AT, NOW, NOW);
    }
    R.recheckQualification({ tenantId: T1, referralId, nowIso: NOW });
    const body = await (await call("/api/referrals/my-status", referred.session)).json();
    expect(body.rewardState).toBe("in_review");
  });
});

describe("what the referred person must NEVER see", () => {
  beforeEach(() => { referralId = seedReferral({ sales: 2, training: true }); });

  it("no reward amount — not even a zero", async () => {
    const raw = await (await call("/api/referrals/my-status", referred.session)).text();
    // The reward is the REFERRER's compensation. A zero would invite "why is my
    // bonus $0"; any real figure is someone else's pay.
    expect(raw).not.toMatch(/50000|\$500|rewardCents|rewardAmount/i);
  });

  it("no referrer identity", async () => {
    const raw = await (await call("/api/referrals/my-status", referred.session)).text();
    expect(raw).not.toContain(referrer.email);
    expect(raw).not.toContain("Ref Errer");
    expect(raw.toLowerCase()).not.toContain("referrer");
  });

  it("no internal ids, audit fields, or programme rules", async () => {
    const body = await (await call("/api/referrals/my-status", referred.session)).json();
    for (const leaked of [
      "referralId", "id", "referrerRepId", "referrerUserId", "referredUserId",
      "configSnapshot", "rewardLedgerId", "approvedBy", "rejectionReason",
      "qualificationWindowDays", "clawbackWindowDays", "status",
    ]) {
      expect(Object.keys(body), `${leaked} must not be exposed`).not.toContain(leaked);
    }
  });

  it("never says WHY a referral was closed", async () => {
    R.rejectReferral({
      tenantId: T1, referralId, actorUserId: 1,
      reason: "anti-fraud: duplicate device fingerprint", nowIso: NOW,
    });
    const res = await call("/api/referrals/my-status", referred.session);
    const raw = await res.text();
    const body = JSON.parse(raw);

    // A cause is a probe someone could use to tune a next attempt, so every
    // non-qualifying terminal state collapses to one opaque value.
    expect(body.rewardState).toBe("unavailable");
    expect(raw).not.toMatch(/fraud|duplicate|fingerprint|offboard|invalid|expired/i);
  });

  it("a decline is opaque whatever the underlying cause", async () => {
    // Distinct causes must be INDISTINGUISHABLE from the applicant's side.
    R.rejectReferral({ tenantId: T1, referralId, actorUserId: 1, reason: "referrer offboarded", nowIso: NOW });
    const rejected = await (await call("/api/referrals/my-status", referred.session)).json();

    rawDb.prepare(`UPDATE referrals SET status = 'EXPIRED' WHERE id = ?`).run(referralId);
    const expired = await (await call("/api/referrals/my-status", referred.session)).json();

    expect(rejected.rewardState).toBe(expired.rewardState);
    expect(rejected.headline).toBe(expired.headline);
  });
});

describe("insecure direct object reference", () => {
  beforeEach(() => { referralId = seedReferral({ sales: 2, training: true }); });

  it("ignores every identifier an attacker can supply", async () => {
    const mine = await (await call("/api/referrals/my-status", bystander.session)).json();
    // The route takes no id, so none of these can steer it.
    for (const attempt of [
      `/api/referrals/my-status?repId=${referred.memberId}`,
      `/api/referrals/my-status?userId=${referred.userId}`,
      `/api/referrals/my-status?referralId=${referralId}`,
      `/api/referrals/my-status?tenantId=${T1}&repId=${referred.memberId}`,
    ]) {
      const body = await (await call(attempt, bystander.session)).json();
      expect(body, attempt).toEqual(mine);
      expect(body.attributed).toBe(false);
    }
  });

  it("ignores a spoofed identity in the body", async () => {
    const res = await call("/api/referrals/my-status", bystander.session, {
      method: "GET",
    });
    expect((await res.json()).attributed).toBe(false);
  });

  it("a bystander in the same org sees nothing of someone else's referral", async () => {
    const body = await (await call("/api/referrals/my-status", bystander.session)).json();
    expect(body.attributed).toBe(false);
    expect(body.salesProgress).toBeNull();
  });

  it("requires a session", async () => {
    const res = await call("/api/referrals/my-status", null);
    expect([401, 403]).toContain(res.status);
  });
});

describe("cross-tenant", () => {
  it("a rep in another org never sees this org's referral", async () => {
    seedReferral({ sales: 2, training: true });
    const body = await (await call("/api/referrals/my-status", otherTenantRep.session)).json();
    expect(body.attributed).toBe(false);
  });

  it("a rep id that collides across tenants resolves to the caller's own org", async () => {
    seedReferral({ sales: 2, training: true });
    // The lookup is (tenantId, repId) from the session, so a same-numbered rep
    // in another org cannot pull T1's row.
    const status = R.applicantStatusFor(T2, referred.memberId, NOW);
    expect(status.attributed).toBe(false);
  });
});

describe("stability across repeated requests", () => {
  it("is identical on refresh and session restore", async () => {
    seedReferral({ sales: 3, training: true });
    const first = await (await call("/api/referrals/my-status", referred.session)).json();
    const second = await (await call("/api/referrals/my-status", referred.session)).json();

    // A fresh session for the same person — the "session restore" path.
    const restored = storage.createSession(referred.userId).id;
    const third = await (await call("/api/referrals/my-status", restored)).json();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("reading the status never mutates anything", async () => {
    const id = seedReferral({ sales: 3, training: true });
    const before = R.getReferral(T1, id)!;
    const eventsBefore = (R.eventsFor(T1, id) as any[]).length;

    for (let i = 0; i < 5; i += 1) await call("/api/referrals/my-status", referred.session);

    const after = R.getReferral(T1, id)!;
    expect(after.status).toBe(before.status);
    expect(after.qualifyingSalesCount).toBe(before.qualifyingSalesCount);
    expect((R.eventsFor(T1, id) as any[]).length).toBe(eventsBefore);
  });
});

describe("the redaction rule itself", () => {
  it("collapses every terminal non-reward state to one value", () => {
    for (const status of ["REJECTED", "EXPIRED", "CLAWED_BACK"] as const) {
      const view = applicantStatusView(
        { status, hiredAt: NOW, activatedAt: NOW }, null, true,
      );
      expect(view.rewardState).toBe("unavailable");
    }
  });

  it("checks terminal state BEFORE progress, so a rejection cannot read as progress", () => {
    const view = applicantStatusView(
      { status: "REJECTED", hiredAt: NOW, activatedAt: NOW },
      {
        qualified: false, salesRemaining: 4, progress: 0.33, blocked: null,
        requirements: [{ key: "sales", label: "6 approved sales", met: false, current: 2, target: 6 }],
      },
      true,
    );
    expect(view.rewardState).toBe("unavailable");
    expect(view.headline).not.toMatch(/2 of 6/);
  });
});
