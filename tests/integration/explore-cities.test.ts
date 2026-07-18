import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let explore: typeof import("../../server/exploreCities");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-explore-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  explore = await import("../../server/exploreCities");
});

const fakeStart = () => {
  const calls: any[] = [];
  const start = ((input: any) => {
    calls.push(input);
    const id = `sweep_test_${calls.length}`;
    rawDb.prepare(
      `INSERT INTO sweep_jobs (id,tenant_id,kind,query,city,state,max_checks,phase,status,heartbeat_at)
       VALUES (?,?,?,?,?,?,?,'queued','running',datetime('now'))`,
    ).run(id, input.tenantId, "city", `${input.city}, ${input.state}`, input.city, input.state, input.maxChecks);
    return { id };
  }) as any;
  return { start, calls };
};

beforeEach(() => {
  rawDb.prepare(`DELETE FROM sweep_jobs`).run();
});

describe("parseExploreSpec", () => {
  it("parses cities, defaults state to NC, dedups, drops invalid states", () => {
    expect(explore.parseExploreSpec("durham:nc, Chapel Hill , durham:NC, atlanta:ga, oxford:sc")).toEqual([
      { city: "durham", state: "NC" },
      { city: "chapel hill", state: "NC" },
      { city: "oxford", state: "SC" },
    ]);
    expect(explore.parseExploreSpec("")).toEqual([]);
    expect(explore.parseExploreSpec(undefined)).toEqual([]);
  });
});

describe("runExploreBurst", () => {
  it("starts bounded sweeps for listed cities with the configured check cap", () => {
    const { start, calls } = fakeStart();
    const decisions = explore.runExploreBurst(
      { EXPLORE_CITIES: "durham:nc,roxboro:nc", EXPLORE_MAX_CHECKS: "900" } as any,
      start,
      TENANT,
    );
    expect(decisions.map((d) => d.action)).toEqual(["started", "started"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ tenantId: TENANT, city: "durham", state: "NC", maxChecks: 900 });
  });

  it("is idempotent: skips running and recent sweeps, re-arms after the repeat window", () => {
    const { start, calls } = fakeStart();
    const env = { EXPLORE_CITIES: "durham:nc" } as any;
    explore.runExploreBurst(env, start, TENANT);
    // Second tick while the first sweep is still running → skipped.
    expect(explore.runExploreBurst(env, start, TENANT)[0].action).toBe("skipped_running");
    // Completed recently → still skipped.
    rawDb.prepare(`UPDATE sweep_jobs SET status='done'`).run();
    expect(explore.runExploreBurst(env, start, TENANT)[0].action).toBe("skipped_recent");
    // Outside the repeat window → starts again.
    rawDb.prepare(`UPDATE sweep_jobs SET started_at=datetime('now','-200 hours')`).run();
    expect(explore.runExploreBurst(env, start, TENANT)[0].action).toBe("started");
    expect(calls).toHaveLength(2);
  });

  it("caps starts per tick and walks the remainder on the next tick", () => {
    const { start, calls } = fakeStart();
    const env = { EXPLORE_CITIES: "durham:nc,roxboro:nc,oxford:nc,creedmoor:nc", EXPLORE_STARTS_PER_TICK: "2" } as any;
    const first = explore.runExploreBurst(env, start, TENANT);
    expect(first.map((d) => d.action)).toEqual(["started", "started", "deferred_tick_cap", "deferred_tick_cap"]);
    const second = explore.runExploreBurst(env, start, TENANT);
    expect(second.map((d) => d.action)).toEqual(["skipped_running", "skipped_running", "started", "started"]);
    expect(calls.map((c) => c.city)).toEqual(["durham", "roxboro", "oxford", "creedmoor"]);
  });

  it("does nothing without a tenant or with an empty spec", () => {
    const { start, calls } = fakeStart();
    expect(explore.runExploreBurst({ EXPLORE_CITIES: "durham:nc" } as any, start, null)).toEqual([]);
    expect(explore.runExploreBurst({ EXPLORE_CITIES: "" } as any, start, TENANT)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("runPriorityCityBurst", () => {
  const insertTarget = (city: string, lastScanned: string | null) =>
    rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, tenant_id, last_scanned_at, source)
       VALUES (?,?,?,?,?,?, 'test')`,
    ).run(`${Math.random().toString(36).slice(2)} Main St`, city, "NC", "27505", TENANT, lastScanned);

  const fakeRun = () => {
    const calls: any[] = [];
    const start = ((opts: any) => {
      calls.push(opts);
      const id = `run_test_${calls.length}`;
      rawDb.prepare(
        `INSERT INTO scan_runs (id, tenant_id, kind, label, city, state, budget, status, heartbeat_at)
         VALUES (?,?,?,?,?,?,?, 'running', datetime('now'))`,
      ).run(id, opts.tenantId, opts.runKind, opts.label, opts.city, opts.state, opts.targetIds.length);
      return { runId: id, queued: opts.targetIds.length } as any;
    }) as any;
    return { start, calls };
  };

  beforeEach(() => {
    rawDb.prepare(`DELETE FROM scan_runs WHERE label LIKE 'PRIORITY-CITY:%'`).run();
    rawDb.prepare(`DELETE FROM scan_targets WHERE source='test'`).run();
  });

  it("starts a DISCOVERY run over stale/unchecked targets and skips cities with none", () => {
    insertTarget("Broadway", null);
    insertTarget("Broadway", "2020-01-01 00:00:00");
    insertTarget("Sanford", new Date().toISOString().slice(0, 19).replace("T", " ")); // fresh → excluded
    const { start, calls } = fakeRun();
    const decisions = explore.runPriorityCityBurst({ PRIORITY_CITIES: "broadway:nc,sanford:nc,olivia:nc" } as any, start, TENANT);
    expect(decisions).toEqual([
      expect.objectContaining({ city: "broadway", action: "started", queued: 2 }),
      expect.objectContaining({ city: "sanford", action: "no_stale_targets" }),
      expect.objectContaining({ city: "olivia", action: "no_stale_targets" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ city: "broadway", runKind: "discovery", label: "PRIORITY-CITY: broadway NC" });
  });

  it("is idempotent within the 4h label-guard window", () => {
    insertTarget("Broadway", null);
    const { start, calls } = fakeRun();
    const env = { PRIORITY_CITIES: "broadway:nc" } as any;
    expect(explore.runPriorityCityBurst(env, start, TENANT)[0].action).toBe("started");
    expect(explore.runPriorityCityBurst(env, start, TENANT)).toEqual([]);
    expect(calls).toHaveLength(1);
    // Outside the window → re-fires.
    rawDb.prepare(`UPDATE scan_runs SET heartbeat_at=datetime('now','-5 hours') WHERE label LIKE 'PRIORITY-CITY:%'`).run();
    expect(explore.runPriorityCityBurst(env, start, TENANT)[0].action).toBe("started");
    expect(calls).toHaveLength(2);
  });
});
