// ── Daily confirmed-market refresh ─────────────────────────────────────────────
// For every confirmed Kinetic city (state_fiber_markets, auto_scan_eligible),
// rerun OSM discovery across its full boundary, diff today's normalized address
// inventory against what's saved, and live-check ONLY the NEW addresses. The
// persistent inventory (scan_targets) is upsert-only — an address is NEVER
// deleted just because OSM stopped returning it. Coming-Soon / unresolved / stale
// rechecks and the Coming-Soon→live promotion are handled by the existing
// startKineticRecheck worker + projectConfirmedFreshLeads, which run alongside.
import { rawDb } from "./db";
import { readDailyRefreshCounts } from "./dailyRefreshMetrics";
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

const emptyStatus = (): DailyRefreshStatus => ({
  running: false, startedAt: null, completedAt: null,
  citiesTotal: 0, citiesRefreshed: 0, currentCity: null,
  newAddresses: 0, checked: 0, newLeads: 0, comingSoon: 0, newlyLit: 0, pending: 0,
  lastError: null,
});
const DAILY_ENQUEUE_PAGE = Math.min(500, MAX_CHECKS_PER_RUN);
const statuses = new Map<number, DailyRefreshStatus>();
const pending = new Map<number, Promise<DailyRefreshStatus>>();
// Serialize discovery across tenants; coalesce only requests for the SAME tenant.
let discoveryTail: Promise<unknown> = Promise.resolve();

export function getDailyRefreshStatus(tenantId: number): DailyRefreshStatus {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error("Tenant required");
  return { ...(statuses.get(tenantId) ?? emptyStatus()) };
}

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

export function runDailyMarketRefresh(tenantId: number): Promise<DailyRefreshStatus> {
  getDailyRefreshStatus(tenantId); // validate before registering work
  const existing = pending.get(tenantId);
  if (existing) return existing;
  statuses.set(tenantId, { ...emptyStatus(), running: true });
  const work = discoveryTail.then(() => refreshTenant(tenantId));
  pending.set(tenantId, work);
  discoveryTail = work.catch(() => {});
  void work.finally(() => pending.delete(tenantId)).catch(() => {});
  return work;
}

async function refreshTenant(tenantId: number): Promise<DailyRefreshStatus> {
  const status = emptyStatus();
  statuses.set(tenantId, status);
  Object.assign(status, {
    running: true, startedAt: new Date().toISOString(), completedAt: null,
    citiesTotal: 0, citiesRefreshed: 0, currentCity: null,
    newAddresses: 0, checked: 0, newLeads: 0, comingSoon: 0, newlyLit: 0, pending: 0, lastError: null,
  });
  let lastCountAt = Date.now();
  try {
    const cities = KINETIC_MONITORED_STATES.flatMap((state) =>
      confirmedCities(state).map((city) => ({ city, state })));
    status.citiesTotal = cities.length;
    structuredLog("daily_refresh.started", { tenantId, cities: cities.length });
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
        // Keyset pages cap memory and yield between durable enqueue batches.
        // Freeze the upper ID so discovery elsewhere cannot extend this pass forever.
        const upperId = Number((rawDb.prepare(`SELECT MAX(id) AS id FROM scan_targets
          WHERE tenant_id=? AND lower(city)=lower(?) AND state=? AND last_scanned_at IS NULL`)
          .get(tenantId, city, state) as { id: number | null }).id ?? 0);
        let afterId = 0;
        for (;;) {
          const page = rawDb.prepare(`SELECT id FROM scan_targets
            WHERE tenant_id=? AND lower(city)=lower(?) AND state=? AND last_scanned_at IS NULL
              AND id>? AND id<=? ORDER BY id LIMIT ?`)
            .all(tenantId, city, state, afterId, upperId, DAILY_ENQUEUE_PAGE) as Array<{ id: number }>;
          if (!page.length) break;
          scanService.startTargetRun({
            tenantId, city, state, targetIds: page.map(t => t.id),
            runKind: "daily-diff", label: `Daily diff · ${city}, ${state}`,
          });
          status.newAddresses += page.length;
          afterId = page[page.length - 1].id;
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      } catch (e: any) {
        status.lastError = String(e?.message ?? e);
        structuredLog("daily_refresh.city_failed", { city, state, error: String(e?.message ?? e) }, "warn");
      }
      status.citiesRefreshed++;
      if (Date.now() - lastCountAt >= 30_000) {
        Object.assign(status, readDailyRefreshCounts(rawDb, tenantId, status.startedAt!));
        lastCountAt = Date.now();
      }

    }
  } catch (e: any) {
    status.lastError = String(e?.message ?? e);
  } finally {
    try {
      Object.assign(status, readDailyRefreshCounts(rawDb, tenantId, status.startedAt!));
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
    }
    status.running = false;
    status.completedAt = new Date().toISOString();
    status.currentCity = null;
    structuredLog("daily_refresh.completed", {
      tenantId, cities: status.citiesRefreshed, newAddresses: status.newAddresses,
      newLeads: status.newLeads, newlyLit: status.newlyLit,
    });
  }
  return getDailyRefreshStatus(tenantId);
}
