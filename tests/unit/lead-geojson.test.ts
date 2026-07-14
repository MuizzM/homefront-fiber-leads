import { describe, expect, it } from "vitest";
import {
  reconcileLeadFeatures,
  type GeoJsonLead,
  type LeadFeatureCache,
} from "../../client/src/lib/leadGeoJson";

function leads(count = 5_000): GeoJsonLead[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    lat: 35.8 + i / 1_000_000,
    lng: -80.25 - i / 1_000_000,
    address: `${i + 1} Example Avenue`,
    leadStatus: "prospect",
  }));
}

describe("lead GeoJSON reconciliation", () => {
  it("reuses all 5,000 feature allocations across unchanged API snapshots", () => {
    const cache: LeadFeatureCache = new Map();
    const first = reconcileLeadFeatures(leads(), cache);
    const second = reconcileLeadFeatures(leads(), cache);

    expect(first.created).toBe(5_000);
    expect(second).toMatchObject({ created: 0, reused: 5_000, removed: 0 });
    expect(second.data.features[2_500]).toBe(first.data.features[2_500]);
  });

  it("replaces only the changed feature and prunes removed IDs in O(n)", () => {
    const cache: LeadFeatureCache = new Map();
    const initialLeads = leads();
    const first = reconcileLeadFeatures(initialLeads, cache);
    const changed = initialLeads.slice(0, -1).map((lead, index) => index === 10
      ? { ...lead, leadStatus: "sold", visited: true, lastOutcome: "sold" }
      : { ...lead });
    const second = reconcileLeadFeatures(changed, cache);

    expect(second).toMatchObject({ created: 1, reused: 4_998, removed: 1 });
    expect(second.data.features[10]).not.toBe(first.data.features[10]);
    expect(second.data.features[11]).toBe(first.data.features[11]);
    expect(cache.has(5_000)).toBe(false);
  });

  it("marks only cross-verified fresh-fiber leads for the field-map halo", () => {
    const cache: LeadFeatureCache = new Map();
    const [base] = leads(1);
    const result = reconcileLeadFeatures([
      { ...base, leadTag: "fresh_fiber_confirmed", freshConfidence: "cross_verified" },
      { ...base, id: 2, lng: base.lng - 0.001, leadTag: "fresh_fiber_confirmed", freshConfidence: "single_source_provisional" },
    ], cache);
    expect(result.data.features.map((feature) => feature.properties.fresh)).toEqual([1, 0]);
  });
});
