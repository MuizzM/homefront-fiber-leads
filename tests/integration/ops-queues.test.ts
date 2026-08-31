// ── Operations command center: the queue rules under test ────────────────────
// Every queue is a deterministic rule the UI renders verbatim; these tests pin
// that the SQL does exactly what the rule says - per queue, per tenant wall,
// per scope (team_lead sees only their reports' work, and never the
// manager-only queues), plus the dismiss-with-reason lifecycle and the new
// bulk-assign undo token.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let clearOpsMemo: () => void;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, reportsToId?: number): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@opsqueues.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function get(path: string, session: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });
}
function post(path: string, session: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}

const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

let addrSeq = 1;
function seedLead(over: Record<string, unknown> = {}, tenantId = 1): number {
  const lead = storage.createLead({
    address: `${addrSeq++} Ops Court`, city: "Rockwell", state: "NC", zip: "28138",
    lat: 35.55, lng: -80.4, tenantId, leadStatus: "prospect",
  } as any);
  const keys = Object.keys(over);
  if (keys.length) {
    const sets = keys.map(k => `${k} = ?`).join(", ");
    rawDb.prepare(`UPDATE leads SET ${sets} WHERE id = ?`).run(...keys.map(k => (over as any)[k]), lead.id);
  }
  return lead.id;
}

function seedKnock(leadId: number, over: Record<string, unknown> = {}, tenantId = 1): void {
  rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, tenant_id, knocked_at, outcome, was_home, callback_date, callback_time, superseded)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    leadId,
    (over.rep_id as number) ?? fx.rep.memberId,
    tenantId,
    over.knocked_at ?? iso(24 * HOUR),
    over.outcome ?? "follow_up",
    over.callback_date ?? null,
    over.callback_time ?? null,
    over.superseded ?? 0,
  );
}

async function queue(key: string, session: string, params = "") {
  const res = await get(`/api/ops/queue/${key}${params}`, session);
  expect(res.status).toBe(200);
  return res.json();
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-opsqueues-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (mod as any).rawDb ?? (await import("../../server/db")).rawDb;
  clearOpsMemo = (await import("../../server/opsQueues")).__clearOpsMemoForTests;

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;

  fx.manager = person("Mara Manager", "manager");
  fx.lead = person("Tess TeamLead", "team_lead");
  fx.rep = person("Dana Doors", "rep", 1, fx.lead.memberId);
  fx.otherRep = person("Omar Other", "rep", 1); // NOT under Tess
  fx.fieldRep = person("Riley Rep", "rep");
  // Training complete, so the refusal below is the CAPABILITY denial, not the
  // training gate answering first.
  rawDb.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run(fx.fieldRep.userId);
  fx.foreignManager = person("Frida Foreign", "manager", 2);
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(() => {
  clearOpsMemo();
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM knock_log").run();
  rawDb.prepare("DELETE FROM ops_dismissals").run();
  rawDb.prepare("DELETE FROM activity_log").run();
  rawDb.prepare("DELETE FROM clock_sessions").run();
});

describe("access", () => {
  it("a rep is refused with the gating capability named", async () => {
    const res = await get("/api/ops/overview", fx.fieldRep.session);
    expect(res.status).toBe(403);
    expect((await res.json()).need).toBe("dashboard.read.team");
  });

  it("a team lead gets the overview WITHOUT the manager-only queues", async () => {
    const body = await (await get("/api/ops/overview", fx.lead.session)).json();
    const keys = body.queues.map((q: any) => q.key);
    expect(keys).toContain("assigned_unworked");
    expect(keys).not.toContain("unassigned_hot");
    expect(keys).not.toContain("territory_link_conflicts");
    expect(keys).not.toContain("partial_writes");
    const q = await get("/api/ops/queue/unassigned_hot", fx.lead.session);
    expect(q.status).toBe(404);
  });
});

describe("assigned_unworked - the flagship rule", () => {
  it("matches exactly: assigned past the window with no activity since assignment", async () => {
    const inQueue = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR) });
    const workedAfter = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR), last_outcome_at: iso(2 * HOUR), last_outcome: "not_home" });
    const tooRecent = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(1 * HOUR) });
    const soldLead = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR), lead_status: "sold" });
    const workedBeforeReassign = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR), last_outcome_at: iso(100 * HOUR), last_outcome: "not_home" });

    const body = await queue("assigned_unworked", fx.manager.session);
    const ids = body.rows.map((r: any) => r.id);
    expect(ids).toContain(inQueue);
    expect(ids).toContain(workedBeforeReassign); // activity predates the assignment
    expect(ids).not.toContain(workedAfter);
    expect(ids).not.toContain(tooRecent);
    expect(ids).not.toContain(soldLead);
    expect(body.total).toBe(2);
    expect(body.rule).toContain("48 hours");
    const row = body.rows.find((r: any) => r.id === inQueue);
    expect(row.repName).toBe("Dana Doors");
    expect(row.reason).toContain("No door activity");
  });

  it("honors the window parameter, clamped", async () => {
    seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(2 * HOUR) });
    expect((await queue("assigned_unworked", fx.manager.session)).total).toBe(0);
    clearOpsMemo();
    const tight = await queue("assigned_unworked", fx.manager.session, "?window=1");
    expect(tight.total).toBe(1);
    expect(tight.rule).toContain("1 hours");
  });

  it("holds the tenant wall and the team-lead scope", async () => {
    const mine = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR) });
    seedLead({ assigned_rep_id: fx.otherRep.memberId, assigned_at: iso(72 * HOUR) });
    const foreign = storage.createLead({
      address: "9 Foreign Rd", city: "Elsewhere", state: "SC", zip: "29000",
      lat: 34, lng: -81, tenantId: 2, leadStatus: "prospect",
    } as any).id;
    rawDb.prepare("UPDATE leads SET assigned_rep_id = ?, assigned_at = ? WHERE id = ?")
      .run(fx.foreignManager.memberId, iso(72 * HOUR), foreign);

    const managerView = await queue("assigned_unworked", fx.manager.session);
    expect(managerView.total).toBe(2); // both tenant-1 leads, never the foreign one
    expect(managerView.rows.map((r: any) => r.id)).not.toContain(foreign);

    clearOpsMemo();
    const leadView = await queue("assigned_unworked", fx.lead.session);
    expect(leadView.rows.map((r: any) => r.id)).toEqual([mine]); // Dana reports to Tess; Omar does not
  });
});

describe("followups_overdue", () => {
  it("flags the latest knock's past callback date, and newer activity clears it", async () => {
    const overdue = seedLead({ assigned_rep_id: fx.rep.memberId, lead_status: "follow_up" });
    seedKnock(overdue, { knocked_at: iso(48 * HOUR), callback_date: ymd(24 * HOUR) });

    const cleared = seedLead({ assigned_rep_id: fx.rep.memberId, lead_status: "follow_up" });
    seedKnock(cleared, { knocked_at: iso(48 * HOUR), callback_date: ymd(24 * HOUR) });
    seedKnock(cleared, { knocked_at: iso(1 * HOUR), outcome: "not_home" }); // newer visit, no schedule

    const superseded = seedLead({ assigned_rep_id: fx.rep.memberId, lead_status: "follow_up" });
    seedKnock(superseded, { knocked_at: iso(48 * HOUR), callback_date: ymd(24 * HOUR), superseded: 1 });

    const future = seedLead({ assigned_rep_id: fx.rep.memberId, lead_status: "follow_up" });
    seedKnock(future, { knocked_at: iso(2 * HOUR), callback_date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });

    const body = await queue("followups_overdue", fx.manager.session);
    expect(body.rows.map((r: any) => r.id)).toEqual([overdue]);
    expect(body.rows[0].reason).toContain("due");
  });
});

describe("unassigned_hot", () => {
  it("names the factor that qualified each row, and only real factors qualify", async () => {
    const scored = seedLead({ assigned_rep_id: null, lead_score: 80 });
    const buyer = seedLead({ assigned_rep_id: null, buyer_score: 9 });
    const marked = seedLead({ assigned_rep_id: null, assign_mark: "priority" });
    const cold = seedLead({ assigned_rep_id: null, lead_score: 10 });

    const body = await queue("unassigned_hot", fx.manager.session);
    const byId = new Map(body.rows.map((r: any) => [r.id, r]));
    expect(byId.get(scored)?.reason).toContain("lead score 80");
    expect(byId.get(buyer)?.reason).toContain("buyer score 9");
    expect(byId.get(marked)?.reason).toContain("marked priority");
    expect(byId.has(cold)).toBe(false);
  });
});

describe("inactive_rep_holdings and territory_link_conflicts", () => {
  it("surfaces doors parked on a deactivated rep", async () => {
    const parked = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(2 * HOUR) });
    rawDb.prepare("UPDATE team_members SET active = 0 WHERE id = ?").run(fx.rep.memberId);
    try {
      const body = await queue("inactive_rep_holdings", fx.manager.session);
      expect(body.rows.map((r: any) => r.id)).toEqual([parked]);
      expect(body.rows[0].reason).toContain("deactivated");
    } finally {
      rawDb.prepare("UPDATE team_members SET active = 1 WHERE id = ?").run(fx.rep.memberId);
    }
  });

  it("reads broken territory links without ever repairing them", async () => {
    const missing = seedLead({ assigned_territory_id: 999_999 });
    const t = storage.createTerritory({ name: "Old Farm", repId: fx.rep.memberId, polygon: JSON.stringify([[-80.4, 35.5], [-80.3, 35.5], [-80.3, 35.6]]), tenantId: 1 } as any);
    rawDb.prepare("UPDATE territories SET status = 'archived' WHERE id = ?").run(t.id);
    const archived = seedLead({ assigned_territory_id: t.id });

    const body = await queue("territory_link_conflicts", fx.manager.session);
    const byId = new Map(body.rows.map((r: any) => [r.id, r]));
    expect(byId.get(missing)?.reason).toContain("no longer exists");
    expect(byId.get(archived)?.reason).toContain("archived");
    // Read-only: the links are untouched.
    expect((rawDb.prepare("SELECT assigned_territory_id t FROM leads WHERE id = ?").get(missing) as any).t).toBe(999_999);
  });
});

describe("partial_writes", () => {
  it("lists incomplete bulk writes from the last 7 days only", async () => {
    storage.logActivity(fx.manager.userId, "lead.assign_selection", "lead", undefined,
      { repId: fx.rep.memberId, resolved: 100, updated: 40, skipped: 0, incomplete: true });
    storage.logActivity(fx.manager.userId, "lead.assign_selection", "lead", undefined,
      { repId: fx.rep.memberId, resolved: 100, updated: 100, skipped: 0 });
    rawDb.prepare(
      `INSERT INTO activity_log (user_id, tenant_id, action, entity_type, details, at)
       VALUES (?, 1, 'lead.bulk_assign', 'lead', '{"updated":5,"skipped":0,"incomplete":true}', ?)`,
    ).run(fx.manager.userId, iso(10 * 86_400_000));

    const body = await queue("partial_writes", fx.manager.session);
    expect(body.total).toBe(1);
    expect(body.rows[0].reason).toContain("stopped part-way");
  });
});

describe("dismissals", () => {
  it("requires a reason, hides the row from rows AND count, audits, and restores", async () => {
    const id = seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR) });
    expect((await queue("assigned_unworked", fx.manager.session)).total).toBe(1);

    const bare = await post("/api/ops/dismiss", fx.manager.session, { queue: "assigned_unworked", entityId: id });
    expect(bare.status).toBe(400);
    expect((await bare.json()).code).toBe("REASON_REQUIRED");

    const ok = await post("/api/ops/dismiss", fx.manager.session, { queue: "assigned_unworked", entityId: id, reason: "Seasonal home - owner back in spring" });
    expect(ok.status).toBe(200);
    clearOpsMemo();
    expect((await queue("assigned_unworked", fx.manager.session)).total).toBe(0);

    const audit = rawDb.prepare("SELECT details FROM activity_log WHERE action = 'ops.queue.dismissed'").get() as any;
    expect(audit.details).toContain("Seasonal home");

    // A dismissal is per-queue: the same lead still shows where other rules match.
    clearOpsMemo();
    rawDb.prepare("UPDATE leads SET last_outcome_at = ?, last_outcome = 'not_home' WHERE id = ?").run(iso(40 * 86_400_000), id);
    expect((await queue("stale_active", fx.manager.session)).rows.map((r: any) => r.id)).toContain(id);

    const undis = await post("/api/ops/undismiss", fx.manager.session, { queue: "assigned_unworked", entityId: id });
    expect((await undis.json()).restored).toBe(true);
  });

  it("refuses a cross-tenant entity id", async () => {
    const foreign = storage.createLead({
      address: "77 Foreign Wall", city: "Elsewhere", state: "SC", zip: "29000",
      lat: 34, lng: -81, tenantId: 2, leadStatus: "prospect",
    } as any).id;
    const res = await post("/api/ops/dismiss", fx.manager.session, { queue: "assigned_unworked", entityId: foreign, reason: "nope" });
    expect(res.status).toBe(404);
  });
});

describe("workload", () => {
  it("reports the distribution with on-shift state, never a fake capacity", async () => {
    seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR) });
    seedLead({ assigned_rep_id: fx.rep.memberId, assigned_at: iso(72 * HOUR), last_outcome_at: iso(1 * HOUR), last_outcome: "not_home" });
    rawDb.prepare(
      `INSERT INTO clock_sessions (rep_id, user_id, tenant_id, clocked_in, date) VALUES (?, ?, 1, ?, ?)`,
    ).run(fx.rep.memberId, fx.rep.userId, iso(2 * HOUR), ymd(0));

    const body = await (await get("/api/ops/workload", fx.manager.session)).json();
    const dana = body.rows.find((r: any) => r.repId === fx.rep.memberId);
    expect(dana.activeLeads).toBe(2);
    expect(dana.unworked).toBe(1);
    expect(dana.onShift).toBe(true);
    expect(body.rule).toContain("not a capacity score");
  });
});

describe("bulk-assign now carries the put-back token", () => {
  it("returns undoToken + undoExpiresAt, and the undo restores", async () => {
    const a = seedLead({});
    const b = seedLead({});
    const res = await post("/api/leads/bulk-assign", fx.manager.session, { leadIds: [a, b], repId: fx.rep.memberId });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    expect(typeof body.undoToken).toBe("string");
    expect(Date.parse(body.undoExpiresAt)).toBeGreaterThan(Date.now());

    const undo = await post("/api/leads/assign-selection/undo", fx.manager.session, { token: body.undoToken });
    expect(undo.status).toBe(200);
    expect((await undo.json()).restored).toBe(2);
    expect((rawDb.prepare("SELECT assigned_rep_id r FROM leads WHERE id = ?").get(a) as any).r).toBeNull();
  });
});
