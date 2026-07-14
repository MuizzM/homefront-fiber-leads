import crypto from "node:crypto";
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

const DEFAULT_FEED = "https://investor.uniti.com/press-releases";
const USER_AGENT = "HomeFrontFiber-AnnouncementMonitor/1.0 (operations@homefrontsolutions.com)";

export function announcementSourceStatus() {
  return rawDb.prepare(`SELECT source_url, last_checked_at, last_success_at, next_poll_at, status, error FROM monitor_source_polls ORDER BY source_url`).all();
}

export async function pollAnnouncementsIfDue(force = false): Promise<{ status: string; discovered: number; prioritized: number }> {
  if (process.env.ENABLE_ANNOUNCEMENT_WATCH !== "true") return { status: "disabled", discovered: 0, prioritized: 0 };
  const sourceUrl = process.env.KINETIC_ANNOUNCEMENT_FEED_URL || DEFAULT_FEED;
  const prior = rawDb.prepare(`SELECT * FROM monitor_source_polls WHERE source_url=?`).get(sourceUrl) as any;
  if (!force && prior?.next_poll_at && Date.parse(prior.next_poll_at + "Z") > Date.now()) return { status: "not_due", discovered: 0, prioritized: 0 };
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" };
  if (prior?.etag) headers["if-none-match"] = prior.etag;
  if (prior?.last_modified) headers["if-modified-since"] = prior.last_modified;
  try {
    const response = await fetch(sourceUrl, { headers, redirect: "follow", signal: AbortSignal.timeout(15_000) });
    if (response.status === 304) {
      recordPoll(sourceUrl, response, "not_modified", null, "+7 days");
      return { status: "not_modified", discovered: 0, prioritized: 0 };
    }
    if (!response.ok) throw new Error(`official announcement source returned ${response.status}`);
    const html = await response.text();
    const links = extractReleaseLinks(html, sourceUrl).slice(0, 30);
    let discovered = 0, prioritized = 0;
    for (const link of links) {
      const articleResponse = await fetch(link.url, { headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(15_000) });
      if (!articleResponse.ok) continue;
      const articleHtml = await articleResponse.text();
      const text = stripHtml(articleHtml);
      if (!/\b(Kinetic|Windstream|Uniti)\b/i.test(text) || !/\bfiber\b/i.test(text)) continue;
      const state = /South Carolina|\bSC\b/i.test(text) ? "SC" : /North Carolina|\bNC\b/i.test(text) ? "NC" : null;
      if (!state) continue;
      const places = rawDb.prepare(`SELECT city FROM state_fiber_markets WHERE state=? ORDER BY length(city) DESC`).all(state) as Array<{ city: string }>;
      const locations = places.filter(({ city }) => new RegExp(`\\b${escapeRegExp(city)}\\b`, "i").test(text)).map(({ city }) => city);
      const published = text.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}\b/i)?.[0] ?? null;
      const hash = crypto.createHash("sha256").update(`${link.url}|${link.title}|${published ?? ""}`).digest("hex");
      const insert = rawDb.prepare(`INSERT OR IGNORE INTO market_announcements (source_url,title,published_at,state,locations_json,content_hash) VALUES (?,?,?,?,?,?)`)
        .run(link.url, link.title, published, state, JSON.stringify(locations), hash);
      discovered += insert.changes;
      if (locations.length) {
        const marks = locations.map(() => "?").join(",");
        prioritized += rawDb.prepare(`UPDATE state_fiber_markets SET priority_class='critical', priority_score=MAX(priority_score,100), cadence_hours=MIN(cadence_hours,24), announcement_url=?, priority_reasons=?, next_scan_at=MIN(COALESCE(next_scan_at,datetime('now')),datetime('now')), updated_at=datetime('now') WHERE state=? AND city IN (${marks})`)
          .run(link.url, JSON.stringify([`Official announcement: ${link.title}`]), state, ...locations).changes;
      }
    }
    recordPoll(sourceUrl, response, "ok", null, "+7 days");
    structuredLog("state_monitor.announcement_poll", { sourceUrl, discovered, prioritized, linksChecked: links.length });
    return { status: "ok", discovered, prioritized };
  } catch (error: any) {
    recordPoll(sourceUrl, null, "failed", error.message, "+1 day");
    structuredLog("state_monitor.announcement_poll_failed", { sourceUrl, error: error.message });
    throw new Error(`ANNOUNCEMENT_WATCH_FAILED: ${error.message}`);
  }
}

function recordPoll(url: string, response: Response | null, status: string, error: string | null, next: string) {
  rawDb.prepare(`INSERT INTO monitor_source_polls (source_url,etag,last_modified,last_checked_at,last_success_at,next_poll_at,status,error)
    VALUES (?,?,?,datetime('now'),CASE WHEN ? IS NULL THEN datetime('now') ELSE NULL END,datetime('now',?),?,?)
    ON CONFLICT(source_url) DO UPDATE SET etag=COALESCE(excluded.etag,etag), last_modified=COALESCE(excluded.last_modified,last_modified),
      last_checked_at=datetime('now'), last_success_at=CASE WHEN excluded.error IS NULL THEN datetime('now') ELSE last_success_at END,
      next_poll_at=excluded.next_poll_at, status=excluded.status, error=excluded.error, updated_at=datetime('now')`)
    .run(url, response?.headers.get("etag") ?? null, response?.headers.get("last-modified") ?? null, error, next, status, error);
}

function extractReleaseLinks(html: string, base: string): Array<{ url: string; title: string }> {
  const out = new Map<string, string>();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(re)) {
    const title = stripHtml(match[2]).trim();
    if (!/news-release|press-release/i.test(match[1]) || !title) continue;
    try { out.set(new URL(match[1], base).toString(), title); } catch { /* malformed publisher link */ }
  }
  return [...out].map(([url, title]) => ({ url, title }));
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
