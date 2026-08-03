/**
 * SQLite-backed OTP rate buckets (SEC-B).
 *
 * The OTP request/verify limiters used to live in in-memory Maps inside
 * routes.ts, which meant every cluster worker had its OWN bucket and a
 * restart wiped the counts — an attacker got N× the guess budget and a fresh
 * budget on every deploy. This store keeps the same window+lockout semantics
 * in the shared SQLite database so the limits hold across N workers and
 * restarts.
 *
 * Two instances over the same database file observe each other's counts
 * (that's the multi-worker property), and a prune sweep keeps the table from
 * growing without bound.
 */
import { rawDb } from "./db";

export interface OtpBucketCheck {
  allowed: boolean;
  retryAfter?: number;
}

export class OtpRateBuckets {
  private hits = 0;

  constructor(
    private db: import("better-sqlite3").Database = rawDb,
    private nowFn: () => number = Date.now,
  ) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS otp_rate_buckets (
      bucket       TEXT NOT NULL,
      key          TEXT NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL,
      locked_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, key)
    )`);
  }

  /**
   * Record one hit against (bucket, key). Mirrors the old in-memory logic:
   * a fixed RATE_WINDOW_MS window, and once `max` is exceeded the key locks
   * for LOCKOUT_MS. Read-modify-write runs in an immediate transaction so two
   * workers can't both slip under the cap on a race.
   */
  check(bucket: string, key: string, max: number, windowMs: number, lockoutMs: number): OtpBucketCheck {
    const now = this.nowFn();
    const select = this.db.prepare("SELECT count, window_start, locked_until FROM otp_rate_buckets WHERE bucket=? AND key=?");
    const upsert = this.db.prepare(
      `INSERT INTO otp_rate_buckets (bucket, key, count, window_start, locked_until)
       VALUES (?,?,?,?,?)
       ON CONFLICT (bucket, key) DO UPDATE SET count=excluded.count, window_start=excluded.window_start, locked_until=excluded.locked_until`,
    );
    const prune = this.db.prepare("DELETE FROM otp_rate_buckets WHERE bucket=? AND locked_until < ? AND window_start < ?");
    return this.db.transaction((): OtpBucketCheck => {
      const row = select.get(bucket, key) as { count: number; window_start: number; locked_until: number } | undefined;
      let count = (row?.count ?? 0);
      let windowStart = row?.window_start ?? now;
      let lockedUntil = row?.locked_until ?? 0;

      // Opportunistic prune of fully-expired rows in this bucket (every 64th
      // hit) so the table can't grow unboundedly with throwaway keys.
      this.hits++;
      if (this.hits % 64 === 0) prune.run(bucket, now, now - lockoutMs * 2 - windowMs);

      // Still locked?
      if (lockedUntil > now) return { allowed: false, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
      // Reset the window once it has fully expired.
      if (now - windowStart > windowMs) { count = 0; windowStart = now; lockedUntil = 0; }
      count++;
      if (count > max) {
        lockedUntil = now + lockoutMs;
        upsert.run(bucket, key, count, windowStart, lockedUntil);
        return { allowed: false, retryAfter: Math.ceil(lockoutMs / 1000) };
      }
      upsert.run(bucket, key, count, windowStart, lockedUntil);
      return { allowed: true };
    })();
  }

  /** Clear one key (successful verify resets the caller's buckets). */
  reset(bucket: string, key: string): void {
    this.db.prepare("DELETE FROM otp_rate_buckets WHERE bucket=? AND key=?").run(bucket, key);
  }
}

/** Process-wide shared instance (backs the OTP routes). */
export const otpRateBuckets = new OtpRateBuckets();
