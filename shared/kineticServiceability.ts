export const KINETIC_SERVICEABILITY_MODEL_VERSION = 1;

export type KineticServiceabilityState = "FIBER_LIVE" | "NON_FIBER" | "UNKNOWN";
export type KineticDiscoveryState = "BASELINE_FIBER" | "NON_FIBER" | "CANDIDATE_FRESH" | "VERIFIED_FRESH" | "REGRESSED" | "SOURCE_ERROR";

export interface KineticServiceabilitySignal {
  isLive: boolean | null;
  technologyType: string | null;
  observedAtMs: number;
  conclusive?: boolean;
}

export interface KineticServiceabilitySnapshot {
  previousState: KineticServiceabilityState | null;
  previousDiscoveryState?: KineticDiscoveryState | null;
  lastNonFiberAtMs: number | null;
  openCandidate: boolean;
  confirmationCount: number;
}

export interface KineticServiceabilityDecision {
  canonicalState: KineticServiceabilityState;
  discoveryState: KineticDiscoveryState;
  action: "BASELINE" | "RECORD_NON_FIBER" | "OPEN_CANDIDATE" | "CONFIRM" | "VERIFY" | "REGRESS" | "NO_CHANGE" | "NO_CHANGE_FAILURE";
  changesCurrentState: boolean;
  fresh: boolean;
  verificationCount: number;
  detectionWindow: { fromMs: number; toMs: number } | null;
  reason: string;
}

export function classifyKineticServiceability(signal: KineticServiceabilitySignal): KineticServiceabilityState {
  if (signal.conclusive === false || signal.isLive == null) return "UNKNOWN";
  if (!signal.isLive) return "NON_FIBER";
  const technology = String(signal.technologyType ?? "").trim().toLowerCase().replace(/[_-]+/g, " ");
  return /\bfiber\b|\bftth\b|\bfttp\b|fiber to the (home|premises)/.test(technology) ? "FIBER_LIVE" : "UNKNOWN";
}

export function decideKineticServiceability(
  previous: KineticServiceabilitySnapshot,
  signal: KineticServiceabilitySignal,
  requiredConfirmations = 2,
): KineticServiceabilityDecision {
  const required = Math.max(1, Math.floor(requiredConfirmations));
  const canonicalState = classifyKineticServiceability(signal);
  if (canonicalState === "UNKNOWN") return {
    canonicalState, discoveryState: "SOURCE_ERROR", action: "NO_CHANGE_FAILURE", changesCurrentState: false,
    fresh: false, verificationCount: previous.confirmationCount, detectionWindow: null,
    reason: "Provider response did not contain a conclusive explicit fiber serviceability state.",
  };

  if (previous.previousState == null) return canonicalState === "FIBER_LIVE" ? {
    canonicalState, discoveryState: "BASELINE_FIBER", action: "BASELINE", changesCurrentState: true,
    fresh: false, verificationCount: 0, detectionWindow: null,
    reason: "First successful observation is fiber-live; recorded as baseline, never as a fresh transition.",
  } : {
    canonicalState, discoveryState: "NON_FIBER", action: "RECORD_NON_FIBER", changesCurrentState: true,
    fresh: false, verificationCount: 0, detectionWindow: null,
    reason: "First successful observation establishes a non-fiber baseline.",
  };

  if (canonicalState === "NON_FIBER") return previous.previousState === "FIBER_LIVE" || previous.openCandidate ? {
    canonicalState, discoveryState: "REGRESSED", action: "REGRESS", changesCurrentState: true,
    fresh: false, verificationCount: 0, detectionWindow: null,
    reason: "A conclusive non-fiber result superseded the prior fiber-live state.",
  } : {
    canonicalState, discoveryState: "NON_FIBER", action: "RECORD_NON_FIBER", changesCurrentState: true,
    fresh: false, verificationCount: 0, detectionWindow: null,
    reason: "Address remains conclusively non-fiber.",
  };

  if (previous.openCandidate) {
    const verificationCount = previous.confirmationCount + 1;
    const verified = verificationCount >= required;
    return {
      canonicalState, discoveryState: verified ? "VERIFIED_FRESH" : "CANDIDATE_FRESH", action: verified ? "VERIFY" : "CONFIRM",
      changesCurrentState: true, fresh: verified, verificationCount,
      detectionWindow: previous.lastNonFiberAtMs == null ? null : { fromMs: previous.lastNonFiberAtMs, toMs: signal.observedAtMs },
      reason: verified ? `Fresh fiber transition verified (${verificationCount}/${required}).` : `Fresh fiber confirmation ${verificationCount}/${required}.`,
    };
  }

  if (previous.previousState === "NON_FIBER") {
    const verified = required === 1;
    return {
      canonicalState, discoveryState: verified ? "VERIFIED_FRESH" : "CANDIDATE_FRESH", action: "OPEN_CANDIDATE",
      changesCurrentState: true, fresh: verified, verificationCount: 1,
      detectionWindow: previous.lastNonFiberAtMs == null ? null : { fromMs: previous.lastNonFiberAtMs, toMs: signal.observedAtMs },
      reason: verified ? "Non-fiber to fiber-live transition verified by the configured single-read rule." : "Non-fiber to fiber-live transition detected; independent repeat verification is required.",
    };
  }

  const remainsVerified=previous.previousDiscoveryState==="VERIFIED_FRESH";
  return {
    canonicalState, discoveryState: remainsVerified?"VERIFIED_FRESH":"BASELINE_FIBER", action: "NO_CHANGE", changesCurrentState: false,
    fresh: remainsVerified, verificationCount: previous.confirmationCount, detectionWindow: null,
    reason: "Address was already fiber-live; no new transition occurred.",
  };
}
