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

/**
 * Verified neighbours: conclusively-scanned targets on the same canonical
 * street AND in the same place.
 *
 * "Same street_key + same state" is NOT a neighbour relation. Measured on this
 * database: street_key 'S MAIN ST' in NC matches 414 scanned rows spread over
 * 14 different cities, and NOT ONE of them shares the ZIP of the Rockwell door
 * we were trying to repair; 'N MAIN ST' matches 304 rows over 11 cities, also
 * zero same-ZIP. Inferring a "verified city" from that pool relabelled 21
 * Rockwell doors as Norwood / Concord / High Point / Statesville while keeping
 * ZIP 28138 - city+ZIP pairs that do not exist, on doors that were correct
 * before the repair.
 *
 * So a neighbour must also be in the same PLACE. ZIP is the primary fence.
 * Proximity is the fallback for rows whose own ZIP is unusable (this table has
 * 533 rows whose ZIP was overwritten with the house number - '10540 US HWY 52'
 * stored under ZIP 10540, a New York prefix), because those are exactly the
 * rows a ZIP fence would silently exclude.
 *
 * NEAR_DEG is deliberately tight (~1 mile). A rural highway runs further than
 * that, so a long road yields fewer neighbours - correctly. Under-repairing is
 * free; a wrong repair corrupts a real address and then costs a paid check.
 */
const NEAR_DEG = 0.015;

function scannedNeighbours(c: RepairCandidate): Array<{ city: string; zip: string; address: string; lat: number | null; lng: number | null }> {
  if (!c.street_key) return [];
  const zip5 = normalizeZip5(c.zip);
  // A ZIP that repeats the house number is corruption, not a location.
  const houseNum = String(c.address ?? "").trim().split(/\s+/)[0] ?? "";
  const zipUsable = zip5 !== "" && zip5 !== houseNum;
  const place = zipUsable
    ? { clause: `AND substr(replace(COALESCE(zip,''),'-',''),1,5) = ?`, args: [zip5] }
    : (c.lat != null && c.lng != null)
      ? { clause: `AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
          args: [c.lat - NEAR_DEG, c.lat + NEAR_DEG, c.lng - NEAR_DEG, c.lng + NEAR_DEG] }
      : null;
  // No ZIP and no coordinates = no way to prove same-place. Refuse to guess.
  if (!place) return [];
  return rawDb.prepare(
    `SELECT city, zip, address, lat, lng FROM scan_targets
      WHERE street_key = ? AND upper(COALESCE(state,'')) = upper(COALESCE(?,''))
        AND last_scanned_at IS NOT NULL AND id <> ?
        ${place.clause}
      ORDER BY id LIMIT 40`,
  ).all(c.street_key, c.state ?? "", c.id, ...place.args) as any[];
}

const mode = (values: string[]): string | null => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | null = null, bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
};

/** True when no token in this street spelling gets folded by the canonical
 *  alias map — i.e. it is already the form Kinetic and our street_key use. */
const isCanonicalSpelling = (street: string): boolean => {
  const plain = String(street).toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  return plain !== "" && plain === canonicalAddressPart(street);
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
  // 3. Suffix variant — move TOWARDS the canonical spelling, never away from it.
  //
  // The original rule adopted the first neighbour's spelling whatever it was.
  // On the Rockwell cohort that rewrote 25 doors from "1009 Quail Haven Dr" to
  // "1009 Quail Haven Drive" — backwards. Kinetic canonicalizes street types to
  // abbreviations (scanner.ts adopts data.address.addressLine1 for exactly that
  // reason), and shared/addressKey folds DRIVE→DR, HIGHWAY→HWY, so the
  // abbreviated form is both our canonical key and Kinetic's own output form.
  // Expanding it makes a match strictly less likely.
  //
  // A repair is therefore only available when OUR spelling is the non-canonical
  // one. The replacement is the modal spelling among neighbours that are
  // themselves canonical — modal, like the city and ZIP rules above, so one odd
  // neighbour cannot decide it.
  const ourStreet = String(c.address).trim().split(/\s+/).slice(1).join(" ");
  if (ourStreet && !isCanonicalSpelling(ourStreet)) {
    const canonicalNeighbourStreets = neighbours
      .filter((n) => streetKeyOf(n.address) === c.street_key)
      .map((n) => String(n.address).trim().split(/\s+/).slice(1).join(" "))
      .filter((st) => st && isCanonicalSpelling(st));
    const theirStreet = mode(canonicalNeighbourStreets);
    if (theirStreet && theirStreet.toUpperCase() !== ourStreet.toUpperCase()) {
      return {
        code: "SUFFIX_VARIANT",
        patch: { address: `${houseNum} ${theirStreet}` },
        detail: `street spelling "${ourStreet}" -> canonical "${theirStreet}"`
          + ` (${canonicalNeighbourStreets.length} verified neighbours use it)`,
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
  /** Unrepairable but still inside the park ladder — left alone, not parked. */
  skipped: number;
  byCode: Record<string, number>; halted: string | null;
}

/**
 * Candidates named by id. Same eligibility rules as the scheduled batch minus
 * the park threshold, which is the caller's job to justify: still unanswered,
 * still kinetic, still never repaired. A row that already has an answer or a
 * repair_code is silently skipped, so re-running a cohort is a no-op.
 */
export function targetsById(ids: number[]): RepairCandidate[] {
  const out: RepairCandidate[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    out.push(...rawDb.prepare(
      `SELECT id, address, city, state, zip, lat, lng, street_key FROM scan_targets
        WHERE id IN (${chunk.map(() => "?").join(",")})
          AND last_scanned_at IS NULL
          AND repair_code IS NULL
          AND COALESCE(carrier,'kinetic')='kinetic'
        ORDER BY id ASC`,
    ).all(...chunk) as RepairCandidate[]);
  }
  return out;
}

/**
 * The per-row decision + write, shared by every entry point so a scheduled pass
 * and an operator-driven cohort pass can never drift apart.
 */
function repairBatch(batch: RepairCandidate[], opts: { quarantine: boolean } = { quarantine: true }): RepairRunResult {
  const result: RepairRunResult = { examined: 0, repaired: 0, quarantined: 0, skipped: 0, byCode: {}, halted: null };
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
        // Quarantine is PERMANENT — the row leaves the scan rotation for good.
        // That is only defensible once the escalating park ladder has actually
        // finished with the address. A row still inside the ladder is due
        // another re-probe (fabric imports DO add streets), and "our own table
        // has no verified neighbour" is absence of evidence, not a bad address.
        if (!opts.quarantine) { result.skipped++; continue; }
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
      // A repair that cannot be WRITTEN must still leave the row terminal.
      // Rewriting an address onto one that already exists trips
      // idx_scan_targets_addr_city_state; the original code logged and moved
      // on WITHOUT setting repair_code, so the row stayed a candidate and every
      // later pass re-planned the same doomed UPDATE forever - the unbounded
      // retry this lane exists to end. Mark it for review instead.
      const detail = `repair ${plan.code} could not be applied: ${String(e?.message ?? e).slice(0, 120)}`;
      try {
        quarantine.run({ id: c.id, code: "UNREPAIRABLE", detail });
        result.quarantined++;
        result.byCode[plan.code] = (result.byCode[plan.code] ?? 1) - 1;
        result.byCode.UNREPAIRABLE = (result.byCode.UNREPAIRABLE ?? 0) + 1;
      } catch { /* the marker itself failed — leave it for the next pass */ }
      structuredLog("address_repair.row_failed", { id: c.id, code: plan.code, error: String(e?.message ?? e).slice(0, 120) }, "warn");
    }
  }
  return result;
}

/**
 * One bounded pass. Repairable rows are corrected and re-armed (attempts → 0)
 * so they scan ONCE more with the fixed address; unrepairable rows are marked
 * ADDRESS_REVIEW and leave the rotation for good. Single-writer, one
 * transaction per row, sentinel-aware.
 */
export function runAddressRepairPass(limit = 500): RepairRunResult {
  ensureRepairSchema();
  const result = repairBatch(terminalParkedBatch(limit));
  structuredLog("address_repair.pass", { ...result, byCode: JSON.stringify(result.byCode) },
    result.halted ? "warn" : "info");
  return result;
}

/**
 * OPERATOR-DRIVEN COHORT PASS — repair exactly the addresses named, using the
 * same planner and the same writes as the scheduled pass.
 *
 * The scheduled pass only ever sees rows that survived unanswered to
 * `INCONCLUSIVE_GIVEUP + ANF_PARK_MAX_GENERATIONS + 1` attempts. In practice
 * almost nothing does: `ANF_TERMINAL_ATTEMPTS` (server/scanEngine.ts) concludes
 * an address at 6, so the park ladder terminates below the repair lane's floor
 * and its candidate query stays empty while real stuck inventory piles up at 3
 * and 4 attempts. Until those two thresholds are reconciled, this is how the
 * repair lane reaches a run's stuck tail: name the ids, repair once, re-scan
 * what got corrected.
 *
 * Cohort membership is the caller's evidence, not a threshold — but every other
 * guard the scheduled pass relies on still applies, so this can neither
 * double-repair a row nor touch an address that already has an answer.
 */
export function runAddressRepairForTargets(ids: number[], opts: { quarantine?: boolean } = {}): RepairRunResult {
  ensureRepairSchema();
  // Default OFF for a cohort: the caller named these rows from a run's stuck
  // tail, which says nothing about whether their park ladder is exhausted.
  // Repair what we can prove; leave the rest to the ladder that already owns
  // their re-probe schedule.
  const result = repairBatch(targetsById(ids), { quarantine: opts.quarantine === true });
  structuredLog("address_repair.cohort", {
    ...result, requested: ids.length, byCode: JSON.stringify(result.byCode),
  }, result.halted ? "warn" : "info");
  return result;
}
