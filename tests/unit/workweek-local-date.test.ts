// Commission-week bounds are computed in the ORG'S timezone, so any date that
// gets compared against those bounds must be the org's local calendar date.
// `new Date().toISOString().slice(0,10)` is the UTC date, which is a different
// calendar day from the org's date for several hours of every day.
//
// That mismatch was a real defect, not a nitpick: `assignStructure` defaulted a
// new plan's effectiveFrom to the UTC date, so on a Sunday evening in
// America/New_York (already Monday in UTC) the plan was stamped with the NEXT
// week's start date. resolveAssignmentForWeek's in-week window is half-open
// (from < nextWeekStart), so the assignment matched neither the week in
// progress nor as a mid-week start — and the rep's statement failed with
// NO_EFFECTIVE_PLAN_ASSIGNMENT. Every Sunday evening Eastern, which is exactly
// when a door-knocking org sets up the coming week.
import { describe, expect, it } from "vitest";
import { localDateISO, weekBoundsFor, DEFAULT_WORKWEEK } from "@shared/workweek";

describe("localDateISO — the org's calendar date, not UTC's", () => {
  it("returns the LOCAL day when UTC has already rolled over", () => {
    // 2026-08-03T03:30:00Z is Monday in UTC but still Sunday 23:30 in New York.
    const instant = "2026-08-03T03:30:00.000Z";
    expect(instant.slice(0, 10)).toBe("2026-08-03");        // what UTC would say
    expect(localDateISO(instant)).toBe("2026-08-02");        // what the org sees
  });

  it("agrees with UTC once the local day has caught up", () => {
    const instant = "2026-08-03T16:00:00.000Z"; // Monday noon ET
    expect(localDateISO(instant)).toBe("2026-08-03");
  });

  it("honours a non-default timezone", () => {
    const instant = "2026-08-03T03:30:00.000Z"; // Sunday 20:30 in Los Angeles
    expect(localDateISO(instant, { ...DEFAULT_WORKWEEK, timezone: "America/Los_Angeles" })).toBe("2026-08-02");
    // …and is already Monday in Europe.
    expect(localDateISO(instant, { ...DEFAULT_WORKWEEK, timezone: "Europe/London" })).toBe("2026-08-03");
  });

  it("the local date always falls INSIDE the week that contains the instant", () => {
    // The regression itself: a plan dated with the local date is coverable by
    // the week in progress. With the UTC date it landed on nextWeekStart and
    // resolved to no assignment at all.
    const instant = "2026-08-03T03:30:00.000Z";
    const b = weekBoundsFor(instant);
    const local = localDateISO(instant);
    const wk = b.weekStartUtc.slice(0, 10);
    const nk = b.nextWeekStartUtc.slice(0, 10);
    // resolveAssignmentForWeek's own comparison: covering (<= wk) OR starting
    // within the week (> wk AND < nk). The local date must satisfy one of them.
    expect(local <= wk || (local > wk && local < nk)).toBe(true);
    // And concretely, the UTC date does NOT — it equals the exclusive bound.
    expect(instant.slice(0, 10)).toBe(nk);
  });
});
