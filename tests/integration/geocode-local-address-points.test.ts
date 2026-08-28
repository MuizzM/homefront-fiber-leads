// Address search must survive a dead Mapbox token.
//
// The failure this covers is not hypothetical: both Mapbox tokens were retired,
// every server-side geocode 401'd, and - because the route reported a provider
// outage and a genuine miss identically - it read to reps as "that address does
// not exist" for weeks. 309eb6d fixed the REPORTING. This covers the CAUSE: a
// house we already hold in the county E911 table needs no provider at all, so
// the search box keeps working with no token, no network, and no spend.
//
// The addresses here are the real ones from the incident (Salisbury, Rowan
// County NC), so a regression fails on the case that was actually reported.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let store: typeof import("../../server/addressPointStore");
let geocoder: typeof import("../../server/geocoder");

// 117 Carriage Ln as the state's AddressNC service delivers it: st_address
// carries the house number, which is what makes canonical_key per-house.
const CARRIAGE_LN = {
  sourceId: "rowan-1", source: "nc-onemap",
  houseNumber: "117", street: "117 CARRIAGE LN", fullAddress: "117 CARRIAGE LN, SALISBURY, NC 28146",
  city: "SALISBURY", state: "NC", zip: "28146", county: "ROWAN",
  lat: 35.6412, lng: -80.4051,
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-geo-local-"));
  process.env.NODE_ENV = "test";
  // No token: this suite must prove search works with Mapbox entirely absent.
  delete process.env.MAPBOX_TOKEN;
  delete process.env.MAPBOX_PUBLIC_TOKEN;

  const mod = await import("../../server/storage");
  mod.runMigrations();
  store = await import("../../server/addressPointStore");
  geocoder = await import("../../server/geocoder");

  store.upsertAddressPoints([
    CARRIAGE_LN,
    { ...CARRIAGE_LN, sourceId: "rowan-2", houseNumber: "119", street: "119 CARRIAGE LN",
      fullAddress: "119 CARRIAGE LN, SALISBURY, NC 28146", lat: 35.6414, lng: -80.4055 },
  ]);
});

describe("forward geocoding falls to our own E911 points before any provider", () => {
  it("resolves the reported address with no Mapbox token configured", async () => {
    const hit = await geocoder.forwardGeocode("117 Carriage Ln, Salisbury, NC 28146");
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("address-points");
    expect(hit!.lat).toBeCloseTo(35.6412, 4);
    expect(hit!.lng).toBeCloseTo(-80.4051, 4);
  });

  it("picks the house the rep typed, not merely the street", async () => {
    const a = await geocoder.forwardGeocode("117 Carriage Ln, Salisbury, NC");
    const b = await geocoder.forwardGeocode("119 Carriage Ln, Salisbury, NC");
    expect(a!.lat).not.toBe(b!.lat);
    expect(b!.lat).toBeCloseTo(35.6414, 4);
  });

  it("folds the street suffix, so 'Lane' and 'Ln' are the same house", async () => {
    const hit = await geocoder.forwardGeocode("117 Carriage Lane, Salisbury, NC 28146");
    expect(hit!.source).toBe("address-points");
    expect(hit!.lat).toBeCloseTo(35.6412, 4);
  });

  it("works without a state, and without commas after the street", async () => {
    expect((await geocoder.forwardGeocode("117 Carriage Ln, Salisbury"))!.source).toBe("address-points");
    expect((await geocoder.forwardGeocode("117 Carriage Ln, Salisbury NC 28146"))!.source).toBe("address-points");
  });

  it("treats a typed ZIP as a tiebreaker, not a filter", async () => {
    // A rep typing the mailing ZIP must still find the house.
    const hit = await geocoder.forwardGeocode("117 Carriage Ln, Salisbury, NC 28147");
    expect(hit!.source).toBe("address-points");
    expect(hit!.lat).toBeCloseTo(35.6412, 4);
  });
});

describe("what the local lookup deliberately refuses", () => {
  it("does not answer a street without a house number", () => {
    // A confident wrong pin is worse than none: "Carriage Ln" must reach the
    // geocoders, which can return the street's centroid honestly.
    expect(store.lookupAddressPointByAddress("Carriage Ln, Salisbury, NC")).toBeNull();
  });

  it("does not answer a bare city or a single token", () => {
    expect(store.lookupAddressPointByAddress("Salisbury, NC")).toBeNull();
    expect(store.lookupAddressPointByAddress("Salisbury")).toBeNull();
    expect(store.parseAddressQuery("117 Carriage Ln")).toBeNull();
  });

  it("returns null for a house we do not hold, so a provider still runs", () => {
    expect(store.lookupAddressPointByAddress("999 Nowhere Rd, Salisbury, NC")).toBeNull();
  });
});

describe("the admin health endpoint tells an operator what is still answering", () => {
  it("reports the local table as usable even with no Mapbox token", () => {
    const status = geocoder.geocoderStatus();
    const local = status.providers.find((p) => p.name === "address-points");
    expect(local?.available).toBe(true);
    expect(local?.note).toMatch(/county E911 points/);
    // The point of the alarm: usable must NOT read false just because the paid
    // provider is dark, when house lookups are in fact still being answered.
    expect(status.usable).toBe(true);
    expect(status.providers.find((p) => p.name === "mapbox")?.configured).toBe(false);
  });
});
