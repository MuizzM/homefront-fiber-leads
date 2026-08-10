// ── Attribute existing doors to Kinetic's build-front blocks (local) ─────────
//
// Thin operator wrapper. All the work lives in server/kineticBuildAttribution.ts
// so this and the production loader (script/load-kinetic-2026.ts) run the SAME
// implementation - what gets reviewed on a laptop is what runs on the box.
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

import { runMigrations } from "../server/storage";
import { TARGET_COUNTY_FIPS } from "../server/fccImportStore";
import { attributeBuildFront } from "../server/kineticBuildAttribution";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes("--apply");
const TENANT = Number(flag("tenant") ?? NaN);
if (!Number.isInteger(TENANT) || TENANT <= 0) {
  console.error("Required: --tenant <positive org id>   (plus --apply to write)");
  process.exit(1);
}

async function main() {
  runMigrations();
  const result = await attributeBuildFront(TENANT, {
    apply: APPLY,
    onProgress: (done, total) => process.stdout.write(`\r  polygons ${done}/${total}`),
  });
  process.stdout.write("\n");

  console.log(`build-front blocks: ${result.buildFrontBlocks} (${result.shapesFetched} polygons fetched)`);
  console.log(`candidate doors inside the build-front bounds: ${result.doorsInBounds}`);
  console.log(`doors inside a build-front block: ${result.doorsMatched}\n`);

  const named: Record<string, number> = {};
  for (const [fips, n] of Object.entries(result.byCounty)) named[TARGET_COUNTY_FIPS[fips] ?? fips] = n;
  console.table(named);

  if (!APPLY) {
    console.log("\nDRY RUN (nothing written). Re-run with --apply.");
    return;
  }
  console.log(`\ndenominators set on ${result.denominatorsSet} blocks (Census HU100)`);
  console.table(result.classified);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
