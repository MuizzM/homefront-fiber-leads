import { describe, it, expect } from "vitest";
import {
  normalizeSegment, isNewFiberSignal, decideTransition,
  DEFAULT_VERIFICATION_RULE, describeDetectionWindow, TRANSITION_MODEL_VERSION,
  type TargetSnapshot, type NormalizedObservation,
} from "../../shared/transition";

// The truth model is the moat. These prove the hard product laws hold in the
// PURE layer (no DB, no provider): a non-answer is never a "no", the first-ever
// New is a baseline not a proven flip, verification needs N-of-M, and
// OLD→NEW→OLD→NEW is two episodes.

const T = (ms: number) => ms;
function obs(p: Partial<NormalizedObservation>): NormalizedObservation {
  return { canonical: "NEW_FIBER", billingStatus: "N", conclusive: true, recognized: true, providerObservedAtMs: T(1000), ingestedAtMs: T(1000), failureKind: null, ...p };
}
const FRESH: TargetSnapshot = { everObservedSuccessfully: false, lastConclusiveCanonical: null, lastNonNewObservedAtMs: null, hasOpenCandidate: false, openEpisodeConfirmations: 0 };

describe("normalizeSegment — explicit table, no fuzzy matching", () => {
  it("normalizes whitespace + case to the canonical state", () => {
    expect(normalizeSegment("  new   fiber ").canonical).toBe("NEW_FIBER");
    expect(normalizeSegment("NEW FIBER").recognized).toBe(true);
    expect(normalizeSegment("Tenured").canonical).toBe("TENURED");
    expect(normalizeSegment("COPPER").canonical).toBe("EXISTING_COPPER");
  });
  it("NEVER fuzzy-matches toward NEW_FIBER — an unknown value is UNKNOWN + drift", () => {
    expect(normalizeSegment("NEWFIBER").canonical).toBe("UNKNOWN");     // no space → not the token
    expect(normalizeSegment("NEW FIBRE").recognized).toBe(false);       // misspelling → unknown
    expect(normalizeSegment("newish fiber").canonical).toBe("UNKNOWN");
    expect(normalizeSegment(null).canonical).toBe("UNKNOWN");
    expect(normalizeSegment("").canonical).toBe("UNKNOWN");
  });
  it("the model is versioned", () => { expect(TRANSITION_MODEL_VERSION).toBeGreaterThanOrEqual(1); });
});

describe("isNewFiberSignal — the door-knock target", () => {
  it("requires NEW_FIBER and billing N", () => {
    expect(isNewFiberSignal("NEW_FIBER", "N")).toBe(true);
    expect(isNewFiberSignal("NEW_FIBER", "Y")).toBe(false); // already a subscriber
    expect(isNewFiberSignal("TENURED", "N")).toBe(false);
  });
});

describe("decideTransition — the state machine", () => {
  it("LAW: a failed/inconclusive check NEVER changes fiber state", () => {
    for (const kind of ["timeout", "rate_limited", "auth", "challenge", "server", "malformed"] as const) {
      const d = decideTransition({ everObservedSuccessfully: true, lastConclusiveCanonical: "NEW_FIBER", lastNonNewObservedAtMs: null, hasOpenCandidate: false, openEpisodeConfirmations: 0 },
        obs({ conclusive: false, failureKind: kind, canonical: "INCONCLUSIVE", recognized: false }));
      expect(d.action).toBe("NO_CHANGE_FAILURE");
      expect(d.changesFiberState).toBe(false);
      expect(d.recordObservation).toBe(true); // still audited
    }
  });

  it("LAW: first-ever observation already New → BASELINE, not a proven transition", () => {
    const d = decideTransition(FRESH, obs({ canonical: "NEW_FIBER", billingStatus: "N" }));
    expect(d.action).toBe("RECORD_BASELINE_NEW");
    expect(d.discoveryState).toBe("BASELINE_NEW");
    expect(d.provisionalAlert).toBe(false);   // we cannot claim HomeFront watched it go live
    expect(d.detectionWindow).toBeUndefined();
  });

  it("LAW: proven non-New → New is a CANDIDATE with a provisional alert + censored window", () => {
    const prev: TargetSnapshot = { everObservedSuccessfully: true, lastConclusiveCanonical: "EXISTING_COPPER", lastNonNewObservedAtMs: T(500), hasOpenCandidate: false, openEpisodeConfirmations: 0 };
    const d = decideTransition(prev, obs({ canonical: "NEW_FIBER", providerObservedAtMs: T(2000) }));
    expect(d.action).toBe("OPEN_CANDIDATE");
    expect(d.provisionalAlert).toBe(true);
    expect(d.verifiedAlert).toBe(false);
    expect(d.detectionWindow).toEqual({ fromMs: 500, toMs: 2000 });
  });

  it("LAW: verification needs N-of-M — first confirm stays candidate, second verifies", () => {
    const rule = { n: 2, m: 3 };
    const openPrev: TargetSnapshot = { everObservedSuccessfully: true, lastConclusiveCanonical: "NEW_FIBER", lastNonNewObservedAtMs: T(500), hasOpenCandidate: true, openEpisodeConfirmations: 1 };
    const d = decideTransition(openPrev, obs({ canonical: "NEW_FIBER", providerObservedAtMs: T(3000) }), rule);
    expect(d.action).toBe("VERIFY_EPISODE");
    expect(d.verifiedAlert).toBe(true);
    // With a stricter rule the same observation only confirms.
    const strict = decideTransition({ ...openPrev, openEpisodeConfirmations: 1 }, obs({ canonical: "NEW_FIBER" }), { n: 5, m: 8 });
    expect(strict.action).toBe("CONFIRM_CANDIDATE");
    expect(strict.verifiedAlert).toBe(false);
  });

  it("LAW: unrecognized conclusive segment → schema drift, recorded, but NEVER changes fiber state", () => {
    // A relabelled/garbage segment is a NON-ANSWER — it must not overwrite a known
    // state or advance any watermark (else a label rename fabricates a false flip).
    const knownNew: TargetSnapshot = { everObservedSuccessfully: true, lastConclusiveCanonical: "NEW_FIBER", lastNonNewObservedAtMs: null, hasOpenCandidate: false, openEpisodeConfirmations: 0 };
    const d = decideTransition(knownNew, obs({ canonical: "UNKNOWN", recognized: false, conclusive: true }));
    expect(d.action).toBe("NO_CHANGE_DRIFT");
    expect(d.changesFiberState).toBe(false);
    expect(d.recordObservation).toBe(true);
    expect(d.schemaDrift).toBe(true);
    expect(d.isNewFiberSignal).toBe(false);
    expect(d.provisionalAlert).toBe(false);
  });

  it("LAW: a single-sighting rule (n≤1) VERIFIES on the opening flip — no phantom 2nd read", () => {
    const prev: TargetSnapshot = { everObservedSuccessfully: true, lastConclusiveCanonical: "EXISTING_COPPER", lastNonNewObservedAtMs: T(500), hasOpenCandidate: false, openEpisodeConfirmations: 0 };
    const d = decideTransition(prev, obs({ canonical: "NEW_FIBER", providerObservedAtMs: T(2000) }), { n: 1 });
    expect(d.action).toBe("OPEN_CANDIDATE");
    expect(d.verifyOnOpen).toBe(true);
    expect(d.verifiedAlert).toBe(true);
    expect(d.provisionalAlert).toBe(false);
    expect(d.discoveryState).toBe("VERIFIED_NEW");
  });

  it("regression: was New, now conclusively non-New → REGRESS (episode preserved)", () => {
    const prev: TargetSnapshot = { everObservedSuccessfully: true, lastConclusiveCanonical: "NEW_FIBER", lastNonNewObservedAtMs: null, hasOpenCandidate: true, openEpisodeConfirmations: 1 };
    const d = decideTransition(prev, obs({ canonical: "EXISTING_COPPER", billingStatus: "Y" }));
    expect(d.action).toBe("REGRESS");
    expect(d.discoveryState).toBe("REGRESSED");
  });

  it("detection window phrasing says 'First observed by HomeFront', never 'market first'", () => {
    const s = describeDetectionWindow({ fromMs: T(0), toMs: T(3_600_000) });
    expect(s).toMatch(/First observed by HomeFront/);
    expect(s).not.toMatch(/market first|before every competitor/i);
    expect(describeDetectionWindow({ fromMs: null, toMs: T(1000) })).toMatch(/no prior non-New/);
  });
});
