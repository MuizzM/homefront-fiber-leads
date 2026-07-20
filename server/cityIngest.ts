/**
 * CITY INGEST — pull every mappable address in a city from OpenStreetMap into
 * scan_targets, so the harvest fleet can qualify them all (fresh + coming-soon).
 *
 * Uses the existing Overpass machinery: geocode the city (Mapbox) → bbox →
 * tiled Overpass pulls (polite 1.5s spacing) → upsertScanTargets (dedups on the
 * canonical address key, so re-ingesting a city is free).
 *
 * Idempotent per city per 7 days: a city with a recent ingest is skipped, so
 * this can run daily without duplicating work. OSM is free — zero proxy cost;
 * the proxy budget is only spent qualifying addresses (and freshHarvest's
 * verdict-aware tiers make sure each qualification is actually due).
 *
 * CITY_INGEST=off disables. Cities come from CITY_INGEST_CITIES (default:
 * PRIORITY_CITIES + EXPLORE_CITIES envs).
 */
import { rawDb } from "./db";
import { geocodeCity, pullAddressesFromOverpass, tileBbox } from "./overpass";
import { storage } from "./storage";
import { structuredLog } from "./structuredLog";

const INGEST_FRESH_DAYS = 7;
const TILE_DELAY_MS = 1_500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ingestCityList(): Array<{ city: string; state: string }> {
  const spec = (process.env.CITY_INGEST_CITIES ??
    `${process.env.PRIORITY_CITIES ?? ""},${process.env.EXPLORE_CITIES ?? ""}`).trim();
  if (!spec || spec === "off" || spec === ",") return [];
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [city, st = "nc"] = entry.split(":").map((s) => s.trim());
    return { city, state: st };
  }).filter((c) => c.city);
}

/** True when this city already has a fresh ingest (skip — idempotent). */
function recentlyIngested(city: string, state: string): boolean {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS c FROM scan_targets
      WHERE source='osm-ingest' AND lower(city)=? AND lower(state)=?
        AND created_at > datetime('now','-${INGEST_FRESH_DAYS} days')`,
  ).get(city, state) as any;
  return Number(row?.c ?? 0) > 500;
}

export async function ingestCity(tenantId: number, city: string, state: string): Promise<{ city: string; added: number; skipped?: string }> {
  if (recentlyIngested(city, state)) {
    structuredLog("city_ingest.skipped", { city, state, reason: "fresh ingest < 7d" });
    return { city, added: 0, skipped: "recent" };
  }
  const geo = await geocodeCity(city, state);
  if (!geo) {
    structuredLog("city_ingest.no_geocode", { city, state });
    return { city, added: 0, skipped: "no_geocode" };
  }
  const tiles = tileBbox(geo.bbox, 0.05);
  let added = 0;
  for (const tile of tiles) {
    try {
      const rows = await pullAddressesFromOverpass(tile, city, state);
      if (rows.length) {
        added += storage.upsertScanTargets(rows.map((a) => ({
          address: a.address, city: a.city, state: a.state, zip: a.zip,
          lat: a.lat, lng: a.lng, source: "osm-ingest", tenantId,
        })));
      }
    } catch (e: any) {
      structuredLog("city_ingest.tile_failed", { city, state, error: String(e?.message ?? e).slice(0, 120) });
    }
    await sleep(TILE_DELAY_MS);
  }
  structuredLog("city_ingest.done", { city, state, tiles: tiles.length, added });
  return { city, added };
}

/** Ingest every configured city, sequentially (Overpass politeness). */
export async function runCityIngest(tenantId: number): Promise<void> {
  for (const { city, state } of ingestCityList()) {
    try { await ingestCity(tenantId, city, state); }
    catch (e: any) { console.warn(`[city-ingest] ${city},${state} skipped:`, e?.message); }
  }
}
