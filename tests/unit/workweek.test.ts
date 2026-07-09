import { describe, it, expect } from "vitest";
import { weekBoundsFor, isInWeek, DEFAULT_WORKWEEK } from "../../shared/workweek";

/**
 * CONTRACT (shared/workweek.ts): a FIXED Mon 00:00 → next Mon 00:00 week in the
 * org timezone, half-open [start, next). DST-correct (never a fixed 168h UTC
 * subtraction). Default America/New_York.
 */

const NY = DEFAULT_WORKWEEK; // America/New_York, Monday, 00:00

// Format a UTC ISO as its local weekday + HH:mm in the zone, to assert boundaries.
function localOf(iso: string, tz = NY.timezone): string {
  // hourCycle h23 → midnight is "00:00", not the ICU "24:00" quirk of hour12:false.
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(iso));
}
const H = (iso: string) => (Date.parse(iso)) / 3_600_000;

describe("week boundaries land on Monday 00:00 local", () => {
  it("a mid-week instant resolves to Mon 00:00 → next Mon 00:00", () => {
    const b = weekBoundsFor("2026-03-04T12:00:00Z", NY); // Wed in the Mar 2–8 week
    expect(localOf(b.weekStartUtc)).toMatch(/Mon.*00:00/);
    expect(localOf(b.nextWeekStartUtc)).toMatch(/Mon.*00:00/);
    expect(b.localWeekLabel).toBe("Mar 2 – Mar 8, 2026");
  });
});

describe("half-open membership at the Sunday→Monday seam (across spring-forward)", () => {
  // Mar 8 2026 US spring-forward (02:00 EST → 03:00 EDT). Week = Mar 2–8.
  const week = weekBoundsFor("2026-03-04T12:00:00Z", NY);
  it("Sunday 23:59 local belongs to the CLOSING week", () => {
    // 2026-03-08 23:59 EDT (UTC-4) = 03:59Z on the 9th
    expect(isInWeek("2026-03-09T03:59:00Z", week)).toBe(true);
  });
  it("Monday 00:00 local belongs to the NEW week (exclusive end)", () => {
    // 2026-03-09 00:00 EDT = 04:00Z — exactly nextWeekStart
    expect(isInWeek("2026-03-09T04:00:00Z", week)).toBe(false);
    expect(week.nextWeekStartUtc).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("DST is handled — week span is not a fixed 168h", () => {
  it("spring-forward week is 167 hours", () => {
    const b = weekBoundsFor("2026-03-04T12:00:00Z", NY); // Mar 2–8, contains spring-forward
    expect(H(b.nextWeekStartUtc) - H(b.weekStartUtc)).toBe(167);
  });
  it("fall-back week is 169 hours", () => {
    const b = weekBoundsFor("2026-10-28T12:00:00Z", NY); // Oct 26–Nov 1, contains fall-back (Nov 1)
    expect(H(b.nextWeekStartUtc) - H(b.weekStartUtc)).toBe(169);
    expect(localOf(b.weekStartUtc)).toMatch(/Mon.*00:00/);
    expect(localOf(b.nextWeekStartUtc)).toMatch(/Mon.*00:00/);
  });
  it("an ordinary week is exactly 168 hours", () => {
    const b = weekBoundsFor("2026-06-10T12:00:00Z", NY);
    expect(H(b.nextWeekStartUtc) - H(b.weekStartUtc)).toBe(168);
  });
});

describe("half-open interval at exact boundaries", () => {
  const b = weekBoundsFor("2026-06-10T12:00:00Z", NY);
  it("weekStart is inclusive, nextWeekStart is exclusive", () => {
    expect(isInWeek(b.weekStartUtc, b)).toBe(true);
    expect(isInWeek(b.nextWeekStartUtc, b)).toBe(false);
    expect(isInWeek(new Date(Date.parse(b.nextWeekStartUtc) - 1), b)).toBe(true); // 1ms before end
  });
});

describe("timezone matters (not a UTC calculation)", () => {
  it("the same instant sits in different local weeks for different zones", () => {
    // 2026-01-05T02:00:00Z: Monday 02:00 UTC. In LA (UTC-8) it's still Sunday
    // Jan 4 18:00 → belongs to the PRIOR week; in NY it's Mon 21:00 (prev day)…
    const la = weekBoundsFor("2026-01-05T02:00:00Z", { ...NY, timezone: "America/Los_Angeles" });
    expect(localOf(la.weekStartUtc, "America/Los_Angeles")).toMatch(/Mon.*00:00/);
    // LA local time of the instant is Sun Jan 4 — so its week starts Mon Dec 29.
    expect(la.localWeekLabel).toMatch(/Dec 29/);
  });
});
