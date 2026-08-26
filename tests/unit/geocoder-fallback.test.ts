// The whole point of server/geocoder.ts: a dead Mapbox token must cost an
// approximate match, never a dead address lookup.
//
// This is the exact production failure, replayed. Both MAPBOX tokens were
// retired; api.mapbox.com answered 401 to every geocoding call; the map's
// "jump to an address" search reported "Address lookup failed" on every query
// and tap-a-house went dead outside county address-point coverage. Nothing in
// the app noticed, because each of the four call sites swallowed its own error.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { forwardGeocode, reverseGeocode, geocodePlace, geocoderStatus, resetGeocoderState } from "../../server/geocoder";

const NOMINATIM_ADDRESS = [{
  lat: "35.8235027", lon: "-80.2542407",
  display_name: "100, South Main Street, Lexington, Davidson County, North Carolina, 27292, United States",
  addresstype: "place", type: "house",
  address: { house_number: "100", road: "South Main Street", town: "Lexington", state: "North Carolina", "ISO3166-2-lvl4": "US-NC", postcode: "27292" },
}];

const NOMINATIM_PLACE = [{
  lat: "35.8240265", lon: "-80.2533838", name: "Lexington",
  addresstype: "town", type: "administrative",
  boundingbox: ["35.7574430", "35.8593370", "-80.3299140", "-80.2193140"],
  address: { town: "Lexington", state: "North Carolina", "ISO3166-2-lvl4": "US-NC" },
}];

const NOMINATIM_REVERSE = {
  lat: "35.8235027", lon: "-80.2542407",
  display_name: "100, South Main Street, Lexington, Davidson County, North Carolina, 27292, United States",
  address: { house_number: "100", road: "South Main Street", town: "Lexington", state: "North Carolina", "ISO3166-2-lvl4": "US-NC", postcode: "27292" },
};

function res(status: number, body: any): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

let calls: string[] = [];

/** Mapbox answers `mapboxStatus`; Nominatim always answers with `osmBody`. */
function stubFetch(mapboxStatus: number, osmBody: any) {
  return vi.fn(async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.mapbox.com")) {
      return res(mapboxStatus, mapboxStatus === 200
        ? { features: [{ center: [-80.25, 35.82], place_name: "Mapbox said so", bbox: [-80.3, 35.7, -80.2, 35.9], text: "Lexington", context: [{ id: "region.1", short_code: "US-NC" }] }] }
        : { message: "Not Authorized - Invalid Token" });
    }
    return res(200, osmBody);
  });
}

beforeEach(() => {
  calls = [];
  resetGeocoderState();
  process.env.MAPBOX_TOKEN = "pk.test-token";
  // fetch is stubbed here, so nothing reaches a real host. Point the base URL
  // away from nominatim.openstreetmap.org so the 1 req/s POLICY floor (which
  // stays hard-coded for that host - see nominatimIntervalMs) does not make
  // this file spend ten seconds asleep and flake under parallel load.
  process.env.NOMINATIM_BASE_URL = "https://nominatim.test.invalid";
  process.env.NOMINATIM_MIN_INTERVAL_MS = "1";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NOMINATIM_MIN_INTERVAL_MS;
  delete process.env.NOMINATIM_BASE_URL;
  delete process.env.MAPBOX_TOKEN;
});

describe("forwardGeocode survives a dead Mapbox token", () => {
  it("a 401 from Mapbox falls through to OSM and still returns a point", async () => {
    vi.stubGlobal("fetch", stubFetch(401, NOMINATIM_ADDRESS));
    const hit = await forwardGeocode("100 Main St Lexington NC");
    expect(hit).not.toBeNull();
    expect(hit!.source).toBe("nominatim");
    expect(hit!.lat).toBeCloseTo(35.8235, 3);
    expect(hit!.lng).toBeCloseTo(-80.2542, 3);
    expect(calls.some(u => u.includes("api.mapbox.com"))).toBe(true);
    expect(calls.some(u => u.includes("nominatim"))).toBe(true);
  });

  it("after the first 401 the breaker skips Mapbox entirely - a dead token costs ONE request, not one per lookup", async () => {
    const f = stubFetch(401, NOMINATIM_ADDRESS);
    vi.stubGlobal("fetch", f);
    await forwardGeocode("100 Main St Lexington NC");
    await forwardGeocode("200 Other St Lexington NC");
    await forwardGeocode("300 Third St Lexington NC");
    expect(calls.filter(u => u.includes("api.mapbox.com"))).toHaveLength(1);
    expect(calls.filter(u => u.includes("nominatim"))).toHaveLength(3);
    // And the health endpoint SAYS so, which is the alarm that was missing.
    const status = geocoderStatus();
    expect(status.usable).toBe(true); // OSM is carrying it
    expect(status.providers.find(p => p.name === "mapbox")!.available).toBe(false);
    expect(status.providers.find(p => p.name === "mapbox")!.note).toContain("401");
  });

  it("a working token is preferred and OSM is never called", async () => {
    vi.stubGlobal("fetch", stubFetch(200, NOMINATIM_ADDRESS));
    const hit = await forwardGeocode("100 Main St Lexington NC");
    expect(hit!.source).toBe("mapbox");
    expect(calls.some(u => u.includes("nominatim"))).toBe(false);
  });

  it("a repeat query is served from cache - no provider is called twice", async () => {
    vi.stubGlobal("fetch", stubFetch(401, NOMINATIM_ADDRESS));
    await forwardGeocode("100 Main St Lexington NC");
    const before = calls.length;
    await forwardGeocode("100 MAIN ST LEXINGTON NC"); // same query, different case
    expect(calls.length).toBe(before);
  });

  it("a genuine no-match is null, NOT an outage - the rep is told 'no such address'", async () => {
    vi.stubGlobal("fetch", stubFetch(401, []));
    await expect(forwardGeocode("nowhere at all")).resolves.toBeNull();
  });

  it("every provider down throws, so the route can answer 503 instead of 404", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(500, {})));
    await expect(forwardGeocode("100 Main St Lexington NC")).rejects.toThrow(/unavailable/i);
  });
});

describe("reverseGeocode survives a dead Mapbox token", () => {
  it("a 401 falls through to OSM and returns parsed address parts", async () => {
    vi.stubGlobal("fetch", stubFetch(401, NOMINATIM_REVERSE));
    const hit = await reverseGeocode(35.8235, -80.2542);
    expect(hit).toMatchObject({
      address: "100 South Main Street",
      city: "Lexington",
      state: "NC",
      zip: "27292",
      source: "nominatim",
    });
  });
});

describe("geocodePlace survives a dead Mapbox token", () => {
  // geocodeCity() is the first step of every city sweep and market-inventory
  // harvest; a 401 here used to THROW and kill the whole job.
  it("a 401 falls through to OSM and returns a padded bbox", async () => {
    vi.stubGlobal("fetch", stubFetch(401, NOMINATIM_PLACE));
    const place = await geocodePlace("Lexington", "NC");
    expect(place).not.toBeNull();
    expect(place!.source).toBe("nominatim");
    // Nominatim's boundingbox is [south, north, west, east] - a transposition
    // here would hand every sweep a bbox on the wrong side of the planet.
    expect(place!.bbox.south).toBeLessThan(place!.bbox.north);
    expect(place!.bbox.west).toBeLessThan(place!.bbox.east);
    expect(place!.bbox.south).toBeCloseTo(35.7574 - (35.8593 - 35.7574) * 0.1, 2);
    expect(place!.center[0]).toBeCloseTo(-80.2533, 3);
    expect(place!.center[1]).toBeCloseTo(35.8240, 3);
  });

  it("picks the POPULATED place, not the same-named county", async () => {
    // "Monroe, Iowa" returns Monroe COUNTY first; the village is what a sweep means.
    const rows = [
      { lat: "41.5", lon: "-93.0", name: "Monroe County", addresstype: "administrative", boundingbox: ["41.1", "41.9", "-93.5", "-92.5"], address: { state: "Iowa", "ISO3166-2-lvl4": "US-IA" } },
      { lat: "41.5222", lon: "-93.1010", name: "Monroe", addresstype: "city", boundingbox: ["41.51", "41.53", "-93.11", "-93.09"], address: { city: "Monroe", state: "Iowa", "ISO3166-2-lvl4": "US-IA" } },
    ];
    vi.stubGlobal("fetch", stubFetch(401, rows));
    const place = await geocodePlace("Monroe", "IA");
    expect(place!.name).toBe("Monroe");
  });

  it("ignores a same-named place in the WRONG state", async () => {
    const rows = [
      { lat: "38.2", lon: "-85.7", name: "Lexington", addresstype: "city", boundingbox: ["38.1", "38.3", "-85.8", "-85.6"], address: { city: "Lexington", state: "Kentucky", "ISO3166-2-lvl4": "US-KY" } },
      ...NOMINATIM_PLACE,
    ];
    vi.stubGlobal("fetch", stubFetch(401, rows));
    const place = await geocodePlace("Lexington", "NC");
    expect(place!.center[1]).toBeCloseTo(35.8240, 3); // the NC one
  });
});

describe("the OSM rate policy is not env-configurable", () => {
  it("keeps the 1 req/s floor on nominatim.openstreetmap.org however low the env says", async () => {
    delete process.env.NOMINATIM_BASE_URL; // back to the official host
    process.env.NOMINATIM_MIN_INTERVAL_MS = "1";
    resetGeocoderState();
    vi.stubGlobal("fetch", stubFetch(401, NOMINATIM_ADDRESS));
    const started = Date.now();
    await forwardGeocode("1 First St Lexington NC");
    await forwardGeocode("2 Second St Lexington NC");
    // Two calls one second apart, not two calls a millisecond apart.
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  }, 10_000);
});
