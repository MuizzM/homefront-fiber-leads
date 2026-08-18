// ── Daily confirmed-market refresh ─────────────────────────────────────────────
// For every confirmed Kinetic city (state_fiber_markets, auto_scan_eligible),
// rerun OSM discovery across its full boundary, diff today's normalized address
// inventory against what's saved, and live-check ONLY the NEW addresses. The
// persistent inventory (scan_targets) is upsert-only — an address is NEVER
// deleted just because OSM stopped returning it. Coming-Soon / unresolved / stale
// rechecks and the Coming-Soon→live promotion are handled by the existing
// startKineticRecheck worker + projectConfirmedFreshLeads, which run alongside.
import { rawDb } from "./db";
import { storage } from "./storage";
import { getCityAddresses } from "./overpass";
import * as scanService from "./scanService";
import { structuredLog } from "./structuredLog";
import { MAX_CHECKS_PER_RUN } from "@shared/scanEconomics";
import { KINETIC_MONITORED_STATES, type KineticMonitoredState } from "./kineticMarketCatalog";

export interface DailyRefreshStatus {
  running: boolean;
  startedAt: string | null;
  completedAt: string | null;
  citiesTotal: number;
  citiesRefreshed: number;
  currentCity: string | null;
  newAddresses: number; // new OSM addresses found today (the diff)
  checked: number;      // addresses checked this run
  newLeads: number;     // fresh-fiber leads created this run
  comingSoon: number;   // coming-soon watchlist size
  newlyLit: number;     // addresses whose fiber first went live during this run
  pending: number;      // discovered-but-not-yet-checked
  lastError: string | null;
}

const status: DailyRefreshStatus = {
  running: false, startedAt: null, completedAt: null,
  citiesTotal: 0, citiesRefreshed: 0, currentCity: null,
  newAddresses: 0, checked: 0, newLeads: 0, comingSoon: 0, newlyLit: 0, pending: 0,
  lastError: null,
};
let active = false;

export function getDailyRefreshStatus(): DailyRefreshStatus { return { ...status }; }

/** Confirmed cities for a state — the saved markets; we never re-approve them. */
function confirmedCities(state: KineticMonitoredState): string[] {
  const rows = rawDb.prepare(
    `SELECT city FROM state_fiber_markets WHERE state=? AND auto_scan_eligible=1 ORDER BY city`,
  ).all(state) as Array<{ city: string }>;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    const key = String(r.city ?? "").trim().toLowerCase();
    if (key && !seen.has(key)) { seen.add(key); out.push(String(r.city).trim()); }
  }
  return out;
}

export async function runDailyMarketRefresh(tenantId: number): Promise<DailyRefreshStatus> {
  if (active) return getDailyRefreshStatus();
  active = true;
  const cities = KINETIC_MONITORED_STATES.flatMap((state) =>
    confirmedCities(state).map((city) => ({ city, state })),
  );
  Object.assign(status, {
    running: true, startedAt: new Date().toISOString(), completedAt: null,
    citiesTotal: cities.length, citiesRefreshed: 0, currentCity: null,
    newAddresses: 0, checked: 0, newLeads: 0, comingSoon: 0, newlyLit: 0, pending: 0, lastError: null,
  });
  structuredLog("daily_refresh.started", { tenantId, cities: cities.length });
  try {
    for (const { city, state } of cities) {
      status.currentCity = `${city}, ${state}`;
      try {
        // 1) rerun OSM across the city's (cached) full boundary.
        const harvest = await getCityAddresses(city, state);
        // 2) upsert into the persistent inventory — normalized + deduped, never
        //    deleted. New rows land with last_scanned_at = NULL.
        storage.upsertScanTargets(
          harvest.addresses.map((a) => ({ ...a, tenantId, source: "osm-daily-diff" })),
        );
        // 3) the diff = addresses in this city we've never checked (brand-new to
        //    the inventory). Established addresses are left to the recheck worker.
        const newTargets = rawDb.prepare(
          `SELECT id FROM scan_targets WHERE tenant_id=? AND lower(city)=lower(?) AND state=? AND last_scanned_at IS NULL`,
        ).all(tenantId, city, state) as Array<{ id: number }>;
        status.newAddresses += newTargets.length;
        // 4) live-check ONLY the new ones, in durable batches.
        for (let i = 0; i < newTargets.length; i += MAX_CHECKS_PER_RUN) {
          const batch = newTargets.slice(i, i + MAX_CHECKS_PER_RUN).map((t) => t.id);
          if (batch.length) {
            scanService.startTargetRun({
              tenantId, city, state, targetIds: batch,
              runKind: "daily-diff", label: `Daily diff · ${city}, ${state}`,
            });
          }
        }
      } catch (e: any) {
        structuredLog("daily_refresh.city_failed", { city, state, error: String(e?.message ?? e) }, "warn");
      }
      status.citiesRefreshed++;
      refreshAggregateCounts(tenantId);
    }
  } catch (e: any) {
    status.lastError = String(e?.message ?? e);
  } finally {
    refreshAggregateCounts(tenantId);
    status.running = false;
    status.completedAt = new Date().toISOString();
    status.currentCity = null;
    active = false;
    structuredLog("daily_refresh.completed", {
      tenantId, cities: status.citiesRefreshed, newAddresses: status.newAddresses,
      newLeads: status.newLeads, newlyLit: status.newlyLit,
    });
  }
  return getDailyRefreshStatus();
}

// Live 7-count board, derived from the DB relative to this run's start.
function refreshAggregateCounts(tenantId: number): void {
  const since = status.startedAt ?? new Date().toISOString();
  const one = (sql: string, ...args: unknown[]) => Number((rawDb.prepare(sql).get(...args) as any)?.n ?? 0);
  status.checked = one(`SELECT COUNT(*) n FROM scan_targets WHERE tenant_id=? AND last_scanned_at >= ?`, tenantId, since);
  status.newLeads = one(`SELECT COUNT(*) n FROM leads WHERE tenant_id=? AND lead_tag='fresh_fiber_confirmed' AND datetime(created_at) >= datetime(?)`, tenantId, since);
  status.comingSoon = one(`SELECT COUNT(*) n FROM kinetic_addresses WHERE tenant_id=? AND is_coming_soon=1`, tenantId);
  status.newlyLit = one(`SELECT COUNT(*) n FROM scan_targets WHERE tenant_id=? AND first_seen_fiber_at >= ?`, tenantId, since);
  status.pending = one(`SELECT COUNT(*) n FROM scan_targets WHERE tenant_id=? AND last_scanned_at IS NULL`, tenantId);
}
