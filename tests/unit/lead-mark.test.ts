import { describe, expect, it } from "vitest";
import { LEAD_MARKS, LEAD_MARK_META, isLeadMark, isLeadMarkOrClear, normalizeLeadMark, leadMarkMeta } from "@shared/leadMark";

describe("leadMark shared model", () => {
  it("recognizes valid marks and rejects everything else", () => {
    for (const m of LEAD_MARKS) expect(isLeadMark(m)).toBe(true);
    expect(isLeadMark("priority")).toBe(true);
    expect(isLeadMark("hold")).toBe(true);
    expect(isLeadMark("nope")).toBe(false);
    expect(isLeadMark("")).toBe(false);
    expect(isLeadMark(null)).toBe(false);
    expect(isLeadMark(undefined)).toBe(false);
    expect(isLeadMark(5)).toBe(false);
  });

  it("isLeadMarkOrClear also accepts null/'' (a clear)", () => {
    expect(isLeadMarkOrClear("priority")).toBe(true);
    expect(isLeadMarkOrClear(null)).toBe(true);
    expect(isLeadMarkOrClear("")).toBe(true);
    expect(isLeadMarkOrClear(undefined)).toBe(true);
    expect(isLeadMarkOrClear("bogus")).toBe(false);
    expect(isLeadMarkOrClear(3)).toBe(false);
  });

  it("normalizeLeadMark maps invalid/clear to null and keeps valid marks", () => {
    expect(normalizeLeadMark("priority")).toBe("priority");
    expect(normalizeLeadMark("hold")).toBe("hold");
    expect(normalizeLeadMark("")).toBeNull();
    expect(normalizeLeadMark(null)).toBeNull();
    expect(normalizeLeadMark("garbage")).toBeNull();
  });

  it("every mark has display metadata", () => {
    for (const m of LEAD_MARKS) {
      const meta = LEAD_MARK_META[m];
      expect(meta.label).toBeTruthy();
      expect(meta.chip).toBeTruthy();
      expect(meta.ring).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(leadMarkMeta("priority")?.label).toBe("Priority");
    expect(leadMarkMeta("bogus")).toBeNull();
  });
});
