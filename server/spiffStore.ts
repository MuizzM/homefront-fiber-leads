// ── Spiff store (sales-incentive recognition ledger) ──────────────────────────
// A SEPARATE recognition/bonus ledger. It only READS the sale history
// (knock_log) to build a rep's performance snapshot and INSERTS into its own
// `spiffs` table. It NEVER reads or writes commission/payroll tables — a spiff
// is tracked (earned → approved → paid) and an admin approves it; money is never
// silently injected into pay.
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_by INTEGER,
      approved_at TEXT,
      paid_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_spiffs_tenant_rep ON spiffs(tenant_id, rep_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_spiffs_sale_ref ON spiffs(tenant_id, sale_ref) WHERE sale_ref IS NOT NULL;
  `);
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
  };
}

/** Count of spiffs a rep has already earned on a given UTC day. */
function spiffsGrantedOn(tenantId: number, repId: number, nowMs: number): number {
  try {
    const row = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM spiffs
        WHERE tenant_id = ? AND rep_id = ? AND substr(created_at, 1, 10) = ?`,
    ).get(tenantId, repId, ymdUtc(nowMs)) as { n: number };
    return row?.n ?? 0;
  } catch {
    return 0;
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
  const perf = buildPerfSnapshot(tenantId, repId, nowMs, grantedToday);
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

/** A rep's own spiff feed + their current heat score. Tenant-walled by caller. */
export function getRepSpiffs(tenantId: number, repId: number, nowMs: number): RepSpiffSummary {
  const rows = rawDb.prepare(
    `SELECT * FROM spiffs WHERE tenant_id = ? AND rep_id = ? ORDER BY created_at DESC, id DESC`,
  ).all(tenantId, repId).map(mapRow);
  const snapshot = buildPerfSnapshot(tenantId, repId, nowMs, spiffsGrantedOn(tenantId, repId, nowMs));
  const totals = { earnedCents: 0, approvedCents: 0, paidCents: 0, count: rows.length };
  for (const s of rows) {
    if (s.status === "earned") totals.earnedCents += s.amountCents;
    else if (s.status === "approved") totals.approvedCents += s.amountCents;
    else if (s.status === "paid") totals.paidCents += s.amountCents;
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
  | { ok: false; reason: "not_found" | "invalid_transition"; from?: string };

/** earned → approved. Records approver + timestamp. Idempotent-safe: only a
 *  currently-`earned` spiff may be approved. */
export function approveSpiff(tenantId: number, id: number, approverUserId: number, nowMs: number): TransitionResult {
  const cur = getSpiffById(tenantId, id);
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.status !== "earned") return { ok: false, reason: "invalid_transition", from: cur.status };
  rawDb.prepare(`UPDATE spiffs SET status = 'approved', approved_by = ?, approved_at = ? WHERE tenant_id = ? AND id = ?`)
    .run(approverUserId, new Date(nowMs).toISOString(), tenantId, id);
  return { ok: true, spiff: getSpiffById(tenantId, id)! };
}

/** approved → paid. Stamps paid_at. Only a currently-`approved` spiff may be
 *  marked paid (an admin approves before pay leaves the building). */
export function markSpiffPaid(tenantId: number, id: number, nowMs: number): TransitionResult {
  const cur = getSpiffById(tenantId, id);
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.status !== "approved") return { ok: false, reason: "invalid_transition", from: cur.status };
  rawDb.prepare(`UPDATE spiffs SET status = 'paid', paid_at = ? WHERE tenant_id = ? AND id = ?`)
    .run(new Date(nowMs).toISOString(), tenantId, id);
  return { ok: true, spiff: getSpiffById(tenantId, id)! };
}
