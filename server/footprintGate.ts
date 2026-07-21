/**
 * FOOTPRINT GATE — the set of Kinetic markets we're allowed to spend proxy on.
 *
 * `auto_scan_eligible=1` in state_fiber_markets is the authoritative Kinetic
 * NC/SC/GA footprint (~132 markets): it is set only from official carrier
 * evidence — the directory catalog, live directory refresh, and announced
 * builds — and reset to 0 for any market without evidence
 * (applyAuthoritativeMarketCatalog). This module caches that set so selectors
 * can cheaply ask "is this city in the footprint?" before spending a Decodo
 * check on it.
 *
 * FAIL-OPEN: when the eligible set is empty or the table is unreadable (a fresh
 * boot before the catalog loads, or a replay DB), the gate is INACTIVE and
 * nothing is filtered. We must never silently stop all scanning because the
 * footprint hasn't materialized yet — the gate only ever *removes* work once
 * there is a known footprint to remove it against.
 */
import { rawDb } from "./db";

const REFRESH_MS = Math.max(30_000, Number(process.env.FOOTPRINT_GATE_REFRESH_MS) || 5 * 60_000);

let cache: Set<string> | null = null;
let cachedAt = 0;

// Match kineticMarketCatalog.normalizePlace: fold mt→mount, st→saint, strip
// punctuation — so a geocoded "Winston-Salem" keys the same as the catalog's.
function normalizePlace(value: string): string {
  return String(value).toLowerCase()
    .replace(/\bmt\b/g, "mount").replace(/\bst\b/g, "saint")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
function keyOf(state: string, city: string): string {
  return `${String(state).trim().toLowerCase()}|${normalizePlace(city)}`;
}

function snapshot(now: number): Set<string> {
  if (cache && now - cachedAt < REFRESH_MS) return cache;
  const set = new Set<string>();
  try {
    const rows = rawDb.prepare(
      `SELECT DISTINCT lower(state) AS state, city
         FROM state_fiber_markets
        WHERE auto_scan_eligible=1 AND city IS NOT NULL AND city<>''`,
    ).all() as Array<{ state: string; city: string }>;
    for (const r of rows) set.add(keyOf(r.state, r.city));
  } catch { /* table absent (replay/fresh DB) → empty set → gate inactive */ }
  cache = set;
  cachedAt = now;
  return set;
}

/** True once the footprint is known (≥1 eligible market). While false the gate
 *  is inactive and every isFootprintCity() call returns true (fail-open). */
export function footprintGateActive(now = Date.now()): boolean {
  return snapshot(now).size > 0;
}

/** Is (state, city) an auto_scan_eligible Kinetic market? Returns true for
 *  everything while the gate is inactive (fail-open). */
export function isFootprintCity(state: string | null | undefined, city: string | null | undefined, now = Date.now()): boolean {
  const set = snapshot(now);
  if (set.size === 0) return true;
  return set.has(keyOf(state ?? "", city ?? ""));
}

// Registered as a SQL function so selectors can footprint-gate inside a query
// (respecting LIMIT) using the exact same normalization + fail-open semantics
// as the JS path — `... AND footprint_city(s.state, s.city)=1`.
//
// CRITICAL: the eligible-set snapshot MUST be warm before the function is used
// inside a query. better-sqlite3 forbids a nested DB read from within a running
// statement, so if the FIRST footprint_city call lands mid-query with a cold
// cache, snapshot() throws, is caught, and the gate silently fails OPEN (no
// filtering). Call warmFootprintGate() immediately before any query that uses
// footprint_city so the in-query calls are pure reads of the in-memory Set.
let sqlFnRegistered = false;
export function registerFootprintSqlFunctions(): void {
  if (sqlFnRegistered) return;
  try {
    (rawDb as any).function("footprint_city", { deterministic: true },
      (state: unknown, city: unknown) =>
        isFootprintCity(typeof state === "string" ? state : "", typeof city === "string" ? city : "") ? 1 : 0);
    sqlFnRegistered = true;
  } catch { /* re-registration or exotic driver */ }
}
registerFootprintSqlFunctions();

/** Populate the eligible-set snapshot OUTSIDE any running query, so in-query
 *  footprint_city() calls never trigger a forbidden nested DB read. Idempotent
 *  and cheap (respects the cache TTL). */
export function warmFootprintGate(): void { snapshot(Date.now()); }

/** Test hook: drop the cache so the next call re-reads the table. */
export function _resetFootprintGateForTests(): void { cache = null; cachedAt = 0; }
