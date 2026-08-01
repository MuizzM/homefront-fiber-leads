// The Fiber (FCC) source filter: option predicates, AND-composition with the
// status filter, zero-count suppression, and localStorage persistence that
// never touches the status key.
import { beforeEach, describe, expect, it } from "vitest";
import { pinDisplayState } from "@shared/knock";
import {
  FILTER_SOURCE_LS_KEY,
  LEAD_SOURCE_OPTIONS,
  applySourceFilter,
  countLeadsBySource,
  isFccReportedLead,
  leadMatchesSource,
  persistFilterSource,
  readPersistedFilterSource,
} from "@/lib/leadSourceFilter";
import { FILTER_STATUS_LS_KEY } from "@/lib/mapPins";

const LEADS = [
  { id: 1, leadTag: "fcc_fresh_block", freshConfirmedAt: null, leadStatus: "prospect", lat: 35.5, lng: -80.4, address: "1 A St" },
  { id: 2, leadTag: "fcc_fiber_d25", freshConfirmedAt: null, leadStatus: "prospect", lat: 35.5, lng: -80.4, address: "2 A St" },
  { id: 3, leadTag: null, freshConfirmedAt: "2026-07-01T00:00:00Z", leadStatus: "prospect", lat: 35.5, lng: -80.4, address: "3 A St" },
  { id: 4, leadTag: "hot_lead", freshConfirmedAt: null, leadStatus: "prospect", lat: 35.5, lng: -80.4, address: "4 A St" },
  { id: 5, leadTag: "fcc_fiber_d25", freshConfirmedAt: "2026-07-02T00:00:00Z", leadStatus: "prospect", lat: 35.5, lng: -80.4, address: "5 A St" },
];

describe("source option predicates", () => {
  it("fcc_fresh matches only fcc_fresh_block", () => {
    expect(LEADS.map((l) => leadMatchesSource(l, "fcc_fresh"))).toEqual([true, false, false, false, false]);
  });

  it("fcc_fiber matches only fcc_fiber_d25", () => {
    expect(LEADS.map((l) => leadMatchesSource(l, "fcc_fiber"))).toEqual([false, true, false, false, true]);
  });

  it("field_verified matches fresh_confirmed_at NOT NULL (any tag)", () => {
    expect(LEADS.map((l) => leadMatchesSource(l, "field_verified"))).toEqual([false, false, true, false, true]);
  });

  it("all matches everything", () => {
    expect(LEADS.every((l) => leadMatchesSource(l, "all"))).toBe(true);
  });

  it("offers exactly All + the three documented options", () => {
    expect(LEAD_SOURCE_OPTIONS.map((o) => o.key)).toEqual(["fcc_fresh", "fcc_fiber", "field_verified"]);
    expect(LEAD_SOURCE_OPTIONS.map((o) => o.label)).toEqual(["FCC fresh (H2-25)", "FCC fiber", "Field-verified"]);
  });
});

describe("AND composition with the status filter", () => {
  it("source narrows, status narrows further — both apply at once", () => {
    const worked = { ...LEADS[1], id: 6, visited: true, lastOutcome: "not_home", knockCount: 1, lastKnockedAt: "2026-07-03T00:00:00Z" };
    const leads = [...LEADS, worked] as any[];
    // Mirrors MapView's visibleLeads: source first, then display-state status.
    const sourced = applySourceFilter(leads, "fcc_fiber");
    expect(sourced.map((l) => l.id).sort()).toEqual([2, 5, 6]);
    const both = sourced.filter((l) => pinDisplayState(l as any) === "not_home");
    expect(both.map((l) => l.id)).toEqual([6]);
    // The status lens alone catches non-FCC doors too; the AND is what makes
    // the composition useful.
    const statusOnly = leads.filter((l) => pinDisplayState(l as any) === "not_home");
    expect(statusOnly.map((l) => l.id)).toEqual([6]);
    expect(applySourceFilter(statusOnly, "fcc_fresh")).toEqual([]);
  });
});

describe("countLeadsBySource", () => {
  it("counts each option and OMITS zero-count options (no dead UI)", () => {
    const counts = countLeadsBySource(LEADS);
    expect(counts).toEqual({ fcc_fresh: 1, fcc_fiber: 2, field_verified: 2 });
    expect(countLeadsBySource([LEADS[3]])).toEqual({}); // hot_lead only → nothing
    expect(countLeadsBySource([])).toEqual({});
  });
});

describe("isFccReportedLead", () => {
  it("matches the whole fcc family and nothing else", () => {
    expect(isFccReportedLead({ leadTag: "fcc_fresh_block" })).toBe(true);
    expect(isFccReportedLead({ leadTag: "fcc_fiber_d25" })).toBe(true);
    expect(isFccReportedLead({ leadTag: "fresh_fiber_confirmed" })).toBe(false);
    expect(isFccReportedLead({ leadTag: null })).toBe(false);
    expect(isFccReportedLead({})).toBe(false);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a valid selection under its OWN key", () => {
    persistFilterSource("fcc_fiber");
    expect(readPersistedFilterSource()).toBe("fcc_fiber");
    expect(localStorage.getItem(FILTER_SOURCE_LS_KEY)).toBe("fcc_fiber");
    // …and the status filter's key is untouched by it.
    expect(localStorage.getItem(FILTER_STATUS_LS_KEY)).toBeNull();
  });

  it("falls back to all for missing or garbage values", () => {
    expect(readPersistedFilterSource()).toBe("all");
    localStorage.setItem(FILTER_SOURCE_LS_KEY, "everything-fcc-ish");
    expect(readPersistedFilterSource()).toBe("all");
  });
});
