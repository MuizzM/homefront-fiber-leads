// The floor chat's access rules, end to end.
//
// The room is org-wide and two-way, which makes its boundaries the whole
// point:
//   • every FIELD role reads and writes; desk roles (calling_rep) hold no
//     field.app.use and are refused — the room is the floor talking, not an
//     org-wide mailbox;
//   • a tenant's room is invisible to every other tenant, and cross-tenant
//     deletes miss with 404, never 403 — existence is not confirmed;
//   • you may always remove YOUR words; removing someone else's takes the
//     same capability that moderates the feed (team_lead+);
//   • unread is a monotonic watermark, and your own message never counts
//     against you.
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
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@floor-chat.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

const post = (session: string, body: unknown) =>
  req("/api/chat", session, { method: "POST", body: JSON.stringify({ body }) });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-floor-chat-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA = person("Rep Ann", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.repB = person("Rep Bo", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.caller = person("Cal Caller", "calling_rep");

  storage.createTenant({ slug: "other-floor", companyName: "Other", ownerName: "O", ownerEmail: "o@other-floor.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreignRep = person("Rep Zed", "rep", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
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

// Message ids captured as the story unfolds; later blocks depend on them.
let m1 = 0; // repA's first
let m2 = 0; // repA's long one
let m3 = 0; // repB's

describe("POST /api/chat", () => {
  it("posts, trims, and snapshots the author as a short name", async () => {
    const r = await post(fx.repA.session, "  morning floor  ");
    expect(r.status).toBe(201);
    const msg = await r.json();
    expect(msg.body).toBe("morning floor");
    expect(msg.authorName).toBe("Rep A.");
    expect(msg.authorUserId).toBe(fx.repA.userId);
    expect(msg.authorMemberId).toBe(fx.repA.memberId);
    m1 = msg.id;
    expect(m1).toBeGreaterThan(0);
  });

  it("accepts exactly the cap and refuses one character past it", async () => {
    const ok = await post(fx.repA.session, "x".repeat(2000));
    expect(ok.status).toBe(201);
    m2 = (await ok.json()).id;

    const over = await post(fx.repA.session, "x".repeat(2001));
    expect(over.status).toBe(400);
    expect((await over.json()).error).toContain("2000");
  });

  it("refuses an empty message", async () => {
    const r = await post(fx.repA.session, "   ");
    expect(r.status).toBe(400);
  });

  it("refuses a desk role - the room is the floor's, not the org's", async () => {
    const r = await post(fx.caller.session, "hello from the desk");
    expect(r.status).toBe(403);
    expect((await r.json()).need).toBe("field.app.use");
  });
});

describe("GET /api/chat", () => {
  it("reads ascending, and never counts your own words as unread", async () => {
    const mine = await (await req("/api/chat", fx.repA.session)).json();
    expect(mine.items.map((m: any) => m.id)).toEqual([m1, m2]);
    expect(mine.latestId).toBe(m2);
    expect(mine.unread).toBe(0); // posting advanced repA's own watermark

    const theirs = await (await req("/api/chat", fx.repB.session)).json();
    expect(theirs.unread).toBe(2); // repB has read nothing yet
  });

  it("serves the polling cursor: only what arrived after ?after=", async () => {
    const r = await (await req(`/api/chat?after=${m1}`, fx.manager.session)).json();
    expect(r.items.map((m: any) => m.id)).toEqual([m2]);
    expect(r.latestId).toBe(m2);
  });

  it("pages backwards with ?before= - the badge's whole-room count is reachable", async () => {
    const r = await (await req(`/api/chat?before=${m2}`, fx.manager.session)).json();
    expect(r.items.map((m: any) => m.id)).toEqual([m1]);

    const empty = await (await req(`/api/chat?before=${m1}`, fx.manager.session)).json();
    expect(empty.items).toEqual([]);
  });

  it("shows another tenant an empty room, not this one", async () => {
    const r = await (await req("/api/chat", fx.foreignRep.session)).json();
    expect(r.items).toEqual([]);
    expect(r.latestId).toBe(0);
    expect(r.unread).toBe(0);
  });

  it("refuses a desk role", async () => {
    expect((await req("/api/chat", fx.caller.session)).status).toBe(403);
  });
});

describe("POST /api/chat/read", () => {
  it("clears unread up to the id it was handed", async () => {
    const r = await req("/api/chat/read", fx.repB.session, { method: "POST", body: JSON.stringify({ upToId: m2 }) });
    expect((await r.json()).lastReadId).toBe(m2);
    const page = await (await req("/api/chat", fx.repB.session)).json();
    expect(page.unread).toBe(0);
  });

  it("is monotonic - a stale mark from a second device cannot un-read", async () => {
    const r = await req("/api/chat/read", fx.repB.session, { method: "POST", body: JSON.stringify({ upToId: 1 }) });
    expect((await r.json()).lastReadId).toBe(m2);
  });
});

describe("DELETE /api/chat/:id", () => {
  it("lets repB post so there is something for the moderator cases", async () => {
    const r = await post(fx.repB.session, "who's got spare door hangers?");
    expect(r.status).toBe(201);
    m3 = (await r.json()).id;
  });

  it("refuses a rep deleting someone else's message - 404, room unchanged", async () => {
    const r = await req(`/api/chat/${m1}`, fx.repB.session, { method: "DELETE" });
    expect(r.status).toBe(404);
    const page = await (await req("/api/chat", fx.manager.session)).json();
    expect(page.items.map((m: any) => m.id)).toContain(m1);
  });

  it("misses cross-tenant with 404 - existence is never confirmed", async () => {
    const r = await req(`/api/chat/${m1}`, fx.foreignRep.session, { method: "DELETE" });
    expect(r.status).toBe(404);
  });

  it("lets an author remove their own words", async () => {
    const r = await req(`/api/chat/${m1}`, fx.repA.session, { method: "DELETE" });
    expect((await r.json()).ok).toBe(true);
    const page = await (await req("/api/chat", fx.repA.session)).json();
    expect(page.items.map((m: any) => m.id)).not.toContain(m1);
  });

  it("lets a team lead moderate someone else's message", async () => {
    const r = await req(`/api/chat/${m3}`, fx.lead.session, { method: "DELETE" });
    expect((await r.json()).ok).toBe(true);
  });

  it("404s an id that is already gone", async () => {
    const r = await req(`/api/chat/${m3}`, fx.manager.session, { method: "DELETE" });
    expect(r.status).toBe(404);
  });
});
