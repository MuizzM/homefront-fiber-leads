// Export Kinetic answers we ALREADY BOUGHT, in the shape
// script/import-scan-verdicts.ts replays into production.
//
// Committed alongside the JSON it produces so a verdict batch destined for
// production is never an opaque blob: the query that derived it is right here.
// Run from the repo root against the database that did the scanning:
//   npx tsx script/export-scan-verdicts.ts --city Rockwell
//   npx tsx script/export-scan-verdicts.ts --city Rockwell --merge script/scan-verdicts-nc-2026-08.json
//
// Why this exists: those doors were scanned once, with real provider responses
// stored in availability_snapshots. Production should ADOPT that evidence, not
// buy the same answers a second time. The replay goes through
// persistKineticObservation - the same function the live scanner calls - so
// each door gets a real availability snapshot, is stamped scanned (which under
// SCAN_ONCE_ONLY takes it out of the never-scanned rotation for good), and is
// handed to the projector.
//
// --merge folds the export INTO the file the build ships
// (script/build.ts copies scan-verdicts-nc-2026-08.json into dist/, and
// import-scan-verdicts.yml runs the bundle with no --file input, so that one
// filename is what production actually reads). Merging keeps the NEWEST verdict
// per door: a door answered again today supersedes its older row rather than
// appearing twice. The importer would skip the stale copy anyway, but shipping
// two rows for one door makes the file lie about its own size.
import "dotenv/config";
import { rawDb } from "../server/db";
import { normalizeKineticAddressKey } from "@shared/addressKey";
import fs from "node:fs";

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : null;
}
const CITY = flag("city");
const STATE = flag("state") ?? "NC";
const TENANT = Number(flag("tenant") ?? 1);
const MERGE_INTO = flag("merge");
const OUT = flag("out");
if (!CITY) { console.error("Required: --city <town> [--state NC] [--merge <file>] [--out <file>]"); process.exit(2); }

type Verdict = {
  address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null;
  fiberStatus: string; isNewFiber: boolean; billingStatus: string | null;
  fiberAvailable: boolean; householdSegmentType: string | null; scannedAt: string;
};

// householdSegmentType is KINETIC's own word (NEW FIBER / TENURED), read off the
// latest conclusive snapshot. It is NOT scan_targets.last_customer_segment,
// which is OUR derived new_opportunity/existing_customer label - substituting
// one for the other would feed the projector a value Kinetic never said.
const rows = rawDb.prepare(`
  SELECT s.address, s.city, s.state, s.zip, s.lat, s.lng,
         s.last_fiber_status   AS fiberStatus,
         s.last_is_new_fiber   AS isNewFiber,
         s.last_billing_status AS billingStatus,
         s.last_fiber_available AS fiberAvailable,
         a.household_segment_type AS householdSegmentType,
         s.last_scanned_at AS scannedAt
    FROM scan_targets s
    LEFT JOIN availability_snapshots a ON a.id=(
      SELECT x.id FROM availability_snapshots x
       WHERE x.scan_target_id=s.id AND x.tenant_id=? AND x.conclusive=1
       ORDER BY x.checked_at_epoch DESC, x.id DESC LIMIT 1)
   WHERE s.tenant_id=? AND s.state=? AND lower(s.city)=lower(?)
     AND s.last_scanned_at IS NOT NULL
     AND s.last_fiber_status IS NOT NULL
   ORDER BY s.city, s.address`).all(TENANT, TENANT, STATE, CITY) as any[];

const fresh: Verdict[] = rows.map((r) => ({
  address: r.address, city: r.city, state: r.state, zip: r.zip ?? "",
  lat: r.lat ?? null, lng: r.lng ?? null,
  fiberStatus: r.fiberStatus,
  isNewFiber: !!r.isNewFiber,
  billingStatus: r.billingStatus ?? null,
  fiberAvailable: !!r.fiberAvailable,
  householdSegmentType: r.householdSegmentType ?? null,
  scannedAt: r.scannedAt,
}));

const key = (v: Verdict) => normalizeKineticAddressKey(v.address, v.city, v.state, v.zip);
const tally = (list: Verdict[]) => ({
  n: list.length,
  fiber: list.filter((v) => v.fiberAvailable).length,
  sellable: list.filter((v) => v.fiberAvailable && v.billingStatus === "N").length,
  newFiber: list.filter((v) => v.isNewFiber).length,
});
const t = tally(fresh);
console.log(`${CITY}, ${STATE} verdicts exported : ${t.n}`);
console.log(`  fiber available              : ${t.fiber}`);
console.log(`  SELLABLE (fiber + billing N) : ${t.sellable}`);
console.log(`  NEW FIBER segment            : ${t.newFiber}`);

let out = fresh;
let target = OUT ?? `script/scan-verdicts-${CITY.toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.json`;

if (MERGE_INTO) {
  const existing = JSON.parse(fs.readFileSync(MERGE_INTO, "utf8")) as Verdict[];
  const merged = new Map<string, Verdict>();
  for (const v of existing) merged.set(key(v), v);
  let replaced = 0, added = 0, kept = 0;
  for (const v of fresh) {
    const k = key(v);
    const prev = merged.get(k);
    if (!prev) { merged.set(k, v); added++; continue; }
    // Newest wins. A verdict older than the one already in the file is dropped -
    // shipping it would only be skipped by the importer, and it makes the file
    // overstate how much evidence it carries.
    if (String(v.scannedAt) > String(prev.scannedAt)) { merged.set(k, v); replaced++; }
    else kept++;
  }
  out = [...merged.values()];
  target = OUT ?? MERGE_INTO;
  console.log("");
  console.log(`merge into ${MERGE_INTO}`);
  console.log(`  existing verdicts : ${existing.length}`);
  console.log(`  added (new door)  : ${added}`);
  console.log(`  replaced (newer)  : ${replaced}`);
  console.log(`  kept (file newer) : ${kept}`);
  console.log(`  result            : ${out.length}`);
  const m = tally(out);
  console.log(`  file now: ${m.n} verdicts, ${m.fiber} fiber, ${m.sellable} SELLABLE, ${m.newFiber} NEW FIBER`);
}

fs.writeFileSync(target, JSON.stringify(out, null, 0));
console.log("");
console.log(`wrote ${target}  (${Math.round(fs.statSync(target).size / 1024)} KB)`);
process.exit(0);
