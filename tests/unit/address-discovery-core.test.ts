import { describe, expect, it } from "vitest";
import {
  AddressDiscoveryValidationError,
  createCanonicalAddressKey,
  dedupeAddressCandidates,
  geometryAreaKm2,
  geometryBbox,
  normalizeAddress,
  planDiscoveryTiles,
  pointInDiscoveryGeometry,
  validateDiscoveryGeometry,
} from "../../shared/addressDiscovery";

describe("discovery geometry", () => {
  const polygonWithHole = validateDiscoveryGeometry({
    type: "Polygon",
    coordinates: [
      [[-80.3, 35.8], [-80.2, 35.8], [-80.2, 35.9], [-80.3, 35.9]],
      [[-80.27, 35.83], [-80.23, 35.83], [-80.23, 35.87], [-80.27, 35.87]],
    ],
  });

  it("closes and orients Polygon rings and honors holes", () => {
    expect(polygonWithHole.type).toBe("Polygon");
    if (polygonWithHole.type !== "Polygon") throw new Error("expected polygon");
    expect(polygonWithHole.coordinates[0][0]).toEqual(polygonWithHole.coordinates[0].at(-1));
    expect(pointInDiscoveryGeometry([-80.29, 35.81], polygonWithHole)).toBe(true);
    expect(pointInDiscoveryGeometry([-80.25, 35.85], polygonWithHole)).toBe(false);
    expect(pointInDiscoveryGeometry([-80.1, 35.85], polygonWithHole)).toBe(false);
    expect(geometryAreaKm2(polygonWithHole)).toBeGreaterThan(70);
    expect(geometryBbox(polygonWithHole)).toEqual({ west: -80.3, south: 35.8, east: -80.2, north: 35.9 });
  });

  it("validates MultiPolygon components and plans bounded intersecting tiles", () => {
    const geometry = validateDiscoveryGeometry({
      type: "MultiPolygon",
      coordinates: [
        [[[-80.3, 35.8], [-80.28, 35.8], [-80.28, 35.82], [-80.3, 35.82], [-80.3, 35.8]]],
        [[[-80.2, 35.9], [-80.18, 35.9], [-80.18, 35.92], [-80.2, 35.92], [-80.2, 35.9]]],
      ],
    });
    const tiles = planDiscoveryTiles(geometry, { targetTileAreaKm2: 1, maxTiles: 64 });
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(64);
    expect(new Set(tiles.map((tile) => tile.id)).size).toBe(tiles.length);
    for (const tile of tiles) {
      expect(tile.bbox.north).toBeGreaterThan(tile.bbox.south);
      expect(tile.bbox.east).toBeGreaterThan(tile.bbox.west);
    }
  });

  it("rejects self-intersections and holes outside their exterior", () => {
    expect(() => validateDiscoveryGeometry({
      type: "Polygon",
      coordinates: [[[-80.3, 35.8], [-80.2, 35.9], [-80.3, 35.9], [-80.2, 35.8], [-80.3, 35.8]]],
    })).toThrow(AddressDiscoveryValidationError);
    expect(() => validateDiscoveryGeometry({
      type: "Polygon",
      coordinates: [
        [[-80.3, 35.8], [-80.2, 35.8], [-80.2, 35.9], [-80.3, 35.9], [-80.3, 35.8]],
        [[-80.4, 35.8], [-80.35, 35.8], [-80.35, 35.85], [-80.4, 35.85], [-80.4, 35.8]],
      ],
    })).toThrow(/hole/i);
  });
});

describe("canonical address normalization", () => {
  it("normalizes Unicode, directionals, suffixes, ZIP+4, state, and preserves units", () => {
    const candidate = normalizeAddress({
      source: "county_gis",
      sourceId: "parcel-1",
      rawAddress: "101 North Café Street Apartment 4-B, Lexington, North Carolina 27292-1234",
      lat: 35.82,
      lng: -80.25,
      confidence: 0.99,
    });
    expect(candidate.normalizedHouseNumber).toBe("101");
    expect(candidate.normalizedStreet).toBe("N CAFE ST");
    expect(candidate.normalizedUnit).toBe("APT 4-B");
    expect(candidate.normalizedState).toBe("NC");
    expect(candidate.normalizedPostalCode).toBe("27292-1234");
    expect(candidate.canonicalKey).toBe("101|N CAFE ST|APT 4-B|27292-1234");
    expect(candidate.rawAddress).toContain("Café");
    expect(candidate.providerVariants).toContain("101 NORTH CAFE STREET APT 4-B, LEXINGTON, NC, 27292-1234");
  });

  it("normalizes US, interstate, and NC route names into stable highway identities", () => {
    expect(normalizeAddress({ source: "x", houseNumber: "50", street: "U.S. Highway 64", state: "NC", city: "Lexington" }).normalizedStreet).toBe("US HWY 64");
    expect(normalizeAddress({ source: "x", houseNumber: "50", street: "Interstate 85", state: "NC", city: "Lexington" }).normalizedStreet).toBe("I 85");
    expect(normalizeAddress({ source: "x", houseNumber: "50", street: "North Carolina Highway 8", state: "NC", city: "Lexington" }).normalizedStreet).toBe("NC HWY 8");
  });

  it("uses locality/spatial evidence without ZIP and never collapses separate units", () => {
    const key = createCanonicalAddressKey({
      normalizedHouseNumber: "10", normalizedStreet: "MAIN ST", normalizedUnit: "APT 1",
      normalizedState: "NC", normalizedCity: "LEXINGTON", lat: 35.812345, lng: -80.256789,
    });
    expect(key).toBe("10|MAIN ST|APT 1|NC:LEXINGTON:35.81235,-80.25679");
    const base = { source: "osm", houseNumber: "10", street: "Main Street", city: "Lexington", state: "NC", postalCode: "27292", lat: 35.81, lng: -80.25 };
    const candidates = [
      normalizeAddress({ ...base, sourceId: "node/1", unit: "Apt 1", confidence: 0.8 }),
      normalizeAddress({ ...base, source: "county", sourceId: "p1", unit: "Apartment 1", confidence: 0.99 }),
      normalizeAddress({ ...base, sourceId: "node/2", unit: "Apt 2", confidence: 0.8 }),
    ];
    const deduped = dedupeAddressCandidates(candidates);
    expect(deduped).toHaveLength(2);
    expect(deduped.find((item) => item.normalizedUnit === "APT 1")?.sources).toHaveLength(2);
    expect(deduped.some((item) => item.normalizedUnit === "APT 2")).toBe(true);
  });

  it("honors explicit authoritative source priority while retaining all provenance", () => {
    const osm = normalizeAddress({ source: "openstreetmap", sourceId: "node/1", houseNumber: "8", street: "Center Street", city: "Lexington", state: "NC", postalCode: "27292", lat: 35.8, lng: -80.2, confidence: 0.99, coordinateQuality: "ROOFTOP" });
    const county = normalizeAddress({ source: "county_gis", sourceId: "address-8", houseNumber: "8", street: "Center St", city: "Lexington", state: "NC", postalCode: "27292", lat: 35.80001, lng: -80.20001, confidence: 0.9, coordinateQuality: "PARCEL" });
    const [merged] = dedupeAddressCandidates([osm, county], { sourcePriority: ["county_gis", "openstreetmap"] });
    expect(merged.coordinateQuality).toBe("PARCEL");
    expect(merged.sources.map((source) => source.source).sort()).toEqual(["county_gis", "openstreetmap"]);
  });
});
