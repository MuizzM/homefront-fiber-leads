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
// These tests pin the two guarantees that fix gives back:
//   1. rate-limit BOOKKEEPING can never fail the login (it degrades in memory),
//   2. an essential write that genuinely can't happen answers 503 + "try again"
//      — and a verify that failed this way has NOT burned the user's code.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterEach(() => unlockDatabase());

afterAll(async () => {
  unlockDatabase();
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("OTP sign-in with a contested database", () => {
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

  it("a wrong code is still a 401 while the database is locked (bookkeeping degrades, the decision stands)", async () => {
    const email = "busy.badcode@otp-busy.test";
    seedUser(email);

    lockDatabase();
    const res = await verifyCode(email, "000000");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/invalid or expired/i);
  });

  it("the per-email request cap still holds when the bucket store is unwritable", async () => {
    const email = "busy.cap@otp-busy.test";
    seedUser(email);

    lockDatabase();
    // The cap is 5 per email; every attempt 503s on the OTP write, but the
    // limiter itself must keep counting (in memory) rather than fail open.
    for (let i = 0; i < 5; i++) expect((await requestCode(email)).status).toBe(503);
    const capped = await requestCode(email);
    expect(capped.status).toBe(429);
  });
});
