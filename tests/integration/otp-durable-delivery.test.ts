// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimOtpDelivery, eligibleOtpMail, ensureOtpDeliverySchema, issueDurableOtp, settleOtpDelivery } from "../../server/otpDeliveryStore";
import { assertReliableOtpReady, drainOtpDeliveries } from "../../server/otpDeliveryWorker";
import { otpCodeMatches } from "../../server/otpSecrets";
import { reliableOtpEnabled, reliabilityEnabled } from "../../server/reliabilityFeatures";

let db: Database.Database, dir: string, file: string;
const now = Date.parse("2026-09-08T12:00:00Z");
const user = { id: 1, tenantId: 1, name: "Test", email: "fixture@example.invalid" };
const mail = (code: string) => ({ from: "Test <sender@example.invalid>", to: user.email, subject: "Fixture", text: code, html: `<b>${code}</b>` });
function issue(at = now) { return db.transaction(() => issueDurableOtp(db, user, mail, at)).immediate(); }
function claim(connection = db, at = now) { return connection.transaction(() => claimOtpDelivery(connection, at)).immediate()!; }
beforeEach(() => {
  vi.stubEnv("OTP_ENCRYPTION_KEY", "7".repeat(64));
  dir = mkdtempSync(join(tmpdir(), "hf-reliability-test-")); file = join(dir, "fixture.sqlite");
  db = new Database(file); db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,active INTEGER,tenant_id INTEGER);
    CREATE TABLE otp_codes(id INTEGER PRIMARY KEY,email TEXT,code TEXT,used INTEGER DEFAULT 0,expires_at TEXT,created_at TEXT,failed_attempts INTEGER DEFAULT 0);
    INSERT INTO users VALUES (1,'fixture@example.invalid',1,1);`);
  ensureOtpDeliverySchema(db);
});
afterEach(() => { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("durable OTP delivery", () => {
  it("survives actual SIGKILL between provider acceptance and local acknowledgement", async () => {
    const issued = issue();
    db.exec("CREATE TABLE fixture_provider(id TEXT PRIMARY KEY,body TEXT)");
    const result = await new Promise<{ code: number | null; signal: string | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", resolve("tests/fixtures/reliability-worker.ts"), file, "crash-email-acceptance", String(now)], { stdio: ["ignore", "ignore", "pipe"] });
      let error = ""; child.stderr.on("data", chunk => { error += chunk; }); child.on("error", reject);
      child.on("exit", (code, signal) => done({ code, signal, error }));
    });
    expect(result, result.error).toMatchObject({ signal: "SIGKILL" });
    expect(db.prepare("SELECT status,attempts FROM auth_delivery_outbox").get()).toEqual({ status: "processing", attempts: 1 });
    await drainOtpDeliveries(db, { now: () => now + 60_001, send: async (body, key) => {
      expect(key).toBe(`otp-v1/${issued.operationId}`);
      expect(db.prepare("SELECT body FROM fixture_provider WHERE id=?").get(key)).toEqual({ body: JSON.stringify(body) });
      db.prepare("INSERT OR IGNORE INTO fixture_provider(id,body) VALUES (?,?)").run(key, JSON.stringify(body));
      return { id: key };
    } });
    expect(db.prepare("SELECT COUNT(*) n FROM fixture_provider").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT status,attempts FROM auth_delivery_outbox").get()).toEqual({ status: "accepted", attempts: 2 });
  });
  it("does not acquire a writer for an empty queue", async () => {
    const holder = new Database(file); holder.exec("BEGIN IMMEDIATE");
    try { await drainOtpDeliveries(db, { now: () => now, send: vi.fn() }); }
    finally { holder.exec("ROLLBACK"); holder.close(); }
  });
  it("does not let an expired backlog starve fresh delivery", async () => {
    const first = issue();
    // Explicit columns below keep the fixture aligned with the durable schema.
    const row = db.prepare("SELECT * FROM auth_delivery_outbox WHERE id=?").get(first.operationId) as Record<string, unknown>;
    const keys = Object.keys(row), insert = db.prepare(`INSERT INTO auth_delivery_outbox(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`);
    db.transaction(() => { for (let i = 1; i <= 1200; i++) insert.run(...keys.map(key => key === "id" ? `expired-${i}` : key === "otp_id" ? i + 10 : key === "expires_at" ? now - 1 : key === "created_at" ? now - 700_000 : row[key])); })();
    const send = vi.fn(async () => ({ id: "fresh" }));
    await drainOtpDeliveries(db, { now: () => now, send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status FROM auth_delivery_outbox WHERE id=?").get(first.operationId)).toEqual({ status: "accepted" });
  });
  it("commits protected code and delivery together and survives close/reopen", async () => {
    const { code, operationId } = issue();
    const stored = db.prepare("SELECT code FROM otp_codes").get() as { code: string };
    expect(stored.code).toMatch(/^otp1\./); expect(stored.code).not.toContain(code);
    expect(otpCodeMatches(stored.code, user.email, code)).toBe(true);
    expect(otpCodeMatches(stored.code, "foreign@example.invalid", code)).toBe(false);
    expect(otpCodeMatches(stored.code, user.email, code === "100000" ? "100001" : "100000")).toBe(false);
    db.close(); db = new Database(file); ensureOtpDeliverySchema(db);
    const send = vi.fn(async () => ({ id: "provider-1" }));
    await drainOtpDeliveries(db, { now: () => now, send });
    expect(send).toHaveBeenCalledWith(mail(code), `otp-v1/${operationId}`, undefined);
    expect(db.prepare("SELECT status,payload,provider_id,attempts FROM auth_delivery_outbox").get())
      .toEqual({ status: "accepted", payload: null, provider_id: "provider-1", attempts: 1 });
    await drainOtpDeliveries(db, { now: () => now, send }); expect(send).toHaveBeenCalledTimes(1);
  });
  it("rolls back supersession and issuance when enqueue fails", () => {
    const first = issue();
    db.exec(`CREATE TRIGGER fail_enqueue BEFORE INSERT ON auth_delivery_outbox BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    expect(() => issue(now + 1)).toThrow("injected");
    expect(db.prepare("SELECT used FROM otp_codes").all()).toEqual([{ used: 0 }]);
    expect(db.prepare("SELECT id,status FROM auth_delivery_outbox").all()).toEqual([{ id: first.operationId, status: "pending" }]);
  });
  it("only one connection owns a live claim and a stale owner cannot acknowledge a replacement", () => {
    issue(); const a = claim(); const other = new Database(file);
    try {
      expect(claim(other)).toBeNull();
      const b = claim(other, now + 60_001);
      expect(b.lease_token).not.toBe(a.lease_token);
      expect(settleOtpDelivery(db, a, { status: "accepted" }, now + 60_002)).toBe(false);
      expect(settleOtpDelivery(other, b, { status: "accepted", providerId: "winner" }, now + 60_002)).toBe(true);
    } finally { other.close(); }
  });
  it("replays identical provider body/key after acceptance but lost local acknowledgement", async () => {
    issue(); const first = claim(); const body = eligibleOtpMail(db, first, now)!;
    const accepted = new Map<string, string>(); let deliveries = 0;
    const send = vi.fn(async (_mail: unknown, key: string) => {
      if (!accepted.has(key)) { deliveries++; accepted.set(key, "accepted-before-crash"); }
      return { id: accepted.get(key)! };
    });
    await send(body, `otp-v1/${first.id}`); // process dies before local acknowledgement
    db.close(); db = new Database(file);
    await drainOtpDeliveries(db, { now: () => now + 60_001, send });
    expect(send).toHaveBeenCalledTimes(2); expect(deliveries).toBe(1);
    expect(send.mock.calls[1].slice(0, 2)).toEqual(send.mock.calls[0]);
    expect(db.prepare("SELECT status,attempts FROM auth_delivery_outbox").get()).toEqual({ status: "accepted", attempts: 2 });
  });
  it("does not deliver a replaced or consumed code or an account that moved tenant", async () => {
    const old = issue(); const claimed = claim(); issue(now + 1);
    expect(eligibleOtpMail(db, claimed, now + 2)).toBeNull();
    expect(settleOtpDelivery(db, claimed, { status: "accepted" }, now + 2)).toBe(false);
    expect(db.prepare("SELECT status FROM auth_delivery_outbox WHERE id=?").get(old.operationId)).toEqual({ status: "superseded" });
    db.prepare("UPDATE users SET tenant_id=2 WHERE id=1").run();
    const send = vi.fn(); await drainOtpDeliveries(db, { now: () => now + 2, send }); expect(send).not.toHaveBeenCalled();
    db.prepare("UPDATE users SET tenant_id=1 WHERE id=1").run(); issue(now + 3);
    db.prepare("UPDATE otp_codes SET used=1").run();
    await drainOtpDeliveries(db, { now: () => now + 4, send }); expect(send).not.toHaveBeenCalled();
  });
  it("never exceeds five attempts and never sends expired codes", async () => {
    issue(); let clock = now;
    const send = vi.fn(async () => { throw new Error("lost acknowledgement"); });
    for (let i = 0; i < 8; i++) {
      await drainOtpDeliveries(db, { now: () => clock, send }); clock += 60_001;
    }
    expect(send).toHaveBeenCalledTimes(5);
    expect(db.prepare("SELECT status,attempts,payload FROM auth_delivery_outbox").get()).toEqual({ status: "failed", attempts: 5, payload: null });
    issue(clock); await drainOtpDeliveries(db, { now: () => clock + 600_000, send });
    expect(send).toHaveBeenCalledTimes(5);
  });
  it("preserves organization-less account ownership instead of inventing a tenant", async () => {
    db.prepare("UPDATE users SET tenant_id=NULL").run();
    db.transaction(() => issueDurableOtp(db, { ...user, tenantId: null }, mail, now)).immediate();
    const send = vi.fn(async () => ({ id: "platform" }));
    await drainOtpDeliveries(db, { now: () => now, send }); expect(send).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT tenant_id FROM auth_delivery_outbox").get()).toEqual({ tenant_id: null });
  });
  it("keeps protected and legacy readers active when rollout is disabled", () => {
    const issued = issue(); vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "0");
    expect(reliableOtpEnabled(user.email)).toBe(false);
    expect(otpCodeMatches((db.prepare("SELECT code FROM otp_codes").get() as any).code, user.email, issued.code)).toBe(true);
    expect(otpCodeMatches("123456", user.email, "123456")).toBe(true);
  });
  it("fails closed on missing encryption before mutation, and validates rollout cohorts", () => {
    vi.stubEnv("OTP_ENCRYPTION_KEY", ""); vi.stubEnv("CALLING_DATA_ENCRYPTION_KEY", "");
    expect(assertReliableOtpReady).toThrow("not configured"); expect(() => issue()).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM otp_codes").get()).toEqual({ n: 0 });
    vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "bogus"); expect(reliabilityEnabled("OUTBOX_PATTERN", 1)).toBe(false);
    vi.stubEnv("RELIABILITY_ROLLOUT_PERCENT", "100"); expect(reliableOtpEnabled(user.email)).toBe(true);
    vi.stubEnv("OUTBOX_PATTERN", "off"); expect(reliableOtpEnabled(user.email)).toBe(false);
    expect(reliabilityEnabled("IDEMPOTENT_ASSIGNMENT", 0)).toBe(false);
  });
});
