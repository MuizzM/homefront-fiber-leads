/**
 * MAPBOX SPEND GOVERNOR — a hard ceiling on billed Mapbox geocoding requests.
 *
 * Unlike Decodo (unlimited plan), Mapbox geocoding is separately metered and has
 * a documented runaway-cost history. This governor is what makes the per-scan
 * grid caps SAFE TO REMOVE: a scan may request unlimited grid points, but paid
 * Mapbox calls stop at a real daily/monthly ceiling and callers fall back to the
 * free OSM/Overpass path. Spend is bounded regardless of how greedy any single
 * scan is — the ceiling, not a per-box guess, is the real protection.
 *
 * Same discipline as the Decodo bandwidth governor: a batched ledger, cheap hot
 * path, best-effort persistence. Caps of 0 mean "unlimited" (explicit opt-out).
 *
 * Env: MAPBOX_DAILY_REQUEST_CAP (default 50000), MAPBOX_MONTHLY_REQUEST_CAP
 *      (default 1_000_000).
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

const DAILY_CAP = Math.max(0, Math.floor(Number(process.env.MAPBOX_DAILY_REQUEST_CAP ?? 50_000)));
const MONTHLY_CAP = Math.max(0, Math.floor(Number(process.env.MAPBOX_MONTHLY_REQUEST_CAP ?? 1_000_000)));
const FLUSH_MS = 10_000;

/** Thrown when a paid Mapbox call is refused because the budget is exhausted.
 *  Callers catch this and degrade to the free OSM path — it is never fatal. */
export class MapboxBudgetExhaustedError extends Error {
  readonly code = "MAPBOX_BUDGET_EXHAUSTED";
  constructor(scope: "daily" | "monthly") {
    super(`Mapbox request budget exhausted (${scope} cap) — falling back to free OSM enumeration`);
    this.name = "MapboxBudgetExhaustedError";
  }
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  try {
    rawDb.exec(`CREATE TABLE IF NOT EXISTS mapbox_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, requests INTEGER NOT NULL
    )`);
    rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_mapbox_ledger_ts ON mapbox_ledger(ts)`);
    ensured = true;
  } catch { /* best-effort — migrations run elsewhere */ }
}

// ── Batched ledger ────────────────────────────────────────────────────────────
let pending = 0;
let flushTimer: NodeJS.Timeout | null = null;

export function flushMapboxLedger(): void {
  if (!pending) return;
  const n = pending;
  pending = 0;
  try {
    ensureTable();
    rawDb.prepare("INSERT INTO mapbox_ledger (ts, requests) VALUES (?,?)").run(Date.now(), n);
  } catch { pending += n; /* retry next flush */ }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => flushMapboxLedger(), FLUSH_MS);
  if (typeof flushTimer.unref === "function") flushTimer.unref();
}

function sumSince(ts: number): number {
  try {
    ensureTable();
    const row = rawDb.prepare("SELECT COALESCE(SUM(requests),0) AS n FROM mapbox_ledger WHERE ts >= ?").get(ts) as any;
    return Number(row?.n ?? 0) + pending;
  } catch {
    return pending;
  }
}

function dayStart(): number { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime(); }
function monthStart(): number { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }

export interface MapboxBudgetState {
  dayUsed: number; monthUsed: number; dayCap: number; monthCap: number;
  dayRemaining: number; monthRemaining: number; exhausted: boolean;
}

export function mapboxBudgetState(): MapboxBudgetState {
  const dayUsed = sumSince(dayStart());
  const monthUsed = sumSince(monthStart());
  const dayRemaining = DAILY_CAP === 0 ? Infinity : Math.max(0, DAILY_CAP - dayUsed);
  const monthRemaining = MONTHLY_CAP === 0 ? Infinity : Math.max(0, MONTHLY_CAP - monthUsed);
  return {
    dayUsed, monthUsed, dayCap: DAILY_CAP, monthCap: MONTHLY_CAP,
    dayRemaining, monthRemaining, exhausted: dayRemaining <= 0 || monthRemaining <= 0,
  };
}

/** True while a paid Mapbox call is still within budget. */
export function canSpendMapbox(): boolean {
  if (DAILY_CAP === 0 && MONTHLY_CAP === 0) return true; // unlimited (opt-out)
  if (DAILY_CAP > 0 && sumSince(dayStart()) >= DAILY_CAP) return false;
  if (MONTHLY_CAP > 0 && sumSince(monthStart()) >= MONTHLY_CAP) return false;
  return true;
}

let lastExhaustLog = 0;
/** Record `n` billed Mapbox requests against the budget (batched). */
export function recordMapboxRequests(n = 1): void {
  if (n <= 0) return;
  pending += n;
  scheduleFlush();
  if (pending >= 200) flushMapboxLedger();
}

/**
 * The single choke point for every BILLED Mapbox geocoding call. Refuses (throws
 * MapboxBudgetExhaustedError) when the ceiling is hit — callers degrade to OSM —
 * and records the spend otherwise. Wrap every api.mapbox.com geocoding fetch in
 * this so the spend ceiling is the real limit, not a per-box grid cap.
 */
export async function mapboxFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!canSpendMapbox()) {
    const scope: "daily" | "monthly" = DAILY_CAP > 0 && sumSince(dayStart()) >= DAILY_CAP ? "daily" : "monthly";
    if (Date.now() - lastExhaustLog > 60_000) {
      lastExhaustLog = Date.now();
      structuredLog("mapbox_budget.exhausted", { scope, ...mapboxBudgetState() });
    }
    throw new MapboxBudgetExhaustedError(scope);
  }
  recordMapboxRequests(1);
  return fetch(url, init);
}

/** Test hook. */
export function _resetMapboxBudgetForTests(): void {
  pending = 0; lastExhaustLog = 0;
  try { rawDb.exec("DELETE FROM mapbox_ledger"); } catch { /* table may not exist */ }
}
