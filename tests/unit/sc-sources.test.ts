import { describe, expect, it } from "vitest";
import {
  pollScCountyAddresses, SC_COUNTY_SOURCES, SC_COUNTY_SOURCE_ID, type ScCountySource,
} from "../../server/newBuildSources";

// SC county authoritative address sources: incremental OID-cursor pollers
// mirroring the NC OneMap pattern. Endpoints in SC_COUNTY_SOURCES were
// live-verified (2026-07-17); these tests prove parsing + cursor mechanics
// against mocked fetch so no network is touched.

const SPARTANBURG: ScCountySource = {
  county: "Spartanburg",
  layerUrl: "https://maps.spartanburgcounty.org/server/rest/services/GIS/Address_Points/FeatureServer/0",
  oidField: "OBJECTID", addressFields: ["FullName"], cityFields: ["MSAGComm", "Inc_Muni"], zipField: "Post_Code", pageSize: 1000,
};

const LANCASTER: ScCountySource = {
  county: "Lancaster",
  layerUrl: "https://services3.arcgis.com/rJcpRneDUBgTeCT3/arcgis/rest/services/LC_Addresses/FeatureServer/0",
  oidField: "FID", addressFields: ["WHOLE_ADDR"], cityFields: ["POSTAL_TOW", "INC_MUNI"], zipField: "POSTAL_ZIP", pageSize: 1000,
};

function mkFetch(map: Record<string, any>, seen: string[] = []) {
  return (async (url: string) => {
    seen.push(url);
    const key = Object.keys(map).find((k) => url.includes(k));
    const body = key ? map[key] : { features: [] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as any;
}

describe("SC county address source poller", () => {
  it("SEEDS on first contact via a top-1 DESC probe (no backlog ingested)", async () => {
    const seen: string[] = [];
    const fetchImpl = mkFetch({ "resultRecordCount=1": { features: [{ attributes: { OBJECTID: 636803 } }] } }, seen);
    const r = await pollScCountyAddresses(SPARTANBURG, "0", { fetchImpl });
    expect(r.seeded).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.candidates.length).toBe(0);
    expect(r.cursor).toBe("636803");
    expect(r.source).toBe(SC_COUNTY_SOURCE_ID);
    // The seed probe orders by the configured OID field descending, top 1 only.
    expect(seen[0]).toContain("orderByFields=OBJECTID%20DESC");
    expect(seen[0]).toContain("resultRecordCount=1");
  });

  it("incremental poll returns only OID>cursor rows, normalized to SC candidates, cursor advanced", async () => {
    const seen: string[] = [];
    const fetchImpl = mkFetch({
      query: {
        features: [
          {
            attributes: { OBJECTID: 636804, FullName: "1425 BLACKSTOCK RD", MSAGComm: "PAULINE", Inc_Muni: "UNINCORPORATED", Post_Code: "29374" },
            geometry: { x: -81.87524, y: 34.77441 },
          },
          {
            attributes: { OBJECTID: 636809, FullName: "1723 E MAIN ST", MSAGComm: "", Inc_Muni: "DUNCAN", Post_Code: "29334" },
            geometry: { x: -82.0933, y: 34.90093 },
          },
        ],
      },
    }, seen);
    const r = await pollScCountyAddresses(SPARTANBURG, "636803", { fetchImpl, now: () => 5000 });
    expect(r.seeded).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.recordsSeen).toBe(2);
    expect(r.candidates.length).toBe(2);
    expect(r.candidates[0]).toMatchObject({
      source: SC_COUNTY_SOURCE_ID, sourceRecordId: "spartanburg:636804",
      address: "1425 Blackstock Rd", city: "Pauline", state: "SC", zip: "29374", county: "Spartanburg",
      lat: 34.77441, lng: -81.87524, buildStage: "addressed", confidence: "authoritative", detectedAt: 5000,
    });
    // UNINCORPORATED is never a postal city; falls through to the next field.
    expect(r.candidates[1].city).toBe("Duncan");
    expect(r.cursor).toBe("636809"); // high-water-mark advanced to max OID seen
    // The incremental query filters on the OID cursor and requests WGS84 geometry.
    expect(decodeURIComponent(seen[0])).toContain("OBJECTID>636803");
    expect(seen[0]).toContain("outSR=4326");
    expect(seen[0]).toContain(`resultRecordCount=${SPARTANBURG.pageSize}`);
  });

  it("uses the per-source OID field (Lancaster FID) and handles integer zips", async () => {
    const seen: string[] = [];
    const fetchImpl = mkFetch({
      query: {
        features: [{
          attributes: { FID: 64634, WHOLE_ADDR: "3270 FERN HOLLOW DR", POSTAL_TOW: "LANCASTER", INC_MUNI: " ", POSTAL_ZIP: 29720 },
          geometry: { x: -80.8652, y: 34.63567 },
        }],
      },
    }, seen);
    const r = await pollScCountyAddresses(LANCASTER, "64633", { fetchImpl });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]).toMatchObject({ address: "3270 Fern Hollow Dr", city: "Lancaster", zip: "29720", state: "SC", county: "Lancaster" });
    expect(r.cursor).toBe("64634");
    expect(decodeURIComponent(seen[0])).toContain("FID>64633");
    expect(decodeURIComponent(seen[0])).toContain("orderByFields=FID ASC");
  });

  it("a layer without city fields yields city:null (Greenville shape), never a fabricated city", async () => {
    const greenville = SC_COUNTY_SOURCES.find((s) => s.county === "Greenville")!;
    const fetchImpl = mkFetch({
      query: { features: [{ attributes: { OBJECTID: 1539039, ADDRESS: "152 DUNCAN RD", ZIPCODE: 29690 }, geometry: { x: -82.44946, y: 34.98326 } }] },
    });
    const r = await pollScCountyAddresses(greenville, "1539038", { fetchImpl });
    expect(r.candidates[0]).toMatchObject({ address: "152 Duncan Rd", city: null, zip: "29690", county: "Greenville" });
  });

  it("keeps the cursor and reports honestly on HTTP errors and ArcGIS body errors", async () => {
    const httpFail = (async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" })) as any;
    const r1 = await pollScCountyAddresses(SPARTANBURG, "100", { fetchImpl: httpFail });
    expect(r1.ok).toBe(false);
    expect(r1.cursor).toBe("100"); // never loses ground on failure
    expect(r1.note).toContain("503");

    // ArcGIS returns 200 with an error body for bad queries — must not be treated as success.
    const bodyFail = mkFetch({ query: { error: { code: 400, message: "Invalid query" } } });
    const r2 = await pollScCountyAddresses(SPARTANBURG, "100", { fetchImpl: bodyFail });
    expect(r2.ok).toBe(false);
    expect(r2.cursor).toBe("100");
    expect(r2.note).toContain("400");
  });

  it("rows with no parsable address become addressless candidates (monitored, not dropped)", async () => {
    const fetchImpl = mkFetch({
      query: { features: [{ attributes: { OBJECTID: 700, FullName: "", MSAGComm: "INMAN", Post_Code: "29349" }, geometry: { x: -82.09, y: 35.05 } }] },
    });
    const r = await pollScCountyAddresses(SPARTANBURG, "699", { fetchImpl });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].buildStage).toBe("addressless");
    expect(r.candidates[0].address).toBeNull();
  });

  it("registry sanity: unique counties, page sizes bounded, https layer URLs, Kinetic SC markets covered", () => {
    const counties = SC_COUNTY_SOURCES.map((s) => s.county);
    expect(new Set(counties).size).toBe(counties.length);
    for (const s of SC_COUNTY_SOURCES) {
      expect(s.layerUrl.startsWith("https://")).toBe(true);
      expect(s.layerUrl.endsWith("/")).toBe(false);
      expect(s.pageSize).toBeGreaterThan(0);
      expect(s.pageSize).toBeLessThanOrEqual(1000); // stay well under every verified maxRecordCount
      expect(s.addressFields.length).toBeGreaterThan(0);
      expect(s.oidField.length).toBeGreaterThan(0);
    }
    // The verified county set covering Kinetic SC markets (Cherokee + Union have
    // no public ArcGIS REST — tracked as KNOWN_GAPS in the radar, not here).
    for (const c of ["Spartanburg", "Greenville", "York", "Lancaster", "Anderson", "Laurens"]) {
      expect(counties).toContain(c);
    }
  });
});
