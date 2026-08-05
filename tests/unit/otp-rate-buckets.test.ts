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

function open(now?: () => number, busyTimeoutMs?: number) {
  // busyTimeoutMs: 0 makes a contested write fail immediately instead of
  // waiting out better-sqlite3's 5s default — that's what the locked-database
  // test needs, and what production hits once the scan firehose outlasts the
  // (much longer) real busy_timeout.
  const db = new Database(dbPath, busyTimeoutMs != null ? { timeout: busyTimeoutMs } : undefined);
  db.pragma("journal_mode = WAL"); // production's mode — readers and writers overlap
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

  // THE BUCKET TRANSACTION MUST BE IMMEDIATE, NOT DEFERRED (2026-08-05).
  // It reads and then writes. Under better-sqlite3's default DEFERRED begin the
  // read takes a snapshot first, so any commit by another connection in between
  // makes the write fail with SQLITE_BUSY_SNAPSHOT — thrown INSTANTLY, since
  // busy_timeout does not cover that error. On the production box (a permanent
  // scan-write firehose) that was the sub-second half of the login 500s, and it
  // is also the exact read-modify-write race the transaction exists to close.
  // This test forces the interleaving: another connection commits between the
  // SELECT and the UPSERT. IMMEDIATE holds the write lock, so that intruding
  // commit cannot land and OUR value is the one in the table afterwards.
  it("holds the write lock across the read-modify-write (an intruding commit cannot land)", () => {
    open(); // create the table (and put the file in WAL, as production is)
    const own = new Database(dbPath);
    const other = new Database(dbPath);
    dbs.push(own, other);
    // WAL is load-bearing here: it is what lets `other` commit while `own` holds
    // a read snapshot, which is the whole SQLITE_BUSY_SNAPSHOT setup.
    expect(own.pragma("journal_mode", { simple: true })).toBe("wal");
    other.pragma("busy_timeout = 0"); // blocked → fail fast rather than wait

    let intrusionCommitted: boolean | null = null;
    const intrude = () => {
      try {
        other.prepare(
          `INSERT INTO otp_rate_buckets (bucket, key, count, window_start, locked_until) VALUES ('verify','email:a@b.c',99,?,0)
             ON CONFLICT (bucket, key) DO UPDATE SET count=99`,
        ).run(1);
        intrusionCommitted = true;
      } catch { intrusionCommitted = false; }
    };

    // Fire `intrude` from inside the transaction, right after its SELECT.
    const db = new Proxy(own, {
      get(target, prop, recv) {
        const value = Reflect.get(target, prop, recv);
        if (prop !== "prepare") return typeof value === "function" ? value.bind(target) : value;
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.startsWith("SELECT count") || intrusionCommitted !== null) return stmt;
          return new Proxy(stmt, {
            get(s, p) {
              const v = Reflect.get(s, p);
              if (p !== "get") return typeof v === "function" ? v.bind(s) : v;
              return (...args: unknown[]) => { const row = (v as any).apply(s, args); intrude(); return row; };
            },
          });
        };
      },
    }) as unknown as Database.Database;

    expect(new OtpRateBuckets(db).check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
    expect(intrusionCommitted).toBe(false); // the write lock was already ours
    const row = own.prepare("SELECT count FROM otp_rate_buckets WHERE bucket='verify' AND key='email:a@b.c'").get() as { count: number };
    expect(row.count).toBe(1); // ours, not the intruder's 99 — and no throw to swallow
  });

  // A LOCKED DATABASE MUST NOT BE A LOCKOUT. On the production box the scan
  // firehose can hold the write lock past busy_timeout; better-sqlite3 then
  // throws SQLITE_BUSY out of the bucket write, which surfaced as a bare 500
  // ("An internal error occurred") on /api/auth/otp/request — sign-in broken by
  // its own rate limiter. The store falls back to a per-process bucket instead.
  it("never throws when the database is locked, and still enforces the cap", () => {
    const buckets = open(undefined, 0); // creates the table while the DB is still writable
    const holder = new Database(dbPath);
    dbs.push(holder);
    holder.exec("BEGIN EXCLUSIVE"); // another connection owns the write lock
    try {
      for (let i = 0; i < 5; i++) {
        expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
      }
      const blocked = buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfter).toBeGreaterThan(0);
      // A different key is still allowed — degraded, not a blanket denial.
      expect(buckets.check("verify", "email:x@y.z", 5, WINDOW, LOCKOUT).allowed).toBe(true);
      // The success path's reset() must survive the lock too.
      expect(() => buckets.reset("verify", "email:a@b.c")).not.toThrow();
      expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
    } finally {
      holder.exec("ROLLBACK");
    }
    // Once the lock clears, the persistent store is in use again.
    expect(buckets.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
    expect(open().check("request", "email:a@b.c", 1, WINDOW, LOCKOUT).allowed).toBe(false);
  });

  it("keeps request and verify buckets independent", () => {
    const buckets = open();
    for (let i = 0; i < 5; i++) buckets.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT);
    expect(buckets.check("request", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(false);
    expect(buckets.check("verify", "email:a@b.c", 5, WINDOW, LOCKOUT).allowed).toBe(true);
  });
});
