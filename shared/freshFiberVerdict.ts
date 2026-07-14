export type FreshFiberVerdict = "fresh" | "not_fresh" | "unverified";

export interface FreshFiberEvidence {
  apiSource?: string | null;
  blocked?: boolean | null;
  fiberStatus?: string | null;
  isNewFiber?: boolean | null;
  fiberAvailable?: boolean | null;
  billingStatus?: string | null;
}
export interface FreshFiberDecision {
  verdict: FreshFiberVerdict;
  /** null means the provider did not give a usable answer; it is never coerced to false. */
  isFreshFiber: boolean | null;
  label: "Fresh fiber" | "Not fresh fiber" | "Couldn't verify";
  message: string;
}

/**
 * The single business verdict for every scan surface.
 *
 * Fresh means all three sales signals are present in one conclusive response:
 * Kinetic says NEW FIBER, actual fiber technology is serviceable, and billing
 * says there is no active subscriber. A timeout/throttle/schema drift is a
 * non-answer—not a false negative—and must remain recheckable.
 */
export function decideFreshFiber(input: FreshFiberEvidence): FreshFiberDecision {
  const sourceFailed = input.apiSource === "failed";
  const unknown = !input.fiberStatus || input.fiberStatus === "unknown";
  if (sourceFailed || input.blocked === true || unknown) {
    return {
      verdict: "unverified",
      isFreshFiber: null,
      label: "Couldn't verify",
      message: "The provider did not return a reliable answer. Recheck this address.",
    };
  }

  const fresh = input.isNewFiber === true
    && input.fiberAvailable === true
    && String(input.billingStatus ?? "").toUpperCase() === "N";
  if (fresh) {
    return {
      verdict: "fresh",
      isFreshFiber: true,
      label: "Fresh fiber",
      message: "Yes—fresh fiber is available and no active subscriber is indicated.",
    };
  }

  return {
    verdict: "not_fresh",
    isFreshFiber: false,
    label: "Not fresh fiber",
    message: "No—the provider did not return a fresh, unsubscribed fiber opportunity.",
  };
}
