// ── Kinetic build classification - one address, one honest verdict ───────────
//
// Pure, deterministic, side-effect free (nowMs is injected), so the whole
// classification contract is unit-testable without a database or a network.
//
// THE TWO THINGS THIS FILE REFUSES TO DO
//
// 1. Convert a plan into a fact. An announcement, a construction permit, a
//    city-level "Kinetic is coming to X" page and a half-built census block
//    are all evidence that something MIGHT happen. None of them can produce
//    confirmed_2026. The only path to confirmed_2026 runs through a conclusive
//    address-level authorized qualification.
//
// 2. Guess a quarter. quarterWhenProven is null unless a dated evidence window
//    fits entirely inside one calendar quarter (shared/fccVintage.ts). A
//    biannual FCC diff never does, so FCC-derived rows carry a null quarter
//    forever, and that is the correct answer rather than a missing one.
//
// PRECEDENCE, highest first. Each rule is a reason a lower rule can never be
// reached, which is why the order is written out rather than scored:
//
//   suppressed          you are not permitted to work this door, full stop
//   existing_customer   there is no sale here
//   not_serviceable     our own conclusive address-level check said no
//   confirmed_2026      conclusive fiber-live AND a dated pre-2026 lower bound
//   existing_fiber      conclusive fiber-live, but it predates 2026
//   reported_2026       an FCC filing that CAN attest to 2026 newly reports it
//   construction_observed  a person verified construction at this address
//   likely_2026         partially-built block Kinetic was actively extending
//   planned             official market evidence only
//   unverified          nothing conclusive yet
//
// Address-level evidence always outranks block-level evidence: a conclusive
// qualification for THIS door beats what the FCC says about its census block,
// because a block contains premises we did not ask about.

import {
  additionWindow, vintageAsOfMs, windowQuarter, windowYear,
  type CalendarQuarter, type DetectionWindow, type FccVintageCode,
} from "./fccVintage";

/**
 * The 10 states an address can be in.
 *
 * `existing_fiber` is an addition to the nine originally specified. Those nine
 * had no slot for "Kinetic FTTP live since before 2026, household is not a
 * subscriber" - a real and common case, a legitimate sales target, and the one
 * the field map paints gray as "older Kinetic fiber". Folding it into
 * existing_customer would assert a subscription we have no evidence for, and
 * folding it into not_serviceable would assert the opposite of what we
 * observed, so it gets its own name.
 */
export type KineticBuildClass =
  | "confirmed_2026"
  | "reported_2026"
  | "likely_2026"
  | "construction_observed"
  | "planned"
  | "unverified"
  | "not_serviceable"
  | "existing_customer"
  | "existing_fiber"
  | "suppressed";

export const KINETIC_BUILD_CLASSES: readonly KineticBuildClass[] = [
  "confirmed_2026", "reported_2026", "likely_2026", "construction_observed",
  "planned", "unverified", "not_serviceable", "existing_customer",
  "existing_fiber", "suppressed",
] as const;

export type BuildConfidence = "high" | "medium" | "low" | "none";

/** Why an address may not become a lead. Mirrors the suppression sources the
 *  CRM already enforces so this classifier never invents a new one. */
export type SuppressionReason =
  | "dnc" | "do_not_knock" | "out_of_territory" | "unauthorized_market"
  | "competitor" | "scope" | "non_residential";

/** A single authorized Kinetic address-level qualification result. */
export interface AuthorizedObservation {
  /** true = fiber serviceable, false = conclusively not, null = no usable answer. */
  isFiberLive: boolean | null;
  /** false when the provider timed out, throttled, or drifted schema. A
   *  non-answer is never a negative - it stays recheckable. */
  conclusive: boolean;
  observedAtMs: number;
  /** Kinetic billing status. "N" = no active subscriber at this address. */
  billingStatus?: string | null;
  technology?: string | null;
  maxDownMbps?: number | null;
  maxUpMbps?: number | null;
}

/** What the imported FCC vintages say about this address's census block.
 *  Block-level by necessity: BDC availability files carry location_id and
 *  block_geoid but no addresses, and the address-level fabric is licensed. */
export interface FccBlockFacts {
  blockGeoid: string | null;
  /** Oldest imported vintage reporting Kinetic residential FTTP in this block. */
  firstReportedVintage: FccVintageCode | null;
  /** Newest vintage imported (the current side of the diff). */
  latestVintage: FccVintageCode | null;
  /** The vintage the latest one is diffed against. */
  baselineVintage: FccVintageCode | null;
  /** Kinetic residential FTTP locations reported in the block at latestVintage. */
  reportedLocations: number;
  /** Residential BDC locations in the block, all providers - the denominator. */
  totalLocations: number;
  /** Kinetic locations present at latestVintage and absent at baselineVintage. */
  addedLocations: number;
  /** FCC fabric location ids attributed to this block. Stored for provenance;
   *  binding one to a street address needs a fabric licence we do not hold. */
  locationIds?: readonly string[];
  maxDownMbps?: number | null;
}

export interface FieldObservation {
  kind: "construction" | "service_confirmed" | "no_service";
  observedAtMs: number;
  /** The user who stood at the door. null = imported or unattributed, which
   *  costs the observation a confidence tier. */
  verifiedByUserId?: number | null;
  note?: string | null;
}

export interface PlannedEvidence {
  /** Matches market_evidence.evidence_type. */
  sourceType: "official_directory" | "official_announcement" | "grant_award" | "licensed_import";
  observedAtMs: number;
  sourceUrl?: string | null;
}

export interface KineticBuildInput {
  /** Most recent authorized qualification, conclusive or not. */
  latest?: AuthorizedObservation | null;
  /** Earliest CONCLUSIVE fiber-live observation we hold for this address. */
  firstFiberLiveAtMs?: number | null;
  /** Latest CONCLUSIVE non-fiber observation. The lower bound that turns a
   *  fiber-live reading into a dated transition. */
  lastNonFiberAtMs?: number | null;
  fcc?: FccBlockFacts | null;
  field?: FieldObservation | null;
  planned?: PlannedEvidence | null;
  suppression?: SuppressionReason | null;
  /** BDC business_residential_code R or X, or our own determination. */
  residential?: boolean;
  /** Kinetic reports an active subscriber at this address. */
  existingCustomer?: boolean;
  nowMs?: number;
}

export interface KineticBuildDecision {
  classification: KineticBuildClass;
  confidence: BuildConfidence;
  /** Non-null ONLY when a dated window fits inside one calendar quarter. */
  quarterWhenProven: CalendarQuarter | null;
  /** Non-null ONLY when a dated window fits inside one calendar year. */
  buildYear: number | null;
  detectionWindow: DetectionWindow | null;
  /** Days since the most recent conclusive verification, or null if never. */
  verificationAgeDays: number | null;
  /** May this address be minted as a sales lead? */
  leadEligible: boolean;
  /** Ordered provenance labels, most authoritative first. */
  sources: string[];
  /** Human sentences for the lead card. Never speculative. */
  reasons: string[];
}

/** Classifications that may become sales leads. Deliberately a policy input
 *  rather than a hard-coded check: the brief is 2026 builds, so the default is
 *  confirmed_2026 alone, but an operator widening it later should have to say
 *  so explicitly and get the change covered by a test. */
export const DEFAULT_LEAD_ELIGIBLE_CLASSES: readonly KineticBuildClass[] = ["confirmed_2026"] as const;

/** Verification freshness tiers - the map's "verification age" filter and the
 *  confidence decay both read these, so a pin's colour and its age chip can
 *  never disagree. */
export const VERIFICATION_FRESH_DAYS = 30;
export const VERIFICATION_AGING_DAYS = 90;

export type VerificationAgeBucket = "fresh" | "aging" | "stale" | "never";

export function verificationAgeBucket(ageDays: number | null): VerificationAgeBucket {
  if (ageDays == null) return "never";
  if (ageDays <= VERIFICATION_FRESH_DAYS) return "fresh";
  if (ageDays <= VERIFICATION_AGING_DAYS) return "aging";
  return "stale";
}

const DAY_MS = 86_400_000;

/** The build year every "2026" classification is measured against. Kept as a
 *  named constant so next year's rollover is one edit plus a failing test,
 *  not a search for the literal 2026 across the codebase. */
export const TARGET_BUILD_YEAR = 2026;

function ageDaysFrom(ms: number | null | undefined, nowMs: number): number | null {
  if (ms == null) return null;
  return Math.max(0, (nowMs - ms) / DAY_MS);
}

/** Confidence decay shared by every conclusive address-level verdict. */
function decayByAge(base: Exclude<BuildConfidence, "none">, ageDays: number | null): BuildConfidence {
  if (ageDays == null) return "low";
  if (ageDays <= VERIFICATION_FRESH_DAYS) return base;
  if (ageDays <= VERIFICATION_AGING_DAYS) return base === "high" ? "medium" : "low";
  return "low";
}

/**
 * The lower bound on when a build could have started, from the strongest
 * dated evidence available.
 *
 * Address-level first: a conclusive non-fiber reading for THIS door is direct
 * evidence. Only if we have none do we fall back to the FCC block - and then
 * only when the block genuinely reported no Kinetic FTTP at that vintage,
 * which makes "this address had no Kinetic FTTP then" a sound inference (an
 * address cannot be served in a block where the carrier reports nothing).
 *
 * The reverse inference is NOT sound and is never made: a block that DOES
 * report Kinetic FTTP tells us nothing about whether this particular premise
 * was one of the served locations.
 */
function lowerBound(input: KineticBuildInput): { atMs: number; source: string } | null {
  if (input.lastNonFiberAtMs != null) {
    return { atMs: input.lastNonFiberAtMs, source: "authorized_non_fiber_observation" };
  }
  const fcc = input.fcc;
  if (!fcc?.latestVintage) return null;
  // The block reported zero Kinetic residential FTTP as of the latest vintage
  // we hold, so nothing in it was served through that filing's as-of date.
  if (fcc.reportedLocations === 0) {
    return { atMs: vintageAsOfMs(fcc.latestVintage), source: `fcc_${fcc.latestVintage}_block_absent` };
  }
  // The block had SOME Kinetic FTTP only from a later vintage than the
  // baseline: everything in it was unserved as of the baseline's as-of date.
  if (fcc.baselineVintage && fcc.firstReportedVintage
      && vintageAsOfMs(fcc.firstReportedVintage) > vintageAsOfMs(fcc.baselineVintage)) {
    return { atMs: vintageAsOfMs(fcc.baselineVintage), source: `fcc_${fcc.baselineVintage}_block_absent` };
  }
  return null;
}

function decide(input: KineticBuildInput, nowMs: number): KineticBuildDecision {
  const sources: string[] = [];
  const reasons: string[] = [];
  const latest = input.latest ?? null;
  const conclusive = latest?.conclusive === true && latest.isFiberLive != null;
  const verificationAgeDays = conclusive ? ageDaysFrom(latest!.observedAtMs, nowMs) : null;

  const base = (
    classification: KineticBuildClass,
    confidence: BuildConfidence,
    extra?: Partial<KineticBuildDecision>,
  ): KineticBuildDecision => ({
    classification,
    confidence,
    quarterWhenProven: null,
    buildYear: null,
    detectionWindow: null,
    verificationAgeDays,
    leadEligible: false,
    sources,
    reasons,
    ...extra,
  });

  // 1. Suppression. Compliance and authorization outrank every fact about the
  //    fiber: a DNC-listed or out-of-territory door is not workable even when
  //    it is a perfect confirmed 2026 build.
  if (input.suppression) {
    sources.push(`suppression:${input.suppression}`);
    reasons.push(`Suppressed (${input.suppression.replace(/_/g, " ")}) - excluded from lead creation and routing.`);
    return base("suppressed", "none");
  }
  if (input.residential === false) {
    sources.push("suppression:non_residential");
    reasons.push("Not a residential address - out of scope for door-to-door.");
    return base("suppressed", "none");
  }

  // 2. Already a customer. Kinetic's own billing signal, so it is trusted
  //    without a freshness decay - a subscription does not become untrue.
  if (input.existingCustomer || String(latest?.billingStatus ?? "").toUpperCase() === "Y") {
    sources.push("kinetic_billing");
    reasons.push("Kinetic reports an active subscriber at this address.");
    return base("existing_customer", "medium");
  }

  // 3. Conclusive address-level negative. Outranks anything the block says.
  if (conclusive && latest!.isFiberLive === false) {
    sources.push("authorized_kinetic_qualification");
    reasons.push("Authorized Kinetic qualification returned conclusively no fiber at this address.");
    return base("not_serviceable", decayByAge("high", verificationAgeDays));
  }

  // 4. Conclusive address-level positive - the only route to confirmed_2026.
  if (conclusive && latest!.isFiberLive === true) {
    sources.push("authorized_kinetic_qualification");
    const firstLiveMs = input.firstFiberLiveAtMs ?? latest!.observedAtMs;
    const bound = lowerBound(input);
    const window: DetectionWindow | null =
      bound && firstLiveMs > bound.atMs ? { fromMs: bound.atMs, toMs: firstLiveMs } : null;
    if (bound) sources.push(bound.source);

    const year = windowYear(window);
    const quarter = windowQuarter(window);

    if (year === TARGET_BUILD_YEAR) {
      reasons.push("Fiber serviceable now, and dated evidence shows it was not before 2026.");
      reasons.push(quarter
        ? `Build proven within ${quarter}.`
        : "Evidence window is too wide to prove a quarter - quarter not established.");
      // A confirmed build needs BOTH legs conclusive and recent. The lower
      // bound never decays (a past observation stays true), so only the
      // freshness of the positive reading moves the tier.
      return base("confirmed_2026", decayByAge("high", verificationAgeDays), {
        quarterWhenProven: quarter, buildYear: year, detectionWindow: window,
        leadEligible: true,
      });
    }

    // Fiber is live but the window either predates 2026 or straddles the
    // boundary. Either way it is not a proven 2026 build.
    if (year != null) {
      reasons.push(`Fiber serviceable; dated evidence places the build in ${year}, not ${TARGET_BUILD_YEAR}.`);
    } else if (window) {
      reasons.push("Fiber serviceable, but the evidence window straddles the year boundary - build year not established.");
    } else {
      reasons.push("Fiber serviceable, with no dated evidence that it was ever unserved - treated as pre-existing.");
    }
    return base("existing_fiber", decayByAge("high", verificationAgeDays), {
      quarterWhenProven: quarter, buildYear: year, detectionWindow: window,
    });
  }

  // 5. FCC reported: the block gained Kinetic fiber inside a window that lies
  //    wholly within the target year.
  //
  //    The test is windowYear on the ACTUAL diff window, NOT vintageCanAttestYear.
  //    Those answer different questions and conflating them loses real data:
  //
  //      windowYear           per ADDRESS - "is this a proven 2026 build?"
  //      vintageCanAttestYear per DATASET - "do we have COMPLETE 2026 coverage?"
  //
  //    A D25-to-J26 diff proves an addition between 2025-12-31 and 2026-06-30,
  //    which is entirely inside 2026 and therefore a real 2026 build - even
  //    though J26 cannot speak for the second half of the year and so fails
  //    the attestation (completeness) test. Gating this branch on attestation
  //    would silently demote every genuine H1-2026 addition to likely_2026 the
  //    moment the first usable filing landed. Completeness belongs on the
  //    status endpoint, which reports it separately.
  const fcc = input.fcc;
  const fccWindow = fcc?.latestVintage && fcc.baselineVintage
    ? additionWindow(fcc.baselineVintage, fcc.latestVintage)
    : null;
  if (fcc?.latestVintage && fcc.baselineVintage
      && windowYear(fccWindow) === TARGET_BUILD_YEAR
      && fcc.addedLocations > 0) {
    const window = fccWindow;
    sources.push(`fcc_${fcc.latestVintage}_vs_${fcc.baselineVintage}`);
    reasons.push(`FCC ${fcc.latestVintage} filing reports Kinetic fiber in this census block that the ${fcc.baselineVintage} filing did not.`);
    reasons.push("Block-level filing, not a door verification - confirm at the door.");
    return base("reported_2026", "medium", {
      quarterWhenProven: windowQuarter(window),
      buildYear: windowYear(window),
      detectionWindow: window,
    });
  }

  // 6. Somebody stood there and saw construction. Weaker than a filing about
  //    completed service, stronger than a statistic about the block.
  if (input.field?.kind === "construction") {
    sources.push("field_verification");
    reasons.push("Field evidence of Kinetic construction at or beside this address.");
    reasons.push("Construction is not serviceability - this never becomes confirmed without a qualification.");
    return base("construction_observed", input.field.verifiedByUserId != null ? "medium" : "low", {
      verificationAgeDays: ageDaysFrom(input.field.observedAtMs, nowMs),
    });
  }

  // 7. Leading edge. A block Kinetic was actively extending through the last
  //    filing, that it has NOT finished covering. The unserved remainder of a
  //    block under active build is the best-founded 2026 candidate we can name
  //    without spending a qualification - and it is labelled "likely", never
  //    "confirmed", precisely because we cannot tell which premises they were.
  if (fcc && fcc.addedLocations > 0 && fcc.totalLocations > fcc.reportedLocations) {
    const uncovered = fcc.totalLocations - fcc.reportedLocations;
    sources.push(`fcc_${fcc.latestVintage ?? "unknown"}_partial_block`);
    reasons.push(`Kinetic added ${fcc.addedLocations} fiber locations in this block through ${fcc.latestVintage ?? "the latest filing"}, and ${uncovered} residential locations there still have none.`);
    reasons.push("Candidate only - no filing or qualification has confirmed this address.");
    return base("likely_2026", "low");
  }

  // 8. Official plans. Explicitly terminal: nothing here can be promoted.
  if (input.planned) {
    sources.push(`market_evidence:${input.planned.sourceType}`);
    reasons.push("Official Kinetic market or expansion evidence covers this area.");
    reasons.push("A market announcement is not address serviceability.");
    return base("planned", "none");
  }

  if (latest && !conclusive) {
    sources.push("authorized_kinetic_qualification");
    reasons.push("The provider did not return a usable answer - this address stays recheckable.");
  } else {
    reasons.push("No conclusive evidence for this address yet.");
  }
  return base("unverified", "none");
}

export function classifyKineticBuild(
  input: KineticBuildInput,
  leadEligibleClasses: readonly KineticBuildClass[] = DEFAULT_LEAD_ELIGIBLE_CLASSES,
): KineticBuildDecision {
  const decision = decide(input, input.nowMs ?? Date.now());
  // One place decides lead eligibility, so widening the policy can never
  // accidentally bypass the suppression and customer rules above: those
  // classifications simply are not in the eligible set.
  return {
    ...decision,
    leadEligible: decision.leadEligible && leadEligibleClasses.includes(decision.classification),
  };
}

/** Map paint tiers, named so the server, the legend and the layer spec all
 *  read from one list. The brief's colour language maps as:
 *    gold       confirmed and recent  (a confirmed 2026 build verified lately)
 *    blue       confirmed 2026        (confirmed, verification has aged)
 *    lightblue  FCC-reported
 *    amber      construction candidates
 *    gray       older Kinetic fiber
 */
export type BuildPaintTier = "gold" | "blue" | "lightblue" | "amber" | "gray" | "muted";

export function paintTierFor(
  classification: KineticBuildClass,
  ageBucket: VerificationAgeBucket,
): BuildPaintTier {
  switch (classification) {
    case "confirmed_2026":
      // Gold is reserved for a confirmed build we have verified RECENTLY -
      // the doors worth walking today. An aged confirmation stays blue.
      return ageBucket === "fresh" ? "gold" : "blue";
    case "reported_2026":
      return "lightblue";
    case "likely_2026":
    case "construction_observed":
      return "amber";
    case "existing_fiber":
    case "existing_customer":
      return "gray";
    default:
      return "muted";
  }
}
