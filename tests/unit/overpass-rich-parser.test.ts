import { describe, expect, it } from "vitest";
import {
  buildOverpassQuery,
  interpolateAddressWay,
  parseOsmElements,
  type OsmElement,
} from "../../server/addressDiscovery/overpass";

describe("rich OSM address parsing", () => {
  it("parses nodes, addressed building ways, relations, entrances, and addr:full", () => {
    const elements: OsmElement[] = [
      { type: "node", id: 1, lat: 35.81, lon: -80.25, tags: { "addr:housenumber": "10", "addr:street": "North Main Street", "addr:city": "Lexington", "addr:state": "NC", "addr:postcode": "27292" } },
      { type: "way", id: 2, center: { lat: 35.811, lon: -80.251 }, tags: { building: "house", "addr:housenumber": "12", "addr:street": "North Main Street" } },
      { type: "relation", id: 3, center: { lat: 35.812, lon: -80.252 }, tags: { type: "multipolygon", building: "apartments", "addr:housenumber": "14", "addr:street": "North Main Street", "addr:unit": "2B" } },
      { type: "node", id: 4, lat: 35.813, lon: -80.253, tags: { entrance: "main", "addr:housenumber": "16", "addr:street": "North Main Street" } },
      { type: "node", id: 5, lat: 35.814, lon: -80.254, tags: { "addr:full": "18 North Main Street Apt 3, Lexington, NC 27292" } },
    ];
    const parsed = parseOsmElements(elements, { city: "Lexington", state: "NC" });
    expect(parsed.map((item) => item.normalizedHouseNumber)).toEqual(["10", "12", "14", "16", "18"]);
    expect(parsed.every((item) => item.normalizedStreet === "N MAIN ST")).toBe(true);
    expect(parsed.find((item) => item.osmId === 3)?.normalizedUnit).toBe("2B");
    expect(parsed.find((item) => item.osmId === 4)?.coordinateQuality).toBe("ENTRANCE");
    expect(parsed.find((item) => item.osmId === 5)?.inferenceMethod).toBe("FULL_ADDRESS");
  });

  it("recovers a missing street from associatedStreet and one contained address node", () => {
    const elements: OsmElement[] = [
      { type: "node", id: 10, lat: 35.8, lon: -80.2, tags: { "addr:housenumber": "20" } },
      { type: "relation", id: 20, tags: { type: "associatedStreet", name: "Oak Lane" }, members: [{ type: "node", ref: 10, role: "house" }] },
      { type: "node", id: 31, lat: 35.811, lon: -80.211, tags: { "addr:housenumber": "22", "addr:street": "Pine Road" } },
      {
        type: "way", id: 30, center: { lat: 35.811, lon: -80.211 },
        geometry: [{ lat: 35.81, lon: -80.212 }, { lat: 35.81, lon: -80.21 }, { lat: 35.812, lon: -80.21 }, { lat: 35.812, lon: -80.212 }, { lat: 35.81, lon: -80.212 }],
        tags: { building: "yes", "addr:housenumber": "24" },
      },
    ];
    const parsed = parseOsmElements(elements, { city: "Lexington", state: "NC" });
    expect(parsed.find((item) => item.osmId === 10)).toMatchObject({ normalizedStreet: "OAK LN", inferenceMethod: "ASSOCIATED_STREET", validationRequired: false });
    expect(parsed.find((item) => item.osmId === 30)).toMatchObject({ normalizedStreet: "PINE RD", inferenceMethod: "CONTAINED_ADDRESS", validationRequired: true });
  });

  it("keeps ambiguous partials unresolved instead of choosing an arbitrary nearby road", () => {
    const elements: OsmElement[] = [
      { type: "node", id: 1, lat: 35.8, lon: -80.2, tags: { "addr:housenumber": "40" } },
      { type: "way", id: 2, geometry: [{ lat: 35.7999, lon: -80.201 }, { lat: 35.7999, lon: -80.199 }], tags: { highway: "residential", name: "First Street" } },
      { type: "way", id: 3, geometry: [{ lat: 35.8001, lon: -80.201 }, { lat: 35.8001, lon: -80.199 }], tags: { highway: "residential", name: "Second Street" } },
    ];
    const partial = parseOsmElements(elements, { city: "Lexington", state: "NC" }).find((item) => item.osmId === 1);
    expect(partial).toMatchObject({ inferenceMethod: "UNRESOLVED_PARTIAL", normalizedStreet: "", validationRequired: true });
  });
});

describe("OSM interpolation", () => {
  function interpolation(rule: string, start = "101", end = "109"): { way: OsmElement; nodes: Map<number, OsmElement> } {
    const first: OsmElement = { type: "node", id: 1, lat: 35.8, lon: -80.2, tags: { "addr:housenumber": start, "addr:street": "Main Street" } };
    const last: OsmElement = { type: "node", id: 2, lat: 35.8, lon: -80.19, tags: { "addr:housenumber": end, "addr:street": "Main Street" } };
    return {
      way: { type: "way", id: 99, nodes: [1, 2], tags: { "addr:interpolation": rule, "addr:street": "Main Street" } },
      nodes: new Map([[1, first], [2, last]]),
    };
  }

  it.each([
    ["all", ["102", "103", "104", "105", "106", "107", "108"]],
    ["odd", ["103", "105", "107"]],
    ["even", ["104", "106", "108"], "102", "110"],
    ["3", ["104", "107"]],
  ])("supports interpolation=%s", (rule, expected, start = "101", end = "109") => {
    const fixture = interpolation(rule as string, start as string, end as string);
    const generated = interpolateAddressWay(fixture.way, fixture.nodes);
    expect(generated.map((item) => item.normalizedHouseNumber)).toEqual(expected);
    expect(generated.every((item) => item.observationType === "INTERPOLATED" && item.validationRequired && item.confidence < 0.7)).toBe(true);
    expect(new Set(generated.flatMap((item) => item.sources.map((source) => source.sourceId))).size).toBe(generated.length);
  });

  it("interpolates coordinates along geometry, including reversed endpoints and safe suffixes", () => {
    const fixture = interpolation("all", "109A", "101A");
    const generated = interpolateAddressWay(fixture.way, fixture.nodes);
    expect(generated).toHaveLength(7);
    const number105 = generated.find((item) => item.normalizedHouseNumber === "105A");
    expect(number105?.lng).toBeCloseTo(-80.195, 5);
    expect(number105?.sources[0].parentSourceId).toBe("way/99");
    const unsafe = interpolation("all", "101A", "109B");
    expect(interpolateAddressWay(unsafe.way, unsafe.nodes)).toEqual([]);
  });

  it("does not let recursive skel duplicates erase interpolation endpoint tags", () => {
    const elements: OsmElement[] = [
      { type: "node", id: 1, lat: 35.8, lon: -80.2, tags: { "addr:housenumber": "1", "addr:street": "Oak Street" } },
      { type: "node", id: 2, lat: 35.8, lon: -80.19, tags: { "addr:housenumber": "5", "addr:street": "Oak Street" } },
      { type: "way", id: 9, nodes: [1, 2], tags: { "addr:interpolation": "odd", "addr:street": "Oak Street" } },
      { type: "node", id: 1, lat: 35.8, lon: -80.2 },
      { type: "node", id: 2, lat: 35.8, lon: -80.19 },
    ];
    const parsed = parseOsmElements(elements, { city: "Lexington", state: "NC" });
    expect(parsed.some((item) => item.normalizedHouseNumber === "3" && item.observationType === "INTERPOLATED")).toBe(true);
  });
});

describe("Overpass query shape", () => {
  it("requests all supported element classes with valid output modifiers", () => {
    const query = buildOverpassQuery({ south: 35.8, west: -80.3, north: 35.9, east: -80.2 });
    expect(query).toContain('nwr(35.8,-80.3,35.9,-80.2)["addr:housenumber"]');
    expect(query).toContain('["addr:full"]');
    expect(query).toContain('["addr:interpolation"]');
    expect(query).toContain('["type"="associatedStreet"]');
    expect(query).toContain('["highway"]["name"]');
    expect(query).toContain("out body center qt;");
    expect(query).not.toMatch(/out body[^;]*\b(?:tags|geom)\b/);
  });
});
