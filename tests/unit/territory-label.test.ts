// What a manager reads off an area without tapping it.
import { describe, expect, it } from "vitest";
import {
  territoryLabel, knockedPct, shortDate, shortRep, detailForZoom,
} from "../../shared/territoryLabel";

const NOW = "2026-07-28T12:00:00.000Z";

describe("knockedPct", () => {
  it("floors rather than rounds", () => {
    // Rounding shows 100% at 99.6%, and a rep who sees 100% stops walking.
    expect(knockedPct(996, 1000)).toBe(99);
    expect(knockedPct(1000, 1000)).toBe(100);
    expect(knockedPct(1, 3)).toBe(33);
  });

  it("is null when there are no doors - 0% of nothing is not progress", () => {
    expect(knockedPct(0, 0)).toBeNull();
    expect(knockedPct(5, null)).toBeNull();
    expect(knockedPct(null, null)).toBeNull();
  });

  it("clamps nonsense instead of printing it", () => {
    expect(knockedPct(50, 10)).toBe(100);
    expect(knockedPct(-5, 10)).toBe(0);
  });
});

describe("shortDate", () => {
  it("omits the year within the current year", () => {
    expect(shortDate("2026-03-04T10:00:00Z", NOW)).toBe("Mar 4");
  });

  it("shows the year for older assignments", () => {
    // A bare "Mar 4" on a two-year-old assignment reads as recent — exactly the
    // case a manager needs to catch.
    expect(shortDate("2025-03-04T10:00:00Z", NOW)).toBe("Mar 4 '25");
  });

  it("returns null for missing or unparseable input", () => {
    expect(shortDate(null)).toBeNull();
    expect(shortDate("not a date")).toBeNull();
  });
});

describe("shortRep", () => {
  it("takes the first name - map labels are tight", () => {
    expect(shortRep("Ann Rivera")).toBe("Ann");
    expect(shortRep("  Bo  Chen ")).toBe("Bo");
    expect(shortRep(null)).toBe("");
  });
});

describe("territoryLabel", () => {
  const base = {
    areaName: "Maple Grove", repName: "Ann Rivera",
    assignedAt: "2026-03-04T10:00:00Z", knocked: 24, total: 60,
    status: "active", now: NOW,
  };

  it("full detail: area, rep · date, percent", () => {
    expect(territoryLabel(base, "full")).toBe("Maple Grove\nAnn · Mar 4\n40% knocked");
  });

  it("compact detail drops the date", () => {
    expect(territoryLabel(base, "compact")).toBe("Maple Grove\nAnn  40%");
  });

  it("name detail is just the area", () => {
    expect(territoryLabel(base, "name")).toBe("Maple Grove");
  });

  it("says Unassigned for a pooled area, never a stale rep name", () => {
    // A leftover rep name on a pooled area is how ground quietly goes unworked.
    for (const status of ["unassigned", "reclaimed"]) {
      const out = territoryLabel({ ...base, status }, "full");
      expect(out).toBe("Maple Grove\nUnassigned");
      expect(out).not.toContain("Ann");
    }
  });

  it("marks a completed area with its rep", () => {
    expect(territoryLabel({ ...base, status: "completed" }, "full")).toBe("Maple Grove\nDone - Ann");
  });

  it("omits the progress line when there are no doors yet", () => {
    const out = territoryLabel({ ...base, knocked: 0, total: 0 }, "full");
    expect(out).toBe("Maple Grove\nAnn · Mar 4");
    expect(out).not.toContain("%");
  });

  it("omits the date when the area has never been assigned", () => {
    expect(territoryLabel({ ...base, assignedAt: null }, "full")).toBe("Maple Grove\nAnn\n40% knocked");
  });

  it("survives an area with no name", () => {
    expect(territoryLabel({ ...base, areaName: "" }, "full")).toBe("Ann · Mar 4\n40% knocked");
  });

  it("never emits a leading or trailing blank line", () => {
    // Blank lines become vertical gaps in the map label and look like a bug.
    for (const detail of ["full", "compact", "name"] as const) {
      for (const input of [base, { ...base, areaName: "" }, { ...base, repName: "" }, { ...base, status: "unassigned" }]) {
        const out = territoryLabel(input, detail);
        expect(out).not.toMatch(/^\n|\n$|\n\n/);
      }
    }
  });
});

describe("detailForZoom", () => {
  it("sheds detail as areas shrink on screen", () => {
    expect(detailForZoom(16)).toBe("full");
    expect(detailForZoom(14)).toBe("full");
    expect(detailForZoom(13)).toBe("compact");
    expect(detailForZoom(12)).toBe("compact");
    expect(detailForZoom(11)).toBe("name");
    expect(detailForZoom(3)).toBe("name");
  });

  it("degrades to the shortest label on a junk zoom", () => {
    expect(detailForZoom(NaN)).toBe("name");
  });
});
