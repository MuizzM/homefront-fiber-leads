import { describe, expect, it } from "vitest";
import { classifyScanIssue, scanIssueLabel } from "../../client/src/lib/scanIssue";

describe("scan issue explanation", () => {
  it("treats an HTTP 200 AddressNeedsFix response as an address correction, not a proxy failure", () => {
    const kind = classifyScanIssue({
      stage: "error",
      httpStatus: 200,
      detail: "non-conclusive (success=false, AddressNeedsFix) - unresolved, NOT no-service",
    });
    expect(kind).toBe("address_correction");
    expect(scanIssueLabel(kind)).toBe("Address correction");
  });

  it("separates 403 retries from address-quality responses", () => {
    expect(classifyScanIssue({ stage: "retry", httpStatus: 403, retryReason: "token invalidated" })).toBe("auth_retry");
    expect(scanIssueLabel("auth_retry")).toBe("Session retry");
  });

  it("keeps malformed or transient failures in the provider bucket", () => {
    expect(classifyScanIssue({ stage: "error", httpStatus: 200, detail: "malformed JSON" })).toBe("provider_issue");
    expect(classifyScanIssue({ stage: "classified", httpStatus: 200 })).toBeNull();
  });
});
