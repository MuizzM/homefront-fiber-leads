// ── Attributing doors to Kinetic's build-front blocks ────────────────────────
//
// Shared by the local operator script and the production loader, so what runs
// against the live volume is the same code that produced the numbers reviewed
// on a laptop - not a re-implementation that drifted.
//
// FCC BDC is block-level: location_ids and block_geoids, no addresses, and the
// address-level fabric is licence-gated. The gap is closed with free sources:
//
//   TIGERweb layer 2 (2020 Census Blocks) -> block polygons AND HU100, the
//   2020 housing-unit count. HU100 is the denominator the classifier needs to
//   tell a finished block from a half-built one, which Kinetic's own filing can
//   never supply because it lists only what Kinetic serves.
//
// Doors already in the CRM are point-in-polygon matched into those blocks.
// Nothing is geocoded and nothing is bought.

import { rawDb } from "./db";
import { additionBlocks, setBlockDenominators, importedVintages } from "./fccImportStore";
import { ensureBuildState, reclassify, canonicalKeyFor } from "./kineticBuildStore";
import type { SuppressionReason } from "@shared/kineticBuild2026";

const TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/2/query";
/** GEOIDs per TIGERweb request. The service rejects very long WHERE clauses;
 *  40 keeps each request comfortably inside its limit. */
export const GEOID_CHUNK = 40;

export interface BlockShape {
  geoid: string;
  countyFips: string;
  housingUnits: number;
  /** Outer rings only. Census blocks are simple enough that holes do not
   *  change containment for a residential address. */
  rings: Array<Array<[number, number]>>;
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}

export async function fetchBlockShapes(
  geoids: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<BlockShape[]> {
  const out: BlockShape[] = [];
  for (let i = 0; i < geoids.length; i += GEOID_CHUNK) {
    const batch = geoids.slice(i, i + GEOID_CHUNK);
    const body = new URLSearchParams({
      where: `GEOID IN (${batch.map((g) => `'${g}'`).join(",")})`,
      outFields: "GEOID,HU100",
      returnGeometry: "true",
      f: "geojson",
      outSR: "4326",
    });
    const response = await fetch(TIGERWEB, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) throw new Error(`TIGERweb ${response.status} on chunk ${i / GEOID_CHUNK}`);
    const json = await response.json() as any;
    for (const feature of json.features ?? []) {
      const geometry = feature.geometry;
      if (!geometry) continue;
      const polygons: any[] = geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];
      const rings = polygons.map((p: any) => p[0] as Array<[number, number]>).filter(Boolean);
      if (!rings.length) continue;
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      for (const ring of rings) for (const [lng, lat] of ring) {
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      }
      const geoid = String(feature.properties.GEOID);
      out.push({
        geoid, countyFips: geoid.slice(0, 5),
        housingUnits: Number(feature.properties.HU100) || 0,
        rings, minLat, maxLat, minLng, maxLng,
      });
    }
    onProgress?.(Math.min(i + GEOID_CHUNK, geoids.length), geoids.length);
  }
  return out;
}

/** Ray casting. Points exactly on an edge are rare at address precision;
 *  consistency matters more than which side they land on. */
function inRing(lat: number, lng: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const inBlock = (lat: number, lng: number, block: BlockShape) =>
  lat >= block.minLat && lat <= block.maxLat && lng >= block.minLng && lng <= block.maxLng
  && block.rings.some((ring) => inRing(lat, lng, ring));

export interface AttributionResult {
  buildFrontBlocks: number;
  shapesFetched: number;
  doorsInBounds: number;
  doorsMatched: number;
  byCounty: Record<string, number>;
  denominatorsSet: number;
  classified: Record<string, number>;
}

/**
 * Match a tenant's existing doors into the build-front blocks and classify them.
 *
 * `apply: false` stops before any write, after the point-in-polygon pass, so an
 * operator sees exactly how many doors would be touched before touching them.
 */
export async function attributeBuildFront(
  tenantId: number,
  opts: { apply: boolean; onProgress?: (done: number, total: number) => void } = { apply: false },
): Promise<AttributionResult> {
  const vintages = importedVintages(tenantId);
  if (vintages.length < 2) {
    throw new Error(`Need at least two imported vintages to compute a build front (have: ${vintages.join(", ") || "none"}).`);
  }

  const blocks = additionBlocks(tenantId, { limit: 50_000 });
  const shapes = await fetchBlockShapes(blocks.map((b) => b.blockGeoid), opts.onProgress);

  // One coarse bbox over every build-front block, so the lead scan skips the
  // vast majority of doors without a single point-in-polygon test.
  const bounds = shapes.reduce((acc, s) => ({
    minLat: Math.min(acc.minLat, s.minLat), maxLat: Math.max(acc.maxLat, s.maxLat),
    minLng: Math.min(acc.minLng, s.minLng), maxLng: Math.max(acc.maxLng, s.maxLng),
  }), { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 });

  const leads = shapes.length ? rawDb.prepare(`
    SELECT id, address, city, state, zip, lat, lng, do_not_knock AS dnk, lead_status AS status,
           billing_status AS billing
      FROM leads
     WHERE tenant_id = ? AND lat IS NOT NULL AND lng IS NOT NULL
       AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
  `).all(tenantId, bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng) as any[] : [];

  const matches: Array<{ lead: any; block: BlockShape }> = [];
  for (const lead of leads) {
    const block = shapes.find((s) => inBlock(lead.lat, lead.lng, s));
    if (block) matches.push({ lead, block });
  }

  const byCounty: Record<string, number> = {};
  for (const m of matches) byCounty[m.block.countyFips] = (byCounty[m.block.countyFips] ?? 0) + 1;

  const result: AttributionResult = {
    buildFrontBlocks: blocks.length,
    shapesFetched: shapes.length,
    doorsInBounds: leads.length,
    doorsMatched: matches.length,
    byCounty,
    denominatorsSet: 0,
    classified: {},
  };
  if (!opts.apply) return result;

  // Denominators FIRST. The classifier reads total_residential_locations to
  // tell a finished block from one with premises still unserved, and treats 0
  // as unknown rather than empty - so without this every door stays unverified.
  const latest = vintages[vintages.length - 1];
  result.denominatorsSet = setBlockDenominators(tenantId, latest,
    shapes.map((s) => ({ blockGeoid: s.geoid, totalResidentialLocations: s.housingUnits })));

  const link = rawDb.prepare(`UPDATE kinetic_build_state SET lead_id = ? WHERE id = ? AND lead_id IS NULL`);
  for (const { lead, block } of matches) {
    const identity = {
      tenantId,
      address: lead.address, city: lead.city, state: lead.state ?? "NC", zip: lead.zip,
      lat: lead.lat, lng: lead.lng,
      blockGeoid: block.geoid, countyFips: block.countyFips,
    };
    const state = ensureBuildState(identity);
    // Link the door a rep already knows, rather than minting a parallel record.
    link.run(lead.id, state.id);

    // Suppression comes from the CRM's own flags - never invented here.
    const suppression: SuppressionReason | null = lead.dnk ? "do_not_knock"
      : lead.status === "competitor_suppressed" ? "competitor"
      : lead.status === "scope_suppressed" ? "scope"
      : null;
    const decision = reclassify(tenantId, canonicalKeyFor(identity), {
      suppression,
      existingCustomer: String(lead.billing ?? "").toUpperCase() === "Y",
    });
    result.classified[decision.classification] = (result.classified[decision.classification] ?? 0) + 1;
  }
  return result;
}
