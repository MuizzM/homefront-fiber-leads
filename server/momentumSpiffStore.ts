// ── Momentum spiffs — signals, armed offers, and honouring them ─────────────
// The decision logic is pure and lives in shared/momentumSpiff.ts. This file
// reads the rep's live field activity, ARMS an offer, and pays it when they
// convert.
//
// ── AN ARMED OFFER IS A ROW, NOT A UI STATE ────────────────────────────────
// The moment a rep sees "close one in 40 minutes for $40", the org owes that
// money if they do it. So the offer is persisted the instant it is shown, with
// its amount and expiry frozen at arm time. Three consequences, all deliberate:
//
//   A rep who closes at minute 39 gets paid even if their momentum has since
//   decayed — the offer they were SHOWN is the offer that is honoured.
//
//   Retuning the config mid-afternoon cannot retroactively cheapen an offer
//   already on someone's phone.
//
//   Reloading the app, switching devices, or going offline and back does not
//   lose it. A promise that evaporates on refresh is worse than no promise.
//
// ── THE SALE MUST BE REAL ──────────────────────────────────────────────────
// Conversion requires a QUALIFIED commission sale, not a `sold` tap. A rep who
// marks a door sold and un-marks it has not converted anything, and the knock
// path's own CAS already reverses that commission.
//
// Awards land in the existing `spiffs` ledger, so they inherit earned →
// approved → paid, the payroll CSV, and the commission statement line.

import { rawDb } from "./db";
import { storage } from "./storage";
import {
  DEFAULT_MOMENTUM_CONFIG, evaluateMomentum, momentumScore, momentumReason,
  validateMomentumConfig, offerRemainingMs,
  type MomentumConfig, type MomentumSignals,
} from "@shared/momentumSpiff";
import { DEFAULT_WORKWEEK, localWallToUtcMs, localYmdParts } from "@shared/workweek";

const CONFIG_SETTING = "spiff.momentum";

export function ensureMomentumSchema(): void {
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS momentum_offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      rep_id INTEGER NOT NULL,
      armed_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      score INTEGER NOT NULL,
      headline TEXT NOT NULL DEFAULT '',
      call_to_action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'live',   -- live | converted | expired
      converted_sale_ref TEXT,
      converted_at_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_momentum_offers_live
      ON momentum_offers(tenant_id, rep_id, status, expires_at_ms);
  `);
  // At most ONE live offer per rep. Two concurrent knocks racing to arm would
  // otherwise both succeed and the rep would see a promise flicker between two
  // amounts. The partial index makes the database refuse the second.
  try {
    rawDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_momentum_one_live
                  ON momentum_offers(tenant_id, rep_id) WHERE status = 'live'`);
  } catch { /* already present */ }
}
ensureMomentumSchema();

function orgTimezone(tenantId: number): string {
  try {
    const row = rawDb.prepare(`SELECT commission_timezone AS tz FROM tenants WHERE id = ?`).get(tenantId) as any;
    return row?.tz || DEFAULT_WORKWEEK.timezone;
  } catch { return DEFAULT_WORKWEEK.timezone; }
}

/** UTC bounds of the org's local calendar day — the daily caps are a LOCAL day,
 *  because a cap that rolls over at 7pm Pacific is not a daily cap. */
function localDayBounds(tenantId: number, nowMs: number): { startMs: number; endMs: number } {
  const tz = orgTimezone(tenantId);
  const { y, mo, d } = localYmdParts(nowMs, tz);
  const startMs = localWallToUtcMs(y, mo, d, 0, 0, tz);
  return { startMs, endMs: startMs + 86_400_000 };
}

export function getMomentumConfig(tenantId: number): MomentumConfig {
  try {
    const raw = storage.getSetting(CONFIG_SETTING, tenantId);
    if (!raw) return DEFAULT_MOMENTUM_CONFIG;
    const parsed = JSON.parse(raw);
    // A malformed stored value falls back rather than throwing — a bad settings
    // row must never be able to break a knock.
    if (validateMomentumConfig(parsed)) return DEFAULT_MOMENTUM_CONFIG;
    return { ...DEFAULT_MOMENTUM_CONFIG, ...parsed };
  } catch { return DEFAULT_MOMENTUM_CONFIG; }
}

export function setMomentumConfig(tenantId: number, actorId: number | null, cfg: MomentumConfig): MomentumConfig {
  const merged = { ...DEFAULT_MOMENTUM_CONFIG, ...cfg };
  storage.setSetting(CONFIG_SETTING, JSON.stringify(merged), actorId, tenantId);
  storage.logActivity(actorId, "spiff.momentum.configured", "tenant", tenantId, {
    enabled: merged.enabled, armAtScore: merged.armAtScore, tiers: merged.tiers,
    maxCentsPerOrgPerDay: merged.maxCentsPerOrgPerDay,
  }, undefined);
  return merged;
}

const iso = (ms: number) => new Date(ms).toISOString();

// Outcomes that mean the door OPENED. Mirrors deriveWasHome (anything but
// not_home), read straight off the logged outcome so the two cannot drift.
const CONVERSATION_SQL = `k.outcome <> 'not_home'`;
// Live interest that has not closed. Deliberately EXCLUDES `sold` — a closed
// door is not a convertible signal, it is the conversion.
const INTEREST_SQL = `k.outcome IN ('interested','follow_up','callback')`;

/** Verified, distinct-door activity in a window. Same anti-farming rule as the
 *  milestone ladder: one address counts once, and only when the server's own
 *  geo check rated the knock `verified`. */
function windowActivity(tenantId: number, repId: number, fromMs: number, toMs: number): {
  doors: number; conversations: number; interest: number;
} {
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT k.lead_id) AS doors,
            COUNT(DISTINCT CASE WHEN ${CONVERSATION_SQL} THEN k.lead_id END) AS conversations,
            COUNT(DISTINCT CASE WHEN ${INTEREST_SQL}     THEN k.lead_id END) AS interest
       FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at >= ? AND k.knocked_at < ?
        AND k.verification_status = 'verified'
        AND COALESCE(k.superseded, 0) = 0`,
  ).get(repId, tenantId, iso(fromMs), iso(toMs)) as any;
  return {
    doors: Number(row?.doors ?? 0),
    conversations: Number(row?.conversations ?? 0),
    interest: Number(row?.interest ?? 0),
  };
}

/**
 * The rep's own trailing doors-per-hour, over the 14 days BEFORE the current
 * window — the baseline the pace ratio is measured against.
 *
 * Divided by hours ACTUALLY WORKED (days with any activity × 8), not by
 * 14×24. Dividing by wall-clock would give everyone a baseline near zero and
 * make every rep permanently "1.15× above pace", which would arm an offer for
 * simply existing.
 */
function baselineDoorsPerHour(tenantId: number, repId: number, windowStartMs: number): number {
  const fromMs = windowStartMs - 14 * 86_400_000;
  const row = rawDb.prepare(
    `SELECT COUNT(DISTINCT k.lead_id) AS doors,
            COUNT(DISTINCT date(k.knocked_at)) AS days
       FROM knock_log k
       JOIN leads l ON l.id = k.lead_id
      WHERE k.rep_id = ? AND l.tenant_id = ?
        AND k.knocked_at >= ? AND k.knocked_at < ?
        AND k.verification_status = 'verified'
        AND COALESCE(k.superseded, 0) = 0`,
  ).get(repId, tenantId, iso(fromMs), iso(windowStartMs)) as any;

  const doors = Number(row?.doors ?? 0);
  const days = Number(row?.days ?? 0);
  if (doors <= 0 || days <= 0) return 0; // no history → the engine treats it as neutral
  return doors / (days * 8);
}

function minutesSinceLastSale(tenantId: number, repId: number, nowMs: number): number | null {
  const row = rawDb.prepare(
    `SELECT MAX(sold_at) AS t FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED'`,
  ).get(tenantId, repId) as any;
  const t = row?.t ? Date.parse(row.t) : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 60_000));
}

function awardedToday(tenantId: number, repId: number | null, nowMs: number): number {
  const { startMs, endMs } = localDayBounds(tenantId, nowMs);
  const sql = `SELECT COALESCE(SUM(s.amount_cents), 0) AS c
                 FROM spiffs s
                 JOIN momentum_offers o ON o.id = CAST(substr(s.sale_ref, 10) AS INTEGER)
                WHERE s.tenant_id = ? AND s.sale_ref LIKE 'momentum:%'
                  AND s.status IN ('earned','approved','paid')
                  AND o.converted_at_ms >= ? AND o.converted_at_ms < ?
                  ${repId != null ? "AND s.rep_id = ?" : ""}`;
  const args: any[] = [tenantId, startMs, endMs];
  if (repId != null) args.push(repId);
  const row = rawDb.prepare(sql).get(...args) as any;
  return Number(row?.c ?? 0);
}

function offersArmedToday(tenantId: number, repId: number, nowMs: number): number {
  const { startMs, endMs } = localDayBounds(tenantId, nowMs);
  const row = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM momentum_offers
      WHERE tenant_id = ? AND rep_id = ? AND armed_at_ms >= ? AND armed_at_ms < ?`,
  ).get(tenantId, repId, startMs, endMs) as any;
  return Number(row?.n ?? 0);
}

/** Everything the pure rules read, assembled for one rep at one instant. */
export function buildSignals(
  tenantId: number, repId: number, nowMs: number, cfg = getMomentumConfig(tenantId),
): MomentumSignals {
  const windowStart = nowMs - cfg.windowMinutes * 60_000;
  const act = windowActivity(tenantId, repId, windowStart, nowMs);
  return {
    repId,
    doorsInWindow: act.doors,
    conversationsInWindow: act.conversations,
    interestSignalsInWindow: act.interest,
    baselineDoorsPerHour: baselineDoorsPerHour(tenantId, repId, windowStart),
    minutesSinceLastSale: minutesSinceLastSale(tenantId, repId, nowMs),
    offersArmedToday: offersArmedToday(tenantId, repId, nowMs),
    awardedToRepTodayCents: awardedToday(tenantId, repId, nowMs),
    awardedOrgTodayCents: awardedToday(tenantId, null, nowMs),
  };
}

export interface LiveOffer {
  id: number;
  amountCents: number;
  expiresAtMs: number;
  score: number;
  headline: string;
  callToAction: string;
  remainingMs: number;
}

function mapOffer(row: any, nowMs: number): LiveOffer {
  return {
    id: Number(row.id),
    amountCents: Number(row.amount_cents),
    expiresAtMs: Number(row.expires_at_ms),
    score: Number(row.score),
    headline: String(row.headline ?? ""),
    callToAction: String(row.call_to_action ?? ""),
    remainingMs: offerRemainingMs(Number(row.expires_at_ms), nowMs),
  };
}

/** Retire offers whose clock ran out. An expired offer is NOT a failure the rep
 *  is told about — it simply stops being shown. "You missed it" is demotivating
 *  noise after the fact and teaches nothing actionable. */
export function expireStaleOffers(tenantId: number, nowMs: number): void {
  rawDb.prepare(
    `UPDATE momentum_offers SET status = 'expired'
      WHERE tenant_id = ? AND status = 'live' AND expires_at_ms <= ?`,
  ).run(tenantId, nowMs);
}

export function liveOfferFor(tenantId: number, repId: number, nowMs: number): LiveOffer | null {
  expireStaleOffers(tenantId, nowMs);
  const row = rawDb.prepare(
    `SELECT * FROM momentum_offers
      WHERE tenant_id = ? AND rep_id = ? AND status = 'live' AND expires_at_ms > ?
      ORDER BY id DESC LIMIT 1`,
  ).get(tenantId, repId, nowMs);
  return row ? mapOffer(row, nowMs) : null;
}

/**
 * Called after every applied knock. Arms an offer if the rep just went hot.
 *
 * Returns the offer ONLY when it was newly armed, so the caller can surface it
 * once at the door rather than re-announcing it on every subsequent knock.
 */
export function armMomentumOffer(tenantId: number, repId: number, nowMs: number): LiveOffer | null {
  const cfg = getMomentumConfig(tenantId);
  if (!cfg.enabled) return null;

  expireStaleOffers(tenantId, nowMs);
  // Already holding one — do not re-arm, do not re-announce. The rep is already
  // chasing something, and a second card would just muddy which promise is real.
  if (liveOfferFor(tenantId, repId, nowMs)) return null;

  const signals = buildSignals(tenantId, repId, nowMs, cfg);
  const verdict = evaluateMomentum(signals, nowMs, cfg);
  if (!("offer" in verdict)) return null;

  const o = verdict.offer;
  try {
    const info = rawDb.prepare(
      `INSERT INTO momentum_offers
        (tenant_id, rep_id, armed_at_ms, expires_at_ms, amount_cents, score, headline, call_to_action, status)
       VALUES (?,?,?,?,?,?,?,?,'live')`,
    ).run(tenantId, repId, nowMs, o.expiresAtMs, o.amountCents, o.score, o.headline, o.callToAction);

    storage.logActivity(null, "spiff.momentum.armed", "team_member", repId, {
      offerId: Number(info.lastInsertRowid), amountCents: o.amountCents, score: o.score,
      doors: signals.doorsInWindow, conversations: signals.conversationsInWindow,
      interest: signals.interestSignalsInWindow, expiresAtMs: o.expiresAtMs,
    }, undefined);

    return liveOfferFor(tenantId, repId, nowMs);
  } catch (e: any) {
    // The one-live-offer unique index rejected a concurrent arm. That is the
    // index doing its job — the other request's offer stands.
    if (/UNIQUE|constraint/i.test(e?.message ?? "")) return null;
    throw e;
  }
}

export interface MomentumConversion {
  offerId: number;
  amountCents: number;
  reason: string;
  inserted: boolean;
}

/**
 * Called after a QUALIFIED sale. Pays the live offer, if there is one.
 *
 * The amount comes from the OFFER ROW, never from a re-evaluation — the rep is
 * paid what they were shown. Idempotent on the offer id, so a retried sale or a
 * replayed knock cannot pay the same promise twice.
 */
export function convertMomentumOffer(
  tenantId: number, repId: number, saleRef: string, nowMs: number,
): MomentumConversion | null {
  expireStaleOffers(tenantId, nowMs);
  const offer = liveOfferFor(tenantId, repId, nowMs);
  if (!offer) return null;

  // Close the offer FIRST, conditionally on it still being live. If another
  // request converted it a millisecond ago, this updates zero rows and we stop
  // — the ledger insert never runs twice.
  const closed = rawDb.prepare(
    `UPDATE momentum_offers
        SET status = 'converted', converted_sale_ref = ?, converted_at_ms = ?
      WHERE id = ? AND status = 'live'`,
  ).run(saleRef, nowMs, offer.id);
  if (closed.changes !== 1) return null;

  const key = `momentum:${offer.id}`;
  const reason = momentumReason(offer.amountCents);
  const info = rawDb.prepare(
    `INSERT OR IGNORE INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status)
     VALUES (?,?,?,?,?,'earned')`,
  ).run(tenantId, repId, key, offer.amountCents, reason);

  const inserted = info.changes === 1;
  if (inserted) {
    storage.logActivity(null, "spiff.momentum.converted", "team_member", repId, {
      offerId: offer.id, amountCents: offer.amountCents, saleRef,
      secondsToClose: Math.round((nowMs - (offer.expiresAtMs - offer.remainingMs)) / 1000),
    }, undefined);
  }
  return { offerId: offer.id, amountCents: offer.amountCents, reason, inserted };
}

export interface MomentumCard {
  enabled: boolean;
  /** The live offer, or null. */
  offer: LiveOffer | null;
  /** How hot they are right now, 0–100 — shown even with no offer, so the rep
   *  can see the meter climbing toward one rather than being surprised. */
  score: number;
  armAtScore: number;
  /** What the next offer would be worth if they got there. */
  nextAmountCents: number;
  doorsInWindow: number;
  conversationsInWindow: number;
  interestSignalsInWindow: number;
  windowMinutes: number;
  /** Cents this rep has converted from momentum offers today. */
  earnedTodayCents: number;
}

/** What the rep sees. Shows the meter even when cold, because a hidden mechanic
 *  cannot motivate anyone — a rep who watches the bar climb learns what the
 *  system rewards, which is exactly the behaviour we want more of. */
export function repMomentumCard(tenantId: number, repId: number, nowMs: number): MomentumCard {
  const cfg = getMomentumConfig(tenantId);
  if (!cfg.enabled) {
    return {
      enabled: false, offer: null, score: 0, armAtScore: cfg.armAtScore, nextAmountCents: 0,
      doorsInWindow: 0, conversationsInWindow: 0, interestSignalsInWindow: 0,
      windowMinutes: cfg.windowMinutes, earnedTodayCents: 0,
    };
  }
  const signals = buildSignals(tenantId, repId, nowMs, cfg);
  const lowestTier = [...cfg.tiers].sort((a, b) => a.atScore - b.atScore)[0];
  return {
    enabled: true,
    offer: liveOfferFor(tenantId, repId, nowMs),
    score: momentumScore(signals, cfg),
    armAtScore: cfg.armAtScore,
    nextAmountCents: lowestTier ? lowestTier.amountCents : 0,
    doorsInWindow: signals.doorsInWindow,
    conversationsInWindow: signals.conversationsInWindow,
    interestSignalsInWindow: signals.interestSignalsInWindow,
    windowMinutes: cfg.windowMinutes,
    earnedTodayCents: signals.awardedToRepTodayCents,
  };
}

/** Live exposure + how the mechanic is actually performing. The conversion rate
 *  is the number that says whether this is working: offers that expire unclaimed
 *  are a threshold set too high, or a window set too short. */
export function momentumExposure(tenantId: number, nowMs: number): {
  enabled: boolean;
  liveOffers: number; liveCommitmentCents: number;
  armedToday: number; convertedToday: number; expiredToday: number;
  awardedTodayCents: number; conversionRate: number;
} {
  expireStaleOffers(tenantId, nowMs);
  const { startMs, endMs } = localDayBounds(tenantId, nowMs);
  const live = rawDb.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS c FROM momentum_offers
      WHERE tenant_id = ? AND status = 'live' AND expires_at_ms > ?`,
  ).get(tenantId, nowMs) as any;
  const day = rawDb.prepare(
    `SELECT COUNT(*) AS armed,
            SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) AS converted,
            SUM(CASE WHEN status = 'expired'   THEN 1 ELSE 0 END) AS expired
       FROM momentum_offers
      WHERE tenant_id = ? AND armed_at_ms >= ? AND armed_at_ms < ?`,
  ).get(tenantId, startMs, endMs) as any;

  const armed = Number(day?.armed ?? 0);
  const converted = Number(day?.converted ?? 0);
  return {
    enabled: getMomentumConfig(tenantId).enabled,
    liveOffers: Number(live?.n ?? 0),
    liveCommitmentCents: Number(live?.c ?? 0),
    armedToday: armed,
    convertedToday: converted,
    expiredToday: Number(day?.expired ?? 0),
    awardedTodayCents: awardedToday(tenantId, null, nowMs),
    conversionRate: armed > 0 ? Math.round((converted / armed) * 100) : 0,
  };
}
