// A BUSY DATABASE MUST NOT LOOK LIKE A BROKEN ACCOUNT (2026-08-05).
//
// Reported as "sq7120@gmail.com can't log in — internal error", but probing
// production showed it hit any email, intermittently: /api/auth/otp/request
// answered {"error":"An internal error occurred. Please try again."} after a
// ~15-23s hang while the box was under scan load. Every sign-in step writes
// (rate bucket → OTP row → session), so once the scan firehose held the SQLite
// write lock past busy_timeout, better-sqlite3 threw SQLITE_BUSY and Express 5
// routed the async rejection to the generic 500 handler.
//
// Admission, code consumption and session creation commit together. A locked
// writer yields bounded 503 instead of bypassing persistent cross-worker caps.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl: string;
let dbPath: string;
let storage: (typeof import("../../server/storage"))["storage"];
let holder: Database.Database | null = null;

/** Hold the write lock from another connection — exactly what a scan worker
 *  mid-transaction does to the web process. */
function lockDatabase() {
  holder = new Database(dbPath);
  holder.pragma("busy_timeout = 0");
  holder.exec("BEGIN EXCLUSIVE");
}
function unlockDatabase() {
  if (!holder) return;
  try { holder.exec("ROLLBACK"); } finally { holder.close(); holder = null; }
}

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const requestCode = (email: string) => post("/api/auth/otp/request", { email });
const verifyCode = (email: string, code: string) => post("/api/auth/otp/verify", { email, code });

function seedUser(email: string) {
  storage.createUser({ name: "Busy Tester", email, role: "manager", active: true, tenantId: 1 } as any);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-otp-busy-"));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = "test";
  // The real box waits busy_timeout (15s) before throwing. Wait 1ms here — the
  // failure mode is identical, the test doesn't take 15 seconds per case.
  process.env.SQLITE_BUSY_TIMEOUT_MS = "1";
  dbPath = join(dir, "data.db");

  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  const { registerRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.get("/fixture-health", (_req, res) => res.json({ ok: true }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterEach(() => { unlockDatabase(); vi.restoreAllMocks(); });

afterAll(async () => {
  unlockDatabase();
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("OTP sign-in with a contested database", () => {
  it("keeps the code and request budget when session creation fails after consumption", async () => {
    const email = "atomic.verify@otp-busy.test";
    seedUser(email);
    const code = (await (await requestCode(email)).json()).developmentCode as string;
    const { rawDb } = await import("../../server/db");
    const buckets = () => rawDb.prepare("SELECT * FROM otp_rate_buckets WHERE key=? ORDER BY bucket").all(`email:${email}`);
    const before = buckets();
    const insertSession = storage.createSession.bind(storage);
    const createSession = vi.spyOn(storage, "createSession").mockImplementationOnce(userId => {
      insertSession(userId);
      throw new Error("Synthetic session insertion failure");
    });
    expect((await verifyCode(email, code)).status).toBe(503);
    expect(buckets()).toEqual(before);
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(storage.getUserByEmail(email)!.id)).toEqual({ n: 0 });
    createSession.mockRestore();
    const retried = await verifyCode(email, code);
    expect(retried.status).toBe(200);
    const data = await retried.json();
    expect(data.sessionId).toBeTruthy();
    expect(data.user.tenantId).toBe(1);
    expect(data.user.isSuperAdmin).toBe(false);
    expect((await verifyCode(email, code)).status).toBe(401);
  });

  it("preserves the prior code if inserting a replacement fails", async () => {
    const email = "atomic.request@otp-busy.test";
    seedUser(email);
    const code = (await (await requestCode(email)).json()).developmentCode as string;
    const { rawDb } = await import("../../server/db");
    rawDb.exec("CREATE TEMP TRIGGER fail_otp_insert BEFORE INSERT ON otp_codes BEGIN SELECT RAISE(ABORT, 'synthetic insertion failure'); END");
    try { expect((await requestCode(email)).status).toBe(503); }
    finally { rawDb.exec("DROP TRIGGER fail_otp_insert"); }
    expect((await verifyCode(email, code)).status).toBe(200);
  });
  it("requesting a code answers 503 'try again', never a bare 500", async () => {
    const email = "busy.request@otp-busy.test";
    seedUser(email);

    lockDatabase();
    const res = await requestCode(email);
    expect(res.status).toBe(503); // was: 500 "An internal error occurred."
    expect((await res.json()).error).toMatch(/try again/i);

    // …and it is genuinely transient: the same email works the moment the lock
    // clears. Nothing about the ACCOUNT was wrong.
    unlockDatabase();
    const after = await requestCode(email);
    expect(after.status).toBe(200);
    expect((await after.json()).developmentCode).toMatch(/^\d{6}$/);
  });

  it("a failed verify does not burn the code - the same digits work on retry", async () => {
    const email = "busy.verify@otp-busy.test";
    seedUser(email);
    const code = (await (await requestCode(email)).json()).developmentCode as string;
    expect(code).toMatch(/^\d{6}$/);

    lockDatabase();
    const blocked = await verifyCode(email, code);
    expect(blocked.status).toBe(503);
    expect((await blocked.json()).error).toMatch(/try again/i);

    unlockDatabase();
    const ok = await verifyCode(email, code);
    expect(ok.status).toBe(200);
    expect((await ok.json()).sessionId).toBeTruthy();
  });

  it("does not judge a code until persistent guess accounting can commit", async () => {
    const email = "busy.badcode@otp-busy.test";
    seedUser(email);

    lockDatabase();
    const res = await verifyCode(email, "000000");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    unlockDatabase();
    expect((await verifyCode(email, "000000")).status).toBe(401);
  });

  it("a lock never permits sending or guessing under a per-process fallback budget", async () => {
    const email = "busy.cap@otp-busy.test";
    seedUser(email);

    lockDatabase();
    expect((await requestCode(email)).status).toBe(503);
    unlockDatabase();
    const { rawDb } = await import("../../server/db");
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM otp_codes WHERE email=?").get(email)).toEqual({ n: 0 });
    for (let i = 0; i < 5; i++) expect((await requestCode(email)).status).toBe(200);
    expect((await requestCode(email)).status).toBe(429);
  });

  it.each(["request", "verify"])("recovers the first %s attempt after a brief lock without freezing HTTP or double-counting", async kind => {
    const email = `brief.${kind}@otp-busy.test`;
    seedUser(email);
    const code = kind === "verify" ? (await (await requestCode(email)).json()).developmentCode : undefined;
    const { rawDb } = await import("../../server/db");
    const prior = rawDb.pragma("busy_timeout", { simple: true });
    rawDb.pragma("busy_timeout = 2000"); // a stalled native call would exceed the entire retry budget
    lockDatabase();
    const started = performance.now();
    // Releasing on this event loop is intentional: native SQLite waiting
    // prevents this timer and the health request from running, failing the test.
    const release = setTimeout(unlockDatabase, 100);
    try {
      const auth = kind === "request" ? requestCode(email) : verifyCode(email, code);
      await new Promise(resolve => setTimeout(resolve, 25));
      expect((await fetch(`${baseUrl}/fixture-health`)).status).toBe(200);
      expect(performance.now() - started).toBeLessThan(500);
      expect((await auth).status).toBe(200);
      expect(performance.now() - started).toBeLessThan(1500);
      expect(rawDb.pragma("busy_timeout", { simple: true })).toBe(2000);
      if (kind === "request") {
        expect(rawDb.prepare("SELECT count FROM otp_rate_buckets WHERE bucket='request' AND key=?").get(`email:${email}`)).toEqual({ count: 1 });
      }
    } finally { clearTimeout(release); unlockDatabase(); rawDb.pragma(`busy_timeout = ${prior}`); }
  });

  it("commits only one session for concurrent verification of the same code", async () => {
    const email = "concurrent.verify@otp-busy.test";
    seedUser(email);
    const code = (await (await requestCode(email)).json()).developmentCode;
    const replies = await Promise.all([verifyCode(email, code), verifyCode(email, code)]);
    expect(replies.map(r => r.status).sort()).toEqual([200, 401]);
    const { rawDb } = await import("../../server/db");
    expect(rawDb.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?").get(storage.getUserByEmail(email)!.id)).toEqual({ n: 1 });
  });

  it("commits wrong-code counters across requests and enforces the cap from a fresh bucket instance", async () => {
    const email = "denial.verify@otp-busy.test";
    seedUser(email);
    expect((await requestCode(email)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await verifyCode(email, "000000")).status).toBe(401);
    const { rawDb } = await import("../../server/db");
    expect(rawDb.prepare("SELECT count FROM otp_rate_buckets WHERE bucket='verify' AND key=?").get(`email:${email}`)).toEqual({ count: 5 });
    expect(rawDb.prepare("SELECT used, failed_attempts FROM otp_codes WHERE email=?").get(email)).toEqual({ used: 1, failed_attempts: 5 });
    expect((await verifyCode(email, "000000")).status).toBe(429);
    const { OtpRateBuckets } = await import("../../server/otpRateBuckets");
    const restarted = new OtpRateBuckets(rawDb);
    const result = rawDb.transaction(() => restarted.checkInTransaction("verify", `email:${email}`, 5, 15 * 60_000, 30 * 60_000)).immediate();
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});
