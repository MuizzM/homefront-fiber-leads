import { describe, it, expect } from "vitest";
import {
  qualifyDetection, buildInventoryIndex, normalizeAddressKey, summarizeExclusions,
  type ExclusionReason,
} from "../../shared/leadQualify";

/**
 * CONTRACT (shared/leadQualify.ts): the scanner creates leads ONLY for net-new
 * fiber opportunity. Every exclusion carries a named reason — sold and
 * disqualified doors are permanent no-gos, actively assigned leads are a rep's
 * working claim, anything else owned is a duplicate. O(1) per check via a
 * once-per-batch inventory index.
 */

const inventory = buildInventoryIndex([
  { address: "10 Sold St", leadStatus: "sold", assignedRepId: 14 },
  { address: "20 NoThanks Ave", leadStatus: "not_interested", assignedRepId: null },
  { address: "30 Working Rd", leadStatus: "follow_up", assignedRepId: 14 },
  { address: "40 Pool Ln", leadStatus: "prospect", assignedRepId: null },
]);

describe("qualifyDetection — the net-new rule", () => {
  it("an unknown address is net-new and qualifies", () => {
    expect(qualifyDetection("50 Fresh Ct", inventory)).toEqual({ qualified: true, reason: "net_new" });
  });

  it("sold and disqualified doors NEVER re-qualify (permanent exclusions)", () => {
    expect(qualifyDetection("10 Sold St", inventory)).toEqual({ qualified: false, reason: "already_sold" });
    expect(qualifyDetection("20 NoThanks Ave", inventory)).toEqual({ qualified: false, reason: "disqualified" });
  });

  it("a lead a rep actively owns is excluded as already_assigned", () => {
    expect(qualifyDetection("30 Working Rd", inventory)).toEqual({ qualified: false, reason: "already_assigned" });
  });

  it("any other owned record is a duplicate (unassigned pool prospect)", () => {
    expect(qualifyDetection("40 Pool Ln", inventory)).toEqual({ qualified: false, reason: "duplicate" });
  });

  it("matching is case/whitespace-insensitive (scanner-normalized)", () => {
    expect(qualifyDetection("  10  SOLD st ", inventory).reason).toBe("already_sold");
    expect(normalizeAddressKey("  10  SOLD st ")).toBe("10 sold st");
  });
});

describe("summarizeExclusions", () => {
  it("aggregates the batch audit line", () => {
    const reasons: ExclusionReason[] = ["net_new", "net_new", "already_sold", "duplicate"];
    expect(summarizeExclusions(reasons)).toEqual({
      net_new: 2, already_sold: 1, duplicate: 1, disqualified: 0, already_assigned: 0,
    });
  });
});
