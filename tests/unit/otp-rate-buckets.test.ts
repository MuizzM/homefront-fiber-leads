import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { OtpRateBuckets } from "../../server/otpRateBuckets";

const WINDOW = 15 * 60 * 1000;
const LOCKOUT = 30 * 60 * 1000;

let dir: string;
let dbPath: string;
let dbs: Database.Database[];

function open(now?: () => number) {
  const db = new Database(dbPath);
  dbs.push(db);
  return new OtpRateBuckets(db, now);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-otp-buckets-"));
  dbPath = path.join(dir, "data.db");
  dbs = [];
});

afterEach(() => {
  for (const db of dbs) { try { db.close(); } catch { /* */ } }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("SQLite-backed OTP rate buckets", () => {
  it("allows up to max, then locks with a retryAfter", () => {
    const buckets = open();
    for (let i = 0; i < 5; i++) {
      expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
    }
    const blocked = buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    // Locked: subsequent hits report the remaining lockout.
    expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    // A different key is unaffected.
    expect(buckets.check("verify", "email:x@y.z", 5, WINDOW, LOCKOUT).allowed).toBe(true);
  });

  it("shares limits across two storage instances (multi-worker property)", () => {
    const workerA = open();
    const workerB = open();
    for (let i = 0; i < 3; i++) workerA.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT);
    for (let i = 0; i < 2; i++) workerB.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT);
    // 5 hits split across both instances → the 6th locks, seen by BOTH workers.
    expect(workerA.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    expect(workerB.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
  });

  it("survives a restart (state persists in the database file)", () => {
    const before = open();
    for (let i = 0; i < 5; i++) before.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT);
    expect(before.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    const after = open(); // brand-new instance over the same file = post-restart worker
    expect(after.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
  });

  it("resets the window after it expires", () => {
    let now = 1_000_000;
    const buckets = open(() => now);
    for (let i = 0; i < 5; i++) buckets.check("request", "ip:1.2.3.4", 5, WINDOW, LOCKOUT);
    expect(buckets.check("request", "ip:1.2.3.4", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    now += WINDOW + LOCKOUT + 1; // lockout AND window both elapsed
    expect(buckets.check("request", "ip:1.2.3.4", 5, WINDOW, LOCKOUT).allowed).toBe(true);
  });

  it("reset() clears a key (successful verify path)", () => {
    const buckets = open();
    for (let i = 0; i < 5; i++) buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT);
    expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    buckets.reset("verify", "email:a@b.c");
    expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
  });

  it("keeps request and verify buckets independent", () => {
    const buckets = open();
    for (let i = 0; i < 5; i++) buckets.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT);
    expect(buckets.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
  });
});
