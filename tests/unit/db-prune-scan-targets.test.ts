// ── Pruning the never-pruned table ───────────────────────────────────────────
//
// scan_run_targets and its three indexes were 10.13 GB of an 18.80 GB
// production database — 54% of the file — on a 38 GB disk that hit 100% and
// took out a maintenance run with SQLITE_FULL. runDbPrune had been running
// nightly the whole time and simply never covered this table; storage.ts's own
// index comment already called it "the never-pruned table".
//
// These tests run against the REAL schema, which is the point. The first draft
// keyed retention off `finished_at`; the column is `completed_at`, so the query
// threw, the catch swallowed it, and the prune would have reported success
// while freeing nothing. A test with a hand-rolled table would have passed.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

let rawDb: import("better-sqlite3").Database;
let prune: typeof import("../../server/dbPrune");

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-prune-"));
  process.env.NODE_ENV = "test";
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  prune = await import("../../server/dbPrune");
});

function seedRun(id: string, status: string, completedMsAgo: number | null, targets: number) {
  rawDb.prepare(
    `INSERT OR REPLACE INTO scan_runs (id,tenant_id,kind,label,city,state,budget,status,started_at,completed_at,created_by)
     VALUES (?,1,'city',?,'Testville','NC',100,?,?,?,1)`,
  ).run(id, id, status, iso(60 * DAY), completedMsAgo == null ? null : iso(completedMsAgo));
  const ins = rawDb.prepare(
    `INSERT OR REPLACE INTO scan_run_targets (run_id,target_id,seq,state) VALUES (?,?,?,'queued')`);
  for (let i = 0; i < targets; i++) ins.run(id, Math.abs(hash(id)) + i, i);
}
function hash(s: string): number {
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h;
}
const countFor = (runId: string) =>
  (rawDb.prepare(`SELECT COUNT(*) n FROM scan_run_targets WHERE run_id=?`).get(runId) as any).n;

beforeEach(() => {
  rawDb.prepare("DELETE FROM scan_run_targets").run();
  rawDb.prepare("DELETE FROM scan_runs").run();
});

describe("pruneFinishedRunTargets", () => {
  it("THE POINT: drops the work queue of a run that finished long ago", () => {
    seedRun("old_done", "done", 30 * DAY, 50);
    expect(countFor("old_done")).toBe(50);

    const removed = prune.pruneFinishedRunTargets(iso(14 * DAY));
    expect(removed).toBe(50);
    expect(countFor("old_done")).toBe(0);
  });

  it("keeps a RUNNING run's queue however old the run is — those rows are the run", () => {
    // A long market run legitimately carries weeks-old queued rows it is still
    // working through. Deleting them would silently truncate live work.
    seedRun("live", "running", null, 40);
    expect(prune.pruneFinishedRunTargets(iso(1 * DAY))).toBe(0);
    expect(countFor("live")).toBe(40);
  });

  it("keeps a PAUSED run's queue, so resuming next month still finds it whole", () => {
    seedRun("paused", "paused", null, 25);
    prune.pruneFinishedRunTargets(iso(0));
    expect(countFor("paused")).toBe(25);
  });

  it("keeps a recently-finished run inside the retention window", () => {
    seedRun("fresh_done", "done", 2 * DAY, 30);
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(0);
    expect(countFor("fresh_done")).toBe(30);
  });

  it("covers every terminal status, not just 'done'", () => {
    seedRun("e", "error", 30 * DAY, 10);
    seedRun("c", "cancelled", 30 * DAY, 10);
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(20);
    expect(countFor("e") + countFor("c")).toBe(0);
  });

  it("falls back to started_at when a terminal run never recorded completed_at", () => {
    // Real rows do this — an errored run can die before stamping completion.
    seedRun("no_stamp", "error", null, 15);
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(15);
  });

  it("prunes only the eligible run, leaving its neighbours untouched", () => {
    seedRun("old", "done", 30 * DAY, 20);
    seedRun("new", "done", 1 * DAY, 20);
    seedRun("live", "running", null, 20);
    prune.pruneFinishedRunTargets(iso(14 * DAY));
    expect(countFor("old")).toBe(0);
    expect(countFor("new")).toBe(20);
    expect(countFor("live")).toBe(20);
  });

  it("is a no-op on an empty history and safe to run twice", () => {
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(0);
    seedRun("old", "done", 30 * DAY, 10);
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(10);
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(0);
  });

  it("handles more runs than one IN clause can hold", () => {
    // The id list is chunked at 200; a long history must not silently prune
    // only the first chunk.
    for (let i = 0; i < 250; i++) seedRun(`r${i}`, "done", 30 * DAY, 2);
    expect(prune.pruneFinishedRunTargets(iso(14 * DAY))).toBe(500);
    expect((rawDb.prepare("SELECT COUNT(*) n FROM scan_run_targets").get() as any).n).toBe(0);
  });
});

describe("runDbPrune wiring", () => {
  it("reaches scan_run_targets, and does not throw on the real schema", () => {
    seedRun("old_done", "done", 60 * DAY, 30);
    // The whole nightly job — the wiring is what silently regressed before.
    expect(() => prune.runDbPrune()).not.toThrow();
    expect(countFor("old_done")).toBe(0);
  });

  it("leaves a pending notification_outbox row alone at any age", () => {
    // Unsent is work outstanding, not history, however long it has been stuck.
    rawDb.prepare(
      `INSERT INTO notification_outbox (tenant_id,dedupe_key,kind,status,created_at)
       VALUES (1,'stuck-forever','fresh_fiber','pending',?)`).run(iso(400 * DAY));
    rawDb.prepare(
      `INSERT INTO notification_outbox (tenant_id,dedupe_key,kind,status,created_at,sent_at)
       VALUES (1,'delivered-long-ago','fresh_fiber','sent',?,?)`).run(iso(400 * DAY), iso(400 * DAY));

    prune.runDbPrune();

    const rows = rawDb.prepare("SELECT dedupe_key FROM notification_outbox").all() as Array<{ dedupe_key: string }>;
    expect(rows.map((r) => r.dedupe_key)).toEqual(["stuck-forever"]);
  });
});

describe("prune leaves a durable record", () => {
  it("writes a row saying it ran, what it removed, and from which role", () => {
    // "Is the nightly prune running" was unanswerable for a month while the
    // database grew to 18.8 GB, because the only evidence was a log line — and
    // a log line competes with a chatty scanner for a rotating buffer, needs
    // shell access nobody has, and says nothing when the scheduler was never
    // reached at all.
    seedRun("old_done", "done", 30 * DAY, 12);
    prune.runDbPrune();

    const row = rawDb.prepare(
      "SELECT ran_at, role, total_removed, removed_json FROM db_prune_runs ORDER BY id DESC LIMIT 1",
    ).get() as any;
    expect(row).toBeTruthy();
    expect(row.ran_at).toBeTruthy();
    expect(row.total_removed).toBeGreaterThanOrEqual(12);
    expect(JSON.parse(row.removed_json).scan_run_targets).toBe(12);
  });

  it("records a run that removed nothing — silence must not look like absence", () => {
    prune.runDbPrune();
    const before = (rawDb.prepare("SELECT COUNT(*) n FROM db_prune_runs").get() as any).n;
    prune.runDbPrune();
    const after = (rawDb.prepare("SELECT COUNT(*) n FROM db_prune_runs").get() as any).n;
    expect(after).toBe(before + 1);
  });

  it("caps its own history so the record cannot become the problem", () => {
    for (let i = 0; i < 70; i++) prune.runDbPrune();
    const n = (rawDb.prepare("SELECT COUNT(*) n FROM db_prune_runs").get() as any).n;
    expect(n).toBeLessThanOrEqual(60);
  });
});

describe("isPruneDue — scheduling that survives a busy box", () => {
  beforeEach(() => { try { rawDb.prepare("DELETE FROM db_prune_runs").run(); } catch { /* not created yet */ } });

  it("is due when nothing has ever run", () => {
    expect(prune.isPruneDue()).toBe(true);
  });

  it("is NOT due immediately after a run", () => {
    prune.runDbPrune();
    expect(prune.isPruneDue()).toBe(false);
  });

  it("is due again once the window has passed", () => {
    prune.runDbPrune();
    rawDb.prepare("UPDATE db_prune_runs SET ran_at = ?").run(iso(25 * 3_600_000));
    expect(prune.isPruneDue()).toBe(true);
  });

  it("THE POINT: a missed window is still due at the next tick, not lost", () => {
    // The old scheduling was a one-shot 30-minute timer. If it did not fire —
    // saturated event loop, or a deploy restarting the container first — the
    // run was simply lost until the next 24h interval, which the next deploy
    // would also reset. A due check self-heals: nothing ran, so it is still due.
    rawDb.prepare("DELETE FROM db_prune_runs").run();
    expect(prune.isPruneDue()).toBe(true);
    expect(prune.isPruneDue()).toBe(true); // still due; checking is not running
  });

  it("treats an unparseable timestamp as due rather than skipping forever", () => {
    prune.runDbPrune();
    rawDb.prepare("UPDATE db_prune_runs SET ran_at = 'not-a-date'").run();
    expect(prune.isPruneDue()).toBe(true);
  });

  it("honours a custom window", () => {
    prune.runDbPrune();
    rawDb.prepare("UPDATE db_prune_runs SET ran_at = ?").run(iso(3 * 3_600_000));
    expect(prune.isPruneDue(20)).toBe(false);
    expect(prune.isPruneDue(1)).toBe(true);
  });
});
