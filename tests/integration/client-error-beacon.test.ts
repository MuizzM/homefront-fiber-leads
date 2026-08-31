// POST /api/client-errors - the transmit half of the ErrorBoundary's
// "Support code". The contract under test: authenticated only (an anonymous
// beacon is a log-flood primitive), accepts a capped report, and a crash
// loop is throttled per user (accepted-and-dropped, never an error the
// beacon would then re-report).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

function post(path: string, session: string | null, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-session-id": session, "x-csrf-token": session } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-beacon-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${a.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

function mintSession(name: string): string {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@beacon.example.test`;
  const member = storage.createTeamMember({ name, email, role: "rep", active: true, tenantId: 1 } as any);
  const user = storage.createUser({ name, email, role: "rep", active: true, tenantId: 1, teamMemberId: member.id } as any);
  return storage.createSession(user.id).id;
}

describe("client error beacon", () => {
  it("refuses anonymous reports", async () => {
    const res = await post("/api/client-errors", null, { kind: "boundary", message: "boom" });
    expect(res.status).toBe(401);
  });

  it("accepts an authenticated report", async () => {
    const session = mintSession("Beacon One");
    const res = await post("/api/client-errors", session, {
      kind: "boundary",
      incidentId: "AB12CD34",
      name: "TypeError",
      message: "x is not a function",
      stack: "TypeError: x is not a function\n  at f (chunk.js:1:1)",
      route: "#/map",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("throttles a crash loop: the 11th report in a minute is accepted-and-dropped", async () => {
    const session = mintSession("Beacon Loop");
    for (let i = 0; i < 10; i++) {
      const res = await post("/api/client-errors", session, { kind: "window", message: `crash ${i}` });
      expect(res.status).toBe(200);
    }
    const eleventh = await post("/api/client-errors", session, { kind: "window", message: "crash 11" });
    expect(eleventh.status).toBe(202);
    expect(await eleventh.json()).toEqual({ ok: true, dropped: true });
  });
});
