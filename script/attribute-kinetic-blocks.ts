// ── Attribute existing doors to Kinetic's build-front census blocks ──────────
//
// THE PROBLEM THIS SOLVES
// FCC BDC data is block-level: it carries location_ids and block_geoids but no
// addresses, and the address-level fabric is licence-gated. So an import gives
// us "Kinetic lit 6,717 locations in these 383 Cabarrus blocks" and no way to
// point a rep at a door. This script closes that gap using only free sources:
//
//   TIGERweb layer 2 (2020 Census Blocks) -> block polygons AND HU100, the
//   2020 housing-unit count. HU100 is the denominator the classifier needs to
//   tell a finished block from a half-built one, which Kinetic's own filing
//   can never supply (it lists only what Kinetic serves).
//
// Doors already in the CRM are then point-in-polygon matched into those
// blocks. Nothing is geocoded and nothing is bought.
//
// WHAT A RESULT MEANS - read this before sending anyone to a door
// A match says "this address sits inside a census block where Kinetic added
// fiber between the two most recent filings". It does NOT say this address has
// service. The newest filing describes 2025-12-31, so these are the blocks
// Kinetic was actively building through the end of 2025 - the best-founded
// place to look for 2026 completions, and still a candidate, never a
// confirmation. Only an authorized address qualification can confirm.
//
// USAGE - dry run is the default.
//   tsx script/attribute-kinetic-blocks.ts --tenant 1
//   tsx script/attribute-kinetic-blocks.ts --tenant 1 --apply

import { rawDb } from "../server/db";
import { runMigrations } from "../server/storage";
import { additionBlocks, setBlockDenominators, importedVintages, TARGET_COUNTY_FIPS } from "../server/fccImportStore";
import { ensureBuildState, reclassify, canonicalKeyFor } from "../server/kineticBuildStore";

const TIGERWEB = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/2/query";
/** GEOIDs per TIGERweb request. The service rejects very long WHERE clauses,
 *  and 40 keeps each request comfortably inside its limit. */
const GEOID_CHUNK = 40;

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes("--apply");
const TENANT = Number(flag("tenant") ?? NaN);
if (!Number.isInteger(TENANT) || TENANT <= 0) {
  console.error("Required: --tenant <positive org id>   (plus --apply to write)");
  process.exit(1);
}

interface BlockShape {
  geoid: string;
  countyFips: string;
  housingUnits: number;
  /** Outer rings only. Census blocks are simple enough that holes do not
   *  change containment for a residential address. */
  rings: Array<Array<[number, number]>>;
  minLat: number; maxLat: number; minLng: number; maxLng: number;
}

async function fetchShapes(geoids: string[]): Promise<BlockShape[]> {
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
    process.stdout.write(`\r  polygons ${Math.min(i + GEOID_CHUNK, geoids.length)}/${geoids.length}`);
  }
  process.stdout.write("\n");
  return out;
}

/** Ray casting. Points exactly on an edge are rare enough at address
 *  precision that either answer is defensible; consistency is what matters. */
function inRing(lat: number, lng: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inBlock = (lat: number, lng: number, block: BlockShape) =>
  lat >= block.minLat && lat <= block.maxLat && lng >= block.minLng && lng <= block.maxLng
  && block.rings.some((ring) => inRing(lat, lng, ring));

async function main() {
  runMigrations();
  const vintages = importedVintages(TENANT);
  if (vintages.length < 2) {
    console.error(`Need at least two imported vintages to compute a build front (have: ${vintages.join(", ") || "none"}).`);
    process.exit(1);
  }
  console.log(`vintages  ${vintages.join(" -> ")}`);

  const blocks = additionBlocks(TENANT, { limit: 50_000 });
  console.log(`build-front blocks: ${blocks.length} (${blocks.reduce((n, b) => n + b.added, 0)} locations added)\n`);

  console.log("fetching block polygons + housing units from TIGERweb...");
  const shapes = await fetchShapes(blocks.map((b) => b.blockGeoid));
  console.log(`  got ${shapes.length} of ${blocks.length} blocks\n`);

  // Coarse bbox over every build-front block, so the lead scan skips the vast
  // majority of doors without running a single point-in-polygon test.
  const bounds = shapes.reduce((acc, s) => ({
    minLat: Math.min(acc.minLat, s.minLat), maxLat: Math.max(acc.maxLat, s.maxLat),
    minLng: Math.min(acc.minLng, s.minLng), maxLng: Math.max(acc.maxLng, s.maxLng),
  }), { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 });

  const leads = rawDb.prepare(`
    SELECT id, address, city, state, zip, lat, lng, do_not_knock AS dnk, lead_status AS status,
           contact_phone AS phone, billing_status AS billing
      FROM leads
     WHERE tenant_id = ? AND lat IS NOT NULL AND lng IS NOT NULL
       AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
  `).all(TENANT, bounds.minLat, bounds.maxLat, bounds.minLng, bounds.maxLng) as any[];
  console.log(`candidate doors inside the build-front bounds: ${leads.length}`);

  const matches: Array<{ lead: any; block: BlockShape }> = [];
  for (const lead of leads) {
    const block = shapes.find((s) => inBlock(lead.lat, lead.lng, s));
    if (block) matches.push({ lead, block });
  }
  console.log(`doors inside a build-front block: ${matches.length}\n`);

  const byCounty: Record<string, number> = {};
  for (const m of matches) {
    const name = TARGET_COUNTY_FIPS[m.block.countyFips] ?? m.block.countyFips;
    byCounty[name] = (byCounty[name] ?? 0) + 1;
  }
  console.table(byCounty);

  if (!APPLY) {
    console.log("\nDRY RUN (nothing written). Re-run with --apply.");
    return;
  }

  // Denominators first: the classifier reads total_residential_locations to
  // tell a finished block from one with premises still unserved, and treats 0
  // as unknown rather than empty. Without this every door stays unverified.
  const latest = vintages[vintages.length - 1];
  const written = setBlockDenominators(TENANT, latest,
    shapes.map((s) => ({ blockGeoid: s.geoid, totalResidentialLocations: s.housingUnits })));
  console.log(`\ndenominators set on ${written} blocks (${latest}, from Census HU100)`);

  let created = 0;
  const classCounts: Record<string, number> = {};
  for (const { lead, block } of matches) {
    const identity = {
      tenantId: TENANT,
      address: lead.address, city: lead.city, state: lead.state ?? "NC", zip: lead.zip,
      lat: lead.lat, lng: lead.lng,
      blockGeoid: block.geoid, countyFips: block.countyFips,
    };
    const state = ensureBuildState(identity);
    created++;
    // Link the existing door so the map and the ranked list resolve to the
    // lead a rep already knows, rather than minting a parallel record.
    rawDb.prepare(`UPDATE kinetic_build_state SET lead_id = ? WHERE id = ? AND lead_id IS NULL`).run(lead.id, state.id);

    const decision = reclassify(TENANT, canonicalKeyFor(identity), {
      // Suppression comes from the CRM's own flags - never invented here.
      suppression: lead.dnk ? "do_not_knock"
        : lead.status === "competitor_suppressed" ? "competitor"
        : lead.status === "scope_suppressed" ? "scope"
        : null,
      existingCustomer: String(lead.billing ?? "").toUpperCase() === "Y",
    });
    classCounts[decision.classification] = (classCounts[decision.classification] ?? 0) + 1;
  }

  console.log(`\nbuild states written: ${created}`);
  console.table(classCounts);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
