// ── Kinetic build state - projection, evidence history, map reads ────────────
//
// One row per address per tenant, carrying the verdict; one append-only row per
// piece of evidence that ever moved it. The classifier itself is pure and lives
// in shared/kineticBuild2026.ts - everything here is persistence, aggregation
// and the two read paths the field map needs.
//
// WHY THE BOUNDS ARE MAINTAINED INCREMENTALLY
// Classification needs the earliest conclusive fiber-live observation and the
// latest conclusive non-fiber one. Re-deriving those from the evidence ledger
// on every pass would turn a projector run into a table scan per address, so
// they are folded into the state row as evidence arrives. Both are monotonic
// (earliest only moves earlier, latest only moves later), which makes the
// update order-independent: a replayed or out-of-order observation converges to
// the same answer as a perfectly ordered one.

import { createHash } from "node:crypto";
import { rawDb } from "./db";
import { canonicalAddressPart, normalizeKineticAddressKey } from "./addressKey";
import { storage } from "./storage";
import { blockFactsFor, importedVintages } from "./fccImportStore";
import {
  PROXIMITY_RADIUS_M, haversineApproxM, rankBuilds,
} from "@shared/kineticBuildRanking";
import {
  classifyKineticBuild, paintTierFor, verificationAgeBucket,
  DEFAULT_LEAD_ELIGIBLE_CLASSES,
  type BuildConfidence, type FieldObservation, type KineticBuildClass,
  type KineticBuildDecision, type PlannedEvidence, type SuppressionReason,
} from "@shared/kineticBuild2026";

const iso = (ms: number) => new Date(ms).toISOString();
const msOf = (value: string | null | undefined) => (value ? Date.parse(value) : null);
const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

export interface AddressIdentity {
  tenantId: number;
  address: string;
  city: string;
  state?: string;
  zip?: string | null;
  unit?: string | null;
  lat?: number | null;
  lng?: number | null;
  blockGeoid?: string | null;
  countyFips?: string | null;
  residential?: boolean;
}

export interface BuildStateRow {
  id: number;
  tenantId: number;
  canonicalKey: string;
  address: string;
  city: string;
  state: string;
  zip: string | null;
  countyFips: string | null;
  blockGeoid: string | null;
  lat: number | null;
  lng: number | null;
  classification: KineticBuildClass;
  confidence: BuildConfidence;
  buildYear: number | null;
  quarterWhenProven: string | null;
  detectionFrom: string | null;
  detectionTo: string | null;
  firstObservedAt: string | null;
  firstConfirmedAt: string | null;
  lastVerifiedAt: string | null;
  firstFiberLiveAt: string | null;
  lastNonFiberAt: string | null;
  sources: string[];
  fccLocationIds: string[];
  fccFirstReportedVintage: string | null;
  maxDownMbps: number | null;
  maxUpMbps: number | null;
  leadId: number | null;
  suppressionReason: string | null;
  residential: boolean;
  stateVersion: number;
}

function hydrate(raw: any): BuildStateRow {
  const parse = (json: string): string[] => {
    try { const v = JSON.parse(json || "[]"); return Array.isArray(v) ? v.map(String) : []; }
    catch { return []; }
  };
  return {
    id: raw.id, tenantId: raw.tenant_id, canonicalKey: raw.canonical_key,
    address: raw.address, city: raw.city, state: raw.state, zip: raw.zip,
    countyFips: raw.county_fips, blockGeoid: raw.block_geoid,
    lat: raw.lat, lng: raw.lng,
    classification: raw.classification, confidence: raw.confidence,
    buildYear: raw.build_year, quarterWhenProven: raw.quarter_when_proven,
    detectionFrom: raw.detection_from, detectionTo: raw.detection_to,
    firstObservedAt: raw.first_observed_at, firstConfirmedAt: raw.first_confirmed_at,
    lastVerifiedAt: raw.last_verified_at,
    firstFiberLiveAt: raw.first_fiber_live_at, lastNonFiberAt: raw.last_non_fiber_at,
    sources: parse(raw.sources_json), fccLocationIds: parse(raw.fcc_location_ids_json),
    fccFirstReportedVintage: raw.fcc_first_reported_vintage,
    maxDownMbps: raw.max_down_mbps, maxUpMbps: raw.max_up_mbps,
    leadId: raw.lead_id, suppressionReason: raw.suppression_reason,
    residential: !!raw.residential, stateVersion: raw.state_version,
  };
}

/**
 * The street line including the unit, when there is one.
 *
 * ONE function computes this, and both the canonical key and the lead handed
 * to upsertLeadByAddress go through it. They must agree: if the build state
 * keys on "12 Oak St Apt 4" while the promoted lead keys on "12 Oak St", the
 * two records point at different premises, the lead_id back-reference lands on
 * the wrong door, and every unit in the building collapses onto one pin.
 */
export function fullStreet(address: string, unit?: string | null): string {
  const trimmed = (unit ?? "").trim();
  if (!trimmed) return address;
  // Idempotent: an address that already carries its unit is left alone, so a
  // caller passing "12 Oak St Apt 4" plus unit "Apt 4" does not become
  // "...Apt 4 Apt 4". Compared in CANONICAL form, because the designators need
  // not match textually - "12 Oak St #4" already carries unit "Apt 4", since
  // shared/addressKey.ts v4 folds every designator to the one UNIT token.
  const canonicalAddress = canonicalAddressPart(address);
  const canonicalUnit = canonicalAddressPart(trimmed);
  return canonicalUnit && canonicalAddress.endsWith(canonicalUnit)
    ? address
    : `${address} ${trimmed}`;
}

export function canonicalKeyFor(identity: AddressIdentity): string {
  // The SAME normalisation leads.canonical_key uses, so an address has one
  // identity across leads, scan targets and build state. Units stay distinct
  // (shared/addressKey.ts v4 folds every designator to UNIT but keeps the
  // value), and ZIP is deliberately excluded there, not here.
  return normalizeKineticAddressKey(
    fullStreet(identity.address, identity.unit),
    identity.city, identity.state ?? "NC", identity.zip ?? "",
  );
}

export function getBuildState(tenantId: number, canonicalKey: string): BuildStateRow | null {
  const raw = rawDb.prepare(
    `SELECT * FROM kinetic_build_state WHERE tenant_id = ? AND canonical_key = ?`,
  ).get(tenantId, canonicalKey) as any;
  return raw ? hydrate(raw) : null;
}

export function getBuildStateById(id: number): BuildStateRow | null {
  const raw = rawDb.prepare(`SELECT * FROM kinetic_build_state WHERE id = ?`).get(id) as any;
  return raw ? hydrate(raw) : null;
}

/** Create the row if this address is new, otherwise return the existing one.
 *  Coordinates and block attribution are filled in when they were missing but
 *  never overwritten - an expensive geocode is not discarded because a later,
 *  coarser source turned up. That rule is why the import can run repeatedly. */
export function ensureBuildState(identity: AddressIdentity): BuildStateRow {
  const canonicalKey = canonicalKeyFor(identity);
  const existing = getBuildState(identity.tenantId, canonicalKey);
  if (existing) {
    const patch: string[] = [];
    const params: unknown[] = [];
    const fill = (column: string, current: unknown, incoming: unknown) => {
      if ((current == null || current === "") && incoming != null && incoming !== "") {
        patch.push(`${column} = ?`); params.push(incoming);
      }
    };
    fill("lat", existing.lat, identity.lat);
    fill("lng", existing.lng, identity.lng);
    fill("block_geoid", existing.blockGeoid, identity.blockGeoid);
    fill("county_fips", existing.countyFips, identity.countyFips ?? identity.blockGeoid?.slice(0, 5));
    fill("zip", existing.zip, identity.zip);
    if (!patch.length) return existing;
    params.push(existing.id);
    rawDb.prepare(`UPDATE kinetic_build_state SET ${patch.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...params);
    return getBuildStateById(existing.id)!;
  }

  const countyFips = identity.countyFips ?? identity.blockGeoid?.slice(0, 5) ?? null;
  const info = rawDb.prepare(`
    INSERT INTO kinetic_build_state (
      tenant_id, canonical_key, address, unit, city, state, zip, county_fips,
      block_geoid, lat, lng, residential, first_observed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    identity.tenantId, canonicalKey, identity.address, identity.unit ?? null,
    identity.city, identity.state ?? "NC", identity.zip ?? null, countyFips,
    identity.blockGeoid ?? null, identity.lat ?? null, identity.lng ?? null,
    identity.residential === false ? 0 : 1,
  );
  return getBuildStateById(Number(info.lastInsertRowid))!;
}

export interface AuthorizedEvidenceInput {
  identity: AddressIdentity;
  /** true = serviceable fiber, false = conclusively not, null = no answer. */
  isFiberLive: boolean | null;
  conclusive: boolean;
  observedAtMs: number;
  billingStatus?: string | null;
  technology?: string | null;
  maxDownMbps?: number | null;
  maxUpMbps?: number | null;
  /** Pointer to the underlying fiber_checks / target_observations row. */
  reference?: string | null;
  /** Idempotency. Two deliveries of the same provider response collapse. */
  evidenceKey?: string;
}

export interface FieldEvidenceInput {
  identity: AddressIdentity;
  observation: FieldObservation;
  reference?: string | null;
  evidenceKey?: string;
}

/** Suppression and customer facts, sourced from the CRM rather than invented
 *  here. Passed in so this module never reaches into the DNC tables directly. */
export interface AddressPolicyFacts {
  suppression?: SuppressionReason | null;
  existingCustomer?: boolean;
  planned?: PlannedEvidence | null;
}

/** Record an authorized Kinetic qualification and re-classify the address. */
export function recordAuthorizedObservation(
  input: AuthorizedEvidenceInput,
  policy: AddressPolicyFacts = {},
): { state: BuildStateRow; decision: KineticBuildDecision; duplicate: boolean } {
  const state = ensureBuildState(input.identity);
  const key = input.evidenceKey
    ?? sha(`auth|${state.id}|${input.observedAtMs}|${String(input.isFiberLive)}|${input.conclusive}`);

  const already = rawDb.prepare(
    `SELECT id FROM kinetic_build_evidence WHERE tenant_id = ? AND evidence_key = ?`,
  ).get(state.tenantId, key) as any;

  // A non-answer is NOT a negative. It is recorded so the attempt is auditable,
  // but it never moves a bound and never downgrades a prior conclusive verdict.
  const conclusive = input.conclusive && input.isFiberLive != null;
  const observedIso = iso(input.observedAtMs);

  const apply = rawDb.transaction(() => {
    if (!already) {
      rawDb.prepare(`
        INSERT INTO kinetic_build_evidence (
          tenant_id, build_state_id, evidence_key, source, kind, observed_at,
          conclusive, detail_json, reference
        ) VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        state.tenantId, state.id, key, "authorized_kinetic_qualification",
        conclusive ? (input.isFiberLive ? "fiber_live" : "non_fiber") : "inconclusive",
        observedIso, conclusive ? 1 : 0,
        JSON.stringify({
          billingStatus: input.billingStatus ?? null,
          technology: input.technology ?? null,
          maxDownMbps: input.maxDownMbps ?? null,
          maxUpMbps: input.maxUpMbps ?? null,
        }),
        input.reference ?? null,
      );
    }
    if (!conclusive) return;

    // Monotonic bounds: MIN for the first live sighting, MAX for the last
    // non-fiber one. COALESCE handles the first write; the comparison makes a
    // late-arriving older observation harmless.
    if (input.isFiberLive) {
      rawDb.prepare(`
        UPDATE kinetic_build_state
           SET first_fiber_live_at = CASE
                 WHEN first_fiber_live_at IS NULL OR first_fiber_live_at > ? THEN ? ELSE first_fiber_live_at END,
               last_verified_at = CASE WHEN last_verified_at IS NULL OR last_verified_at < ? THEN ? ELSE last_verified_at END,
               last_verification_outcome = 'fiber_live',
               max_down_mbps = MAX(COALESCE(?, 0), COALESCE(max_down_mbps, 0)),
               max_up_mbps = MAX(COALESCE(?, 0), COALESCE(max_up_mbps, 0)),
               updated_at = datetime('now')
         WHERE id = ?
      `).run(observedIso, observedIso, observedIso, observedIso,
             input.maxDownMbps ?? null, input.maxUpMbps ?? null, state.id);
    } else {
      rawDb.prepare(`
        UPDATE kinetic_build_state
           SET last_non_fiber_at = CASE
                 WHEN last_non_fiber_at IS NULL OR last_non_fiber_at < ? THEN ? ELSE last_non_fiber_at END,
               last_verified_at = CASE WHEN last_verified_at IS NULL OR last_verified_at < ? THEN ? ELSE last_verified_at END,
               last_verification_outcome = 'non_fiber',
               updated_at = datetime('now')
         WHERE id = ?
      `).run(observedIso, observedIso, observedIso, observedIso, state.id);
    }
  });
  apply();

  // No `latest` override: reclassify reads the strongest evidence from the
  // ledger (see latestAuthorizedFor). Passing THIS observation in would make
  // an inconclusive delivery override a standing conclusive verdict.
  const decision = reclassify(state.tenantId, state.canonicalKey, policy);
  return { state: getBuildState(state.tenantId, state.canonicalKey)!, decision, duplicate: !!already };
}

/** Record a field sighting (construction, service confirmed, no service). */
export function recordFieldObservation(
  input: FieldEvidenceInput,
  policy: AddressPolicyFacts = {},
): { state: BuildStateRow; decision: KineticBuildDecision } {
  const state = ensureBuildState(input.identity);
  const key = input.evidenceKey
    ?? sha(`field|${state.id}|${input.observation.kind}|${input.observation.observedAtMs}`);
  rawDb.prepare(`
    INSERT OR IGNORE INTO kinetic_build_evidence (
      tenant_id, build_state_id, evidence_key, source, kind, observed_at,
      conclusive, detail_json, reference, recorded_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    state.tenantId, state.id, key, "field_verification", input.observation.kind,
    iso(input.observation.observedAtMs), 1,
    JSON.stringify({ note: input.observation.note ?? null }),
    input.reference ?? null, input.observation.verifiedByUserId ?? null,
  );
  const decision = reclassify(state.tenantId, state.canonicalKey, policy, { field: input.observation });
  return { state: getBuildState(state.tenantId, state.canonicalKey)!, decision };
}

interface ClassifyOverrides {
  latest?: import("@shared/kineticBuild2026").AuthorizedObservation | null;
  field?: FieldObservation | null;
}

/**
 * Re-run the classifier for one address and persist the verdict.
 *
 * The evidence itself is never rewritten - only the derived columns. That is
 * what makes a vintage revert safe: the projector recomputes from whatever
 * evidence still stands, and the history of what we once believed survives.
 */
export function reclassify(
  tenantId: number,
  canonicalKey: string,
  policy: AddressPolicyFacts = {},
  overrides: ClassifyOverrides = {},
): KineticBuildDecision {
  const state = getBuildState(tenantId, canonicalKey);
  if (!state) throw new Error(`No build state for ${canonicalKey}`);

  const latest = overrides.latest !== undefined ? overrides.latest : latestAuthorizedFor(state.id);
  const field = overrides.field !== undefined ? overrides.field : latestFieldFor(state.id);
  const fcc = blockFactsFor(tenantId, state.blockGeoid);

  const decision = classifyKineticBuild({
    latest,
    firstFiberLiveAtMs: msOf(state.firstFiberLiveAt),
    lastNonFiberAtMs: msOf(state.lastNonFiberAt),
    fcc,
    field,
    planned: policy.planned ?? null,
    suppression: policy.suppression ?? null,
    residential: state.residential,
    existingCustomer: policy.existingCustomer ?? false,
  }, DEFAULT_LEAD_ELIGIBLE_CLASSES);

  rawDb.prepare(`
    UPDATE kinetic_build_state
       SET classification = ?, confidence = ?, build_year = ?, quarter_when_proven = ?,
           detection_from = ?, detection_to = ?,
           sources_json = ?, suppression_reason = ?,
           fcc_location_ids_json = ?, fcc_first_reported_vintage = ?,
           first_confirmed_at = CASE
             WHEN ? = 'confirmed_2026' AND first_confirmed_at IS NULL THEN datetime('now')
             ELSE first_confirmed_at END,
           state_version = state_version + 1,
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    decision.classification, decision.confidence, decision.buildYear, decision.quarterWhenProven,
    decision.detectionWindow ? iso(decision.detectionWindow.fromMs) : null,
    decision.detectionWindow ? iso(decision.detectionWindow.toMs) : null,
    JSON.stringify(decision.sources), policy.suppression ?? null,
    JSON.stringify(fcc?.locationIds ?? []), fcc?.firstReportedVintage ?? null,
    decision.classification, state.id,
  );

  // Stamp the verdict onto the newest evidence row so the history reads as a
  // timeline of what each observation concluded, not just what arrived.
  rawDb.prepare(`
    UPDATE kinetic_build_evidence
       SET resulting_classification = ?, resulting_confidence = ?
     WHERE id = (SELECT id FROM kinetic_build_evidence WHERE build_state_id = ?
                  ORDER BY observed_at DESC, id DESC LIMIT 1)
  `).run(decision.classification, decision.confidence, state.id);

  return decision;
}

/**
 * The authorized observation classification should act on.
 *
 * The latest CONCLUSIVE one wins, not simply the latest one. A provider
 * timeout, throttle or schema drift is a non-answer, and letting it supersede
 * a conclusive reading would silently demote a confirmed build to unverified
 * every time the endpoint had a bad afternoon - the exact failure mode
 * shared/freshFiberVerdict.ts already refuses elsewhere in this codebase.
 *
 * Only when there has NEVER been a conclusive answer does the inconclusive row
 * surface, so a genuinely unanswerable address still reads as unverified
 * rather than as having no evidence at all.
 */
function latestAuthorizedFor(buildStateId: number): import("@shared/kineticBuild2026").AuthorizedObservation | null {
  const raw = (rawDb.prepare(`
    SELECT kind, observed_at, conclusive, detail_json
      FROM kinetic_build_evidence
     WHERE build_state_id = ? AND source = 'authorized_kinetic_qualification' AND conclusive = 1
     ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(buildStateId) ?? rawDb.prepare(`
    SELECT kind, observed_at, conclusive, detail_json
      FROM kinetic_build_evidence
     WHERE build_state_id = ? AND source = 'authorized_kinetic_qualification'
     ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(buildStateId)) as any;
  if (!raw) return null;
  let detail: any = {};
  try { detail = JSON.parse(raw.detail_json || "{}"); } catch { /* opaque payload */ }
  return {
    isFiberLive: raw.kind === "fiber_live" ? true : raw.kind === "non_fiber" ? false : null,
    conclusive: !!raw.conclusive,
    observedAtMs: Date.parse(raw.observed_at),
    billingStatus: detail.billingStatus ?? null,
    technology: detail.technology ?? null,
    maxDownMbps: detail.maxDownMbps ?? null,
    maxUpMbps: detail.maxUpMbps ?? null,
  };
}

function latestFieldFor(buildStateId: number): FieldObservation | null {
  const raw = rawDb.prepare(`
    SELECT kind, observed_at, recorded_by, detail_json
      FROM kinetic_build_evidence
     WHERE build_state_id = ? AND source = 'field_verification'
     ORDER BY observed_at DESC, id DESC LIMIT 1
  `).get(buildStateId) as any;
  if (!raw) return null;
  return {
    kind: raw.kind,
    observedAtMs: Date.parse(raw.observed_at),
    verifiedByUserId: raw.recorded_by ?? null,
  };
}

export interface EvidenceEntry {
  id: number;
  source: string;
  kind: string;
  observedAt: string;
  recordedAt: string;
  conclusive: boolean;
  resultingClassification: string | null;
  resultingConfidence: string | null;
  reference: string | null;
  detail: Record<string, unknown>;
}

/** The full history for one address, newest first. Never truncated by the
 *  projector - only by an explicit retention pass. */
export function evidenceHistory(buildStateId: number, limit = 200): EvidenceEntry[] {
  const rows = rawDb.prepare(`
    SELECT id, source, kind, observed_at, recorded_at, conclusive,
           resulting_classification, resulting_confidence, reference, detail_json
      FROM kinetic_build_evidence
     WHERE build_state_id = ?
     ORDER BY observed_at DESC, id DESC LIMIT ?
  `).all(buildStateId, Math.max(1, Math.min(1000, limit))) as any[];
  return rows.map((r) => {
    let detail: Record<string, unknown> = {};
    try { detail = JSON.parse(r.detail_json || "{}"); } catch { /* opaque */ }
    return {
      id: r.id, source: r.source, kind: r.kind,
      observedAt: r.observed_at, recordedAt: r.recorded_at,
      conclusive: !!r.conclusive,
      resultingClassification: r.resulting_classification,
      resultingConfidence: r.resulting_confidence,
      reference: r.reference, detail,
    };
  });
}

// ── Map read paths ───────────────────────────────────────────────────────────

export interface BuildMapFilters {
  classifications?: readonly KineticBuildClass[];
  confidences?: readonly BuildConfidence[];
  counties?: readonly string[];
  cities?: readonly string[];
  zips?: readonly string[];
  quarters?: readonly string[];
  /** fresh | aging | stale | never */
  verificationAge?: readonly string[];
  territoryId?: number | null;
  assignedRepId?: number | null;
  leadStatuses?: readonly string[];
}

export interface BuildMapWindow extends BuildMapFilters {
  minLat: number; minLng: number; maxLat: number; maxLng: number;
  limit?: number;
}

export interface BuildMapPin {
  id: number;
  lat: number;
  lng: number;
  classification: KineticBuildClass;
  confidence: BuildConfidence;
  tier: string;
  quarter: string | null;
  buildYear: number | null;
  leadId: number | null;
  leadStatus: string | null;
  assignedRepId: number | null;
  assignedTerritoryId: number | null;
  verificationAgeDays: number | null;
  address: string;
  city: string;
  zip: string | null;
}

/** SQL cap. Above this a window is answered as a density grid instead - the
 *  same honest-window contract the lead map already enforces (never a thinned
 *  sample presented as the whole truth). */
export const BUILD_WINDOW_ROW_CAP = 20_000;

function inList(column: string, values: readonly string[] | undefined, params: unknown[]): string {
  if (!values?.length) return "";
  params.push(...values);
  return ` AND ${column} IN (${values.map(() => "?").join(",")})`;
}

/**
 * Build the shared WHERE for both read paths.
 *
 * Verification age is expressed in SQL rather than filtered in JS so the row
 * cap means what it says: a window that returns 20k rows really did have 20k
 * matches, not 60k of which two thirds were dropped after the query.
 */
function windowPredicate(tenantId: number, filters: BuildMapFilters, params: unknown[]): string {
  let sql = `s.tenant_id = ? AND s.lat IS NOT NULL AND s.lng IS NOT NULL`;
  params.push(tenantId);
  sql += inList("s.classification", filters.classifications as string[] | undefined, params);
  sql += inList("s.confidence", filters.confidences as string[] | undefined, params);
  sql += inList("s.county_fips", filters.counties as string[] | undefined, params);
  sql += inList("s.city", filters.cities as string[] | undefined, params);
  sql += inList("s.zip", filters.zips as string[] | undefined, params);
  sql += inList("s.quarter_when_proven", filters.quarters as string[] | undefined, params);
  sql += inList("l.lead_status", filters.leadStatuses as string[] | undefined, params);

  if (filters.territoryId != null) { sql += ` AND l.assigned_territory_id = ?`; params.push(filters.territoryId); }
  if (filters.assignedRepId != null) { sql += ` AND l.assigned_rep_id = ?`; params.push(filters.assignedRepId); }

  const ages = filters.verificationAge ?? [];
  if (ages.length) {
    // julianday differences keep this an expression over the row rather than a
    // per-row JS date parse, and it uses the same day thresholds the shared
    // classifier does, so a pin's colour and its age chip cannot disagree.
    const clauses: string[] = [];
    for (const bucket of ages) {
      if (bucket === "never") clauses.push(`s.last_verified_at IS NULL`);
      if (bucket === "fresh") clauses.push(`(s.last_verified_at IS NOT NULL AND julianday('now') - julianday(s.last_verified_at) <= 30)`);
      if (bucket === "aging") clauses.push(`(s.last_verified_at IS NOT NULL AND julianday('now') - julianday(s.last_verified_at) > 30 AND julianday('now') - julianday(s.last_verified_at) <= 90)`);
      if (bucket === "stale") clauses.push(`(s.last_verified_at IS NOT NULL AND julianday('now') - julianday(s.last_verified_at) > 90)`);
    }
    if (clauses.length) sql += ` AND (${clauses.join(" OR ")})`;
  }
  return sql;
}

/** Exact count for a window. Cheap enough to run before the pin query, which
 *  is what lets the caller flip to the grid tier instead of shipping a sample. */
export function buildWindowCount(tenantId: number, window: BuildMapWindow): number {
  const params: unknown[] = [];
  const pred = windowPredicate(tenantId, window, params);
  params.push(window.minLat, window.maxLat, window.minLng, window.maxLng);
  const row = rawDb.prepare(`
    SELECT COUNT(*) AS n FROM kinetic_build_state s
      LEFT JOIN leads l ON l.id = s.lead_id
     WHERE ${pred} AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?
  `).get(...params) as any;
  return row.n;
}

export function buildWindowPins(tenantId: number, window: BuildMapWindow): BuildMapPin[] {
  const params: unknown[] = [];
  const pred = windowPredicate(tenantId, window, params);
  params.push(window.minLat, window.maxLat, window.minLng, window.maxLng);
  const limit = Math.max(1, Math.min(BUILD_WINDOW_ROW_CAP, window.limit ?? BUILD_WINDOW_ROW_CAP));
  params.push(limit);
  const rows = rawDb.prepare(`
    SELECT s.id, s.lat, s.lng, s.classification, s.confidence, s.quarter_when_proven AS quarter,
           s.build_year AS buildYear, s.lead_id AS leadId, s.address, s.city, s.zip,
           s.last_verified_at AS lastVerifiedAt,
           l.lead_status AS leadStatus, l.assigned_rep_id AS assignedRepId,
           l.assigned_territory_id AS assignedTerritoryId
      FROM kinetic_build_state s
      LEFT JOIN leads l ON l.id = s.lead_id
     WHERE ${pred} AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?
     LIMIT ?
  `).all(...params) as any[];

  const nowMs = Date.now();
  return rows.map((r) => {
    const ageDays = r.lastVerifiedAt == null ? null : Math.max(0, (nowMs - Date.parse(r.lastVerifiedAt)) / 86_400_000);
    return {
      id: r.id, lat: r.lat, lng: r.lng,
      classification: r.classification, confidence: r.confidence,
      tier: paintTierFor(r.classification, verificationAgeBucket(ageDays)),
      quarter: r.quarter, buildYear: r.buildYear,
      leadId: r.leadId, leadStatus: r.leadStatus ?? null,
      assignedRepId: r.assignedRepId ?? null, assignedTerritoryId: r.assignedTerritoryId ?? null,
      verificationAgeDays: ageDays == null ? null : Math.round(ageDays),
      address: r.address, city: r.city, zip: r.zip,
    };
  });
}

export interface BuildGridCell {
  lat: number; lng: number; count: number; confirmed: number;
}

/** The wide-zoom aggregate tier: exact counts bucketed on a lat/lng grid, over
 *  the SAME predicate the pin path uses, so zooming never changes which doors
 *  exist - only how they are drawn. */
export function buildGrid(
  tenantId: number,
  window: BuildMapWindow & { cell: number },
  limit = 5_000,
): BuildGridCell[] {
  const params: unknown[] = [];
  const pred = windowPredicate(tenantId, window, params);
  const cell = Math.max(0.001, window.cell);
  const rows = rawDb.prepare(`
    SELECT FLOOR(s.lat / ?) AS latBucket, FLOOR(s.lng / ?) AS lngBucket,
           COUNT(*) AS n,
           SUM(CASE WHEN s.classification = 'confirmed_2026' THEN 1 ELSE 0 END) AS confirmed
      FROM kinetic_build_state s
      LEFT JOIN leads l ON l.id = s.lead_id
     WHERE ${pred} AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?
     GROUP BY latBucket, lngBucket
     ORDER BY n DESC
     LIMIT ?
  `).all(cell, cell, ...params, window.minLat, window.maxLat, window.minLng, window.maxLng,
         Math.max(1, Math.min(20_000, limit))) as any[];
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return rows.map((r) => ({
    lat: round((r.latBucket + 0.5) * cell),
    lng: round((r.lngBucket + 0.5) * cell),
    count: r.n,
    confirmed: r.confirmed,
  }));
}

// ── Lead promotion ───────────────────────────────────────────────────────────

/** The tag every promoted door carries. Sits in the same family the map lens
 *  and the FCC purge already understand, but is deliberately NOT an `fcc_*`
 *  tag: these doors were confirmed by an authorized qualification, so the
 *  "verify at the door, this is only a filing" chip would be wrong on them. */
export const KINETIC_2026_LEAD_TAG = "kinetic_build_2026";

export interface PromotionResult {
  created: number;
  attached: number;
  skipped: number;
  leadIds: number[];
}

/**
 * Mint leads for confirmed 2026 builds.
 *
 * Eligibility is NOT re-derived here - it is read off the classification the
 * projector already wrote. That is the point: one place decides whether a door
 * is workable, and promotion is a mechanical consequence. A door that is
 * suppressed, an existing customer, unverified or merely likely never reaches
 * this function because it never classified as confirmed_2026.
 *
 * Deduplication rides the canonical key, so an address that already exists as
 * an organic lead, a scanner find or a prior FCC pin is ATTACHED to rather
 * than duplicated - upsertLeadByAddress computes the same key the UNIQUE index
 * enforces, and reports created:false when it found one.
 */
export function promoteConfirmedBuilds(
  tenantId: number,
  opts: { limit?: number; dryRun?: boolean } = {},
): PromotionResult {
  const limit = Math.max(1, Math.min(20_000, opts.limit ?? 5_000));
  const rows = rawDb.prepare(`
    SELECT * FROM kinetic_build_state
     WHERE tenant_id = ? AND classification = 'confirmed_2026'
       AND lead_id IS NULL AND lat IS NOT NULL AND lng IS NOT NULL
       AND residential = 1 AND suppression_reason IS NULL
     ORDER BY COALESCE(first_confirmed_at, created_at) DESC
     LIMIT ?
  `).all(tenantId, limit) as any[];

  const result: PromotionResult = { created: 0, attached: 0, skipped: 0, leadIds: [] };
  for (const raw of rows) {
    const state = hydrate(raw);
    if (opts.dryRun) { result.created++; continue; }
    try {
      const { lead, created } = storage.upsertLeadByAddress({
        // Unit included - see fullStreet(). The lead's canonical key must be
        // the SAME key this build state is filed under.
        address: fullStreet(state.address, raw.unit),
        city: state.city, state: state.state, zip: state.zip ?? "",
        lat: state.lat, lng: state.lng,
        tenantId,
        leadStatus: "prospect",
        leadTag: KINETIC_2026_LEAD_TAG,
        // DELIBERATELY NOT is_new_fiber / 'new_fiber' / fresh_fiber_confirmed.
        // Those belong to the independent-evidence projector, and the leads
        // fresh-guard triggers enforce that: setting them requires either two
        // cross-verified sources or Kinetic's own NEW FIBER + billing N
        // signal, with a source_scan_target_id behind it. This pipeline proves
        // something different - serviceable now, plus dated evidence it was
        // not before 2026 - so it gets its own tag and keeps its provenance in
        // kinetic_build_state, linked by lead_id. Reusing the fresh-fiber
        // fields would trip the guard and blur two evidence models into one.
        fiberStatus: "available",
        maxDownloadMbps: state.maxDownMbps ?? undefined,
        techType: "FTTP",
        notes: noteFor(state),
      } as any);
      rawDb.prepare(`UPDATE kinetic_build_state SET lead_id = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(lead.id, state.id);
      result.leadIds.push(lead.id);
      if (created) result.created++; else result.attached++;
    } catch (error: any) {
      // A single bad row must not abort a promotion run. The address stays
      // unpromoted and is picked up next pass once the cause is fixed.
      console.warn(`[kinetic2026] promotion failed for ${state.canonicalKey}:`, error?.message);
      result.skipped++;
    }
  }
  return result;
}

function noteFor(state: BuildStateRow): string {
  const parts = [
    `Kinetic fiber confirmed serviceable by authorized address qualification.`,
    state.quarterWhenProven
      ? `Build proven within ${state.quarterWhenProven}.`
      : state.detectionFrom && state.detectionTo
        ? `Build occurred between ${state.detectionFrom.slice(0, 10)} and ${state.detectionTo.slice(0, 10)} - quarter not established.`
        : `Build quarter not established.`,
  ];
  if (state.maxDownMbps) parts.push(`Reported up to ${state.maxDownMbps} Mbps down.`);
  if (state.lastVerifiedAt) parts.push(`Last verified ${state.lastVerifiedAt.slice(0, 10)}.`);
  return parts.join(" ");
}

/** Confirmed 2026 builds within `radiusM` of a point, excluding one id.
 *  Bounded by a bbox prefilter so the index does the work and the haversine
 *  only runs over the handful of rows already in the neighbourhood. */
export function nearbyConfirmedCount(
  tenantId: number, lat: number, lng: number, radiusM: number, excludeId?: number,
): number {
  const degLat = radiusM / 111_320;
  const degLng = radiusM / (111_320 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));
  const rows = rawDb.prepare(`
    SELECT id, lat, lng FROM kinetic_build_state
     WHERE tenant_id = ? AND classification = 'confirmed_2026'
       AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
  `).all(tenantId, lat - degLat, lat + degLat, lng - degLng, lng + degLng) as any[];
  let count = 0;
  for (const row of rows) {
    if (excludeId != null && row.id === excludeId) continue;
    if (haversineApproxM({ id: row.id, lat: row.lat, lng: row.lng }, { id: -1, lat, lng }) <= radiusM) count++;
  }
  return count;
}

export interface RankedBuild {
  id: number;
  leadId: number | null;
  address: string;
  city: string;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  classification: KineticBuildClass;
  confidence: BuildConfidence;
  quarterWhenProven: string | null;
  score: number;
  explanation: string[];
}

/** Ranked confirmed builds. The pool is capped before scoring so a statewide
 *  request can never pull an unbounded set into memory. */
export function rankedBuilds(
  tenantId: number,
  opts: { limit?: number; poolMax?: number; nowMs?: number; classifications?: readonly KineticBuildClass[] } = {},
): RankedBuild[] {
  const poolMax = Math.max(1, Math.min(5_000, opts.poolMax ?? 2_000));
  // Confirmed builds by default. Candidates are servable too, but only when
  // asked for explicitly - a caller that wants "the doors to knock" must not
  // silently receive unconfirmed ones mixed in with proven ones.
  const classes = opts.classifications?.length ? [...opts.classifications] : ["confirmed_2026"];
  // Vintage codes are chronologically ordered in JS and passed in as
  // parameters. They are NOT derived with MAX(vintage) in SQL: these codes
  // sort LEXICALLY there, where 'J25' > 'D25', so MAX would name June as the
  // newest filing and silently score every block against the wrong baseline.
  const vintages = importedVintages(tenantId);
  const latestVintage = vintages[vintages.length - 1] ?? null;
  const baselineVintage = vintages.length > 1 ? vintages[vintages.length - 2] : null;
  const rows = rawDb.prepare(`
    SELECT s.*, l.contact_phone AS phone, l.contact_email AS email, l.owner_name AS ownerName,
           (SELECT COUNT(*) FROM knock_log k WHERE k.lead_id = l.id) AS knockCount,
           (SELECT MAX(k.knocked_at) FROM knock_log k WHERE k.lead_id = l.id) AS lastKnockedAt,
           -- Build-front strength: the share of this block's premises Kinetic
           -- lit between the two most recent filings. Computed in SQL against
           -- the footprint so a candidate pool of thousands costs one pass.
           (SELECT CAST(f.kinetic_locations - COALESCE(p.kinetic_locations, 0) AS REAL)
                   / NULLIF(f.total_residential_locations, 0)
              FROM fcc_block_footprint f
              LEFT JOIN fcc_block_footprint p
                ON p.tenant_id = f.tenant_id AND p.block_geoid = f.block_geoid AND p.vintage = ?
             WHERE f.tenant_id = s.tenant_id AND f.block_geoid = s.block_geoid AND f.vintage = ?
          ) AS buildFrontStrength
      FROM kinetic_build_state s
      LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.tenant_id = ? AND s.classification IN (${classes.map(() => "?").join(",")})
     ORDER BY COALESCE(s.first_confirmed_at, s.created_at) DESC
     LIMIT ?
  `).all(baselineVintage, latestVintage, tenantId, ...classes, poolMax) as any[];

  const pool = rows.map((raw) => {
    const state = hydrate(raw);
    return {
      id: state.id,
      lat: state.lat, lng: state.lng,
      confidence: state.confidence,
      firstConfirmedAtMs: msOf(state.firstConfirmedAt),
      lastVerifiedAtMs: msOf(state.lastVerifiedAt),
      nearbyConfirmedCount: state.lat != null && state.lng != null
        ? nearbyConfirmedCount(tenantId, state.lat, state.lng, PROXIMITY_RADIUS_M, state.id)
        : 0,
      hasPhone: !!raw.phone, hasEmail: !!raw.email, hasOwnerName: !!raw.ownerName,
      knockCount: raw.knockCount ?? 0,
      lastKnockedAtMs: msOf(raw.lastKnockedAt),
      quarterProven: state.quarterWhenProven != null,
      buildFrontStrength: Number(raw.buildFrontStrength) || 0,
      _state: state,
    };
  });

  return rankBuilds(pool, opts.nowMs).slice(0, Math.max(1, Math.min(500, opts.limit ?? 100)))
    .map((entry) => {
      const state = (entry as any)._state as BuildStateRow;
      return {
        id: state.id, leadId: state.leadId,
        address: state.address, city: state.city, zip: state.zip,
        lat: state.lat, lng: state.lng,
        classification: state.classification, confidence: state.confidence,
        quarterWhenProven: state.quarterWhenProven,
        score: entry.score, explanation: entry.explanation,
      };
    });
}

/** Counts by classification for the layer's filter chips. */
export function buildSummary(tenantId: number, filters: BuildMapFilters = {}): Record<string, number> {
  const params: unknown[] = [];
  const pred = windowPredicate(tenantId, filters, params);
  const rows = rawDb.prepare(`
    SELECT s.classification AS c, COUNT(*) AS n
      FROM kinetic_build_state s
      LEFT JOIN leads l ON l.id = s.lead_id
     WHERE ${pred}
     GROUP BY s.classification
  `).all(...params) as any[];
  return Object.fromEntries(rows.map((r) => [r.c, r.n]));
}
