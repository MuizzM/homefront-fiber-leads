// @vitest-environment node
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "hf-login-performance-"));
let db: Database.Database;
let store: typeof import("../../server/storage");
beforeAll(async () => {
  process.env.DATA_DIR = directory;
  process.env.NODE_ENV = "test";
  store = await import("../../server/storage");
  store.runMigrations();
  ({ rawDb: db } = await import("../../server/db"));
  (await import("../../server/calling/migrations")).runCallingMigrations();
});
afterAll(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

it("adds a restart-safe OTP index to existing data and uses it for all email/live-code paths", () => {
  db.exec("DROP INDEX idx_otp_email_used_expiry");
  db.exec(`INSERT INTO otp_codes (email,code,expires_at,used) VALUES ('fixture@example.test','123456','2099-01-01',0)`);
  const before = db.prepare("SELECT * FROM otp_codes").all();
  store.runMigrations();
  store.runMigrations();
  expect(db.prepare("SELECT * FROM otp_codes").all()).toEqual(before);
  for (const sql of [
    "SELECT * FROM otp_codes WHERE email=? AND code=? AND used=0 AND expires_at>?",
    "UPDATE otp_codes SET used=1 WHERE email=? AND used=0",
    "UPDATE otp_codes SET failed_attempts=failed_attempts+1 WHERE email=? AND used=0 AND expires_at>?",
  ]) {
    const bindings = sql.includes("code=?") ? ["fixture@example.test", "123456", "2026-01-01"]
      : sql.includes("expires_at>?") ? ["fixture@example.test", "2026-01-01"] : ["fixture@example.test"];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
    expect(plan.map(p => p.detail).join(" ")).toMatch(/SEARCH.*idx_otp_email_used_expiry/);
  }
});

it("empty retention and stranded-run maintenance do not acquire a database writer", async () => {
  const { purgeExpiredProviderPayloads } = await import("../../server/calling/providerRetention");
  const { reconcileStrandedRuns } = await import("../../server/areaSkipTrace");
  db.pragma("query_only = ON");
  try {
    expect(purgeExpiredProviderPayloads()).toEqual({ purged: 0, hasMore: false });
    expect(reconcileStrandedRuns()).toBe(0);
  } finally { db.pragma("query_only = OFF"); }
});

it("the actual maintenance scheduler stays read-only when there is no work and stops cleanly", async () => {
  const { startCallingMaintenance } = await import("../../server/callingMaintenance");
  const holder = new Database(db.name);
  holder.exec("BEGIN IMMEDIATE");
  const transaction = vi.spyOn(db, "transaction");
  let stop: (() => void) | undefined;
  try {
    const started = performance.now();
    stop = await startCallingMaintenance();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(performance.now() - started).toBeLessThan(500);
    expect(transaction).not.toHaveBeenCalled();
  } finally { stop?.(); transaction.mockRestore(); holder.exec("ROLLBACK"); holder.close(); }
});

it("a contended bandwidth flush yields immediately and retains exact accounting until commit", async () => {
  const gov = await import("../../server/bandwidthGovernor");
  gov.recordProxyResponse(10_000);
  gov.flushBandwidthLedger();
  const holder = new Database(db.name);
  holder.exec("BEGIN IMMEDIATE");
  db.pragma("busy_timeout = 2000");
  try {
    gov.recordProxyResponse(20_000);
    const start = performance.now();
    gov.flushBandwidthLedger();
    expect(performance.now() - start).toBeLessThan(250);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(2000);
    expect(db.prepare("SELECT SUM(bytes) AS bytes FROM bandwidth_ledger").get()).toEqual({ bytes: 10_000 });
  } finally { holder.exec("ROLLBACK"); holder.close(); }
  gov.recordProxyResponse(30_000);
  gov.flushBandwidthLedger();
  gov.flushBandwidthLedger();
  expect(db.prepare("SELECT SUM(bytes) AS bytes, SUM(requests) AS requests FROM bandwidth_ledger").get()).toEqual({ bytes: 60_000, requests: 3 });
});
