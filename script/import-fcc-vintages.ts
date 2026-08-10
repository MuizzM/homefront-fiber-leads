// ── Import FCC BDC vintages for Kinetic (Windstream) ─────────────────────────
//
// Streams harvested BDC availability rows into the durable per-block footprint
// through the REAL staged import path (openImport -> ingestChunk ->
// finalizeImport), so an operator run exercises exactly the code the HTTP API
// uses: same scope rejection, same chunk digests, same refusal to finalize a
// partial baseline, same reversibility.
//
// WHERE THE INPUT COMES FROM
// broadbandmap.fcc.gov answers 403 to every server-side client (Akamai), so
// this script does not download anything. An operator extracts the rows in a
// browser and drops one JSONL file per vintage into the input directory:
//
//   fcc-D24.jsonl  fcc-J25.jsonl  fcc-D25.jsonl
//
// Each line is one availability row:
//   {"locationId","blockGeoid","providerId","technology","brCode",
//    "maxDownMbps","maxUpMbps"}
//
// Kinetic files under provider_id 131413 (Uniti Group Inc. - the post-merger
// holding company; "Windstream" and "Kinetic" appear nowhere in the BDC
// provider list, which is why a name search for either returns nothing).
//
// ORDER MATTERS. Vintages import oldest first. A vintage with no older
// vintage beneath it has nothing to diff against, so every block reports zero
// additions and no candidates are produced - importing D25 alone looks like a
// success and yields an empty layer.
//
// USAGE - dry run is the default. Nothing is written without --apply.
//
//   tsx script/import-fcc-vintages.ts --tenant 1 --dir ./data/fcc-vintages
//   tsx script/import-fcc-vintages.ts --tenant 1 --dir ./data/fcc-vintages --apply
//
// Undo: POST /api/kinetic-2026/vintages/<code>/revert (confirm = the code), or
// revertVintage() directly. Reverting removes that vintage's footprint rows
// and leaves every other vintage, all leads, and all evidence history intact.

import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "../server/storage";
import {
  additionBlocks, discardImport, exportFootprint, finalizeImport, importedVintages,
  ingestChunk, listImports, openImport, TARGET_COUNTY_FIPS,
  type FccAvailabilityRow,
} from "../server/fccImportStore";
import { parseVintageCode, sortVintages, vintageOf, type FccVintageCode } from "@shared/fccVintage";

/** Rows per chunk. Matches the API cap so a file that imports cleanly here
 *  imports cleanly over HTTP too. */
const CHUNK = 5_000;
/** Kinetic's FCC provider id. See the header note about Uniti. */
const KINETIC_PROVIDER_ID = "131413";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes("--apply");
const TENANT = Number(flag("tenant") ?? NaN);
const DIR = flag("dir") ?? path.join(process.cwd(), "data", "fcc-vintages");

if (!Number.isInteger(TENANT) || TENANT <= 0) {
  console.error("Required: --tenant <positive org id>   (plus --apply to write)");
  process.exit(1);
}

function discover(): FccVintageCode[] {
  if (!fs.existsSync(DIR)) {
    console.error(`Input directory not found: ${DIR}`);
    process.exit(1);
  }
  const found: FccVintageCode[] = [];
  for (const entry of fs.readdirSync(DIR)) {
    const match = /^fcc-([JD]\d{2})\.jsonl$/i.exec(entry);
    if (!match) continue;
    const code = parseVintageCode(match[1]);
    if (code) found.push(code);
  }
  return sortVintages(found);   // oldest first - see the header note
}

function readRows(code: FccVintageCode): FccAvailabilityRow[] {
  const file = path.join(DIR, `fcc-${code}.jsonl`);
  const rows: FccAvailabilityRow[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch { /* a truncated final line from an interrupted upload - skip it */ }
  }
  return rows;
}

function main() {
  runMigrations();
  console.log(`database  ${path.join(process.env.DATA_DIR || process.cwd(), "data.db")}`);
  console.log(`input     ${DIR}`);
  console.log(`counties  ${Object.values(TARGET_COUNTY_FIPS).join(", ")}\n`);

  const vintages = discover();
  if (!vintages.length) {
    console.error(`No fcc-<VINTAGE>.jsonl files in ${DIR} - nothing to import.`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log("DRY RUN (nothing written). Re-run with --apply to import.\n");
    for (const code of vintages) {
      const rows = readRows(code);
      const inScope = rows.filter((r) => TARGET_COUNTY_FIPS[String(r.blockGeoid).slice(0, 5)]);
      console.log(`  ${code} (${vintageOf(code).label}): ${rows.length} rows, ${inScope.length} inside the authorized counties`);
    }
    console.log(`\nWould import oldest-first: ${vintages.join(" -> ")}`);
    return;
  }

  for (const code of vintages) {
    const rows = readRows(code);
    // Re-runnable: clear an import left open by an interrupted attempt, so the
    // one-open-per-vintage unique index does not block the retry.
    for (const job of listImports(TENANT)) {
      if (job.status === "open" && job.vintage === code) discardImport(job.id, "superseded by rerun");
    }

    const chunkCount = Math.max(1, Math.ceil(rows.length / CHUNK));
    const job = openImport({
      tenantId: TENANT,
      vintage: code,
      providerIds: [KINETIC_PROVIDER_ID],
      manifest: `bdc_37_${KINETIC_PROVIDER_ID}_fixed_broadband_${code}`,
      sourceUrl: "https://broadbandmap.fcc.gov/data-download/data-by-provider",
      expectedChunkCount: chunkCount,
      expectedRowCount: rows.length,
    });

    let accepted = 0, rejected = 0;
    const reasons: Record<string, number> = {};
    for (let i = 0; i < chunkCount; i++) {
      const result = ingestChunk(job.id, i, rows.slice(i * CHUNK, (i + 1) * CHUNK));
      accepted += result.accepted; rejected += result.rejected;
      for (const [reason, n] of Object.entries(result.rejectionReasons)) {
        reasons[reason] = (reasons[reason] ?? 0) + n;
      }
    }
    const done = finalizeImport(job.id);
    const why = Object.entries(reasons).map(([r, n]) => `${r}=${n}`).join(" ");
    console.log(`${code}: ${accepted} accepted, ${rejected} rejected${why ? ` (${why})` : ""} -> ${done.blocksWritten} blocks, ${done.locationsWritten} locations`);
  }

  console.log(`\nimported vintages: ${importedVintages(TENANT).join(", ")}`);
  const additions = additionBlocks(TENANT, { limit: 50_000 });
  const addedTotal = additions.reduce((n, b) => n + b.added, 0);
  console.log(`addition blocks (newest vintage vs the one before it): ${additions.length} blocks, ${addedTotal} locations`);

  const byCounty: Record<string, { blocks: number; added: number }> = {};
  for (const block of additions) {
    const county = TARGET_COUNTY_FIPS[block.countyFips] ?? block.countyFips;
    const entry = (byCounty[county] ??= { blocks: 0, added: 0 });
    entry.blocks++; entry.added += block.added;
  }
  console.table(byCounty);

  // Bake the durable artifact for production. The raw availability rows never
  // ship - only the per-block rollup they finalize into.
  const exportPath = flag("export");
  if (exportPath) {
    const payload = exportFootprint(TENANT, { generatedAt: new Date().toISOString() });
    fs.writeFileSync(exportPath, JSON.stringify(payload));
    const mb = (fs.statSync(exportPath).size / 1e6).toFixed(1);
    console.log(`\nbaked footprint -> ${exportPath} (${payload.rows.length} block-vintage rows, ${mb} MB)`);
  }
}

main();
