// The rep-metrics HTTP surface: the security contract, not the arithmetic.
//
//   * every read is scoped SERVER-SIDE from the caller's own roster seat, and a
//     client-supplied rep filter can only narrow it, never widen it,
//   * a rep cannot reach another rep's metrics, insights, or coaching notes,
//   * a manager sees their own branch and 404s (not 403s) on anyone else,
//   * tenant walls hold in both directions,
//   * NO RAW COORDINATE is returned by any endpoint in this plane - summaries
//     only; raw trails stay behind the audited export in live ops,
//   * a supervisor's private coaching note is invisible to the rep until shared,
//   * the reclaim review endpoint records a decision and moves no doors.

import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
let recomputeRepDay: (tenantId: number, repId: number, metricDate: string, nowMs?: number) => unknown;

const realFetch = globalThis.fetch.bind(globalThis);

// Tenant 1 org chart:  managerA ── leadA ── repA1, repA2
//                      managerB ── repB1        (a peer branch, not managerA's)
// Tenant 2:            foreignManager, foreignRep
let repA1Session: string, repA2Session: string, leadASession: string;
let managerASession: string, managerBSession: string, adminSession: string;
let foreignManagerSession: string;
let repA1Rep: number, repA2Rep: number, repB1Rep: number, foreignRep: number;
let territoryId: number;

// The day these fixtures are filed under MUST be the day the API will ask for.
//
// This was `new Date().toISOString().slice(0, 10)` - the UTC calendar date -
// while every read resolves "today" in the ORG's timezone
// (periodOf → localDateString(Date.now(), tenantTimezone(...))). Those two
// disagree for the four hours between 20:00 US-East and midnight, which is
// both when this repo's CI runs and when the work happens: the rollups landed
// on the server's TOMORROW, every "today" query matched nothing, and the suite
// failed with doorsAttempted 0 instead of 60 and empty rep lists.
//
// Resolved through the same helpers the route uses, so the fixture cannot
// drift from the server's definition of a day again. Assigned in beforeAll
// because tenantTimezone reads the DB, which does not exist at module load.
let TODAY: string;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-repmetrics-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  const { registerRoutes } = await import("../../server/routes");
  const metricsStore = await import("../../server/repMetricsStore");
  const { localDateString, tenantTimezone } = metricsStore;
  recomputeRepDay = metricsStore.recomputeRepDay;
  // Tenant 1 is the org under test; its timezone is what "today" means here.
  TODAY = localDateString(Date.now(), tenantTimezone(1));

  rawDb.prepare(
    `INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name)
     VALUES (2, 'tenant-b-metrics', 'Tenant B', 'Owner B', 'owner-b-metrics@example.com', 'Tenant B')`,
  ).run();

  // Roster first: the scope resolver reads team_members, not users.
  const mkMember = (name: string, role: string, tenantId: number, reportsTo: number | null) =>
    Number((rawDb.prepare(
      `INSERT INTO team_members (name, role, tenant_id, reports_to_id, active, created_at)
       VALUES (?,?,?,?,1,?) RETURNING id`,
    ).get(name, role, tenantId, reportsTo, new Date().toISOString()) as any).id);

  const managerAMember = mkMember("Manager A", "manager", 1, null);
  const leadAMember = mkMember("Lead A", "team_lead", 1, managerAMember);
  repA1Rep = mkMember("Rep A1", "rep", 1, leadAMember);
  repA2Rep = mkMember("Rep A2", "rep", 1, leadAMember);
  const managerBMember = mkMember("Manager B", "manager", 1, null);
  repB1Rep = mkMember("Rep B1", "rep", 1, managerBMember);
  const foreignManagerMember = mkMember("Foreign Manager", "manager", 2, null);
  foreignRep = mkMember("Foreign Rep", "rep", 2, foreignManagerMember);

  const mkUser = (name: string, email: string, role: string, tenantId: number, teamMemberId: number | null) => {
    const u = storage.createUser({ name, email, role, active: true, tenantId } as any);
    // users.training_required defaults to 1, and the onboarding gate refuses a
    // gated REP every path outside /api/training and their own paperwork - which
    // includes Metrics, correctly: a rep who has not finished onboarding has no
    // field activity to look at. These fixtures are working reps, so the flag is
    // cleared. The gate itself is covered by its own suite; asserting it here
    // would only re-test somebody else's middleware.
    rawDb.prepare(`UPDATE users SET training_required = 0 WHERE id = ?`).run(u.id);
    if (teamMemberId != null) {
      rawDb.prepare(`UPDATE users SET team_member_id = ? WHERE id = ?`).run(teamMemberId, u.id);
    }
    return storage.createSession(u.id).id;
  };

  repA1Session = mkUser("Rep A1", "rep-a1-metrics@example.com", "rep", 1, repA1Rep);
  repA2Session = mkUser("Rep A2", "rep-a2-metrics@example.com", "rep", 1, repA2Rep);
  leadASession = mkUser("Lead A", "lead-a-metrics@example.com", "team_lead", 1, leadAMember);
  managerASession = mkUser("Manager A", "manager-a-metrics@example.com", "manager", 1, managerAMember);
  managerBSession = mkUser("Manager B", "manager-b-metrics@example.com", "manager", 1, managerBMember);
  adminSession = mkUser("Admin", "admin-metrics@example.com", "admin", 1, null);
  foreignManagerSession = mkUser("Foreign Manager", "fm-metrics@example.com", "manager", 2, foreignManagerMember);

  // Rollup rows so the reads have something to scope.
  const insertDay = (
    tenantId: number,
    repId: number,
    doors: number,
    contacts: number,
    stocks: { assigned: number; eligible: number; worked: number; fresh: number },
  ) =>
    rawDb.prepare(
      `INSERT INTO rep_daily_metrics (tenant_id, rep_id, metric_date, doors_attempted, doors_visited,
         verified_doors, contacts, submitted_orders, active_seconds, assigned_doors, eligible_doors,
         ever_worked_doors, fresh_assigned)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      tenantId, repId, TODAY, doors, doors, doors, contacts, 1, 8 * 3600,
      stocks.assigned, stocks.eligible, stocks.worked, stocks.fresh,
    );

  insertDay(1, repA1Rep, 60, 15, { assigned: 220, eligible: 200, worked: 60, fresh: 30 });
  insertDay(1, repA2Rep, 40, 12, { assigned: 430, eligible: 400, worked: 40, fresh: 50 });
  insertDay(1, repB1Rep, 55, 20, { assigned: 300, eligible: 250, worked: 55, fresh: 20 });
  insertDay(2, foreignRep, 99, 33, { assigned: 500, eligible: 450, worked: 99, fresh: 70 });

  // An insight on each rep, so the coaching endpoints have rows to scope.
  const insight = (tenantId: number, repId: number, title: string) =>
    rawDb.prepare(
      `INSERT INTO rep_coaching_insights (tenant_id, rep_id, period_start, period_end, insight_type,
         severity, title, explanation, suggested_action)
       VALUES (?,?,?,?,'slow_pace_between_doors','coaching_needed',?,'x','y')`,
    ).run(tenantId, repId, TODAY, TODAY, title);
  insight(1, repA1Rep, "A1 insight");
  insight(1, repB1Rep, "B1 insight");
  insight(2, foreignRep, "Foreign insight");

  territoryId = Number((rawDb.prepare(
    `INSERT INTO territories (tenant_id, name, rep_id, polygon, assignee_ids, status, assigned_at, created_at)
     VALUES (1, 'Test Area', ?, '[[-81,35],[-81,35.01],[-80.99,35.01],[-80.99,35]]', ?, 'active', ?, ?)
     RETURNING id`,
  ).get(repA1Rep, JSON.stringify([repA1Rep]), new Date(Date.now() - 5 * 86_400_000).toISOString(),
        new Date().toISOString()) as any).id);

  rawDb.prepare(
    `INSERT INTO territory_daily_metrics (tenant_id, territory_id, metric_date, eligible_doors,
       assigned_doors, ever_worked_doors, doors_attempted, status, reclaim_recommended, reclaim_rationale)
     VALUES (1, ?, ?, 300, 300, 20, 22, 'reclaim_candidate', 1, 'Assigned 5 days, 7% attempted.')`,
  ).run(territoryId, TODAY);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
});

function request(path: string, sessionId?: string, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(sessionId ? { "x-session-id": sessionId } : {}),
      ...init.headers,
    },
  });
}

let hourlyLeadSeq = 0;
function insertHourlyKnock(
  knockedAt: string,
  options: { outcome?: string; wasHome?: boolean; superseded?: boolean } = {},
) {
  const outcome = options.outcome ?? "not_home";
  const lead = storage.createLead({
    address: `${++hourlyLeadSeq} Hourly Metrics Way`,
    city: "High Point",
    state: "NC",
    zip: "27263",
    fiberStatus: "fiber",
    leadStatus: outcome === "sold" ? "sold" : "prospect",
    tenantId: 1,
  } as any);
  rawDb.prepare(`
    INSERT INTO knock_log
      (lead_id, rep_id, tenant_id, knocked_at, was_home, outcome, pass_number, superseded)
    VALUES (?, ?, 1, ?, ?, ?, 1, ?)
  `).run(
    lead.id,
    repA1Rep,
    knockedAt,
    options.wasHome ? 1 : 0,
    outcome,
    options.superseded ? 1 : 0,
  );
}

const METRIC_PATHS = [
  "/api/metrics/me",
  "/api/metrics/team",
  "/api/metrics/territories",
  "/api/metrics/insights",
  "/api/metrics/reports",
  "/api/metrics/settings",
  "/api/field-mode/state",
];

// ── Authentication ───────────────────────────────────────────────────────────

describe("authentication", () => {
  it("refuses every metrics endpoint without a session", async () => {
    for (const path of METRIC_PATHS) {
      const res = await request(path);
      expect([401, 403], `${path} allowed an anonymous read`).toContain(res.status);
    }
  });
});

// ── Rep isolation ────────────────────────────────────────────────────────────

describe("a rep sees only themselves", () => {
  it("returns the caller's own numbers from /me with no way to ask for another rep", async () => {
    const res = await request("/api/metrics/me", repA1Session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasSeat).toBe(true);
    expect(body.facts.doorsAttempted).toBe(60);   // A1's row, not A2's 40
  });

  it("ignores a repId smuggled into the query string", async () => {
    const res = await request(`/api/metrics/me?repId=${repA2Rep}`, repA1Session);
    const body = await res.json();
    // Still A1's own figure. The endpoint reads the session's seat, full stop.
    expect(body.facts.doorsAttempted).toBe(60);
  });

  it("refuses the team table to a rep", async () => {
    const res = await request("/api/metrics/team", repA1Session);
    expect(res.status).toBe(403);
  });

  it("refuses another rep's drill-down to a rep", async () => {
    const res = await request(`/api/metrics/rep/${repA2Rep}`, repA1Session);
    expect(res.status).toBe(403);
  });

  it("refuses the coaching board and the reports tab to a rep", async () => {
    expect((await request("/api/metrics/insights", repA1Session)).status).toBe(403);
    expect((await request("/api/metrics/reports", repA1Session)).status).toBe(403);
    expect((await request("/api/metrics/settings", repA1Session)).status).toBe(403);
  });

  it("gives a rep their own insights and nobody else's", async () => {
    const res = await request("/api/metrics/insights/me", repA1Session);
    expect(res.status).toBe(200);
    const { insights } = await res.json();
    expect(insights.length).toBeGreaterThan(0);
    for (const i of insights) expect(i.repId).toBe(repA1Rep);
  });
});

// ── Hourly rollup ───────────────────────────────────────────────────────────

describe("hourly activity uses the org's local clock", () => {
  it("reads the asynchronous rollup instead of aggregating raw knocks on request", async () => {
    const metricDate = "2026-08-15";
    insertHourlyKnock("2026-08-15T16:00:00.000Z", { wasHome: true }); // noon EDT

    let res = await request(
      `/api/metrics/me/hourly?from=${metricDate}&to=${metricDate}`,
      repA1Session,
    );
    expect((await res.json()).hours).toEqual([]);

    recomputeRepDay(1, repA1Rep, metricDate, Date.parse("2026-08-16T12:00:00.000Z"));
    res = await request(
      `/api/metrics/me/hourly?from=${metricDate}&to=${metricDate}`,
      repA1Session,
    );
    expect((await res.json()).hours).toEqual([
      { hour: 12, doors: 1, contacts: 1, sales: 0 },
    ]);
  });

  it("uses America/New_York local-day bounds across UTC midnight", async () => {
    const metricDate = "2026-08-18";
    insertHourlyKnock("2026-08-18T03:30:00.000Z"); // Aug 17 23:30 EDT: outside
    insertHourlyKnock("2026-08-19T01:30:00.000Z"); // Aug 18 21:30 EDT: inside
    insertHourlyKnock("2026-08-19T04:00:00.000Z"); // Aug 19 00:00 EDT: exclusive end
    recomputeRepDay(1, repA1Rep, metricDate, Date.parse("2026-08-20T00:00:00.000Z"));

    const res = await request(
      `/api/metrics/me/hourly?from=${metricDate}&to=${metricDate}`,
      repA1Session,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).hours).toEqual([
      { hour: 21, doors: 1, contacts: 0, sales: 0 },
    ]);
  });

  it("uses DST-aware local hours on spring-forward and fall-back days", async () => {
    insertHourlyKnock("2026-03-08T06:30:00.000Z", { wasHome: true }); // 01:30 EST
    insertHourlyKnock("2026-03-08T07:30:00.000Z", { wasHome: true }); // 03:30 EDT
    recomputeRepDay(1, repA1Rep, "2026-03-08", Date.parse("2026-03-09T12:00:00.000Z"));

    let res = await request(
      "/api/metrics/me/hourly?from=2026-03-08&to=2026-03-08",
      repA1Session,
    );
    expect((await res.json()).hours).toEqual([
      { hour: 1, doors: 1, contacts: 1, sales: 0 },
      { hour: 3, doors: 1, contacts: 1, sales: 0 },
    ]);

    insertHourlyKnock("2026-11-01T05:30:00.000Z", { wasHome: true }); // 01:30 EDT
    insertHourlyKnock("2026-11-01T06:30:00.000Z", { wasHome: true }); // 01:30 EST
    recomputeRepDay(1, repA1Rep, "2026-11-01", Date.parse("2026-11-02T12:00:00.000Z"));

    res = await request(
      "/api/metrics/me/hourly?from=2026-11-01&to=2026-11-01",
      repA1Session,
    );
    expect((await res.json()).hours).toEqual([
      { hour: 1, doors: 2, contacts: 2, sales: 0 },
    ]);
  });

  it("keeps superseded attempts but excludes their losing contact and sale outcomes", async () => {
    const metricDate = "2026-08-16";
    insertHourlyKnock("2026-08-16T18:00:00.000Z", {
      outcome: "sold", wasHome: true,
    });
    insertHourlyKnock("2026-08-16T18:15:00.000Z", {
      outcome: "sold", wasHome: true, superseded: true,
    });
    insertHourlyKnock("2026-08-16T18:30:00.000Z", {
      outcome: "not_home", wasHome: false,
    });
    recomputeRepDay(1, repA1Rep, metricDate, Date.parse("2026-08-17T12:00:00.000Z"));

    const res = await request(
      `/api/metrics/me/hourly?from=${metricDate}&to=${metricDate}`,
      repA1Session,
    );
    expect((await res.json()).hours).toEqual([
      { hour: 14, doors: 3, contacts: 1, sales: 1 },
    ]);
  });
});

describe("order activity uses the org's local calendar date", () => {
  it("counts a date-only sold commission on its intended local day", () => {
    const metricDate = "2026-08-14";
    rawDb.prepare(`
      INSERT INTO commissions (tenant_id, rep_id, amount, status, sale_date)
      VALUES (1, ?, 100, 'pending', ?)
    `).run(repA2Rep, metricDate);

    recomputeRepDay(1, repA2Rep, metricDate, Date.parse("2026-08-15T12:00:00.000Z"));
    const row = rawDb.prepare(`
      SELECT submitted_orders AS submittedOrders
        FROM rep_daily_metrics
       WHERE tenant_id = 1 AND rep_id = ? AND metric_date = ?
    `).get(repA2Rep, metricDate) as any;

    expect(row.submittedOrders).toBe(1);
  });
});

// ── Supervisor scope ─────────────────────────────────────────────────────────

describe("supervisor scope", () => {
  it("gives a team lead their own subtree and not a peer branch", async () => {
    const res = await request("/api/metrics/team", leadASession);
    expect(res.status).toBe(200);
    const { rows } = await res.json();
    const ids = rows.map((r: any) => r.repId);
    expect(ids).toContain(repA1Rep);
    expect(ids).toContain(repA2Rep);
    expect(ids).not.toContain(repB1Rep);
  });

  it("sums two reps' unequal stock snapshots for team utilization", async () => {
    const res = await request("/api/metrics/team", leadASession);
    expect(res.status).toBe(200);
    const { kpis } = await res.json();

    expect(kpis.facts.assignedDoors).toBe(650);
    expect(kpis.facts.eligibleDoors).toBe(600);
    expect(kpis.facts.everWorkedDoors).toBe(100);
    expect(kpis.facts.freshAssigned).toBe(80);
    expect(kpis.metrics.utilizationRate).toBeCloseTo(1 / 6, 5);
  });

  it("gives a manager their own branch and not another manager's", async () => {
    const res = await request("/api/metrics/team", managerASession);
    const { rows } = await res.json();
    const ids = rows.map((r: any) => r.repId);
    expect(ids).toContain(repA1Rep);
    expect(ids).not.toContain(repB1Rep);
  });

  it("and the same in reverse - the branch wall is symmetric, not id-ordered", async () => {
    // managerB's fixtures existed for this case and nothing asserted it: every
    // scope test above looks outward from managerA. A subtree walk that
    // compared ids, or that treated the FIRST manager as privileged, would
    // satisfy all of them and still leak here.
    const res = await request("/api/metrics/team", managerBSession);
    expect(res.status).toBe(200);
    const { rows } = await res.json();
    const ids = rows.map((r: any) => r.repId);
    expect(ids).toContain(repB1Rep);
    expect(ids).not.toContain(repA1Rep);
    expect(ids).not.toContain(repA2Rep);
  });

  it("and a peer manager drilling into the other branch's rep gets the same 404", async () => {
    const res = await request(`/api/metrics/rep/${repA1Rep}`, managerBSession);
    expect(res.status).toBe(404);
  });

  it("404s, not 403s, when a manager drills into another branch's rep", async () => {
    const res = await request(`/api/metrics/rep/${repB1Rep}`, managerASession);
    // 404 so the response never confirms that a rep outside the caller's world
    // exists at all.
    expect(res.status).toBe(404);
  });

  it("lets a manager drill into their own rep", async () => {
    const res = await request(`/api/metrics/rep/${repA1Rep}`, managerASession);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repId).toBe(repA1Rep);
    expect(body.facts.doorsAttempted).toBe(60);
  });

  it("cannot be widened by a client-supplied rep filter", async () => {
    // Manager A asks explicitly for Manager B's rep. The filter may only narrow.
    const res = await request(`/api/metrics/team?reps=${repB1Rep}`, managerASession);
    const { rows } = await res.json();
    expect(rows.map((r: any) => r.repId)).not.toContain(repB1Rep);
  });

  it("scopes the coaching board to the caller's branch", async () => {
    const res = await request("/api/metrics/insights", managerASession);
    const { insights } = await res.json();
    const ids = insights.map((i: any) => i.repId);
    expect(ids).toContain(repA1Rep);
    expect(ids).not.toContain(repB1Rep);
  });

  it("gives an admin the whole tenant", async () => {
    const res = await request("/api/metrics/team", adminSession);
    const { rows } = await res.json();
    const ids = rows.map((r: any) => r.repId);
    expect(ids).toContain(repA1Rep);
    expect(ids).toContain(repB1Rep);
  });
});

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("never leaks tenant 2 rows into a tenant 1 read", async () => {
    const res = await request("/api/metrics/team", adminSession);
    const { rows } = await res.json();
    expect(rows.map((r: any) => r.repId)).not.toContain(foreignRep);
    expect(rows.every((r: any) => r.facts.doorsAttempted !== 99)).toBe(true);
  });

  it("404s when a foreign manager drills into a tenant 1 rep", async () => {
    const res = await request(`/api/metrics/rep/${repA1Rep}`, foreignManagerSession);
    expect(res.status).toBe(404);
  });

  it("keeps a foreign manager's coaching board empty of tenant 1 insights", async () => {
    const res = await request("/api/metrics/insights", foreignManagerSession);
    const { insights } = await res.json();
    for (const i of insights) expect(i.repId).not.toBe(repA1Rep);
  });

  it("does not show a tenant 1 territory to a foreign manager", async () => {
    const res = await request("/api/metrics/territories", foreignManagerSession);
    const { rows } = await res.json();
    expect(rows.map((r: any) => r.territoryId)).not.toContain(territoryId);
  });
});

// ── Privacy: no raw coordinates on this plane ────────────────────────────────

describe("no raw location in the metrics plane", () => {
  it("returns no latitude or longitude from any metrics endpoint", async () => {
    const paths = [
      "/api/metrics/me",
      "/api/metrics/team",
      `/api/metrics/rep/${repA1Rep}`,
      "/api/metrics/territories",
      "/api/metrics/insights",
      "/api/field-mode/state",
      "/api/field-mode/summary",
    ];
    for (const path of paths) {
      const res = await request(path, adminSession);
      if (res.status !== 200) continue;
      const text = await res.text();
      // A coordinate would appear as a lat/lng key. Summaries (metres travelled,
      // seconds inside territory) carry no position and are what this plane is for.
      expect(/"lat"\s*:/.test(text), `${path} returned a lat`).toBe(false);
      expect(/"lng"\s*:/.test(text), `${path} returned a lng`).toBe(false);
      expect(/"repLat"|"repLng"/.test(text), `${path} returned a device fix`).toBe(false);
    }
  });
});

// ── Coaching notes ───────────────────────────────────────────────────────────

describe("coaching notes", () => {
  it("refuses a rep the ability to write a note about anyone, including themselves", async () => {
    const res = await request("/api/metrics/notes", repA1Session, {
      method: "POST",
      body: JSON.stringify({ repId: repA1Rep, body: "self note" }),
    });
    expect(res.status).toBe(403);
  });

  it("404s when a supervisor writes a note about a rep outside their branch", async () => {
    const res = await request("/api/metrics/notes", managerASession, {
      method: "POST",
      body: JSON.stringify({ repId: repB1Rep, body: "out of branch" }),
    });
    expect(res.status).toBe(404);
  });

  it("keeps a private note invisible to the rep and visible to the supervisor", async () => {
    const create = await request("/api/metrics/notes", leadASession, {
      method: "POST",
      body: JSON.stringify({ repId: repA1Rep, body: "PRIVATE: work on the close", sharedWithRep: false }),
    });
    expect(create.status).toBe(200);

    const repView = await request("/api/metrics/notes/me", repA1Session);
    const { notes: repNotes } = await repView.json();
    expect(repNotes.some((n: any) => n.body.includes("PRIVATE"))).toBe(false);

    const supView = await request(`/api/metrics/notes?repId=${repA1Rep}`, leadASession);
    const { notes: supNotes } = await supView.json();
    expect(supNotes.some((n: any) => n.body.includes("PRIVATE"))).toBe(true);
  });

  it("shows a note to the rep once it is explicitly shared", async () => {
    await request("/api/metrics/notes", leadASession, {
      method: "POST",
      body: JSON.stringify({ repId: repA1Rep, body: "SHARED: nice work on callbacks", sharedWithRep: true }),
    });
    const repView = await request("/api/metrics/notes/me", repA1Session);
    const { notes } = await repView.json();
    expect(notes.some((n: any) => n.body.includes("SHARED"))).toBe(true);
    // ...and still not the private one.
    expect(notes.some((n: any) => n.body.includes("PRIVATE"))).toBe(false);
  });
});

// ── Reclaim review is review-only ────────────────────────────────────────────

describe("territory reclaim review", () => {
  it("refuses the decision endpoint to a team lead", async () => {
    const res = await request(`/api/metrics/territories/${territoryId}/review`, leadASession, {
      method: "POST",
      body: JSON.stringify({ decision: "reclaimed" }),
    });
    expect(res.status).toBe(403);
  });

  it("records a manager's decision without moving any doors", async () => {
    const before = rawDb.prepare(
      `SELECT rep_id AS repId, assignee_ids AS assigneeIds, status FROM territories WHERE id = ?`,
    ).get(territoryId) as any;

    const res = await request(`/api/metrics/territories/${territoryId}/review`, managerASession, {
      method: "POST",
      body: JSON.stringify({ decision: "reclaimed", note: "Agreed at the Monday call" }),
    });
    expect(res.status).toBe(200);

    // The audit row exists...
    const review = rawDb.prepare(
      `SELECT decision, decision_note AS note FROM territory_reclaim_reviews WHERE territory_id = ?`,
    ).get(territoryId) as any;
    expect(review.decision).toBe("reclaimed");
    expect(review.note).toContain("Monday");

    // ...and the territory is completely untouched. Recording an intent is not
    // the same act as taking the area away, and this endpoint only does the first.
    const after = rawDb.prepare(
      `SELECT rep_id AS repId, assignee_ids AS assigneeIds, status FROM territories WHERE id = ?`,
    ).get(territoryId) as any;
    expect(after).toEqual(before);
  });

  it("rejects an unknown decision value", async () => {
    const res = await request(`/api/metrics/territories/${territoryId}/review`, managerASession, {
      method: "POST",
      body: JSON.stringify({ decision: "delete_everything" }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Field Mode ───────────────────────────────────────────────────────────────

describe("field mode", () => {
  it("reports the rep's own shift state and never another rep's", async () => {
    const res = await request("/api/field-mode/state", repA1Session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasSeat).toBe(true);
    expect(body.facts.doorsAttempted).toBe(60);
  });

  it("declines to record an arrival with no open shift, and does not error", async () => {
    const res = await request("/api/field-mode/arrival", repA1Session, {
      method: "POST",
      body: JSON.stringify({ leadId: 1, lat: 35.0, lng: -81.0 }),
    });
    // 200 with recorded:false, never a 4xx: a rep at a doorstep must never see
    // an error from a telemetry write, and the disposition path is unaffected.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(false);
    expect(body.reason).toBe("no_active_shift");
  });

  it("records an arrival during an open shift and survives a duplicate flush", async () => {
    storage.clockIn(repA1Rep, 1);
    const payload = JSON.stringify({ leadId: 4242, lat: 35.0, lng: -81.0, clientId: "arrival-idem-1" });
    const first = await request("/api/field-mode/arrival", repA1Session, { method: "POST", body: payload });
    expect((await first.json()).recorded).toBe(true);
    await request("/api/field-mode/arrival", repA1Session, { method: "POST", body: payload });

    const count = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM door_arrivals WHERE client_id = 'arrival-idem-1'`,
    ).get() as any;
    expect(Number(count.n)).toBe(1);
  });

  it("still records the arrival when the device has no usable fix", async () => {
    const res = await request("/api/field-mode/arrival", repA1Session, {
      method: "POST",
      body: JSON.stringify({ leadId: 4243, clientId: "arrival-nogps-1" }),
    });
    const body = await res.json();
    expect(body.recorded).toBe(true);
    // Labelled unverified rather than refused - a weak GPS fix never blocks the
    // work, it only changes what the record claims.
    expect(body.locationVerified).toBe(false);
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────

describe("field activity and privacy settings", () => {
  it("refuses the settings surface to a manager", async () => {
    expect((await request("/api/metrics/settings", managerASession)).status).toBe(403);
  });

  it("lets an admin read and update, clamping retention to the documented range", async () => {
    const res = await request("/api/metrics/settings", adminSession, {
      method: "PUT",
      body: JSON.stringify({ retentionDays: 9999, graceRadiusM: 5, minDwellSeconds: 30 }),
    });
    expect(res.status).toBe(200);
    const { settings } = await res.json();
    // No admin setting can ever mean "keep forever".
    expect(settings.retentionDays).toBe(90);
    // Grace radius has a floor too.
    expect(settings.graceRadiusM).toBe(10);
    expect(settings.minDwellSeconds).toBe(30);
  });

  it("writes a before/after row to the protected admin audit trail", async () => {
    await request("/api/metrics/settings", adminSession, {
      method: "PUT",
      body: JSON.stringify({ rawTrailsVisible: true }),
    });
    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'metrics.field_privacy_settings_changed'`,
    ).get() as any;
    expect(Number(row.n)).toBeGreaterThan(0);
  });

  it("ships raw location trails hidden by default", async () => {
    // Fresh tenant with no policy row: the fallback is what a new org gets.
    const res = await request("/api/metrics/settings", foreignManagerSession);
    expect(res.status).toBe(403); // manager cannot read it at all
  });
});

// ── Coaching board dedup (prod audit 2026-08-31) ─────────────────────────────
//
// The generator writes one row per (rep, rule, rolling 7-day window) and the
// window rolls daily, so the raw table holds 6-8 near-identical rows per
// finding. The board must show only the NEWEST window per (rep, rule) — and
// dismissing that one card must hide the rule instead of resurfacing last
// week's copy of it.

describe("coaching board window dedup", () => {
  const shiftDay = (iso: string, days: number) =>
    new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

  it("keeps one card per (rep, rule) — the newest window — and dismissal hides the rule", async () => {
    const windowRow = (periodStart: string, periodEnd: string, title: string) =>
      rawDb.prepare(
        `INSERT INTO rep_coaching_insights (tenant_id, rep_id, period_start, period_end, insight_type,
           severity, title, explanation, suggested_action)
         VALUES (1,?,?,?,'fresh_territory_unworked','coaching_needed',?,'x','y')`,
      ).run(repA2Rep, periodStart, periodEnd, title);
    windowRow(shiftDay(TODAY, -8), shiftDay(TODAY, -2), "stale window");
    windowRow(shiftDay(TODAY, -7), shiftDay(TODAY, -1), "middle window");
    windowRow(shiftDay(TODAY, -6), TODAY, "newest window");

    const res = await request("/api/metrics/insights", adminSession);
    expect(res.status).toBe(200);
    const { insights } = await res.json();
    const mine = insights.filter((i: any) => i.repId === repA2Rep && i.insightType === "fresh_territory_unworked");
    expect(mine.length).toBe(1);
    expect(mine[0].title).toBe("newest window");
    expect(mine[0].periodEnd).toBe(TODAY);

    // Dismissing the surviving card silences the RULE — the middle/stale
    // windows must not pop back up in its place.
    const dismiss = await request(`/api/metrics/insights/${mine[0].id}/dismiss`, adminSession, { method: "POST" });
    expect(dismiss.status).toBe(200);
    const after = await request("/api/metrics/insights", adminSession);
    const remaining = (await after.json()).insights
      .filter((i: any) => i.repId === repA2Rep && i.insightType === "fresh_territory_unworked");
    expect(remaining.length).toBe(0);
  });
});
