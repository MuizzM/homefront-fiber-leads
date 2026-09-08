// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import express from "express";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionAuthority, sameSessionIdentity } from "../../server/sessionAuthority";
import { guardSessionStream } from "../../server/streamSessionGuard";
import { SESSION_ABSOLUTE_MAX_MS, sessionTimestamp } from "../../server/sessionLifetime";
import { canReadTenantJob } from "../../server/tenantJobAccess";

let db: Database.Database, writer: Database.Database, server: Server, base: string, dir: string;
let openStreams = 0;
let sendNext: () => void;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hf-session-guard-"));
  db = new Database(join(dir, "fixture.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,password_hash TEXT,tenant_id INTEGER,
      role TEXT,is_super_admin INTEGER,team_member_id INTEGER,active INTEGER,created_at TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id INTEGER,created_at TEXT,expires_at TEXT);`);
  writer = new Database(join(dir, "fixture.db"));
  const app = express();
  app.get("/json", (_req, res) => {
    guardSessionStream(res, () => { throw new Error("JSON must not read stream authority"); });
    res.json({ ok: true });
  });
  app.get("/stream", (req, res) => {
    const initial = readSessionAuthority(db, "session")!;
    const allowed = () => {
      const current = readSessionAuthority(db, "session");
      return !!current && sameSessionIdentity(initial.user, current.user) && current.organizationStatus === "active";
    };
    guardSessionStream(res, allowed);
    guardSessionStream(res, () => { throw new Error("second installation must be ignored"); });
    res.type("text/event-stream");
    let tick = 0, cleaned = false;
    openStreams++;
    sendNext = () => {
      tick++;
      if (req.query.end === "1") res.end("data: forbidden-end\n\n");
      else res.write(`data: ${tick}\n\n`);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true; openStreams--;
    };
    req.on("close", cleanup); res.on("close", cleanup);
    res.write("data: ready\n\n");
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  db.exec("DELETE FROM sessions; DELETE FROM users; DELETE FROM tenants; INSERT INTO tenants VALUES(1,'active');");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users VALUES(1,'Fixture','fixture@example.test',NULL,1,'manager',0,1,1,?)").run(now);
  db.prepare("INSERT INTO sessions VALUES('session',1,?,?)").run(now, new Date(Date.now() + 3600000).toISOString());
});
afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  writer.close(); db.close(); rmSync(dir, { recursive: true, force: true });
});

it.each(["deleted", "inactive", "role", "tenant", "member", "marker", "org", "idle", "absolute", "end"])(
  "observes %s from another connection before the next asynchronous payload", async change => {
    const res = await fetch(`${base}/stream${change === "end" ? "?end=1" : ""}`, { signal: AbortSignal.timeout(2000) });
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: ready");
    if (change === "deleted" || change === "end") writer.exec("DELETE FROM sessions");
    else if (change === "inactive") writer.exec("UPDATE users SET active=0");
    else if (change === "role") writer.exec("UPDATE users SET role='rep'");
    else if (change === "tenant") writer.exec("UPDATE users SET tenant_id=2");
    else if (change === "member") writer.exec("UPDATE users SET team_member_id=2");
    else if (change === "marker") writer.exec("UPDATE users SET is_super_admin=1");
    else if (change === "org") writer.exec("UPDATE tenants SET status='suspended'");
    else if (change === "idle") writer.prepare("UPDATE sessions SET expires_at=?").run(new Date(Date.now() - 1000).toISOString());
    else writer.prepare("UPDATE sessions SET created_at=?").run(new Date(Date.now() - SESSION_ABSOLUTE_MAX_MS - 1000).toISOString());
    sendNext();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(openStreams).toBe(0);
  });

it("does not renew sessions while sending data and leaves JSON responses alone", async () => {
  expect(await (await fetch(`${base}/json`)).json()).toEqual({ ok: true });
  const changes = db.prepare("SELECT total_changes() AS n").get() as { n: number };
  const before = readSessionAuthority(db, "session")!.session;
  const ac = new AbortController();
  const res = await fetch(`${base}/stream`, { signal: ac.signal });
  const reader = res.body!.getReader();
  await reader.read(); sendNext(); await reader.read();
  expect(readSessionAuthority(db, "session")!.session).toEqual(before);
  expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  ac.abort(); await reader.cancel().catch(() => {});
});

it("interprets legacy SQLite timestamps as UTC and rejects unspecified formats", () => {
  expect(sessionTimestamp("2026-09-08 12:34:56")).toBe(Date.parse("2026-09-08T12:34:56Z"));
  expect(sessionTimestamp("2026-09-08T12:34:56.123Z")).toBe(Date.parse("2026-09-08T12:34:56.123Z"));
  expect(Number.isNaN(sessionTimestamp("2026-09-08T12:34:56"))).toBe(true);
  expect(Number.isNaN(sessionTimestamp("invalid"))).toBe(true);
});

it("legacy jobs require a positive matching tenant or the immutable platform marker", () => {
  expect(canReadTenantJob({ tenantId: 1 }, { tenantId: 1 })).toBe(true);
  expect(canReadTenantJob({ tenantId: 1 }, { tenantId: 2 })).toBe(false);
  expect(canReadTenantJob({ tenantId: null }, { tenantId: 1 })).toBe(false);
  expect(canReadTenantJob({ tenantId: 0 }, { tenantId: 0 })).toBe(false);
  expect(canReadTenantJob({ isSuperAdmin: 1 }, { tenantId: 2 })).toBe(true);
  expect(canReadTenantJob({ isSuperAdmin: 1 }, undefined)).toBe(false);
});
