import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proves the two behaviors added to the continuous, opportunity-weighted statewide
// sweep: (a) city selection is ordered by due-ness + priority (NOT alphabetically),
// and (b) a completed pass self-re-arms the next cycle, honoring the kill-switch and
// the configurable cycle pause.
let rawDb: import("better-sqlite3").Database;
let sweep: typeof import("../../server/sweepService");

let fips = 100;
function seedMarket(city: string, priorityClass: string, score: number, cadence: number, nextOffset: string, scannedOffset: string) {
  rawDb.prepare(
    `INSERT INTO state_fiber_markets
      (state,place_fips,city,legal_name,population,priority_class,priority_score,priority_reasons,cadence_hours,source_vintage,auto_scan_eligible,next_scan_at,last_scanned_at)
     VALUES ('NC',?,?,?,5000,?,?,'[]',?,'test',1,datetime('now',?),datetime('now',?))`,
  ).run(String(fips++), city, `${city} town`, priorityClass, score, cadence, nextOffset, scannedOffset);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-statewide-cadence-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  sweep = await import("../../server/sweepService");

  // Alphabetical order of these four is: Apex, Gastonia, Monroe, Zebulon.
  // Opportunity order should be roughly the REVERSE, because due-ness dominates and
  // then priority_score. Zebulon (alphabetically LAST) is due + top priority → first.
  seedMarket("Zebulon", "critical", 100, 24, "-1 day", "-10 days");   // DUE, priority 100
  seedMarket("Monroe", "medium", 65, 168, "-1 day", "-5 days");       // DUE, priority 65
  seedMarket("Gastonia", "critical", 100, 24, "+30 days", "-1 hour"); // NOT due, priority 100
  seedMarket("Apex", "low", 40, 336, "+30 days", "-2 hours");         // NOT due, priority 40
});

afterEach(() => {
  sweep.__clearReArmTimers();
  delete process.env.STATEWIDE_SCAN_ON_DEPLOY;
  delete process.env.STATEWIDE_CYCLE_PAUSE_MS;
});

describe("opportunity-weighted city ordering", () => {
  it("selects due + high-priority markets first, not alphabetically", () => {
    const cities = sweep.stateCities("NC");
    expect(cities).toEqual(["Zebulon", "Monroe", "Gastonia", "Apex"]);
    // Explicitly prove it is NOT the alphabetical ordering the old code used.
    expect(cities).not.toEqual([...cities].sort());
    // Alphabetically-last market leads because it is due + top priority.
    expect(cities[0]).toBe("Zebulon");
  });

  it("ranks a DUE lower-priority market above a NOT-due higher-priority one", () => {
    const cities = sweep.stateCities("NC");
    // Monroe is due (priority 65); Gastonia is higher priority (100) but not due.
    // Due-ness is the primary key, so Monroe must lead Gastonia.
    expect(cities.indexOf("Monroe")).toBeLessThan(cities.indexOf("Gastonia"));
    // Among the not-due tail, higher priority still wins (Gastonia 100 before Apex 40).
    expect(cities.indexOf("Gastonia")).toBeLessThan(cities.indexOf("Apex"));
  });
});

describe("self-re-arm after a completed pass", () => {
  const parent = { tenant_id: 1, state: "NC" as const, created_by: null, max_checks_per_city: null };

  it("plans a re-arm with the configured cycle pause when the kill-switch is not off", () => {
    process.env.STATEWIDE_CYCLE_PAUSE_MS = "1234";
    expect(sweep.planStateSweepReArm(process.env)).toEqual({ rearm: true, pauseMs: 1234, reason: "scheduled" });
  });

  it("falls back to the default cycle pause when unset or invalid", () => {
    expect(sweep.planStateSweepReArm({} as NodeJS.ProcessEnv).pauseMs).toBe(sweep.DEFAULT_STATEWIDE_CYCLE_PAUSE_MS);
    expect(sweep.planStateSweepReArm({ STATEWIDE_CYCLE_PAUSE_MS: "nonsense" } as NodeJS.ProcessEnv).pauseMs)
      .toBe(sweep.DEFAULT_STATEWIDE_CYCLE_PAUSE_MS);
  });

  it("schedules and fires the next cycle after the pause elapses", () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn();
      process.env.STATEWIDE_CYCLE_PAUSE_MS = "50000";
      const plan = sweep.scheduleStateSweepReArm(parent, start);
      expect(plan.rearm).toBe(true);
      expect(start).not.toHaveBeenCalled();            // paused, not immediate
      vi.advanceTimersByTime(49_999);
      expect(start).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(start).toHaveBeenCalledTimes(1);          // exactly one next cycle
      expect(start).toHaveBeenCalledWith({ tenantId: 1, state: "NC", createdBy: null, maxChecksPerCity: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("only queues one cycle per (tenant,state) even if a pass completes twice", () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn();
      process.env.STATEWIDE_CYCLE_PAUSE_MS = "50000";
      sweep.scheduleStateSweepReArm(parent, start);
      sweep.scheduleStateSweepReArm(parent, start); // duplicate completion → must NOT stack
      vi.advanceTimersByTime(50_000);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-arm when the kill-switch STATEWIDE_SCAN_ON_DEPLOY=off", () => {
    vi.useFakeTimers();
    try {
      const start = vi.fn();
      process.env.STATEWIDE_SCAN_ON_DEPLOY = "off";
      const plan = sweep.scheduleStateSweepReArm({ tenant_id: 2, state: "SC", created_by: null, max_checks_per_city: null }, start);
      expect(plan).toMatchObject({ rearm: false, reason: "kill_switch_off" });
      vi.advanceTimersByTime(60 * 60_000);
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
