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
import { withoutSqliteBusyWait } from "./interactiveDb";
import { structuredLog } from "./structuredLog";

const BUDGET_GB = Math.max(1, Number(process.env.DECODO_BUDGET_GB) || 25);
const RESERVE = Math.min(0.9, Math.max(0, (Number(process.env.DECODO_RESERVE_PCT) || 10) / 100));
const BILLING_DAY = Math.min(28, Math.max(1, Number(process.env.DECODO_BILLING_DAY) || 1));
const USABLE_BYTES = BUDGET_GB * (1 - RESERVE) * 1e9;
// UNLIMITED PLAN MODE (DECODO_UNLIMITED=on): the Decodo plan is metered as
// unlimited, so budget pacing must NEVER throttle down and an auth/limit-denial
// burst must NOT freeze scanning. Instead of a cooldown we ROTATE to a fresh
// residential IP set and keep making requests (fresh IPs are free; a throttled
// IP is the only thing that costs us) — matching the proxy layer's rotate-don't-
// back-off philosophy. The single-flight rotate hook is injected by proxy-fetch
// to avoid a circular import.
const UNLIMITED = process.env.DECODO_UNLIMITED === "on";
let rotateHook: ((reason: string) => void) | null = null;
let lastRotateAt = 0;
const ROTATE_MIN_INTERVAL_MS = Math.max(1_000, Number(process.env.PROXY_DENIAL_ROTATE_MIN_MS) || 3_000);
/** proxy-fetch registers its session-rotation here so the governor can rotate on
 *  a denial burst without importing the transport (circular). */
export function setProxyRotateHook(fn: (reason: string) => void): void {
  rotateHook = fn;
}
export function isUnlimitedProxyMode(): boolean {
  return UNLIMITED;
}

const FLUSH_MS = 15_000;
const CIRCUIT_FAILS = 8;                 // 407s inside the window to trip
const CIRCUIT_WINDOW_MS = 5 * 60_000;
// GRADUATED breaker (replaces the old 30-min hard blackout): a trip is a BRIEF
// full stop (COOLDOWN) to let Decodo's rolling window refill, then the circuit
// enters RECOVERING — a probe trickle at RECOVER_FLOOR of normal budget that
// auto-ramps back to full as probes succeed. The system never blacks out for
// 30 minutes on a throttle burst; it self-heals in proportion to real recovery.
const CIRCUIT_COOLDOWN_MS = Math.max(5_000, Number(process.env.PROXY_CIRCUIT_COOLDOWN_MS) || 20_000);
const RECOVER_FLOOR = Math.min(0.5, Math.max(0.01, Number(process.env.PROXY_RECOVER_FLOOR) || 0.05));
// Probe steps the trickle ramps through on sustained success; last step = closed.
const RECOVER_STEPS = [RECOVER_FLOOR, 0.2, 0.5, 1] as const;
// Consecutive successful probes needed to climb one step.
const PROBES_PER_STEP = Math.max(1, Number(process.env.PROXY_PROBES_PER_STEP) || 3);

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

// ── Fleet-shared state (governor_state) ──────────────────────────────────────
// C1 (per-process-state defect): the circuit breaker and the token-mint backoff
// used to live in module-local variables — in the 4-worker cluster a fleet-wide
// trip needed 8 denials × 4 processes, one worker's recovery probe raced a
// sibling's failure storm, and mint backoff was computed independently per
// process (up to 4× concurrent mints against a throttling Cloudflare). Both now
// persist to a tiny key/value row so every worker trips, cools down, recovers,
// and backs off mints TOGETHER. The in-memory variables below remain as a
// read-through/write-through CACHE (TTL-gated reads, write-through on every
// mutation) so hot paths never hit the DB per request.
let governorStateEnsured = false;
function ensureGovernorStateTable(): void {
  if (governorStateEnsured) return;
  try {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS governor_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER NOT NULL
    )`);
    governorStateEnsured = true;
  } catch { /* best-effort — the in-memory cache keeps the old behavior */ }
}

// ── Batched ledger writes ────────────────────────────────────────────────────
let pendingBytes = 0;
let pendingReqs = 0;
let flushTimer: NodeJS.Timeout | null = null;
let retryFlushAfter = 0;

export function flushBandwidthLedger(): void {
  if (!pendingReqs && !pendingBytes) return;
  try {
    withoutSqliteBusyWait(rawDb, () => {
      ensureTable();
      rawDb.prepare("INSERT INTO bandwidth_ledger (ts, bytes, requests) VALUES (?,?,?)")
        .run(Date.now(), pendingBytes, pendingReqs);
    });
    pendingBytes = 0;
    pendingReqs = 0;
    retryFlushAfter = 0;
  } catch {
    // Retain every byte/request for the next scheduled flush. Retrying on each
    // response once the 200-request threshold is crossed creates a lock storm.
    retryFlushAfter = Date.now() + FLUSH_MS;
  }
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
  if (pendingReqs >= 200 && Date.now() >= retryFlushAfter) flushBandwidthLedger();
}

// ── Graduated circuit breaker ────────────────────────────────────────────────
// States: CLOSED (recoverStep<0) → COOLDOWN (now<cooldownUntil, hard 0 for a few
// seconds) → RECOVERING (recoverStep≥0, probe trickle ramping RECOVER_STEPS).
let failTimes: number[] = [];
let cooldownUntil = 0;      // brief full-stop right after a trip
let recoverStep = -1;       // -1 = closed; else index into RECOVER_STEPS
let probeStreak = 0;        // consecutive successful probes at the current step
let circuitLogAt = 0;

// Breaker cache sync: the row value our in-memory cache currently reflects, and
// when we last read it. Reads are TTL-gated (hot paths ≤1 DB read/SYNC_TTL_MS
// per process); every mutation writes through immediately so siblings see it.
const BREAKER_ROW_KEY = "proxy_circuit";
const SYNC_TTL_MS = 250;
let breakerCacheReadAt = 0;
let breakerCacheRaw = "";

function loadBreakerFromDb(): void {
  try {
    ensureGovernorStateTable();
    const row = rawDb.prepare("SELECT value FROM governor_state WHERE key=?").get(BREAKER_ROW_KEY) as any;
    const raw = String(row?.value ?? "");
    if (raw === breakerCacheRaw) return; // unchanged since our last read/write
    breakerCacheRaw = raw;
    if (!raw) { failTimes = []; cooldownUntil = 0; recoverStep = -1; probeStreak = 0; return; }
    const v = JSON.parse(raw);
    failTimes = Array.isArray(v.f) ? v.f.filter((t: any) => Number.isFinite(t)) : [];
    cooldownUntil = Number(v.c) || 0;
    recoverStep = Number.isFinite(v.r) ? Math.trunc(v.r) : -1;
    probeStreak = Number(v.p) || 0;
  } catch { /* DB best-effort — the cache keeps working standalone */ }
}

function syncBreaker(force = false): void {
  const now = Date.now();
  if (!force && now - breakerCacheReadAt < SYNC_TTL_MS) return;
  breakerCacheReadAt = now;
  loadBreakerFromDb();
}

function persistBreaker(): void {
  try {
    ensureGovernorStateTable();
    const raw = JSON.stringify({ f: failTimes.slice(-CIRCUIT_FAILS), c: cooldownUntil, r: recoverStep, p: probeStreak });
    rawDb.prepare(
      `INSERT INTO governor_state (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(BREAKER_ROW_KEY, raw, Date.now());
    breakerCacheRaw = raw;
  } catch { /* best-effort */ }
}

function tripCircuit(now: number, reason: string): void {
  cooldownUntil = now + CIRCUIT_COOLDOWN_MS;
  recoverStep = 0;          // enter recovery at the floor after cooldown
  probeStreak = 0;
  failTimes = [];
  structuredLog("bandwidth.circuit_trip", {
    reason, cooldownMs: CIRCUIT_COOLDOWN_MS, recoverFloor: RECOVER_FLOOR,
  });
}

export function noteProxyAuthFailure(): void {
  const now = Date.now();
  if (UNLIMITED) {
    // Unlimited plan: never freeze. On a denial burst, rotate to a fresh IP set
    // (rate-limited so a storm triggers ONE rotation, not thousands) and keep
    // scanning. The circuit never opens; budget never throttles.
    failTimes = failTimes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
    failTimes.push(now);
    if (failTimes.length >= CIRCUIT_FAILS && now - lastRotateAt >= ROTATE_MIN_INTERVAL_MS) {
      lastRotateAt = now;
      failTimes = [];
      structuredLog("bandwidth.denial_rotate", { reason: "unlimited-mode denial burst → rotate, no freeze" });
      try { rotateHook?.("denial burst"); } catch { /* rotation best-effort */ }
    }
    return;
  }
  // C1: pull the fleet view before mutating so a sibling's trip/recovery isn't
  // clobbered by this process's stale cache (failures are rare — a forced sync
  // here costs nothing against a proxy request).
  syncBreaker(true);
  if (recoverStep >= 0) {
    // A failure while recovering: don't blackout — drop back to the floor and
    // re-arm a short cooldown so we keep probing, never hammering.
    recoverStep = 0;
    probeStreak = 0;
    cooldownUntil = now + CIRCUIT_COOLDOWN_MS;
    persistBreaker();
    return;
  }
  failTimes = failTimes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  failTimes.push(now);
  if (failTimes.length >= CIRCUIT_FAILS) tripCircuit(now, "proxy auth/limit denials");
  persistBreaker();
}

export function noteProxySuccess(): void {
  // TTL-gated sync: per-response hot path stays off the DB, yet a sibling's
  // trip is seen within SYNC_TTL_MS so our successes count as fleet probes.
  syncBreaker();
  if (recoverStep >= 0) {
    syncBreaker(true); // about to mutate — never climb off a stale step
    if (recoverStep >= 0) {
      // Probe succeeded — climb the recovery ramp; on the last step, close.
      probeStreak += 1;
      if (probeStreak >= PROBES_PER_STEP) {
        probeStreak = 0;
        recoverStep += 1;
        if (recoverStep >= RECOVER_STEPS.length) {
          recoverStep = -1;   // fully closed / healthy
          structuredLog("bandwidth.circuit_closed", { reason: "probes recovered" });
        } else {
          structuredLog("bandwidth.circuit_recover_step", { scale: RECOVER_STEPS[recoverStep] });
        }
      }
      persistBreaker();
      return;
    }
  }
  if (failTimes.length) { failTimes = []; persistBreaker(); }
}

/** True ONLY during the brief post-trip cooldown — the one window where callers
 *  must issue NO proxied requests. Bounded to CIRCUIT_COOLDOWN_MS (seconds), so
 *  scanning is never suspended for 30 minutes again. During RECOVERING this is
 *  false and a probe trickle flows (see proxyThrottleScale / budgetScale). */
export function isProxyCircuitOpen(): boolean {
  if (UNLIMITED) return false; // unlimited plan → scanning is never suspended
  syncBreaker(); // TTL-gated — a sibling's trip is honored within SYNC_TTL_MS
  // Only meaningful while tripped/recovering; a closed circuit is never "open"
  // even if a stale cooldown timestamp is still nominally in the future (probes
  // may have recovered us early).
  const open = recoverStep >= 0 && Date.now() < cooldownUntil;
  if (open && Date.now() - circuitLogAt > 30_000) {
    circuitLogAt = Date.now();
    console.warn(`[bandwidth] circuit COOLDOWN - proxy paused ${Math.round((cooldownUntil - Date.now()) / 1000)}s, then probe-recovers (auth/limit denials)`);
  }
  return open;
}

/** Circuit contribution to the budget, [0,1]. 1 when healthy, 0 during the
 *  brief post-trip cooldown, the current probe-ramp fraction while recovering. */
export function proxyThrottleScale(now = Date.now()): number {
  if (UNLIMITED) return 1;              // unlimited plan → never throttled
  syncBreaker();                        // TTL-gated read-through of the shared row
  if (recoverStep < 0) return 1;        // closed / healthy
  if (now < cooldownUntil) return 0;    // brief cooldown — the one full stop
  return RECOVER_STEPS[recoverStep];    // probe trickle, ramping to full
}

/** Cheap one-call view of the shared breaker for observability (fleet heartbeat). */
export function circuitBreakerSnapshot(): { open: boolean; step: number; scale: number } {
  if (UNLIMITED) return { open: false, step: -1, scale: 1 };
  return { open: isProxyCircuitOpen(), step: recoverStep, scale: proxyThrottleScale() };
}

// ── Fleet-shared mint backoff (authorizedTokenPool) ──────────────────────────
// C1: the 403-storm mint backoff was per-process, so 4 workers each computed
// their own and could fire up to 4× concurrent mints against a throttling
// Cloudflare. The consecutive-failure counter + last-failure timestamp now live
// in a shared row; same read-through/write-through cache discipline as the
// breaker. Mint cadence is low (token lifetime minutes), so a forced read on
// every failure/success is cheap.
const MINT_ROW_KEY = "authorized_mint_backoff";
let mintCache = { failures: 0, lastFailureAt: 0 };
let mintCacheReadAt = 0;
let mintCacheRaw = "";

export function getSharedMintBackoff(force = false): { failures: number; lastFailureAt: number } {
  const now = Date.now();
  if (!force && now - mintCacheReadAt < SYNC_TTL_MS) return mintCache;
  mintCacheReadAt = now;
  try {
    ensureGovernorStateTable();
    const row = rawDb.prepare("SELECT value FROM governor_state WHERE key=?").get(MINT_ROW_KEY) as any;
    const raw = String(row?.value ?? "");
    if (raw !== mintCacheRaw) {
      mintCacheRaw = raw;
      const v = raw ? JSON.parse(raw) : {};
      mintCache = { failures: Number(v.n) || 0, lastFailureAt: Number(v.at) || 0 };
    }
  } catch { /* best-effort — per-process fallback values stay */ }
  return mintCache;
}

function persistMintBackoff(): void {
  try {
    ensureGovernorStateTable();
    const raw = JSON.stringify({ n: mintCache.failures, at: mintCache.lastFailureAt });
    rawDb.prepare(
      `INSERT INTO governor_state (key, value, updated_at) VALUES (?,?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(MINT_ROW_KEY, raw, Date.now());
    mintCacheRaw = raw;
  } catch { /* best-effort */ }
}

/** One more consecutive mint failure, fleet-wide. `at` is wall-clock ms. */
export function noteSharedMintFailure(at: number): { failures: number; lastFailureAt: number } {
  getSharedMintBackoff(true); // increment the fleet value, never a stale local one
  mintCache = { failures: mintCache.failures + 1, lastFailureAt: at };
  persistMintBackoff();
  return mintCache;
}

/** A mint succeeded — clear the fleet storm counter. */
export function resetSharedMintFailures(): void {
  getSharedMintBackoff(true);
  if (!mintCache.failures && !mintCache.lastFailureAt) return;
  mintCache = { failures: 0, lastFailureAt: 0 };
  persistMintBackoff();
}

/** Test-only reset of the breaker state. */
export function _resetCircuitForTests(): void {
  failTimes = []; cooldownUntil = 0; recoverStep = -1; probeStreak = 0; circuitLogAt = 0; lastRotateAt = 0;
  breakerCacheReadAt = 0; breakerCacheRaw = "";
  mintCache = { failures: 0, lastFailureAt: 0 }; mintCacheReadAt = 0; mintCacheRaw = "";
  try {
    ensureGovernorStateTable();
    rawDb.prepare("DELETE FROM governor_state WHERE key IN (?,?)").run(BREAKER_ROW_KEY, MINT_ROW_KEY);
  } catch { /* best-effort */ }
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

function ledgerSpanDays(): number {
  try {
    ensureTable();
    const row = rawDb.prepare("SELECT MIN(ts) AS first FROM bandwidth_ledger").get() as any;
    if (!row?.first) return 0;
    return Math.max(0.25, (Date.now() - Number(row.first)) / 86_400_000);
  } catch { return 0; }
}

/**
 * Budget scale 0.10–1.50 — paces the REMAINING pool against the REMAINING
 * cycle days using the ledger's own observed burn rate:
 *
 *   scale = (remainingBytes / daysLeft) / observedDailyBurn
 *
 * Correct even when the ledger starts mid-cycle (plan upgraded or deployed
 * mid-month): the old elapsed-vs-burned math compared a 1-day-old ledger
 * against a 20-day-old cycle and boosted x1.5 while the pool was actually
 * burning 6x over pace (observed live: 5GB in <24h of a 25GB plan).
 * No data yet -> 1 (neutral). Cooldown -> 0 (brief). Recovering -> the pace
 * multiplied by the probe-trickle fraction (RECOVER_FLOOR ramping to 1), so a
 * throttle burst self-heals instead of blacking out for 30 minutes.
 */
export function bandwidthBudgetScale(): number {
  // Unlimited plan: full throttle, always. Never pace down on burn, never
  // freeze — the plan can't run out, so hunt at max (up to the 1.5 hunt-harder
  // ceiling the harvester already understands).
  if (UNLIMITED) return 1.5;
  const throttle = proxyThrottleScale();
  if (throttle <= 0) return 0; // cooldown — the one true full stop
  const { start, end } = cycleBounds();
  const now = Date.now();
  const { bytes } = sumSince(start);
  let pace = 1;
  if (bytes > 0) {
    const remaining = USABLE_BYTES - bytes;
    if (remaining <= 0) pace = 0.1;
    else {
      const span = ledgerSpanDays() || Math.max(0.25, (now - start) / 86_400_000);
      const dailyRate = bytes / span;                        // observed burn/day
      if (dailyRate > 0) {
        const daysLeft = Math.max(0.5, (end - now) / 86_400_000);
        const allowedDaily = remaining / daysLeft;           // sustainable rate
        pace = Math.min(1.5, Math.max(0.1, allowedDaily / dailyRate));
      }
    }
  }
  // The circuit trickle can pull below the 0.1 pacing floor (it is a recovery
  // probe, not a budget decision), so apply it as a separate multiplier.
  return throttle >= 1 ? pace : pace * throttle;
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
  retryFlushAfter = 0;
  estReqBytes = SEED_REQ_BYTES;
  _resetCircuitForTests();
}
