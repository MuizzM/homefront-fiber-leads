import { describe, expect, it } from "vitest";
import {
  extractAllKineticLocationNames, extractFiberLocationNames, KINETIC_MARKET_CATALOG,
  NC_Q1_2026_EXPANSION_URL, NC_Q4_2025_EXPANSION_URL,
} from "../../server/kineticMarketCatalog";

describe("Kinetic NC/SC market catalog", () => {
  it("contains every normalized carrier market while keeping fiber and change-watch evidence distinct", () => {
    const keys = KINETIC_MARKET_CATALOG.map((m) => `${m.state}|${m.city.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("NC|lexington");
    expect(keys).toContain("SC|lexington");
    expect(keys).toContain("SC|landrum");
    expect(keys).not.toContain("NC|landrum");
    expect(keys).toHaveLength(132);
    expect(KINETIC_MARKET_CATALOG.filter((m) => m.status === "verified_expanding").length).toBe(13);
    expect(KINETIC_MARKET_CATALOG.filter((m) => m.status === "verified_legacy_service")).toHaveLength(69);
    expect(KINETIC_MARKET_CATALOG.find((m) => m.city === "Statesville" && m.state === "NC")).toMatchObject({
      status: "verified_legacy_service", serviceTier: "other_high_speed", cadenceHours: 336,
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
});
