import { describe, it, expect } from "vitest";
import {
  classifyAvailabilityTransition, isHotFiber, snapshotFromTarget,
  type ScanResult,
} from "../../shared/fiberDetect";

/**
 * CONTRACT (shared/fiberDetect.ts): the core detection event. A provable
 * unavailable→live FLIP is "newly_live" (first-to-market); a first-ever scan
 * of an already-live address is "checked_available" (a lead, but not provably
 * new); everything else classifies without ever overcounting new launches.
 */

const hot: ScanResult = { isNewFiber: true, fiberAvailable: true, billingStatus: "N" };
const cold: ScanResult = { isNewFiber: false, fiberAvailable: false, billingStatus: null };

describe("isHotFiber", () => {
  it("is true only for new + available + billing 'N'", () => {
    expect(isHotFiber(hot)).toBe(true);
    expect(isHotFiber({ ...hot, billingStatus: "T" })).toBe(false); // tenured/billed
    expect(isHotFiber({ ...hot, fiberAvailable: false })).toBe(false);
    expect(isHotFiber(cold)).toBe(false);
  });
});

describe("classifyAvailabilityTransition", () => {
  it("FLIP unavailable → live is newly_live (the money event) and makes a lead", () => {
    const o = classifyAvailabilityTransition({ everScanned: true, wasLive: false }, hot);
    expect(o.status).toBe("newly_live");
    expect(o.isNewlyLive).toBe(true);
    expect(o.shouldCreateLead).toBe(true);
  });

  it("first-ever scan of a live address is checked_available — a lead, NOT provably new", () => {
    const o = classifyAvailabilityTransition({ everScanned: false, wasLive: false }, hot);
    expect(o.status).toBe("checked_available");
    expect(o.isNewlyLive).toBe(false);       // must not inflate first-to-market metrics
    expect(o.shouldCreateLead).toBe(true);
  });

  it("already-known live address is still_available — no duplicate lead", () => {
    const o = classifyAvailabilityTransition({ everScanned: true, wasLive: true }, hot);
    expect(o.status).toBe("still_available");
    expect(o.isNewlyLive).toBe(false);
    expect(o.shouldCreateLead).toBe(false);
  });

  it("a live address that goes dark is went_stale (review)", () => {
    const o = classifyAvailabilityTransition({ everScanned: true, wasLive: true }, cold);
    expect(o.status).toBe("went_stale");
    expect(o.shouldCreateLead).toBe(false);
  });

  it("never-live, still-not-serviceable stays checked_unavailable", () => {
    expect(classifyAvailabilityTransition({ everScanned: false, wasLive: false }, cold).status).toBe("checked_unavailable");
    expect(classifyAvailabilityTransition({ everScanned: true, wasLive: false }, cold).status).toBe("checked_unavailable");
  });
});

describe("snapshotFromTarget", () => {
  it("reconstructs the prior 'was live' judgment from stored fields", () => {
    expect(snapshotFromTarget({ lastScannedAt: null })).toEqual({ everScanned: false, wasLive: false });
    expect(snapshotFromTarget({ lastScannedAt: "2026-07-01", lastIsNewFiber: true, lastBillingStatus: "N" }))
      .toEqual({ everScanned: true, wasLive: true });
    expect(snapshotFromTarget({ lastScannedAt: "2026-07-01", lastIsNewFiber: true, lastBillingStatus: "T" }))
      .toEqual({ everScanned: true, wasLive: false }); // billed → not a live opportunity
  });

  it("end-to-end: a stored not-yet-live target that scans hot classifies newly_live", () => {
    const prev = snapshotFromTarget({ lastScannedAt: "2026-07-01", lastIsNewFiber: false, lastBillingStatus: null });
    expect(classifyAvailabilityTransition(prev, hot).status).toBe("newly_live");
  });

  it("reads RAW snake_case rows too (the cron passes SELECT * rows, not drizzle shapes)", () => {
    // Regression: a previously-scanned-unavailable raw row must read everScanned.
    const rawRow = { last_scanned_at: "2026-07-01 05:00:00", last_is_new_fiber: 0, last_billing_status: null };
    expect(snapshotFromTarget(rawRow)).toEqual({ everScanned: true, wasLive: false });
    // and that raw row flipping hot must classify newly_live, not checked_available
    expect(classifyAvailabilityTransition(snapshotFromTarget(rawRow), hot).status).toBe("newly_live");
    // a raw row that was already live (sqlite 1) reconstructs wasLive
    const liveRaw = { last_scanned_at: "2026-07-01 05:00:00", last_is_new_fiber: 1, last_billing_status: "N" };
    expect(snapshotFromTarget(liveRaw)).toEqual({ everScanned: true, wasLive: true });
  });
});
