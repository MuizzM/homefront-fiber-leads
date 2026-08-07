// ── Domain events — the spine the incentive engine subscribes to ────────────
//
// WHY THIS EXISTS. Today every incentive is awarded by an INLINE CALL at the
// write site: the knock route evaluates a spiff, the training route calls
// payRampBonus, the review batch calls awardRampForRep. That works, and it is
// why those bonuses are correct — but it means the set of things that can earn
// money is fixed at the call sites, and a reward can never name the thing that
// caused it. The spec's `incentive_ledger.source_event_id` and its rule that
// "the same event must never create duplicate rewards" both need a durable,
// identifiable event to point AT.
//
// So: writes emit events, and awarding subscribes. This file is the pure half —
// the taxonomy, the validation, and (most importantly) the two KEY DERIVATIONS
// that make the whole thing idempotent. server/domainEventStore.ts is the
// durable half.
//
// PURE: no clock, no database, no randomness. Every function here is a
// deterministic function of its arguments, which is what lets a test assert
// that replaying the same event twice produces the same key and therefore the
// same single reward.
//
// ── TWO KEYS, TWO DIFFERENT JOBS ────────────────────────────────────────────
//
//   eventDedupeKey   makes EMISSION idempotent. "This sale qualified" emitted
//                    twice (a retry, a double-click, a replayed webhook) is ONE
//                    row in domain_events.
//
//   rewardKey        makes AWARDING idempotent. One event evaluated against one
//                    campaign for one recipient can pay at most once, no matter
//                    how many times the subscriber runs.
//
// Both are needed and neither substitutes for the other: deduping emission does
// not stop a subscriber re-running over an event it already paid, and deduping
// the reward does not stop the event log from growing a duplicate row that
// every downstream count then double-counts.
//
// ── WHY THE REWARD KEY IS SHAPED THE WAY IT IS ──────────────────────────────
// `rewardKey` lands in `spiffs.sale_ref`, which already carries
// `UNIQUE(tenant_id, sale_ref)`. That index — which exists today, for the
// existing spiff ledger — becomes the enforcement point for the spec's
// no-duplicate-rewards rule. No new uniqueness mechanism is introduced, and the
// database refuses the second write rather than the application remembering to.

/**
 * Every event the platform emits. Named for the FACT that occurred, in the past
 * tense, never for the reaction ("SALE_APPROVED", not "PAY_COMMISSION") — a
 * subscriber may come and go, but the fact stays true.
 */
export const DOMAIN_EVENT_TYPES = [
  // ── Sales ────────────────────────────────────────────────────────────────
  /** A commissionable sale reached QUALIFIED. The spec calls this SALE_APPROVED. */
  "SALE_APPROVED",
  /** A previously-qualified sale was cancelled/reversed — the clawback trigger. */
  "SALE_CANCELLED",

  // ── Training ─────────────────────────────────────────────────────────────
  /** All required lessons of a course are done. Completion, NOT enrollment —
   *  opening a course emits nothing, by explicit product rule. */
  "TRAINING_COMPLETED",
  /** A graded assessment cleared its configured passing score. */
  "TRAINING_PASSED",

  // ── Mileage ──────────────────────────────────────────────────────────────
  "MILEAGE_SUBMITTED",
  "MILEAGE_APPROVED",

  // ── Referrals ────────────────────────────────────────────────────────────
  "REFERRAL_CREATED",
  "REFERRAL_REP_HIRED",
  "REFERRAL_REP_ACTIVATED",
  /** The referred rep's Nth qualifying sale landed — N is org-configured. */
  "REFERRAL_THRESHOLD_REACHED",

  // ── Money ────────────────────────────────────────────────────────────────
  "PAYOUT_APPROVED",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(DOMAIN_EVENT_TYPES);

export function isDomainEventType(v: unknown): v is DomainEventType {
  return typeof v === "string" && EVENT_TYPE_SET.has(v);
}

/**
 * What the event is ABOUT. Kept as a small closed set rather than free text so
 * `(subjectType, subjectId)` is a real composite identity a query can index and
 * a dedupe key can be built from without ambiguity.
 */
export const EVENT_SUBJECT_TYPES = [
  "sale", "training_enrollment", "training_quiz_attempt",
  "mileage_trip", "referral", "payout", "rep",
] as const;
export type EventSubjectType = (typeof EVENT_SUBJECT_TYPES)[number];

/**
 * An event as it is emitted. `occurredAt` is supplied by the caller (this module
 * has no clock) and is the instant the FACT happened, which is not always the
 * instant the row is written — an offline mileage trip approved on sync
 * occurred when the manager approved it, not when the request landed.
 */
export interface DomainEventInput {
  tenantId: number;
  type: DomainEventType;
  subjectType: EventSubjectType;
  subjectId: number;
  /** The rep the event is ABOUT (team_members.id) — the default reward
   *  recipient. Null for events with no single beneficiary. */
  subjectRepId?: number | null;
  /** Who caused it (users.id). Null = system/automatic. */
  actorUserId?: number | null;
  /** Event-specific facts. Must be JSON-serializable and must NOT carry
   *  secrets — this table is read by reporting and audit surfaces. */
  payload?: Record<string, unknown> | null;
  /** ISO-8601 with milliseconds and a trailing Z, always (the convention the
   *  spiffs ledger settled on — see normalizeSpiffTimestamps for why a mixed
   *  format is not cosmetic when the column is compared as TEXT). */
  occurredAt: string;
  /**
   * Overrides the derived dedupe key. Supply one when the natural
   * `(type, subject)` identity is NOT unique per occurrence — the clearest case
   * is MILEAGE_SUBMITTED, where the same trip may legitimately be submitted
   * again after a rejection and each submission is a distinct fact.
   */
  dedupeKey?: string;
}

/**
 * The stored shape. `id` is what a reward row references as `source_event_id`.
 */
export interface DomainEvent extends Omit<DomainEventInput, "payload" | "dedupeKey"> {
  id: number;
  payload: Record<string, unknown> | null;
  dedupeKey: string;
  recordedAt: string;
}

/**
 * Events whose natural identity is NOT one-per-subject, and which therefore
 * always need a caller-supplied discriminator inside the dedupe key.
 *
 * A trip can be submitted, rejected, and submitted again — three real facts
 * about one subject. A sale, by contrast, qualifies exactly once: emitting
 * SALE_APPROVED for sale 42 twice IS a duplicate and must collapse.
 */
const REPEATABLE_EVENTS: ReadonlySet<DomainEventType> = new Set<DomainEventType>([
  "MILEAGE_SUBMITTED",
  "TRAINING_PASSED",          // a rep may retake an assessment
  "REFERRAL_THRESHOLD_REACHED", // configurable thresholds; more than one may exist
]);

export function isRepeatableEvent(type: DomainEventType): boolean {
  return REPEATABLE_EVENTS.has(type);
}

/**
 * The natural idempotency key for an emission.
 *
 * For a once-ever fact this is simply `type:subjectType:subjectId`, so two
 * concurrent "this sale qualified" writes collapse to one row under the store's
 * UNIQUE index — the retry does not need to know it is a retry.
 *
 * For a repeatable fact the caller MUST supply `dedupeKey`; without one this
 * function throws rather than silently minting a key that would swallow the
 * second legitimate occurrence. Failing loudly here is the whole point: a
 * quietly-dropped MILEAGE_SUBMITTED is a trip a rep never gets paid for.
 */
export function eventDedupeKey(input: Pick<DomainEventInput, "type" | "subjectType" | "subjectId" | "dedupeKey">): string {
  if (input.dedupeKey) return input.dedupeKey;
  if (isRepeatableEvent(input.type)) {
    throw new Error(`EVENT_DEDUPE_KEY_REQUIRED:${input.type}`);
  }
  return `${input.type}:${input.subjectType}:${input.subjectId}`;
}

/**
 * The idempotency key for ONE reward: this campaign, paying this recipient, for
 * this event. Written to `spiffs.sale_ref`, where the existing
 * `UNIQUE(tenant_id, sale_ref)` index makes a second attempt a no-op.
 *
 * The recipient is part of the key on purpose. A referral reward pays the
 * REFERRER for an event about the REFERRED rep, and an override pays an upline
 * for an event about a downline seller — one event legitimately produces
 * several rewards, to different people. Keying on the event alone would pay
 * only the first of them.
 */
export function rewardKey(campaignId: number, eventId: number, recipientRepId: number): string {
  return `inc:c${Math.trunc(campaignId)}:e${Math.trunc(eventId)}:r${Math.trunc(recipientRepId)}`;
}

/** Does this ledger reference come from the event-driven engine? Lets reporting
 *  separate engine awards from the legacy inline ones without a schema change. */
export function isRewardKey(saleRef: string | null | undefined): boolean {
  return typeof saleRef === "string" && saleRef.startsWith("inc:c");
}

/**
 * Validate an emission before it reaches the database. Returns a list of
 * problems; empty means valid. Returning problems rather than throwing lets a
 * route reject with a useful 400 and lets a batch emitter skip one bad event
 * without losing the rest of the batch.
 */
export function validateEventInput(input: Partial<DomainEventInput>): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(input.tenantId) || (input.tenantId as number) <= 0) {
    problems.push("tenantId must be a positive integer");
  }
  if (!isDomainEventType(input.type)) problems.push("type is not a known domain event");
  if (!input.subjectType || !(EVENT_SUBJECT_TYPES as readonly string[]).includes(input.subjectType)) {
    problems.push("subjectType is not a known subject");
  }
  if (!Number.isInteger(input.subjectId) || (input.subjectId as number) <= 0) {
    problems.push("subjectId must be a positive integer");
  }
  if (typeof input.occurredAt !== "string" || !ISO_INSTANT.test(input.occurredAt)) {
    problems.push("occurredAt must be an ISO-8601 instant with milliseconds and a trailing Z");
  }
  if (input.type && isDomainEventType(input.type) && isRepeatableEvent(input.type) && !input.dedupeKey) {
    problems.push(`${input.type} is repeatable and requires an explicit dedupeKey`);
  }
  if (input.payload != null && typeof input.payload !== "object") {
    problems.push("payload must be an object or null");
  }
  return problems;
}

/** The one timestamp shape this codebase writes: 2026-08-06T17:02:00.000Z */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isIsoInstant(v: unknown): v is string {
  return typeof v === "string" && ISO_INSTANT.test(v);
}

/**
 * Which events can create a reward, and which REVERSE one.
 *
 * Split explicitly rather than inferred from the name, because the reversal set
 * is what the clawback path iterates and a mis-classified event there either
 * fails to claw back money or claws back money that was never paid.
 */
export const REWARDING_EVENTS: ReadonlySet<DomainEventType> = new Set<DomainEventType>([
  "SALE_APPROVED", "TRAINING_COMPLETED", "TRAINING_PASSED",
  "MILEAGE_APPROVED", "REFERRAL_THRESHOLD_REACHED",
]);

export const REVERSING_EVENTS: ReadonlySet<DomainEventType> = new Set<DomainEventType>([
  "SALE_CANCELLED",
]);

export function canReward(type: DomainEventType): boolean {
  return REWARDING_EVENTS.has(type);
}
export function isReversal(type: DomainEventType): boolean {
  return REVERSING_EVENTS.has(type);
}
