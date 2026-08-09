import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The election core (tryAcquirePrimaryOn / currentPrimaryOn) is pure over an
// injected better-sqlite3 handle — test it with a real temp DB, no app boot.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-lease-"));

let lease: typeof import("../../server/primaryNodeLease");
let Database: any;
let db: any;

beforeAll(async () => {
  lease = await import("../../server/primaryNodeLease");
  Database = (await import("better-sqlite3")).default;
  db = new Database(":memory:");
});

const TTL = 60_000;

describe("primary-node lease - producers run on exactly one node across the fleet", () => {
  it("a lone node acquires the lease and holds it on renew", () => {
    const t = 1_000_000;
    expect(lease.tryAcquirePrimaryOn(db, "nodeA", t, TTL)).toBe(true);
    expect(lease.currentPrimaryOn(db, t)).toBe("nodeA");
    // Renew before expiry stays primary and does not reset acquired_at churn.
    expect(lease.tryAcquirePrimaryOn(db, "nodeA", t + 20_000, TTL)).toBe(true);
  });

  it("a SECOND node is refused while the holder's lease is live (no double-primary)", () => {
    const t = 2_000_000;
    expect(lease.tryAcquirePrimaryOn(db, "nodeA", t, TTL)).toBe(true);
    // nodeB tries 10s later — nodeA's lease is still live → nodeB stands down.
    expect(lease.tryAcquirePrimaryOn(db, "nodeB", t + 10_000, TTL)).toBe(false);
    expect(lease.currentPrimaryOn(db, t + 10_000)).toBe("nodeA");
  });

  it("a surviving node takes over ONLY after the dead holder's lease expires", () => {
    const t = 3_000_000;
    expect(lease.tryAcquirePrimaryOn(db, "nodeA", t, TTL)).toBe(true);
    // nodeA dies; nodeB probes mid-lease → still refused.
    expect(lease.tryAcquirePrimaryOn(db, "nodeB", t + 30_000, TTL)).toBe(false);
    // Past expiry (t + TTL) → nodeB wins.
    expect(lease.tryAcquirePrimaryOn(db, "nodeB", t + TTL + 1, TTL)).toBe(true);
    expect(lease.currentPrimaryOn(db, t + TTL + 1)).toBe("nodeB");
  });

  it("currentPrimaryOn reports null once the lease has expired and nobody renewed", () => {
    const t = 4_000_000;
    expect(lease.tryAcquirePrimaryOn(db, "nodeC", t, TTL)).toBe(true);
    expect(lease.currentPrimaryOn(db, t + TTL + 1)).toBeNull();
  });
});
