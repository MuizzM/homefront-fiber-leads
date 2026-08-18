import { describe, expect, it } from "vitest";
import { leadStateLabel } from "../../client/src/lib/leadDisplay";
import { summarizeEvidenceWorker, summarizeScanYield } from "../../client/src/lib/scanYield";
import { safeRequestId } from "../../server/requestId";

describe("lead command-center labels", () => {
  it("does not label an untouched prospect as Contacted", () => {
    expect(leadStateLabel({ leadStatus: "prospect", lastOutcome: null })).toBe("Prospect");
  });

  it("keeps outcome-specific worked states", () => {
    expect(leadStateLabel({ leadStatus: "prospect", lastOutcome: "not_home" })).toBe("Not Home");
    expect(leadStateLabel({ leadStatus: "not_interested", lastOutcome: "already_customer" })).toBe("Already a Customer");
  });
});

describe("scanner yield reporting", () => {
  it("flags the observed 200-address batch as degraded", () => {
    const result = summarizeScanYield({ found: 200, checked: 0, queued: 80, checking: 42, retrying: 2, unresolved: 76 });
    expect(result).toMatchObject({ tone: "degraded", completedPercent: 0, unresolvedPercent: 38 });
  });

  it("reports evidence successes and errors without calling errors successful", () => {
    expect(summarizeEvidenceWorker({ checked: 19_679, errors: 899 })).toEqual({
      successful: 18_780,
      errorPercent: 4.6,
    });
  });
});

describe("request correlation IDs", () => {
  it("accepts bounded proxy trace IDs", () => {
    expect(safeRequestId("edge:iad.abc-123", () => "new-id")).toBe("edge:iad.abc-123");
  });

  it.each([
    "with spaces",
    "line\nbreak",
    "x".repeat(129),
    ["one", "two"],
    undefined,
  ])("replaces unsafe inbound ID %j", (input) => {
    expect(safeRequestId(input, () => "minted-safe-id")).toBe("minted-safe-id");
  });
});
