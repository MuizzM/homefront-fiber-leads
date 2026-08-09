import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { weekBoundsFor, DEFAULT_WORKWEEK } from "../../shared/workweek";

/**
 * Integration tests for the hourly-pay money plane (service level, throwaway
 * SQLite via DATA_DIR). Covers: hours math (boundary clamps, open sessions,
 * punch corrections, 16h/day cap), rate-effective-at-week-start (mid-week
 * change keeps the old rate), the statement hourly block + idempotent
 * regeneration, hourly-only reps, and the OPEN_CLOCK_SESSION finalize block.
 * Route-level tests (CSV, disputes, capability gates) live in
 * hourly-pay-routes.test.ts.
 */

let svc: typeof import("../../server/commissionService");
let hourly: typeof import("../../server/hourlyPay");
let rawDb: import("better-sqlite3").Database;

const T1 = 9101, T2 = 9102;
const REP = 3001, REP_HOURLY_ONLY = 3002, REP_T2 = 3003;

// Week of Mon Jun 8 – Sun Jun 14 2026 (America/New_York). Next: Jun 15 – 21.
const WEEK_REF = "2026-06-10T12:00:00.000Z";
const NEXT_WEEK_REF = "2026-06-17T12:00:00.000Z";
let wk: { weekStartUtc: string; nextWeekStartUtc: string };
let nwk: { weekStartUtc: string; nextWeekStartUtc: string };

function seedRep(id: number, tenantId: number) {
  rawDb.prepare(`INSERT INTO team_members (id, name, tenant_id, role, active, created_at) VALUES (?,?,?,?,1,?)`)
    .run(id, `Rep ${id}`, tenantId, "rep", new Date().toISOString());
}

let sessionSeq = 0;
function seedSession(repId: number, tenantId: number, inTs: string, outTs: string | null) {
  sessionSeq += 1;
  rawDb.prepare(
    `INSERT INTO clock_sessions (id, rep_id, user_id, tenant_id, clocked_in, clocked_out, duration_minutes, date) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(9000 + sessionSeq, repId, 1, tenantId, inTs, outTs,
    outTs ? Math.round((Date.parse(outTs) - Date.parse(inTs)) / 60000) : null, inTs.slice(0, 10));
  return 9000 + sessionSeq;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-hourly-pay-"));
  svc = await import("../../server/commissionService");
  hourly = await import("../../server/hourlyPay");
  ({ rawDb } = await import("../../server/db"));
  const { runMigrations } = await import("../../server/storage");
  rawDb.exec(`CREATE TABLE IF NOT EXISTS tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, created_at TEXT, updated_at TEXT)`);
  runMigrations();

  wk = weekBoundsFor(WEEK_REF, DEFAULT_WORKWEEK);
  nwk = weekBoundsFor(NEXT_WEEK_REF, DEFAULT_WORKWEEK);

  for (const t of [T1, T2]) {
    rawDb.prepare(`INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?,?,?,?)`)
      .run(t, `Tenant ${t}`, new Date().toISOString(), new Date().toISOString());
  }
  seedRep(REP, T1);
  seedRep(REP_HOURLY_ONLY, T1);
  seedRep(REP_T2, T2);
});

describe("hours aggregation", () => {
  it("clamps sessions to the week boundary (half-open)", () => {
    const s = wk.weekStartUtc, e = wk.nextWeekStartUtc;
    // 2h before the week, out 2h in → only the in-week 2h count.
    seedSession(REP, T1, new Date(Date.parse(s) - 2 * 3_600_000).toISOString(), new Date(Date.parse(s) + 2 * 3_600_000).toISOString());
    // In 2h before week end, out 3h after → clamped to the boundary.
    seedSession(REP, T1, new Date(Date.parse(e) - 2 * 3_600_000).toISOString(), new Date(Date.parse(e) + 3 * 3_600_000).toISOString());
    const r = hourly.hoursWorkedThisWeek(T1, REP, s, e);
    expect(r.minutes).toBe(240);
    expect(r.hours).toBe(4);
    expect(r.openSessionCount).toBe(0);
  });

  it("splits at midnight and flags days over 16h", () => {
    const s = wk.weekStartUtc, e = wk.nextWeekStartUtc;
    const repId = REP_HOURLY_ONLY; // isolated rep for this assertion
    // Two 9h sessions on the SAME UTC day (Tuesday) → an 18h day: counted, flagged.
    const tue = Date.parse(s) + 20 * 3_600_000; // Tue 00:00Z (week starts Mon 04:00Z)
    const s1 = new Date(tue + 30 * 60_000).toISOString();          // 00:30 → 09:30
    seedSession(repId, T1, s1, new Date(Date.parse(s1) + 9 * 3_600_000).toISOString());
    const s2 = new Date(tue + 12 * 3_600_000).toISOString();       // 12:00 → 21:00
    seedSession(repId, T1, s2, new Date(Date.parse(s2) + 9 * 3_600_000).toISOString());
    const r = hourly.hoursWorkedThisWeek(T1, repId, s, e);
    expect(r.minutes).toBe(18 * 60);
    expect(r.dailyCapFlags.length).toBe(1);
    expect(r.dailyCapFlags[0].minutes).toBe(18 * 60);
    // clean up so later tests on this rep start fresh
    rawDb.prepare(`DELETE FROM clock_sessions WHERE rep_id = ?`).run(repId);
  });

  it("open sessions accrue through min(now, weekEnd) and keep the week non-finalizable", () => {
    const s = wk.weekStartUtc, e = wk.nextWeekStartUtc;
    const liveNow = new Date(Date.parse(s) + 52 * 3_600_000); // mid-week "now"
    seedSession(REP_HOURLY_ONLY, T1, new Date(Date.parse(s) + 50 * 3_600_000).toISOString(), null); // open, 2h before liveNow
    const live = hourly.hoursWorkedThisWeek(T1, REP_HOURLY_ONLY, s, e, liveNow);
    expect(live.minutes).toBe(120);
    expect(live.openSessionCount).toBe(1);
    expect(live.weekEnded).toBe(false);
    expect(live.finalizable).toBe(false);
    // With real now (week long past): accrues through weekEnd, but the open
    // session BLOCKS finalization of the ended week.
    const past = hourly.hoursWorkedThisWeek(T1, REP_HOURLY_ONLY, s, e);
    expect(past.weekEnded).toBe(true);
    expect(past.finalizable).toBe(false);
    expect(past.openSessionCount).toBe(1);
    rawDb.prepare(`DELETE FROM clock_sessions WHERE rep_id = ?`).run(REP_HOURLY_ONLY);
  });

  it("folds punch corrections into the sum with a floor at 0/day", () => {
    const s = wk.weekStartUtc, e = wk.nextWeekStartUtc;
    const repId = REP_HOURLY_ONLY;
    // 2h Monday session, then a −3h correction the same day → floor at 0.
    const mon = new Date(Date.parse(s) + 8 * 3_600_000).toISOString();
    const sessId = seedSession(repId, T1, mon, new Date(Date.parse(mon) + 2 * 3_600_000).toISOString());
    hourly.addPunchCorrection(T1, 1, { repId, sessionId: sessId, kind: "adjust", minutesDelta: -180, reason: "double-counted shift" });
    let r = hourly.hoursWorkedThisWeek(T1, repId, s, e);
    expect(r.sessionMinutes).toBe(120);
    expect(r.correctionMinutes).toBe(-180);
    expect(r.minutes).toBe(0); // floored at 0/day, never negative
    // A +8h missed-punch correction the next day lands on top.
    hourly.addPunchCorrection(T1, 1, { repId, sessionId: null, kind: "missed_out", minutesDelta: 480, reason: "forgot to clock in Tuesday" });
    // attribute the correction to Tuesday by backdating created_at
    rawDb.prepare(`UPDATE punch_corrections SET created_at = ? WHERE minutes_delta = 480`)
      .run(new Date(Date.parse(s) + 30 * 3_600_000).toISOString());
    r = hourly.hoursWorkedThisWeek(T1, repId, s, e);
    expect(r.minutes).toBe(480);
    // Corrections attributed outside the week don't count.
    rawDb.prepare(`UPDATE punch_corrections SET created_at = ? WHERE minutes_delta = 480`)
      .run(new Date(Date.parse(e) + 3_600_000).toISOString());
    r = hourly.hoursWorkedThisWeek(T1, repId, s, e);
    expect(r.minutes).toBe(0);
    rawDb.prepare(`DELETE FROM punch_corrections WHERE rep_id = ?`).run(repId);
    rawDb.prepare(`DELETE FROM clock_sessions WHERE rep_id = ?`).run(repId);
  });

  it("is tenant-scoped - another tenant's sessions never leak into the sum", () => {
    const s = wk.weekStartUtc, e = wk.nextWeekStartUtc;
    seedSession(REP_T2, T2, new Date(Date.parse(s) + 8 * 3_600_000).toISOString(), new Date(Date.parse(s) + 12 * 3_600_000).toISOString());
    expect(hourly.hoursWorkedThisWeek(T1, REP, s, e).minutes).toBe(240); // REP's own sessions only
    expect(hourly.hoursWorkedThisWeek(T2, REP_T2, s, e).minutes).toBe(240);
  });
});

describe("rate effective at week start", () => {
  it("a mid-week rate change keeps the OLD rate for the running week, new rate next week", () => {
    const repId = REP_HOURLY_ONLY;
    hourly.setHourlyRate(T1, 1, repId, 2000, "2026-06-01T00:00:00.000Z"); // $20/h before the week
    hourly.setHourlyRate(T1, 1, repId, 3000, "2026-06-10T00:00:00.000Z"); // $30/h mid-week
    expect(hourly.hourlyRateEffectiveAt(repId, wk.weekStartUtc).rateCents).toBe(2000);
    expect(hourly.hourlyRateEffectiveAt(repId, nwk.weekStartUtc).rateCents).toBe(3000);
    // And the pay block prices each week accordingly (1h Monday session).
    seedSession(repId, T1, new Date(Date.parse(wk.weekStartUtc) + 8 * 3_600_000).toISOString(),
      new Date(Date.parse(wk.weekStartUtc) + 9 * 3_600_000).toISOString());
    const payWk = hourly.hourlyPayForWeek(T1, repId, wk.weekStartUtc, wk.nextWeekStartUtc);
    expect(payWk.rateCents).toBe(2000);
    expect(payWk.payCents).toBe(2000); // 1h × $20 (old rate governs the week)
    rawDb.prepare(`DELETE FROM clock_sessions WHERE rep_id = ?`).run(repId);
  });

  it("validates rates: negative rejected, null = commission-only, audit event written", () => {
    expect(() => hourly.setHourlyRate(T1, 1, REP, -5)).toThrowError(/non-negative/);
    hourly.setHourlyRate(T1, 1, REP, 2500, "2026-06-01T00:00:00.000Z");
    const audit = rawDb.prepare(
      `SELECT details FROM activity_log WHERE action = 'pay.hourly_rate.changed' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(REP) as any;
    const d = JSON.parse(audit.details);
    expect(d.oldRateCents).toBe(null);
    expect(d.newRateCents).toBe(2500);
    // Commission-only again from 2026-06-20: the current week keeps its rate,
    // weeks governed by the null change price no hourly pay.
    hourly.setHourlyRate(T1, 1, REP, null, "2026-06-20T00:00:00.000Z");
    expect(hourly.hourlyRateEffectiveAt(REP, "2026-06-22T04:00:00.000Z").rateCents).toBe(null);
    expect(hourly.hourlyRateEffectiveAt(REP, wk.weekStartUtc).rateCents).toBe(2500);
    hourly.setHourlyRate(T1, 1, REP, 2500, "2026-06-01T00:00:00.000Z"); // restore for statement tests
    expect(hourly.hourlyRateEffectiveAt(REP, wk.weekStartUtc).rateCents).toBe(2500);
  });
});

describe("statement hourly block", () => {
  it("rep with hours + rate but no plan gets an hourly-only statement; with a plan, both lines", () => {
    // REP has 4h in the week (boundary test above) and a $25/h rate.
    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1, requestId: "hourly-1" });
    expect(out.statement.hourly_minutes).toBe(240);
    expect(out.statement.hourly_rate_cents).toBe(2500);
    expect(out.statement.hourly_pay_cents).toBe(10000); // 4h × $25
    expect(out.statement.commission_plan_version_id).toBeNull();
    expect(out.statement.gross_commission_cents).toBe(0);

    // Assign a FLAT commission plan → the SAME statement now carries both lines.
    const plan = svc.createPlan(T1, 1, { name: "Flat", type: "FLAT" });
    const version = svc.addPlanVersion(T1, 1, plan.id, { effectiveFrom: "2026-01-01", flatRateCents: 15000, qualificationBasis: "QUALIFIED_AT" });
    svc.activatePlan(T1, 1, plan.id);
    svc.assignPlanVersionToRep(T1, 1, { repId: REP, commissionPlanVersionId: version.id, effectiveFrom: "2026-01-01" });
    svc.upsertSale(T1, 1, { repId: REP, externalId: "hybrid-1", status: "QUALIFIED", soldAt: WEEK_REF, qualifiedAt: WEEK_REF });
    const both = svc.calculateOrRecalculateStatement({ tenantId: T1, repId: REP, weekReference: WEEK_REF, actorId: 1, requestId: "hourly-2" });
    expect(both.statement.gross_commission_cents).toBe(15000); // 1 sale × $150
    expect(both.statement.hourly_pay_cents).toBe(10000);       // hourly line intact
    expect(both.statement.hourly_minutes).toBe(240);
  });

  it("hourly-only rep (no plan) still gets a weekly statement; regeneration is truthful", () => {
    const repId = REP_HOURLY_ONLY; // $30/h current, $20/h effective at week start
    seedSession(repId, T1, new Date(Date.parse(wk.weekStartUtc) + 8 * 3_600_000).toISOString(),
      new Date(Date.parse(wk.weekStartUtc) + 18 * 3_600_000).toISOString()); // 10h Monday
    const first = svc.calculateOrRecalculateStatement({ tenantId: T1, repId, weekReference: WEEK_REF, actorId: 1, requestId: "ho-1" });
    expect(first.statement.hourly_minutes).toBe(600);
    expect(first.statement.hourly_rate_cents).toBe(2000); // rate at week start
    expect(first.statement.hourly_pay_cents).toBe(20000); // 10h × $20
    expect(first.statement.gross_commission_cents).toBe(0);
    expect(first.hourly.hours).toBe(10);
    // Regenerate: same truth, ONE row, version unchanged (no double-count).
    const second = svc.calculateOrRecalculateStatement({ tenantId: T1, repId, weekReference: WEEK_REF, actorId: 1, requestId: "ho-2" });
    expect(second.statement.id).toBe(first.statement.id);
    expect(second.statement.calculation_version).toBe(first.statement.calculation_version);
    expect(second.statement.hourly_pay_cents).toBe(20000);
    expect(svc.listStatements(T1, { repIds: [repId], weekStartUtc: wk.weekStartUtc }).length).toBe(1);
    // A material change (more hours) DOES recompute truthfully.
    seedSession(repId, T1, new Date(Date.parse(wk.weekStartUtc) + 32 * 3_600_000).toISOString(),
      new Date(Date.parse(wk.weekStartUtc) + 34 * 3_600_000).toISOString()); // +2h Tuesday
    const third = svc.calculateOrRecalculateStatement({ tenantId: T1, repId, weekReference: WEEK_REF, actorId: 1, requestId: "ho-3" });
    expect(third.statement.hourly_minutes).toBe(720);
    expect(third.statement.hourly_pay_cents).toBe(24000);
    expect(third.statement.calculation_version).toBeGreaterThan(second.statement.calculation_version);
  });

  it("the next week prices at the NEW rate (mid-week change does not leak forward/back)", () => {
    const repId = REP_HOURLY_ONLY;
    seedSession(repId, T1, new Date(Date.parse(nwk.weekStartUtc) + 8 * 3_600_000).toISOString(),
      new Date(Date.parse(nwk.weekStartUtc) + 12 * 3_600_000).toISOString()); // 4h next Monday
    const out = svc.calculateOrRecalculateStatement({ tenantId: T1, repId, weekReference: NEXT_WEEK_REF, actorId: 1 });
    expect(out.statement.hourly_rate_cents).toBe(3000);
    expect(out.statement.hourly_pay_cents).toBe(12000); // 4h × $30
  });
});

describe("F2: rate-history supersede rule", () => {
  it("remove-then-re-add restores the rate for all weeks (no stranded null)", () => {
    const repId = REP_T2; // clean rate history
    hourly.setHourlyRate(T2, 1, repId, 2500, "2026-06-01T00:00:00.000Z");
    hourly.setHourlyRate(T2, 1, repId, null, "2026-06-20T00:00:00.000Z");
    expect(hourly.hourlyRateEffectiveAt(repId, "2026-06-22T04:00:00.000Z").rateCents).toBe(null);
    // Re-add $25 effective Jun 1: the newest write supersedes the pending null.
    hourly.setHourlyRate(T2, 1, repId, 2500, "2026-06-01T00:00:00.000Z");
    expect(hourly.hourlyRateEffectiveAt(repId, "2026-06-22T04:00:00.000Z").rateCents).toBe(2500);
    expect(hourly.hourlyRateEffectiveAt(repId, wk.weekStartUtc).rateCents).toBe(2500);
    // A mid-week change still works under the rule (newest write dated mid-week).
    hourly.setHourlyRate(T2, 1, repId, 3000, "2026-06-10T00:00:00.000Z");
    expect(hourly.hourlyRateEffectiveAt(repId, wk.weekStartUtc).rateCents).toBe(2500);
    expect(hourly.hourlyRateEffectiveAt(repId, nwk.weekStartUtc).rateCents).toBe(3000);
  });
});

describe("open clock session blocks finalize (OPEN_CLOCK_SESSION)", () => {
  it("week overview raises the named exception and batch FINALIZE skips the rep", () => {
    const repId = REP_HOURLY_ONLY;
    seedSession(repId, T1, new Date(Date.parse(nwk.weekStartUtc) + 40 * 3_600_000).toISOString(), null); // forgotten clock-out
    const ov = svc.getWeekOverview(T1, 1, NEXT_WEEK_REF, null);
    const exc = ov.exceptions.find(x => x.type === "OPEN_CLOCK_SESSION" && x.repId === repId);
    expect(exc).toBeTruthy();
    const row = ov.rows.find(r => r.repId === repId)!;
    expect(row.openClockSessions).toBe(1);
    expect(row.hourlyPayCents).toBeGreaterThan(0);

    const res = svc.batchTransitionWeek(T1, 1, NEXT_WEEK_REF, "FINALIZE", [repId]);
    expect(res.results[0].result).toMatch(/BLOCKED \(OPEN_CLOCK_SESSION/);
    // Still OPEN — nothing was finalized.
    expect(svc.listStatements(T1, { repIds: [repId], weekStartUtc: nwk.weekStartUtc })[0].status).toBe("OPEN");

    // Clock the session out (close the punch) → finalize proceeds.
    const open = rawDb.prepare(`SELECT id FROM clock_sessions WHERE rep_id = ? AND clocked_out IS NULL`).get(repId) as any;
    rawDb.prepare(`UPDATE clock_sessions SET clocked_out = ?, duration_minutes = 120 WHERE id = ?`)
      .run(new Date(Date.parse(nwk.weekStartUtc) + 42 * 3_600_000).toISOString(), open.id);
    const res2 = svc.batchTransitionWeek(T1, 1, NEXT_WEEK_REF, "FINALIZE", [repId]);
    expect(res2.results[0].result).toBe("FINALIZED");
  });
});

describe("F5: locked pre-hourly statements never fall back to LIVE hourly", () => {
  it("a FINALIZED statement with NULL hourly renders a zero block even after a rate is backdated", () => {
    const repId = REP_HOURLY_ONLY;
    // Simulate a statement locked BEFORE the hourly plane existed.
    rawDb.prepare(
      `UPDATE commission_statements SET status='FINALIZED', hourly_minutes=NULL, hourly_rate_cents=NULL, hourly_pay_cents=0
       WHERE tenant_id=? AND rep_id=? AND week_start_utc=?`,
    ).run(T1, repId, wk.weekStartUtc);
    // Backdate a rich rate before that frozen week — live math now differs…
    hourly.setHourlyRate(T1, 1, repId, 9900, "2026-01-01T00:00:00.000Z");
    expect(hourly.hourlyRateEffectiveAt(repId, wk.weekStartUtc).rateCents).toBe(9900);
    // …but the locked row renders the frozen (zero/empty) block, not live money.
    const ov = svc.getWeekOverview(T1, 1, WEEK_REF, null);
    const row = ov.rows.find(r => r.repId === repId)!;
    expect(row.status).toBe("FINALIZED");
    expect(row.hours).toBe(0);
    expect(row.hourlyRateCents).toBeNull();
    expect(row.hourlyPayCents).toBe(0);
  });
});
