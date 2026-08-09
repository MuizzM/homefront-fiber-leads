// Migration behaviour of the one-referral-per-application constraint, on BOTH
// a new install and an existing database.
//
// This suite exists because of a real hazard found in review: `CREATE UNIQUE
// INDEX` fails when the data already violates it, and `ensureReferralSchema`
// runs at module import — i.e. at BOOT. Put naively in the bulk exec, an
// existing database with one duplicate would refuse to start the server, on
// every restart, with no way in. A data problem would have become an outage.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let R: typeof import("../../server/referralStore");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
const NOW = "2026-08-07T12:00:00.000Z";

const indexExists = () => !!rawDb.prepare(
  `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_referrals_one_per_application'`,
).get();

function referral(applicationId: number | null, status = "APPLIED") {
  return rawDb.prepare(
    `INSERT INTO referrals (tenant_id, referrer_user_id, referrer_rep_id, referred_email,
       referred_application_id, status, reward_amount_cents, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(TENANT, 1, 1, `a${Math.random()}@example.test`, applicationId, status, 50_000, NOW, NOW);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-refmig-"));
  (await import("../../server/storage")).runMigrations();
  ({ rawDb } = await import("../../server/db"));
  R = await import("../../server/referralStore");
});

beforeEach(() => {
  rawDb.exec("DROP TRIGGER IF EXISTS referral_events_no_delete");
  rawDb.prepare("DELETE FROM referral_events").run();
  rawDb.prepare("DELETE FROM referrals").run();
  rawDb.exec("DROP INDEX IF EXISTS idx_referrals_one_per_application");
});

describe("a NEW install", () => {
  it("installs the constraint on empty data", () => {
    const result = R.ensureOneReferralPerApplicationIndex();
    expect(result).toEqual({ installed: true, conflicts: 0 });
    expect(indexExists()).toBe(true);
  });

  it("is idempotent - re-running is a no-op", () => {
    R.ensureOneReferralPerApplicationIndex();
    expect(R.ensureOneReferralPerApplicationIndex()).toEqual({ installed: true, conflicts: 0 });
  });

  it("then blocks a duplicate at the database", () => {
    R.ensureOneReferralPerApplicationIndex();
    referral(42);
    expect(() => referral(42)).toThrow(/UNIQUE/i);
  });
});

describe("an EXISTING database with clean data", () => {
  it("installs the constraint over rows that do not violate it", () => {
    referral(1); referral(2); referral(3);
    // NULL application ids are the pre-wiring rows — many of them, all exempt
    // because the index is partial.
    referral(null); referral(null); referral(null);

    expect(R.ensureOneReferralPerApplicationIndex()).toEqual({ installed: true, conflicts: 0 });
    expect(indexExists()).toBe(true);
  });
});

describe("an EXISTING database that already violates it", () => {
  it("BOOTS rather than crashing, and reports the offending rows", () => {
    const first = referral(42);
    const second = referral(42, "REJECTED");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    // The whole point: a data problem must not become an outage.
    const result = R.ensureOneReferralPerApplicationIndex();
    expect(result.installed).toBe(false);
    expect(result.conflicts).toBe(1);
    expect(indexExists()).toBe(false);

    // …and the operator is told exactly what to fix, by id.
    const logged = warn.mock.calls.map(c => c.join(" ")).join("\n");
    expect(logged).toMatch(/application 42 has 2 referrals/);
    expect(logged).toMatch(new RegExp(`${first.lastInsertRowid}`));
    expect(logged).toMatch(new RegExp(`${second.lastInsertRowid}`));
    expect(logged).toMatch(/without idx_referrals_one_per_application/i);
    warn.mockRestore();
  });

  it("does NOT silently delete or merge the rows", () => {
    referral(42); referral(42, "REJECTED");
    vi.spyOn(console, "error").mockImplementation(() => {});
    R.ensureOneReferralPerApplicationIndex();
    // These rows decide who gets paid $500. A heuristic that picks a winner
    // without a human is worse than a missing index for a day.
    const n = rawDb.prepare(`SELECT COUNT(*) AS n FROM referrals`).get() as any;
    expect(n.n).toBe(2);
    vi.restoreAllMocks();
  });

  it("installs cleanly once the operator resolves the conflict", () => {
    referral(42);
    const dupe = referral(42, "REJECTED");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(R.ensureOneReferralPerApplicationIndex().installed).toBe(false);

    // The operator detaches the duplicate — the next boot installs the index.
    rawDb.prepare(`UPDATE referrals SET referred_application_id = NULL WHERE id = ?`)
      .run(dupe.lastInsertRowid);
    expect(R.ensureOneReferralPerApplicationIndex()).toEqual({ installed: true, conflicts: 0 });
    expect(indexExists()).toBe(true);
    vi.restoreAllMocks();
  });

  it("the full schema setup survives dirty data too", () => {
    referral(42); referral(42, "REJECTED");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // ensureReferralSchema is what runs at import. It must not throw.
    expect(() => R.ensureReferralSchema()).not.toThrow();
    vi.restoreAllMocks();
  });
});
