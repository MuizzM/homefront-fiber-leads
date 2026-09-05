// TODO: verify usage: this audit is referenced by docs/ops/DATA-AUDIT-2026-08-31.md but has no production caller; retain the operational audit contract.
/**
 * LEAD DEDUP AUDIT — geospatial near-duplicate DETECTION (never deletes).
 *
 * The canonical_key UNIQUE index already makes exact-address duplicates
 * structurally impossible. What it cannot catch is the SAME premise ingested
 * with address STRINGS that don't normalize equal — geocoder drift (a Mapbox
 * pass vs an OSM pass returning slightly different text), or one source carrying
 * a unit the other lacks. Those become two keys → two pins.
 *
 * Auto-merging by proximity is dangerous for a door-knocking tool: two real
 * neighbouring homes on a dense fiber route sit metres apart, and merging them
 * DELETES a real lead (a lost sale) — strictly worse than a duplicate pin. So
 * this module only DETECTS: it flags candidate pairs that are (a) within a tight
 * distance AND (b) share a house number AND (c) have different canonical keys,
 * for a human/live-box audit. It never mutates leads.
 *
 * The distance threshold is intentionally conservative and env-tunable; the
 * right value depends on real geocoder drift, which must be measured on the
 * live box before any auto-merge is ever considered.
 */
import { rawDb } from "./db";

// Same premise from two geocoders rarely drifts more than a rooftop's width.
// Deliberately tight — widen only after auditing real pairs on the live box.
const DEFAULT_MAX_METERS = Math.max(1, Number(process.env.LEAD_NEARDUP_MAX_METERS) || 12);
const EARTH_M = 6_371_000;

export interface NearDupPair {
  aId: number; bId: number;
  meters: number;
  houseNumber: string;
  addressA: string; addressB: string;
  keyA: string; keyB: string;
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Leading house number of an address ("123 N Main St" → "123", "" if none). */
export function houseNumberOf(address: string | null | undefined): string {
  return String(address ?? "").trim().match(/^(\d+)/)?.[1] ?? "";
}

interface Row { id: number; address: string; lat: number; lng: number; canonical_key: string }

/**
 * Return suspected near-duplicate lead pairs for a tenant — proximity AND a
 * shared house number AND distinct canonical keys. Detection only; O(n·bucket)
 * via a ~110 m grid so it scales past a naive O(n²). Rows without coordinates
 * or a house number degrade gracefully (skipped, never falsely paired).
 */
export function findNearDuplicateLeads(
  tenantId: number,
  opts: { maxMeters?: number } = {},
): NearDupPair[] {
  const maxMeters = Math.max(1, opts.maxMeters ?? DEFAULT_MAX_METERS);
  const rows = rawDb.prepare(
    `SELECT id, address, lat, lng, canonical_key
       FROM leads
      WHERE tenant_id=? AND lat IS NOT NULL AND lng IS NOT NULL AND canonical_key IS NOT NULL`,
  ).all(tenantId) as Row[];

  // ~0.001° ≈ 110 m cells; a pair within maxMeters (< one cell) can only sit in
  // the same or an 8-neighbour cell, so we compare each row against those only.
  const CELL = 0.001;
  const cellKey = (lat: number, lng: number) => `${Math.round(lat / CELL)}:${Math.round(lng / CELL)}`;
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    (buckets.get(cellKey(r.lat, r.lng)) ?? buckets.set(cellKey(r.lat, r.lng), []).get(cellKey(r.lat, r.lng))!).push(r);
  }

  const pairs: NearDupPair[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const hn = houseNumberOf(r.address);
    if (!hn) continue; // no house number → never flag (avoids false premises)
    const ci = Math.round(r.lat / CELL), cj = Math.round(r.lng / CELL);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const o of buckets.get(`${ci + di}:${cj + dj}`) ?? []) {
        if (o.id <= r.id) continue;                     // each unordered pair once
        if (o.canonical_key === r.canonical_key) continue; // already one identity
        if (houseNumberOf(o.address) !== hn) continue;  // must share house number
        const meters = haversineMeters(r.lat, r.lng, o.lat, o.lng);
        if (meters > maxMeters) continue;
        const pk = `${r.id}:${o.id}`;
        if (seen.has(pk)) continue;
        seen.add(pk);
        pairs.push({
          aId: r.id, bId: o.id, meters: Math.round(meters * 10) / 10,
          houseNumber: hn, addressA: r.address, addressB: o.address,
          keyA: r.canonical_key, keyB: o.canonical_key,
        });
      }
    }
  }
  return pairs.sort((a, b) => a.meters - b.meters);
}
