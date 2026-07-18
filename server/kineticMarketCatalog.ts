import crypto from "node:crypto";
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

export type KineticMarketStatus = "verified_served" | "verified_expanding" | "verified_legacy_service" | "unverified";

export interface KineticMarketCatalogEntry {
  city: string;
  state: "NC" | "SC" | "GA";
  county: string;
  status: Exclude<KineticMarketStatus, "unverified">;
  serviceTier: "fiber" | "other_high_speed" | "announced_expansion";
  priorityClass: "critical" | "medium" | "low";
  priorityScore: number;
  cadenceHours: number;
  directoryUrl: string;
  directoryVerified: boolean;
  announcementUrls: string[];
}

export const KINETIC_DIRECTORY_URLS = {
  NC: "https://www.gokinetic.com/locations/nc",
  SC: "https://www.gokinetic.com/locations/sc",
  GA: "https://www.gokinetic.com/locations/ga",
} as const;

export const NC_Q1_2026_EXPANSION_URL =
  "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds";
export const NC_Q4_2025_EXPANSION_URL =
  "https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7600-new-kinetic-fiber-builds/";
export const CATALOG_OBSERVED_AT = "2026-07-14T00:00:00.000Z";

const EXPANDING_NC = new Set([
  "albemarle", "broadway", "concord", "granite quarry", "hemby bridge", "indian trail",
  "kannapolis", "lexington", "morven", "pinebluff", "sanford", "tryon", "wingate",
]);
const Q1_2026_NC = new Set([
  "albemarle", "broadway", "concord", "indian trail", "kannapolis", "lexington",
  "morven", "pinebluff", "tryon", "wingate",
]);

const NC_FIBER: Record<string, string> = {
  Aberdeen: "Moore", Albemarle: "Stanly", Badin: "Stanly", Broadway: "Lee", Cameron: "Moore",
  Charlotte: "Mecklenburg", "China Grove": "Rowan", Columbus: "Polk", Concord: "Cabarrus",
  Cornelius: "Mecklenburg", Davidson: "Mecklenburg", Denton: "Davidson", "Gold Hill": "Rowan",
  "Granite Quarry": "Rowan", Harrisburg: "Cabarrus", Huntersville: "Mecklenburg",
  "Indian Trail": "Union", Kannapolis: "Cabarrus|Rowan", King: "Stokes", Landis: "Rowan",
  Lewisville: "Forsyth", Lexington: "Davidson", Linwood: "Davidson", Marshville: "Union",
  Marvin: "Union", Matthews: "Mecklenburg", Midland: "Cabarrus", "Mint Hill": "Mecklenburg",
  Monroe: "Union", Mooresville: "Iredell", Morven: "Anson", "Mount Pleasant": "Cabarrus",
  "New London": "Stanly", Norwood: "Stanly", Oakboro: "Stanly", Peachland: "Anson",
  Pfafftown: "Forsyth", Pinebluff: "Moore", Polkton: "Anson", Richfield: "Stanly",
  Rockwell: "Rowan", "Rural Hall": "Forsyth", Salisbury: "Rowan", Sanford: "Lee",
  Stallings: "Union", Stanfield: "Stanly", Thomasville: "Davidson", Tryon: "Polk",
  Wadesboro: "Anson", Waxhaw: "Union", Weddington: "Union", Wingate: "Union",
  "Winston-Salem": "Forsyth",
};

const SC_FIBER: Record<string, string> = {
  Cameron: "Calhoun", Campobello: "Spartanburg", Inman: "Spartanburg", Kershaw: "Lancaster",
  Landrum: "Spartanburg", Lexington: "Lexington", "Saint Matthews": "Calhoun",
  Spartanburg: "Spartanburg", "West Columbia": "Lexington",
};

// Carrier-listed "other high-speed internet" places are verified Kinetic
// service territory, but NOT evidence of fiber. Monitoring them at a slower
// cadence is essential: they are the most likely places to produce the next
// copper/no-service → fiber transition. Aliases (China Grove-Landis and St
// Matthews) are intentionally folded into their physical markets.
const NC_LEGACY_SERVICE: Record<string, string> = {
  Ansonville: "Anson", Lilesville: "Anson", McFarlan: "Anson",
  "Bear Creek": "Chatham", Goldston: "Chatham", Moncure: "Chatham", Hayesville: "Clay",
  Southmont: "Davidson", Welcome: "Davidson", Bethania: "Forsyth", Clemmons: "Forsyth",
  "Old Town": "Forsyth", Stanleyville: "Forsyth", Tobaccoville: "Forsyth", "High Point": "Guilford",
  Lillington: "Harnett", Olivia: "Harnett", Raeford: "Hoke", Olin: "Iredell",
  Statesville: "Iredell", Troutman: "Iredell", "Lemon Springs": "Lee", Otto: "Macon",
  "Scaly Mountain": "Macon", Carthage: "Moore", "Jackson Springs": "Moore", Pinehurst: "Moore",
  "Southern Pines": "Moore", "Green Creek": "Polk", Lynn: "Polk", "Mill Spring": "Polk",
  Saluda: "Polk", Randleman: "Randolph", Hoffman: "Richmond", Marston: "Richmond",
  "Red Springs": "Robeson", Cleveland: "Rowan", Faith: "Rowan", "Mount Ulla": "Rowan",
  Rutherfordton: "Rutherford", Gibson: "Scotland", Laurinburg: "Scotland", "Laurel Hill": "Scotland",
  Wagram: "Scotland", Locust: "Stanly", Misenheimer: "Stanly", Germanton: "Stokes",
  Pinnacle: "Stokes", Westfield: "Surry", "Hemby Bridge": "Union", "Lake Park": "Union",
  "Mineral Springs": "Union", "New Salem": "Union", "Wesley Chapel": "Union", "New Hill": "Wake",
};

const SC_LEGACY_SERVICE: Record<string, string> = {
  Creston: "Calhoun", "Fort Motte": "Calhoun", Jefferson: "Chesterfield", Bethune: "Kershaw",
  Camden: "Kershaw", "Liberty Hill": "Kershaw", Westville: "Kershaw", "Heath Springs": "Lancaster",
  Gilbert: "Lexington", Swansea: "Lexington", Elloree: "Orangeburg", North: "Orangeburg",
  Orangeburg: "Orangeburg", Gramling: "Spartanburg", Wellford: "Spartanburg",
};

/**
 * Current carrier-published fiber markets, normalized to physical NC/SC places.
 * The NC directory's duplicate "Mt Pleasant" is folded into Mount Pleasant and
 * its geographically invalid "Landrum, NC" entry is represented once as SC.
 */
// Georgia: Dalton is an active fresh-fiber build zone (field-confirmed). The
// surrounding north-GA Kinetic ILEC territory is seeded as legacy/transition
// candidates — the weekly directory watch promotes/corrects entries.
const GA_FIBER: Record<string, string> = {
  Dalton: "Whitfield",
};

const GA_LEGACY_SERVICE: Record<string, string> = {
  Chatsworth: "Murray", "Eton": "Murray", Calhoun: "Gordon", Resaca: "Gordon",
  Adairsville: "Bartow", "Rydal": "Bartow", Ellijay: "Gilmer", "East Ellijay": "Gilmer",
  "Blue Ridge": "Fannin", McCaysville: "Fannin", Jasper: "Pickens", "Talking Rock": "Pickens",
  Dawsonville: "Dawson", Cleveland: "White", Cornelia: "Habersham", Toccoa: "Stephens",
  LaFayette: "Walker", Chickamauga: "Walker", "Fort Oglethorpe": "Catoosa", Ringgold: "Catoosa",
  Summerville: "Chattooga", Trion: "Chattooga", Cedartown: "Polk", Rockmart: "Polk",
  Dallas: "Paulding", Hiram: "Paulding", Trenton: "Dade", "Rising Fawn": "Dade",
};

const EXPANDING_GA = new Set(["dalton"]);

export const KINETIC_MARKET_CATALOG: KineticMarketCatalogEntry[] = [
  ...Object.entries(GA_FIBER).map(([city, county]) => makeEntry(city, "GA", county)),
  ...Object.entries(GA_LEGACY_SERVICE).map(([city, county]) => makeLegacyEntry(city, "GA", county)),
  ...Object.entries(NC_FIBER).map(([city, county]) => makeEntry(city, "NC", county)),
  ...Object.entries(SC_FIBER).map(([city, county]) => makeEntry(city, "SC", county)),
  ...Object.entries(NC_LEGACY_SERVICE)
    .filter(([city]) => city !== "Hemby Bridge")
    .map(([city, county]) => makeLegacyEntry(city, "NC", county)),
  ...Object.entries(SC_LEGACY_SERVICE).map(([city, county]) => makeLegacyEntry(city, "SC", county)),
  // Named in the official Q4 build release but conservatively listed under
  // "other high-speed" on the current state directory. Expansion evidence is
  // sufficient to scan it; no directory-fiber claim is synthesized.
  { ...makeEntry("Hemby Bridge", "NC", "Union"), directoryVerified: false, serviceTier: "announced_expansion" },
];

function makeEntry(city: string, state: "NC" | "SC" | "GA", county: string): KineticMarketCatalogEntry {
  const expanding = (state === "NC" && EXPANDING_NC.has(normalizePlace(city)))
    || (state === "GA" && EXPANDING_GA.has(normalizePlace(city)));
  return {
    city, state, county,
    status: expanding ? "verified_expanding" : "verified_served",
    serviceTier: expanding ? "announced_expansion" : "fiber",
    priorityClass: expanding ? "critical" : "medium",
    priorityScore: expanding ? 100 : 65,
    cadenceHours: expanding ? 24 : 168,
    directoryUrl: KINETIC_DIRECTORY_URLS[state],
    directoryVerified: true,
    announcementUrls: expanding
      ? [NC_Q4_2025_EXPANSION_URL, ...(Q1_2026_NC.has(normalizePlace(city)) ? [NC_Q1_2026_EXPANSION_URL] : [])]
      : [],
  };
}

function makeLegacyEntry(city: string, state: "NC" | "SC" | "GA", county: string): KineticMarketCatalogEntry {
  return {
    city, state, county, status: "verified_legacy_service", serviceTier: "other_high_speed",
    priorityClass: "low", priorityScore: 40, cadenceHours: 336,
    directoryUrl: KINETIC_DIRECTORY_URLS[state], directoryVerified: true, announcementUrls: [],
  };
}

export function applyAuthoritativeMarketCatalog(): { verified: number; expanding: number; synthetic: number } {
  const markets = rawDb.prepare(`SELECT id,state,city FROM state_fiber_markets`).all() as Array<{ id: number; state: string; city: string }>;
  const byPlace = new Map(markets.map((m) => [`${m.state}|${normalizePlace(m.city)}`, m]));
  const insertSynthetic = rawDb.prepare(`INSERT INTO state_fiber_markets
    (state,place_fips,city,legal_name,county,counties_json,population,priority_class,priority_score,
     priority_reasons,cadence_hours,source_vintage,next_scan_at,kinetic_status,auto_scan_eligible,
     directory_url,evidence_checked_at,directory_last_seen_at,coverage_gap)
    VALUES (?,?,?,?,?,?,0,?,?,?,?,?,datetime('now'),?,1,?,?,?,?)`);
  const update = rawDb.prepare(`UPDATE state_fiber_markets SET
    county=COALESCE(county,?), counties_json=CASE WHEN counties_json='[]' THEN ? ELSE counties_json END,
    kinetic_status=?,auto_scan_eligible=1,directory_url=?,evidence_checked_at=?,directory_last_seen_at=?,
    coverage_gap=CASE WHEN lat IS NULL OR lng IS NULL THEN 'coordinates_pending' ELSE NULL END,
    priority_class=CASE WHEN ?='verified_expanding' THEN 'critical' WHEN ?='verified_served' THEN 'medium' WHEN population>=25000 THEN 'medium' ELSE 'low' END,
    priority_score=CASE WHEN ?='verified_expanding' THEN 100 WHEN ?='verified_served' THEN 65 WHEN population>=25000 THEN 65 ELSE 45 END,
    cadence_hours=CASE WHEN ?='verified_expanding' THEN 24 WHEN ?='verified_served' THEN 168 WHEN population>=25000 THEN 168 ELSE 336 END,
    priority_reasons=?,announcement_url=COALESCE(?,announcement_url),
    next_scan_at=MIN(COALESCE(next_scan_at,datetime('now')),datetime('now')),updated_at=datetime('now')
    WHERE id=?`);
  const evidence = rawDb.prepare(`INSERT INTO market_evidence
    (market_id,evidence_type,source_url,source_title,observed_at,content_hash)
    VALUES (?,?,?,?,?,?) ON CONFLICT(market_id,evidence_type,source_url) DO UPDATE SET
      source_title=excluded.source_title,observed_at=excluded.observed_at,content_hash=excluded.content_hash`);

  let synthetic = 0;
  const tx = rawDb.transaction(() => {
    // A Census place is planning inventory, not carrier evidence. Previously
    // verified rows retain eligibility through their evidence ledger.
    rawDb.prepare(`UPDATE state_fiber_markets SET kinetic_status='unverified',auto_scan_eligible=0,
      coverage_gap=COALESCE(coverage_gap,'carrier_presence_unverified')
      WHERE NOT EXISTS (SELECT 1 FROM market_evidence e WHERE e.market_id=state_fiber_markets.id)`).run();
    for (const entry of KINETIC_MARKET_CATALOG) {
      const key = `${entry.state}|${normalizePlace(entry.city)}`;
      let market = byPlace.get(key);
      if (!market) {
        const fips = `official-${entry.state.toLowerCase()}-${slug(entry.city)}`;
        const result = insertSynthetic.run(
          entry.state, fips, entry.city, entry.city, entry.county, JSON.stringify(entry.county.split("|")),
          entry.priorityClass, entry.priorityScore, JSON.stringify(priorityReasons(entry)), entry.cadenceHours,
          "Kinetic official directory/build evidence 2026-07-14", entry.status, entry.directoryVerified ? entry.directoryUrl : null,
          CATALOG_OBSERVED_AT, CATALOG_OBSERVED_AT, "census_enrichment_pending",
        );
        market = { id: Number(result.lastInsertRowid), state: entry.state, city: entry.city };
        byPlace.set(key, market);
        synthetic++;
      }
      update.run(
        entry.county, JSON.stringify(entry.county.split("|")), entry.status, entry.directoryVerified ? entry.directoryUrl : null,
        CATALOG_OBSERVED_AT, CATALOG_OBSERVED_AT,
        entry.status, entry.status, entry.status, entry.status, entry.status, entry.status,
        JSON.stringify(priorityReasons(entry)), entry.announcementUrls[0] ?? null, market.id,
      );
      if (entry.directoryVerified) {
        writeEvidence(evidence, market.id, "official_directory", entry.directoryUrl,
          entry.serviceTier === "other_high_speed"
            ? `Kinetic ${entry.state} other high-speed locations directory`
            : `Kinetic ${entry.state} fiber locations directory`,
          CATALOG_OBSERVED_AT);
      }
      for (const url of entry.announcementUrls) {
        writeEvidence(evidence, market.id, "official_announcement", url,
          "Official Kinetic North Carolina fiber-build announcement", CATALOG_OBSERVED_AT);
      }
    }
  });
  tx();
  return {
    verified: KINETIC_MARKET_CATALOG.length,
    expanding: KINETIC_MARKET_CATALOG.filter((m) => m.status === "verified_expanding").length,
    synthetic,
  };
}

/** Continuous refresh of carrier-owned location indexes. New entries
 * become eligible; a missing entry is never silently removed because a partial
 * publisher response must not erase coverage. */
export async function refreshKineticLocationDirectory(force = false): Promise<{ status: string; seen: number; added: number }> {
  let seen = 0, added = 0;
  for (const state of ["NC", "SC", "GA"] as const) {
    const url = KINETIC_DIRECTORY_URLS[state];
    const prior = rawDb.prepare(`SELECT * FROM monitor_source_polls WHERE source_url=?`).get(url) as any;
    if (!force && prior?.next_poll_at && parseSqliteTime(prior.next_poll_at) > Date.now()) continue;
    const headers: Record<string, string> = {
      "user-agent": "HomeFrontFiber-MarketMonitor/1.0 (operations@homefrontsolutions.com)",
      accept: "text/html,application/xhtml+xml",
    };
    if (prior?.etag) headers["if-none-match"] = prior.etag;
    if (prior?.last_modified) headers["if-modified-since"] = prior.last_modified;
    try {
      const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
      if (response.status === 304) { recordDirectoryPoll(url, response, "not_modified", null, "+7 days"); continue; }
      if (!response.ok) throw new Error(`official directory returned ${response.status}`);
      const html = await response.text();
      const fiberNames = extractFiberLocationNames(html, state);
      const names = extractAllKineticLocationNames(html, state);
      if (fiberNames.length < (state === "NC" ? 40 : state === "SC" ? 5 : 1) || names.length < (state === "NC" ? 70 : state === "SC" ? 12 : 3)) {
        throw new Error(`partial directory response (${fiberNames.length} fiber / ${names.length} total markets)`);
      }
      const fiberKeys = new Set(fiberNames.map((name) => normalizePlace(canonicalDirectoryName(name))));
      seen += names.length;
      for (const name of names) {
        const canonical = canonicalDirectoryName(name);
        const normalized = normalizePlace(canonical);
        // The publisher currently duplicates the physical SC city Landrum on
        // its NC index. Keep one geographically valid target, never invent NC.
        if ((state === "NC" && normalized === "landrum") || normalized === "china grove landis") continue;
        const fiberListed = fiberKeys.has(normalized);
        const entry = KINETIC_MARKET_CATALOG.find((m) => m.state === state && normalizePlace(m.city) === normalized);
        if (!entry) {
          upsertDirectoryDiscovery(canonical, state, url, fiberListed);
          added++;
        } else {
          const status = fiberListed
            ? (entry.status === "verified_expanding" ? "verified_expanding" : "verified_served")
            : entry.status;
          rawDb.prepare(`UPDATE state_fiber_markets SET kinetic_status=?,auto_scan_eligible=1,
            directory_last_seen_at=datetime('now'),evidence_checked_at=datetime('now'),updated_at=datetime('now')
            WHERE state=? AND lower(replace(city,'-',' '))=lower(replace(?,'-',' '))`).run(status, state, entry.city);
        }
      }
      recordDirectoryPoll(url, response, "ok", null, "+7 days");
    } catch (error: any) {
      recordDirectoryPoll(url, null, "failed", error.message, "+1 day");
      structuredLog("state_monitor.directory_poll_failed", { state, sourceUrl: url, error: error.message });
      throw new Error(`KINETIC_DIRECTORY_REFRESH_FAILED: ${state}: ${error.message}`);
    }
  }
  return { status: "ok", seen, added };
}

export function extractFiberLocationNames(html: string, state: "NC" | "SC" | "GA"): string[] {
  const start = html.search(/where we currently offer Kinetic Fiber Internet/i);
  const end = html.search(/Kinetic Fiber internet plans|don.t see your city/i);
  const section = start >= 0 ? html.slice(start, end > start ? end : undefined) : "";
  const names = new Set<string>();
  const re = new RegExp(`<a\\b[^>]*href=["'][^"']*/locations/${state.toLowerCase()}/[^"']+["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
  for (const match of section.matchAll(re)) {
    const name = decodeEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (name && name.length <= 100) names.add(name);
  }
  return [...names];
}

export function extractAllKineticLocationNames(html: string, state: "NC" | "SC" | "GA"): string[] {
  const names = new Set<string>();
  const re = new RegExp(`<a\\b[^>]*href=["'][^"']*/locations/${state.toLowerCase()}/[^"']+["'][^>]*>([\\s\\S]*?)<\\/a>`, "gi");
  for (const match of html.matchAll(re)) {
    const name = decodeEntities(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (name && name.length <= 100) names.add(name);
  }
  return [...names];
}

function upsertDirectoryDiscovery(city: string, state: "NC" | "SC" | "GA", url: string, fiberListed: boolean) {
  const canonical = canonicalDirectoryName(city);
  const status: Exclude<KineticMarketStatus, "unverified" | "verified_expanding"> = fiberListed ? "verified_served" : "verified_legacy_service";
  const existing = rawDb.prepare(`SELECT id FROM state_fiber_markets WHERE state=? AND lower(city)=lower(?)`).get(state, canonical) as any;
  let id = existing?.id as number | undefined;
  if (!id) {
    id = Number(rawDb.prepare(`INSERT INTO state_fiber_markets
      (state,place_fips,city,legal_name,population,priority_class,priority_score,priority_reasons,cadence_hours,
       source_vintage,next_scan_at,kinetic_status,auto_scan_eligible,directory_url,evidence_checked_at,directory_last_seen_at,coverage_gap)
      VALUES (?,?,?,?,0,?,?,?, ?,?,datetime('now'),?,1,?,datetime('now'),datetime('now'),'census_enrichment_pending')`)
      .run(state, `official-${state.toLowerCase()}-${slug(canonical)}`, canonical, canonical,
        fiberListed ? "high" : "low", fiberListed ? 75 : 40,
        JSON.stringify([fiberListed ? "New carrier fiber-directory market; address inventory pending" : "New carrier other-high-speed market; fiber change watch"]),
        fiberListed ? 168 : 336, "Kinetic official locations directory live refresh", status, url).lastInsertRowid);
  } else {
    rawDb.prepare(`UPDATE state_fiber_markets SET kinetic_status=?,auto_scan_eligible=1,directory_url=?,
      directory_last_seen_at=datetime('now'),evidence_checked_at=datetime('now'),next_scan_at=datetime('now'),updated_at=datetime('now') WHERE id=?`).run(status, url, id);
  }
  const stmt = rawDb.prepare(`INSERT INTO market_evidence (market_id,evidence_type,source_url,source_title,observed_at,content_hash)
    VALUES (?,?,?,?,?,?) ON CONFLICT(market_id,evidence_type,source_url) DO UPDATE SET observed_at=excluded.observed_at,content_hash=excluded.content_hash`);
  writeEvidence(stmt, id, "official_directory", url,
    fiberListed ? `Kinetic ${state} fiber locations directory` : `Kinetic ${state} other high-speed locations directory`,
    new Date().toISOString());
}

function writeEvidence(stmt: any, marketId: number, type: string, url: string, title: string, observedAt: string) {
  const hash = crypto.createHash("sha256").update(`${type}|${url}|${title}`).digest("hex");
  stmt.run(marketId, type, url, title, observedAt, hash);
}

function recordDirectoryPoll(url: string, response: Response | null, status: string, error: string | null, next: string) {
  rawDb.prepare(`INSERT INTO monitor_source_polls (source_url,etag,last_modified,last_checked_at,last_success_at,next_poll_at,status,error)
    VALUES (?,?,?,datetime('now'),CASE WHEN ? IS NULL THEN datetime('now') ELSE NULL END,datetime('now',?),?,?)
    ON CONFLICT(source_url) DO UPDATE SET etag=COALESCE(excluded.etag,etag),last_modified=COALESCE(excluded.last_modified,last_modified),
      last_checked_at=datetime('now'),last_success_at=CASE WHEN excluded.error IS NULL THEN datetime('now') ELSE last_success_at END,
      next_poll_at=excluded.next_poll_at,status=excluded.status,error=excluded.error,updated_at=datetime('now')`)
    .run(url, response?.headers.get("etag") ?? null, response?.headers.get("last-modified") ?? null, error, next, status, error);
}

function priorityReasons(entry: KineticMarketCatalogEntry): string[] {
  const reasons = entry.directoryVerified
    ? [entry.serviceTier === "other_high_speed" ? "Official Kinetic other high-speed location; fiber change watch" : "Current Kinetic fiber location directory"]
    : [];
  if (entry.status === "verified_expanding") reasons.unshift("Named in recent official Kinetic fiber-build release");
  return reasons;
}
function canonicalDirectoryName(value: string): string {
  if (/^mt\.? pleasant$/i.test(value.trim())) return "Mount Pleasant";
  if (/^pineshurst$/i.test(value.trim())) return "Pinehurst";
  if (/^st\.? matthews$/i.test(value.trim())) return "Saint Matthews";
  return value.trim();
}
function normalizePlace(value: string): string {
  return value.toLowerCase().replace(/\bmt\b/g, "mount").replace(/\bst\b/g, "saint").replace(/[^a-z0-9]+/g, " ").trim();
}
function slug(value: string): string { return normalizePlace(value).replace(/\s+/g, "-"); }
function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function parseSqliteTime(value: string): number {
  const ms = Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : 0;
}
