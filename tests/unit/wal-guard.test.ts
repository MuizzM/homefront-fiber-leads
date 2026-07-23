import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The WAL guard must measure the -wal FILE (ground truth) and reclaim it with
// a forced TRUNCATE. The 2026-07-23 incident: the old guard sized the WAL from
// wal_checkpoint(PASSIVE)'s `log` column, which reports -1 under contention,
// so it never escalated while the file grew to 12GB and filled the disk.

let dataDir: string;
let db: typeof import("../../server/db");

const walBytes = () => {
  const p = join(dataDir, "data.db-wal");
  return existsSync(p) ? statSync(p).size : 0;
};

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "hf-wal-guard-"));
  process.env.DATA_DIR = dataDir;
  db = await import("../../server/db");
});

describe("WAL guard", () => {
  it("forceWalTruncate reclaims a grown WAL and preserves the data", () => {
    // Suppress autocheckpoint so writes actually accumulate in the WAL.
    db.rawDb.pragma("wal_autocheckpoint = 0");
    db.rawDb.exec(`CREATE TABLE IF NOT EXISTS wal_growth (id INTEGER PRIMARY KEY, blob TEXT)`);
    const insert = db.rawDb.prepare(`INSERT INTO wal_growth (blob) VALUES (?)`);
    const chunk = "x".repeat(8192);
    const tx = db.rawDb.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(chunk);
    });
    tx(2000);
    expect(walBytes()).toBeGreaterThan(1_000_000);

    const afterMb = db.forceWalTruncate("test");
    expect(afterMb).toBe(0);
    expect(walBytes()).toBe(0);
    const n = (db.rawDb.prepare(`SELECT COUNT(*) c FROM wal_growth`).get() as any).c;
    expect(n).toBe(2000);
  });

  it("forceWalTruncate restores the connection busy_timeout", () => {
    const before = db.rawDb.pragma("busy_timeout", { simple: true });
    db.forceWalTruncate("test-2");
    expect(db.rawDb.pragma("busy_timeout", { simple: true })).toBe(before);
  });

  it("bootWalCheckpoint is a no-op on a tiny WAL and never throws", () => {
    expect(() => db.bootWalCheckpoint()).not.toThrow();
  });

  it("startWalGuard respects the WAL_GUARD=off kill-switch", () => {
    process.env.WAL_GUARD = "off";
    try {
      expect(db.startWalGuard()).toBeNull();
    } finally {
      delete process.env.WAL_GUARD;
    }
    const timer = db.startWalGuard();
    expect(timer).not.toBeNull();
    clearInterval(timer!);
  });
});
