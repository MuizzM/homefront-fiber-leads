import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE 30-DAY LEAD CLIFF.
 *
 * The lead projector reads exactly one row per door - the latest CONCLUSIVE
 * availability_snapshot - and publishes nothing without it. That table was
 * pruned at 30 days while fiber_checks, the evidence it is derived from, is
 * kept forever on purpose. So a door scanned in July stopped being publishable
 * in August with its provider body still on disk.
 *
 * Measured on a production-shaped copy: 3,214 kinetic targets carry a
 * lifecycle_state (only ever written on a successful snapshot insert) and have
 * no snapshot left.
 */
let rawDb: import("better-sqlite3").Database;
let prune: typeof import("../../server/dbPrune");
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-22T12:00:00.000Z");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-snapretain-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  prune = await import("../../server/dbPrune");
});

const target = (id: number) => {
  rawDb.prepare(`INSERT INTO scan_targets (id, tenant_id, address, city, state, zip, source)
    VALUES (?,?,?,?,?,?,?)`).run(id, 1, `${id} Retention Rd`, "Rockwell", "NC", "28138", "test");
  return id;
};
let snapSeq = 0;
const snap = (targetId: number, agoDays: number, conclusive: 0 | 1) => {
  const epoch = NOW - agoDays * DAY;
  rawDb.prepare(`INSERT INTO availability_snapshots
    (tenant_id, scan_target_id, run_id, checked_at, conclusive, fiber_available, transition_status,
     evidence_hash, checked_at_epoch)
    VALUES (1,?,?,?,?,1,'none',?,?)`)
    .run(targetId, `r${++snapSeq}`, new Date(epoch).toISOString(), conclusive, `h${snapSeq}`, epoch);
  return snapSeq;
};
const idsFor = (t: number) => rawDb.prepare(
  `SELECT conclusive, checked_at_epoch e FROM availability_snapshots WHERE scan_target_id=? ORDER BY e`).all(t) as any[];

describe("snapshot retention keeps the row a lead depends on", () => {
  it("never deletes a door's latest conclusive snapshot, however old", () => {
    const t = target(9001);
    snap(t, 200, 1); // the ONLY conclusive answer this door ever got, in February
    prune.pruneSnapshotsKeepingLatestConclusive(NOW - 30 * DAY);
    const left = idsFor(t);
    expect(left, "the projector's one input survives").toHaveLength(1);
    expect(left[0].conclusive).toBe(1);
    expect(left[0].e).toBe(NOW - 200 * DAY);
  });

  it("still prunes superseded history for the same door", () => {
    const t = target(9002);
    snap(t, 300, 1); // older conclusive - superseded, may go
    snap(t, 250, 1); // the latest conclusive - must stay
    snap(t, 280, 0); // an inconclusive attempt - may go
    prune.pruneSnapshotsKeepingLatestConclusive(NOW - 30 * DAY);
    const left = idsFor(t);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ conclusive: 1, e: NOW - 250 * DAY });
  });

  it("prunes a door whose only snapshots are inconclusive", () => {
    const t = target(9003);
    snap(t, 90, 0);
    snap(t, 80, 0);
    prune.pruneSnapshotsKeepingLatestConclusive(NOW - 30 * DAY);
    expect(idsFor(t), "nothing here can publish a lead").toHaveLength(0);
  });

  it("leaves everything inside the retention window alone", () => {
    const t = target(9004);
    snap(t, 10, 1);
    snap(t, 5, 0);
    snap(t, 2, 1);
    prune.pruneSnapshotsKeepingLatestConclusive(NOW - 30 * DAY);
    expect(idsFor(t)).toHaveLength(3);
  });

  it("is idempotent and does not touch other doors", () => {
    const a = target(9005), b = target(9006);
    snap(a, 400, 1); snap(b, 400, 1); snap(b, 350, 0);
    prune.pruneSnapshotsKeepingLatestConclusive(NOW - 30 * DAY);
    const first = [idsFor(a).length, idsFor(b).length];
    prune.pruneSnapshotsKeepingLatestConclusive(NOW - 30 * DAY);
    expect([idsFor(a).length, idsFor(b).length]).toEqual(first);
    expect(first).toEqual([1, 1]);
  });
});
