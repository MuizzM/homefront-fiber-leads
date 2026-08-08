// ── Import FCC fiber-addition pins — Cabarrus/Rowan five-city 2025 batch ─────
//
// WHAT THIS ADDS
// One `fcc_fresh_block` lead per harvested door inside a census block where the
// FCC's Dec-31-2025 BDC filing reports residential fiber (tech 50) that the
// Dec-31-2024 filing did not — i.e. doors whose block was newly lit during
// 2025/2026 reporting. Cities: Concord, Kannapolis, Salisbury, China Grove,
// Landis (Cabarrus + Rowan). The dataset ships in
// data/fcc-additions-cabarrus-rowan-2025.json (built from the public BDC
// state/technology files, block polygons from TIGERweb, doors from OSM).
//
// WHAT A PIN MEANS — same contract the map/knock-sheet already enforce for the
// fcc tag family: the tag is the carrier's FILING, not a door verification.
// Blocks qualify when they had NO fiber at all in D24, or when ≥50% of the
// block's D25 residential locations are 2025-additions; each lead's notes say
// which case it is. The knock sheet shows its amber "verify at the door" chip
// for every fcc_* tag, purge (/api/leads/fcc-purge) removes unworked ones in
// bulk, and adopt-on-tap turns a knocked one into the rep's live pin.
//
// WHY upsertLeadByAddress AND NOT RAW SQL
// It computes the same canonical key the UNIQUE index enforces, so an existing
// door (organic, hot_lead, fresh_fiber_confirmed — anything) attaches instead
// of duplicating, and comes back created:false — this import can never touch,
// retag, or duplicate a door the org already works.
//
// USAGE — dry run is the default. Nothing is written without --apply.
//
//   tsx script/import-fcc-pins.ts --tenant 1
//   tsx script/import-fcc-pins.ts --tenant 1 --apply
//
// In PRODUCTION nobody has a shell — run it through
// .github/workflows/import-fcc-pins.yml, which executes the bundled build
// (`node dist/import-fcc-pins.cjs`) in a one-off container on the live /data
// volume (exactly the reset-areas.yml pattern). script/build.ts copies the
// JSON into dist/ beside the .cjs, so the image carries its own dataset.

import fs from "node:fs";
import path from "node:path";
import { storage, runMigrations } from "../server/storage";

// Dataset rides beside the code the same way rockwell_gis_addresses.json does:
// script/build.ts copies it into dist/ so the bundled .cjs finds it in the
// production image; the tsx dev run finds it in data/ at the repo root.
function loadPins(): unknown {
  // Beside the executed entry (dist/ in the image, script/ under tsx — hence
  // the data/ fallback for the dev run), avoiding __dirname/import.meta which
  // each exist in only one of those module systems.
  const candidates = [
    path.join(path.dirname(process.argv[1] ?? "."), "fcc-additions-cabarrus-rowan-2025.json"),
    path.join(process.cwd(), "data", "fcc-additions-cabarrus-rowan-2025.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  throw new Error(`dataset not found; looked in:\n  ${candidates.join("\n  ")}`);
}
const pins = loadPins();

interface Pin {
  address: string; city: string; state: string; zip: string;
  lat: number; lng: number; blockGeoid: string; blockKind: "new" | "infill";
  addedInBlock: number; totalInBlock: number; providers: string[];
}

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const tenantFlag = argv.indexOf("--tenant");
const TENANT = tenantFlag >= 0 ? Number(argv[tenantFlag + 1]) : NaN;
if (!Number.isInteger(TENANT) || TENANT <= 0) {
  console.error("Required: --tenant <positive org id>   (plus --apply to write)");
  process.exit(1);
}

const LEAD_TAG = "fcc_fresh_block";
// Brand names as filed with the FCC → what a rep should read on the card.
const PROVIDER_LABELS: Record<string, string> = {
  "Windstream Concord Telephone Company": "Kinetic (Windstream)",
};
const providerLabel = (p: string) => PROVIDER_LABELS[p] ?? p;

function noteFor(p: Pin): string {
  const provs = p.providers.map(providerLabel).join(" + ");
  const doors = `${p.addedInBlock} of ${p.totalInBlock} doors in this block`;
  return p.blockKind === "new"
    ? `FCC Dec-2025 filing: first fiber reported in this block during 2025 — ${provs}. ${doors} reported newly serviceable. Verify at the door.`
    : `FCC Dec-2025 filing: ${provs} newly reported fiber to ${doors} during 2025 (some neighbors had fiber earlier). Verify at the door.`;
}

async function main() {
  runMigrations();
  console.log(`database  ${path.join(process.env.DATA_DIR || process.cwd(), "data.db")}`);
  const rows = pins as Pin[];
  if (!rows.length) { console.error("Dataset is empty — refusing to run."); process.exit(1); }

  const perCity = new Map<string, { created: number; existing: number }>();
  const bump = (city: string, k: "created" | "existing") => {
    const c = perCity.get(city) ?? { created: 0, existing: 0 };
    c[k]++; perCity.set(city, c);
  };

  let created = 0, existing = 0;
  for (const [i, p] of rows.entries()) {
    if (!APPLY) {
      const hit = storage.findLeadByAddress(TENANT, p.address, p.city, p.state, p.zip);
      if (hit) { existing++; bump(p.city, "existing"); } else { created++; bump(p.city, "created"); }
    } else {
      const r = storage.upsertLeadByAddress({
        address: p.address, city: p.city, state: p.state, zip: p.zip,
        lat: p.lat, lng: p.lng,
        leadStatus: "prospect", leadTag: LEAD_TAG, leadScore: 0,
        notes: noteFor(p), tenantId: TENANT,
      } as any);
      if (r.created) { created++; bump(p.city, "created"); } else { existing++; bump(p.city, "existing"); }
    }
    if ((i + 1) % 2000 === 0) console.log(`  … ${i + 1}/${rows.length}`);
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN (nothing written)"} — tenant ${TENANT}, tag ${LEAD_TAG}`);
  console.log(`  ${APPLY ? "created" : "would create"}: ${created}`);
  console.log(`  already on the map (left untouched): ${existing}`);
  for (const [city, c] of [...perCity.entries()].sort((a, b) => b[1].created - a[1].created)) {
    console.log(`    ${city.padEnd(12)} ${APPLY ? "created" : "new"} ${String(c.created).padStart(5)}   existing ${String(c.existing).padStart(5)}`);
  }
  if (APPLY) {
    storage.logActivity(null, "lead.fcc_imported", "lead", undefined,
      { batch: "cabarrus-rowan-2025", tag: LEAD_TAG, created, existing }, undefined, TENANT);
    console.log(`\nDone. Pins appear on the field map within its refresh window (cross-process data version moves on insert).`);
    console.log(`Bulk undo for unworked ones: Map → admin → Remove FCC leads (fcc-purge).`);
  } else {
    console.log(`\nRe-run with --apply to write.`);
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
