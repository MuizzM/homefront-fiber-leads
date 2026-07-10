// ── Transition truth model — the Market Birth Radar core ──────────────────────
// The moat is not "having addresses". It is proving EXACTLY what changed and
// when HomeFront first observed it. This module is the single, versioned source
// of that truth: it normalizes a provider segment, decides whether an
// observation is a baseline, a fresh candidate transition, a confirmation, or a
// regression, and maintains episode identity so OLD→NEW→OLD→NEW yields TWO
// legitimate transition episodes. Pure + deterministic + fully unit-tested —
// no DB, no provider, no clock reads except the timestamps passed in.
//
// Hard product laws encoded here:
//  1. A failed / inconclusive check NEVER changes fiber state. A non-answer is
//     not a "no" and not a "yes".
//  2. The FIRST successful observation being NEW FIBER is a BASELINE, not a
//     proven recent transition — we cannot say HomeFront watched it go live.
//  3. A transition is only VERIFIED after an admin-configurable N-of-M rule.
//  4. Detection time is interval-censored: lastNonNew ≤ real change ≤ firstNew.
//     We display the window honestly, never a false precise "went live at".
//  5. "First observed by HomeFront" — never "first in market".

export const TRANSITION_MODEL_VERSION = 1;

// ── Canonical provider states (what the provider says) ────────────────────────
export type CanonicalState =
  | "NEW_FIBER"
  | "PROSPECT"
  | "EXISTING_FIBER"
  | "EXISTING_COPPER"
  | "TENURED"
  | "NO_SERVICE"
  | "UNKNOWN"        // a value we don't recognize → emits a schema-drift signal
  | "INCONCLUSIVE";  // no usable answer (failure/timeout/challenge/heuristic)

// Explicit mapping table — NO fuzzy matching. A value not present here is
// UNKNOWN (and flagged), never coerced toward NEW_FIBER. Keyed by the
// normalized (trim → upper → collapse-whitespace) provider segment string.
const SEGMENT_MAP: Record<string, CanonicalState> = {
  "NEW FIBER": "NEW_FIBER",
  "PROSPECT": "PROSPECT",
  "EXISTING FIBER": "EXISTING_FIBER",
  "TENURED": "TENURED",
  "TENURED FIBER": "TENURED",
  "COPPER": "EXISTING_COPPER",
  "EXISTING COPPER": "EXISTING_COPPER",
  "NO SERVICE": "NO_SERVICE",
  "NO_SERVICE": "NO_SERVICE",
};

// Normalize a raw provider segment deterministically. Returns the canonical
// state and whether the raw value was recognized (unrecognized → schema drift).
export function normalizeSegment(raw: string | null | undefined): { canonical: CanonicalState; recognized: boolean; normalizedRaw: string } {
  if (raw == null) return { canonical: "UNKNOWN", recognized: false, normalizedRaw: "" };
  const normalizedRaw = String(raw).trim().toUpperCase().replace(/\s+/g, " ");
  if (normalizedRaw === "") return { canonical: "UNKNOWN", recognized: false, normalizedRaw };
  const mapped = SEGMENT_MAP[normalizedRaw];
  if (mapped) return { canonical: mapped, recognized: true, normalizedRaw };
  return { canonical: "UNKNOWN", recognized: false, normalizedRaw };
}

// The door-knock signal: a serviceable NEW FIBER address with no current
// subscriber (billing "N"). This is the operational definition of the target
// the whole product is built to catch.
export function isNewFiberSignal(canonical: CanonicalState, billingStatus: string | null | undefined): boolean {
  return canonical === "NEW_FIBER" && (billingStatus ?? "").toUpperCase() === "N";
}

// ── Discovery states (HomeFront's operational view of a target) ───────────────
export type DiscoveryState =
  | "BASELINE_NEW"   // first-ever successful obs was already New — can't prove recent
  | "CANDIDATE_NEW"  // proven non-New → New flip, awaiting confirmation
  | "VERIFIED_NEW"   // candidate confirmed by the N-of-M rule
  | "REGRESSED"      // was New, now reads non-New (worth review)
  | "STALE"          // last successful observation older than staleAfter
  | "NON_NEW"        // known, not New Fiber
  | "RATE_LIMITED"
  | "AUTH_ERROR"
  | "SOURCE_ERROR";

// ── An ingested provider observation, already normalized ──────────────────────
export interface NormalizedObservation {
  canonical: CanonicalState;
  billingStatus: string | null;
  conclusive: boolean;         // false = failure/timeout/challenge/heuristic → no state change
  recognized: boolean;         // false = schema drift on the raw segment
  providerObservedAtMs: number; // provider's own "as of" time
  ingestedAtMs: number;         // when HomeFront received it
  // A coarse failure category for non-conclusive observations, so the caller
  // can drive discovery state without inspecting transport details.
  failureKind?: "timeout" | "rate_limited" | "auth" | "challenge" | "server" | "malformed" | "heuristic" | null;
}

// The prior snapshot of a target (from target_state), plus the OPEN episode if any.
export interface TargetSnapshot {
  everObservedSuccessfully: boolean;
  lastConclusiveCanonical: CanonicalState | null; // last KNOWN (conclusive) state
  lastNonNewObservedAtMs: number | null;          // last conclusive non-New obs time
  hasOpenCandidate: boolean;                        // an unverified CANDIDATE_NEW episode is open
  openEpisodeConfirmations: number;                 // confirmations accrued on the open episode
}

// The confirmation rule: require N successful New-Fiber confirmations to VERIFY a
// candidate. Because ANY conclusive non-New observation regresses (and closes)
// the open episode, the N confirmations are necessarily a contiguous run of
// successful New reads — a separate "M window" cannot bind, so `m` is retained
// only as an OPTIONAL advisory display value and is NOT used for logic (keeping
// what we implement identical to what we show). Admin-configurable per source.
export interface VerificationRule { n: number; m?: number }
export const DEFAULT_VERIFICATION_RULE: VerificationRule = { n: 2 };

export type TransitionAction =
  | "NONE"                 // nothing material (e.g. still non-New, or a repeat)
  | "RECORD_BASELINE_NEW"  // first-ever obs is New → baseline (no transition claim)
  | "OPEN_CANDIDATE"       // proven non-New → New → new episode + provisional alert
  | "CONFIRM_CANDIDATE"    // another New obs on the open episode (toward N-of-M)
  | "VERIFY_EPISODE"       // N-of-M satisfied → episode becomes VERIFIED_NEW
  | "REGRESS"              // was New, now conclusively non-New
  | "RECORD_NON_NEW"       // conclusive non-New, no open candidate
  | "NO_CHANGE_DRIFT"      // conclusive but UNRECOGNIZED segment — state untouched
  | "NO_CHANGE_FAILURE";   // inconclusive — state untouched

export interface TransitionDecision {
  action: TransitionAction;
  discoveryState: DiscoveryState;
  recordObservation: boolean;   // append to target_observations?
  changesFiberState: boolean;   // may CAS target_state?
  isNewFiberSignal: boolean;    // is this a hot door-knock target right now?
  schemaDrift: boolean;         // unrecognized provider value
  provisionalAlert: boolean;    // fire an immediate, clearly-provisional alert
  verifiedAlert: boolean;       // fire the "verified" alert
  verifyOnOpen?: boolean;       // n≤1 → the opening flip is itself verified
  // Interval-censored detection window for a candidate/verified transition:
  detectionWindow?: { fromMs: number | null; toMs: number };
  reason: string;
}

// The heart: prev snapshot × fresh normalized observation → decision.
export function decideTransition(
  prev: TargetSnapshot,
  obs: NormalizedObservation,
  rule: VerificationRule = DEFAULT_VERIFICATION_RULE,
): TransitionDecision {
  // LAW 1 — a non-conclusive observation NEVER changes fiber state. We still
  // append it as an attempt (for auditing + backoff), but touch no state.
  if (!obs.conclusive) {
    const ds: DiscoveryState =
      obs.failureKind === "rate_limited" ? "RATE_LIMITED"
      : obs.failureKind === "auth" ? "AUTH_ERROR"
      : "SOURCE_ERROR";
    return {
      action: "NO_CHANGE_FAILURE", discoveryState: ds,
      recordObservation: true, changesFiberState: false, isNewFiberSignal: false,
      schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
      reason: `inconclusive (${obs.failureKind ?? "unknown"}) — no state change`,
    };
  }

  // An unrecognized (schema-drift) segment is a NON-ANSWER about fiber state —
  // LAW 1 extends to it. Record the attempt + raise the drift signal, but NEVER
  // overwrite canonical_state and NEVER advance the non-New / conclusive
  // watermarks off an unrecognized value. (Doing so would erase a proven state
  // and later fabricate a false "went live" transition the moment the provider's
  // label is restored — the exact false claim the product must never make.)
  if (!obs.recognized || obs.canonical === "UNKNOWN") {
    return {
      action: "NO_CHANGE_DRIFT", discoveryState: "SOURCE_ERROR",
      recordObservation: true, changesFiberState: false, isNewFiberSignal: false,
      schemaDrift: true, provisionalAlert: false, verifiedAlert: false,
      reason: "unrecognized provider segment — recorded + schema-drift signal; fiber state untouched",
    };
  }

  const isNew = obs.canonical === "NEW_FIBER";
  const hotSignal = isNewFiberSignal(obs.canonical, obs.billingStatus);

  // ── First-ever successful observation ──────────────────────────────────────
  if (!prev.everObservedSuccessfully) {
    if (isNew) {
      // LAW 2 — currently New, but we cannot prove a recent flip.
      return {
        action: "RECORD_BASELINE_NEW", discoveryState: "BASELINE_NEW",
        recordObservation: true, changesFiberState: true, isNewFiberSignal: hotSignal,
        schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
        reason: "first observation already New Fiber — baseline, not a proven transition",
      };
    }
    return {
      action: "RECORD_NON_NEW", discoveryState: "NON_NEW",
      recordObservation: true, changesFiberState: true, isNewFiberSignal: false,
      schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
      reason: "first observation — not serviceable New Fiber",
    };
  }

  // ── We have prior conclusive history ────────────────────────────────────────
  const wasNew = prev.lastConclusiveCanonical === "NEW_FIBER";

  if (isNew && prev.hasOpenCandidate) {
    // Another New observation on an open candidate → confirmation toward N-of-M.
    const confirmations = prev.openEpisodeConfirmations + 1;
    if (confirmations >= rule.n) {
      return {
        action: "VERIFY_EPISODE", discoveryState: "VERIFIED_NEW",
        recordObservation: true, changesFiberState: true, isNewFiberSignal: hotSignal,
        schemaDrift: false, provisionalAlert: false, verifiedAlert: true,
        detectionWindow: { fromMs: prev.lastNonNewObservedAtMs, toMs: obs.providerObservedAtMs },
        reason: `confirmed New Fiber (${confirmations}/${rule.n}) — verified transition`,
      };
    }
    return {
      action: "CONFIRM_CANDIDATE", discoveryState: "CANDIDATE_NEW",
      recordObservation: true, changesFiberState: true, isNewFiberSignal: hotSignal,
      schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
      detectionWindow: { fromMs: prev.lastNonNewObservedAtMs, toMs: obs.providerObservedAtMs },
      reason: `New Fiber confirmation ${confirmations}/${rule.n}`,
    };
  }

  if (isNew && !wasNew) {
    // LAW 4 — a proven non-New → New flip. Open a fresh candidate episode with
    // an interval-censored window and fire a PROVISIONAL alert immediately. If
    // the rule requires only a single sighting (n ≤ 1), the opening flip is
    // itself the verification — no phantom second observation is needed.
    const verifyOnOpen = rule.n <= 1;
    return {
      action: "OPEN_CANDIDATE", discoveryState: verifyOnOpen ? "VERIFIED_NEW" : "CANDIDATE_NEW",
      recordObservation: true, changesFiberState: true, isNewFiberSignal: hotSignal,
      schemaDrift: false, provisionalAlert: !verifyOnOpen, verifiedAlert: verifyOnOpen, verifyOnOpen,
      detectionWindow: { fromMs: prev.lastNonNewObservedAtMs, toMs: obs.providerObservedAtMs },
      reason: verifyOnOpen
        ? "flipped non-New → New Fiber — verified (single-sighting rule; first observed by HomeFront)"
        : "flipped non-New → New Fiber — candidate transition (first observed by HomeFront)",
    };
  }

  if (isNew && wasNew && !prev.hasOpenCandidate) {
    // Still New, no open episode (already baseline/verified) — nothing new.
    return {
      action: "NONE", discoveryState: hotSignal ? "VERIFIED_NEW" : "NON_NEW",
      recordObservation: true, changesFiberState: false, isNewFiberSignal: hotSignal,
      schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
      reason: "already known New Fiber — no new transition",
    };
  }

  // Non-New now. If it was New, this is a regression (close any open episode).
  if (!isNew && wasNew) {
    return {
      action: "REGRESS", discoveryState: "REGRESSED",
      recordObservation: true, changesFiberState: true, isNewFiberSignal: false,
      schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
      reason: "was New Fiber, now reads non-New — regression (episode preserved)",
    };
  }

  // Non-New now, non-New before — a plain conclusive non-New observation.
  return {
    action: "RECORD_NON_NEW", discoveryState: "NON_NEW",
    recordObservation: true, changesFiberState: true, isNewFiberSignal: false,
    schemaDrift: false, provisionalAlert: false, verifiedAlert: false,
    reason: "still not serviceable New Fiber",
  };
}

// Whether a decision should OPEN a new episode (increment episodeSequence).
export function opensEpisode(action: TransitionAction): boolean {
  return action === "OPEN_CANDIDATE";
}
// Whether a decision advances/verifies the CURRENT open episode.
export function advancesEpisode(action: TransitionAction): boolean {
  return action === "CONFIRM_CANDIDATE" || action === "VERIFY_EPISODE";
}
// Whether a decision closes the current open episode (regression).
export function closesEpisode(action: TransitionAction): boolean {
  return action === "REGRESS";
}

// Human, defensible phrasing for a detection window — the honest "first observed
// by HomeFront" claim with its interval-censored uncertainty.
export function describeDetectionWindow(w: { fromMs: number | null; toMs: number }): string {
  if (w.fromMs == null) return `First observed by HomeFront as New Fiber (no prior non-New observation to bound the change)`;
  const hrs = Math.max(0, Math.round((w.toMs - w.fromMs) / 3_600_000));
  return `First observed by HomeFront as New Fiber; provider changed within a ${hrs}h window (last seen non-New ${new Date(w.fromMs).toISOString()} → first seen New ${new Date(w.toMs).toISOString()})`;
}
