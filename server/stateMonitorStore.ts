import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rawDb } from "./db";
import { clusterFreshFiber, type FreshFiberPoint } from "@shared/freshFiberClusters";

export const CORROBORATION_SOURCES = ["fcc_bdc_licensed", "carrier_partner_feed", "third_party_licensed", "field_verification"] as const;
export type CorroborationSource = typeof CORROBORATION_SOURCES[number];

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.filter((r) => r.some(Boolean)).map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ""])));
}

export function seedStateMarkets(csvPath = path.resolve(process.cwd(), "data/nc_sc_kinetic_markets.csv")): { total: number; insertedOrUpdated: number } {
  if (!fs.existsSync(csvPath)) throw new Error(`MARKET_DATA_MISSING: run npm run markets:refresh (${csvPath})`);
  const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
  const stmt = rawDb.prepare(`
    INSERT INTO state_fiber_markets
      (state, place_fips, city, legal_name, county_fips, county, counties_json, population, lat, lng,
       priority_class, priority_score, priority_reasons, cadence_hours, announcement_url, source_vintage, next_scan_at)
    VALUES (@state,@placeFips,@city,@legalName,@countyFips,@county,@counties,@population,@lat,@lng,
            @priorityClass,@priorityScore,@priorityReasons,@cadenceHours,@announcementUrl,@sourceVintage,datetime('now'))
    ON CONFLICT(state, place_fips) DO UPDATE SET
      city=excluded.city, legal_name=excluded.legal_name, county_fips=excluded.county_fips,
      county=excluded.county, counties_json=excluded.counties_json, population=excluded.population,
      lat=excluded.lat, lng=excluded.lng, priority_class=excluded.priority_class,
      priority_score=excluded.priority_score, priority_reasons=excluded.priority_reasons,
      cadence_hours=excluded.cadence_hours, announcement_url=excluded.announcement_url,
      source_vintage=excluded.source_vintage, updated_at=datetime('now')`);
  const announcement = rawDb.prepare(`
    INSERT OR IGNORE INTO market_announcements
      (source_url, title, published_at, state, locations_json, content_hash)
    VALUES (?,?,?,?,?,?)`);
  const tx = rawDb.transaction(() => {
    let changed = 0;
    const byUrl = new Map<string, string[]>();
    for (const r of rows) {
      const reason = r.priority_reason || "Population priority";
      changed += stmt.run({
        state: r.state, placeFips: r.place_fips, city: r.city, legalName: r.legal_name,
        countyFips: r.county_fips || null, county: r.county || null,
        counties: JSON.stringify((r.counties || "").split("|").filter(Boolean)),
        population: Number(r.population || 0), lat: r.lat ? Number(r.lat) : null, lng: r.lng ? Number(r.lng) : null,
        priorityClass: r.priority_class, priorityScore: Number(r.priority_score || 0),
        priorityReasons: JSON.stringify([reason]), cadenceHours: Number(r.cadence_hours),
        announcementUrl: r.announcement_url || null, sourceVintage: r.source_vintage,
      }).changes;
      if (r.announcement_url) byUrl.set(r.announcement_url, [...(byUrl.get(r.announcement_url) ?? []), `${r.city}, ${r.state}`]);
    }
    for (const [url, locations] of byUrl) {
      const published = rows.find((r) => r.announcement_url === url)?.priority_reason.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      const hash = crypto.createHash("sha256").update(`${url}|${locations.sort().join("|")}`).digest("hex");
      announcement.run(url, "Official Kinetic/Uniti NC fiber build announcement", published, "NC", JSON.stringify(locations), hash);
    }
    return changed;
  });
  return { total: rows.length, insertedOrUpdated: tx() };
}

export function syncMarketState(): number {
  const result = rawDb.prepare(`
    UPDATE state_fiber_markets AS m SET
      last_scanned_at=(SELECT MAX(s.last_scanned_at) FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state),
      last_status=CASE
        WHEN NOT EXISTS (SELECT 1 FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state) THEN 'inventory_pending'
        WHEN EXISTS (SELECT 1 FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state AND s.last_is_new_fiber=1) THEN 'fiber_detected'
        WHEN EXISTS (SELECT 1 FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state AND s.last_scanned_at IS NOT NULL) THEN 'monitored'
        ELSE 'inventory_ready' END,
      fresh_flag=CASE WHEN EXISTS (
        SELECT 1 FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state
          AND COALESCE(s.first_seen_fiber_at,s.first_seen_live_at) >= datetime('now','-30 days')) THEN 1 ELSE 0 END,
      next_scan_at=CASE
        WHEN (SELECT MAX(s.last_scanned_at) FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state) IS NULL THEN COALESCE(next_scan_at, datetime('now'))
        ELSE datetime((SELECT MAX(s.last_scanned_at) FROM scan_targets s WHERE lower(s.city)=lower(m.city) AND s.state=m.state), '+' || cadence_hours || ' hours') END,
      updated_at=datetime('now')`).run();
  return result.changes;
}

export function listMarkets(filters: { state?: "NC" | "SC"; priority?: string; due?: boolean; limit?: number } = {}) {
  const where: string[] = ["1=1"];
  const args: any[] = [];
  if (filters.state) { where.push("m.state=?"); args.push(filters.state); }
  if (filters.priority) { where.push("m.priority_class=?"); args.push(filters.priority); }
  if (filters.due) where.push("m.next_scan_at <= datetime('now')");
  args.push(Math.max(1, Math.min(2_000, filters.limit ?? 1_000)));
  return rawDb.prepare(`
    SELECT m.*,
      COUNT(s.id) AS address_count,
      SUM(CASE WHEN s.last_scanned_at IS NOT NULL THEN 1 ELSE 0 END) AS scanned_count,
      SUM(CASE WHEN s.last_is_new_fiber=1 THEN 1 ELSE 0 END) AS fiber_count,
      SUM(CASE WHEN s.first_seen_live_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS fresh_week
    FROM state_fiber_markets m
    LEFT JOIN scan_targets s ON lower(s.city)=lower(m.city) AND s.state=m.state
    WHERE ${where.join(" AND ")}
    GROUP BY m.id ORDER BY m.priority_score DESC, m.population DESC LIMIT ?`).all(...args);
}

export function dueMarkets(limit = 25) {
  return listMarkets({ due: true, limit }).filter((m: any) => Number(m.address_count) > 0);
}

export interface CorroborationInput {
  scanTargetId: number;
  source: CorroborationSource;
  sourceRecordId?: string | null;
  observedAt: string;
  availability: "available" | "unavailable" | "unknown";
  technology?: string | null;
  maxDownMbps?: number | null;
  referenceUrl?: string | null;
  importBatchId?: string | null;
}

export function recordCorroboration(tenantId: number, rows: CorroborationInput[]): { accepted: number; duplicates: number } {
  const target = rawDb.prepare(`SELECT id, address, city, state FROM scan_targets WHERE id=? AND (tenant_id=? OR tenant_id IS NULL)`);
  const insert = rawDb.prepare(`
    INSERT OR IGNORE INTO availability_corroboration
      (tenant_id, scan_target_id, source, source_record_id, observed_at, availability, technology,
       max_down_mbps, evidence_hash, reference_url, import_batch_id)
    VALUES (@tenantId,@scanTargetId,@source,@sourceRecordId,@observedAt,@availability,@technology,
            @maxDownMbps,@evidenceHash,@referenceUrl,@importBatchId)`);
  const tx = rawDb.transaction(() => {
    let accepted = 0, duplicates = 0;
    for (const row of rows) {
      const t = target.get(row.scanTargetId, tenantId) as any;
      if (!t) throw new Error(`SCAN_TARGET_NOT_FOUND: ${row.scanTargetId}`);
      const evidenceHash = crypto.createHash("sha256").update(JSON.stringify({
        target: row.scanTargetId, source: row.source, sourceRecordId: row.sourceRecordId ?? null,
        observedAt: row.observedAt, availability: row.availability, technology: row.technology ?? null,
        maxDownMbps: row.maxDownMbps ?? null,
      })).digest("hex");
      const result = insert.run({ tenantId, ...row, sourceRecordId: row.sourceRecordId ?? null,
        technology: row.technology ?? null, maxDownMbps: row.maxDownMbps ?? null,
        referenceUrl: row.referenceUrl ?? null, importBatchId: row.importBatchId ?? null, evidenceHash });
      if (result.changes) accepted++; else duplicates++;
    }
    return { accepted, duplicates };
  });
  return tx();
}

export function freshPoints(tenantId: number, days = 30): FreshFiberPoint[] {
  const rows = rawDb.prepare(`
    SELECT s.id, s.address, s.city, s.state, s.zip, s.lat, s.lng,
           COALESCE(s.first_seen_fiber_at,s.first_seen_live_at) AS firstSeenLiveAt, s.converted_to_lead_id AS leadId,
           s.last_customer_segment AS customerSegment,s.last_customer_confidence AS customerConfidence,
           GROUP_CONCAT(DISTINCT c.source) AS corroboratingSources
      FROM scan_targets s
      LEFT JOIN availability_corroboration c
        ON c.scan_target_id=s.id AND c.tenant_id=? AND c.availability='available'
       AND c.observed_at >= datetime(COALESCE(s.first_seen_fiber_at,s.first_seen_live_at),'-7 days')
       AND c.observed_at <= datetime(COALESCE(s.first_seen_fiber_at,s.first_seen_live_at),'+31 days')
     WHERE s.state IN ('NC','SC') AND COALESCE(s.first_seen_fiber_at,s.first_seen_live_at) >= datetime('now', ?)
       AND s.lat IS NOT NULL AND s.lng IS NOT NULL AND (s.tenant_id=? OR s.tenant_id IS NULL)
     GROUP BY s.id ORDER BY s.first_seen_live_at DESC`).all(tenantId, `-${Math.max(1, Math.min(365, days))} days`, tenantId) as any[];
  return rows.map((r) => {
    const independent = String(r.corroboratingSources ?? "").split(",").filter(Boolean);
    return {
      id: r.id, address: r.address, city: r.city, state: r.state, zip: r.zip,
      lat: Number(r.lat), lng: Number(r.lng), firstSeenLiveAt: toIso(r.firstSeenLiveAt), leadId: r.leadId,
      confidence: independent.length ? "cross_verified" : "single_source_provisional",
      sources: ["kinetic", ...independent],
      customerSegment: r.customerSegment ?? "unknown", customerConfidence: r.customerConfidence ?? "low",
    } as FreshFiberPoint;
  });
}

export function monitoringSummary(tenantId: number, days = 7) {
  const tracked = rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_targets WHERE state IN ('NC','SC') AND (tenant_id=? OR tenant_id IS NULL)`).get(tenantId) as any;
  const fresh = freshPoints(tenantId, days);
  const clusters = clusterFreshFiber(fresh);
  const markets = rawDb.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN next_scan_at <= datetime('now') THEN 1 ELSE 0 END) due, SUM(fresh_flag) fresh FROM state_fiber_markets`).get() as any;
  return {
    generatedAt: new Date().toISOString(), windowDays: days,
    markets: { total: markets.n ?? 0, due: markets.due ?? 0, fresh: markets.fresh ?? 0 },
    addressesTracked: tracked.n ?? 0, newlyAvailable: fresh.length,
    crossVerified: fresh.filter((p) => p.confidence === "cross_verified").length,
    provisional: fresh.filter((p) => p.confidence === "single_source_provisional").length,
    topFreshClusters: clusters.slice(0, 10),
    nextScans: listMarkets({ limit: 20 }).sort((a: any, b: any) => String(a.next_scan_at).localeCompare(String(b.next_scan_at))).slice(0, 20),
  };
}

export function knockList(tenantId: number, days = 30) {
  return clusterFreshFiber(freshPoints(tenantId, days).filter((p) => p.customerSegment === "new_opportunity")).flatMap((cluster, clusterRank) =>
    cluster.addresses.map((point) => ({
      rank: clusterRank + 1, cluster_id: cluster.id, cluster_score: cluster.score,
      cluster_density: cluster.density, confidence: point.confidence, first_seen_live_at: point.firstSeenLiveAt,
      address: point.address, city: point.city, state: point.state, zip: point.zip ?? "",
      lat: point.lat, lng: point.lng, sources: point.sources.join("|"), lead_id: point.leadId ?? "", map_url: cluster.mapUrl,
      customer_segment: point.customerSegment ?? "unknown", customer_confidence: point.customerConfidence ?? "low",
    })),
  );
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...rows.map((row) => headers.map((h) => cell(row[h])).join(","))].join("\n") + "\n";
}

function toIso(value: string): string {
  const normalized = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  return new Date(normalized).toISOString();
}
