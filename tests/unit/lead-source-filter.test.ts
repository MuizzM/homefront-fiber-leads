// The Fiber (FCC) source filter: option predicates, AND-composition with the
// status filter, zero-count suppression, and localStorage persistence that
// never touches the status key.
//
// DEFAULT IS "latest": the map opens on the newest fiber (everything except
// the established-footprint fcc_fiber_d25 import) — a speed/relevance lens,
// not a deletion. The v2 persistence key is what applies that default ONCE
// for everyone, including users with a persisted v1 choice.
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
  it("latest matches everything EXCEPT the footprint import (NULL tags stay)", () => {
    expect(LEADS.map((l) => leadMatchesSource(l, "latest"))).toEqual([true, false, true, true, false]);
  });

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

  it("offers Latest fiber FIRST, then the three documented options", () => {
    expect(LEAD_SOURCE_OPTIONS.map((o) => o.key)).toEqual(["latest", "fcc_fresh", "fcc_fiber", "field_verified"]);
    expect(LEAD_SOURCE_OPTIONS.map((o) => o.label)).toEqual(["Latest fiber", "FCC fresh (H2-25)", "FCC fiber", "Field-verified"]);
  });

  it("latest + fcc_fiber partition the map: every pin is in exactly one of them", () => {
    for (const l of LEADS) {
      expect(leadMatchesSource(l, "latest")).toBe(!leadMatchesSource(l, "fcc_fiber"));
    }
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

  it("the latest lens still lets the status filter bite (worked footprint doors are just gone)", () => {
    const workedOrganic = { ...LEADS[2], id: 7, leadTag: null, visited: true, lastOutcome: "not_home", knockCount: 1, lastKnockedAt: "2026-07-03T00:00:00Z" };
    const leads = [...LEADS, workedOrganic] as any[];
    const sourced = applySourceFilter(leads, "latest");
    expect(sourced.map((l) => l.id).sort()).toEqual([1, 3, 4, 7]);
    const both = sourced.filter((l) => pinDisplayState(l as any) === "not_home");
    expect(both.map((l) => l.id)).toEqual([7]);
  });
});

describe("countLeadsBySource", () => {
  it("counts each option (latest included) and OMITS zero-count options (no dead UI)", () => {
    const counts = countLeadsBySource(LEADS);
    expect(counts).toEqual({ latest: 3, fcc_fresh: 1, fcc_fiber: 2, field_verified: 2 });
    expect(countLeadsBySource([])).toEqual({});
  });

  it("a footprint-only tenant: latest is zero-count (omitted), the footprint keeps its count", () => {
    const counts = countLeadsBySource([LEADS[1], LEADS[4]]); // LEADS[4] is also field-verified
    expect(counts).toEqual({ fcc_fiber: 2, field_verified: 1 });
    expect(counts.latest).toBeUndefined();
  });

  it("a zero-FCC tenant: latest == the whole map, the FCC options hide", () => {
    const counts = countLeadsBySource([LEADS[2], LEADS[3]]);
    expect(counts).toEqual({ latest: 2, field_verified: 1 });
    expect(counts.fcc_fiber).toBeUndefined();
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

describe("persistence (v2 — Latest fiber is the default for everyone)", () => {
  beforeEach(() => localStorage.clear());

  it("the key is v2 (the bump that applies the new default once)", () => {
    expect(FILTER_SOURCE_LS_KEY).toBe("hf.mapFilterSource.v2");
  });

  it("defaults to latest with no persisted choice", () => {
    expect(readPersistedFilterSource()).toBe("latest");
  });

  it("a persisted v1 choice is LEFT BEHIND (the new default applies once)", () => {
    localStorage.setItem("hf.mapFilterSource.v1", "fcc_fiber");
    expect(readPersistedFilterSource()).toBe("latest");
  });

  it("a v2 choice WINS from then on (all five values round-trip)", () => {
    for (const v of ["latest", "all", "fcc_fresh", "fcc_fiber", "field_verified"] as const) {
      persistFilterSource(v);
      expect(readPersistedFilterSource()).toBe(v);
    }
  });

  it("writing v2 cleans the superseded v1 key (one key owns the lens)", () => {
    localStorage.setItem("hf.mapFilterSource.v1", "fcc_fresh");
    persistFilterSource("fcc_fiber");
    expect(localStorage.getItem("hf.mapFilterSource.v1")).toBeNull();
    expect(localStorage.getItem(FILTER_SOURCE_LS_KEY)).toBe("fcc_fiber");
    // …and the status filter's key is untouched by any of it.
    expect(localStorage.getItem(FILTER_STATUS_LS_KEY)).toBeNull();
  });

  it("falls back to latest for garbage values", () => {
    localStorage.setItem(FILTER_SOURCE_LS_KEY, "everything-fcc-ish");
    expect(readPersistedFilterSource()).toBe("latest");
  });
});
