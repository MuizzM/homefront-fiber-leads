// The two key derivations are the whole idempotency story, so they get the
// bulk of the coverage: an emission key that collapses retries of a once-ever
// fact, and a reward key that lets ONE event pay SEVERAL people exactly once
// each.
import { describe, expect, it } from "vitest";
import {
  DOMAIN_EVENT_TYPES, eventDedupeKey, isDomainEventType, isRepeatableEvent,
  rewardKey, isRewardKey, validateEventInput, canReward, isReversal, isIsoInstant,
} from "@shared/domainEvents";

const AT = "2026-08-06T17:02:00.000Z";

describe("event taxonomy", () => {
  it("covers every event type the spec names", () => {
    for (const t of [
      "SALE_APPROVED", "SALE_CANCELLED", "TRAINING_COMPLETED", "TRAINING_PASSED",
      "MILEAGE_SUBMITTED", "MILEAGE_APPROVED", "REFERRAL_CREATED", "REFERRAL_REP_HIRED",
      "REFERRAL_REP_ACTIVATED", "REFERRAL_THRESHOLD_REACHED", "PAYOUT_APPROVED",
    ]) {
      expect(DOMAIN_EVENT_TYPES).toContain(t);
      expect(isDomainEventType(t)).toBe(true);
    }
  });

  it("fails closed on an unknown type", () => {
    expect(isDomainEventType("SALE_MAYBE")).toBe(false);
    expect(isDomainEventType(undefined)).toBe(false);
  });

  it("separates rewarding from reversing events", () => {
    expect(canReward("SALE_APPROVED")).toBe(true);
    expect(canReward("SALE_CANCELLED")).toBe(false);
    expect(isReversal("SALE_CANCELLED")).toBe(true);
    // Opening a course is not an event at all, but completing one is — and
    // completion is what may pay. This is the spec's "do not reward a rep
    // merely for opening a course" expressed in the taxonomy.
    expect(canReward("TRAINING_COMPLETED")).toBe(true);
  });
});

describe("eventDedupeKey", () => {
  it("collapses a retried once-ever fact to one key", () => {
    const a = eventDedupeKey({ type: "SALE_APPROVED", subjectType: "sale", subjectId: 42 });
    const b = eventDedupeKey({ type: "SALE_APPROVED", subjectType: "sale", subjectId: 42 });
    expect(a).toBe(b);
  });

  it("keeps different subjects and different types apart", () => {
    const sale42 = eventDedupeKey({ type: "SALE_APPROVED", subjectType: "sale", subjectId: 42 });
    const sale43 = eventDedupeKey({ type: "SALE_APPROVED", subjectType: "sale", subjectId: 43 });
    const cancel42 = eventDedupeKey({ type: "SALE_CANCELLED", subjectType: "sale", subjectId: 42 });
    expect(new Set([sale42, sale43, cancel42]).size).toBe(3);
  });

  it("REFUSES to invent a key for a repeatable fact", () => {
    // A trip submitted, rejected, then submitted again is two real facts. A
    // derived key would swallow the second, which is a trip nobody pays.
    expect(isRepeatableEvent("MILEAGE_SUBMITTED")).toBe(true);
    expect(() => eventDedupeKey({ type: "MILEAGE_SUBMITTED", subjectType: "mileage_trip", subjectId: 7 }))
      .toThrow(/EVENT_DEDUPE_KEY_REQUIRED/);
  });

  it("honours an explicit key for a repeatable fact", () => {
    const k = eventDedupeKey({
      type: "MILEAGE_SUBMITTED", subjectType: "mileage_trip", subjectId: 7,
      dedupeKey: "MILEAGE_SUBMITTED:trip:7:attempt:2",
    });
    expect(k).toBe("MILEAGE_SUBMITTED:trip:7:attempt:2");
  });
});

describe("rewardKey", () => {
  it("is stable for the same campaign/event/recipient", () => {
    expect(rewardKey(3, 900, 12)).toBe(rewardKey(3, 900, 12));
  });

  it("lets ONE event pay several recipients - the referral and override case", () => {
    // The event is about the referred rep; the money goes to the referrer. If
    // the key ignored the recipient, only the first beneficiary would ever be
    // paid.
    const toReferrer = rewardKey(3, 900, 12);
    const toManager = rewardKey(3, 900, 44);
    expect(toReferrer).not.toBe(toManager);
  });

  it("separates two campaigns reacting to the same event", () => {
    expect(rewardKey(3, 900, 12)).not.toBe(rewardKey(4, 900, 12));
  });

  it("is recognisable in the existing spiff ledger", () => {
    expect(isRewardKey(rewardKey(1, 2, 3))).toBe(true);
    // Legacy inline awards must NOT be mistaken for engine awards.
    expect(isRewardKey("ramp-complete:rep:12")).toBe(false);
    expect(isRewardKey("knock:1234")).toBe(false);
    expect(isRewardKey(null)).toBe(false);
  });
});

describe("validateEventInput", () => {
  const valid = {
    tenantId: 1, type: "SALE_APPROVED" as const, subjectType: "sale" as const,
    subjectId: 42, occurredAt: AT,
  };

  it("accepts a well-formed event", () => {
    expect(validateEventInput(valid)).toEqual([]);
  });

  it("requires a real tenant - an org-less event has no isolation", () => {
    expect(validateEventInput({ ...valid, tenantId: 0 }).join()).toMatch(/tenantId/);
    expect(validateEventInput({ ...valid, tenantId: -1 }).join()).toMatch(/tenantId/);
  });

  it("rejects a timestamp that is not the codebase's one ISO shape", () => {
    // A SQLite-format timestamp sorts before every ISO one, which is exactly
    // the class of bug shared/sqlTime.ts documents.
    expect(validateEventInput({ ...valid, occurredAt: "2026-08-06 17:02:00" }).join()).toMatch(/occurredAt/);
    expect(isIsoInstant("2026-08-06 17:02:00")).toBe(false);
    expect(isIsoInstant(AT)).toBe(true);
  });

  it("rejects an unknown type and an unknown subject", () => {
    expect(validateEventInput({ ...valid, type: "NOPE" as any }).join()).toMatch(/type/);
    expect(validateEventInput({ ...valid, subjectType: "invoice" as any }).join()).toMatch(/subjectType/);
  });

  it("demands an explicit dedupe key for repeatable events", () => {
    expect(validateEventInput({
      ...valid, type: "MILEAGE_SUBMITTED", subjectType: "mileage_trip", subjectId: 7,
    }).join()).toMatch(/dedupeKey/);
  });
});
