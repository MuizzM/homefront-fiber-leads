import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MEASURED (prod 2026-07-24): 251,033 targets enqueued/hour against 2,863
// completed checks — 88x oversubscription, 9.3M accumulated 'skipped' rows.
// Each excess row costs an INSERT + a claim/skip UPDATE on the single writer.
// Dispatch is now sized to proven provider throughput.

let rawDb: import("better-sqlite3").Database;
let yieldEngine: typeof import("../../server/yieldEngine");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-throughput-"));
  process.env.FRESH_HARVEST_INTERVAL_MIN = "60"; // 1 cycle/hour — capacity == hourly checks x oversubscribe
  process.env.YIELD_OVERSUBSCRIBE = "2";
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  yieldEngine = await import("../../server/yieldEngine");
  // Inventory far larger than any sane dispatch.
  const ins = rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, created_at)
     VALUES (?, 'Concord', 'NC', '28025', ?, -80.58, ?, 'osm', datetime('now','-30 days'))`);
  const tx = rawDb.transaction(() => {
    for (let i = 0; i < 4000; i++) ins.run(`${i + 1} Backlog Ave`, 35.4 + i / 1e5, TENANT);
  });
  tx();
});

function seedChecks(n: number): void {
  // snapshots require a real target FK — reuse the seeded backlog rows.
  const targetIds = (rawDb.prepare(`SELECT id FROM scan_targets LIMIT ?`).all(n) as any[]).map((r) => r.id);
  const ins = rawDb.prepare(
    `INSERT INTO availability_snapshots (tenant_id, scan_target_id, run_id, checked_at, checked_at_epoch,
       conclusive, fiber_available, fiber_status, transition_status, fresh, api_source, evidence_hash)
     VALUES (?, ?, ?, datetime('now'), ?, 1, 0, 'no_service', 'baseline_unavailable', 0, 'test', ?)`);
  const tx = rawDb.transaction(() => {
    targetIds.forEach((id, i) => ins.run(TENANT, id, `r-tp-${i}`, Date.now() - 60_000, `h-tp-${Date.now()}-${i}`));
  });
  tx();
}

describe("throughput-matched dispatch", () => {
  it("caps a huge configured budget to proven recent throughput", () => {
    // Above the spiral floor so the cap is what is actually being tested:
    // capacity = max(lastHour, 24h avg, MIN_ASSUMED_HOURLY_CHECKS) x 2
    //          = 3,500 x 2 = 7,000 for a 1-cycle-per-hour cadence.
    seedChecks(3500);
    const res = yieldEngine.runYieldCycle(TENANT, 50_000);
    const total = res.exploit + res.explore + (res.discovery ?? 0);
    expect(total).toBeLessThanOrEqual(7000);
    expect(total).toBeGreaterThan(0); // still dispatches real work
  });

  it("a collapsed hour does NOT strangle dispatch (the production spiral)", () => {
    // Live incident: checkedLastHour=34 drove the cap to 500, throughput fell
    // 3,376/hr → 43/hr and could not recover. The floor must hold dispatch up.
    const res = yieldEngine.runYieldCycle(TENANT, 50_000);
    const total = res.exploit + res.explore + (res.discovery ?? 0);
    expect(total).toBeGreaterThan(600); // never collapses to the old 500-ish cap
  });

  // The cold-start guarantee - zero completed checks must not freeze dispatch -
  // is asserted in tests/unit/throughput-spiral.test.ts against the real
  // provenHourlyCapacity(0, 0). It used to be restated here as
  // `expect(Math.max(500, Math.round((0 * 2) / 1))).toBe(500)`, which is
  // arithmetic: it passes no matter what the engine does, so it could not fail
  // and was not coverage. The module-reload trick it used to force a cold DB
  // did not work either - better-sqlite3's handle is already open by then, and
  // the import fell back to the same instance.

  it("the kill-switch restores the configured budget", () => {
    process.env.YIELD_THROUGHPUT_MATCH = "off";
    try {
      const res = yieldEngine.runYieldCycle(TENANT, 3000);
      const total = res.exploit + res.explore + (res.discovery ?? 0);
      expect(total).toBeGreaterThan(600); // uncapped path takes the full budget
    } finally {
      delete process.env.YIELD_THROUGHPUT_MATCH;
    }
  });
});
