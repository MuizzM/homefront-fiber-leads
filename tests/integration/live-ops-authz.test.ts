/**
 * Live Operations — who may see whose location, and when a position may be
 * recorded at all.
 *
 * The two questions this suite exists to answer, because getting either wrong
 * is a privacy incident rather than a bug:
 *
 *   1. Can a supervisor reach a rep outside their branch? (No, and the refusal
 *      must be a 404, because a 403 confirms the person exists.)
 *   2. Can a position be recorded when the rep is off shift, undisclosed, or
 *      the org never switched collection on? (No, on the server, not merely in
 *      a disabled button.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const TENANT_A = 1;
const TENANT_B = 9302;

let server: Server;
let baseUrl: string;
let storage: any;
let rawDb: any;
let liveStore: any;

interface Person { userId: number; memberId: number; session: string }
let admin: Person;
let mgrA: Person, tlA: Person, repA1: Person, repA2: Person;
let mgrB: Person, tlB: Person, repB1: Person;
let mgrC: Person, repC1: Person;   // a different org entirely

function person(
  name: string, memberRole: string,
  opts: { loginRole?: string; reportsToId?: number | null; tenantId?: number } = {},
): Person {
  const tenantId = opts.tenantId ?? TENANT_A;
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${tenantId}@liveops.example.test`;
  const member = storage.createTeamMember({
    name, email, role: memberRole, active: true, tenantId, reportsToId: opts.reportsToId ?? null,
  } as any);
  const user = storage.createUser({
    name, email, role: opts.loginRole ?? memberRole, active: true, tenantId, teamMemberId: member.id,
  } as any);
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-session-id": session,
      "x-csrf-token": session,
      ...(init.headers ?? {}),
    },
  });
}

/** Put a rep in the only state where a fix may legally be recorded. */
async function makeTrackable(p: Person, tenantId = TENANT_A) {
  liveStore.setFieldLocationPolicy(tenantId, { mode: "default_on" }, admin.userId);
  await req("/api/live-ops/consent/acknowledge", p.session, { method: "POST", body: "{}" });
  storage.clockIn(p.memberId, p.userId);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-liveops-"));
  process.env.NODE_ENV = "test";

  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  liveStore = await import("../../server/liveOpsStore");

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name, status)
     VALUES (?,?,?,?,?,?,'active')`,
  ).run(TENANT_B, "other-org-liveops", "Other Org", "Owner", "owner-liveops@example.test", "Other Org");

  // Branch A            Branch B            Another org
  //   mgrA                mgrB                mgrC
  //   └ tlA               └ tlB               └ repC1
  //     ├ repA1             └ repB1
  //     └ repA2
  admin = person("Ada Admin", "manager", { loginRole: "admin" });
  mgrA = person("Mona Manager A", "manager");
  tlA = person("Tal Lead A", "team_lead", { reportsToId: mgrA.memberId });
  repA1 = person("Rae One", "rep", { reportsToId: tlA.memberId });
  repA2 = person("Rae Two", "rep", { reportsToId: tlA.memberId });
  mgrB = person("Milo Manager B", "manager");
  tlB = person("Tess Lead B", "team_lead", { reportsToId: mgrB.memberId });
  repB1 = person("Bex One", "rep", { reportsToId: tlB.memberId });
  mgrC = person("Cal Manager C", "manager", { tenantId: TENANT_B });
  repC1 = person("Cyd One", "rep", { reportsToId: mgrC.memberId, tenantId: TENANT_B });

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const repIds = async (session: string) => {
  const res = await req("/api/live-ops/reps", session);
  const body = await res.json();
  return (body.reps ?? []).map((r: any) => r.repId).sort((a: number, b: number) => a - b);
};

describe("supervisor scope", () => {
  it("an admin sees every rep in their org", async () => {
    const ids = await repIds(admin.session);
    for (const p of [mgrA, tlA, repA1, repA2, mgrB, tlB, repB1]) {
      expect(ids).toContain(p.memberId);
    }
  });

  it("a manager sees their own branch", async () => {
    const ids = await repIds(mgrA.session);
    expect(ids).toEqual(expect.arrayContaining([mgrA.memberId, tlA.memberId, repA1.memberId, repA2.memberId]));
  });

  it("...and NOT the other manager's branch - the gap this feature closes", async () => {
    const ids = await repIds(mgrA.session);
    for (const outsider of [mgrB.memberId, tlB.memberId, repB1.memberId]) {
      expect(ids).not.toContain(outsider);
    }
  });

  it("a team lead sees their subtree", async () => {
    const ids = await repIds(tlA.session);
    expect(ids).toEqual(expect.arrayContaining([tlA.memberId, repA1.memberId, repA2.memberId]));
    expect(ids).not.toContain(mgrA.memberId);   // never upward
    expect(ids).not.toContain(repB1.memberId);  // never sideways
  });

  it("a rep is refused the supervisor board outright", async () => {
    // Not "scoped to one row" - refused. A rep has no business calling a
    // roster-wide endpoint, and least privilege is the door being locked
    // rather than the room beyond it happening to be empty.
    const res = await req("/api/live-ops/reps", repA1.session);
    expect(res.status).toBe(403);
  });

  it("...but can always read their OWN tracking state", async () => {
    const res = await req("/api/live-ops/me", repA1.session);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tracking: expect.any(Boolean), reason: expect.any(String) });
  });

  it("no org can see another org's reps", async () => {
    const ids = await repIds(mgrC.session);
    expect(ids).toContain(repC1.memberId);
    for (const p of [mgrA, tlA, repA1, repB1]) expect(ids).not.toContain(p.memberId);
  });

  it("the presence table obeys the same scope", async () => {
    const res = await req("/api/live-ops/presence", mgrA.session);
    const { rows } = await res.json();
    const seen = rows.map((r: any) => r.repId);
    expect(seen).toContain(repA1.memberId);
    expect(seen).not.toContain(repB1.memberId);
  });

  it("presence never exposes a session token, IP, or user agent", async () => {
    const res = await req("/api/live-ops/presence", admin.session);
    const body = await res.json();
    const serialized = JSON.stringify(body);
    for (const secret of [admin.session, repA1.session, "userAgent", "ipAddress", "sessionId"]) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe("history export", () => {
  it("is refused to a supervisor without the export capability", async () => {
    const res = await req(`/api/live-ops/rep/${repA1.memberId}/track?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`, mgrA.session);
    expect(res.status).toBe(403);
  });

  it("answers 404 - not 403 - for a rep outside the caller's world", async () => {
    // A 403 would confirm the rep exists, which is itself a disclosure about
    // someone the caller is not entitled to know about.
    const res = await req(`/api/live-ops/rep/${repC1.memberId}/track?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`, admin.session);
    expect(res.status).toBe(404);
  });

  it("writes an append-only audit row naming the range and row count", async () => {
    const url = `/api/live-ops/rep/${repA1.memberId}/track?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z`;
    const res = await req(url, admin.session);
    expect(res.status).toBe(200);

    const row = rawDb.prepare(
      `SELECT action, target_id AS targetId, after_json AS afterJson
         FROM admin_audit WHERE action = 'liveops.location_exported'
        ORDER BY id DESC LIMIT 1`,
    ).get();
    expect(row?.action).toBe("liveops.location_exported");
    expect(Number(row.targetId)).toBe(repA1.memberId);
    expect(JSON.parse(row.afterJson)).toMatchObject({ rowCount: expect.any(Number) });
  });

  it("rejects a range that is not a pair of timestamps", async () => {
    const res = await req(`/api/live-ops/rep/${repA1.memberId}/track?from=yesterday&to=today`, admin.session);
    expect(res.status).toBe(400);
  });
});

describe("a position may only be recorded on shift, disclosed, and switched on", () => {
  const fix = (over: any = {}) => ({
    method: "POST",
    body: JSON.stringify({ lat: 35.5, lng: -80.4, accuracyM: 8, ...over }),
  });

  it("refuses while the org has collection switched off - the shipped default", async () => {
    liveStore.setFieldLocationPolicy(TENANT_A, { mode: "off" }, admin.userId);
    const res = await req("/api/live-ops/ping", repA1.session, fix());
    expect(await res.json()).toMatchObject({ stored: false, reason: "policy-off" });
  });

  it("refuses before the rep has been shown the disclosure, even with policy ON", async () => {
    // This is what keeps "default on" from meaning "secretly on".
    liveStore.setFieldLocationPolicy(TENANT_A, { mode: "default_on" }, admin.userId);
    const res = await req("/api/live-ops/ping", repA2.session, fix());
    expect(await res.json()).toMatchObject({ stored: false, reason: "not-disclosed" });
  });

  it("refuses off shift, on the SERVER, not merely in a disabled button", async () => {
    await req("/api/live-ops/consent/acknowledge", repA2.session, { method: "POST", body: "{}" });
    const res = await req("/api/live-ops/ping", repA2.session, fix());
    expect(await res.json()).toMatchObject({ stored: false, reason: "not-clocked-in" });
  });

  it("accepts once policy, disclosure and an open shift all hold", async () => {
    await makeTrackable(repA1);
    const res = await req("/api/live-ops/ping", repA1.session, fix());
    expect(await res.json()).toMatchObject({ stored: true });
  });

  it("stops the moment the rep clocks out, and leaves no live position behind", async () => {
    const before = rawDb.prepare(`SELECT COUNT(*) AS n FROM rep_location_state WHERE rep_id = ?`).get(repA1.memberId);
    expect(before.n).toBe(1);

    await req("/api/clock/out", repA1.session, { method: "POST", body: "{}" });

    const after = rawDb.prepare(`SELECT COUNT(*) AS n FROM rep_location_state WHERE rep_id = ?`).get(repA1.memberId);
    expect(after.n).toBe(0);

    const res = await req("/api/live-ops/ping", repA1.session, fix({ lat: 35.6, lng: -80.5 }));
    expect(await res.json()).toMatchObject({ stored: false, reason: "not-clocked-in" });
  });

  it("a rep's pause suppresses collection while it lasts", async () => {
    await makeTrackable(repA2);
    await req("/api/live-ops/consent/pause", repA2.session, {
      method: "POST", body: JSON.stringify({ paused: true }),
    });
    const paused = await req("/api/live-ops/ping", repA2.session, fix({ lat: 35.71, lng: -80.71 }));
    expect(await paused.json()).toMatchObject({ stored: false, reason: "paused" });

    await req("/api/live-ops/consent/pause", repA2.session, {
      method: "POST", body: JSON.stringify({ paused: false }),
    });
    const resumed = await req("/api/live-ops/ping", repA2.session, fix({ lat: 35.72, lng: -80.72 }));
    expect(await resumed.json()).toMatchObject({ stored: true });
  });

  it("a rep can always read WHY they are or are not being tracked", async () => {
    const res = await req("/api/live-ops/me", repA2.session);
    const body = await res.json();
    expect(body).toMatchObject({
      tracking: expect.any(Boolean),
      reason: expect.any(String),
      retentionDays: expect.any(Number),
      canPause: expect.any(Boolean),
    });
  });

  it("a ping is only ever about the caller - nobody may file one for another rep", async () => {
    // The old route let any non-rep role pass repId in the body, producing a
    // movement record attributed to a person who never reported it.
    await makeTrackable(repB1);
    const res = await req("/api/location-pings", mgrA.session, fix({ repId: repB1.memberId, lat: 35.9, lng: -80.9 }));
    expect(res.status).toBeLessThan(500);
    const stateB = rawDb.prepare(`SELECT lat FROM rep_location_state WHERE rep_id = ?`).get(repB1.memberId);
    expect(stateB?.lat).not.toBe(35.9);
  });

  it("a coordinate of exactly zero is a real place, not a missing value", async () => {
    // `!lat || !lng` rejected the Gulf of Guinea. Zero is falsy; it is also a
    // location.
    await makeTrackable(repA1);
    const res = await req("/api/live-ops/ping", repA1.session, fix({ lat: 0, lng: 0 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: true });
  });
});

describe("policy administration", () => {
  it("is refused to a manager", async () => {
    const res = await req("/api/live-ops/policy", mgrA.session, {
      method: "PATCH", body: JSON.stringify({ mode: "locked_on" }),
    });
    expect(res.status).toBe(403);
  });

  it("records who switched tracking on, and from what", async () => {
    const res = await req("/api/live-ops/policy", admin.session, {
      method: "PATCH", body: JSON.stringify({ mode: "locked_on", retentionDays: 7 }),
    });
    expect(res.status).toBe(200);
    const row = rawDb.prepare(
      `SELECT before_json AS beforeJson, after_json AS afterJson
         FROM admin_audit WHERE action = 'liveops.policy_changed' ORDER BY id DESC LIMIT 1`,
    ).get();
    expect(JSON.parse(row.afterJson)).toMatchObject({ mode: "locked_on" });
    expect(JSON.parse(row.beforeJson)).toMatchObject({ mode: expect.any(String) });
  });

  it("clamps a retention window rather than trusting it", async () => {
    const res = await req("/api/live-ops/policy", admin.session, {
      method: "PATCH", body: JSON.stringify({ retentionDays: 99999 }),
    });
    const body = await res.json();
    expect(body.retentionDays).toBeLessThanOrEqual(90);
    expect(body.retentionDays).toBeGreaterThanOrEqual(1);
  });
});
