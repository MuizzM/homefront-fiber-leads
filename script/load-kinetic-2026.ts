// ── Load the Kinetic 2026 build front into a live database ───────────────────
//
// The PRODUCTION path. Same rails as script/import-fcc-pins.ts: the dataset
// ships inside the image, the bundled .cjs runs in a one-off container against
// the real /data volume, and nobody needs a shell or an admin session.
// Dispatched by .github/workflows/import-kinetic-2026.yml.
//
// TWO STEPS, ONE DISPATCH
//   1. Apply the baked per-block footprint (kinetic-2026-footprint.json) - the
//      durable product of the FCC BDC vintage imports. The raw availability
//      rows never ship; only the rollup they finalized into.
//   2. Attribute the org's EXISTING doors into the build-front blocks and
//      classify them, using free TIGERweb block polygons and Census HU100
//      housing counts. No geocoding, nothing bought.
//
// WHAT THIS DOES NOT DO
// It creates no leads. Only confirmed_2026 is lead-eligible and nothing here
// can confirm - that needs an authorized address qualification. This classifies
// doors the org already has, so a rep can be pointed at the ones sitting in
// blocks Kinetic was actively building. Candidates, verified at the door.
//
// USAGE - dry run is the default. Nothing is written without --apply.
//   node dist/load-kinetic-2026.cjs --tenant 1
//   node dist/load-kinetic-2026.cjs --tenant 1 --apply
//
// UNDO: the footprint is removable per vintage
// (POST /api/kinetic-2026/vintages/<code>/revert, confirm = the code). The
// classification rows are derived and are recomputed from whatever evidence
// remains; no lead is created, retagged or deleted by this script, so there is
// nothing here that a purge has to clean up.

import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../server/storage";
import {
  importedVintages, loadFootprint, TARGET_COUNTY_FIPS,
  type FootprintExport,
} from "../server/fccImportStore";
import { attributeBuildFront } from "../server/kineticBuildAttribution";
import { vintageOf } from "@shared/fccVintage";

const DATASET = "kinetic-2026-footprint.json";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes("--apply");
const TENANT = Number(flag("tenant") ?? NaN);
if (!Number.isInteger(TENANT) || TENANT <= 0) {
  console.error("Required: --tenant <positive org id>   (plus --apply to write)");
  process.exit(1);
}

/** Beside the executed entry (dist/ in the image), with a data/ fallback for a
 *  tsx dev run - the same two-candidate lookup import-fcc-pins.ts uses, and for
 *  the same reason: __dirname and import.meta each exist in only one of the two
 *  module systems this file is run under. */
function loadDataset(): FootprintExport {
  const candidates = [
    path.join(path.dirname(process.argv[1] ?? "."), DATASET),
    path.join(process.cwd(), "data", DATASET),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error(`dataset not found; looked in:\n  ${candidates.join("\n  ")}`);
}

async function main() {
  runMigrations();
  console.log(`database  ${path.join(process.env.DATA_DIR || process.cwd(), "data.db")}`);

  const data = loadDataset();
  if (!data.rows?.length) { console.error("Dataset is empty - refusing to run."); process.exit(1); }
  console.log(`dataset   ${data.rows.length} block-vintage rows, vintages ${data.vintages.join(" -> ")}`);
  console.log(`counties  ${Object.values(TARGET_COUNTY_FIPS).join(", ")}`);
  const newest = data.vintages[data.vintages.length - 1];
  console.log(`evidence  through ${vintageOf(newest).label}`);
  console.log(`\nNOTE: no published FCC filing covers 2026 yet, so nothing here is a`);
  console.log(`confirmed 2026 build. These are candidates - verify at the door.\n`);

  if (!APPLY) {
    console.log("DRY RUN (nothing written). Re-run with --apply.\n");
    const existing = importedVintages(TENANT);
    console.log(`  vintages already present for tenant ${TENANT}: ${existing.join(", ") || "none"}`);
    console.log(`  would apply: ${data.vintages.join(", ")}`);
    // The attribution dry run still costs the TIGERweb fetch, which is the
    // slow part - worth it, because it reports exactly how many doors would be
    // touched before anything is.
    try {
      const preview = await attributeBuildFront(TENANT, {
        apply: false,
        onProgress: (d, t) => process.stdout.write(`\r  polygons ${d}/${t}`),
      });
      process.stdout.write("\n");
      console.log(`  build-front blocks: ${preview.buildFrontBlocks}`);
      console.log(`  doors that would be classified: ${preview.doorsMatched}`);
    } catch (error: any) {
      console.log(`\n  (attribution preview unavailable: ${error?.message})`);
      console.log("  Expected on a first run - the footprint has not been applied yet.");
    }
    return;
  }

  const applied = loadFootprint(TENANT, data);
  console.log(`footprint applied: ${applied.blocks} rows across ${applied.vintages.join(", ")}`);

  const result = await attributeBuildFront(TENANT, {
    apply: true,
    onProgress: (d, t) => process.stdout.write(`\r  polygons ${d}/${t}`),
  });
  process.stdout.write("\n");
  console.log(`build-front blocks: ${result.buildFrontBlocks} (${result.shapesFetched} polygons)`);
  console.log(`doors in bounds: ${result.doorsInBounds}, matched into a block: ${result.doorsMatched}`);
  console.log(`denominators set on ${result.denominatorsSet} blocks (Census HU100)`);

  const named: Record<string, number> = {};
  for (const [fips, n] of Object.entries(result.byCounty)) named[TARGET_COUNTY_FIPS[fips] ?? fips] = n;
  console.log("\ndoors by county:");
  console.table(named);
  console.log("classified:");
  console.table(result.classified);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
