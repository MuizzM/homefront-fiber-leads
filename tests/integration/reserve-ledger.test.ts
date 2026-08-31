// ── Chargeback reserve — ledger, cap, idempotency, RBAC, tenancy ─────────────
//
// The reserve is a real payroll instruction, so the properties tested here are
// the ones that would cost money if they broke:
//   • the balance comes from the append-only ledger, computed in SQL
//   • the weekly hold is IDEMPOTENT per (rep, week) — recalculating or
//     re-finalizing a statement can never double-hold
//   • the cap is never exceeded and the balance is never negative
//   • the append-only DB triggers really do ABORT an UPDATE and a DELETE
//   • a per-rep override beats the org default, and NO override reproduces
//     today's org-wide behaviour exactly
//   • a rep cannot read another rep's reserve; a manager cannot move the money;
//     a cross-tenant rep is 404, not 403
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeHoldback } from "../../shared/commissionReserve";
import { DEFAULT_RETRO_TIERS } from "../../shared/commissionTiers";
import { weekBoundsFor, DEFAULT_WORKWEEK } from "../../shared/workweek";

let server: Server;
let baseUrl = "";
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: any;
let svc: typeof import("../../server/commissionService");
let reserve: typeof import("../../server/reserveService");

type Fixture = { userId: number; memberId: number; session: string };

function makePerson(name: string, loginRole: string, tenantId: number, memberRole = "rep"): Fixture {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@reserve.example.test`;
  const member = storage.createTeamMember({ name, email, role: memberRole, active: true, reportsToId: null, tenantId } as any);
  const user = storage.createUser({ name, email, role: loginRole, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...init.headers },
  });
}

const T1 = 1;
let T2 = 0;
let admin1: Fixture, mgr1: Fixture, rep1: Fixture, repOther: Fixture, rep2: Fixture, admin2: Fixture;

// One concrete week per scenario so each rep's ledger is independent.
const WEEKS = [
  "2026-06-10T12:00:00Z",   // Jun 8–14
  "2026-06-17T12:00:00Z",   // Jun 15–21
  "2026-06-24T12:00:00Z",   // Jun 22–28
  "2026-07-01T12:00:00Z",   // Jun 29–Jul 5
];

function weekStartOf(ref: string) { return weekBoundsFor(ref, DEFAULT_WORKWEEK).weekStartUtc; }
function inWeek(ref: string) { return new Date(Date.parse(weekStartOf(ref)) + 3 * 3_600_000).toISOString(); }

let planVersionByTenant: Record<number, number> = {};
function activePlanFor(tenantId: number): number {
  if (planVersionByTenant[tenantId]) return planVersionByTenant[tenantId];
  const plan = svc.createPlan(tenantId, 1, { name: "Standard", type: "TIERED", tierMode: "RETROACTIVE_WEEKLY" });
  const version = svc.addPlanVersion(tenantId, 1, plan.id, { effectiveFrom: "2026-01-01", qualificationBasis: "QUALIFIED_AT", tiers: DEFAULT_RETRO_TIERS });
  svc.activatePlan(tenantId, 1, plan.id);
  planVersionByTenant[tenantId] = version.id;
  return version.id;
}

let saleSeq = 0;
/** Book `n` qualified sales inside `weekRef`, settle the week, and return the
 *  FINALIZED statement — the moment a hold is appended. */
function settleWeek(tenantId: number, repId: number, weekRef: string, n: number) {
  for (let i = 0; i < n; i++) {
    saleSeq += 1;
    svc.upsertSale(tenantId, 1, {
      repId, externalId: `res-${saleSeq}`, status: "QUALIFIED",
      soldAt: inWeek(weekRef), qualifiedAt: inWeek(weekRef),
    });
  }
  const out = svc.calculateOrRecalculateStatement({ tenantId, repId, weekReference: weekRef, actorId: 1 });
  return svc.transitionStatement(tenantId, 1, out.statement.id, "FINALIZE");
}

function holdRows(tenantId: number, repId: number) {
  return rawDb.prepare(`SELECT * FROM reserve_entries WHERE tenant_id = ? AND rep_id = ? AND kind = 'hold' ORDER BY id`).all(tenantId, repId) as any[];
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-reserve-ledger-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();          // creates + adopts the default tenant (id 1)
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  svc = await import("../../server/commissionService");
  reserve = await import("../../server/reserveService");

  T2 = storage.createTenant({
    slug: "reserve-b", companyName: "Reserve Org B", ownerName: "B Owner",
    ownerEmail: "owner-b@reserve.example.test", brandName: "Reserve B",
  } as any).id;

  // Both orgs run a 10% reserve so the org-wide default is exercised.
  rawDb.prepare(`UPDATE tenants SET commission_reserve_percent = 10 WHERE id IN (?, ?)`).run(T1, T2);

  admin1 = makePerson("Reserve Admin One", "admin", T1, "manager");
  mgr1 = makePerson("Reserve Mgr One", "manager", T1, "manager");
  rep1 = makePerson("Reserve Rep One", "rep", T1);
  repOther = makePerson("Reserve Rep Other", "rep", T1);
  rep2 = makePerson("Reserve Rep Two", "rep", T2);
  admin2 = makePerson("Reserve Admin Two", "admin", T2, "manager");

  for (const [tenantId, repId] of [[T1, rep1.memberId], [T1, repOther.memberId], [T2, rep2.memberId]] as const) {
    svc.assignPlanVersionToRep(tenantId, 1, { repId, commissionPlanVersionId: activePlanFor(tenantId), effectiveFrom: "2026-01-01" });
  }

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

// ── Balance + idempotent hold ────────────────────────────────────────────────
describe("the ledger is the balance", () => {
  it("settling a week appends ONE hold and the SQL balance matches it", () => {
    const stmt = settleWeek(T1, rep1.memberId, WEEKS[0], 8);
    expect(stmt.final_commission_cents).toBe(160000);          // 8 × $200 (retro tier)
    const holds = holdRows(T1, rep1.memberId);
    expect(holds.length).toBe(1);
    expect(holds[0].amount_cents).toBe(16000);                 // 10% of $1,600
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(16000);
  });

  it("the hold is IDEMPOTENT per (rep, week) - re-settling never double-holds", () => {
    const before = reserve.getReserveBalanceCents(T1, rep1.memberId);
    const stmtId = svc.listStatements(T1, { repIds: [rep1.memberId], weekStartUtc: weekStartOf(WEEKS[0]) })[0].id;

    // Mark paid → the settle path runs again for the same week.
    svc.transitionStatement(T1, 1, stmtId, "MARK_PAID");
    // And drive the recorder directly, twice more, the way a recalculation would.
    for (let i = 0; i < 2; i++) {
      const r = reserve.recordWeeklyHold({
        tenantId: T1, repId: rep1.memberId, statementId: stmtId,
        weekStartUtc: weekStartOf(WEEKS[0]), weekLabel: "Jun 8 - Jun 14, 2026",
        earnedCents: 160000, actorId: 1,
      });
      expect(r.inserted).toBe(false);                          // already held
    }
    // And the backfill sweep, which also runs on every reserve read.
    reserve.ensureHoldsForSettledStatements(T1, rep1.memberId, 1);

    expect(holdRows(T1, rep1.memberId).length).toBe(1);        // still exactly ONE
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(before);
  });

  it("a second week appends a second hold and the balance is their SQL sum", () => {
    settleWeek(T1, rep1.memberId, WEEKS[1], 8);
    const holds = holdRows(T1, rep1.memberId);
    expect(holds.length).toBe(2);
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(32000);
    const sql = rawDb.prepare(`SELECT SUM(amount_cents) AS s FROM reserve_entries WHERE tenant_id = ? AND rep_id = ?`).get(T1, rep1.memberId) as any;
    expect(Number(sql.s)).toBe(32000);
  });
});

// ── Per-rep override vs the org default ──────────────────────────────────────
describe("per-rep configuration", () => {
  it("no override → the resolved policy IS the org default, and the hold is identical to today's org-wide number", () => {
    const cfg = reserve.resolveRepReserveConfig(T1, repOther.memberId);
    expect(cfg.repReservePercent).toBeNull();
    expect(cfg.repReserveCapCents).toBeNull();
    expect(cfg.reservePercent).toBe(10);
    expect(cfg.percentSource).toBe("org");

    // The pre-cap behaviour, byte for byte: the per-rep, cap-aware holdback for a
    // rep with NO override and a balance under the cap equals the org-wide split.
    for (const earned of [160000, 8085, 1, 0, -5000]) {
      const perRep = svc.holdbackForStatement(T1, earned, repOther.memberId);
      const orgWide = computeHoldback({ earnedCents: earned, reservePercent: 10 });
      expect(perRep.reserveCents).toBe(orgWide.reserveCents);
      expect(perRep.netPayableCents).toBe(orgWide.netPayableCents);
      expect(perRep.reserveCents + perRep.netPayableCents).toBe(Math.trunc(earned));
    }
    // …and the legacy 2-argument call is untouched.
    expect(svc.holdbackForStatement(T1, 160000).reserveCents).toBe(16000);
  });

  it("a per-rep percent BEATS the org default on the actual weekly hold", () => {
    reserve.setRepReserveConfig(T1, repOther.memberId, admin1.userId, { reservePercent: 25 });
    expect(reserve.resolveRepReserveConfig(T1, repOther.memberId).reservePercent).toBe(25);

    settleWeek(T1, repOther.memberId, WEEKS[0], 8);            // $1,600 earned
    const holds = holdRows(T1, repOther.memberId);
    expect(holds.length).toBe(1);
    expect(holds[0].amount_cents).toBe(40000);                 // 25%, not the org's 10%
  });

  it("clearing the override with null falls back to the org default again", () => {
    reserve.setRepReserveConfig(T1, repOther.memberId, admin1.userId, { reservePercent: null });
    const cfg = reserve.resolveRepReserveConfig(T1, repOther.memberId);
    expect(cfg.repReservePercent).toBeNull();
    expect(cfg.reservePercent).toBe(10);
  });

  it("the cap defaults to $2,500 and a per-rep cap overrides it", () => {
    const base = reserve.resolveRepReserveConfig(T1, rep1.memberId);
    expect(base.reserveCapCents).toBe(250000);
    expect(base.capSource).toBe("default");
    reserve.setRepReserveConfig(T1, rep1.memberId, admin1.userId, { reserveCapCents: 40000 });
    const after = reserve.resolveRepReserveConfig(T1, rep1.memberId);
    expect(after.reserveCapCents).toBe(40000);
    expect(after.capSource).toBe("rep");
  });

  it("the reserve STOPS at the cap - the hold is trimmed, then nothing is held", () => {
    // rep1 is at $320 held with a $400 cap. A third $1,600 week would hold $160
    // uncapped; only $80 of room remains.
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(32000);
    settleWeek(T1, rep1.memberId, WEEKS[2], 8);
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(40000);   // exactly the cap
    const trimmed = holdRows(T1, rep1.memberId).at(-1);
    expect(trimmed.amount_cents).toBe(8000);                                 // trimmed, not 16000

    // A FOURTH week at the cap holds nothing at all — no zero-amount row either.
    const holdCount = holdRows(T1, rep1.memberId).length;
    settleWeek(T1, rep1.memberId, WEEKS[3], 8);
    expect(holdRows(T1, rep1.memberId).length).toBe(holdCount);
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(40000);

    const summary = reserve.getReserveSummary(T1, rep1.memberId);
    expect(summary.atCap).toBe(true);
    expect(summary.capRemainingCents).toBe(0);
    expect(summary.capProgressPercent).toBe(100);
    // The rep is paid their WHOLE week once the reserve is full.
    const h = svc.holdbackForStatement(T1, 160000, rep1.memberId);
    expect(h.reserveCents).toBe(0);
    expect(h.netPayableCents).toBe(160000);
  });

  it("rejects a nonsensical percent or cap", () => {
    expect(() => reserve.setRepReserveConfig(T1, rep1.memberId, admin1.userId, { reservePercent: 101 })).toThrow(/0 to 100/);
    expect(() => reserve.setRepReserveConfig(T1, rep1.memberId, admin1.userId, { reservePercent: 10.5 as any })).toThrow(/whole number/);
    expect(() => reserve.setRepReserveConfig(T1, rep1.memberId, admin1.userId, { reserveCapCents: -1 })).toThrow(/whole number of cents/);
  });
});

// ── Append-only enforcement, in the DATABASE ─────────────────────────────────
describe("reserve_entries is append-only at the DB level", () => {
  it("an UPDATE is ABORTed by trigger", () => {
    const row = holdRows(T1, rep1.memberId)[0];
    expect(() => rawDb.prepare(`UPDATE reserve_entries SET amount_cents = 1 WHERE id = ?`).run(row.id))
      .toThrow(/append_only/);
    expect((rawDb.prepare(`SELECT amount_cents FROM reserve_entries WHERE id = ?`).get(row.id) as any).amount_cents).toBe(row.amount_cents);
  });

  it("a DELETE is ABORTed by trigger", () => {
    const row = holdRows(T1, rep1.memberId)[0];
    expect(() => rawDb.prepare(`DELETE FROM reserve_entries WHERE id = ?`).run(row.id)).toThrow(/append_only/);
    expect(rawDb.prepare(`SELECT 1 FROM reserve_entries WHERE id = ?`).get(row.id)).toBeTruthy();
  });

  it("a wrong-signed, zero, or reasonless entry cannot be inserted at all", () => {
    const ins = (kind: string, amount: number, reason = "x") => rawDb.prepare(
      `INSERT INTO reserve_entries (tenant_id, rep_id, kind, amount_cents, reason) VALUES (?,?,?,?,?)`
    ).run(T1, rep1.memberId, kind, amount, reason);
    expect(() => ins("hold", -100)).toThrow(/sign|invalid/i);        // a hold cannot subtract
    expect(() => ins("drawdown", 100)).toThrow(/sign|invalid/i);     // a drawdown cannot add
    expect(() => ins("release", 100)).toThrow(/sign|invalid/i);
    expect(() => ins("drawdown", -100, "   ")).toThrow(/reason|invalid/i);
    expect(() => ins("nonsense", -100)).toThrow(/CHECK|constraint/i);
  });
});

// ── Manual admin movements ───────────────────────────────────────────────────
describe("manual drawdown and release", () => {
  it("a drawdown reduces the balance and is recorded with its reason", () => {
    const before = reserve.getReserveBalanceCents(T1, rep1.memberId);
    const out = reserve.applyDrawdown({ tenantId: T1, repId: rep1.memberId, amountCents: 5000, reason: "Chargeback - 12 Oak St cancelled", actorId: admin1.userId });
    expect(out.entry.amountCents).toBe(-5000);
    expect(out.balanceCents).toBe(before - 5000);
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(before - 5000);
  });

  it("a drawdown larger than the balance is REFUSED (400) - the balance never goes negative", async () => {
    const before = reserve.getReserveBalanceCents(T1, rep1.memberId);
    const res = await request(`/api/commission/reps/${rep1.memberId}/reserve/drawdown`, admin1.session, {
      method: "POST", body: JSON.stringify({ amountCents: before + 1, reason: "too big" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RESERVE_INSUFFICIENT_BALANCE");
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(before);
  });

  it("a release larger than the balance is REFUSED (400)", async () => {
    const before = reserve.getReserveBalanceCents(T1, rep1.memberId);
    const res = await request(`/api/commission/reps/${rep1.memberId}/reserve/release`, admin1.session, {
      method: "POST", body: JSON.stringify({ amountCents: before + 1, reason: "too big" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RESERVE_INSUFFICIENT_BALANCE");
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(before);
  });

  it("a reason is REQUIRED on every movement", async () => {
    const res = await request(`/api/commission/reps/${rep1.memberId}/reserve/drawdown`, admin1.session, {
      method: "POST", body: JSON.stringify({ amountCents: 100 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("RESERVE_REASON_REQUIRED");
  });

  it("a fractional or non-positive amount is REFUSED", async () => {
    for (const amountCents of [0, -100, 10.5]) {
      const res = await request(`/api/commission/reps/${rep1.memberId}/reserve/drawdown`, admin1.session, {
        method: "POST", body: JSON.stringify({ amountCents, reason: "nope" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("RESERVE_INVALID_AMOUNT");
    }
  });

  it("releasing with no amount returns the FULL balance and lands the ledger on zero", async () => {
    const before = reserve.getReserveBalanceCents(T1, rep1.memberId);
    expect(before).toBeGreaterThan(0);
    const res = await request(`/api/commission/reps/${rep1.memberId}/reserve/release`, admin1.session, {
      method: "POST", body: JSON.stringify({ reason: "Contract ended - releasing the balance" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).entry.amountCents).toBe(-before);
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(0);
    // Nothing was rewritten — the history is still every entry ever written.
    expect(holdRows(T1, rep1.memberId).length).toBeGreaterThan(0);
  });

  it("releasing an empty balance is REFUSED rather than writing a zero entry", async () => {
    const res = await request(`/api/commission/reps/${rep1.memberId}/reserve/release`, admin1.session, {
      method: "POST", body: JSON.stringify({ reason: "nothing there" }),
    });
    expect(res.status).toBe(400);
    expect(reserve.getReserveBalanceCents(T1, rep1.memberId)).toBe(0);
  });
});

// ── RBAC + tenancy ───────────────────────────────────────────────────────────
describe("RBAC and tenant isolation", () => {
  it("a rep sees their OWN reserve on the self-scoped endpoint", async () => {
    const res = await request("/api/me/reserve", repOther.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repId).toBe(repOther.memberId);
    expect(body.balanceCents).toBe(reserve.getReserveBalanceCents(T1, repOther.memberId));
  });

  it("a rep CANNOT read another rep's reserve", async () => {
    const res = await request(`/api/commission/reps/${rep1.memberId}/reserve`, repOther.session);
    expect(res.status).toBe(403);
    // …and there is no self-scoped route that takes an id to point elsewhere.
    const mine = await request("/api/me/reserve", repOther.session).then(r => r.json());
    expect(mine.repId).toBe(repOther.memberId);
  });

  it("a MANAGER may read a reserve but may NOT move the money", async () => {
    const read = await request(`/api/commission/reps/${rep1.memberId}/reserve`, mgr1.session);
    expect(read.status).toBe(200);

    const before = reserve.getReserveBalanceCents(T1, repOther.memberId);
    const drawdown = await request(`/api/commission/reps/${repOther.memberId}/reserve/drawdown`, mgr1.session, {
      method: "POST", body: JSON.stringify({ amountCents: 100, reason: "manager should not be able to" }),
    });
    expect(drawdown.status).toBe(403);
    const release = await request(`/api/commission/reps/${repOther.memberId}/reserve/release`, mgr1.session, {
      method: "POST", body: JSON.stringify({ amountCents: 100, reason: "manager should not be able to" }),
    });
    expect(release.status).toBe(403);
    expect(reserve.getReserveBalanceCents(T1, repOther.memberId)).toBe(before);
  });

  it("a rep cannot set anyone's reserve configuration", async () => {
    const res = await request(`/api/commission/reps/${repOther.memberId}/reserve-config`, rep1.session, {
      method: "PATCH", body: JSON.stringify({ reservePercent: 0 }),
    });
    expect(res.status).toBe(403);
  });

  it("cross-tenant is 404, not 403 - no id-space probing", async () => {
    const read = await request(`/api/commission/reps/${rep2.memberId}/reserve`, admin1.session);
    expect(read.status).toBe(404);

    const before = reserve.getReserveBalanceCents(T2, rep2.memberId);
    const drawdown = await request(`/api/commission/reps/${rep2.memberId}/reserve/drawdown`, admin1.session, {
      method: "POST", body: JSON.stringify({ amountCents: 100, reason: "cross tenant" }),
    });
    expect(drawdown.status).toBe(404);
    expect(reserve.getReserveBalanceCents(T2, rep2.memberId)).toBe(before);

    expect(() => reserve.resolveRepReserveConfig(T1, rep2.memberId)).toThrow(/not found/i);
  });

  it("an admin CAN configure and move, and the ledger stays tenant-scoped", async () => {
    const cfg = await request(`/api/commission/reps/${repOther.memberId}/reserve-config`, admin1.session, {
      method: "PATCH", body: JSON.stringify({ reservePercent: 15, reserveCapCents: 500000 }),
    });
    expect(cfg.status).toBe(200);
    const body = await cfg.json();
    expect(body.reservePercent).toBe(15);
    expect(body.reserveCapCents).toBe(500000);

    // Tenant 2's rep is untouched by any of tenant 1's activity.
    settleWeek(T2, rep2.memberId, WEEKS[0], 8);
    expect(reserve.getReserveBalanceCents(T2, rep2.memberId)).toBe(16000);
    const t2Rows = rawDb.prepare(`SELECT DISTINCT tenant_id FROM reserve_entries WHERE rep_id = ?`).all(rep2.memberId) as any[];
    expect(t2Rows.map(r => r.tenant_id)).toEqual([T2]);
    const read2 = await request(`/api/commission/reps/${rep2.memberId}/reserve`, admin2.session);
    expect(read2.status).toBe(200);
    expect((await read2.json()).balanceCents).toBe(16000);
  });

  it("an admin cannot set their OWN reserve configuration (self-dealing guard)", async () => {
    const res = await request(`/api/commission/reps/${admin1.memberId}/reserve-config`, admin1.session, {
      method: "PATCH", body: JSON.stringify({ reservePercent: 0 }),
    });
    expect(res.status).toBe(403);
  });
});
