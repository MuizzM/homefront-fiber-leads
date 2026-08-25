import { describe, expect, it } from "vitest";
import {
  NEEDS_FIX_NOTE,
  REQUEUE_DETAIL_MAX,
  REQUEUE_REASONS,
  isRequeueReason,
  requeueDetail,
  requeueReasonFor,
} from "@shared/scanRequeueReason";

// The requeue vocabulary is only useful if it is CLOSED and TOTAL: closed so a
// `GROUP BY reason` over fiber_job_events has a bounded, meaningful key set, and
// total so no requeue can ever land without one. Both properties are asserted
// here, at the definition, rather than only at the engine.

describe("requeue reason vocabulary", () => {
  it("names every reason the operator's runbook query groups by", () => {
    // The seven the plan called out by name, plus the codes the call sites use.
    for (const reason of [
      "transient_transport",
      "inconclusive_address_needs_fix",
      "auth_denied",
      "token_unavailable",
      "breaker_open",
      "budget",
      "superseded",
    ]) {
      expect(REQUEUE_REASONS).toContain(reason);
    }
    expect(new Set(REQUEUE_REASONS).size).toBe(REQUEUE_REASONS.length); // no duplicates
  });

  it("rejects anything outside the closed set", () => {
    expect(isRequeueReason("auth_denied")).toBe(true);
    expect(isRequeueReason("AUTH_DENIED")).toBe(false);
    expect(isRequeueReason("provider_blocked")).toBe(false); // the coarse category, not a reason
    expect(isRequeueReason(undefined)).toBe(false);
    expect(isRequeueReason(null)).toBe(false);
    expect(isRequeueReason(403)).toBe(false);
  });
});

describe("requeueReasonFor", () => {
  it("prefers the producer's own typed stamp over any note text", () => {
    // Deliberately contradictory: the note says needs-fix, the stamp says auth.
    // The stamp wins - it is the producer's first-hand knowledge.
    expect(
      requeueReasonFor({ retryReason: "auth_denied", notes: "AddressNeedsFix", blocked: true }),
    ).toBe("auth_denied");
  });

  it("ignores a stamp that is not in the vocabulary", () => {
    expect(requeueReasonFor({ retryReason: "made_up_code", notes: "", blocked: true }))
      .toBe("transient_transport");
  });

  it("falls back to the shared needs-fix pattern for an unstamped checker", () => {
    // A checker written before retryReason existed (or an injected replay
    // checker) must still land in the SAME lane the engine's backoff uses.
    const notes = "Non-conclusive response (success=false, AddressNeedsFix)";
    expect(NEEDS_FIX_NOTE.test(notes)).toBe(true);
    expect(requeueReasonFor({ notes, checkFailed: true } as any))
      .toBe("inconclusive_address_needs_fix");
    expect(requeueReasonFor({ notes: "AddressSuggestions returned" }))
      .toBe("inconclusive_address_needs_fix");
  });

  it("derives the transport-level reason from an HTTP status when there is no stamp", () => {
    expect(requeueReasonFor({ httpStatus: 401, blocked: true })).toBe("auth_denied");
    expect(requeueReasonFor({ httpStatus: 403, blocked: true })).toBe("auth_denied");
    expect(requeueReasonFor({ httpStatus: 429, blocked: true })).toBe("rate_limited");
    expect(requeueReasonFor({ httpStatus: 503, blocked: true })).toBe("provider_server_error");
    expect(requeueReasonFor({ httpStatus: 422, blocked: true })).toBe("provider_bad_request");
  });

  it("reads the legacy note shapes the live scanner has always written", () => {
    expect(requeueReasonFor({ notes: "No authorized session - mint failed (unresolved, recheck)" }))
      .toBe("token_unavailable");
    expect(requeueReasonFor({ notes: "Check failed (transient) - fetch failed", blocked: true }))
      .toBe("transient_transport");
    expect(requeueReasonFor({ notes: "Malformed 200 response (unparseable) - unresolved, recheck" }))
      .toBe("inconclusive_response");
  });

  it("is total: never undefined, even for an empty or missing signal", () => {
    expect(requeueReasonFor(null)).toBe("unknown");
    expect(requeueReasonFor(undefined)).toBe("unknown");
    // An unnameable non-answer still resolves to a code, so the operator's
    // GROUP BY has no NULL bucket to guess about.
    expect(isRequeueReason(requeueReasonFor({}))).toBe(true);
    expect(isRequeueReason(requeueReasonFor({ blocked: true, notes: "" }))).toBe(true);
  });
});

describe("requeueDetail", () => {
  it("bounds the free text so the event log cannot be grown by a chatty error", () => {
    const detail = requeueDetail("x".repeat(REQUEUE_DETAIL_MAX + 500));
    expect(detail).toHaveLength(REQUEUE_DETAIL_MAX);
  });

  it("returns null rather than an empty string, so json_extract has one empty shape", () => {
    expect(requeueDetail("")).toBeNull();
    expect(requeueDetail("   ")).toBeNull();
    expect(requeueDetail(null)).toBeNull();
    expect(requeueDetail(undefined)).toBeNull();
  });
});
