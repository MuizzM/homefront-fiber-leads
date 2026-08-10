/**
 * Retention — precise location does not accumulate.
 *
 * The table this feature builds on had no retention at all: its own comment in
 * server/storage.ts recorded the row count "climbing" with no ceiling. A live
 * dashboard raises the write rate, so the deletion path is part of the feature
 * rather than a follow-up.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: any;
let storage: any;
let prune: typeof import("../../server/dbPrune");
let liveStore: typeof import("../../server/liveOpsStore");

const TENANT_KEEPS_LONGER = 4101;
const TENANT_KEEPS_SHORT = 4102;
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-10T12:00:00.000Z");

/** A ping at a chosen age, written straight to the table. */
function seedPing(tenantId: number | null, repId: number, ageDays: number) {
  const at = new Date(NOW - ageDays * DAY).toISOString();
  rawDb.prepare(
    `INSERT INTO location_pings (rep_id, user_id, tenant_id, lat, lng, accuracy, ping_at, captured_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(repId, 1, tenantId, 35.5, -80.4, 10, at, at);
}

const countFor = (tenantId: number | null) =>
  rawDb.prepare(
    tenantId == null
      ? `SELECT COUNT(*) AS n FROM location_pings WHERE tenant_id IS NULL`
      : `SELECT COUNT(*) AS n FROM location_pings WHERE tenant_id = ${tenantId}`,
  ).get().n as number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-liveops-retention-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  prune = await import("../../server/dbPrune");
  liveStore = await import("../../server/liveOpsStore");
});

afterAll(() => { /* temp dir is disposable */ });

describe("precise location ages out", () => {
  beforeAll(() => {
    liveStore.setFieldLocationPolicy(TENANT_KEEPS_SHORT, { retentionDays: 2 }, null);
    liveStore.setFieldLocationPolicy(TENANT_KEEPS_LONGER, { retentionDays: 7 }, null);

    for (const age of [0, 1, 3, 5, 9]) seedPing(TENANT_KEEPS_SHORT, 501, age);
    for (const age of [0, 1, 3, 5, 9]) seedPing(TENANT_KEEPS_LONGER, 502, age);
    for (const age of [0, 9]) seedPing(null, 503, age);
  });

  it("deletes points past each org's OWN window, not one global one", () => {
    expect(countFor(TENANT_KEEPS_SHORT)).toBe(5);
    expect(countFor(TENANT_KEEPS_LONGER)).toBe(5);

    prune.pruneLocationPings(NOW);

    // 2-day org keeps ages 0 and 1. 7-day org keeps 0, 1, 3 and 5.
    expect(countFor(TENANT_KEEPS_SHORT)).toBe(2);
    expect(countFor(TENANT_KEEPS_LONGER)).toBe(4);
  });

  it("sweeps rows that predate the tenant column on the tightest window", () => {
    // Nobody's policy covers them, so they must not get an indefinite stay.
    expect(countFor(null)).toBe(1);
  });

  it("is a hard delete, not an anonymisation", () => {
    // A trail with the name stripped off is still a trail - the route itself
    // identifies whoever walked it. There must be no orphaned coordinates left.
    const orphans = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM location_pings
        WHERE CAST(strftime('%s', COALESCE(captured_at, ping_at)) AS INTEGER) < ?`,
    ).get(Math.floor((NOW - 7 * DAY) / 1000)).n;
    expect(orphans).toBe(0);
  });

  it("caps an org that tries to keep location forever", () => {
    // Retention is configurable BELOW the system ceiling, never above it.
    const policy = liveStore.setFieldLocationPolicy(TENANT_KEEPS_SHORT, { retentionDays: 100000 }, null);
    expect(policy.retentionDays).toBeLessThanOrEqual(90);

    seedPing(TENANT_KEEPS_SHORT, 501, 60);
    prune.pruneLocationPings(NOW);
    const survivors = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM location_pings
        WHERE tenant_id = ? AND CAST(strftime('%s', COALESCE(captured_at, ping_at)) AS INTEGER) < ?`,
    ).get(TENANT_KEEPS_SHORT, Math.floor((NOW - 8 * DAY) / 1000)).n;
    expect(survivors).toBe(0);
  });

  it("leaves today's points alone", () => {
    seedPing(TENANT_KEEPS_LONGER, 502, 0);
    const before = countFor(TENANT_KEEPS_LONGER);
    prune.pruneLocationPings(NOW);
    expect(countFor(TENANT_KEEPS_LONGER)).toBe(before);
  });

  it("reports what it removed, so 'is retention running' is answerable", () => {
    seedPing(TENANT_KEEPS_LONGER, 502, 30);
    const removed = prune.pruneLocationPings(NOW);
    expect(removed).toBeGreaterThan(0);
  });
});
