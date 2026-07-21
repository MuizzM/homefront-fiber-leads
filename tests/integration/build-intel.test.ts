import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Build Intelligence — news + permit signals promote cities into the dynamic
// hot zone the 20-min burst unions with HOT_MARKETS. Pure parsing/extraction is
// exercised on fixtures; promotion/expiry/union against a real temp DB. No
// network — the fetch ticks are NOT run here.

let bi: typeof import("../../server/buildIntel");
let rawDb: import("better-sqlite3").Database;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-build-intel-"));
  ({ rawDb } = await import("../../server/db"));
  bi = await import("../../server/buildIntel");
  bi.ensureBuildIntelSchema();
});

const RSS = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>Kinetic by Windstream launches fiber expansion in Concord, N.C.</title>
    <link>https://example.com/a1</link>
    <pubDate>Mon, 20 Jul 2026 12:00:00 GMT</pubDate>
    <description><![CDATA[The build will pass 4,100 homes in Concord and nearby Kannapolis, N.C., officials said.]]></description>
  </item>
  <item>
    <title>County approves broadband construction permits</title>
    <link>https://example.com/a2</link>
    <description>Crews begin fiber construction in Rockwell, NC next month.</description>
  </item>
</channel></rss>`;

describe("build intel — RSS parsing + city extraction", () => {
  it("parses items with CDATA, entities, and both link styles", () => {
    const items = bi.parseRssItems(RSS);
    expect(items.length).toBe(2);
    expect(items[0].title).toContain("Concord, N.C.");
    expect(items[0].link).toBe("https://example.com/a1");
    expect(items[0].description).toContain("Kannapolis");
  });

  it('extracts "<City>, ST" mentions — including towns NOT in any known list (footprint growth)', () => {
    const got = bi.extractCityMentions("Crews begin work in Rockwell, NC and later in Locust, N.C. this year.");
    expect(got).toContainEqual({ city: "rockwell", state: "nc" });
    expect(got).toContainEqual({ city: "locust", state: "nc" }); // no catalog needed
  });

  it("matches known footprint cities on word boundaries only", () => {
    const known = [{ city: "concord", state: "nc" }, { city: "landis", state: "nc" }];
    const got = bi.extractCityMentions("The Concordance project is unrelated; service reaches Landis today.", known);
    expect(got).not.toContainEqual({ city: "concord", state: "nc" }); // "Concordance" ≠ Concord
    expect(got).toContainEqual({ city: "landis", state: "nc" });
  });

  it("normalizes every state-token spelling to the 2-letter code", () => {
    const got = bi.extractCityMentions("Builds in Salisbury, North Carolina; Inman, S.C.; Dalton, Ga.");
    expect(got).toContainEqual({ city: "salisbury", state: "nc" });
    expect(got).toContainEqual({ city: "inman", state: "sc" });
    expect(got).toContainEqual({ city: "dalton", state: "ga" });
  });
});

describe("build intel — signals, promotion rules, TTL, hot-zone union", () => {
  it("dedupes identical signals by hash", () => {
    const sig = { kind: "news" as const, source: "example.com", url: "https://example.com/x", title: "t", city: "concord", state: "nc" };
    expect(bi.recordSignal(sig)).toBe(true);
    expect(bi.recordSignal(sig)).toBe(false); // replay is a no-op
  });

  it("one OFFICIAL release promotes immediately; independent news needs two articles", () => {
    bi.recordSignal({ kind: "official", source: "news.windstream.com", url: "https://news.windstream.com/r1", title: "expansion", city: "broadway", state: "nc" });
    // concord already has ONE news signal from the dedupe test — not enough yet.
    let promoted = bi.evaluatePromotions();
    expect(promoted).toContainEqual(expect.objectContaining({ city: "broadway", state: "nc" }));
    expect(promoted.find((p) => p.city === "concord")).toBeUndefined();
    // Second distinct article → over the threshold.
    bi.recordSignal({ kind: "news", source: "paper.com", url: "https://paper.com/y", title: "t2", city: "concord", state: "nc" });
    promoted = bi.evaluatePromotions();
    expect(promoted).toContainEqual(expect.objectContaining({ city: "concord", state: "nc" }));
  });

  it("permit surge promotes only past the threshold", () => {
    for (let i = 0; i < 24; i++)
      bi.recordSignal({ kind: "permit", source: "cabarrus", city: "midland", state: "nc", dedupeKey: `p-${i}` });
    expect(bi.evaluatePromotions().find((p) => p.city === "midland")).toBeUndefined(); // 24 < 25
    bi.recordSignal({ kind: "permit", source: "cabarrus", city: "midland", state: "nc", dedupeKey: "p-24" });
    expect(bi.evaluatePromotions()).toContainEqual(expect.objectContaining({ city: "midland", state: "nc" }));
  });

  it("expired promotions drop out of the dynamic list", () => {
    rawDb.prepare(
      `INSERT INTO hot_zone_dynamic (city,state,reason,expires_at) VALUES ('oldzone','nc','stale',datetime('now','-1 day'))
       ON CONFLICT(city,state) DO UPDATE SET expires_at=excluded.expires_at`,
    ).run();
    const active = bi.listDynamicHotMarkets().map((d) => d.city);
    expect(active).not.toContain("oldzone");
    expect(active).toContain("broadway");
  });

  it("listHotMarkets unions env entries with dynamic promotions, env first, deduped", () => {
    const list = bi.listHotMarkets("dalton:ga, broadway:nc");
    expect(list[0]).toEqual({ city: "dalton", state: "ga" });      // operator order preserved
    expect(list.filter((e) => e.city === "broadway").length).toBe(1); // env+dynamic dedupe
    expect(list).toContainEqual({ city: "concord", state: "nc" }); // news-promoted
    expect(list).toContainEqual({ city: "midland", state: "nc" }); // permit-promoted
  });
});
