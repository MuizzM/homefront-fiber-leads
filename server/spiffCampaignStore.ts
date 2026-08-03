// ── SPIFF campaigns — persistence and the counters the rules read ────────────
// The decision logic lives in shared/spiffCampaign.ts and is pure. This file
// does the two things that engine deliberately cannot: read the field's actual
// activity out of SQLite, and record an award exactly once.
//
// AWARDS REUSE THE EXISTING SPIFF LEDGER. A campaign award is a row in `spiffs`
// with a campaign_id, which means it inherits the whole pipeline that already
// exists and is tested — earned → approved → paid, the self-approval block, the
// payroll CSV column, the commission statement line. Inventing a second payout
// table would have meant a second thing to reconcile against the bank.
//
// IDEMPOTENCY IS A DATABASE CONSTRAINT, NOT A CODE PATH. Every award carries a
// deterministic key (`campaign:7:rep:12:day:2026-08-04`) written into the
// UNIQUE-indexed `sale_ref` column. A double-submitted knock, two servers
// evaluating at once, or a retry after a timeout all collide on the index and
// the second insert is ignored. Money that can be paid twice by refreshing is
// not a rounding bug, it is the whole thing.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  campaignProgress, evaluateCampaign, awardReason,
  type CampaignStatus, type CampaignTrigger, type RepWindowCounters, type SpiffCampaign,
} from "@shared/spiffCampaign";
import { localHourIn, localWallToUtcMs, localYmdParts } from "@shared/workweek";

export function ensureCampaignSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS spiff_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starts_at_ms INTEGER NOT NULL,
      ends_at_ms INTEGER NOT NULL,
      trigger_json TEXT NOT NULL,
      reward_cents INTEGER NOT NULL,
      eligible_rep_ids TEXT,                     -- JSON array, NULL = whole tenant
      per_rep_cap_cents INTEGER NOT NULL DEFAULT 0,
      campaign_cap_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'live',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_spiff_campaigns_tenant ON spiff_campaigns(tenant_id, status, ends_at_ms);
  `);
  // Campaign awards ride the existing spiffs ledger.
  try { rawDb.exec(`ALTER TABLE spiffs ADD COLUMN campaign_id INTEGER`); }
  catch (e: any) { if (!/duplicate column/i.test(e?.message ?? "")) throw e; }
  try { rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_spiffs_campaign ON spiffs(tenant_id, campaign_id)`); }
  catch { /* index already present */ }
}
ensureCampaignSchema();

const DAY_MS = 86_400_000;

function mapCampaign(row: any): SpiffCampaign {
  let trigger: CampaignTrigger;
  try { trigger = JSON.parse(row.trigger_json); } catch { trigger = { kind: "per_sale" }; }
  let eligibleRepIds: number[] | null = null;
  if (row.eligible_rep_ids) {
    try {
      const parsed = JSON.parse(row.eligible_rep_ids);
      eligibleRepIds = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isSafeInteger) : null;
    } catch { eligibleRepIds = null; }
  }
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    startsAtMs: Number(row.starts_at_ms),
    endsAtMs: Number(row.ends_at_ms),
    trigger,
    rewardCents: Number(row.reward_cents),
    eligibleRepIds,
    perRepCapCents: Number(row.per_rep_cap_cents ?? 0),
    campaignCapCents: Number(row.campaign_cap_cents ?? 0),
    status: String(row.status) as CampaignStatus,
  };
}

/** A campaign whose end has passed is ENDED, whatever the row still says. The
 *  status column is the manager's intent; the clock is the truth. Persisting it
 *  keeps the admin list honest without a cron. */
export function expireFinishedCampaigns(tenantId: number, nowMs: number): void {
  rawDb.prepare(
    `UPDATE spiff_campaigns SET status = 'ended', updated_at = datetime('now')
      WHERE tenant_id = ? AND status IN ('live','scheduled','paused') AND ends_at_ms <= ?`,
  ).run(tenantId, nowMs);
  // …and a scheduled one whose start has arrived goes live on its own.
  rawDb.prepare(
    `UPDATE spiff_campaigns SET status = 'live', updated_at = datetime('now')
      WHERE tenant_id = ? AND status = 'scheduled' AND starts_at_ms <= ? AND ends_at_ms > ?`,
  ).run(tenantId, nowMs, nowMs);
}

export function listCampaigns(tenantId: number, nowMs: number): SpiffCampaign[] {
  expireFinishedCampaigns(tenantId, nowMs);
  return (rawDb.prepare(
    `SELECT * FROM spiff_campaigns WHERE tenant_id = ? ORDER BY ends_at_ms DESC, id DESC LIMIT 200`,
  ).all(tenantId) as any[]).map(mapCampaign);
}

export function getCampaign(tenantId: number, id: number): SpiffCampaign | null {
  const row = rawDb.prepare(`SELECT * FROM spiff_campaigns WHERE tenant_id = ? AND id = ?`).get(tenantId, id);
  return row ? mapCampaign(row) : null;
}

export function createCampaign(tenantId: number, actorId: number | null, input: {
  name: string; description?: string; startsAtMs: number; endsAtMs: number;
  trigger: CampaignTrigger; rewardCents: number;
  eligibleRepIds?: number[] | null; perRepCapCents?: number; campaignCapCents?: number;
  nowMs: number;
}): SpiffCampaign {
  // A campaign that starts in the future is scheduled, not live — the rep card
  // should not count down toward something that has not opened.
  const status: CampaignStatus = input.startsAtMs > input.nowMs ? "scheduled" : "live";
  const info = rawDb.prepare(
    `INSERT INTO spiff_campaigns
      (tenant_id, name, description, starts_at_ms, ends_at_ms, trigger_json, reward_cents,
       eligible_rep_ids, per_rep_cap_cents, campaign_cap_cents, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    tenantId, input.name.trim(), (input.description ?? "").trim(),
    Math.trunc(input.startsAtMs), Math.trunc(input.endsAtMs),
    JSON.stringify(input.trigger), Math.trunc(input.rewardCents),
    input.eligibleRepIds && input.eligibleRepIds.length ? JSON.stringify(input.eligibleRepIds) : null,
    Math.max(0, Math.trunc(input.perRepCapCents ?? 0)),
    Math.max(0, Math.trunc(input.campaignCapCents ?? 0)),
    status, actorId,
  );
  const created = getCampaign(tenantId, Number(info.lastInsertRowid))!;
  storage.logActivity(actorId, "spiff_campaign.launched", "spiff_campaign", created.id, {
    name: created.name, rewardCents: created.rewardCents, trigger: created.trigger,
    endsAtMs: created.endsAtMs, campaignCapCents: created.campaignCapCents,
  }, undefined);
  return created;
}

/** Pause / resume / cancel. Cancelling is terminal — a promise the floor was
 *  shown should not be able to flicker back on after being withdrawn. */
export function setCampaignStatus(
  tenantId: number, actorId: number | null, id: number, next: "live" | "paused" | "cancelled", nowMs: number,
): SpiffCampaign | null {
  const current = getCampaign(tenantId, id);
  if (!current) return null;
  if (current.status === "cancelled" || current.status === "ended") return current;
  if (next === "live" && current.endsAtMs <= nowMs) return current; // cannot resume a finished window
  rawDb.prepare(`UPDATE spiff_campaigns SET status = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?`)
    .run(next, tenantId, id);
  storage.logActivity(actorId, `spiff_campaign.${next}`, "spiff_campaign", id, { from: current.status }, undefined);
  return getCampaign(tenantId, id);
}

// ── Counters ────────────────────────────────────────────────────────────────
// Everything the pure rules read, resolved in the ORG'S local time. A cutoff
// hour is meaningless in UTC: "40 knocks before noon" in New York is a
// different set of rows than the same phrase in Los Angeles.

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || "America/New_York";
  } catch { return "America/New_York"; }
}

/** UTC bounds of the org's local calendar day containing `nowMs`. */
function localDayBounds(tenantId: number, nowMs: number): { startMs: number; endMs: number; tz: string } {
  const tz = orgTimezone(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  return { startMs, endMs: startMs + DAY_MS, tz };
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * DISTINCT doors, and only the ones the SERVER rated `verified`.
 *
 * A knock-count contest pays for effort, so the counter has to be evidence of
 * effort rather than of tapping. Two exploits it closes:
 *
 *   COUNT(DISTINCT lead_id) — standing at one house and logging it forty times
 *   wins nothing. The count is doors worked, not buttons pressed.
 *
 *   verification_status = 'verified' — the verdict is computed server-side from
 *   the door's own coordinates (shared/geoVerify.ts), so a rep cannot clear a
 *   contest from the couch. `needs_review`, `invalid`, and legacy NULL do not
 *   count: an unverifiable knock is not evidence, and paying for one teaches the
 *   whole floor exactly which way to hold the phone.
 *
 * The same rule backs the standing milestone ladder — see verifiedDoorCount in
 * server/knockMilestoneStore.ts. One definition of "a door", two features.
 */
function knockCount(tenantId: number, repId: number, fromMs: number, toMs: number): number {
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT k.lead_id) AS n FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at >= ? AND k.knocked_at < ?
        AND k.verification_status = 'verified'
        AND COALESCE(k.superseded, 0) = 0`,
  ).get(repId, tenantId, iso(fromMs), iso(toMs)) as any;
  return Number(row?.n ?? 0);
}

function saleCount(tenantId: number, repId: number, fromMs: number, toMs: number): number {
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'
        AND sold_at >= ? AND sold_at < ?`,
  ).get(tenantId, repId, iso(fromMs), iso(toMs)) as any;
  return Number(row?.n ?? 0);
}

function firstSaleMs(tenantId: number, repId: number, fromMs: number, toMs: number): number | null {
  const row = rawDb.prepare(
    `SELECT MIN(sold_at) AS t FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'
        AND sold_at >= ? AND sold_at < ?`,
  ).get(tenantId, repId, iso(fromMs), iso(toMs)) as any;
  const t = row?.t ? Date.parse(row.t) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Consecutive local days ending TODAY where the rep cleared the knock bar.
 *  Today counts only if it already clears the bar — a streak you have not yet
 *  earned today should read as "day 2 of 3", not "day 3". */
function knockStreakDays(tenantId: number, repId: number, bar: number, nowMs: number, maxLookback = 60): number {
  const tz = orgTimezone(tenantId);
  let days = 0;
  for (let back = 0; back < maxLookback; back += 1) {
    const { y, mo, d } = localYmdParts(nowMs - back * DAY_MS, tz);
    const start = localWallToUtcMs(y, mo, d, 0, 0, tz);
    if (knockCount(tenantId, repId, start, start + DAY_MS) >= bar) days += 1;
    else break;
  }
  return days;
}

function awardedToRep(tenantId: number, campaignId: number, repId: number): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM spiffs
      WHERE tenant_id = ? AND campaign_id = ? AND rep_id = ? AND status IN ('earned','approved','paid')`,
  ).get(tenantId, campaignId, repId) as any;
  return Number(row?.s ?? 0);
}

export function awardedTotal(tenantId: number, campaignId: number): number {
  const row = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM spiffs
      WHERE tenant_id = ? AND campaign_id = ? AND status IN ('earned','approved','paid')`,
  ).get(tenantId, campaignId) as any;
  return Number(row?.s ?? 0);
}

/** Build the counters one campaign's rules need for one rep. */
export function buildCounters(
  tenantId: number, campaign: SpiffCampaign, repId: number, nowMs: number,
): RepWindowCounters {
  const { startMs: dayStart, endMs: dayEnd, tz } = localDayBounds(tenantId, nowMs);
  const winStart = campaign.startsAtMs;
  const winEnd = Math.min(campaign.endsAtMs, nowMs);

  const t = campaign.trigger;
  const cutoffMs = (t.kind === "knocks_by_time" || t.kind === "sale_by_time")
    ? (() => { const { y, mo, d } = localYmdParts(nowMs, tz); return localWallToUtcMs(y, mo, d, t.byHourLocal, 0, tz); })()
    : dayEnd;

  const firstToday = firstSaleMs(tenantId, repId, dayStart, dayEnd);

  return {
    repId,
    knocksInWindow: winEnd > winStart ? knockCount(tenantId, repId, winStart, winEnd) : 0,
    // Knocks today that landed BEFORE the cutoff. Capped at "now" so the number
    // never counts a future minute.
    knocksBeforeCutoffToday: knockCount(tenantId, repId, dayStart, Math.min(cutoffMs, nowMs)),
    salesInWindow: winEnd > winStart ? saleCount(tenantId, repId, winStart, winEnd) : 0,
    salesToday: saleCount(tenantId, repId, dayStart, dayEnd),
    firstSaleHourLocalToday: firstToday == null ? null : localHourIn(firstToday, tz),
    streakDaysMeetingBar: t.kind === "knock_streak"
      ? knockStreakDays(tenantId, repId, t.knocksPerDay, nowMs)
      : 0,
    awardedToRepCents: awardedToRep(tenantId, campaign.id, repId),
    awardedTotalCents: awardedTotal(tenantId, campaign.id),
  };
}

/** The deterministic key that makes an award unrepeatable. Per-sale campaigns
 *  key on the sale; everything else keys on the local day, because "40 knocks
 *  before noon" is a thing you can earn once a day, not once a knock. */
export function idempotencyKey(campaign: SpiffCampaign, repId: number, nowMs: number, tz: string, saleRef?: string): string {
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const day = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const suffix = campaign.trigger.kind === "per_sale" && saleRef ? `sale:${saleRef}` : `day:${day}`;
  return `campaign:${campaign.id}:rep:${repId}:${suffix}`;
}

export interface CampaignAwardResult {
  campaignId: number;
  campaignName: string;
  amountCents: number;
  reason: string;
  /** False when the award already existed — a retry, not a second payment. */
  inserted: boolean;
}

/**
 * Evaluate every live campaign for one rep and record what they earned.
 *
 * Called after a knock and after a sale, so the card updates the moment the rep
 * does the thing. Safe to call as often as you like: the unique index is what
 * stops a double award, not the caller's discipline.
 */
export function awardCampaignsForRep(
  tenantId: number, repId: number, nowMs: number, saleRef?: string,
): CampaignAwardResult[] {
  expireFinishedCampaigns(tenantId, nowMs);
  const tz = orgTimezone(tenantId);
  const live = (rawDb.prepare(
    `SELECT * FROM spiff_campaigns
      WHERE tenant_id = ? AND status = 'live' AND starts_at_ms <= ? AND ends_at_ms > ?`,
  ).all(tenantId, nowMs, nowMs) as any[]).map(mapCampaign);

  const out: CampaignAwardResult[] = [];
  for (const campaign of live) {
    // A per-sale campaign only pays when this call IS a sale.
    if (campaign.trigger.kind === "per_sale" && !saleRef) continue;
    const counters = buildCounters(tenantId, campaign, repId, nowMs);
    const verdict = evaluateCampaign(campaign, counters, nowMs);
    if (!("award" in verdict)) continue;

    const key = idempotencyKey(campaign, repId, nowMs, tz, saleRef);
    const info = rawDb.prepare(
      `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status, campaign_id)
       VALUES (?,?,?,?,?,'earned',?)`,
    ).run(tenantId, repId, key, verdict.award.amountCents, verdict.award.reason, campaign.id);

    const inserted = info.changes === 1;
    if (inserted) {
      storage.logActivity(null, "spiff_campaign.awarded", "spiff_campaign", campaign.id, {
        repId, amountCents: verdict.award.amountCents, reason: verdict.award.reason, idemKey: key,
      }, undefined);
    }
    out.push({
      campaignId: campaign.id, campaignName: campaign.name,
      amountCents: verdict.award.amountCents, reason: awardReason(campaign), inserted,
    });
  }
  return out;
}

export interface RepCampaignCard {
  id: number;
  name: string;
  description: string;
  rewardCents: number;
  trigger: CampaignTrigger;
  endsAtMs: number;
  progress: ReturnType<typeof campaignProgress>;
  earnedCents: number;
}

/** What the rep sees: every live campaign they are eligible for, with live
 *  progress. This is the surface that actually moves a Tuesday afternoon. */
export function repCampaignCards(tenantId: number, repId: number, nowMs: number): RepCampaignCard[] {
  expireFinishedCampaigns(tenantId, nowMs);
  const live = (rawDb.prepare(
    `SELECT * FROM spiff_campaigns
      WHERE tenant_id = ? AND status = 'live' AND starts_at_ms <= ? AND ends_at_ms > ?
      ORDER BY ends_at_ms ASC`,
  ).all(tenantId, nowMs, nowMs) as any[]).map(mapCampaign);

  return live
    .filter(c => c.eligibleRepIds == null || c.eligibleRepIds.includes(repId))
    .map(c => {
      const counters = buildCounters(tenantId, c, repId, nowMs);
      return {
        id: c.id, name: c.name, description: c.description,
        rewardCents: c.rewardCents, trigger: c.trigger, endsAtMs: c.endsAtMs,
        progress: campaignProgress(c, counters, nowMs),
        earnedCents: counters.awardedToRepCents,
      };
    });
}

/** Live payout exposure for one campaign — what it has already committed, and
 *  what the ceiling is. A manager launching "$75 a sale" should be able to see
 *  the bill climbing in real time. */
export function campaignLiability(tenantId: number, campaignId: number): {
  awardedCents: number; capCents: number; remainingCents: number | null; awardCount: number;
} {
  const c = getCampaign(tenantId, campaignId);
  const awardedCents = awardedTotal(tenantId, campaignId);
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM spiffs WHERE tenant_id = ? AND campaign_id = ? AND status IN ('earned','approved','paid')`,
  ).get(tenantId, campaignId) as any;
  const capCents = c?.campaignCapCents ?? 0;
  return {
    awardedCents,
    capCents,
    remainingCents: capCents > 0 ? Math.max(0, capCents - awardedCents) : null,
    awardCount: Number(row?.n ?? 0),
  };
}
