import { describe, it, expect } from "vitest";
import { mergeAddresses, normalizeAddressKey } from "../../server/providers/mergeAddresses";
import { buildCoverageReport } from "../../server/providers/coverage";
import { classifyCoverage, type ProviderResult, type RawAddress, type CoverageClass, type ProviderName } from "../../server/providers/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────
// A partial-coverage geocoder (Mapbox, "primary") vs a full-coverage parcel file
// ("authoritative"). This is the exact scenario the coverage system exists for:
// the parcel file knows every house; the geocoder lags the new builds.
const BOX = { south: 35.49, north: 35.51, west: -82.10, east: -82.08 };
const A = (address: string, lat: number, lng: number): RawAddress => ({ address, city: "Inman", state: "SC", zip: "29349", lat, lng });
const R = (provider: ProviderName, coverageClass: CoverageClass, addresses: RawAddress[], partial = false, error?: string): ProviderResult =>
  ({ provider, coverageClass, addresses, partial, error, ms: 1 });

// 10 real parcels; the geocoder only has the first 6 (missing 4 "new builds").
const PARCELS = Array.from({ length: 10 }, (_, i) => A(`${100 + i} Main St`, 35.50 + i * 1e-4, -82.09));
const GEOCODED = PARCELS.slice(0, 6).map((p) => A(p.address, p.lat! + 5e-5, p.lng! + 5e-5)); // slightly different coords

describe("normalizeAddressKey", () => {
  it("folds street-type + direction synonyms so sources dedupe", () => {
    expect(normalizeAddressKey("10 Bell Ridge Court")).toBe(normalizeAddressKey("10 Bell Ridge Ct"));
    expect(normalizeAddressKey("5 North Main Street")).toBe(normalizeAddressKey("5 N Main St"));
    expect(normalizeAddressKey("402  Nard  Ln.")).toBe("402 nard ln");
  });
});

describe("mergeAddresses - dedupe order / precedence", () => {
  it("higher-precision provider owns the coordinates; sources union", () => {
    const merged = mergeAddresses([
      R("mapbox", "primary", [A("100 Main St", 35.6, -82.0)]),
      R("parcel", "authoritative", [A("100 Main St", 35.5, -82.09)]),
    ]);
    expect(merged).toHaveLength(1);
    // parcel (precision 1) beats mapbox (precision 2) for coords
    expect(merged[0].lat).toBeCloseTo(35.5, 5);
    expect(merged[0].primarySource).toBe("parcel");
    expect(merged[0].sources.sort()).toEqual(["mapbox", "parcel"]);
    expect(merged[0].missedByPrimary).toBe(false); // mapbox had it
  });

  it("rooftop outranks parcel for the winning coordinate", () => {
    const merged = mergeAddresses([
      R("parcel", "authoritative", [A("100 Main St", 35.50, -82.09)]),
      R("rooftop", "authoritative", [A("100 Main St", 35.501234, -82.091234)]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].primarySource).toBe("rooftop");
    expect(merged[0].lng).toBeCloseTo(-82.091234, 6);
  });

  it("dedupes across street-suffix spellings", () => {
    const merged = mergeAddresses([
      R("parcel", "authoritative", [A("10 Bell Ridge Court", 35.5, -82.0)]),
      R("overpass", "fill", [A("10 Bell Ridge Ct", 35.5, -82.0)]),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].missedByPrimary).toBe(true); // neither source is the primary
  });

  it("backfills missing coords from a lower-precision source", () => {
    const merged = mergeAddresses([
      R("parcel", "authoritative", [{ ...A("1 Oak Dr", 0, 0), lat: null, lng: null }]),
      R("mapbox", "primary", [A("1 Oak Dr", 35.5, -82.0)]),
    ]);
    expect(merged[0].lat).toBeCloseTo(35.5, 5);
  });
});

describe("buildCoverageReport - coverageRatio + classification", () => {
  it("partial geocoder vs full parcels → 0.6 partial, 4 new-build candidates", () => {
    const rep = buildCoverageReport(BOX, [
      R("mapbox", "primary", GEOCODED),
      R("parcel", "authoritative", PARCELS),
    ]);
    expect(rep.estimated).toBe(false);        // parcel is a usable denominator
    expect(rep.knownCount).toBe(10);
    expect(rep.primaryCount).toBe(6);
    expect(rep.coverageRatio).toBeCloseTo(0.6, 5);
    expect(rep.classification).toBe("partial");
    expect(rep.merged).toHaveLength(10);       // union
    expect(rep.newBuildCandidates).toHaveLength(4); // the 4 parcels the geocoder missed
    expect(rep.newBuildCandidates.every((c) => c.missedByPrimary)).toBe(true);
  });

  it("full geocoder coverage → ratio 1, classification full", () => {
    const rep = buildCoverageReport(BOX, [
      R("mapbox", "primary", PARCELS.map((p) => A(p.address, p.lat!, p.lng!))),
      R("parcel", "authoritative", PARCELS),
    ]);
    expect(rep.coverageRatio).toBe(1);
    expect(rep.classification).toBe("full");
    expect(rep.newBuildCandidates).toHaveLength(0);
  });

  it("a PARTIAL authoritative source is not trusted as the denominator", () => {
    const rep = buildCoverageReport(BOX, [
      R("mapbox", "primary", GEOCODED),
      R("parcel", "authoritative", PARCELS, /* partial */ true, "capped mid-scan"),
    ]);
    // Its addresses still merge (they're real — so we won't skip them), but the
    // set is NOT trusted as complete → ratio is an estimate off the union.
    expect(rep.estimated).toBe(true);
    expect(rep.knownCount).toBe(10);           // union still includes the parcels
    expect(rep.primaryCount).toBe(6);
    expect(rep.coverageRatio).toBeCloseTo(0.6, 5);
    expect(rep.newBuildCandidates).toHaveLength(4); // still flags what the primary missed
  });

  it("no authoritative source → estimated off the merged union", () => {
    const rep = buildCoverageReport(BOX, [
      R("mapbox", "primary", GEOCODED),
      R("overpass", "fill", [A("999 New Cut Rd", 35.505, -82.085)]),
    ]);
    expect(rep.estimated).toBe(true);
    expect(rep.knownCount).toBe(7);            // 6 geocoded + 1 overpass-only
    // overpass-only address is missed by the primary → a candidate
    expect(rep.newBuildCandidates.map((c) => c.address)).toContain("999 New Cut Rd");
  });
});

describe("buildCoverageReport - no primary enumerator ran (free preview / Mapbox down)", () => {
  it("reports UNKNOWN, not a confident 0% / all-new-builds", () => {
    // Parcel + overpass only (Mapbox excluded, as in a free preview).
    const rep = buildCoverageReport(BOX, [
      R("parcel", "authoritative", PARCELS),
      R("overpass", "fill", GEOCODED),
    ]);
    expect(rep.primaryRan).toBe(false);
    expect(rep.coverageRatio).toBeNull();
    expect(rep.classification).toBe("unknown");
    expect(rep.estimated).toBe(true);
    expect(rep.newBuildCandidates).toHaveLength(0); // can't attribute "missed" with no primary
    expect(rep.merged.length).toBe(10);              // enumeration still works
  });

  it("a Mapbox ERROR (throttle/cap) is treated as unknown, not 0% coverage", () => {
    const rep = buildCoverageReport(BOX, [
      R("mapbox", "primary", [], /* partial */ true, "rate limited"),
      R("parcel", "authoritative", PARCELS),
    ]);
    expect(rep.primaryRan).toBe(false);
    expect(rep.coverageRatio).toBeNull();
    expect(rep.classification).toBe("unknown");
    expect(rep.newBuildCandidates).toHaveLength(0);
  });
});

describe("classifyCoverage thresholds", () => {
  it("maps ratios to the documented bands", () => {
    expect(classifyCoverage(1)).toBe("full");
    expect(classifyCoverage(0.96)).toBe("full");
    expect(classifyCoverage(0.9)).toBe("good");
    expect(classifyCoverage(0.8)).toBe("good");
    expect(classifyCoverage(0.65)).toBe("partial");
    expect(classifyCoverage(0.5)).toBe("partial");
    expect(classifyCoverage(0.2)).toBe("sparse");
    expect(classifyCoverage(0)).toBe("none");
  });
});
