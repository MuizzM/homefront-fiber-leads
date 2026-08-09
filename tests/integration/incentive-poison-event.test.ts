// ── A poison event must not stall the incentive queue forever ────────────────
//
// `drainOnce` ran each event's transaction bare and called `advanceCursor` only
// after the whole batch. So one throwing event propagated out of `drainOnce`
// entirely — the cursor never advanced, not even past the events that HAD
// already committed. Every later drain replayed from the same cursor, hit the
// same event, and threw again: the queue stalled permanently, no event after
// the poison one ever paid anybody, and the only signal was an exception
// reaching whatever happened to call drain.
//
// The fix STOPS at the failure rather than skipping past it, because these
// events are ordered and order is load-bearing (a SALE_CANCELLED clawback must
// not be applied before the SALE_APPROVED award it reverses). Stopping keeps
// the failed event claimable, keeps committed work durable, and makes the stall
// loud instead of silent.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Throw on the Nth call to a collaborator the SALE_APPROVED path always makes —
// one call per event, so `nth` selects exactly which event is poisoned.
const fault = vi.hoisted(() => ({ nth: -1, calls: 0, always: false }));
vi.mock("../../server/referralStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/referralStore")>();
  return {
    ...actual,
    referralForRep: (...args: any[]) => {
      fault.calls += 1;
      if (fault.always || fault.calls === fault.nth) throw new TypeError("simulated collaborator fault");
      return (actual.referralForRep as any)(...args);
    },
  };
});

let E: typeof import("../../server/domainEventStore");
let S: typeof import("../../server/incentiveSubscriber");
let R: typeof import("../../server/referralStore");
let Q: typeof import("../../server/eventQueueOps");
let rawDb: import("better-sqlite3").Database;

const T1 = 1, REP = 10;
const NOW = "2026-08-06T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const awardsFor = (repId: number) =>
  rawDb.prepare(`SELECT * FROM spiffs WHERE tenant_id = ? AND rep_id = ? ORDER BY id ASC`).all(T1, repId) as any[];

const saleApproved = (saleId: number) =>
  E.emit({
    tenantId: T1, type: "SALE_APPROVED", subjectType: "sale", subjectId: saleId,
    subjectRepId: REP, occurredAt: NOW, payload: {},
  }, NOW);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-incentive-poison-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  E = await import("../../server/domainEventStore");
  R = await import("../../server/referralStore");
  S = await import("../../server/incentiveSubscriber");
  Q = await import("../../server/eventQueueOps");
});

beforeEach(() => {
  fault.nth = -1;
  fault.calls = 0;
  fault.always = false;
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  for (const t of ["domain_events", "event_subscriptions", "spiffs", "spiff_campaigns",
    "incentive_evaluations", "referrals", "referral_links", "referral_events",
    "commission_sales", "earnings_ledger", "event_processing_state"]) {
    rawDb.prepare(`DELETE FROM ${t}`).run();
  }
  E.ensureDomainEventSchema();
  R.ensureReferralSchema();
  S.ensureIncentiveSchema();
  Q.ensureEventQueueSchema();
  rawDb.prepare(
    `INSERT OR REPLACE INTO team_members (id, name, role, active, tenant_id, created_at)
     VALUES (?,?,?,1,?,datetime('now'))`,
  ).run(REP, "Field Rep", "rep", T1);
  S.createCampaign({
    tenantId: T1, name: "Poison test", incentiveType: "PRODUCT_SPIFF",
    amountBasis: "FLAT", rewardCents: 7_500,
    startsAtMs: NOW_MS - 86_400_000, endsAtMs: NOW_MS + 86_400_000,
    approvalRequired: false, nowIso: NOW,
  } as any);
});

describe("a throwing event is isolated, reported, and retryable", () => {
  it("THE DEFECT: drain returns instead of throwing, and keeps the work that committed", () => {
    saleApproved(1);
    saleApproved(2);
    saleApproved(3);

    fault.nth = 2;   // poison the SECOND event
    const result = S.drain(NOW);

    // It returns a report rather than exploding.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ type: "SALE_APPROVED" });
    expect(result.failed[0].message).toContain("simulated collaborator fault");

    // Event 1 committed and is durable…
    expect(result.processed).toBe(1);
    expect(awardsFor(REP)).toHaveLength(1);
    // …and the cursor advanced past it, so its award is never replayed.
    expect(E.cursorFor(S.SUBSCRIBER_NAME)).toBe(result.lastEventId);
    expect(result.lastEventId).toBeGreaterThan(0);
  });

  it("does NOT skip ahead - the failed event stays claimable and order is preserved", () => {
    const e1 = saleApproved(1);
    const e2 = saleApproved(2);
    saleApproved(3);

    fault.nth = 2;
    S.drain(NOW);

    // The cursor stops BEFORE the poison event, so neither it nor event 3 was
    // consumed. Stepping over a failure could apply money out of sequence.
    expect(E.cursorFor(S.SUBSCRIBER_NAME)).toBe(e1.id);
    expect(E.cursorFor(S.SUBSCRIBER_NAME)).toBeLessThan(e2.id);
  });

  it("RETRY after the fault clears drains the rest and pays each event exactly once", () => {
    saleApproved(1);
    saleApproved(2);
    saleApproved(3);

    fault.nth = 2;
    S.drain(NOW);
    expect(awardsFor(REP)).toHaveLength(1);

    // Fault cleared. The failed event is now BACKING OFF, so it is not retried
    // instantly — an operator clears the backoff explicitly, with a reason.
    fault.nth = -1;
    const stalled = S.drain(NOW);
    expect(stalled.processed).toBe(0);
    expect(stalled.deferred.length).toBeGreaterThan(0);

    const blockedId = stalled.deferred[0].eventId;
    Q.operatorAction({
      subscriber: S.SUBSCRIBER_NAME, eventId: blockedId, action: "RETRY",
      actorUserId: 1, reason: "collaborator fault fixed in deploy 1234",
    });

    const retry = S.drain(NOW);
    expect(retry.failed).toHaveLength(0);
    expect(retry.processed).toBe(2);

    // Three events, three awards. The one that committed before the stall was
    // not paid twice, which is what the cursor discipline buys.
    expect(awardsFor(REP)).toHaveLength(3);
    expect(S.drain(NOW).processed).toBe(0);
  });

  it("a stalled batch does not spin the bounded retry loop", () => {
    saleApproved(1);
    saleApproved(2);

    fault.nth = 1;                       // poison the FIRST event
    const before = fault.calls;
    S.drain(NOW, 50);                    // would otherwise retry 50 times
    // One failing attempt, not fifty: the identical failure on every retry buys
    // nothing but log noise.
    expect(fault.calls - before).toBe(1);
    expect(E.cursorFor(S.SUBSCRIBER_NAME)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POISON-EVENT OPERATIONS — durable state, leases, backoff, operator actions.
//
// Stopping at a poison event is financially correct but was not OPERABLE: the
// stall was a log line, nobody could see how long it had been stuck, and the
// only exit was a deploy. None of the actions below move money — retry re-runs
// idempotent work, dead-letter and resolve only decide whether the queue may
// advance, and the event row itself is never deleted.
// ═══════════════════════════════════════════════════════════════════════════
describe("durable queue state", () => {
  it("records status, attempts, fingerprint and run id for a failing event", () => {
    saleApproved(1);
    saleApproved(2);
    fault.nth = 2;
    const out = S.drain(NOW);

    const st = Q.getState(S.SUBSCRIBER_NAME, out.failed[0].eventId);
    expect(st).toMatchObject({ status: "failed", attempts: 1, retryable: 1 });
    expect(st.error_fingerprint).toContain("TypeError");
    expect(st.last_error).toContain("simulated collaborator fault");
    expect(st.run_id).toBe(out.runId);
    expect(st.first_failed_at).toBeTruthy();
    expect(st.next_attempt_at).toBeTruthy();       // backing off, not spinning
  });

  it("normalizes error fingerprints so repeats group as ONE incident", () => {
    const a = Q.fingerprint(new TypeError("rep 41 failed at 2026-08-06T12:00:00Z"));
    const b = Q.fingerprint(new TypeError("rep 77 failed at 2026-09-01T03:30:00Z"));
    expect(a).toBe(b);
    expect(Q.fingerprint(new RangeError("rep 41 failed"))).not.toBe(a);
  });

  it("marks a successfully processed event completed", () => {
    const e = saleApproved(1);
    S.drain(NOW);
    expect(Q.getState(S.SUBSCRIBER_NAME, e.id)).toMatchObject({ status: "completed" });
  });
});

describe("leases: two workers cannot process one event", () => {
  it("only the first lease attempt wins", () => {
    const e = saleApproved(1);
    expect(Q.acquireLease(S.SUBSCRIBER_NAME, e.id, "worker-A")).toBe(true);
    expect(Q.acquireLease(S.SUBSCRIBER_NAME, e.id, "worker-B")).toBe(false);
  });

  it("a drain defers an event another worker already holds, and pays nobody twice", () => {
    const e = saleApproved(1);
    Q.acquireLease(S.SUBSCRIBER_NAME, e.id, "worker-A");
    const out = S.drain(NOW);
    expect(out.processed).toBe(0);
    expect(out.deferred[0]).toMatchObject({ eventId: e.id });
    expect(awardsFor(REP)).toHaveLength(0);
  });

  it("an EXPIRED lease is reclaimable - the worker-crash recovery path", () => {
    const e = saleApproved(1);
    Q.acquireLease(S.SUBSCRIBER_NAME, e.id, "dead-worker");
    // Simulate the crash: the lease is left behind and ages out.
    rawDb.prepare(
      `UPDATE event_processing_state SET lease_expires_at = ? WHERE subscriber = ? AND event_id = ?`,
    ).run(new Date(Date.now() - 60_000).toISOString(), S.SUBSCRIBER_NAME, e.id);

    const out = S.drain(NOW);
    expect(out.processed).toBe(1);
    // Reclaiming re-runs idempotent work, so the award is written exactly once.
    expect(awardsFor(REP)).toHaveLength(1);
  });
});

describe("operator actions are audited and never silently discard money", () => {
  const auditFor = (action: string) => rawDb.prepare(
    `SELECT * FROM activity_log WHERE action = ? ORDER BY id DESC LIMIT 1`,
  ).get(`event_queue.${action}`) as any;

  it("requires a reason", () => {
    const e = saleApproved(1);
    fault.nth = 1;
    S.drain(NOW);
    expect(() => Q.operatorAction({
      subscriber: S.SUBSCRIBER_NAME, eventId: e.id, action: "RETRY", actorUserId: 1, reason: "  ",
    })).toThrow(/reason is required/i);
  });

  it("RETRY clears the backoff, is audited, and lets the queue resume", () => {
    saleApproved(1);
    saleApproved(2);
    fault.nth = 1;
    const stalled = S.drain(NOW);
    const badId = stalled.failed[0].eventId;

    fault.nth = -1;
    Q.operatorAction({
      subscriber: S.SUBSCRIBER_NAME, eventId: badId, action: "RETRY",
      actorUserId: 42, reason: "upstream dependency restored",
    });
    expect(Q.getState(S.SUBSCRIBER_NAME, badId)).toMatchObject({ status: "pending", retryable: 1 });

    const audit = auditFor("retry");
    expect(audit.user_id).toBe(42);
    expect(JSON.parse(audit.details).reason).toBe("upstream dependency restored");

    const resumed = S.drain(NOW);
    expect(resumed.processed).toBe(2);
    expect(awardsFor(REP)).toHaveLength(2);
  });

  it("DEAD_LETTER lets the queue advance past the event WITHOUT deleting it", () => {
    const e1 = saleApproved(1);
    saleApproved(2);
    fault.nth = 1;
    S.drain(NOW);

    fault.nth = -1;
    Q.operatorAction({
      subscriber: S.SUBSCRIBER_NAME, eventId: e1.id, action: "DEAD_LETTER",
      actorUserId: 7, reason: "malformed payload from a retired importer; handled manually",
    });

    const out = S.drain(NOW);
    // The set-aside event is reported as skipped, not silently dropped…
    expect(out.skipped).toEqual([expect.objectContaining({ eventId: e1.id, status: "dead_lettered" })]);
    // …the following event is processed…
    expect(out.processed).toBe(1);
    // …and the original event row is still there to inspect and replay.
    expect(E.getEvent(T1, e1.id)).toBeTruthy();
    expect(JSON.parse(auditFor("dead_letter").details).reason).toContain("retired importer");
  });

  it("RESOLVE records the human decision and its reason", () => {
    const e1 = saleApproved(1);
    fault.nth = 1;
    S.drain(NOW);
    Q.operatorAction({
      subscriber: S.SUBSCRIBER_NAME, eventId: e1.id, action: "RESOLVE",
      actorUserId: 9, reason: "award booked by hand under ticket OPS-88",
    });
    const st = Q.getState(S.SUBSCRIBER_NAME, e1.id);
    expect(st).toMatchObject({ status: "resolved", resolved_by: 9 });
    expect(st.resolved_reason).toContain("OPS-88");
  });
});

describe("operator visibility and recovery", () => {
  it("surfaces halted events and raises an alert past the attempt threshold", () => {
    const ev = saleApproved(1);
    fault.always = true;             // fails on every attempt, like a real bug
    S.drain(NOW);
    const failedId = ev.id;

    // Drive the attempt count past the alert threshold without waiting out the
    // real backoff.
    for (let i = 0; i < Q.ALERT_ATTEMPTS; i += 1) {
      rawDb.prepare(`UPDATE event_processing_state SET next_attempt_at = NULL WHERE subscriber = ? AND event_id = ?`)
        .run(S.SUBSCRIBER_NAME, failedId);
      S.drain(NOW);
    }

    const health = Q.queueHealth(S.SUBSCRIBER_NAME, E.cursorFor(S.SUBSCRIBER_NAME), 1);
    expect(health.halted.length).toBeGreaterThan(0);
    expect(health.halted[0].attempts).toBeGreaterThanOrEqual(Q.ALERT_ATTEMPTS);
    expect(health.alerts.join(" ")).toMatch(/has failed/);
  });

  it("stops retrying itself after MAX_ATTEMPTS and waits for a human", () => {
    const ev = saleApproved(1);
    fault.always = true;
    S.drain(NOW);
    const id = ev.id;
    for (let i = 0; i < Q.MAX_ATTEMPTS + 2; i += 1) {
      rawDb.prepare(`UPDATE event_processing_state SET next_attempt_at = NULL WHERE subscriber = ? AND event_id = ?`)
        .run(S.SUBSCRIBER_NAME, id);
      S.drain(NOW);
    }
    const st = Q.getState(S.SUBSCRIBER_NAME, id);
    expect(st.status).toBe("blocked");
    expect(st.retryable).toBe(0);
    expect(st.attempts).toBeGreaterThanOrEqual(Q.MAX_ATTEMPTS);
  });

  it("the recovery report reconciles the cursor and proves no duplicate awards", () => {
    saleApproved(1);
    saleApproved(2);
    S.drain(NOW);
    const report = Q.recoveryReport(S.SUBSCRIBER_NAME, E.cursorFor(S.SUBSCRIBER_NAME));
    expect(report.cursorConsistent).toBe(true);
    expect(report.stillHolding).toEqual([]);
    expect(report.duplicateAwards).toEqual([]);
    expect(report.highestCompleted).toBe(E.cursorFor(S.SUBSCRIBER_NAME));
  });

  it("the recovery report names what is still holding the queue", () => {
    saleApproved(1);
    saleApproved(2);
    fault.nth = 1;
    S.drain(NOW);
    const report = Q.recoveryReport(S.SUBSCRIBER_NAME, E.cursorFor(S.SUBSCRIBER_NAME));
    expect(report.stillHolding.length).toBe(1);
  });
});
