// Export Kinetic answers we ALREADY BOUGHT, in the shape
// script/import-scan-verdicts.ts replays into production.
//
// Committed alongside the JSON it produces so a verdict batch destined for
// production is never an opaque blob: the query that derived it is right here.
// Run from the repo root against the database that did the scanning:
//   npx tsx script/export-scan-verdicts.ts
//
// Why this exists: those doors were scanned once, with real provider responses
// stored in fiber_checks. Production should ADOPT that evidence, not buy the
// same 2,000 answers a second time. The replay goes through
// persistKineticObservation - the same function the live scanner calls - so
// each door gets a real availability snapshot, is stamped scanned (which under
// SCAN_ONCE_ONLY takes it out of the never-scanned rotation for good), and is
// handed to the projector.
import "dotenv/config";
import { rawDb } from "../server/db";
import fs from "node:fs";

const rows = rawDb.prepare(`
  SELECT s.address, s.city, s.state, s.zip, s.lat, s.lng,
         s.last_fiber_status  AS fiberStatus,
         s.last_is_new_fiber  AS isNewFiber,
         s.last_billing_status AS billingStatus,
         s.last_fiber_available AS fiberAvailable,
         a.household_segment_type AS householdSegmentType,
         s.last_scanned_at AS scannedAt
    FROM scan_targets s
    LEFT JOIN availability_snapshots a ON a.id=(
      SELECT x.id FROM availability_snapshots x
       WHERE x.scan_target_id=s.id AND x.tenant_id=1 AND x.conclusive=1
       ORDER BY x.checked_at_epoch DESC, x.id DESC LIMIT 1)
   WHERE s.tenant_id=1 AND s.state='NC'
     AND (lower(s.city)='landis' OR s.zip='28088')
     AND s.last_scanned_at IS NOT NULL
     AND s.last_fiber_status IS NOT NULL
   ORDER BY s.city, s.address`).all() as any[];

const out = rows.map((r) => ({
  address: r.address, city: r.city, state: r.state, zip: r.zip ?? "",
  lat: r.lat ?? null, lng: r.lng ?? null,
  fiberStatus: r.fiberStatus,
  isNewFiber: !!r.isNewFiber,
  billingStatus: r.billingStatus ?? null,
  fiberAvailable: !!r.fiberAvailable,
  householdSegmentType: r.householdSegmentType ?? null,
  scannedAt: r.scannedAt,
}));

fs.writeFileSync("script/scan-verdicts-landis-2026-08-27.json", JSON.stringify(out, null, 0));
const sellable = out.filter((v) => v.fiberAvailable && v.billingStatus === "N").length;
const newFiber = out.filter((v) => v.isNewFiber).length;
console.log(`verdicts exported : ${out.length}`);
console.log(`  fiber available : ${out.filter((v) => v.fiberAvailable).length}`);
console.log(`  SELLABLE (fiber + billing N) : ${sellable}`);
console.log(`  NEW FIBER segment : ${newFiber}`);
console.log(`  by city: ${JSON.stringify(out.reduce((a: any, v) => { a[v.city]=(a[v.city]??0)+1; return a; }, {}))}`);
console.log(`  file KB: ${Math.round(fs.statSync("script/scan-verdicts-landis-2026-08-27.json").size/1024)}`);
process.exit(0);
