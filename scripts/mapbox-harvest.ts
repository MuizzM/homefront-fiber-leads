// ── Deep Mapbox address harvest for ONE tight area → pool ─────────────────────
// Full-coverage address capture: reverse-geocodes a grid over a TIGHT box (the
// town, not Mapbox's oversized place polygon) so it stays under MAPBOX_HARVEST_CAP
// and in the free tier. Every address is pooled once (scan_targets); a later
// scan-engine-run <City> checks them against Kinetic through the proxy — the
// geocoding cost is paid ONCE, re-scans are free.
//
//   usage: tsx scripts/mapbox-harvest.ts <lat> <lng> <miles> <City> [ST=NC]
//   e.g.:  tsx scripts/mapbox-harvest.ts 35.5697 -80.5817 3 "China Grove" NC
import "dotenv/config";
import { storage } from "../server/storage";
import { harvestBboxAddresses, bboxGridSize } from "../server/mapbox-addresses";

const [latS, lngS, miS, city, state = "NC"] = process.argv.slice(2);
if (!latS || !lngS || !miS || !city) {
  console.error('usage: tsx scripts/mapbox-harvest.ts <lat> <lng> <miles> "<City>" [ST]');
  process.exit(1);
}
const cLat = Number(latS), cLng = Number(lngS), mi = Number(miS);
const dLat = mi / 69, dLng = mi / 55; // deg per mile (lat / lng at ~35°N)
const bbox = { south: cLat - dLat / 2, north: cLat + dLat / 2, west: cLng - dLng / 2, east: cLng + dLng / 2 };

(async () => {
  const token = process.env.MAPBOX_TOKEN ?? process.env.MAPBOX_PUBLIC_TOKEN ?? "";
  if (!token) { console.error("MAPBOX_TOKEN not set"); process.exit(1); }
  const grid = bboxGridSize(bbox);
  const cap = Number(process.env.MAPBOX_HARVEST_CAP ?? 5000);
  console.log(`${city}, ${state}: ${mi}mi box · ${grid} grid points (Mapbox geocode calls) · cap ${cap}`);
  if (grid > cap) { console.error(`OVER CAP (${grid} > ${cap}) — use a smaller radius or raise MAPBOX_HARVEST_CAP if you accept the cost.`); process.exit(1); }

  const t0 = Date.now();
  const addresses = await harvestBboxAddresses(bbox, state, token,
    (done, total, found) => { if (done % 250 === 0) console.log(`  ${done}/${total} grid pts · ${found} addresses so far`); });
  console.log(`harvested ${addresses.length} addresses in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Pool once (upsert dedups on the unique address). Force the queried city so a
  // later scan-engine-run <City> loads them; edge points may reverse-geocode to a
  // neighbor town — keep the requested city label so the sweep finds them.
  const added = storage.upsertScanTargets(addresses.map((a: any) => ({
    address: a.address, city, state, zip: a.zip ?? "",
    lat: a.lat ?? null, lng: a.lng ?? null, source: "mapbox-grid", tenantId: null,
  })));
  console.log(`POOLED: ${added} new never-scanned addresses for ${city}. Next: scan-engine-run "${city}" to check them against Kinetic.`);
  process.exit(0);
})();
