// ── Canonical competitive-eligibility classifier ─────────────────────────────
// THE one place that decides whether a Kinetic NEW-FIBER opportunity is a
// deliverable Fresh Lead given the competitive landscape. Used by scan
// projection, lead upsert, Field Map delivery, exports, and rechecks — never
// scatter competitor string-matching anywhere else.
//
// BUSINESS RULE (owner directive, 2026-07-23 wording): ANY competitor is
// acceptable as long as its technology is not fiber. Spectrum/Comcast/Cox or
// any other cable, Starlink/satellite, DSL/copper, fixed wireless, and
// cellular home internet all still qualify; the address is excluded only when
// another provider is identified as offering FIBER. Brand does not matter —
// TECHNOLOGY is the deciding factor; never hardcode any single accepted brand.
//
// FAIL CLOSED: a competitor whose technology can't be recognized is NOT
// published — it becomes COMPETITOR_REVIEW (non-deliverable, kept for audit +
// recheck) rather than a Fresh Lead. An unknown carrier might be fiber.
//
// Grounded in the real values observed in production competitor data:
//   competitor_tech:  Cable | Fiber to the Premises | NGSO Satellite |
//                     Licensed Fixed Wireless
//   competitor_name:  Spectrum | Starlink | NO COMPETITOR | Google Fiber |
//                     Verizon | TDS Telecom | Hotwire Communications | AT&T |
//                     Ripple Fiber | lumos | Randolph Telephone …

export const COMPETITIVE_ELIGIBILITY_VERSION = 2;

export type CompetitorClass = "fiber" | "cable" | "satellite" | "dsl" | "wireless" | "none" | "unknown";
export type CompetitiveDecision = "eligible" | "excluded_fiber_competitor" | "competitor_review";

export interface CompetitorSignal {
  name?: string | null;
  tech?: string | null;
  speedMbps?: number | null;
}

export interface NormalizedCompetitor {
  name: string | null;
  tech: string | null;
  klass: CompetitorClass;
  reason: string;
}

export interface CompetitiveEligibilityResult {
  decision: CompetitiveDecision;
  /** True only when decision === "eligible" — the sole publishable state. */
  eligible: boolean;
  /** Competitors whose technology reads as fiber (the exclusion drivers). */
  fiberCompetitors: string[];
  /** Competitors that couldn't be classified (fail-closed review drivers). */
  reviewCompetitors: string[];
  normalized: NormalizedCompetitor[];
  version: number;
}

const up = (v: unknown): string => String(v ?? "").normalize("NFKD").toUpperCase().replace(/\s+/g, " ").trim();

// Technology-signal tokens. FIBER is the disqualifier; the rest are allowed
// competition (not fiber). Substring match on the normalized string.
const FIBER_TECH = ["FIBER", "FIBRE", "FTTP", "FTTH", "FTTB", "FIBER TO THE", "OPTIC", "GPON", "EPON", "XGS-PON", " PON", "FIOS", "PASSIVE OPTICAL"];
const CABLE_TECH = ["CABLE", "DOCSIS", "COAX", "HFC"];
const SATELLITE_TECH = ["SATELLITE", "NGSO", "GEO SAT", "LEO"];
const DSL_TECH = ["DSL", "ADSL", "VDSL", "COPPER"];
const WIRELESS_TECH = ["FIXED WIRELESS", "WIRELESS", "LTE", "5G HOME", "WISP", "MMWAVE", "CELLULAR", "HOME INTERNET"];

// Name-based signals used ONLY when tech is missing/unrecognized. A name that
// contains "FIBER"/"FIBRE" or is a known fiber-only brand is a fiber competitor.
const FIBER_NAME_BRANDS = ["GOOGLE FIBER", "RIPPLE FIBER", "LUMOS", "METRONET", "ZIPLY", "HOTWIRE", "FIOS", "BRIGHTSPEED FIBER", "GREENLIGHT", "TING", "FRONTIER FIBER", "AT&T FIBER", "ATT FIBER"];
// Known non-fiber brands (cable / satellite) that are safe when tech is absent.
const CABLE_NAME_BRANDS = ["SPECTRUM", "CHARTER", "COMCAST", "XFINITY", "COX", "OPTIMUM", "MEDIACOM", "SUDDENLINK", "WOW", "ASTOUND"];
const SATELLITE_NAME_BRANDS = ["STARLINK", "HUGHESNET", "HUGHES", "VIASAT", "EXEDE"];

const hasToken = (s: string, tokens: string[]): boolean => tokens.some(t => s.includes(t));

/** Classify a single competitor into a technology class. Fail closed: a present
 * competitor that matches no known tech AND no known brand is "unknown". */
export function classifyCompetitor(sig: CompetitorSignal): NormalizedCompetitor {
  const name = sig.name != null && String(sig.name).trim() ? String(sig.name).trim() : null;
  const tech = sig.tech != null && String(sig.tech).trim() ? String(sig.tech).trim() : null;
  const nUp = up(name);
  const tUp = up(tech);

  // "no competitor" / empty → none.
  if ((!name && !tech) || nUp === "NO COMPETITOR" || nUp === "NONE") {
    return { name, tech, klass: "none", reason: "no competitor present" };
  }

  // Technology is the authoritative signal — check it first.
  if (tUp) {
    if (hasToken(tUp, FIBER_TECH)) return { name, tech, klass: "fiber", reason: `fiber technology: ${tech}` };
    if (hasToken(tUp, CABLE_TECH)) return { name, tech, klass: "cable", reason: `cable technology: ${tech}` };
    if (hasToken(tUp, SATELLITE_TECH)) return { name, tech, klass: "satellite", reason: `satellite technology: ${tech}` };
    if (hasToken(tUp, DSL_TECH)) return { name, tech, klass: "dsl", reason: `dsl technology: ${tech}` };
    if (hasToken(tUp, WIRELESS_TECH)) return { name, tech, klass: "wireless", reason: `fixed-wireless technology: ${tech}` };
    // Tech present but unrecognized — could be fiber. Fall through to name; if
    // the name doesn't clarify, this stays unknown (fail closed).
  }

  // No/unrecognized tech → lean on the name.
  if (hasToken(nUp, FIBER_NAME_BRANDS) || /\bFIBER\b|\bFIBRE\b/.test(nUp)) {
    return { name, tech, klass: "fiber", reason: `fiber carrier name: ${name}` };
  }
  if (hasToken(nUp, CABLE_NAME_BRANDS)) return { name, tech, klass: "cable", reason: `cable carrier name: ${name}` };
  if (hasToken(nUp, SATELLITE_NAME_BRANDS)) return { name, tech, klass: "satellite", reason: `satellite carrier name: ${name}` };

  // Present but unclassifiable → review (an unknown telco may be fiber).
  return { name, tech, klass: "unknown", reason: `unrecognized competitor${tech ? ` tech "${tech}"` : ""}${name ? ` name "${name}"` : ""}` };
}

/** Evaluate the competitive landscape for an address. Precedence:
 *  any fiber competitor → excluded; else any unknown competitor → review;
 *  else eligible (none / cable / satellite / dsl / wireless are all fine). */
export function classifyCompetitiveEligibility(competitors: readonly CompetitorSignal[]): CompetitiveEligibilityResult {
  const normalized = (competitors ?? []).map(classifyCompetitor);
  const fiber = normalized.filter(c => c.klass === "fiber");
  const unknown = normalized.filter(c => c.klass === "unknown");

  let decision: CompetitiveDecision;
  if (fiber.length) decision = "excluded_fiber_competitor";
  else if (unknown.length) decision = "competitor_review";
  else decision = "eligible";

  return {
    decision,
    eligible: decision === "eligible",
    fiberCompetitors: fiber.map(c => c.name ?? c.tech ?? "unknown").filter(Boolean),
    reviewCompetitors: unknown.map(c => c.name ?? c.tech ?? "unknown").filter(Boolean),
    normalized,
    version: COMPETITIVE_ELIGIBILITY_VERSION,
  };
}

/** Convenience for the common single-competitor Kinetic payload. */
export function evaluateSingleCompetitor(name?: string | null, tech?: string | null, speedMbps?: number | null): CompetitiveEligibilityResult {
  return classifyCompetitiveEligibility([{ name, tech, speedMbps }]);
}

// ── Response-level Fresh Lead gate ───────────────────────────────────────────
// THE canonical decision for "does this authoritative Kinetic Search response
// qualify as a Fresh Lead?", composing every condition in one place:
//   success=true, errorCode=0, validationResult=AddressFound,
//   Kinetic is FIBER (techType or maxQualTechnologyType),
//   householdSegmentType=NEW FIBER, billingStatus=N,
//   and no competitor whose technology reads as fiber (unknown → review).
// The live pipeline enforces the same conditions at its choke points
// (observation parse → availabilitySnapshot competitive_decision → the
// freshFiberProjector publication gate); this function is the single reference
// implementation fixtures and rechecks test against — keep them in lockstep.

export interface KineticFreshLeadInput {
  success?: boolean | null;
  errorCode?: number | string | null;
  validationResult?: string | null;
  techType?: string | null;
  maxQualTechnologyType?: string | null;
  householdSegmentType?: string | null;
  billingStatus?: string | null;
  competitors?: readonly CompetitorSignal[];
}

export interface KineticFreshLeadResult {
  decision: "fresh_lead" | "competitor_review" | "not_eligible";
  eligible: boolean;
  reasons: string[];
  competitive: CompetitiveEligibilityResult;
  version: number;
}

export function classifyKineticFreshLead(input: KineticFreshLeadInput): KineticFreshLeadResult {
  const reasons: string[] = [];
  if (input.success === false) reasons.push("success=false");
  if (input.errorCode != null && String(input.errorCode) !== "0") reasons.push(`errorCode=${input.errorCode}`);
  if (input.validationResult != null && up(input.validationResult) !== "ADDRESSFOUND" && up(input.validationResult) !== "ADDRESS FOUND") {
    reasons.push(`validationResult=${input.validationResult}`);
  }
  const kineticFiber = hasToken(up(input.techType), FIBER_TECH) || hasToken(up(input.maxQualTechnologyType), FIBER_TECH);
  if (!kineticFiber) reasons.push("kinetic technology is not fiber");
  if (up(input.householdSegmentType) !== "NEW FIBER") reasons.push(`householdSegmentType=${input.householdSegmentType ?? "(none)"}`);
  if (up(input.billingStatus) !== "N") reasons.push(`billingStatus=${input.billingStatus ?? "(none)"}`);

  const competitive = classifyCompetitiveEligibility(input.competitors ?? []);
  if (competitive.decision === "excluded_fiber_competitor") {
    reasons.push(`fiber competitor: ${competitive.fiberCompetitors.join(", ")}`);
  }

  let decision: KineticFreshLeadResult["decision"];
  if (reasons.length) decision = "not_eligible";
  else if (competitive.decision === "competitor_review") decision = "competitor_review";
  else decision = "fresh_lead";
  return { decision, eligible: decision === "fresh_lead", reasons, competitive, version: COMPETITIVE_ELIGIBILITY_VERSION };
}
