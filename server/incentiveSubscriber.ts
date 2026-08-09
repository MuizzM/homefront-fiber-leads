// ── Incentive subscriber — events in, ledger rows out ───────────────────────
//
// The decisions are pure and live in shared/incentiveEngine.ts. This file owns
// the campaign rows, the counters, and the one write that matters.
//
// ── WHY AWARDS LAND IN THE EXISTING `spiffs` LEDGER ─────────────────────────
// `spiffs` already carries `UNIQUE(tenant_id, sale_ref)`, an earned → approved
// → paid lifecycle, and a fold into the commission statement. Writing engine
// awards there means:
//
//   * the spec's "the same event must never create duplicate rewards" is
//     enforced by an index that already exists, not by new bookkeeping;
//   * an engine award reaches a rep's statement through the SAME path a
//     manager's spiff does — there is no second money route to reconcile;
//   * `isRewardKey()` still tells engine awards apart from the legacy inline
//     ones, so reporting can separate them without a schema change.
//
// ── AT-LEAST-ONCE DELIVERY IS FINE ──────────────────────────────────────────
// The cursor advances only after a batch's writes commit. If the process dies
// between the write and the advance, the batch re-runs and pays nothing extra,
// because every insert is `ON CONFLICT DO NOTHING` against that unique key.
// The reverse ordering — advancing before writing — is the one that loses
// money, and is why the advance is last.

import { rawDb } from "./db";
// Imported for their module-level DDL, not their exports: this file EXTENDS
// `spiffs` and `spiff_campaigns` rather than creating them, so both tables must
// already exist when ensureIncentiveSchema runs. Importing the stores that own
// them is how the house orders schema setup (each store runs its own
// ensure*Schema at import), and it keeps that ordering true no matter which
// module a test happens to import first.
import "./spiffStore";
import "./spiffCampaignStore";
import { nextBatch, advanceCursor, cursorFor } from "./domainEventStore";
import { structuredLog } from "./structuredLog";
import * as queueOps from "./eventQueueOps";
import * as referralStore from "./referralStore";
import { recordIncentive } from "./earningsLedgerStore";
import {
  DEFAULT_CLAWBACK, INCENTIVE_TRIGGER_EVENT, evaluateIncentive, evaluateClawback,
  validateCampaign, engineOwnsEarnings,
  type EventFacts, type IncentiveCampaign, type IncentiveDecision, type RecipientCounters,
} from "@shared/incentiveEngine";
import { isRewardKey, type DomainEvent } from "@shared/domainEvents";

export const SUBSCRIBER_NAME = "incentives";

export function ensureIncentiveSchema(): void {
  // The knock-shaped campaign table already exists (server/spiffCampaignStore).
  // It is EXTENDED in place rather than replaced: a second campaign table would
  // mean two places an admin could configure money and two liability reports
  // that disagree.
  const columns: Array<[string, string]> = [
    ["incentive_type", "TEXT"],
    ["amount_basis", "TEXT NOT NULL DEFAULT 'FLAT'"],
    ["percentage_bp", "INTEGER NOT NULL DEFAULT 0"],
    ["filters_json", "TEXT"],
    ["max_rewards_per_user", "INTEGER NOT NULL DEFAULT 0"],
    ["approval_required", "INTEGER NOT NULL DEFAULT 1"],
    ["clawback_policy_json", "TEXT"],
  ];
  for (const [name, type] of columns) {
    try { rawDb.exec(`ALTER TABLE spiff_campaigns ADD COLUMN ${name} ${type}`); }
    catch (e: any) { if (!/duplicate column/i.test(e?.message ?? "")) throw e; }
  }
  // Engine awards cite the event that caused them. Nullable because every
  // existing spiff row predates the engine and was caused by an inline call.
  for (const [name, type] of [["source_event_id", "INTEGER"], ["incentive_type", "TEXT"]] as const) {
    try { rawDb.exec(`ALTER TABLE spiffs ADD COLUMN ${name} ${type}`); }
    catch (e: any) { if (!/duplicate column/i.test(e?.message ?? "")) throw e; }
  }
  try { rawDb.exec(`CREATE INDEX IF NOT EXISTS idx_spiffs_source_event ON spiffs(tenant_id, source_event_id)`); }
  catch { /* already present */ }

  // Every skipped evaluation, with its reason. This is what answers "why did
  // nobody get paid on Tuesday?" — a question that is otherwise unanswerable
  // once the batch has moved on, because a skip leaves no other trace.
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS incentive_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      recipient_rep_id INTEGER,
      awarded INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      skip_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incentive_eval_once
      ON incentive_evaluations(campaign_id, event_id, recipient_rep_id);
    CREATE INDEX IF NOT EXISTS idx_incentive_eval_event
      ON incentive_evaluations(tenant_id, event_id);
  `);
}
ensureIncentiveSchema();

// ── Campaign reads ──────────────────────────────────────────────────────────

function mapCampaign(r: any): IncentiveCampaign | null {
  if (!r || !r.incentive_type) return null;   // a legacy knock campaign, not an engine one
  let filters = {};
  let clawback = DEFAULT_CLAWBACK;
  try { if (r.filters_json) filters = JSON.parse(r.filters_json); } catch { filters = {}; }
  try { if (r.clawback_policy_json) clawback = { ...DEFAULT_CLAWBACK, ...JSON.parse(r.clawback_policy_json) }; } catch { /* defaults */ }
  return {
    id: r.id, tenantId: r.tenant_id, name: r.name, description: r.description ?? "",
    incentiveType: r.incentive_type,
    amountBasis: r.amount_basis ?? "FLAT",
    rewardCents: r.reward_cents ?? 0,
    percentageBp: r.percentage_bp ?? 0,
    filters,
    startsAtMs: r.starts_at_ms, endsAtMs: r.ends_at_ms,
    maximumRewardsPerUser: r.max_rewards_per_user ?? 0,
    perRepCapCents: r.per_rep_cap_cents ?? 0,
    campaignCapCents: r.campaign_cap_cents ?? 0,
    approvalRequired: r.approval_required !== 0,
    clawbackPolicy: clawback,
    active: r.status === "live",
  };
}

/** Engine campaigns in one org that react to this event type. */
export function campaignsFor(tenantId: number, eventType: string): IncentiveCampaign[] {
  const types = (Object.keys(INCENTIVE_TRIGGER_EVENT) as Array<keyof typeof INCENTIVE_TRIGGER_EVENT>)
    .filter(t => INCENTIVE_TRIGGER_EVENT[t] === eventType);
  if (types.length === 0) return [];
  const rows = rawDb.prepare(
    `SELECT * FROM spiff_campaigns
      WHERE tenant_id = ? AND incentive_type IN (${types.map(() => "?").join(",")})`,
  ).all(tenantId, ...types) as any[];
  return rows.map(mapCampaign).filter((c): c is IncentiveCampaign => c != null);
}

export function createCampaign(p: Partial<IncentiveCampaign> & { tenantId: number; createdBy?: number | null; nowIso: string }): IncentiveCampaign {
  const problems = validateCampaign(p);
  if (problems.length > 0) throw new Error(`INVALID_CAMPAIGN:${problems.join("; ")}`);
  const info = rawDb.prepare(
    `INSERT INTO spiff_campaigns
       (tenant_id, name, description, starts_at_ms, ends_at_ms, trigger_json, reward_cents,
        eligible_rep_ids, per_rep_cap_cents, campaign_cap_cents, status, created_by, created_at, updated_at,
        incentive_type, amount_basis, percentage_bp, filters_json, max_rewards_per_user,
        approval_required, clawback_policy_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    p.tenantId, p.name, p.description ?? "",
    p.startsAtMs, p.endsAtMs,
    // The legacy trigger column is NOT NULL; engine campaigns are driven by
    // incentive_type instead, so a marker keeps the old readers from mistaking
    // one of these for a knock contest.
    JSON.stringify({ kind: "event_driven" }),
    p.rewardCents ?? 0,
    p.filters?.repIds ? JSON.stringify(p.filters.repIds) : null,
    p.perRepCapCents ?? 0, p.campaignCapCents ?? 0,
    p.active === false ? "paused" : "live",
    p.createdBy ?? null, p.nowIso, p.nowIso,
    p.incentiveType, p.amountBasis ?? "FLAT", p.percentageBp ?? 0,
    p.filters ? JSON.stringify(p.filters) : null,
    p.maximumRewardsPerUser ?? 0,
    p.approvalRequired === false ? 0 : 1,
    JSON.stringify(p.clawbackPolicy ?? DEFAULT_CLAWBACK),
  );
  return mapCampaign(rawDb.prepare(`SELECT * FROM spiff_campaigns WHERE id = ?`).get(Number(info.lastInsertRowid)))!;
}

// ── Counters ────────────────────────────────────────────────────────────────

function countersFor(tenantId: number, campaignId: number, repId: number): RecipientCounters {
  const mine = rawDb.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS c
       FROM spiffs WHERE tenant_id = ? AND campaign_id = ? AND rep_id = ? AND status != 'void'`,
  ).get(tenantId, campaignId, repId) as any;
  const all = rawDb.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS c
       FROM spiffs WHERE tenant_id = ? AND campaign_id = ? AND status != 'void'`,
  ).get(tenantId, campaignId) as any;
  const member = rawDb.prepare(
    `SELECT role FROM team_members WHERE id = ? AND tenant_id = ?`,
  ).get(repId, tenantId) as any;
  const sales = rawDb.prepare(
    `SELECT COUNT(*) AS n FROM commission_sales
      WHERE tenant_id = ? AND rep_id = ? AND status = 'QUALIFIED' AND reversed_at IS NULL`,
  ).get(tenantId, repId) as any;

  return {
    repId,
    role: member?.role ?? null,
    awardsFromCampaign: mine?.n ?? 0,
    centsFromCampaign: mine?.c ?? 0,
    centsFromCampaignTotal: all?.c ?? 0,
    lifetimeApprovedSales: sales?.n ?? 0,
  };
}

// ── Event → facts ───────────────────────────────────────────────────────────

function factsFrom(event: DomainEvent): EventFacts {
  const p = (event.payload ?? {}) as Record<string, any>;
  return {
    eventId: event.id,
    type: event.type,
    occurredAtMs: Date.parse(event.occurredAt),
    subjectRepId: event.subjectRepId ?? null,
    // Where the money comes from depends on the event, and each of these is
    // already an integer cent count written by the source.
    amountCents: p.reimbursementCents ?? p.rewardCents ?? p.saleAmountCents ?? null,
    provider: p.provider ?? null,
    product: p.product ?? null,
    market: p.market ?? null,
    territoryId: p.territoryId ?? null,
    lifetimeSaleNumber: p.lifetimeSaleNumber ?? null,
  };
}

/**
 * Who gets paid for this event?
 *
 * Usually the event's subject rep — but a REFERRAL_THRESHOLD_REACHED event is
 * ABOUT the referred rep and pays the REFERRER, which is exactly why the
 * recipient is resolved here rather than assumed to be the subject.
 */
function recipientFor(event: DomainEvent): number | null {
  if (event.type === "REFERRAL_THRESHOLD_REACHED") {
    const referral = referralStore.getReferral(event.tenantId, event.subjectId);
    return referral?.referrerRepId ?? null;
  }
  return event.subjectRepId ?? null;
}

// ── The award write ─────────────────────────────────────────────────────────

/**
 * Insert one award. Returns the ledger row id, or null when the unique index
 * refused it because this campaign already paid this recipient for this event.
 */
function writeAward(p: {
  tenantId: number; campaignId: number; repId: number; eventId: number;
  amountCents: number; reason: string; status: string; incentiveType: string; nowIso: string;
  rewardKey: string;
}): number | null {
  const info = rawDb.prepare(
    `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status,
                         created_at, campaign_id, source_event_id, incentive_type,
                         approved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     -- The uniqueness on spiffs is a PARTIAL index (…WHERE sale_ref IS NOT
     -- NULL), and SQLite only matches an ON CONFLICT target to a partial index
     -- when the target repeats the predicate. Without the WHERE this raises
     -- "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE
     -- constraint" - i.e. the idempotency this whole engine relies on would
     -- not merely be slower, it would not exist.
     ON CONFLICT(tenant_id, sale_ref) WHERE sale_ref IS NOT NULL DO NOTHING`,
  ).run(
    p.tenantId, p.repId, p.rewardKey, p.amountCents, p.reason, p.status,
    p.nowIso, p.campaignId, p.eventId, p.incentiveType,
    // A campaign that needs no review is approved at the instant it is earned,
    // so the statement can pick it up without a second human step.
    p.status === "approved" ? p.nowIso : null,
  );
  if (info.changes === 0) return null;
  return Number(info.lastInsertRowid);
}

function recordEvaluation(p: {
  tenantId: number; campaignId: number; eventId: number; repId: number | null;
  decision: IncentiveDecision; nowIso: string;
}): void {
  rawDb.prepare(
    `INSERT INTO incentive_evaluations
       (tenant_id, campaign_id, event_id, recipient_rep_id, awarded, amount_cents, skip_reason, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(campaign_id, event_id, recipient_rep_id) DO NOTHING`,
  ).run(
    p.tenantId, p.campaignId, p.eventId, p.repId,
    p.decision.awarded ? 1 : 0,
    p.decision.awarded ? p.decision.award.amountCents : 0,
    p.decision.awarded ? null : p.decision.skip,
    p.nowIso,
  );
}

// ── Clawback ────────────────────────────────────────────────────────────────

/**
 * A sale was cancelled. Reverse the awards that sale caused, per each
 * campaign's own policy.
 *
 * A reversal is a NEW, negative ledger row rather than an edit of the original:
 * the original award is a historical fact, and a rep who earned $75 and later
 * had it clawed back is owed both lines on their statement, not a silently
 * different number.
 */
function applyClawbacks(event: DomainEvent, nowIso: string): number {
  const saleId = event.subjectId;
  // Find the awards caused by this sale's approval, via the event that carried
  // it — the ledger cites its source event, so this is a lookup, not a guess.
  const priorAwards = rawDb.prepare(
    `SELECT s.*, c.clawback_policy_json, c.incentive_type
       FROM spiffs s
       JOIN domain_events e ON e.id = s.source_event_id
       LEFT JOIN spiff_campaigns c ON c.id = s.campaign_id
      WHERE s.tenant_id = ? AND e.subject_type = 'sale' AND e.subject_id = ?
        AND e.type = 'SALE_APPROVED' AND s.amount_cents > 0`,
  ).all(event.tenantId, saleId) as any[];

  let reversed = 0;
  for (const award of priorAwards) {
    let policy = DEFAULT_CLAWBACK;
    try { if (award.clawback_policy_json) policy = { ...DEFAULT_CLAWBACK, ...JSON.parse(award.clawback_policy_json) }; }
    catch { /* defaults */ }

    const decision = evaluateClawback({
      policy,
      awardedAtMs: Date.parse(award.created_at),
      cancelledAtMs: Date.parse(event.occurredAt),
      awardAmountCents: award.amount_cents,
    });
    if (!decision.reverse) continue;

    const info = rawDb.prepare(
      `INSERT INTO spiffs (tenant_id, rep_id, sale_ref, amount_cents, reason, status,
                           created_at, campaign_id, source_event_id, incentive_type)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(tenant_id, sale_ref) WHERE sale_ref IS NOT NULL DO NOTHING`,
    ).run(
      event.tenantId, award.rep_id,
      // Keyed off the reversing event, so replaying the cancellation reverses
      // once and only once.
      `clawback:${award.id}:e${event.id}`,
      -decision.amountCents,
      `Clawback - ${award.reason}`,
      "approved", nowIso, award.campaign_id, event.id, award.incentive_type,
    );
    if (info.changes > 0) reversed += 1;
  }
  return reversed;
}

// ── The subscriber ──────────────────────────────────────────────────────────

export interface DrainResult {
  processed: number;
  awarded: number;
  reversed: number;
  lastEventId: number;
  /** Events whose transaction threw. The cursor stops BEFORE the first of them,
   *  so the work is retried on the next drain rather than skipped. */
  failed: Array<{ eventId: number; type: string; tenantId: number; message: string; attempts?: number; status?: string }>;
  /** Events an operator explicitly cleared, which the queue advanced past. */
  skipped: Array<{ eventId: number; status: string; reason: string }>;
  /** Events left for later — leased by another worker, or backing off. */
  deferred: Array<{ eventId: number; reason: string }>;
  /** Correlates every log line and state row written by this drain. */
  runId: string;
}

/**
 * Process one batch of events. Returns what it did, so a caller can loop until
 * `processed` is 0 or stop after a bounded amount of work.
 *
 * `nowIso` is supplied rather than read from the clock, which is what lets a
 * test drive the whole engine at a fixed instant.
 */
export function drainOnce(nowIso: string, limit = 200): DrainResult {
  const batch = nextBatch(SUBSCRIBER_NAME, limit);
  const runId = `${SUBSCRIBER_NAME}:${nowIso}:${cursorFor(SUBSCRIBER_NAME)}`;
  const workerId = `${process.pid}`;
  const result: DrainResult = { processed: 0, awarded: 0, reversed: 0, lastEventId: cursorFor(SUBSCRIBER_NAME), failed: [], skipped: [], deferred: [], runId };
  if (batch.length === 0) return result;

  for (const event of batch) {
    // One transaction per EVENT, not per batch: a single malformed event must
    // not roll back the awards of the twenty before it, and the cursor only
    // moves past events whose work committed.
    const tx = rawDb.transaction(() => {
      if (event.type === "SALE_CANCELLED") {
        result.reversed += applyClawbacks(event, nowIso);
        // A cancellation can also un-qualify a referral, which is the referral
        // store's rule, not this engine's — so it is delegated, not duplicated.
        for (const referral of referralStore.listReferrals(event.tenantId, {})) {
          if (referral.referredRepId == null) continue;
          referralStore.recheckAfterCancellation({
            tenantId: event.tenantId, referralId: referral.id, nowIso,
          });
        }
        return;
      }

      if (event.type === "SALE_APPROVED") {
        // A sale may complete a referral's threshold. Delegated for the same
        // reason: "six approved sales" is defined once, in the referral store.
        const referral = event.subjectRepId
          ? referralStore.referralForRep(event.tenantId, event.subjectRepId)
          : null;
        if (referral) {
          referralStore.recheckQualification({ tenantId: event.tenantId, referralId: referral.id, nowIso });
        }
      }

      const facts = factsFrom(event);
      const recipient = recipientFor(event);

      for (const campaign of campaignsFor(event.tenantId, event.type)) {
        const counters = recipient != null
          ? countersFor(event.tenantId, campaign.id, recipient)
          : { repId: 0, role: null, awardsFromCampaign: 0, centsFromCampaign: 0, centsFromCampaignTotal: 0 };

        const decision = evaluateIncentive(campaign, facts, counters, recipient);
        recordEvaluation({
          tenantId: event.tenantId, campaignId: campaign.id, eventId: event.id,
          repId: recipient, decision, nowIso,
        });
        if (!decision.awarded) continue;

        const ledgerId = writeAward({
          tenantId: event.tenantId, campaignId: campaign.id, repId: decision.award.recipientRepId,
          eventId: event.id, amountCents: decision.award.amountCents,
          reason: decision.award.reason, status: decision.award.status,
          incentiveType: decision.award.incentiveType, rewardKey: decision.award.rewardKey,
          nowIso,
        });
        if (ledgerId == null) continue;   // already paid — the index refused it
        result.awarded += 1;

        // Mirror the award into the earnings ledger — but ONLY for the types
        // this engine owns. Mileage and referral money is decided by their own
        // stores, which already wrote the earnings row when they decided it;
        // writing a second one here would double the rep's apparent earnings
        // under a different idempotency key, which no constraint can catch.
        // The `spiffs` row above is still written either way, because that is
        // the rail the money travels to the statement on.
        if (engineOwnsEarnings(campaign.incentiveType)) {
          recordIncentive({
            tenantId: event.tenantId, repId: decision.award.recipientRepId, spiffId: ledgerId,
            amountCents: decision.award.amountCents,
            incentiveType: campaign.incentiveType,
            effectiveDate: event.occurredAt.slice(0, 10),
            campaignId: campaign.id, nowIso,
          });
        }

        // A referral reward links back so the referral row can show where its
        // money went, and so a payout can trace the other way.
        if (campaign.incentiveType === "REFERRAL_REWARD") {
          referralStore.attachRewardLedgerId(event.tenantId, event.subjectId, ledgerId, nowIso);
        }
      }
    });

    // A throwing event used to propagate out of drainOnce entirely, which meant
    // advanceCursor below never ran — not even past the events that HAD already
    // committed. Every later drain replayed from the same cursor, hit the same
    // event, and threw again: the queue stalled permanently and invisibly, so
    // no event after the poison one ever paid anybody.
    //
    // Deliberately STOP rather than skip ahead. These events are ordered and
    // order is load-bearing (a SALE_CANCELLED clawback must not be applied
    // before the SALE_APPROVED award it reverses), so stepping over a failure
    // could apply money out of sequence. Stopping keeps the failed event
    // claimable and the committed work durable.
    const prior = queueOps.getState(SUBSCRIBER_NAME, event.id);

    // An operator has explicitly set this one aside. That is the ONLY way the
    // queue advances past an unprocessed event, it is audited, and it is a
    // deliberate human decision rather than an automatic skip.
    if (queueOps.isOperatorCleared(prior)) {
      result.skipped.push({ eventId: event.id, status: String(prior.status), reason: String(prior.resolved_reason ?? "") });
      result.lastEventId = event.id;
      continue;
    }

    // Lease it. A live lease held by another worker, or an unexpired backoff,
    // means this worker leaves the event alone — which is what stops two
    // workers from processing one event, and what spaces out retries.
    if (!queueOps.acquireLease(SUBSCRIBER_NAME, event.id, workerId, { tenantId: event.tenantId, eventType: String(event.type) })) {
      result.deferred.push({ eventId: event.id, reason: queueOps.isHalted(prior) ? "HALTED" : "LEASED_OR_BACKING_OFF" });
      break;
    }

    try {
      tx();
    } catch (e: any) {
      const message = e?.message ?? String(e);
      const outcome = queueOps.markFailed(SUBSCRIBER_NAME, event.id, e, runId);
      result.failed.push({
        eventId: event.id, type: String(event.type), tenantId: Number(event.tenantId), message,
        attempts: outcome.attempts, status: outcome.status,
      });
      structuredLog("incentive.event_failed", {
        subscriber: SUBSCRIBER_NAME, eventId: event.id, type: String(event.type),
        tenantId: Number(event.tenantId), message, cursorHeldAt: result.lastEventId,
        attempts: outcome.attempts, status: outcome.status, runId,
      }, "error");
      break;
    }
    // Marked completed BEFORE the cursor advances, so a crash between the two
    // leaves a completed row the recovery report can reconcile against.
    queueOps.markCompleted(SUBSCRIBER_NAME, event.id, runId);
    result.processed += 1;
    result.lastEventId = event.id;
  }

  // LAST, and only for events whose work committed. Advancing first would lose
  // money on a crash; advancing last can only cause a harmless replay.
  advanceCursor(SUBSCRIBER_NAME, result.lastEventId, nowIso);
  return result;
}

/** Drain until empty, bounded so a runaway backlog cannot hold the loop. */
export function drain(nowIso: string, maxBatches = 50): DrainResult {
  const total: DrainResult = { processed: 0, awarded: 0, reversed: 0, lastEventId: 0, failed: [], skipped: [], deferred: [], runId: `${SUBSCRIBER_NAME}:${nowIso}` };
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = drainOnce(nowIso);
    total.processed += batch.processed;
    total.awarded += batch.awarded;
    total.reversed += batch.reversed;
    total.lastEventId = batch.lastEventId;
    total.runId = batch.runId;
    total.failed.push(...batch.failed);
    total.skipped.push(...batch.skipped);
    total.deferred.push(...batch.deferred);
    // A stalled batch will produce the identical failure on every retry, so
    // spinning maxBatches times over it buys nothing but log noise.
    if (batch.failed.length > 0 || batch.deferred.length > 0) break;
    if (batch.processed === 0) break;
  }
  return total;
}

/** Why a given event paid nobody — the admin's debugging view. */
export function evaluationsForEvent(tenantId: number, eventId: number) {
  return rawDb.prepare(
    `SELECT e.campaign_id AS campaignId, c.name AS campaignName, e.recipient_rep_id AS repId,
            e.awarded, e.amount_cents AS amountCents, e.skip_reason AS skipReason, e.created_at AS createdAt
       FROM incentive_evaluations e
       LEFT JOIN spiff_campaigns c ON c.id = e.campaign_id
      WHERE e.tenant_id = ? AND e.event_id = ? ORDER BY e.id ASC`,
  ).all(tenantId, eventId);
}

/** Engine awards only — reporting that needs to separate them from the legacy
 *  inline bonuses does it with this, not with a schema change. */
export function engineAwards(tenantId: number, repId?: number) {
  const rows = repId != null
    ? rawDb.prepare(`SELECT * FROM spiffs WHERE tenant_id = ? AND rep_id = ? ORDER BY id DESC LIMIT 500`).all(tenantId, repId)
    : rawDb.prepare(`SELECT * FROM spiffs WHERE tenant_id = ? ORDER BY id DESC LIMIT 500`).all(tenantId);
  return (rows as any[]).filter(r => isRewardKey(r.sale_ref));
}
