// ── Canonical Kinetic Search API response parser + classifier ────────────────
// ONE source of truth for reading a Kinetic address-search response and deciding
// its category. Used by Manual Check, Field Map, city scans, rechecks, and
// background scans — there is no per-surface classification logic anywhere else.
//
// Two real-world quirks this handles:
//  1. `uqualProvisioningResult` arrives as a JSON *string*, not an object. We
//     parse it and use it to SUPPLEMENT missing top-level details (fiber
//     chipSetType / finalQual / speed, service key/status). A nested value never
//     replaces a valid top-level value with a missing/empty/weaker one.
//  2. A COPPER override (`technologyType=COPPER`, `qualMessage=NO QUAL`,
//     `reasonDetails=COPPER QUAL REMOVE FIBER AREA`) removes COPPER qualification
//     ONLY. It can NEVER invalidate a separately-qualified FIBER service. Every
//     override is evaluated solely against the technology it names.

export interface KineticParsed {
  success: boolean;
  validationResult: string;
  exactMatch: boolean;
  addressFound: boolean;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  householdSegmentType: string | null; // "NEW FIBER" | "TENURED" | …
  marketSegmentType: string | null;
  billingStatus: string | null; // "N" (no account) | "Y" / "A" (active account)
  dfAddressId: string | null;
  dfAddressIdXref: string | null;
  accessId: string | null; // qualAddressAccessId
  fiberQualified: boolean; // fiber is separately qualified (copper-override-safe)
  technology: string | null; // resolved primary technology, FIBER-preferring
  maxQual: string | null;
  finalQualSpeedKbps: number | null;
  chipSetType: string | null; // "FTTP" | …
  serviceKey: string | null; // miror.svcKey
  serviceStatus: string | null; // miror.status
  productId: number | null;
  copperOverridePresent: boolean;
}

export type KineticClassification =
  | "FRESH_LEAD"
  | "NOW_ACTIVE"
  | "COMING_SOON"
  | "NO_SERVICE"
  | "CHECKED"
  | "UNRESOLVED";

const up = (v: unknown) => String(v ?? "").trim().toUpperCase();
const strOr = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };
const numOr = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const toArray = (x: any): any[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
const isNoQual = (s: any): boolean =>
  up(s?.qualMessage) === "NO QUAL" || up(s?.finalQual).includes("NO QUAL") || /remove\s*fiber/i.test(String(s?.reasonDetails ?? ""));

interface UqualExtract {
  fiberService: any | null;
  copperOverridePresent: boolean;
  chipSetType: string | null;
  finalQual: string | null;
  finalQualSpeedKbps: number | null;
  serviceKey: string | null;
  serviceStatus: string | null;
  productId: number | null;
}

/** Parse `response.uqualProvisioningResult`, whether an object or a JSON string. */
export function parseUqual(raw: unknown): UqualExtract {
  const empty: UqualExtract = {
    fiberService: null, copperOverridePresent: false, chipSetType: null, finalQual: null,
    finalQualSpeedKbps: null, serviceKey: null, serviceStatus: null, productId: null,
  };
  let obj: any = raw;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return empty;
    try { obj = JSON.parse(s); } catch { return empty; }
  }
  if (!obj || typeof obj !== "object") return empty;

  const services = [
    ...toArray(obj.broadBandServices),
    ...toArray(obj.broadbandServices),
    ...toArray(obj.services),
    ...toArray(obj.fiber),
  ].filter(Boolean);

  // FIBER is qualified INDEPENDENTLY of any COPPER override. A COPPER entry with
  // "NO QUAL / REMOVE FIBER AREA" disqualifies copper only — never fiber.
  const fiberService = services.find(s => up(s.technologyType) === "FIBER" && !isNoQual(s)) ?? null;
  const copperOverridePresent = services.some(s => up(s.technologyType) === "COPPER" && isNoQual(s));

  const miror = obj.miror ?? obj.mirror ?? {};
  const productRaw = fiberService?.productID ?? fiberService?.productId;
  const productNum = productRaw == null ? NaN : Number(productRaw);
  return {
    fiberService,
    copperOverridePresent,
    chipSetType: strOr(obj.chipSetType ?? fiberService?.chipSetType),
    finalQual: strOr(fiberService?.finalQual ?? obj.finalQual),
    finalQualSpeedKbps: numOr(fiberService?.finalQualSpeed ?? obj.finalQualSpeed),
    serviceKey: strOr(miror.svcKey ?? miror.serviceKey ?? obj.svcKey),
    serviceStatus: strOr(miror.status ?? obj.status),
    productId: Number.isFinite(productNum) ? productNum : null,
  };
}

/** Normalize a Kinetic response into canonical fields from the real paths. */
export function parseKineticResponse(data: any): KineticParsed {
  const addr = data?.address ?? {};
  const uq = parseUqual(data?.uqualProvisioningResult);

  const topTech = up(data?.techType);
  const addrTech = up(addr?.maxQualTechnologyType);
  // Fiber is qualified if ANY authoritative signal says so; the copper override is
  // ignored for fiber. This is the fix for "COPPER QUAL REMOVE FIBER AREA" wrongly
  // sinking a lead that has a separately-qualified FIBER service.
  const fiberQualified = topTech === "FIBER" || addrTech === "FIBER" || up(uq.chipSetType) === "FTTP" || !!uq.fiberService;

  const lat = parseFloat(String(addr?.geoLat));
  const lng = parseFloat(String(addr?.geoLong));

  return {
    success: !!data?.success,
    validationResult: strOr(data?.validationResult) ?? "",
    exactMatch: !!data?.exactMatch,
    addressFound: up(data?.validationResult) === "ADDRESSFOUND",
    addressLine1: strOr(addr?.addressLine1),
    city: strOr(addr?.city),
    state: strOr(addr?.stateProvinceCd),
    zip: strOr(addr?.postalCd),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    householdSegmentType: strOr(addr?.householdSegmentType),
    marketSegmentType: strOr(addr?.marketSegmentType),
    billingStatus: strOr(addr?.billingStatus),
    dfAddressId: strOr(data?.dfAddressId),
    dfAddressIdXref: strOr(addr?.dfAddressIdXref),
    accessId: strOr(data?.qualAddressAccessId ?? data?.accessId),
    fiberQualified,
    technology: fiberQualified ? "FIBER" : (strOr(data?.techType) ?? strOr(addr?.maxQualTechnologyType)),
    maxQual: strOr(data?.maxQual) ?? uq.finalQual,
    // Prefer the top-level broadband speed; supplement from the nested fiber
    // service. Never let a missing nested value overwrite a valid top-level one.
    finalQualSpeedKbps: numOr(data?.broadbandService?.finalQualSpeed) ?? uq.finalQualSpeedKbps,
    chipSetType: uq.chipSetType ?? strOr(data?.uqualProvisioningResult?.chipSetType),
    serviceKey: uq.serviceKey,
    serviceStatus: uq.serviceStatus,
    productId: uq.productId,
    copperOverridePresent: uq.copperOverridePresent,
  };
}

/** Canonical classifier. Errors are NEVER a no-fiber — they are UNRESOLVED. */
export function classifyKineticResult(p: KineticParsed): KineticClassification {
  if (!p.success) return "UNRESOLVED"; // request failure / soft failure
  const vr = up(p.validationResult).replace(/\s+/g, "");
  if (!vr) return "UNRESOLVED";
  if (/ADDRESSNOTFOUND|UNSERVICEABLE|OUTOFTERRITORY|NOTSERVICEABLE|NOSERVICE/.test(vr)) return "NO_SERVICE";
  const seg = up(p.householdSegmentType);
  const billing = up(p.billingStatus);
  // A missing segment or billing status is not a No — it is unresolved (recheck).
  if (!seg || !billing) return "UNRESOLVED";
  // AUTHORITATIVE LEAD RULE: NEW FIBER + billing N + successful exact match.
  if (seg === "NEW FIBER" && billing === "N" && p.addressFound && p.exactMatch) return "FRESH_LEAD";
  // Active service, not a lead. Kinetic returns BOTH "Y" and "A" for an address
  // with an active account (verified live: 4051 Dakeita Cir → billingStatus "A").
  if (seg === "NEW FIBER" && (billing === "Y" || billing === "A")) return "NOW_ACTIVE";
  if (isComingSoon(p, seg)) return "COMING_SOON";
  // A successful, conclusive result that is not a lead still counts as Checked.
  return "CHECKED";
}

function isComingSoon(p: KineticParsed, seg: string): boolean {
  return /COMING\s*SOON|FUTURE|PLANNED|PENDING/.test(seg)
    || /COMING\s*SOON|FUTURE|PLANNED/.test(up(p.marketSegmentType))
    || up(p.serviceStatus).includes("PENDING");
}

// ── Address correction (AddressNeedsFix / AddressSuggestions) ─────────────────
// When Kinetic returns success=false with validationResult AddressNeedsFix or
// AddressSuggestions, the payload usually carries a list of SUGGESTED corrected
// addresses. We extract those candidates and decide whether exactly ONE of them
// is reliable enough to auto-apply. If 0 or several ambiguous candidates exist,
// we return null and the caller keeps the existing non-conclusive requeue/backoff
// behavior — we never guess.

export interface KineticAddressSuggestion {
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  score: number | null; // normalized 0..1 confidence if the payload provided one
  exactMatch: boolean;
  raw: any;
}

export interface AddressSuggestionSelection {
  candidates: KineticAddressSuggestion[];
  suggestion: KineticAddressSuggestion | null; // the single reliable pick, else null
  reason: string; // why a pick was / was not made (for notes + telemetry)
}

// Confidence thresholds for auto-applying a suggestion.
const SUGGESTION_HIGH_CONFIDENCE = 0.9; // a scored candidate must clear this to win among several
const SUGGESTION_MIN_GAP = 0.15; // and lead the runner-up by at least this
const SUGGESTION_LOW_FLOOR = 0.5; // an explicitly low-scored SOLE candidate is not applied

function normalizeSuggestionScore(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1 ? raw / 100 : raw;
  if (typeof raw === "string") {
    const s = raw.trim().toUpperCase();
    if (s === "HIGH" || s === "EXACT") return 0.95;
    if (s === "MEDIUM" || s === "MED") return 0.6;
    if (s === "LOW") return 0.3;
    const n = Number(s.replace(/[^\d.]/g, ""));
    if (Number.isFinite(n) && n > 0) return n > 1 ? n / 100 : n;
  }
  return null;
}

function normalizeSuggestion(raw: any): KineticAddressSuggestion | null {
  if (!raw || typeof raw !== "object") return null;
  // Some payloads nest the address fields under `.address`; others are flat.
  const a = (raw.address && typeof raw.address === "object") ? raw.address : raw;
  const addressLine1 = strOr(a.addressLine1 ?? a.addressLine ?? a.line1 ?? a.street ?? raw.addressLine1);
  if (!addressLine1) return null; // a candidate with no street line is unusable
  const city = strOr(a.city ?? raw.city);
  const state = strOr(a.stateProvinceCd ?? a.state ?? a.stateCode ?? raw.state ?? raw.stateProvinceCd);
  const zip = strOr(a.postalCd ?? a.postalCode ?? a.zip ?? a.zipCode ?? raw.postalCd ?? raw.zip);
  const score = normalizeSuggestionScore(
    raw.matchScore ?? raw.score ?? raw.confidence ?? raw.confidenceScore ?? a.matchScore ?? a.score,
  );
  const exactMatch = raw.exactMatch === true || a.exactMatch === true
    || up(raw.matchType ?? raw.matchLevel) === "EXACT";
  return { addressLine1, city, state, zip, score, exactMatch, raw };
}

/**
 * Extract suggested corrected addresses from an AddressNeedsFix / AddressSuggestions
 * response and pick the single reliable one to auto-apply, if any.
 *
 * Selection rules (conservative — never guess):
 *  - 0 usable candidates                → no pick.
 *  - exactly 1 candidate                → pick it, unless it carries an explicit
 *                                          low confidence score (< floor).
 *  - exactly 1 candidate flagged exact  → pick it; >1 exact = ambiguous, no pick.
 *  - a scored candidate clearing the high-confidence threshold AND leading the
 *    runner-up by the min gap → pick it.
 *  - otherwise (several ambiguous)      → no pick.
 */
export function selectReliableAddressSuggestion(data: any): AddressSuggestionSelection {
  const pools = [
    data?.addressSuggestions,
    data?.suggestions,
    data?.addressCandidates,
    data?.candidates,
    data?.candidateAddresses,
    data?.addressValidation?.candidates,
    data?.addressValidation?.suggestions,
    data?.validation?.candidates,
    data?.validation?.suggestions,
  ];
  const seen = new Set<string>();
  const candidates: KineticAddressSuggestion[] = [];
  for (const pool of pools) {
    for (const item of toArray(pool)) {
      const n = normalizeSuggestion(item);
      if (!n) continue;
      const key = [up(n.addressLine1), up(n.city), up(n.state), String(n.zip ?? "").replace(/\D/g, "").slice(0, 5)].join("|");
      if (seen.has(key)) continue; // de-dupe identical candidates repeated across pools
      seen.add(key);
      candidates.push(n);
    }
  }

  if (candidates.length === 0) {
    return { candidates, suggestion: null, reason: "no address suggestions in response" };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    if (only.score != null && only.score < SUGGESTION_LOW_FLOOR) {
      return { candidates, suggestion: null, reason: `single low-confidence suggestion (${only.score.toFixed(2)}) - not applied` };
    }
    return { candidates, suggestion: only, reason: "single unambiguous suggestion" };
  }

  // Several candidates: an exact-match flag is the strongest signal, then a clearly
  // top-ranked score. Anything short of that is ambiguous and left for requeue.
  const exacts = candidates.filter(c => c.exactMatch);
  if (exacts.length === 1) {
    return { candidates, suggestion: exacts[0], reason: "single exact-match suggestion among several" };
  }
  if (exacts.length > 1) {
    return { candidates, suggestion: null, reason: `${exacts.length} exact-match suggestions - ambiguous` };
  }

  const ranked = [...candidates].sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
  const [top, second] = ranked;
  if (
    top.score != null && top.score >= SUGGESTION_HIGH_CONFIDENCE &&
    (second.score == null || top.score - second.score >= SUGGESTION_MIN_GAP)
  ) {
    return { candidates, suggestion: top, reason: `top suggestion score ${top.score.toFixed(2)} clears threshold` };
  }

  return { candidates, suggestion: null, reason: `${candidates.length} ambiguous suggestions - none clearly top-ranked` };
}
