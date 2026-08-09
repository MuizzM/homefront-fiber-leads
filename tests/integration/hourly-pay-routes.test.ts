import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { weekBoundsFor, DEFAULT_WORKWEEK } from "../../shared/workweek";

/**
 * Route-level integration tests for the hourly-pay money plane:
 *  - PATCH /api/team-members/:id/hourly-rate — capability gate (rep 403),
 *    self-deal 403, cross-tenant 404, audit event, effective_from.
 *  - POST/GET/resolve /api/pay/disputes — rep-opens-own, line validation,
 *    idempotency key, rep-can't-see-others, manager tenant queue, cross-tenant
 *    isolation, upheld + adjusted resolutions, dispute-not-open 409.
 *  - GET /api/commission/week-export.csv — appended hourly/spiffs/reserve/total
 *    columns reconcile to the statement (original columns stable).
 */

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let svc: typeof import("../../server/commissionService");
let rawDb: any;

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@hourly-pay.example.test`;
  const member = storage.createTeamMember({
    name, email, role: memberRole, active: true, reportsToId: null, tenantId,
  } as any);
  const user = storage.createUser({
    name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id,
  } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

const WEEK_REF = "2026-06-10T12:00:00.000Z"; // Wed of the Jun 8–14 2026 week
const wk = weekBoundsFor(WEEK_REF, DEFAULT_WORKWEEK);

let TENANT_B = 0;
let mgr1: Fixture, admin1: Fixture, rep1: Fixture, rep1b: Fixture;
let mgr2: Fixture, rep2: Fixture;

let sessionSeq = 0;
function seedSession(repId: number, tenantId: number, inTs: string, outTs: string | null) {
  sessionSeq += 1;
  const info = rawDb.prepare(
    `INSERT INTO clock_sessions (rep_id, user_id, tenant_id, clocked_in, clocked_out, duration_minutes, date) VALUES (?,?,?,?,?,?,?)`,
  ).run(repId, 1, tenantId, inTs, outTs,
    outTs ? Math.round((Date.parse(outTs) - Date.parse(inTs)) / 60000) : null, inTs.slice(0, 10));
  return Number(info.lastInsertRowid);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-hourly-routes-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations(); // creates + adopts the default tenant (id 1)
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  await import("../../server/spiffStore"); // ensures the spiffs ledger table exists

  TENANT_B = storage.createTenant({
    slug: "hourly-pay-b", companyName: "Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@hourly-pay.example.test", brandName: "Org B",
  } as any).id;

  mgr1 = makePerson("Hourly Mgr One", "manager", 1, "manager");
  admin1 = makePerson("Hourly Admin One", "admin", 1, "manager");
  rep1 = makePerson("Hourly Rep One", "rep", 1);
  rep1b = makePerson("Hourly Rep OneBee", "rep", 1);
  mgr2 = makePerson("Hourly Mgr Two", "manager", TENANT_B, "manager");
  rep2 = makePerson("Hourly Rep Two", "rep", TENANT_B);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("PATCH /api/team-members/:id/hourly-rate", () => {
  it("manager sets a rate (audited); rep is capability-denied; self-deal denied; cross-tenant 404", async () => {
    // rep cannot set rates (no commission.structure.manage)
    const asRep = await request(`/api/team-members/${rep1b.memberId}/hourly-rate`, rep1.session, {
      method: "PATCH", body: JSON.stringify({ rateCents: 2000 }),
    });
    expect(asRep.status).toBe(403);

    // negative rejected
    const bad = await request(`/api/team-members/${rep1.memberId}/hourly-rate`, mgr1.session, {
      method: "PATCH", body: JSON.stringify({ rateCents: -1 }),
    });
    expect(bad.status).toBe(400);

    // manager sets $25/h effective before the test week
    const ok = await request(`/api/team-members/${rep1.memberId}/hourly-rate`, mgr1.session, {
      method: "PATCH", body: JSON.stringify({ rateCents: 2500, effectiveFrom: "2026-06-01T00:00:00.000Z" }),
    });
    expect(ok.status).toBe(200);
    const body = await ok.json() as any;
    expect(body.hourlyRateCents).toBe(2500);
    expect(body.hourlyRateEffectiveFrom).toBe("2026-06-01T00:00:00.000Z");
    const audit = rawDb.prepare(
      `SELECT action, details FROM activity_log WHERE action = 'pay.hourly_rate.changed' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(rep1.memberId) as any;
    expect(JSON.parse(audit.details).newRateCents).toBe(2500);

    // self-deal: a manager linked to a team member cannot rate themselves
    const self = await request(`/api/team-members/${mgr1.memberId}/hourly-rate`, mgr1.session, {
      method: "PATCH", body: JSON.stringify({ rateCents: 9000 }),
    });
    expect(self.status).toBe(403);

    // cross-tenant: mgr1 rates a rep in org B → 404 (existence never leaks)
    const cross = await request(`/api/team-members/${rep2.memberId}/hourly-rate`, mgr1.session, {
      method: "PATCH", body: JSON.stringify({ rateCents: 2500 }),
    });
    expect(cross.status).toBe(404);
    expect((storage.getTeamMemberById(rep2.memberId) as any).hourlyRateCents).toBeNull();
  });
});

describe("pay disputes", () => {
  let disputeId = 0;

  it("rep opens a dispute on their own hourly line (idempotent on Idempotency-Key)", async () => {
    const res = await request(`/api/pay/disputes`, rep1.session, {
      method: "POST",
      headers: { "idempotency-key": "disp-1" },
      body: JSON.stringify({ weekStart: "2026-06-10", line: "hourly", message: "I worked 6h Monday but see 4h" }),
    });
    expect(res.status).toBe(201);
    const d = await res.json() as any;
    expect(d.rep_id).toBe(rep1.memberId);
    expect(d.week_start).toBe(wk.weekStartUtc); // canonicalized to the org week
    expect(d.line_kind).toBe("hourly");
    expect(d.status).toBe("open");
    disputeId = d.id;
    // Replay with the same key → the SAME row, no duplicate.
    const replay = await request(`/api/pay/disputes`, rep1.session, {
      method: "POST",
      headers: { "idempotency-key": "disp-1" },
      body: JSON.stringify({ weekStart: "2026-06-10", line: "hourly", message: "I worked 6h Monday but see 4h" }),
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).id).toBe(disputeId);
    const audit = rawDb.prepare(`SELECT 1 FROM activity_log WHERE action = 'pay.dispute.opened' AND entity_id = ?`).get(disputeId);
    expect(audit).toBeTruthy();
  });

  it("a rep cannot dispute another rep's commission row (404); own row flips to disputed", async () => {
    const theirs = storage.createCommission({
      repId: rep1b.memberId, leadId: null, amount: 100, saleDate: "2026-06-10",
      status: "pending", approvedBy: null, paidDate: null, notes: null,
    } as any);
    const foreign = await request(`/api/pay/disputes`, rep1.session, {
      method: "POST", body: JSON.stringify({ weekStart: "2026-06-10", line: theirs.id, message: "not mine" }),
    });
    expect(foreign.status).toBe(404);

    const mine = storage.createCommission({
      repId: rep1.memberId, leadId: null, amount: 100, saleDate: "2026-06-10",
      status: "pending", approvedBy: null, paidDate: null, notes: null,
    } as any);
    const own = await request(`/api/pay/disputes`, rep1.session, {
      method: "POST", body: JSON.stringify({ weekStart: "2026-06-10", line: mine.id, message: "this sale was mine, rate wrong" }),
    });
    expect(own.status).toBe(201);
    const d = await own.json() as any;
    expect(d.commission_id).toBe(mine.id);
    // The disputed commission is visibly under dispute.
    expect(storage.getCommissionById(mine.id, 1)!.status).toBe("disputed");
  });

  it("rep sees ONLY their own disputes; manager sees the tenant queue; cross-tenant is walled", async () => {
    const asRep1 = await (await request(`/api/pay/disputes`, rep1.session)).json() as any[];
    expect(asRep1.length).toBeGreaterThanOrEqual(2);
    expect(asRep1.every(d => d.rep_id === rep1.memberId)).toBe(true);

    const asRep1b = await (await request(`/api/pay/disputes`, rep1b.session)).json() as any[];
    expect(asRep1b.length).toBe(0); // rep1b has none — and never sees rep1's

    const queue = await (await request(`/api/pay/disputes?status=open`, mgr1.session)).json() as any[];
    expect(queue.length).toBeGreaterThanOrEqual(2);
    expect(queue.some(d => d.id === disputeId)).toBe(true);
    expect(queue.every(d => d.tenant_id === 1)).toBe(true);

    // Org B's manager never sees tenant 1's disputes.
    const queueB = await (await request(`/api/pay/disputes?status=open`, mgr2.session)).json() as any[];
    expect(queueB.length).toBe(0);

    // Org B manager resolving a tenant-1 dispute → 404.
    const cross = await request(`/api/pay/disputes/${disputeId}/resolve`, mgr2.session, {
      method: "POST", body: JSON.stringify({ resolution: "upheld", note: "cross-tenant attempt" }),
    });
    expect(cross.status).toBe(404);
  });

  it("rep cannot resolve (capability); manager resolves upheld; re-resolve is 409", async () => {
    const asRep = await request(`/api/pay/disputes/${disputeId}/resolve`, rep1.session, {
      method: "POST", body: JSON.stringify({ resolution: "upheld", note: "rep attempt" }),
    });
    expect(asRep.status).toBe(403);

    const res = await request(`/api/pay/disputes/${disputeId}/resolve`, mgr1.session, {
      method: "POST", body: JSON.stringify({ resolution: "upheld", note: "Hours verified against the territory log - paid correctly." }),
    });
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.status).toBe("resolved");
    expect(d.resolution).toBe("upheld");
    expect(d.resolved_by).toBe(mgr1.userId);
    expect(d.resolved_at).toBeTruthy();

    const again = await request(`/api/pay/disputes/${disputeId}/resolve`, mgr1.session, {
      method: "POST", body: JSON.stringify({ resolution: "upheld", note: "double resolve" }),
    });
    expect(again.status).toBe(409);
    const audit = rawDb.prepare(`SELECT 1 FROM activity_log WHERE action = 'pay.dispute.resolved' AND entity_id = ?`).get(disputeId);
    expect(audit).toBeTruthy();
  });

  it("'adjusted' requires an existing adjustment from the adjustments flow", async () => {
    // Open a fresh dispute on the week's commission line.
    const open = await request(`/api/pay/disputes`, rep1.session, {
      method: "POST", body: JSON.stringify({ weekStart: "2026-06-10", line: "commission", message: "missing a sale bonus" }),
    });
    expect(open.status).toBe(201);
    const d = await open.json() as any;

    // No adjustmentId → 400.
    const missing = await request(`/api/pay/disputes/${d.id}/resolve`, mgr1.session, {
      method: "POST", body: JSON.stringify({ resolution: "adjusted", note: "crediting" }),
    });
    expect(missing.status).toBe(400);

    // A foreign/nonexistent adjustment → 404.
    const foreign = await request(`/api/pay/disputes/${d.id}/resolve`, mgr1.session, {
      method: "POST", body: JSON.stringify({ resolution: "adjusted", note: "crediting", adjustmentId: 999999 }),
    });
    expect(foreign.status).toBe(404);

    // A real adjustment (existing flow — the dispute flow does no money math).
    svc.calculateOrRecalculateStatement({ tenantId: 1, repId: rep1.memberId, weekReference: WEEK_REF, actorId: mgr1.userId });
    const stmt = svc.listStatements(1, { repIds: [rep1.memberId], weekStartUtc: wk.weekStartUtc })[0];
    const adj = svc.createAdjustment(1, mgr1.userId, { statementId: stmt.id, amountCents: 15000, reason: "missed sale credit" });
    const ok = await request(`/api/pay/disputes/${d.id}/resolve`, mgr1.session, {
      method: "POST", body: JSON.stringify({ resolution: "adjusted", note: "credited via adjustment", adjustmentId: adj.id }),
    });
    expect(ok.status).toBe(200);
    const resolved = await ok.json() as any;
    expect(resolved.resolution).toBe("adjusted");
    expect(resolved.adjustment_id).toBe(adj.id);
  });
});

describe("gate fixes F1/F3/F4/F6", () => {
  const NWK_REF = "2026-06-17T12:00:00.000Z"; // week of Jun 15–21 2026
  const nwk = weekBoundsFor(NWK_REF, DEFAULT_WORKWEEK);

  it("F1: single-statement FINALIZE is blocked by an open clock session, then freezes a recomputed truth", async () => {
    // rep1b: $20/h + an open (forgotten) clock-in in the Jun 15 week.
    await request(`/api/team-members/${rep1b.memberId}/hourly-rate`, mgr1.session, {
      method: "PATCH", body: JSON.stringify({ rateCents: 2000, effectiveFrom: "2026-06-01T00:00:00.000Z" }),
    });
    const openId = seedSession(rep1b.memberId, 1, new Date(Date.parse(nwk.weekStartUtc) + 8 * 3_600_000).toISOString(), null);
    const stmt = svc.calculateOrRecalculateStatement({ tenantId: 1, repId: rep1b.memberId, weekReference: NWK_REF, actorId: mgr1.userId }).statement;

    const blocked = await request(`/api/commission/statements/${stmt.id}/transition`, admin1.session, {
      method: "POST", body: JSON.stringify({ action: "FINALIZE" }),
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as any).code).toBe("OPEN_CLOCK_SESSION");
    expect(svc.listStatements(1, { repIds: [rep1b.memberId], weekStartUtc: nwk.weekStartUtc })[0].status).toBe("OPEN");

    // Close the punch → FINALIZE succeeds and locks a FRESHLY recomputed number.
    rawDb.prepare(`UPDATE clock_sessions SET clocked_out = ?, duration_minutes = 240 WHERE id = ?`)
      .run(new Date(Date.parse(nwk.weekStartUtc) + 12 * 3_600_000).toISOString(), openId);
    const ok = await request(`/api/commission/statements/${stmt.id}/transition`, admin1.session, {
      method: "POST", body: JSON.stringify({ action: "FINALIZE" }),
    });
    expect(ok.status).toBe(200);
    const frozen = svc.listStatements(1, { repIds: [rep1b.memberId], weekStartUtc: nwk.weekStartUtc })[0];
    expect(frozen.status).toBe("FINALIZED");
    expect(frozen.hourly_minutes).toBe(240);          // recompute-before-freeze ran
    expect(frozen.hourly_pay_cents).toBe(8000);       // 4h × $20
  });

  it("F3: 'upheld' restores the commission's pre-dispute status through the audited lifecycle path", async () => {
    const c = storage.createCommission({
      repId: rep1.memberId, leadId: null, amount: 75, saleDate: "2026-06-10",
      status: "approved", approvedBy: mgr1.userId, paidDate: null, notes: null,
    } as any);
    const open = await request(`/api/pay/disputes`, rep1.session, {
      method: "POST", body: JSON.stringify({ weekStart: "2026-06-10", line: c.id, message: "amount looks low" }),
    });
    expect(open.status).toBe(201);
    const d = await open.json() as any;
    expect(storage.getCommissionById(c.id, 1)!.status).toBe("disputed");

    const res = await request(`/api/pay/disputes/${d.id}/resolve`, mgr1.session, {
      method: "POST", body: JSON.stringify({ resolution: "upheld", note: "amount verified correct" }),
    });
    expect(res.status).toBe(200);
    // Restored to approved — not stranded in 'disputed'.
    expect(storage.getCommissionById(c.id, 1)!.status).toBe("approved");
    // …and both moves went through the audited lifecycle (commission.* events),
    // not raw UPDATEs.
    const audit = rawDb.prepare(
      `SELECT action FROM activity_log WHERE entity_type = 'commission' AND entity_id = ? ORDER BY id`,
    ).all(c.id) as any[];
    expect(audit.map(a => a.action)).toEqual(expect.arrayContaining(["commission.disputed", "commission.approved"]));
  });

  it("F4: a manager cannot correct their OWN punches (self-deal 403)", async () => {
    const self = await request(`/api/pay/punch-corrections`, mgr1.session, {
      method: "POST", body: JSON.stringify({ repId: mgr1.memberId, kind: "missed_out", minutesDelta: 480, reason: "forgot to clock in" }),
    });
    expect(self.status).toBe(403);
    // …but correcting a REP's punch works.
    const ok = await request(`/api/pay/punch-corrections`, mgr1.session, {
      method: "POST", body: JSON.stringify({ repId: rep1.memberId, kind: "adjust", minutesDelta: 30, reason: "break overlap" }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json() as any).minutes_delta).toBe(30);
  });

  it("F6: idempotency-key replay by a DIFFERENT rep in the tenant is a 409, never a leak", async () => {
    const replay = await request(`/api/pay/disputes`, rep1b.session, {
      method: "POST",
      headers: { "idempotency-key": "disp-1" }, // rep1's key from the dispute tests
      body: JSON.stringify({ weekStart: "2026-06-10", line: "hourly", message: "not my key" }),
    });
    expect(replay.status).toBe(409);
  });
});

describe("payroll CSV - appended hourly money-plane columns reconcile to the statement", () => {
  it("original columns stable; hours/rate/pay/spiffs/reserve/total appended and summed", async () => {
    // rep1: $25/h (set above) + 8h in the week + 1 qualified sale on a $150 flat plan.
    seedSession(rep1.memberId, 1, new Date(Date.parse(wk.weekStartUtc) + 8 * 3_600_000).toISOString(),
      new Date(Date.parse(wk.weekStartUtc) + 16 * 3_600_000).toISOString());
    const plan = svc.createPlan(1, mgr1.userId, { name: "CSV Flat", type: "FLAT" });
    const version = svc.addPlanVersion(1, mgr1.userId, plan.id, { effectiveFrom: "2026-01-01", flatRateCents: 15000, qualificationBasis: "QUALIFIED_AT" });
    svc.activatePlan(1, mgr1.userId, plan.id);
    svc.assignPlanVersionToRep(1, mgr1.userId, { repId: rep1.memberId, commissionPlanVersionId: version.id, effectiveFrom: "2026-01-01" });
    svc.upsertSale(1, mgr1.userId, { repId: rep1.memberId, externalId: "csv-sale-1", status: "QUALIFIED", soldAt: WEEK_REF, qualifiedAt: WEEK_REF });
    // 10% chargeback reserve + one approved $50 spiff in the week.
    rawDb.prepare(`UPDATE tenants SET commission_reserve_percent = 10 WHERE id = 1`).run();
    rawDb.prepare(`INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at) VALUES (1,?,?,?,?,'approved',?)`)
      .run(rep1.memberId, "csv-spiff-1", 5000, "first sale of the week", WEEK_REF);

    // Statement truth first.
    const stmt = svc.calculateOrRecalculateStatement({ tenantId: 1, repId: rep1.memberId, weekReference: WEEK_REF, actorId: mgr1.userId }).statement;
    expect(stmt.hourly_minutes).toBe(480);
    expect(stmt.hourly_pay_cents).toBe(20000); // 8h × $25
    expect(stmt.gross_commission_cents).toBe(15000);
    const expectedReserve = Math.round(stmt.final_commission_cents * 0.10);
    const expectedTotal = stmt.hourly_pay_cents + stmt.gross_commission_cents + stmt.adjustment_cents + 5000 - expectedReserve;

    const res = await request(`/api/commission/week-export.csv?week=2026-06-10`, mgr1.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    const lines = text.trim().split("\n");
    // The install-hold columns are APPENDED after Total (same additive rule as
    // the hourly money-plane columns), and the downline-override column after
    // those; every pre-existing column is untouched.
    expect(lines[1]).toBe("Rep,Status,Qualified Sales,Tier,Rate,Gross,Adjustments,Final,Hours,Hourly Rate,Hourly Pay,Spiffs,Reserve,Total,Install Hold Sales,Install Hold Payable After,Overrides");

    const row = lines.find(l => l.includes("Hourly Rep One"))!;
    const cells = row.split(",");
    // 8h at $25/h → 200.00 hourly pay; $150 gross; $50 spiff; reserve 10% of final.
    expect(cells[8]).toBe("8.00");
    expect(cells[9]).toBe("25.00");
    expect(cells[10]).toBe("200.00");
    expect(cells[5]).toBe("150.00");
    expect(cells[11]).toBe("50.00");
    expect(cells[12]).toBe((expectedReserve / 100).toFixed(2));
    expect(cells[13]).toBe((expectedTotal / 100).toFixed(2));
    // An API-booked sale has no linked legacy commission → never install-held.
    expect(cells[14]).toBe("0");
    expect(cells[15]).toBe('""');
    // No downline in this fixture → zero override pay.
    expect(cells[16]).toBe("0.00");

    // Total row reconciles: Σ(hourly pay + gross + adjustments + overrides +
    // spiffs − reserve); the override column sums like the other money columns.
    const totalRow = lines[lines.length - 1].split(",");
    const dataRows = lines.slice(2, -1).map(l => l.split(","));
    const colSum = (i: number) => dataRows.reduce((s, c) => s + Number(c[i] || 0), 0);
    for (const i of [5, 6, 7, 10, 11, 12, 13, 16]) {
      expect(Number(totalRow[i])).toBeCloseTo(colSum(i), 2);
    }
    // rep1b (a rate from the F1 test, but no hours THIS week) → zero hourly pay.
    const zeroRow = lines.find(l => l.includes("OneBee"))!.split(",");
    expect(zeroRow[8]).toBe("0.00");
    expect(zeroRow[9]).toBe("20.00");
    expect(Number(zeroRow[10])).toBe(0);

    // rep cannot export the payroll CSV (commission.read.all required).
    const asRep = await request(`/api/commission/week-export.csv?week=2026-06-10`, rep1.session);
    expect(asRep.status).toBe(403);
  });
});
