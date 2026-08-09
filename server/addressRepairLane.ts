/**
 * ADDRESS REPAIR LANE — what happens to a terminally-parked address.
 *
 * The escalating park window (@shared/scanPolicy) stops 285k unrecognized
 * addresses from re-cycling forever, but "stop retrying" is only half an
 * answer: many of those addresses are REAL homes whose stored spelling Kinetic
 * simply doesn't match (a Mapbox-seeded "1315 Stonewyck Drive" filed under the
 * wrong postal city, a missing ZIP, a suffix variant). Recycling them wastes
 * proxy checks; repairing them turns them into scannable inventory.
 *
 * This lane repairs from OUR OWN data only — canonical aliases plus the
 * verified neighbours already in scan_targets. No Mapbox calls, so the spend
 * governor is untouched by construction.
 *
 * Repair codes (stored for audit + ops):
 *   POSTAL_CITY_ALIAS — a conclusively-scanned twin on the same street sits
 *                       under a different city; adopt the verified city.
 *   ZIP_MISSING       — blank ZIP; adopt the ZIP its scanned street neighbours
 *                       agree on.
 *   SUFFIX_VARIANT    — stored suffix differs from the canonical form its
 *                       scanned neighbours use ("Drive" vs "Dr").
 *   GEOCODE_MISMATCH  — coordinates sit far from every neighbour on its street.
 *   UNIT_AMBIGUOUS    — a malformed unit clause.
 *   UNREPAIRABLE      — nothing in our data can fix it → ADDRESS_REVIEW, and it
 *                       never re-enters the scan rotation.
 *
 * A repaired address gets inconclusive_attempts reset to 0, so it re-enters the
 * rotation exactly ONCE with the corrected spelling. If it fails again it
 * re-parks and re-escalates — it can never loop.
 */
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import { readPressure, PRESSURE_ORDER } from "./resourcePressure";
import { INCONCLUSIVE_GIVEUP, ANF_PARK_MAX_GENERATIONS } from "@shared/scanPolicy";
import { canonicalAddressPart, normalizeZip5, streetKeyOf } from "@shared/addressKey";

export type RepairCode =
  | "POSTAL_CITY_ALIAS" | "ZIP_MISSING" | "SUFFIX_VARIANT"
  | "GEOCODE_MISMATCH" | "UNIT_AMBIGUOUS" | "UNREPAIRABLE";

const TERMINAL_ATTEMPTS = INCONCLUSIVE_GIVEUP + ANF_PARK_MAX_GENERATIONS + 1;

export function ensureRepairSchema(): void {
  const cols = new Set(
    (rawDb.prepare(`PRAGMA table_xinfo(scan_targets)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!cols.has("repair_code")) rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN repair_code TEXT`);
  if (!cols.has("repaired_at")) rawDb.exec(`ALTER TABLE scan_targets ADD COLUMN repaired_at TEXT`);
}

export interface RepairCandidate {
  id: number; address: string; city: string | null; state: string | null;
  zip: string | null; lat: number | null; lng: number | null; street_key: string | null;
}

/** Terminally-parked addresses that have not yet been through the lane. */
export function terminalParkedBatch(limit: number): RepairCandidate[] {
  return rawDb.prepare(
    `SELECT id, address, city, state, zip, lat, lng, street_key FROM scan_targets
      WHERE last_scanned_at IS NULL
        AND inconclusive_attempts >= ?
        AND repair_code IS NULL
        AND COALESCE(carrier,'kinetic')='kinetic'
      ORDER BY id ASC LIMIT ?`,
  ).all(TERMINAL_ATTEMPTS, limit) as RepairCandidate[];
}

/** Verified neighbours: conclusively-scanned targets on the same canonical street. */
function scannedNeighbours(c: RepairCandidate): Array<{ city: string; zip: string; address: string; lat: number | null; lng: number | null }> {
  if (!c.street_key) return [];
  return rawDb.prepare(
    `SELECT city, zip, address, lat, lng FROM scan_targets
      WHERE street_key = ? AND upper(COALESCE(state,'')) = upper(COALESCE(?,''))
        AND last_scanned_at IS NOT NULL AND id <> ?
      LIMIT 40`,
  ).all(c.street_key, c.state ?? "", c.id) as any[];
}

const mode = (values: string[]): string | null => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
};

export interface RepairPlan {
  code: RepairCode;
  patch: { city?: string; zip?: string; address?: string };
  detail: string;
}

/**
 * Decide the repair from verified neighbours. PURE — no DB writes, so it is
 * fully testable and the caller owns the single-writer transaction.
 */
export function planRepair(c: RepairCandidate, neighbours: ReturnType<typeof scannedNeighbours>): RepairPlan {
  const houseNum = String(c.address ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^\d+[A-Za-z]?$/.test(houseNum)) {
    return { code: "UNREPAIRABLE", patch: {}, detail: "no house number to anchor a premise" };
  }
  if (/\bUNIT\b/.test(canonicalAddressPart(c.address)) && !/\d/.test(canonicalAddressPart(c.address).split(" UNIT ")[1] ?? "")) {
    return { code: "UNIT_AMBIGUOUS", patch: {}, detail: "unit designator without a unit value" };
  }
  if (!neighbours.length) {
    return { code: "UNREPAIRABLE", patch: {}, detail: "no conclusively-scanned neighbour on this street" };
  }

  // 1. Postal-city alias — neighbours agree on a DIFFERENT city than ours.
  const nCity = mode(neighbours.map((n) => String(n.city ?? "").trim()).filter(Boolean));
  if (nCity && canonicalAddressPart(nCity) !== canonicalAddressPart(c.city ?? "")) {
    return { code: "POSTAL_CITY_ALIAS", patch: { city: nCity }, detail: `street verified under "${nCity}", stored as "${c.city ?? ""}"` };
  }
  // 2. Missing ZIP — adopt the neighbours' agreed ZIP.
  const nZip = mode(neighbours.map((n) => normalizeZip5(n.zip)).filter(Boolean));
  if (!normalizeZip5(c.zip) && nZip) {
    return { code: "ZIP_MISSING", patch: { zip: nZip }, detail: `adopted ZIP ${nZip} from ${neighbours.length} scanned neighbours` };
  }
  // 3. Suffix variant — rewrite our street portion to the neighbours' spelling.
  const nAddr = neighbours.find((n) => streetKeyOf(n.address) === c.street_key && n.address);
  if (nAddr) {
    const theirStreet = String(nAddr.address).trim().split(/\s+/).slice(1).join(" ");
    const ourStreet = String(c.address).trim().split(/\s+/).slice(1).join(" ");
    if (theirStreet && ourStreet && theirStreet.toUpperCase() !== ourStreet.toUpperCase()) {
      return {
        code: "SUFFIX_VARIANT",
        patch: { address: `${houseNum} ${theirStreet}` },
        detail: `street spelling "${ourStreet}" -> verified "${theirStreet}"`,
      };
    }
  }
  // 4. Geocode mismatch — our point is far from every scanned neighbour.
  const pts = neighbours.filter((n) => n.lat != null && n.lng != null);
  if (c.lat != null && c.lng != null && pts.length >= 3) {
    const near = pts.some((n) => Math.abs(n.lat! - c.lat!) < 0.01 && Math.abs(n.lng! - c.lng!) < 0.01);
    if (!near) return { code: "GEOCODE_MISMATCH", patch: {}, detail: "coordinates far from every scanned neighbour on this street" };
  }
  return { code: "UNREPAIRABLE", patch: {}, detail: "neighbours match the stored address; Kinetic simply does not serve it" };
}

export interface RepairRunResult {
  examined: number; repaired: number; quarantined: number;
  byCode: Record<string, number>; halted: string | null;
}

/**
 * One bounded pass. Repairable rows are corrected and re-armed (attempts → 0)
 * so they scan ONCE more with the fixed address; unrepairable rows are marked
 * ADDRESS_REVIEW and leave the rotation for good. Single-writer, one
 * transaction per row, sentinel-aware.
 */
export function runAddressRepairPass(limit = 500): RepairRunResult {
  const result: RepairRunResult = { examined: 0, repaired: 0, quarantined: 0, byCode: {}, halted: null };
  ensureRepairSchema();
  const batch = terminalParkedBatch(limit);
  if (!batch.length) return result;

  const applyRepair = rawDb.prepare(
    `UPDATE scan_targets SET
       address = COALESCE(@address, address),
       city    = COALESCE(@city, city),
       zip     = COALESCE(@zip, zip),
       inconclusive_attempts = 0,
       last_inconclusive_at = NULL,
       repair_code = @code,
       repaired_at = datetime('now')
     WHERE id = @id`);
  const quarantine = rawDb.prepare(
    `UPDATE scan_targets SET repair_code = @code, repaired_at = datetime('now'),
       address_review_reason = @detail WHERE id = @id`);

  for (const c of batch) {
    if (PRESSURE_ORDER[readPressure().level] >= PRESSURE_ORDER.pause) { result.halted = "resource_pressure"; break; }
    result.examined++;
    const plan = planRepair(c, scannedNeighbours(c));
    result.byCode[plan.code] = (result.byCode[plan.code] ?? 0) + 1;
    try {
      if (plan.code === "UNREPAIRABLE" || plan.code === "UNIT_AMBIGUOUS" || plan.code === "GEOCODE_MISMATCH") {
        quarantine.run({ id: c.id, code: plan.code, detail: plan.detail });
        result.quarantined++;
      } else {
        applyRepair.run({
          id: c.id, code: plan.code,
          address: plan.patch.address ?? null, city: plan.patch.city ?? null, zip: plan.patch.zip ?? null,
        });
        result.repaired++;
      }
    } catch (e: any) {
      structuredLog("address_repair.row_failed", { id: c.id, error: String(e?.message ?? e).slice(0, 120) }, "warn");
    }
  }
  structuredLog("address_repair.pass", { ...result, byCode: JSON.stringify(result.byCode) },
    result.halted ? "warn" : "info");
  return result;
}
