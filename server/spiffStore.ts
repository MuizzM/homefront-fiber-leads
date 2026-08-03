// ── Spiff store (sales-incentive recognition ledger) ──────────────────────────
// A SEPARATE recognition/bonus ledger. It only READS the sale history
// (knock_log) to build a rep's performance snapshot and INSERTS into its own
// `spiffs` table. It NEVER reads or writes commission/payroll tables — a spiff
// is tracked (earned → approved → paid) and an admin approves it; money is never
// silently injected into pay.
//
// ── EXACTLY-ONCE PAYMENT (read this before touching a status) ─────────────────
// THIS LEDGER IS THE ONLY PAYMENT RAIL FOR A SPIFF. Nothing else in the codebase
// reads `spiffs.amount_cents` — no commission statement, no payroll export, no
// payout batch — so a spiff becomes money at exactly one place: the
// `approved → paid` transition below. (An earlier hourly-pay payroll CSV also
// summed approved spiffs into a payroll `Total`, which made a spiff payable
// twice; that whole plane was reverted, and this file is deliberately the sole
// consumer again. If you ever add a second reader of amount_cents, you are
// adding a second payment instruction — don't, unless it settles through
// markSpiffPaid.)
//
//   earned    the algorithm awarded it. Not money yet — nobody owes anything.
//   approved  an admin OK'd it. It is OWED and it is queued to be paid out.
//   paid      settled. TERMINAL. It can never be paid, re-approved, or reversed
//             by this module again.
//
// Both transitions are compare-and-swap UPDATEs (`WHERE status = <expected>` +
// rowcount check), so a double-click, a retried request, or two managers acting
// at the same instant collapse into exactly one transition and exactly one audit
// event — never a doubled payment.
//
// Determinism: the pure award logic lives in shared/spiffEngine.ts. Everything
// clock-/dice-/DB-dependent lives HERE, and the "random" roll is derived from a
// caller-supplied seed via a pure hash — so the same sale evaluates identically
// every time (and in tests).
import { rawDb } from "./db";
import { storage } from "./storage";
import {
  decideSpiff,
  heatScore,
  DEFAULT_SPIFF_CONFIG,
  type PerfSnapshot,
  type SpiffConfig,
  type SpiffDecision,
} from "@shared/spiffEngine";

// ── Schema (idempotent; additive) ─────────────────────────────────────────────
// Created on import so the ledger exists wherever the store is used (server +
// integration tests) without touching the central migration list.
export function ensureSpiffSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS spiffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      rep_id INTEGER NOT NULL,
      sale_ref TEXT,
      amount_cents INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'earned',
      -- ISO-8601 with milliseconds and a trailing Z, ALWAYS. Every writer passes
      -- one explicitly; the SQLite default below is the odd one out and only
      -- exists because the column predates that rule. See the note on
      -- normalizeSpiffTimestamps for why the mismatch is not cosmetic.
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by INTEGER,
      approved_at TEXT,
      paid_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_spiffs_tenant_rep ON spiffs(tenant_id, rep_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spiffs_sale_ref ON spiffs(tenant_id, sale_ref) WHERE sale_ref IS NOT NULL;
  `);
  normalizeSpiffTimestamps();
}

/**
 * Rewrite any `created_at` still in SQLite's `datetime('now')` shape
 * (`2026-08-03 21:05:00`) into the ISO shape everything else uses
 * (`2026-08-03T21:05:00.000Z`).
 *
 * WHY THIS MATTERS, given both strings name the same instant: this column is
 * compared and ordered as TEXT. `' '` sorts before `'T'`, so the two formats do
 * not interleave — every space-form row sorts before every ISO row regardless of
 * date, and a range filter written against ISO bounds matches NONE of them.
 *
 * That silently broke real behaviour. The award stores (campaigns, milestones,
 * momentum, door drops) all relied on the default, so:
 *   · door-drop daily caps never engaged — the "awarded today" query matched
 *     nothing, so every cap read as $0 spent;
 *   · the doors-since-last-drop counter never reset after a payout, leaving reps
 *     permanently past the pity ceiling and dropping on EVERY verified door;
 *   · rep spiff history and payout batches ordered those awards as a block
 *     instead of by date.
 *
 * Idempotent, cheap (indexed by nothing, but the table is small and the LIKE is
 * anchored), and safe to run on every boot.
 */
export function normalizeSpiffTimestamps(): void {
  try {
    rawDb.prepare(
      `UPDATE spiffs
          SET created_at = replace(created_at, ' ', 'T') || '.000Z'
        WHERE created_at LIKE '____-__-__ __:__:__'`,
    ).run();
  } catch { /* a read-only or mid-migration db must not block boot */ }
}
ensureSpiffSchema();

const DAY_MS = 86_400_000;

/** UTC calendar day (YYYY-MM-DD) for a timestamp. */
function ymdUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Deterministic roll in [0,1) from a seed string (FNV-1a 32-bit). The server
 * passes a per-sale seed; identical seed → identical roll, which is what makes
 * the "random" spiff branch reproducible and unit-testable.
 */
export function seededRoll(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 → unsigned; divide by 2^32 for [0,1).
  return (h >>> 0) / 0x100000000;
}

/**
 * Build a rep's performance snapshot READ-ONLY from sold, non-superseded knocks.
 * `nowMs` is supplied by the caller (never read here) so the windows are stable
 * and the function stays testable. Never throws on missing data — an unknown rep
 * simply reads as all-zeros.
 */
export function buildPerfSnapshot(
  tenantId: number,
  repId: number,
  nowMs: number,
  spiffsGrantedToday = 0,
  spiffCentsGrantedToday = 0,
): PerfSnapshot {
  const windowDays = 7;
  const baselineDays = 21; // the 3 weeks BEFORE the recent week
  let rows: Array<{ knocked_at: string }> = [];
  try {
    rows = rawDb.prepare(
      `SELECT knocked_at FROM knock_log
        WHERE tenant_id = ? AND rep_id = ? AND outcome = 'sold' AND COALESCE(superseded, 0) = 0`,
    ).all(tenantId, repId) as Array<{ knocked_at: string }>;
  } catch {
    rows = [];
  }

  const times = rows
    .map((r) => Date.parse(r.knocked_at))
    .filter((t) => Number.isFinite(t));

  const totalSales = times.length;

  let recentSalesCount = 0;    // last 7d
  let priorWeekCount = 0;      // 8..14d ago (for trend)
  let baselineCount = 0;       // 8..28d ago (for trailing average)
  const saleDays = new Set<string>();
  for (const t of times) {
    const ageDays = (nowMs - t) / DAY_MS;
    if (ageDays >= 0 && ageDays < windowDays) recentSalesCount++;
    if (ageDays >= windowDays && ageDays < windowDays * 2) priorWeekCount++;
    if (ageDays >= windowDays && ageDays < windowDays + baselineDays) baselineCount++;
    saleDays.add(ymdUtc(t));
  }

  const salesVelocityPerDay = recentSalesCount / windowDays;
  const trailingAvgPerDay = baselineCount / baselineDays;
  const recentTrend = recentSalesCount - priorWeekCount;

  // Consecutive selling days ending at the most recent sale day: walk back one
  // calendar day at a time while each day has a sale.
  let currentStreakDays = 0;
  if (times.length) {
    const latest = Math.max(...times);
    let cursor = Date.parse(`${ymdUtc(latest)}T00:00:00.000Z`);
    while (saleDays.has(ymdUtc(cursor))) {
      currentStreakDays++;
      cursor -= DAY_MS;
    }
  }

  return {
    totalSales,
    recentSalesCount,
    windowDays,
    salesVelocityPerDay,
    trailingAvgPerDay,
    currentStreakDays,
    recentTrend,
    spiffsGrantedToday,
    spiffCentsGrantedToday,
  };
}

/**
 * What a rep has already been awarded on a given UTC day — BOTH the count and
 * the cents. The cents figure is the one the anti-farming money cap reads: with
 * a variable award amount, "2 spiffs" no longer means "$100", so bounding the
 * count alone would not bound the spend.
 */
export function spiffsGrantedOn(
  tenantId: number,
  repId: number,
  nowMs: number,
): { count: number; cents: number } {
  try {
    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM spiffs
        WHERE tenant_id = ? AND rep_id = ? AND substr(created_at, 1, 10) = ?`,
    ).get(tenantId, repId, ymdUtc(nowMs)) as { n: number; c: number };
    return { count: Number(row?.n ?? 0), cents: Number(row?.c ?? 0) };
  } catch {
    return { count: 0, cents: 0 };
  }
}

export interface SpiffRow {
  id: number;
  tenantId: number;
  repId: number;
  saleRef: string | null;
  amountCents: number;
  reason: string;
  status: string;
  createdAt: string;
  approvedBy: number | null;
  approvedAt: string | null;
  paidAt: string | null;
}

function mapRow(r: any): SpiffRow {
  return {
    id: r.id, tenantId: r.tenant_id, repId: r.rep_id, saleRef: r.sale_ref,
    amountCents: r.amount_cents, reason: r.reason, status: r.status,
    createdAt: r.created_at, approvedBy: r.approved_by, approvedAt: r.approved_at, paidAt: r.paid_at,
  };
}

export interface EvaluateInput {
  tenantId: number;
  repId: number;
  saleRef: string;
  /** Server-supplied wall clock for the snapshot windows + created_at day. */
  nowMs: number;
  /** Server-supplied seed for the deterministic random roll. */
  seed: string;
  actorId?: number | null;
  config?: SpiffConfig;
}

export interface EvaluateResult {
  decision: SpiffDecision;
  spiff: SpiffRow | null;
  /** True when a prior spiff already existed for this saleRef (idempotent skip). */
  duplicate: boolean;
}

/**
 * Evaluate a committed sale for a spiff and, if earned, insert ONE ledger row.
 *
 * CALLED READ-ONLY WITH RESPECT TO MONEY: builds the snapshot from knock_log,
 * decides via the pure engine, and writes only to `spiffs`. It runs OUTSIDE the
 * commission transaction and the route wraps it in try/catch, so a spiff failure
 * can never affect the sale or its commission. Idempotent on saleRef: a knock
 * dedupe-replay re-evaluates to the SAME row instead of a second award.
 */
export function evaluateSpiffForSale(input: EvaluateInput): EvaluateResult {
  const { tenantId, repId, saleRef, nowMs, seed } = input;
  const config = input.config ?? DEFAULT_SPIFF_CONFIG;

  // Idempotency: never award twice for the same sale.
  const prior = rawDb.prepare(
    `SELECT * FROM spiffs WHERE tenant_id = ? AND sale_ref = ?`,
  ).get(tenantId, saleRef) as any;
  if (prior) {
    return { decision: { awarded: false, amountCents: 0, reason: null }, spiff: mapRow(prior), duplicate: true };
  }

  const grantedToday = spiffsGrantedOn(tenantId, repId, nowMs);
  const perf = buildPerfSnapshot(tenantId, repId, nowMs, grantedToday.count, grantedToday.cents);
  // This sale is already committed to knock_log, so totalSales includes it → it
  // is the rep's lifetime sale ordinal for the milestone check.
  const decision = decideSpiff({ saleRef, lifetimeSaleNumber: perf.totalSales }, perf, seededRoll(seed), config);

  if (!decision.awarded) {
    return { decision, spiff: null, duplicate: false };
  }

  const createdAt = new Date(nowMs).toISOString();
  try {
    const info = rawDb.prepare(
      `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'earned', ?)`,
    ).run(tenantId, repId, saleRef, decision.amountCents, decision.reason, createdAt);
    const row = rawDb.prepare(`SELECT * FROM spiffs WHERE id = ?`).get(info.lastInsertRowid) as any;
    try {
      storage.logActivity(input.actorId ?? null, "spiff.earned", "spiff", Number(info.lastInsertRowid),
        { repId, saleRef, reason: decision.reason, amountCents: decision.amountCents }, undefined, tenantId);
    } catch { /* audit is best-effort */ }
    return { decision, spiff: mapRow(row), duplicate: false };
  } catch (e: any) {
    // Unique-index race on sale_ref (concurrent replay) → treat as idempotent.
    const existing = rawDb.prepare(`SELECT * FROM spiffs WHERE tenant_id = ? AND sale_ref = ?`).get(tenantId, saleRef) as any;
    if (existing) return { decision: { awarded: false, amountCents: 0, reason: null }, spiff: mapRow(existing), duplicate: true };
    throw e;
  }
}

// ── Read models ───────────────────────────────────────────────────────────────

export interface RepSpiffSummary {
  repId: number;
  spiffs: SpiffRow[];
  heat: number;
  snapshot: PerfSnapshot;
  totals: { earnedCents: number; approvedCents: number; paidCents: number; count: number };
}

/** How many spiff cards the rep feed returns. The TOTALS are always computed
 *  over the whole ledger in SQL, so a long-tenured rep's running total stays
 *  exact even though the feed itself is bounded. */
const REP_FEED_LIMIT = 100;

/** A rep's own spiff feed + their current heat score. Tenant-walled by caller. */
export function getRepSpiffs(tenantId: number, repId: number, nowMs: number): RepSpiffSummary {
  const rows = rawDb.prepare(
    `SELECT * FROM spiffs WHERE tenant_id = ? AND rep_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(tenantId, repId, REP_FEED_LIMIT).map(mapRow);
  const granted = spiffsGrantedOn(tenantId, repId, nowMs);
  const snapshot = buildPerfSnapshot(tenantId, repId, nowMs, granted.count, granted.cents);
  // Integer-cent aggregation in SQL — never a sum of floats, and never bounded
  // by the feed limit above.
  const totals = { earnedCents: 0, approvedCents: 0, paidCents: 0, count: 0 };
  const agg = rawDb.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c FROM spiffs
      WHERE tenant_id = ? AND rep_id = ? GROUP BY status`,
  ).all(tenantId, repId) as Array<{ status: string; n: number; c: number }>;
  for (const r of agg) {
    totals.count += Number(r.n) || 0;
    if (r.status === "earned") totals.earnedCents += Number(r.c) || 0;
    else if (r.status === "approved") totals.approvedCents += Number(r.c) || 0;
    else if (r.status === "paid") totals.paidCents += Number(r.c) || 0;
  }
  return { repId, spiffs: rows, heat: heatScore(snapshot), snapshot, totals };
}

export interface TeamHeatEntry {
  repId: number;
  name: string | null;
  role: string | null;
  heat: number;
  snapshot: PerfSnapshot;
  earnedCents: number;
  approvedCents: number;
  paidCents: number;
  spiffCount: number;
}

/**
 * The algorithm data admins/managers see: every rep in scope with their heat
 * score, the snapshot that produced it, and their earned/approved/paid totals.
 * `scope` (undefined = whole tenant) walls the read; a null/empty scope sees no
 * one. Tenant-walled.
 */
export function getTeamHeat(
  tenantId: number,
  nowMs: number,
  scope: number[] | undefined,
): TeamHeatEntry[] {
  const members = storage.getTeamMembers(tenantId) as Array<{ id: number; name: string | null; role: string | null }>;
  const scoped = scope === undefined ? members : members.filter((m) => scope.includes(m.id));

  const totals = new Map<number, { earned: number; approved: number; paid: number; count: number }>();
  const rows = rawDb.prepare(
    `SELECT rep_id, status, amount_cents FROM spiffs WHERE tenant_id = ?`,
  ).all(tenantId) as Array<{ rep_id: number; status: string; amount_cents: number }>;
  for (const r of rows) {
    const t = totals.get(r.rep_id) ?? { earned: 0, approved: 0, paid: 0, count: 0 };
    if (r.status === "earned") t.earned += r.amount_cents;
    else if (r.status === "approved") t.approved += r.amount_cents;
    else if (r.status === "paid") t.paid += r.amount_cents;
    t.count++;
    totals.set(r.rep_id, t);
  }

  return scoped.map((m) => {
    const snapshot = buildPerfSnapshot(tenantId, m.id, nowMs, 0);
    const t = totals.get(m.id) ?? { earned: 0, approved: 0, paid: 0, count: 0 };
    return {
      repId: m.id, name: m.name, role: m.role,
      heat: heatScore(snapshot), snapshot,
      earnedCents: t.earned, approvedCents: t.approved, paidCents: t.paid, spiffCount: t.count,
    };
  }).sort((a, b) => b.heat - a.heat);
}

export interface ActionableSpiff extends SpiffRow {
  repName: string | null;
}

/**
 * Spiffs still in a money-transition state (earned or approved) — the admin's
 * approve/mark-paid work queue. Tenant-walled; `scope` (undefined = whole
 * tenant) restricts by rep, and an empty scope returns nothing.
 */
export function getActionableSpiffs(tenantId: number, scope: number[] | undefined): ActionableSpiff[] {
  if (scope !== undefined && scope.length === 0) return [];
  const params: any[] = [tenantId];
  let scopeSql = "";
  if (scope !== undefined) {
    scopeSql = ` AND rep_id IN (${scope.map(() => "?").join(",")})`;
    params.push(...scope);
  }
  const rows = rawDb.prepare(
    `SELECT * FROM spiffs
      WHERE tenant_id = ? AND status IN ('earned','approved')${scopeSql}
      ORDER BY (status = 'earned') DESC, created_at DESC, id DESC`,
  ).all(...params) as any[];
  const names = new Map((storage.getTeamMembers(tenantId) as Array<{ id: number; name: string | null }>).map((m) => [m.id, m.name]));
  return rows.map((r) => ({ ...mapRow(r), repName: names.get(r.rep_id) ?? null }));
}

/** Fetch one spiff (tenant-walled). */
export function getSpiffById(tenantId: number, id: number): SpiffRow | null {
  const r = rawDb.prepare(`SELECT * FROM spiffs WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as any;
  return r ? mapRow(r) : null;
}

export type TransitionResult =
  | { ok: true; spiff: SpiffRow }
  | { ok: false; reason: "not_found" | "invalid_transition" | "self_approval"; from?: string };

/**
 * earned → approved. Records approver + timestamp.
 *
 * COMPARE-AND-SWAP: the UPDATE itself carries `AND status = 'earned'` and the
 * rowcount is checked, so two managers approving the same spiff at the same
 * instant produce exactly ONE transition — the loser gets `invalid_transition`
 * and the caller emits no second audit/payment event.
 *
 * SEGREGATION OF DUTIES: `approverRepId` (the approver's own team-member id, if
 * they have one) may never equal the spiff's rep. An admin who also sells does
 * not get to sign off their own bonus.
 */
export function approveSpiff(
  tenantId: number,
  id: number,
  approverUserId: number,
  nowMs: number,
  approverRepId?: number | null,
): TransitionResult {
  const cur = getSpiffById(tenantId, id);
  if (!cur) return { ok: false, reason: "not_found" };
  if (approverRepId != null && Number(approverRepId) === Number(cur.repId)) {
    return { ok: false, reason: "self_approval", from: cur.status };
  }
  if (cur.status !== "earned") return { ok: false, reason: "invalid_transition", from: cur.status };
  const info = rawDb.prepare(
    `UPDATE spiffs SET status = 'approved', approved_by = ?, approved_at = ?
      WHERE tenant_id = ? AND id = ? AND status = 'earned'`,
  ).run(approverUserId, new Date(nowMs).toISOString(), tenantId, id);
  if (info.changes !== 1) {
    // Lost the race: somebody else moved it between our read and our write.
    const after = getSpiffById(tenantId, id);
    return { ok: false, reason: "invalid_transition", from: after?.status ?? cur.status };
  }
  return { ok: true, spiff: getSpiffById(tenantId, id)! };
}

/**
 * approved → paid. Stamps paid_at. Only a currently-`approved` spiff may be
 * marked paid (an admin approves before pay leaves the building).
 *
 * THIS IS THE EXACTLY-ONCE POINT. `paid` is terminal and removes the spiff from
 * the payroll export forever, so the transition is a compare-and-swap on
 * `status = 'approved'`: a double-click, a retried request, or two managers at
 * once all collapse to one settlement and one audit line.
 */
export function markSpiffPaid(tenantId: number, id: number, nowMs: number): TransitionResult {
  const cur = getSpiffById(tenantId, id);
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.status !== "approved") return { ok: false, reason: "invalid_transition", from: cur.status };
  const info = rawDb.prepare(
    `UPDATE spiffs SET status = 'paid', paid_at = ?
      WHERE tenant_id = ? AND id = ? AND status = 'approved'`,
  ).run(new Date(nowMs).toISOString(), tenantId, id);
  if (info.changes !== 1) {
    const after = getSpiffById(tenantId, id);
    return { ok: false, reason: "invalid_transition", from: after?.status ?? cur.status };
  }
  return { ok: true, spiff: getSpiffById(tenantId, id)! };
}

export interface BulkTransitionResult {
  /** Spiffs that actually transitioned on THIS call (never a repeat). */
  changed: SpiffRow[];
  /** Ids that were skipped, with why — wrong status, wrong tenant, self-approval. */
  skipped: Array<{ id: number; reason: "not_found" | "invalid_transition" | "self_approval"; from?: string }>;
  /** Cents that moved on this call. */
  totalCents: number;
}

/**
 * Bulk earned → approved. Applies the SAME compare-and-swap per row inside one
 * transaction, so a bulk approve is exactly as safe as clicking each row: a row
 * someone else already approved is reported as skipped, not silently re-approved.
 */
export function approveSpiffs(
  tenantId: number,
  ids: number[],
  approverUserId: number,
  nowMs: number,
  approverRepId?: number | null,
): BulkTransitionResult {
  return runBulk(ids, (id) => approveSpiff(tenantId, id, approverUserId, nowMs, approverRepId));
}

/**
 * Bulk approved → paid — the payroll settlement action. Per-row compare-and-swap
 * inside one transaction: every id in `ids` is paid at most once, no matter how
 * many times the button is pressed or how many admins press it.
 */
export function markSpiffsPaid(tenantId: number, ids: number[], nowMs: number): BulkTransitionResult {
  return runBulk(ids, (id) => markSpiffPaid(tenantId, id, nowMs));
}

function runBulk(ids: number[], step: (id: number) => TransitionResult): BulkTransitionResult {
  const unique = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out: BulkTransitionResult = { changed: [], skipped: [], totalCents: 0 };
  const apply = rawDb.transaction(() => {
    for (const id of unique) {
      const r = step(id);
      if (r.ok) { out.changed.push(r.spiff); out.totalCents += r.spiff.amountCents; }
      else out.skipped.push({ id, reason: r.reason, from: r.from });
    }
  });
  apply();
  return out;
}

/**
 * Every spiff this tenant currently OWES: status = 'approved'. Approved money is
 * the amount that still has to leave the building, and it is exactly the set a
 * "mark paid" settlement retires. Tenant-walled; `scope` (undefined = whole
 * tenant) restricts by rep, an empty scope returns nothing.
 */
export function getPayableSpiffs(tenantId: number, scope: number[] | undefined): SpiffRow[] {
  if (scope !== undefined && scope.length === 0) return [];
  const params: any[] = [tenantId];
  let scopeSql = "";
  if (scope !== undefined) {
    scopeSql = ` AND rep_id IN (${scope.map(() => "?").join(",")})`;
    params.push(...scope);
  }
  return (rawDb.prepare(
    `SELECT * FROM spiffs WHERE tenant_id = ? AND status = 'approved'${scopeSql} ORDER BY created_at ASC, id ASC`,
  ).all(...params) as any[]).map(mapRow);
}
