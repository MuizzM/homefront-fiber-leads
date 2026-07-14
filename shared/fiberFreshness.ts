export type VerificationState = "unverified" | "verified" | "stale" | "failed";
export type ServiceabilityState = "live" | "coming_soon" | "no_service" | "unknown";

export interface FreshnessInput {
  serviceability: ServiceabilityState;
  conclusive: boolean;
  checkedAtMs: number | null;
  firstSeenLiveAtMs?: number | null;
  independentEvidenceAtMs?: number | null;
  transitionObserved?: boolean;
  providerConfidence?: number | null;
  nowMs?: number;
}

export interface FreshnessScore {
  score: number;
  verificationState: VerificationState;
  ageHours: number | null;
  factors: {
    recency: number;
    transition: number;
    corroboration: number;
    providerConfidence: number;
  };
  formulaVersion: "fiber-freshness-v1";
  explanation: string[];
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Deterministic, side-effect-free freshness score. A failed/non-conclusive
 * check can never become a positive availability claim, regardless of age.
 */
export function calculateFiberFreshness(input: FreshnessInput): FreshnessScore {
  const now = input.nowMs ?? Date.now();
  const checkedAt = input.checkedAtMs;
  const ageHours = checkedAt == null ? null : Math.max(0, (now - checkedAt) / 3_600_000);
  const explanation: string[] = [];

  if (!input.conclusive || checkedAt == null || input.serviceability === "unknown") {
    return {
      score: 0,
      verificationState: input.conclusive ? "unverified" : "failed",
      ageHours,
      factors: { recency: 0, transition: 0, corroboration: 0, providerConfidence: 0 },
      formulaVersion: "fiber-freshness-v1",
      explanation: [input.conclusive ? "No conclusive dated availability observation" : "Provider check was inconclusive"],
    };
  }

  const verifiedAgeHours = ageHours ?? Number.POSITIVE_INFINITY;
  const recency = verifiedAgeHours <= 24 ? 1 : verifiedAgeHours <= 72 ? 0.85 : verifiedAgeHours <= 168 ? 0.65 : verifiedAgeHours <= 720 ? 0.35 : 0.1;
  const transition = input.transitionObserved || input.firstSeenLiveAtMs != null ? 1 : 0;
  const corroboration = input.independentEvidenceAtMs != null ? 1 : 0;
  const providerConfidence = clamp01(input.providerConfidence ?? 0.5);
  const score = Math.round(100 * (
    recency * 0.45 + transition * 0.25 + corroboration * 0.2 + providerConfidence * 0.1
  ));

  explanation.push(verifiedAgeHours <= 24 ? "Verified in the last 24 hours" : `Last verified ${Math.round(verifiedAgeHours)} hours ago`);
  if (transition) explanation.push("Unavailable-to-live transition observed");
  if (corroboration) explanation.push("Independent evidence corroborates availability");
  if (input.serviceability !== "live") explanation.push(`Current serviceability is ${input.serviceability.replace("_", " ")}`);

  return {
    score,
    verificationState: verifiedAgeHours > 720 ? "stale" : "verified",
    ageHours,
    factors: { recency, transition, corroboration, providerConfidence },
    formulaVersion: "fiber-freshness-v1",
    explanation,
  };
}

export interface ComingSoonScheduleInput {
  consecutiveComingSoon: number;
  lastChangedAtMs: number | null;
  providerHintDays?: number | null;
  nowMs?: number;
}

export function scheduleComingSoonRecheck(input: ComingSoonScheduleInput): {
  nextCheckAtMs: number;
  intervalHours: number;
  priority: "urgent" | "high" | "normal" | "low";
  reason: string;
} {
  const now = input.nowMs ?? Date.now();
  const changedHoursAgo = input.lastChangedAtMs == null ? null : Math.max(0, (now - input.lastChangedAtMs) / 3_600_000);
  const hintedHours = input.providerHintDays == null ? null : Math.max(12, input.providerHintDays * 24);
  let intervalHours = input.consecutiveComingSoon <= 1 ? 24 : input.consecutiveComingSoon <= 3 ? 72 : input.consecutiveComingSoon <= 8 ? 168 : 336;
  if (changedHoursAgo != null && changedHoursAgo <= 72) intervalHours = Math.min(intervalHours, 24);
  if (hintedHours != null) intervalHours = Math.min(intervalHours, hintedHours);
  const priority = intervalHours <= 24 ? "urgent" : intervalHours <= 72 ? "high" : intervalHours <= 168 ? "normal" : "low";
  return {
    nextCheckAtMs: now + intervalHours * 3_600_000,
    intervalHours,
    priority,
    reason: changedHoursAgo != null && changedHoursAgo <= 72
      ? "Recent state change requires close verification"
      : `Adaptive backoff after ${Math.max(1, input.consecutiveComingSoon)} consecutive coming-soon observations`,
  };
}
