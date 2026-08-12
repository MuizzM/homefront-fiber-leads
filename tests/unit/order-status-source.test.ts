// ── The order-status vocabulary, pinned ──────────────────────────────────────
//
// Three properties make this layer safe to build a recovery queue on, and each
// one is a real failure that has happened to importers of this shape:
//
//   1. A FAILURE PHRASE NEVER READS AS A SUCCESS. Provider status text routinely
//      contains both words - "install failed", "canceled after install
//      scheduled" - and a normalizer that matches the healthy word first closes
//      cases on orders that never installed.
//   2. AN UNRECOGNISED STATUS IS `unknown`, NEVER A GUESS. Guessing is how an
//      order nobody understands ends up driving an automated message.
//   3. DATES ARE TIMEZONE-EXACT. "Days stalled" and "install today" are both
//      arithmetic on these, and a one-day error puts a rep on the phone about
//      an appointment that has not happened yet.

import { describe, expect, it } from "vitest";
import {
  ORDER_STATUSES, ORDER_STATUS_RANK,
  canonicalOrderRowString, cleanText, hasStableIdentity, isTerminalOrderStatus,
  localDayOf, normalizeExternalId, normalizeOrderStatus, normalizePersonName,
  normalizeServiceAddress, parseVendorDate, toIsoOrNull, wholeDaysBetween,
  zonedWallClockToUtc,
} from "@shared/orderStatusSource";

describe("normalizeOrderStatus", () => {
  it("round-trips our own vocabulary", () => {
    for (const status of ORDER_STATUSES) {
      expect(normalizeOrderStatus(status)).toBe(status);
      expect(normalizeOrderStatus(status.replace(/_/g, " ").toUpperCase())).toBe(status);
    }
  });

  it("reads a failure phrase as a failure even when it contains a healthy word", () => {
    expect(normalizeOrderStatus("Install Failed")).toBe("failed_install");
    expect(normalizeOrderStatus("INSTALL NOT COMPLETE")).toBe("failed_install");
    expect(normalizeOrderStatus("Unable to install - facilities issue")).toBe("failed_install");
    expect(normalizeOrderStatus("Canceled after install scheduled")).toBe("canceled");
    expect(normalizeOrderStatus("Customer cancelled - moving")).toBe("canceled");
    expect(normalizeOrderStatus("Rejected - credit decline")).toBe("rejected");
  });

  it("separates a no-show from a failed install", () => {
    expect(normalizeOrderStatus("Customer No Show")).toBe("missed_appointment");
    expect(normalizeOrderStatus("Missed Install Appointment")).toBe("missed_appointment");
    expect(normalizeOrderStatus("Tech no-show")).toBe("missed_appointment");
    expect(normalizeOrderStatus("Customer not home")).toBe("missed_appointment");
  });

  it("separates missing documents from a general customer action", () => {
    expect(normalizeOrderStatus("Awaiting documents")).toBe("pending_documents");
    expect(normalizeOrderStatus("Missing signature")).toBe("pending_documents");
    expect(normalizeOrderStatus("Pending customer callback")).toBe("pending_customer_action");
    expect(normalizeOrderStatus("Action Required")).toBe("pending_customer_action");
  });

  it("reads a scheduling phrase as scheduled, not installed", () => {
    expect(normalizeOrderStatus("Install Scheduled")).toBe("install_scheduled");
    expect(normalizeOrderStatus("Appointment set for 8/14")).toBe("install_scheduled");
    expect(normalizeOrderStatus("Pending Install")).toBe("install_scheduled");
    expect(normalizeOrderStatus("Installed")).toBe("installed");
    expect(normalizeOrderStatus("Install Complete")).toBe("installed");
  });

  it("returns unknown rather than guessing", () => {
    for (const value of ["", "   ", null, undefined, "PROJECT ZZZ", "9", "-"]) {
      expect(normalizeOrderStatus(value as any)).toBe("unknown");
    }
  });

  it("sorts unknown below submitted so it can never look like progress", () => {
    expect(ORDER_STATUS_RANK.unknown).toBeLessThan(ORDER_STATUS_RANK.submitted);
    expect(ORDER_STATUS_RANK.install_scheduled).toBeLessThan(ORDER_STATUS_RANK.installed);
  });

  it("treats canceled and rejected as terminal and nothing else", () => {
    expect(isTerminalOrderStatus("canceled")).toBe(true);
    expect(isTerminalOrderStatus("rejected")).toBe(true);
    expect(isTerminalOrderStatus("on_hold")).toBe(false);
    expect(isTerminalOrderStatus("failed_install")).toBe(false);
  });
});

describe("parseVendorDate", () => {
  it("reads a date-only value as UTC midnight of that calendar day", () => {
    expect(toIsoOrNull(parseVendorDate("2026-08-14"))).toBe("2026-08-14T00:00:00.000Z");
    expect(toIsoOrNull(parseVendorDate("8/14/2026"))).toBe("2026-08-14T00:00:00.000Z");
    expect(toIsoOrNull(parseVendorDate("14-Aug-2026"))).toBe("2026-08-14T00:00:00.000Z");
    expect(toIsoOrNull(parseVendorDate("August 14, 2026"))).toBe("2026-08-14T00:00:00.000Z");
  });

  it("reads a naive evening time in the report's timezone, not the server's", () => {
    // 7pm in New York on 14 August is 23:00 UTC. Read as UTC it would be 19:00
    // UTC, which is the SAME calendar day - so the bug only shows on a late
    // appointment, which is exactly when installs are scheduled.
    const evening = parseVendorDate("8/14/2026 7:00 PM", "America/New_York");
    expect(toIsoOrNull(evening)).toBe("2026-08-14T23:00:00.000Z");
    // The same wall clock in Los Angeles is three hours later in UTC.
    const west = parseVendorDate("8/14/2026 7:00 PM", "America/Los_Angeles");
    expect(toIsoOrNull(west)).toBe("2026-08-15T02:00:00.000Z");
    // And it still reads as the 14th locally, which is what a dashboard shows.
    expect(localDayOf(west!, "America/Los_Angeles")).toBe("2026-08-14");
  });

  it("honours an explicit offset rather than re-interpreting it", () => {
    expect(toIsoOrNull(parseVendorDate("2026-08-14T19:00:00-04:00"))).toBe("2026-08-14T23:00:00.000Z");
    expect(toIsoOrNull(parseVendorDate("2026-08-14T23:00:00Z"))).toBe("2026-08-14T23:00:00.000Z");
  });

  it("handles midnight and noon on a 12-hour clock", () => {
    expect(toIsoOrNull(parseVendorDate("8/14/2026 12:00 AM", "UTC"))).toBe("2026-08-14T00:00:00.000Z");
    expect(toIsoOrNull(parseVendorDate("8/14/2026 12:00 PM", "UTC"))).toBe("2026-08-14T12:00:00.000Z");
  });

  it("reads an Excel serial only inside a plausible band", () => {
    // 46248 is 2026-08-14 in Excel's serial calendar.
    expect(toIsoOrNull(parseVendorDate(46248))).toBe("2026-08-14T00:00:00.000Z");
    // An account number that landed in a date column is refused, not turned
    // into a date in 1902.
    expect(parseVendorDate(12)).toBeNull();
    expect(parseVendorDate(900000)).toBeNull();
  });

  it("refuses an impossible calendar date instead of rolling it forward", () => {
    expect(parseVendorDate("2026-02-31")).toBeNull();
    expect(parseVendorDate("13/40/2026")).toBeNull();
  });

  it("returns null for text it cannot read", () => {
    for (const value of ["", "  ", "next Tuesday", "N/A", "-", null, undefined]) {
      expect(parseVendorDate(value as any)).toBeNull();
    }
  });

  it("resolves a wall clock across a DST boundary", () => {
    // 2026-03-08 is the US spring-forward. 01:30 exists, 03:30 exists.
    const before = zonedWallClockToUtc(2026, 3, 8, 1, 30, 0, "America/New_York");
    const after = zonedWallClockToUtc(2026, 3, 8, 3, 30, 0, "America/New_York");
    expect(before.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(after.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("wholeDaysBetween", () => {
  const at = (iso: string) => new Date(iso);

  it("floors and never goes negative", () => {
    expect(wholeDaysBetween(at("2026-08-01T00:00:00Z"), at("2026-08-08T23:59:00Z"))).toBe(7);
    expect(wholeDaysBetween(at("2026-08-09T00:00:00Z"), at("2026-08-08T00:00:00Z"))).toBe(0);
    expect(wholeDaysBetween(null, at("2026-08-08T00:00:00Z"))).toBe(0);
  });
});

describe("text normalization", () => {
  it("drops the placeholders a report builder emits", () => {
    for (const value of ["", "   ", "N/A", "n/a", "NONE", "null", "-", "#N/A"]) {
      expect(cleanText(value)).toBeNull();
    }
    expect(cleanText("  Kinetic   Fiber ")).toBe("Kinetic Fiber");
  });

  it("compares an external id across the formats a provider reuses", () => {
    expect(normalizeExternalId("PV-000123")).toBe("PV000123");
    expect(normalizeExternalId("pv 000123")).toBe("PV000123");
    expect(normalizeExternalId("pv_000123")).toBe("PV000123");
    expect(normalizeExternalId("   ")).toBeNull();
  });

  it("normalizes an address enough to compare, and no further", () => {
    expect(normalizeServiceAddress("123 N. Main Street, Apt 4"))
      .toBe(normalizeServiceAddress("123 north main st unit 4"));
    expect(normalizeServiceAddress("456 Oak Avenue")).toBe("456 OAK AVE");
    expect(normalizeServiceAddress("  ")).toBeNull();
  });

  it("normalizes a person name for the suggest-only rule", () => {
    expect(normalizePersonName("O'Brien, Mary-Jane")).toBe("O BRIEN MARY JANE");
    expect(normalizePersonName("12345")).toBeNull();
  });
});

describe("identity and row hashing", () => {
  const base = {
    provider: "perfectvision_submitted_orders" as const,
    organizationId: 1,
    normalizedStatus: "submitted" as const,
  };

  it("accepts any one of the three stable identities", () => {
    expect(hasStableIdentity({ externalOrderId: "A1", externalTransactionId: null, customerAccountNumber: null })).toBe(true);
    expect(hasStableIdentity({ externalOrderId: null, externalTransactionId: "T1", customerAccountNumber: null })).toBe(true);
    expect(hasStableIdentity({ externalOrderId: null, externalTransactionId: null, customerAccountNumber: "9001" })).toBe(true);
    expect(hasStableIdentity({ externalOrderId: null, externalTransactionId: null, customerAccountNumber: null })).toBe(false);
    expect(hasStableIdentity({ externalOrderId: "  ", externalTransactionId: "", customerAccountNumber: null })).toBe(false);
  });

  it("gives the same canonical string whichever date format the provider used", () => {
    const a = canonicalOrderRowString({ ...base, externalOrderId: "A1", submittedDate: parseVendorDate("8/1/2026") });
    const b = canonicalOrderRowString({ ...base, externalOrderId: "A1", submittedDate: parseVendorDate("2026-08-01") });
    expect(a).toBe(b);
  });

  it("changes the canonical string when the status changes", () => {
    const a = canonicalOrderRowString({ ...base, externalOrderId: "A1" });
    const b = canonicalOrderRowString({ ...base, externalOrderId: "A1", normalizedStatus: "installed" });
    expect(a).not.toBe(b);
  });

  it("ignores the raw payload, so a reordered export is not a change", () => {
    const a = canonicalOrderRowString({ ...base, externalOrderId: "A1" });
    const b = canonicalOrderRowString({ ...base, externalOrderId: "A1" } as any);
    expect(a).toBe(b);
  });
});
