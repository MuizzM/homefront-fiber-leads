import { createHash } from "node:crypto";

export const RELIABILITY_FEATURES = ["SCANNER_HEARTBEAT", "COUNT_ATOMIC_UPDATES", "IDEMPOTENT_EMAIL",
  "IDEMPOTENT_ASSIGNMENT", "OUTBOX_PATTERN", "DEAD_LETTER_UI"] as const;
export type ReliabilityFeature = typeof RELIABILITY_FEATURES[number];

/** Explicit opt-in rollout: an unset or malformed percentage enables nobody.
 * Hashing the scope gives stable cohorts across processes, restarts and flags.
 * Safety checks and readers for already-issued durable work are never gated. */
export function reliabilityEnabled(feature: ReliabilityFeature, scope: number | string): boolean {
  const setting = process.env[feature]?.trim().toLowerCase();
  if (setting !== undefined && !["true", "on", "1"].includes(setting)) return false;
  if (typeof scope === "number" && (!Number.isSafeInteger(scope) || scope <= 0)) return false;
  if (typeof scope === "string" && !scope.trim()) return false;
  const cohort = typeof scope === "number" ? `tenant:${scope}` : scope;
  const allowed = (process.env.RELIABILITY_CANARY_TENANTS ?? "").split(",").map(s => s.trim());
  if (typeof scope === "number" && allowed.includes(String(scope))) return true;
  const percent = Number(process.env.RELIABILITY_ROLLOUT_PERCENT ?? 0);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return false;
  const bucket = createHash("sha256").update(`reliability-v1:${cohort}`).digest().readUInt32BE(0) % 10_000;
  return bucket < percent * 100;
}

// Auth has no authenticated tenant yet. Stable email cohorts treat known and
// unknown addresses identically and include organization-less administrators.
export function reliableOtpEnabled(email: string): boolean {
  const scope = `auth:${email.trim().toLowerCase()}`;
  return reliabilityEnabled("IDEMPOTENT_EMAIL", scope) && reliabilityEnabled("OUTBOX_PATTERN", scope);
}
