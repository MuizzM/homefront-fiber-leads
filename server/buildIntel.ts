// ── Build Intelligence — news + permit signals promote cities into the hot zone ──
// "Be first" needs to know WHERE Kinetic is building BEFORE the first drop ever
// lights up. This engine watches two external signal classes and promotes named
// cities into a DYNAMIC hot zone that the 20-minute hot-market burst unions with
// the static HOT_MARKETS env list — no redeploy needed for a new build market:
//
//   • NEWS — official Windstream/Kinetic releases + Google News coverage of
//     Kinetic fiber construction. An official release naming a city promotes it
//     immediately; independent news needs ≥2 distinct articles in 30 days.
//   • PERMITS — county building-permit feeds (ArcGIS FeatureServer JSON, the de
//     facto standard for NC/SC county GIS portals). A surge of new residential
//     permits in a footprint city marks an active construction zone — fiber
//     follows rooftops. Feeds are operator-configured (county endpoints vary);
//     the engine is generic over any ArcGIS query URL + field mapping.
//
// This also closes the audited footprint-growth gap: a build announced in a town
// NOT yet in the market catalog still gets promoted — the hot burst's hourly
// address-discovery job then enumerates it from scratch, so brand-new Kinetic
// towns enter coverage from a news article instead of waiting for a redeploy.
//
// All fetches are governor-independent (free public sources, no Decodo), timers
// unref'd, control-worker only (registered in index.ts), kill-switch
// BUILD_INTEL=off. Promotions expire (TTL) so a zone cools off on its own.

import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";
import crypto from "node:crypto";

const HOUR_MS = 3_600_000;

function bounded(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
}

const CFG = {
  enabled: () => process.env.BUILD_INTEL !== "off",
  newsIntervalMs: () => bounded(process.env.BUILD_INTEL_NEWS_INTERVAL_H, 6, 1, 48) * HOUR_MS,
  permitIntervalMs: () => bounded(process.env.BUILD_INTEL_PERMIT_INTERVAL_H, 24, 1, 168) * HOUR_MS,
  // Promotion rules
  newsMinArticles: () => bounded(process.env.BUILD_INTEL_NEWS_MIN, 2, 1, 10),
  permitMin: () => bounded(process.env.BUILD_INTEL_PERMIT_MIN, 25, 1, 10_000),
  windowDays: () => bounded(process.env.BUILD_INTEL_WINDOW_DAYS, 30, 7, 120),
  officialTtlDays: () => bounded(process.env.BUILD_INTEL_OFFICIAL_TTL_DAYS, 45, 7, 365),
  ttlDays: () => bounded(process.env.BUILD_INTEL_TTL_DAYS, 30, 7, 365),
  fetchTimeoutMs: () => bounded(process.env.BUILD_INTEL_FETCH_TIMEOUT_MS, 15_000, 2_000, 60_000),
};

// Default news feeds: official newsroom RSS is classified 'official' by host;
// Google News queries catch local-paper coverage the newsroom misses. All are
// free RSS endpoints — override/extend via BUILD_INTEL_NEWS_FEEDS (comma-sep).
const DEFAULT_NEWS_FEEDS = [
  "https://news.google.com/rss/search?q=%22Kinetic+by+Windstream%22+fiber&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Windstream+fiber+construction+%22North+Carolina%22&hl=en-US&gl=US&ceid=US:en",
  "https://news.google.com/rss/search?q=Windstream+fiber+%22South+Carolina%22+OR+Georgia+expansion&hl=en-US&gl=US&ceid=US:en",
];

const STATES: Record<string, string> = {
  "n.c.": "nc", nc: "nc", "north carolina": "nc",
  "s.c.": "sc", sc: "sc", "south carolina": "sc",
  "ga.": "ga", ga: "ga", georgia: "ga",
};

let ensured = false;
export function ensureBuildIntelSchema(): void {
  if (ensured) return;
  rawDb.exec(`CREATE TABLE IF NOT EXISTS build_intel_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,               -- 'official' | 'news' | 'permit'
    source TEXT NOT NULL,             -- feed label/host
    url TEXT,
    title TEXT,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_build_intel_city
    ON build_intel_signals(state, city, kind, seen_at)`);
  rawDb.exec(`CREATE TABLE IF NOT EXISTS hot_zone_dynamic (
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    reason TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    promoted_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    PRIMARY KEY (city, state)
  )`);
  ensured = true;
}

// ── RSS parsing (dependency-free) ────────────────────────────────────────────
export interface RssItem { title: string; link: string; description: string; pubDate: string }

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");
}

/** Minimal RSS/Atom item extractor — regex-based, tolerant of both formats. */
export function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const block of blocks) {
    const pick = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
      return m ? decodeEntities(m[1]).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
    };
    const linkTag = block.match(/<link[^>]*href="([^"]+)"/i);
    items.push({
      title: pick("title"),
      link: linkTag ? linkTag[1] : pick("link"),
      description: pick("description") || pick("summary") || pick("content"),
      pubDate: pick("pubDate") || pick("published") || pick("updated"),
    });
  }
  return items;
}

// ── City extraction ──────────────────────────────────────────────────────────
export interface CityMention { city: string; state: string }

/**
 * Extract "<City>, N.C."-style mentions from free text, plus word-boundary hits
 * against a known-city list (the live footprint catalog at tick time — so
 * directory-discovered cities match too). A city named in prose WITHOUT a state
 * marker only counts via the known list (its state comes from the catalog);
 * "City, ST" patterns work even for towns the catalog has never seen — that is
 * the footprint-GROWTH path.
 */
export function extractCityMentions(
  text: string,
  knownCities: Array<{ city: string; state: string }> = [],
): CityMention[] {
  const out = new Map<string, CityMention>();
  const add = (city: string, state: string) => {
    const c = city.trim().toLowerCase();
    const sRaw = state.trim().toLowerCase();
    const stripped = sRaw.replace(/\./g, ""); // "n.c." / "N.C" / "nc" all → "nc"
    const st = STATES[sRaw] ?? STATES[stripped] ?? (["nc", "sc", "ga"].includes(stripped) ? stripped : null);
    if (!st || c.length < 3 || !/^[a-z]/.test(c)) return;
    out.set(`${c}:${st}`, { city: c, state: st });
  };
  // Pattern: "in Concord, N.C." / "to Rockwell, NC" / "Salisbury, North Carolina"
  const pat = /\b([A-Z][A-Za-z]+(?:[ -][A-Z][A-Za-z]+){0,3}),\s*(N\.?C\.?|S\.?C\.?|Ga\.?|North Carolina|South Carolina|Georgia)\b/g;
  for (let m = pat.exec(text); m; m = pat.exec(text)) add(m[1], m[2].toLowerCase());
  // Known-city word-boundary pass (case-insensitive).
  const lower = text.toLowerCase();
  for (const k of knownCities) {
    const c = k.city.trim().toLowerCase();
    if (c.length < 4) continue; // "king" etc. too collision-prone for prose matching
    const idx = lower.indexOf(c);
    if (idx < 0) continue;
    const before = idx === 0 ? " " : lower[idx - 1];
    const after = idx + c.length >= lower.length ? " " : lower[idx + c.length];
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
    add(c, k.state);
  }
  return [...out.values()];
}

/** Live footprint city list (catalog + directory-discovered), for matching. */
export function knownFootprintCities(): Array<{ city: string; state: string }> {
  try {
    return rawDb.prepare(
      `SELECT lower(city) AS city, lower(state) AS state FROM state_fiber_markets WHERE auto_scan_eligible=1`,
    ).all() as any[];
  } catch { return []; }
}

// ── Signals + promotion ──────────────────────────────────────────────────────
export function recordSignal(input: {
  kind: "official" | "news" | "permit";
  source: string; url?: string | null; title?: string | null;
  city: string; state: string; dedupeKey?: string;
}): boolean {
  ensureBuildIntelSchema();
  const hash = crypto.createHash("sha1")
    .update(input.dedupeKey ?? `${input.kind}|${input.url ?? input.title ?? ""}|${input.city}|${input.state}`)
    .digest("hex");
  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO build_intel_signals (hash,kind,source,url,title,city,state)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(hash, input.kind, input.source, input.url ?? null, (input.title ?? "").slice(0, 300),
        input.city.toLowerCase(), input.state.toLowerCase());
  return info.changes > 0;
}

/**
 * Promotion rules over the signal window:
 *   official ≥1 → promote (long TTL) — Windstream said so.
 *   news ≥ newsMinArticles distinct URLs → promote.
 *   permit count ≥ permitMin → promote (construction surge).
 * Re-promotion refreshes the TTL. Returns newly-promoted/refreshed entries.
 */
export function evaluatePromotions(): Array<{ city: string; state: string; reason: string }> {
  ensureBuildIntelSchema();
  const windowDays = CFG.windowDays();
  const rows = rawDb.prepare(
    `SELECT city, state,
            SUM(kind='official') AS official,
            COUNT(DISTINCT CASE WHEN kind='news' THEN COALESCE(url, CAST(id AS TEXT)) END) AS news,
            SUM(kind='permit') AS permits
       FROM build_intel_signals
      WHERE seen_at >= datetime('now', ?)
      GROUP BY city, state`,
  ).all(`-${windowDays} days`) as any[];
  const promoted: Array<{ city: string; state: string; reason: string }> = [];
  for (const r of rows) {
    let reason: string | null = null;
    let ttl = CFG.ttlDays();
    if (Number(r.official) >= 1) { reason = `official announcement (${r.official})`; ttl = CFG.officialTtlDays(); }
    else if (Number(r.news) >= CFG.newsMinArticles()) reason = `news coverage (${r.news} articles/${windowDays}d)`;
    else if (Number(r.permits) >= CFG.permitMin()) reason = `permit surge (${r.permits}/${windowDays}d)`;
    if (!reason) continue;
    const evidence = rawDb.prepare(
      `SELECT kind, source, url, title FROM build_intel_signals
        WHERE city=? AND state=? AND seen_at >= datetime('now', ?)
        ORDER BY seen_at DESC LIMIT 10`,
    ).all(r.city, r.state, `-${windowDays} days`);
    rawDb.prepare(
      `INSERT INTO hot_zone_dynamic (city,state,reason,evidence_json,promoted_at,expires_at)
       VALUES (?,?,?,?,datetime('now'),datetime('now', ?))
       ON CONFLICT(city,state) DO UPDATE SET
         reason=excluded.reason, evidence_json=excluded.evidence_json,
         promoted_at=excluded.promoted_at, expires_at=excluded.expires_at`,
    ).run(r.city, r.state, reason, JSON.stringify(evidence), `+${ttl} days`);
    promoted.push({ city: r.city, state: r.state, reason });
    structuredLog("build_intel.promoted", { city: r.city, state: r.state, reason });
  }
  return promoted;
}

/** Active (unexpired) dynamic hot-zone entries. */
export function listDynamicHotMarkets(): Array<{ city: string; state: string; reason: string }> {
  ensureBuildIntelSchema();
  return rawDb.prepare(
    `SELECT city, state, reason FROM hot_zone_dynamic WHERE expires_at > datetime('now')
      ORDER BY promoted_at DESC LIMIT 50`,
  ).all() as any[];
}

/**
 * The hot-market burst's city list: env "city:st" entries UNIONED with active
 * dynamic promotions, deduped, order-stable (env first — operator intent wins).
 */
export function listHotMarkets(envSpec: string): Array<{ city: string; state: string }> {
  const out = new Map<string, { city: string; state: string }>();
  for (const entry of envSpec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [city, st = "ga"] = entry.split(":").map((s) => s.trim().toLowerCase());
    if (city) out.set(`${city}:${st}`, { city, state: st });
  }
  try {
    for (const d of listDynamicHotMarkets()) {
      const key = `${d.city}:${d.state}`;
      if (!out.has(key)) out.set(key, { city: d.city, state: d.state });
    }
  } catch { /* dynamic table unavailable — env list still works */ }
  return [...out.values()];
}

// ── Fetch ticks ──────────────────────────────────────────────────────────────
async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CFG.fetchTimeoutMs());
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "homefront-buildintel/1.0 (+ops)", accept: "application/rss+xml, application/xml, application/json, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

export async function runNewsTick(): Promise<{ signals: number; promoted: number }> {
  const feeds = (process.env.BUILD_INTEL_NEWS_FEEDS ?? DEFAULT_NEWS_FEEDS.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const known = knownFootprintCities();
  let signals = 0;
  for (const feed of feeds) {
    let host = "news";
    try { host = new URL(feed).host; } catch { /* keep label */ }
    // Official = Windstream's own newsroom; everything else is press coverage.
    const kind: "official" | "news" = /windstream\.com$/i.test(host) ? "official" : "news";
    try {
      const xml = await fetchText(feed);
      for (const item of parseRssItems(xml).slice(0, 50)) {
        // An official release IS the signal; a news article must look like a
        // build/expansion story, not a stock-price mention.
        const text = `${item.title} ${item.description}`;
        if (kind === "news" && !/fiber|broadband|internet|build|expan|construct|launch/i.test(text)) continue;
        for (const mention of extractCityMentions(text, known)) {
          if (recordSignal({ kind, source: host, url: item.link, title: item.title, city: mention.city, state: mention.state }))
            signals += 1;
        }
      }
    } catch (e: any) {
      structuredLog("build_intel.feed_failed", { feed: host, error: String(e?.message ?? e).slice(0, 120) }, "warn");
    }
  }
  const promoted = evaluatePromotions();
  structuredLog("build_intel.news_tick", { feeds: feeds.length, signals, promoted: promoted.length });
  return { signals, promoted: promoted.length };
}

interface PermitFeed { label: string; url: string; cityField: string; dateField?: string; state: string }

function permitFeeds(): PermitFeed[] {
  const raw = process.env.BUILD_INTEL_PERMIT_FEEDS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((f) => f && f.url && f.cityField && f.state).map((f) => ({
          label: String(f.label ?? "permits"), url: String(f.url),
          cityField: String(f.cityField), dateField: f.dateField ? String(f.dateField) : undefined,
          state: String(f.state).toLowerCase(),
        }))
      : [];
  } catch {
    structuredLog("build_intel.permit_feeds_invalid", {}, "warn");
    return [];
  }
}

export async function runPermitTick(): Promise<{ signals: number; promoted: number }> {
  const feeds = permitFeeds();
  let signals = 0;
  for (const feed of feeds) {
    try {
      const body = await fetchText(feed.url);
      const json = JSON.parse(body);
      const features: any[] = Array.isArray(json?.features) ? json.features : [];
      for (const f of features.slice(0, 2_000)) {
        const attrs = f?.attributes ?? f?.properties ?? {};
        const city = String(attrs[feed.cityField] ?? "").trim().toLowerCase();
        if (!city || city.length < 3) continue;
        const dateVal = feed.dateField ? String(attrs[feed.dateField] ?? "") : "";
        const key = `permit|${feed.label}|${city}|${JSON.stringify(attrs).slice(0, 200)}`;
        if (recordSignal({ kind: "permit", source: feed.label, city, state: feed.state, dedupeKey: key, title: dateVal }))
          signals += 1;
      }
    } catch (e: any) {
      structuredLog("build_intel.permit_feed_failed", { feed: feed.label, error: String(e?.message ?? e).slice(0, 120) }, "warn");
    }
  }
  const promoted = feeds.length ? evaluatePromotions() : [];
  if (feeds.length) structuredLog("build_intel.permit_tick", { feeds: feeds.length, signals, promoted: promoted.length });
  return { signals, promoted: promoted.length };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
let newsTimer: ReturnType<typeof setInterval> | null = null;
let permitTimer: ReturnType<typeof setInterval> | null = null;

/** Wire from the orchestrator on boot (control worker). BUILD_INTEL=off disables. */
export function startBuildIntel(): void {
  if (!CFG.enabled()) {
    structuredLog("build_intel.disabled", { reason: "BUILD_INTEL=off" }, "info");
    return;
  }
  if (newsTimer) return;
  ensureBuildIntelSchema();
  // First news pull a few minutes after boot (web settles first), then steady.
  const boot = setTimeout(() => { void runNewsTick().catch(() => {}); void runPermitTick().catch(() => {}); }, 3 * 60_000);
  if (typeof (boot as any).unref === "function") (boot as any).unref();
  newsTimer = setInterval(() => { void runNewsTick().catch(() => {}); }, CFG.newsIntervalMs());
  if (typeof (newsTimer as any).unref === "function") (newsTimer as any).unref();
  permitTimer = setInterval(() => { void runPermitTick().catch(() => {}); }, CFG.permitIntervalMs());
  if (typeof (permitTimer as any).unref === "function") (permitTimer as any).unref();
  structuredLog("build_intel.started", {
    newsIntervalH: CFG.newsIntervalMs() / HOUR_MS, permitIntervalH: CFG.permitIntervalMs() / HOUR_MS,
    permitFeeds: permitFeeds().length,
  });
}

export function stopBuildIntel(): void {
  if (newsTimer) { clearInterval(newsTimer); newsTimer = null; }
  if (permitTimer) { clearInterval(permitTimer); permitTimer = null; }
}
