/**
 * BANDWIDTH GOVERNOR — strategic Decodo spend control.
 *
 * The proxy plan is a fixed monthly pool (DECODO_BUDGET_GB, default 25GB).
 * This module makes sure we NEVER hit the hard wall again (a hard limit =
 * 407 storm = zero leads) by pacing spend against the billing cycle:
 *
 *   1. LEDGER — every proxied request records its bytes (content-length, or a
 *      measured-per-request estimate) into bandwidth_ledger. Writes are
 *      batched in memory and flushed every 15s so the hot path never touches
 *      the DB (same discipline as the scan_events batching).
 *
 *   2. PACING — usable budget = plan × (1 − DECODO_RESERVE_PCT, default 10%
 *      safety). budgetScale() compares the fraction of the cycle elapsed with
 *      the fraction of budget burned:
 *        burn > pace  → scale shrinks toward 0.10 (harvest budgets tighten)
 *        burn < pace  → scale grows up to 1.50 (hunt harder while we're ahead)
 *
 *   3. CUT ORDER — when scale < 0.5 the harvester drops Tier D2 entirely;
 *      when scale < 0.25 it also drops Tier D1. Tiers B/B2 (fresh hunting)
 *      are never starved — they produce the verified fresh leads. The
 *      coming-soon watchlist tick paces its own batch by scale with a 25%
 *      floor (flip watching is the top-yield channel).
 *
 *   4. CIRCUIT BREAKER — a run of auth/limit denials (407) opens the circuit
 *      for CIRCUIT_OPEN_MS (30 min): scanning suspends instead of hammering
 *      the gateway with doomed requests (which also flags the account).
 *      Any successful proxied response resets the counter.
 *
 *   5. ECONOMY — governorStats() feeds the fresh_harvest.economy report:
 *      GB today, GB this cycle, projected month-end GB, KB per fresh lead.
 *
 * Env: DECODO_BUDGET_GB (25), DECODO_RESERVE_PCT (10), DECODO_BILLING_DAY (1).
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

const BUDGET_GB = Math.max(1, Number(process.env.DECODO_BUDGET_GB) || 25);
const RESERVE = Math.min(0.9, Math.max(0, (Number(process.env.DECODO_RESERVE_PCT) || 10) / 100));
const BILLING_DAY = Math.min(28, Math.max(1, Number(process.env.DECODO_BILLING_DAY) || 1));
const USABLE_BYTES = BUDGET_GB * (1 - RESERVE) * 1e9;

const FLUSH_MS = 15_000;
const CIRCUIT_FAILS = 8;                 // 407s inside the window to trip
const CIRCUIT_WINDOW_MS = 5 * 60_000;
const CIRCUIT_OPEN_MS = 30 * 60_000;

// Fallback when a response carries no content-length: an EMA over the sizes we
// DO observe, seeded at 24KB (body + TLS/header overhead both directions) and
// clamped to a sane band so one giant or tiny response can't skew accounting.
const SEED_REQ_BYTES = 24_000;
const EST_REQ_MIN = 2_000;
const EST_REQ_MAX = 256_000;
const EST_REQ_ALPHA = 0.05;
let estReqBytes = SEED_REQ_BYTES;

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  try {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS bandwidth_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      requests INTEGER NOT NULL
    )`);
    rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_bandwidth_ledger_ts ON bandwidth_ledger(ts)`);
    ensured = true;
  } catch { /* migrations run elsewhere — ledger is best-effort */ }
}

// ── Batched ledger writes ────────────────────────────────────────────────────
let pendingBytes = 0;
let pendingReqs = 0;
let flushTimer: NodeJS.Timeout | null = null;

export function flushBandwidthLedger(): void {
  if (!pendingReqs && !pendingBytes) return;
  try {
    ensureTable();
    rawDb.prepare("INSERT INTO bandwidth_ledger (ts, bytes, requests) VALUES (?,?,?)")
      .run(Date.now(), pendingBytes, pendingReqs);
  } catch { /* best-effort */ }
  pendingBytes = 0;
  pendingReqs = 0;
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flushBandwidthLedger(); }, FLUSH_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

/** Record one proxied response. `contentLength` from headers, or 0 → estimate. */
export function recordProxyResponse(contentLength: number): void {
  pendingReqs++;
  if (contentLength > 0) {
    const sample = Math.min(contentLength, EST_REQ_MAX);
    estReqBytes = Math.min(EST_REQ_MAX, Math.max(EST_REQ_MIN,
      estReqBytes + EST_REQ_ALPHA * (sample - estReqBytes)));
    pendingBytes += contentLength;
  } else {
    pendingBytes += Math.round(estReqBytes);
  }
  scheduleFlush();
  if (pendingReqs >= 200) flushBandwidthLedger(); // high-rate safety valve
}

// ── Circuit breaker ──────────────────────────────────────────────────────────
let failTimes: number[] = [];
let circuitOpenUntil = 0;
let circuitLogAt = 0;

export function noteProxyAuthFailure(): void {
  const now = Date.now();
  failTimes = failTimes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  failTimes.push(now);
  if (failTimes.length >= CIRCUIT_FAILS && circuitOpenUntil < now) {
    circuitOpenUntil = now + CIRCUIT_OPEN_MS;
    failTimes = [];
    structuredLog("bandwidth.circuit_open", {
      reason: "proxy auth/limit denials", openMs: CIRCUIT_OPEN_MS,
    });
  }
}

export function noteProxySuccess(): void {
  if (failTimes.length) failTimes = [];
}

/** True while the circuit is open — callers must NOT issue proxied requests. */
export function isProxyCircuitOpen(): boolean {
  const open = Date.now() < circuitOpenUntil;
  if (open && Date.now() - circuitLogAt > 60_000) {
    circuitLogAt = Date.now();
    console.warn(`[bandwidth] circuit OPEN — proxy suspended for ${Math.round((circuitOpenUntil - Date.now()) / 60000)}m (auth/limit denials)`);
  }
  return open;
}

// ── Billing cycle + pacing ───────────────────────────────────────────────────
function cycleBounds(now = new Date()): { start: number; end: number } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const start = now.getUTCDate() >= BILLING_DAY
    ? Date.UTC(y, m, BILLING_DAY)
    : Date.UTC(y, m - 1, BILLING_DAY);
  const end = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, BILLING_DAY);
  return { start, end };
}

function sumSince(ts: number): { bytes: number; requests: number } {
  try {
    ensureTable();
    const row = rawDb.prepare("SELECT COALESCE(SUM(bytes),0) AS b, COALESCE(SUM(requests),0) AS r FROM bandwidth_ledger WHERE ts >= ?")
      .get(ts) as any;
    return { bytes: Number(row?.b ?? 0) + pendingBytes, requests: Number(row?.r ?? 0) + pendingReqs };
  } catch {
    return { bytes: pendingBytes, requests: pendingReqs };
  }
}

/**
 * Budget scale 0.10–1.50: compares cycle-elapsed fraction with budget-burned
 * fraction. No data yet → 1 (neutral). When the circuit is open → 0 (frozen).
 */
export function bandwidthBudgetScale(): number {
  if (isProxyCircuitOpen()) return 0;
  const { start, end } = cycleBounds();
  const now = Date.now();
  const elapsed = Math.max(0.02, (now - start) / (end - start)); // cycle fraction
  const { bytes } = sumSince(start);
  if (bytes <= 0) return 1;
  const burned = bytes / USABLE_BYTES;
  if (burned <= 0) return 1;
  const ratio = elapsed / burned;
  return Math.min(1.5, Math.max(0.1, ratio));
}

export interface GovernorStats {
  requests24h: number;
  mb24h: number;
  mbToday: number;
  gbCycle: number;
  budgetGb: number;
  usableGb: number;
  cyclePctUsed: number;
  projectedCycleGb: number;
  estReqBytes: number;
  scale: number;
  circuitOpen: boolean;
}

export function governorStats(): GovernorStats {
  const { start, end } = cycleBounds();
  const now = Date.now();
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const today = sumSince(dayStart.getTime());
  const last24h = sumSince(now - 24 * 3_600_000);
  const cycle = sumSince(start);
  const elapsedFrac = Math.max(0.02, (now - start) / (end - start));
  const cycleGb = cycle.bytes / 1e9;
  return {
    requests24h: last24h.requests,
    mb24h: +(last24h.bytes / 1e6).toFixed(1),
    mbToday: +(today.bytes / 1e6).toFixed(1),
    gbCycle: +cycleGb.toFixed(3),
    budgetGb: BUDGET_GB,
    usableGb: +(USABLE_BYTES / 1e9).toFixed(1),
    cyclePctUsed: +(100 * cycle.bytes / USABLE_BYTES).toFixed(1),
    projectedCycleGb: +(cycleGb / elapsedFrac).toFixed(2),
    estReqBytes: Math.round(estReqBytes),
    scale: +bandwidthBudgetScale().toFixed(2),
    circuitOpen: isProxyCircuitOpen(),
  };
}

/** Test hook: reset in-memory state (ledger rows persist per test DB). */
export function _resetGovernorForTests(): void {
  pendingBytes = 0; pendingReqs = 0;
  failTimes = []; circuitOpenUntil = 0; circuitLogAt = 0;
  estReqBytes = SEED_REQ_BYTES;
}
