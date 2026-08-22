import { describe, expect, it } from "vitest";
import { localDateString, tenantLocalDate } from "../../server/repMetricsStore";

// The midnight-window bug: a knock sale at 9 PM Eastern used to be stamped
// with the UTC date (tomorrow), so the rep-day rollup - which looks orders up
// by the tenant-local date - reported 0 submitted orders for the day it
// actually happened. These pins hold the rule at the exact boundary.
describe("tenant-local sale date", () => {
  // 2026-08-22T02:30:00Z is 10:30 PM on Aug 21 in New York.
  const lateEveningEastern = Date.parse("2026-08-22T02:30:00.000Z");

  it("keeps an evening Eastern sale on the local day, not the UTC day", () => {
    expect(localDateString(lateEveningEastern, "America/New_York")).toBe("2026-08-21");
    expect(localDateString(lateEveningEastern, "UTC")).toBe("2026-08-22");
  });

  it("rolls to the next local day only at local midnight", () => {
    const justBeforeMidnightEastern = Date.parse("2026-08-22T03:59:59.000Z");
    const justAfterMidnightEastern = Date.parse("2026-08-22T04:00:00.000Z");
    expect(localDateString(justBeforeMidnightEastern, "America/New_York")).toBe("2026-08-21");
    expect(localDateString(justAfterMidnightEastern, "America/New_York")).toBe("2026-08-22");
  });

  it("resolves through the tenant timezone lookup for an unknown tenant", () => {
    // A null tenant falls back to the default timezone; the point is that the
    // helper returns a bare YYYY-MM-DD the rollup can match exactly.
    expect(tenantLocalDate(null, lateEveningEastern)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
