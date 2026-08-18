import { describe, expect, it } from "vitest";
import {
  extractAllKineticLocationNames, extractFiberLocationNames, KINETIC_MARKET_CATALOG,
  KINETIC_DIRECTORY_URLS, KINETIC_MONITORED_STATES, NC_Q1_2026_EXPANSION_URL, NC_Q4_2025_EXPANSION_URL,
} from "../../server/kineticMarketCatalog";

describe("Kinetic market catalog", () => {
  it("contains every normalized carrier market while keeping fiber and change-watch evidence distinct", () => {
    const keys = KINETIC_MARKET_CATALOG.map((m) => `${m.state}|${m.city.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("NC|lexington");
    expect(keys).toContain("SC|lexington");
    expect(keys).toContain("SC|landrum");
    expect(keys).not.toContain("NC|landrum");
    expect(keys).toContain("GA|dalton");
    expect(keys).toContain("FL|live oak");
    expect(keys).toContain("FL|lake city");
    expect(keys).toContain("FL|white springs");
    expect(keys).toHaveLength(171);
    expect(KINETIC_MARKET_CATALOG.filter((m) => m.status === "verified_expanding").length).toBe(14);
    expect(KINETIC_MARKET_CATALOG.filter((m) => m.status === "verified_legacy_service")).toHaveLength(97);
    // Copper-switch watch: an ordinary legacy copper town now re-sweeps at 72h
    // (was 336h) so a copper→fiber flip is caught within days, not weeks.
    expect(KINETIC_MARKET_CATALOG.find((m) => m.city === "Statesville" && m.state === "NC")).toMatchObject({
      status: "verified_legacy_service", serviceTier: "other_high_speed", cadenceHours: 72, priorityScore: 40,
    });
    // Funded SW-Chatham CAB town (Bear Creek) runs daily with a score boost.
    expect(KINETIC_MARKET_CATALOG.find((m) => m.city === "Bear Creek" && m.state === "NC")).toMatchObject({
      status: "verified_legacy_service", cadenceHours: 24, priorityScore: 90,
    });
    const hemby = KINETIC_MARKET_CATALOG.find((m) => m.city === "Hemby Bridge" && m.state === "NC")!;
    expect(hemby.directoryVerified).toBe(false);
    expect(hemby.announcementUrls).toEqual([NC_Q4_2025_EXPANSION_URL]);
    const albemarle = KINETIC_MARKET_CATALOG.find((m) => m.city === "Albemarle" && m.state === "NC")!;
    expect(albemarle.announcementUrls).toEqual([NC_Q4_2025_EXPANSION_URL, NC_Q1_2026_EXPANSION_URL]);
  });

  it("extracts only the official fiber section, not other high-speed locations", () => {
    const html = `<h2>Here's where we currently offer Kinetic Fiber Internet</h2>
      <a href="/locations/nc/lexington">Lexington</a><a href="/locations/nc/mt-pleasant">Mt Pleasant</a>
      <h2>Kinetic Fiber internet plans</h2><a href="/locations/nc/statesville">Statesville</a>`;
    expect(extractFiberLocationNames(html, "NC")).toEqual(["Lexington", "Mt Pleasant"]);
    expect(extractAllKineticLocationNames(html, "NC")).toEqual(["Lexington", "Mt Pleasant", "Statesville"]);
  });

  it("supports the six authorized monitoring states and parses Kentucky and Iowa directory links", () => {
    expect(KINETIC_MONITORED_STATES).toEqual(["FL", "GA", "IA", "KY", "NC", "SC"]);
    expect(KINETIC_DIRECTORY_URLS.IA).toBe("https://www.gokinetic.com/locations/ia");
    expect(KINETIC_DIRECTORY_URLS.KY).toBe("https://www.gokinetic.com/locations/ky");

    const ia = `<h2>Here's where we currently offer Kinetic Fiber Internet</h2>
      <a href="/locations/ia/adel">Adel</a><a href="/locations/ia/ottumwa">Ottumwa</a>
      <h2>Kinetic Fiber internet plans</h2><a href="/locations/ia/legacy">Legacy</a>`;
    const ky = `<h2>Here's where we currently offer Kinetic Fiber Internet</h2>
      <a href="/locations/ky/lexington">Lexington</a><a href="/locations/ky/somerset">Somerset</a>
      <h2>Kinetic Fiber internet plans</h2><a href="/locations/ky/legacy">Legacy</a>`;
    expect(extractFiberLocationNames(ia, "IA")).toEqual(["Adel", "Ottumwa"]);
    expect(extractAllKineticLocationNames(ia, "IA")).toEqual(["Adel", "Ottumwa", "Legacy"]);
    expect(extractFiberLocationNames(ky, "KY")).toEqual(["Lexington", "Somerset"]);
    expect(extractAllKineticLocationNames(ky, "KY")).toEqual(["Lexington", "Somerset", "Legacy"]);
  });
});
