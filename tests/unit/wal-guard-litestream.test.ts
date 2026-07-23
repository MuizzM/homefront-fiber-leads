import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// With Litestream enabled (LITESTREAM_BUCKET set), the WAL guard must stand
// down entirely: Litestream holds a long-lived read lock so that no other
// connection can checkpoint/reset the WAL out from under its replication
// position, and it performs its own checkpoints. An active guard would spin
// busy against that lock every tick and could confuse operators with
// perpetual "busy" logs.

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-wal-ls-"));
  process.env.LITESTREAM_BUCKET = "hfs-portal-backup"; // BEFORE importing db
});

afterAll(() => {
  delete process.env.LITESTREAM_BUCKET; // never leak into later test files
});

describe("WAL guard under Litestream", () => {
  it("startWalGuard and bootWalCheckpoint yield to Litestream", async () => {
    const db = await import("../../server/db");
    expect(db.startWalGuard()).toBeNull();
    expect(() => db.bootWalCheckpoint()).not.toThrow();
  });
});
