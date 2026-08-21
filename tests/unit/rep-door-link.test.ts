// Rep→door proximity guide — the dotted line the map draws to the selected
// door. The feature builder is the honesty gate: no line without both ends,
// no line past the max range (a cross-viewport line to a door the rep isn't
// walking to is chart junk, not guidance).
import { describe, expect, it } from "vitest";
import {
  REP_LINK_LAYER, REP_LINK_LAYER_SPEC, REP_LINK_MAX_METERS, REP_LINK_SOURCE,
  repDoorLinkFeature, setRepDoorLink,
} from "../../client/src/lib/mapPins";

const REP = { lat: 30.312, lng: -95.474 };

describe("repDoorLinkFeature", () => {
  it("links rep→door in [lng,lat] order (GeoJSON), rep end first", () => {
    const f = repDoorLinkFeature(REP, { lat: 30.313, lng: -95.475 });
    expect(f).not.toBeNull();
    expect(f!.geometry.type).toBe("LineString");
    expect(f!.geometry.coordinates).toEqual([[-95.474, 30.312], [-95.475, 30.313]]);
  });

  it("draws nothing without both ends or with non-finite coords", () => {
    expect(repDoorLinkFeature(null, { lat: 1, lng: 2 })).toBeNull();
    expect(repDoorLinkFeature(REP, null)).toBeNull();
    expect(repDoorLinkFeature(REP, { lat: null, lng: -95.47 })).toBeNull();
    expect(repDoorLinkFeature(REP, { lat: 30.31, lng: null })).toBeNull();
    expect(repDoorLinkFeature({ lat: NaN, lng: -95.47 }, { lat: 30.31, lng: -95.47 })).toBeNull();
  });

  it("refuses to draw past the max range — and draws just inside it", () => {
    // ~1° latitude ≈ 111 km — far past the cap.
    expect(repDoorLinkFeature(REP, { lat: REP.lat + 1, lng: REP.lng })).toBeNull();
    // ~2.2 km north — inside the 3 km cap.
    const near = repDoorLinkFeature(REP, { lat: REP.lat + 0.02, lng: REP.lng });
    expect(near).not.toBeNull();
    expect(REP_LINK_MAX_METERS).toBe(3000);
  });
});

describe("map wiring", () => {
  it("layer spec draws a dashed line from the dedicated source", () => {
    expect(REP_LINK_LAYER_SPEC.id).toBe(REP_LINK_LAYER);
    expect(REP_LINK_LAYER_SPEC.type).toBe("line");
    expect(REP_LINK_LAYER_SPEC.source).toBe(REP_LINK_SOURCE);
    expect(REP_LINK_LAYER_SPEC.paint["line-dasharray"]).toBeTruthy();
  });

  it("setRepDoorLink pushes the feature (or clears) and survives a stale map", () => {
    const sets: any[] = [];
    const map = { getSource: (id: string) => id === REP_LINK_SOURCE ? { setData: (d: any) => sets.push(d) } : null };
    const f = repDoorLinkFeature(REP, { lat: 30.313, lng: -95.474 });
    setRepDoorLink(map, f);
    setRepDoorLink(map, null);
    expect(sets[0].features).toHaveLength(1);
    expect(sets[1].features).toHaveLength(0);
    // Stale/absent map: never throws.
    expect(() => setRepDoorLink(null, f)).not.toThrow();
    expect(() => setRepDoorLink({ getSource: () => null }, f)).not.toThrow();
  });
});
