// Mid-session permission changes take effect on the NEXT protected request -
// the guarantee the whole capability model rests on. requireAuth re-reads the
// user row per request (never a role cached at session mint), so:
//   - deactivation answers 401 immediately, even mid-shift
//   - a demotion strips capabilities on the very next call
//   - a promotion grants them without a re-login
// This was verified by reading requireAuth; these tests PIN it, because the
// obvious "optimization" (stamp the role into the session row) would silently
// re-open all three.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; memberId: number; session: string };

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@authfresh.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function post(path: string, session: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session },
    body: JSON.stringify(body),
  });
}
function get(path: string, session: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });
}

const RING: [number, number][] = [
  [-80.30, 35.80], [-80.20, 35.80], [-80.20, 35.90], [-80.30, 35.90],
];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-authfresh-"));
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

describe("permission changes land on the next request", () => {
  it("deactivation answers 401 immediately, with the session still held", async () => {
    const rep = person("Riley Rep", "rep");
    expect((await get("/api/auth/status", rep.session)).status).toBe(200);

    storage.updateUser(rep.userId, { active: false } as any, 1);

    const after = await get("/api/leads", rep.session);
    expect(after.status).toBe(401);
  });

  it("a demoted manager loses lead.assign on the very next call - preview and apply", async () => {
    const mara = person("Mara Was-Manager", "manager");
    const ok = await post("/api/leads/assign-selection/preview", mara.session, { polygon: RING });
    expect(ok.status).toBe(200);

    storage.updateUser(mara.userId, { role: "rep" } as any, 1);
    storage.updateTeamMember(mara.memberId, { role: "rep" } as any, 1);

    const preview = await post("/api/leads/assign-selection/preview", mara.session, { polygon: RING });
    expect(preview.status).toBe(403);
    const apply = await post("/api/leads/assign-selection", mara.session, {
      polygon: RING, repId: mara.memberId,
    });
    expect(apply.status).toBe(403);
  });

  it("a promotion grants the capability without a re-login", async () => {
    const pat = person("Pat Promoted", "rep");
    expect((await post("/api/leads/assign-selection/preview", pat.session, { polygon: RING })).status).toBe(403);

    storage.updateUser(pat.userId, { role: "team_lead" } as any, 1);
    storage.updateTeamMember(pat.memberId, { role: "team_lead" } as any, 1);

    expect((await post("/api/leads/assign-selection/preview", pat.session, { polygon: RING })).status).toBe(200);
  });
});
