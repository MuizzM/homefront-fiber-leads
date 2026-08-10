// Two idle backoffs that could never engage, one on each side of the wire.
//
// Both are the same bug in different clothes: a counter was reset or incremented
// on something that is not evidence of progress, so the "we are idle, slow down"
// branch was unreachable. Together they are the write pressure and the request
// pressure measured in production on 2026-08-10:
//
//   WAL 69.6 MB -> 3.4 GB in 23 minutes (~150 MB/min), PSI io full avg60 42.7%
//   GET /api/discovery/jobs/:uuid  588 calls in 15 min (one per 1.5s),
//                                  199,576 ms total = ~23% of all server time
//
// Neither shows up in a normal test run: the code is correct, it is just never
// idle. These pin the accounting.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("server: enqueueRunTargets reports rows it actually inserted", () => {
  let store: typeof import("../../server/scanIntelStore");
  let rawDb: import("better-sqlite3").Database;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-enqueue-"));
    process.env.NODE_ENV = "test";
    const mod = await import("../../server/storage");
    mod.runMigrations();
    ({ rawDb } = await import("../../server/db"));
    store = await import("../../server/scanIntelStore");
    rawDb.prepare(
      `INSERT INTO scan_runs (id, tenant_id, kind, label, city, state, budget, verified,
                              new_fiber, newly_live, failed, status, est_bytes, started_at)
       VALUES ('run_a',1,'city','t','Lexington','NC',10,0,0,0,0,'running',0,datetime('now'))`,
    ).run();
  });

  it("returns 0 for an empty batch - the caller must not count it as work", () => {
    expect(store.enqueueRunTargets("run_a", [])).toBe(0);
  });

  it("returns the inserted count on a fresh batch", () => {
    expect(store.enqueueRunTargets("run_a", [
      { id: 9001, seq: 0 }, { id: 9002, seq: 1 }, { id: 9003, seq: 2 },
    ])).toBe(3);
  });

  it("returns 0 when every row is a duplicate - the case that pinned the reconciler", () => {
    // INSERT OR IGNORE swallows these. Before the fix the caller added
    // batch.length regardless, so `work` was permanently non-zero, the idle
    // branch was unreachable, and the discovery reconciler ran every second
    // against the same jobs forever.
    const again = store.enqueueRunTargets("run_a", [
      { id: 9001, seq: 0 }, { id: 9002, seq: 1 }, { id: 9003, seq: 2 },
    ]);
    expect(again).toBe(0);
    expect(
      (rawDb.prepare(`SELECT COUNT(*) c FROM scan_run_targets WHERE run_id='run_a'`).get() as any).c,
    ).toBe(3); // and nothing was double-written
  });

  it("counts only the new rows in a partially-duplicate batch", () => {
    expect(store.enqueueRunTargets("run_a", [
      { id: 9003, seq: 0 }, { id: 9004, seq: 1 },
    ])).toBe(1);
  });
});

describe("server: the reconciler credits enqueued rows, not offered rows", () => {
  const src = readFileSync(join(process.cwd(), "server/addressDiscovery/engine.ts"), "utf8");

  it("adds the enqueueRunTargets return value to `work`", () => {
    expect(src).toContain("const enqueued = enqueueRunTargets(");
    expect(src).toContain("work += enqueued;");
    // The exact line that made the backoff unreachable.
    expect(src).not.toContain("work += batch.length;");
  });
});

describe("client: the SSE reconnect backoff resets on data, not on headers", () => {
  const src = readFileSync(join(process.cwd(), "client/src/hooks/use-discovery-jobs.ts"), "utf8");

  it("does not reset `attempt` on the response headers", () => {
    // `setConnected(true); attempt = 0;` ran the moment headers arrived. Headers
    // prove routing, not a working stream - and when the stream ended right
    // after, the delay computed 1_000 * 2**0 every cycle.
    expect(src).not.toMatch(/setConnected\(true\);\s*\n\s*attempt = 0;/);
  });

  it("resets `attempt` only after a chunk has actually been delivered", () => {
    const loop = src.slice(src.indexOf("const chunk = await reader.read()"), src.indexOf("if (!stopped) throw"));
    expect(loop).toContain("attempt = 0;");
  });

  it("still backs off exponentially and still caps at 30s", () => {
    expect(src).toContain("Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5))");
  });
});
