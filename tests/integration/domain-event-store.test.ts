import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * domainEventStore against a real temp DB. Three properties matter and nothing
 * else does:
 *
 *   1. the log is APPEND-ONLY at the database level (triggers, not diligence),
 *   2. a retried emission collapses AND still hands the caller an event id,
 *   3. a subscriber cursor resumes, never rewinds, and can be replayed.
 */
let S: typeof import("../../server/domainEventStore");
let rawDb: import("better-sqlite3").Database;

const AT = "2026-08-06T17:02:00.000Z";
const NOW = "2026-08-06T17:02:01.000Z";

const sale = (id: number, tenantId = 1) => ({
  tenantId, type: "SALE_APPROVED" as const, subjectType: "sale" as const,
  subjectId: id, subjectRepId: 10, occurredAt: AT,
});

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-events-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  S = await import("../../server/domainEventStore");
});

beforeEach(() => {
  // The append-only triggers refuse DELETE, so a fresh table is the only way to
  // reset — which is itself a check that the triggers are installed.
  rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_delete");
  rawDb.prepare("DELETE FROM domain_events").run();
  rawDb.prepare("DELETE FROM event_subscriptions").run();
  S.ensureDomainEventSchema();
});

describe("append-only enforcement", () => {
  it("the database refuses UPDATE and DELETE on a recorded event", () => {
    const e = S.emit(sale(42), NOW);
    expect(() => rawDb.prepare("UPDATE domain_events SET type = 'SALE_CANCELLED' WHERE id = ?").run(e.id))
      .toThrow(/append-only/);
    expect(() => rawDb.prepare("DELETE FROM domain_events WHERE id = ?").run(e.id))
      .toThrow(/append-only/);
  });
});

describe("emit", () => {
  it("records the fact, the observation, and the derived key", () => {
    const e = S.emit(sale(42), NOW);
    expect(e.id).toBeGreaterThan(0);
    expect(e.type).toBe("SALE_APPROVED");
    expect(e.subjectRepId).toBe(10);
    // occurred_at is when it happened; recorded_at is when we learned it. They
    // differ for anything that syncs from the field, so both are kept.
    expect(e.occurredAt).toBe(AT);
    expect(e.recordedAt).toBe(NOW);
    expect(e.dedupeKey).toBe("SALE_APPROVED:sale:42");
  });

  it("a retry collapses to ONE row and still returns the event id", () => {
    const first = S.emit(sale(42), NOW);
    const retry = S.emit(sale(42), "2026-08-06T18:00:00.000Z");
    // Same row — not a second event, and not a null the caller would have to
    // handle. A retry that returned nothing is a reward that never gets
    // attributed.
    expect(retry.id).toBe(first.id);
    expect(retry.recordedAt).toBe(NOW); // the original observation stands
    const n = rawDb.prepare("SELECT COUNT(*) c FROM domain_events").get() as any;
    expect(n.c).toBe(1);
  });

  it("scopes the dedupe key per tenant - two orgs may both have a sale 42", () => {
    S.emit(sale(42, 1), NOW);
    S.emit(sale(42, 2), NOW);
    const n = rawDb.prepare("SELECT COUNT(*) c FROM domain_events").get() as any;
    expect(n.c).toBe(2);
  });

  it("keeps repeatable facts distinct when the caller supplies a key", () => {
    const trip = (attempt: number) => ({
      tenantId: 1, type: "MILEAGE_SUBMITTED" as const, subjectType: "mileage_trip" as const,
      subjectId: 7, subjectRepId: 10, occurredAt: AT,
      dedupeKey: `MILEAGE_SUBMITTED:trip:7:attempt:${attempt}`,
    });
    S.emit(trip(1), NOW);
    S.emit(trip(2), NOW);
    const n = rawDb.prepare("SELECT COUNT(*) c FROM domain_events").get() as any;
    expect(n.c).toBe(2);
  });

  it("rejects a malformed event instead of storing it", () => {
    expect(() => S.emit({ ...sale(42), occurredAt: "2026-08-06 17:02:00" }, NOW)).toThrow(/INVALID_EVENT/);
    expect(() => S.emit({ ...sale(42), tenantId: 0 }, NOW)).toThrow(/INVALID_EVENT/);
  });

  it("survives a payload that is not valid JSON on read-back", () => {
    const e = S.emit({ ...sale(42), payload: { miles: 12.5 } }, NOW);
    expect(S.getEvent(1, e.id)?.payload).toEqual({ miles: 12.5 });
    // A corrupt payload must not break the subscriber that reads the event —
    // identity and type are what drive money.
    rawDb.exec("DROP TRIGGER IF EXISTS domain_events_no_update");
    rawDb.prepare("UPDATE domain_events SET payload = '{not json' WHERE id = ?").run(e.id);
    expect(S.getEvent(1, e.id)?.payload).toBeNull();
    S.ensureDomainEventSchema();
  });

  it("does not leak across tenants on read", () => {
    const e = S.emit(sale(42, 2), NOW);
    expect(S.getEvent(1, e.id)).toBeNull();
    expect(S.getEvent(2, e.id)?.id).toBe(e.id);
  });
});

describe("subject history", () => {
  it("returns everything that happened to one subject, oldest first", () => {
    S.emit(sale(42), NOW);
    S.emit({
      tenantId: 1, type: "SALE_CANCELLED", subjectType: "sale", subjectId: 42,
      subjectRepId: 10, occurredAt: "2026-08-07T09:00:00.000Z",
    }, "2026-08-07T09:00:01.000Z");
    const history = S.eventsForSubject(1, "sale", 42);
    expect(history.map(e => e.type)).toEqual(["SALE_APPROVED", "SALE_CANCELLED"]);
  });
});

describe("subscriptions", () => {
  it("delivers in id order and resumes from the cursor", () => {
    const a = S.emit(sale(1), NOW);
    const b = S.emit(sale(2), NOW);
    const c = S.emit(sale(3), NOW);

    const batch1 = S.nextBatch("incentives", 2);
    expect(batch1.map(e => e.id)).toEqual([a.id, b.id]);

    S.advanceCursor("incentives", b.id, NOW);
    const batch2 = S.nextBatch("incentives", 2);
    expect(batch2.map(e => e.id)).toEqual([c.id]);

    S.advanceCursor("incentives", c.id, NOW);
    expect(S.nextBatch("incentives")).toEqual([]);
  });

  it("never rewinds on a stale advance", () => {
    const a = S.emit(sale(1), NOW);
    const b = S.emit(sale(2), NOW);
    S.advanceCursor("incentives", b.id, NOW);
    // A slower worker reporting an older high-water mark must not re-deliver
    // events a faster one already processed.
    S.advanceCursor("incentives", a.id, NOW);
    expect(S.cursorFor("incentives")).toBe(b.id);
  });

  it("can be reset to replay history - the 'we should have been paying' fix", () => {
    const a = S.emit(sale(1), NOW);
    S.emit(sale(2), NOW);
    S.advanceCursor("incentives", 999, NOW);
    expect(S.nextBatch("incentives")).toEqual([]);

    S.resetCursor("incentives", 0, NOW);
    expect(S.nextBatch("incentives").map(e => e.id)[0]).toBe(a.id);
  });

  it("reports backlog depth for the ops page", () => {
    // Ids come from the emitted rows, never assumed to start at 1: the table is
    // AUTOINCREMENT and the sequence survives the DELETE between tests.
    const a = S.emit(sale(1), NOW);
    S.emit(sale(2), NOW);
    expect(S.backlogFor("incentives")).toBe(2);
    S.advanceCursor("incentives", a.id, NOW);
    expect(S.backlogFor("incentives")).toBe(1);
  });

  it("an unknown subscriber starts at zero rather than throwing", () => {
    expect(S.cursorFor("never-seen")).toBe(0);
  });
});
