// Which doors an Area run may spend money on.
//
// The DNC decision itself is NOT tested here — shared/tracerfy.ts owns it and
// has its own suite. This file guards the one rule that lives in the area
// wrapper, and the trap in it: "AlreadyCustomer" is not a lead_status.
import { describe, expect, it } from "vitest";
import {
  AREA_SKIP_TRACE_LEAD_FILTER_SQL,
  isEligibleForAreaSkipTrace,
} from "../../shared/areaSkipTrace";

describe("area lead selection", () => {
  it("includes the ordinary open statuses", () => {
    for (const leadStatus of ["prospect", "contacted", "interested", "follow_up", "not_home"]) {
      expect(isEligibleForAreaSkipTrace({ leadStatus }), leadStatus).toBe(true);
    }
  });

  it("excludes a sold door", () => {
    expect(isEligibleForAreaSkipTrace({ leadStatus: "sold" })).toBe(false);
  });

  // The trap the brief's wording invites. "AlreadyCustomer" persists as
  // lead_status='not_interested' WITH last_outcome='already_customer'
  // (shared/knock.ts), so a filter on lead_status alone matches ZERO rows and
  // bills a skip trace for every existing customer in the area.
  it("excludes an already-customer door, which is stored as not_interested", () => {
    expect(isEligibleForAreaSkipTrace({
      leadStatus: "not_interested", lastOutcome: "already_customer",
    })).toBe(false);
  });

  it("excludes a door the phone path marked as already having service", () => {
    expect(isEligibleForAreaSkipTrace({
      leadStatus: "prospect", lastCallOutcome: "already_has_service",
    })).toBe(false);
  });

  // A skip trace buys the owner's NAME, and the door is still knockable — the
  // DNC rules govern the telephone, not the doorstep.
  it("still includes a plain not_interested door", () => {
    expect(isEligibleForAreaSkipTrace({ leadStatus: "not_interested" })).toBe(true);
  });

  it("excludes a do-not-knock door", () => {
    expect(isEligibleForAreaSkipTrace({ leadStatus: "prospect", doNotKnock: 1 })).toBe(false);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isEligibleForAreaSkipTrace({ leadStatus: " SOLD " })).toBe(false);
    expect(isEligibleForAreaSkipTrace({ leadStatus: "prospect", lastOutcome: "Already_Customer" })).toBe(false);
  });

  // The SQL and the predicate are two statements of one rule. A drift between
  // them is a drift in what we pay a vendor for.
  it("keeps the SQL filter and the TS predicate reading the same columns", () => {
    for (const fragment of ["lead_status", "last_outcome", "last_call_outcome", "do_not_knock"]) {
      expect(AREA_SKIP_TRACE_LEAD_FILTER_SQL).toContain(fragment);
    }
    expect(AREA_SKIP_TRACE_LEAD_FILTER_SQL).toContain("already_customer");
    expect(AREA_SKIP_TRACE_LEAD_FILTER_SQL).toContain("'sold'");
    // not_interested must NOT be excluded wholesale — only the
    // already_customer disambiguator is.
    expect(AREA_SKIP_TRACE_LEAD_FILTER_SQL).not.toContain("'not_interested'");
  });
});
