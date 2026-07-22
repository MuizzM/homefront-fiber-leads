import { isActiveBilling } from "./billingStatus";

export type CustomerSegment = "new_opportunity" | "existing_customer" | "unknown";
export type SegmentConfidence = "medium" | "low";

export interface CustomerClassification {
  segment: CustomerSegment;
  confidence: SegmentConfidence;
  confirmed: false;
  signals: string[];
  reason: string;
}

export function classifyCustomerOpportunity(input: {
  fiberAvailable: boolean;
  billingStatus?: string | null;
  householdSegmentType?: string | null;
  serviceStatus?: string | null;
}): CustomerClassification {
  const billing = String(input.billingStatus ?? "").trim().toUpperCase();
  const segment = String(input.householdSegmentType ?? "").trim().toUpperCase();
  const signals = [
    input.fiberAvailable ? "provider_fiber_available" : "provider_fiber_unavailable",
    billing === "N" ? "provider_billing_no_active_account" : isActiveBilling(billing) ? "provider_billing_active_account" : "provider_billing_unknown",
    segment ? `provider_segment_${segment.toLowerCase().replace(/\s+/g, "_")}` : "provider_segment_unknown",
  ];
  if (!input.fiberAvailable) return {
    segment: "unknown", confidence: "low", confirmed: false, signals,
    reason: "No serviceable fiber is currently indicated, so customer status is not inferred.",
  };
  if (billing === "N") return {
    segment: "new_opportunity", confidence: "medium", confirmed: false, signals,
    reason: "Kinetic indicates fiber serviceability and no active billing account. Provider-indicated, not independently confirmed.",
  };
  if (isActiveBilling(billing)) return {
    segment: "existing_customer", confidence: "medium", confirmed: false, signals,
    reason: "Kinetic indicates an active billing account. Provider-indicated, not independently confirmed.",
  };
  return {
    segment: "unknown", confidence: "low", confirmed: false, signals,
    reason: "Fiber is serviceable, but the provider response has no decisive billing signal.",
  };
}

export type FiberTransitionStatus = "check_failed" | "baseline_available" | "unavailable" | "freshly_available" | "still_available" | "went_unavailable";

export function classifyFiberAvailabilityTransition(
  previous: { everObserved: boolean; fiberAvailable: boolean },
  current: { conclusive: boolean; fiberAvailable: boolean },
): { status: FiberTransitionStatus; fresh: boolean; record: boolean; reason: string } {
  if (!current.conclusive) return { status: "check_failed", fresh: false, record: false, reason: "Non-answer; prior state preserved." };
  if (!previous.everObserved) return current.fiberAvailable
    ? { status: "baseline_available", fresh: false, record: true, reason: "First observation is available; age is unknown." }
    : { status: "unavailable", fresh: false, record: true, reason: "First conclusive observation is unavailable." };
  if (!previous.fiberAvailable && current.fiberAvailable) return { status: "freshly_available", fresh: true, record: true, reason: "Proven unavailable-to-available fiber transition." };
  if (previous.fiberAvailable && current.fiberAvailable) return { status: "still_available", fresh: false, record: true, reason: "Fiber remains available." };
  if (previous.fiberAvailable && !current.fiberAvailable) return { status: "went_unavailable", fresh: false, record: true, reason: "Previously available fiber is no longer indicated." };
  return { status: "unavailable", fresh: false, record: true, reason: "Fiber remains unavailable." };
}

export function opportunityRank(input: { fresh: boolean; customerSegment: CustomerSegment; crossVerified: boolean; clusterDensity: number; ageHours: number }): number {
  const recency = Math.max(0, 20 - Math.max(0, input.ageHours) / 12);
  const density = Math.min(15, Math.log2(Math.max(1, input.clusterDensity) + 1) * 5);
  return Math.round(Math.min(100,
    (input.fresh ? 45 : 0) + (input.customerSegment === "new_opportunity" ? 25 : 0) +
    (input.crossVerified ? 15 : 0) + recency + density,
  ));
}
