// ── Replay Kinetic verdicts into production, as pins ─────────────────────────
//
// A scan that never reaches the field map has not done anything. Verdicts
// gathered off-box live in scan-verdicts-*.json beside this script; this
// replays each one through persistKineticObservation, which is the same
// function the live scanner calls. That means the door gets:
//
//   - an availability snapshot (the audit trail for the verdict),
//   - scan_targets stamped with the answer, which under SCAN_ONCE_ONLY takes it
//     out of the never-scanned rotation so it is never bought a second time,
//   - and, for NEW FIBER + billing N, a lead from the fresh-fiber projector,
//     which is the thing that shows up as a green pin.
//
// Doors are matched by canonical address key, never by row id: the ids in the
// source database have nothing to do with production's. An address production
// has never seen is created; one it already has is attached to and left
// otherwise alone.
//
// NEVER CLOBBERS A FRESHER ANSWER. If production already answered a door AFTER
// the verdict being replayed, the verdict is skipped. A stale import silently
// overwriting live data is the one failure mode that would be hard to notice
// and hard to undo.
//
// DRY RUN IS THE DEFAULT. --apply writes.
import fs from "node:fs";
import path from "node:path";

type Verdict = {
  address: string; city: string; state: string; zip?: string;
  lat?: number | null; lng?: number | null;
  fiberStatus: string; isNewFiber: boolean; billingStatus: string | null;
  fiberAvailable: boolean; householdSegmentType: string | null; scannedAt: string;
};

function loadVerdicts(): Verdict[] {
  const here = path.dirname(process.argv[1] ?? ".");
  const named = process.argv.includes("--file")
    ? process.argv[process.argv.indexOf("--file") + 1]
    : null;
  const candidates = named ? [named] : [
    path.join(here, "scan-verdicts-nc-2026-08.json"),
    path.join(here, "..", "script", "scan-verdicts-nc-2026-08.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const rows = JSON.parse(fs.readFileSync(p, "utf8"));
      console.log(`Loaded ${rows.length.toLocaleString()} verdicts from ${p}`);
      return rows;
    }
  }
  throw new Error(`No verdict file found. Looked in: ${candidates.join(", ")}`);
}

(async () => {
  const argv = process.argv.slice(2);
  const APPLY = argv.includes("--apply");
  const ti = argv.indexOf("--tenant");
  const TENANT = ti >= 0 ? Number(argv[ti + 1]) : NaN;
  if (!Number.isInteger(TENANT) || TENANT <= 0) {
    console.error("Usage: import-scan-verdicts --tenant <id> [--apply] [--file <path>]");
    process.exit(2);
  }
  const verdicts = loadVerdicts();
  const { rawDb } = await import("../server/db");
  const { persistKineticObservation } = await import("../server/kineticObservation");
  const { normalizeKineticAddressKey } = await import("../shared/addressKey");

  console.log(`tenant ${TENANT}   mode ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}`);

  const leadsBefore = (rawDb.prepare(
    `SELECT COUNT(*) c FROM leads WHERE tenant_id = ?`).get(TENANT) as any).c;

  // Mirror persistKineticObservation's OWN resolution order exactly, or the
  // dry-run report lies about what the apply would do. It resolves on the full
  // identity (address + city + state) first and falls back to the canonical
  // key; a canonical-key-only pre-check reported 5,360 of 5,446 verdicts as
  // brand-new addresses when nearly all of them already existed, because
  // canonical_key is NULL on most rows.
  const byIdentity = rawDb.prepare(
    `SELECT id, last_scanned_at FROM scan_targets
      WHERE lower(trim(address))=lower(trim(?)) AND lower(trim(city))=lower(trim(?))
        AND upper(trim(state))=upper(trim(?)) LIMIT 1`);
  const byCanonical = rawDb.prepare(
    `SELECT id, last_scanned_at FROM scan_targets WHERE tenant_id IS ? AND canonical_key = ? LIMIT 1`);

  let attached = 0, wouldCreate = 0, skippedFresher = 0, skippedBad = 0, applied = 0, failed = 0;
  let sellable = 0;

  for (const v of verdicts) {
    if (!v.address?.trim() || !v.city?.trim() || !v.state?.trim()) { skippedBad++; continue; }
    const key = normalizeKineticAddressKey(v.address, v.city, v.state, v.zip ?? "");
    const row = (byIdentity.get(v.address, v.city, v.state) as any)
      ?? (key ? (byCanonical.get(TENANT, key) as any) : null);
    if (row) {
      // Production's own answer wins when it is newer than the one being replayed.
      if (row.last_scanned_at && String(row.last_scanned_at) > String(v.scannedAt)) {
        skippedFresher++;
        continue;
      }
      attached++;
    } else {
      wouldCreate++;
    }
    if (v.fiberStatus === "new_fiber" && v.billingStatus === "N") sellable++;
    if (!APPLY) continue;
    try {
      persistKineticObservation({
        tenantId: TENANT,
        source: "import-scan-verdicts",
        observation: {
          address: v.address, city: v.city, state: v.state, zip: v.zip ?? "",
          lat: v.lat ?? null, lng: v.lng ?? null,
          fiberStatus: v.fiberStatus,
          fiberAvailable: !!v.fiberAvailable,
          isNewFiber: !!v.isNewFiber,
          billingStatus: v.billingStatus ?? undefined,
          householdSegmentType: v.householdSegmentType ?? undefined,
        } as any,
      });
      applied++;
      if (applied % 500 === 0) console.log(`  ...${applied.toLocaleString()} written`);
    } catch (e: any) {
      failed++;
      if (failed <= 10) console.error(`  FAILED ${v.address}, ${v.city}: ${String(e?.message ?? e).slice(0, 140)}`);
    }
  }

  // A verdict only mints a pin when it CHANGES the door's state - the projector
  // runs off the transition. A door production already knew was NEW FIBER but
  // never turned into a lead produces no transition and therefore no pin, and
  // measured on a production-shaped copy that was 525 of 1,333 sellable doors.
  // The full-tenant sweep is the same one FRESH_LEAD_BOOT_BACKFILL runs at boot
  // and it picks up exactly those, so the import ends by asking for it.
  let swept = 0;
  if (APPLY) {
    try {
      const { projectConfirmedFreshLeads } = await import("../server/freshFiberProjector");
      const r = projectConfirmedFreshLeads(TENANT);
      swept = r.created;
      console.log(`  projector sweep: considered ${r.considered.toLocaleString()}, confirmed ${r.confirmed.toLocaleString()}, created ${r.created.toLocaleString()}, linked ${r.linkedExisting.toLocaleString()}`);
    } catch (e: any) {
      console.error(`  projector sweep FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }

  const leadsAfter = (rawDb.prepare(
    `SELECT COUNT(*) c FROM leads WHERE tenant_id = ?`).get(TENANT) as any).c;

  console.log("");
  console.log(`verdicts               ${verdicts.length.toLocaleString()}`);
  console.log(`  attach to existing   ${attached.toLocaleString()}`);
  console.log(`  new addresses        ${wouldCreate.toLocaleString()}`);
  console.log(`  skipped, prod newer  ${skippedFresher.toLocaleString()}`);
  console.log(`  skipped, unusable    ${skippedBad.toLocaleString()}`);
  console.log(`  sellable in this set ${sellable.toLocaleString()}  (NEW FIBER + billing N)`);
  if (APPLY) {
    console.log(`  written              ${applied.toLocaleString()}   failed ${failed}`);
    console.log(`  leads ${leadsBefore.toLocaleString()} -> ${leadsAfter.toLocaleString()}  (+${(leadsAfter - leadsBefore).toLocaleString()} pins, ${swept.toLocaleString()} of them from the sweep)`);
  } else {
    console.log("");
    console.log("DRY RUN - nothing was written. Re-run with --apply to write.");
  }
  process.exit(failed > 0 && APPLY ? 1 : 0);
})().catch((e) => { console.error("IMPORT FAILED:", e); process.exit(1); });
