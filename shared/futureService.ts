// ── "Will this address ever turn on?" — reading a future-service promise ─────
//
// The operator's question is simple: when Kinetic tells us an address is not
// serviceable YET but will be, save the address and save the date it gives.
// Getting that right needs three distinctions the codebase currently blurs.
//
// 1. FUTURE SERVICE is not NOW ACTIVE. `server/availabilitySnapshot.ts` admits
//    `NEW FIBER + billing Y/A` into the coming-soon watchlist, but the canonical
//    classifier (`kineticResponseParser.classifyKineticResult`) calls that
//    NOW_ACTIVE: fiber is already lit AND somebody already holds the account.
//    That is a door we lost, not a door we are waiting on. Measured on the
//    production-shaped copy: 294 of 330 active watches are that inference
//    ("medium" confidence) and ZERO are an explicit pre-launch segment, which is
//    why no watch has ever flipped to a lead. They also sit in the one
//    dedup-exempt recheck lane, so we re-buy sold doors forever.
//
// 2. A PROMISED DATE must come from the provider, or be labelled as ours.
//    `coming_soon_watchlist.estimated_completion` drives the recheck cadence
//    (hot when the date is within 14 days or past) and is NULL on every row.
//    A comment in availabilitySnapshot.ts asserts the Search response "carries
//    no completion date" - and no field in `KineticParsed` is a date, so as far
//    as this codebase has ever looked, that is true. But nobody has looked at an
//    actual pre-launch payload, because we have never recorded one: the raw
//    response is not persisted anywhere. So `findProviderDate` walks the payload
//    for a date under any key whose NAME means "when will it be ready", and
//    reports the path it found. The day Kinetic states a date, we capture it and
//    can prove where it came from; until then we record `null` honestly rather
//    than inventing one.
//
// 2b. MEASURED, 2026-08-22, against all 3,454 raw payloads this install has
//    stored (kinetic_address_observations.raw_response_json - raw IS persisted,
//    contrary to the assumption above; 1,611 are Kinetic-shaped and 1,843
//    Frontier-shaped). Results:
//      * KINETIC: states it outright, in `broadbandService`, which the parser
//        never modelled: {futureQual:"FutureQual", technologyType:
//        "FUTURE_QUAL_EXTENDED", qualDesc:"FUTURE QUAL UP TO 1G",
//        futureTechnologyType:"FIBER", estimatedCompletionDt:"NOV-2026"}.
//        Measured over fiber_checks.result (22,242 stored bodies): 476 distinct
//        doors carry a real MON-YYYY (Harrisburg FEB-2027 131, Indian Trail
//        MAR-2027 125, Monroe NOV-2026 67, Landis NOV-2026 49, ...) and 488 more
//        carry the undated sentinel "Future Fiber Build Planned". ~964 NC doors
//        where Kinetic said fiber is coming, every one of them discarded.
//        (`addressCatalogDt`, values 2019-2024, and an override `dateActive`
//        are the OTHER dates in the payload and are not promises.)
//      * FRONTIER: states the whole thing outright. `isFutureFiberEligible`
//        (67 true), `fiberBuildOutStatus:"PENDING"` (168), `fiberModernization`
//        (168) and `futureServiceDate` (164 doors, dated 2026-08-14 through
//        2026-12-31). We have been throwing every one of those away.
//    So the operator's question already has a real answer for one carrier, and
//    this module reads both vocabularies.
//
// 3. `addressCatalogDate` is NOT a turn-on date. It is a record-keeping stamp
//    (values in this data run 2019-2024). The key filter below excludes it by
//    name, along with billing/order/audit stamps, so a 2019 catalog date can
//    never masquerade as a 2026 promise and drag an address into the hot lane.
//
// Pure and dependency-free so it can be unit-tested against real payload shapes.

/** What one provider answer says about future service at an address. */
export interface FutureServiceRead {
  /** The provider says: not serviceable yet, but planned/coming. */
  isFuture: boolean;
  /** Fiber is live here AND an account is already active - a lost door, not a wait. */
  isNowActive: boolean;
  /** Provider-stated turn-on date, normalized to YYYY-MM-DD. Null when unstated. */
  promisedDate: string | null;
  /** Where promisedDate came from; null when there is no date. */
  dateSource: "provider" | null;
  /** The payload path the date was read from, for provenance in the ledger. */
  datePath: string | null;
  /** Machine-readable reasons, stable strings for logs and the UI. */
  signals: string[];
  /** The provider text that triggered the future verdict, bounded for storage. */
  quote: string | null;
}

/** Fields the classifier reads, as produced by parseKineticResponse. */
export interface FutureServiceInput {
  householdSegmentType?: string | null;
  marketSegmentType?: string | null;
  serviceStatus?: string | null;
  billingStatus?: string | null;
  finalQual?: string | null;
  maxQual?: string | null;
}

/**
 * The provider's own build-out contract, when it ships one. These are Frontier's
 * top-level fields (measured present on 1,843 stored payloads); Kinetic sends
 * none of them, so every value is optional and absence means "not stated".
 */
export interface ProviderBuildFlags {
  futureEligible: boolean | null;
  buildOutStatus: string | null;
  modernization: boolean | null;
  hasExistingService: boolean | null;
  pendingOrder: boolean | null;
  plantType: string | null;
  /** Kinetic: `broadbandService.futureQual` === "FutureQual". */
  futureQual: boolean | null;
  /** Kinetic: the technology the future build will deliver, e.g. "FIBER". */
  futureTechnology: string | null;
  /** Kinetic: the raw estimatedCompletionDt, which may be a month or a sentinel. */
  completionText: string | null;
}

const BUILD_PENDING_RE = /PENDING|IN\s*PROGRESS|PLANNED|UNDER\s*CONSTRUCTION|SCHEDULED/;

/** Read the provider build-out flags off a raw body. Tolerates a missing body. */
export function readBuildFlags(raw: unknown): ProviderBuildFlags {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
  const str = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s ? s : null; };
  // Kinetic hangs its future build off broadbandService; a per-service copy also
  // appears under uqualProvisioningResult.broadBandServices[].
  const bb = (r.broadbandService && typeof r.broadbandService === "object" ? r.broadbandService : {}) as Record<string, unknown>;
  const futureQualText = `${str(bb.futureQual) ?? ""} ${str(bb.technologyType) ?? ""} ${str(bb.qualDesc) ?? ""}`.toUpperCase();
  return {
    futureEligible: bool(r.isFutureFiberEligible),
    buildOutStatus: str(r.fiberBuildOutStatus),
    modernization: bool(r.fiberModernization),
    hasExistingService: bool(r.addressHasExistingService),
    pendingOrder: bool(r.hasPendingOrder),
    plantType: str(r.plantType),
    futureQual: /FUTUREQUAL|FUTURE\s*QUAL/.test(futureQualText.replace(/\s+/g, " ")) ? true : null,
    futureTechnology: str(bb.futureTechnologyType),
    completionText: str(bb.estimatedCompletionDt),
  };
}

const up = (v: unknown) => String(v ?? "").trim().toUpperCase();

/**
 * The provider's ACCOUNT record for a door that already has service.
 *
 * Measured on the stored bodies: every payload with `address.billingStatus='A'`
 * carries `address.localAccountNumber` (1,084 checks, 959 distinct accounts),
 * usually with `accountTier` ("Tier 2" on 706 doors), `accountSubTier` and
 * `billingSystem` ("CAMS"). None of it was ever read, so a rep standing at an
 * existing customer's door had no way to see that the household is already on
 * the books, let alone which tier.
 *
 * The account number is customer data. It is stored, never logged, and only
 * ever leaves the server masked (see maskAccountNumber in
 * server/customerAccount.ts).
 */
export interface ProviderAccount {
  accountNumber: string | null;
  tier: string | null;
  subTier: string | null;
  billingSystem: string | null;
}

export function readAccount(raw: unknown): ProviderAccount {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const addr = (r.address && typeof r.address === "object" ? r.address : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    const s = String(v ?? "").trim();
    return s && s !== "null" && s !== "undefined" ? s : null;
  };
  return {
    accountNumber: str(addr.localAccountNumber ?? addr.accountNumber),
    tier: str(addr.accountTier),
    subTier: str(addr.accountSubTier),
    billingSystem: str(addr.billingSystem),
  };
}

/**
 * Explicit pre-launch vocabulary. Deliberately narrow: every term here means
 * "not yet, but it is coming". `PENDING` is included only for serviceStatus
 * (a pending SERVICE order), never for a segment, where it is ambiguous.
 */
const FUTURE_SEGMENT_RE = /COMING\s*SOON|FUTURE|PLANNED|PRE[-\s]?LAUNCH|UNDER\s*CONSTRUCTION|IN\s*BUILD|BUILD\s*IN\s*PROGRESS/;
const FUTURE_STATUS_RE = /COMING\s*SOON|FUTURE|PLANNED|PENDING|IN\s*PROGRESS|SCHEDULED/;
/** Qualification text that promises service later rather than now. */
const FUTURE_QUAL_RE = /FUTURE\s*QUAL|PLANNED\s*QUAL|QUAL\s*PENDING|COMING\s*SOON/;

/** Billing statuses that mean somebody already holds an account at this door. */
const ACTIVE_BILLING = new Set(["Y", "A"]);

/**
 * Read one parsed provider answer for a future-service promise.
 *
 * `raw` is the untouched response body when available; it is only used to look
 * for a date, never to decide the verdict (the verdict comes from the parsed
 * fields so it stays consistent with the canonical classifier).
 */
export function readFutureService(p: FutureServiceInput, raw?: unknown): FutureServiceRead {
  const seg = up(p.householdSegmentType);
  const market = up(p.marketSegmentType);
  const status = up(p.serviceStatus);
  const qual = `${up(p.finalQual)} ${up(p.maxQual)}`.trim();
  const billing = up(p.billingStatus);

  const signals: string[] = [];
  let quote: string | null = null;

  if (FUTURE_SEGMENT_RE.test(seg)) { signals.push("segment_future"); quote ??= p.householdSegmentType ?? null; }
  if (FUTURE_SEGMENT_RE.test(market)) { signals.push("market_segment_future"); quote ??= p.marketSegmentType ?? null; }
  if (FUTURE_STATUS_RE.test(status)) { signals.push("service_status_future"); quote ??= p.serviceStatus ?? null; }
  if (FUTURE_QUAL_RE.test(qual)) { signals.push("qualification_future"); quote ??= p.finalQual ?? p.maxQual ?? null; }

  const isNowActive = seg === "NEW FIBER" && ACTIVE_BILLING.has(billing);
  if (isNowActive) signals.push("now_active");

  // The provider's explicit build-out contract, when it ships one (Frontier).
  const flags = readBuildFlags(raw);
  if (flags.futureEligible === true) { signals.push("provider_future_eligible"); }
  if (flags.buildOutStatus && BUILD_PENDING_RE.test(up(flags.buildOutStatus))) {
    signals.push("build_pending");
    quote ??= flags.buildOutStatus;
  }
  if (flags.hasExistingService === true) signals.push("has_existing_service");
  if (flags.pendingOrder === true) signals.push("pending_order");
  // Kinetic's own words: a future qualification, optionally with the technology
  // it will deliver and a month. "Future Fiber Build Planned" is the undated
  // sentinel it sends when the month is not set yet - a promise without a date,
  // not an absence of a promise.
  if (flags.futureQual === true) {
    signals.push("future_qual");
    quote ??= flags.completionText ?? flags.futureTechnology ?? "FutureQual";
  }
  if (flags.completionText && !normalizeDate(flags.completionText)) {
    signals.push("future_build_planned");
    quote ??= flags.completionText;
  }

  const found = raw === undefined ? null : findProviderDate(raw);
  if (found) signals.push("provider_date");

  // A stated turn-on date is itself a promise, even if the text vocabulary is
  // one we do not recognise. An already-active door is never "future": the
  // fiber is on and the account is taken, whatever else the payload says.
  const isFuture = !isNowActive && (
    signals.some((s) => s.endsWith("_future")) || signals.includes("build_pending")
    || signals.includes("provider_future_eligible") || signals.includes("future_qual")
    || signals.includes("future_build_planned") || !!found);

  return {
    isFuture,
    isNowActive,
    promisedDate: found?.date ?? null,
    dateSource: found ? "provider" : null,
    datePath: found?.path ?? null,
    signals,
    quote: quote ? String(quote).slice(0, 200) : null,
  };
}

// ── Date discovery ───────────────────────────────────────────────────────────

/**
 * Key names that mean "when will service be ready". Matched against the KEY,
 * never the value, so a date only counts when the provider labelled it as one.
 */
const DATE_KEY_RE = /(estimated|expected|target|planned|scheduled|projected|ready|launch|activation|activate|turn[\s_-]?on|available|availability|complete|completion|install|service|release|live)[\w]*(date|dt|on|at|time)?$|^eta$|^etd$/i;

/**
 * Keys that carry a date but never a turn-on promise. `addressCatalogDate` is
 * the one that matters here: it is present on real responses with values years
 * in the past, and treating it as an ETA would park every address in the hot
 * recheck lane forever.
 */
const DATE_KEY_DENY_RE = /catalog|birth|order|bill|invoice|created|updated|modified|audit|expire|expiry|expiration|cancel|disconnect|term|start|end|last|previous|history|sync/i;

/** Bounds on the payload walk so a hostile or huge body cannot burn the loop. */
const MAX_NODES = 2000;
const MAX_DEPTH = 8;

export interface ProviderDateHit { date: string; path: string; key: string; raw: string }

/**
 * Walk a provider payload for a date the provider itself labelled as a
 * service-ready date. Returns the first plausible hit in breadth order, with
 * the path so the ledger can record exactly where the promise came from.
 *
 * Returns null when the payload states no such date - the expected result
 * today, and the honest one.
 */
export function findProviderDate(raw: unknown, nowMs = Date.now()): ProviderDateHit | null {
  if (raw == null) return null;
  let root: unknown = raw;
  // uqualProvisioningResult arrives as a JSON string; a date could hide in it.
  if (typeof root === "string") {
    const s = root.trim();
    if (!s.startsWith("{") && !s.startsWith("[")) return null;
    try { root = JSON.parse(s); } catch { return null; }
  }
  if (typeof root !== "object") return null;

  const queue: Array<{ node: unknown; path: string; depth: number }> = [{ node: root, path: "", depth: 0 }];
  let seen = 0;
  while (queue.length) {
    const { node, path, depth } = queue.shift()!;
    if (node == null || depth > MAX_DEPTH || ++seen > MAX_NODES) continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && i < 100; i++) queue.push({ node: node[i], path: `${path}[${i}]`, depth: depth + 1 });
      continue;
    }
    if (typeof node !== "object") continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (value != null && typeof value === "object") {
        queue.push({ node: value, path: childPath, depth: depth + 1 });
        continue;
      }
      // A nested JSON string (uqualProvisioningResult) is worth descending into.
      if (typeof value === "string" && (value.trim().startsWith("{") || value.trim().startsWith("["))) {
        try { queue.push({ node: JSON.parse(value), path: childPath, depth: depth + 1 }); } catch { /* not JSON */ }
        continue;
      }
      if (!DATE_KEY_RE.test(key) || DATE_KEY_DENY_RE.test(key)) continue;
      const date = normalizeDate(value, nowMs);
      if (date) return { date, path: childPath, key, raw: String(value).slice(0, 60) };
    }
  }
  return null;
}

/**
 * Normalize a provider date to YYYY-MM-DD, rejecting anything that cannot be a
 * turn-on date: unparseable text, epoch-ish sentinels, dates far in the past, and
 * dates implausibly far ahead (a build we are told about ten years out is not
 * something the recheck lane should carry).
 */
export function normalizeDate(value: unknown, nowMs = Date.now()): string | null {
  if (value == null || typeof value === "boolean") return null;
  const s = String(value).trim();
  if (!s || /^(0|null|none|n\/?a|tbd|unknown)$/i.test(s)) return null;

  let ms: number | null = null;
  // Kinetic states the month, not the day: "NOV-2026", "Nov 2026", "NOVEMBER-2026".
  // A month promise resolves to its first day - the earliest the build could land.
  const mon = s.toUpperCase().match(/^([A-Z]{3,9})[-\s/]+(\d{4})$/);
  if (mon) {
    const idx = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"].indexOf(mon[1].slice(0, 3));
    if (idx >= 0) ms = Date.UTC(Number(mon[2]), idx, 1);
    else return null;
  }
  // Epoch seconds or milliseconds.
  if (ms != null) { /* month form already resolved */ }
  else if (/^\d{10}$/.test(s)) ms = Number(s) * 1000;
  else if (/^\d{13}$/.test(s)) ms = Number(s);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ms = Date.parse(`${s}T00:00:00Z`);
  else if (/^\d{4}\/\d{2}\/\d{2}$/.test(s)) ms = Date.parse(`${s.replace(/\//g, "-")}T00:00:00Z`);
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [m, d, y] = s.split("/").map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) ms = Date.UTC(y, m - 1, d);
  } else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (ms == null || !Number.isFinite(ms)) return null;

  const YEAR = 365 * 86_400_000;
  if (ms < nowMs - 5 * YEAR || ms > nowMs + 10 * YEAR) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── Recheck scheduling for the coming ledger ─────────────────────────────────

export type WatchBand = "hot" | "soon" | "watch";

export interface RecheckInput {
  /** Provider-stated or evidence-derived turn-on date (YYYY-MM-DD), if any. */
  promisedDate: string | null;
  /** When we first saw the future-service signal (epoch ms). */
  firstSeenMs: number;
  /** When we last checked it (epoch ms), or null if never re-checked. */
  lastCheckedMs: number | null;
  /** Hours between rechecks per band. */
  hotHours: number;
  soonHours: number;
  watchHours: number;
  /** A date within this many days (or past) puts the row in the hot band. */
  hotWindowDays: number;
  /** Switch-ons cluster in this age window after first observation. */
  flipFromDays: number;
  flipToDays: number;
  /** Days between re-reads of an UNDATED promise. A "Future Fiber Build
   *  Planned" with no month is months out, not hours: polling it on the watch
   *  cadence would cost ~24,000 checks a month across the undated population,
   *  far more than the once-only law saves. */
  undatedDays: number;
}

/**
 * When should this coming-soon address be bought again? Under the once-only
 * law this is the ONLY sanctioned re-purchase of an address, so it is worth
 * being deliberate: a dated promise drives the schedule, and an undated one
 * falls back to the observed flip window rather than a blind daily poll.
 */
export function nextRecheckAt(i: RecheckInput, nowMs = Date.now()): { dueAtMs: number; band: WatchBand; reason: string } {
  const DAY = 86_400_000;
  const etaMs = i.promisedDate ? Date.parse(`${i.promisedDate}T00:00:00Z`) : NaN;
  const hasEta = Number.isFinite(etaMs);
  const ageMs = nowMs - i.firstSeenMs;
  const inFlipWindow = ageMs >= i.flipFromDays * DAY && ageMs <= i.flipToDays * DAY;

  let band: WatchBand = "watch";
  let reason = "no_date";
  if (hasEta && etaMs <= nowMs + i.hotWindowDays * DAY) { band = "hot"; reason = etaMs <= nowMs ? "date_passed" : "date_near"; }
  else if (hasEta) { band = "soon"; reason = "date_future"; }
  else if (inFlipWindow) { band = "soon"; reason = "flip_window"; }

  // Undated and past the flip window: re-read on a slow cadence, not the daily
  // watch band. This is the difference between ~800 checks a month and 24,000.
  if (!hasEta && !inFlipWindow) {
    const from = i.lastCheckedMs ?? i.firstSeenMs;
    return { dueAtMs: from + i.undatedDays * DAY, band: "watch", reason: "undated_slow" };
  }

  // A far-future promise should not be polled at all until its window opens:
  // the next check is the day it enters the hot window, not a fixed cadence.
  if (band === "soon" && reason === "date_future") {
    return { dueAtMs: etaMs - i.hotWindowDays * DAY, band, reason };
  }
  const hours = band === "hot" ? i.hotHours : band === "soon" ? i.soonHours : i.watchHours;
  const from = i.lastCheckedMs ?? i.firstSeenMs;
  return { dueAtMs: from + hours * 3_600_000, band, reason };
}
