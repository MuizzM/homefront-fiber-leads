// Chat threads — DMs and groups — and the boundaries that make them safe.
//
// What is pinned here, because each one is a promise the UI makes out loud:
//   • ONE DM per pair, however many times or from whichever side it's opened.
//   • A DM is its two members' room: no third party lists it, reads it,
//     moderates inside it, or deletes it — no matter what capability they
//     hold. Managers moderate the floor, not private conversations.
//   • Groups are created and re-crewed by megaphone holders (team_lead+);
//     message-level moderation inside one additionally requires MEMBERSHIP.
//   • Every miss is 404, never 403 — a thread id must not confirm that
//     somebody else's conversation exists.
//   • Thread traffic never leaks into the floor, and the floor's GET carries
//     the all-threads unread total the nav badge shows.
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
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@floor-chat-threads.example.test`;
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

const post = (path: string, session: string, body: unknown) =>
  req(path, session, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-chat-threads-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA = person("Rep Ann", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.repB = person("Rep Bo", "rep", 1, { reportsToId: fx.lead.memberId });
  fx.caller = person("Cal Caller", "calling_rep");

  storage.createTenant({ slug: "other-threads", companyName: "Other", ownerName: "O", ownerEmail: "o@other-threads.test", brandName: "Other", brandColor: "#111", plan: "trial", status: "active" } as any);
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

let dmId = 0;      // repA ↔ repB
let dmMsg = 0;     // repA's message in the DM
let groupId = 0;   // Lee's "Lexington crew"

describe("opening a DM", () => {
  it("creates the pair's room once, from either side", async () => {
    const first = await post("/api/chat/threads", fx.repA.session, { kind: "dm", memberId: fx.repB.memberId });
    expect(first.status).toBe(201);
    dmId = (await first.json()).threadId;
    expect(dmId).toBeGreaterThan(0);

    // Same pair, other direction → the SAME room, not a fork.
    const again = await post("/api/chat/threads", fx.repB.session, { kind: "dm", memberId: fx.repA.memberId });
    expect(again.status).toBe(200);
    expect((await again.json()).threadId).toBe(dmId);
  });

  it("refuses yourself, desk identities, and desk callers", async () => {
    expect((await post("/api/chat/threads", fx.repA.session, { kind: "dm", memberId: fx.repA.memberId })).status).toBe(400);
    // A calling_rep holds no field.app.use — not enrollable, and not a caller.
    expect((await post("/api/chat/threads", fx.repA.session, { kind: "dm", memberId: fx.caller.memberId })).status).toBe(400);
    expect((await post("/api/chat/threads", fx.caller.session, { kind: "dm", memberId: fx.repA.memberId })).status).toBe(403);
  });
});

describe("a DM is its two members' room", () => {
  it("carries messages between the pair, with the unread contract intact", async () => {
    const r = await post(`/api/chat/threads/${dmId}`, fx.repA.session, { body: "got a minute before the 6pm push?" });
    expect(r.status).toBe(201);
    dmMsg = (await r.json()).id;

    const list = await (await req("/api/chat/threads", fx.repB.session)).json();
    expect(list.threads).toHaveLength(1);
    expect(list.threads[0].kind).toBe("dm");
    expect(list.threads[0].unread).toBe(1);
    expect(list.threads[0].lastMessage.body).toContain("6pm push");
    expect(list.threads[0].members.map((m: any) => m.userId).sort()).toEqual([fx.repA.userId, fx.repB.userId].sort());

    // The nav badge total rides the floor GET.
    const home = await (await req("/api/chat", fx.repB.session)).json();
    expect(home.threadsUnread).toBe(1);

    const page = await (await req(`/api/chat/threads/${dmId}`, fx.repB.session)).json();
    expect(page.items.map((m: any) => m.id)).toEqual([dmMsg]);

    const read = await post(`/api/chat/threads/${dmId}/read`, fx.repB.session, { upToId: page.latestId });
    expect((await read.json()).lastReadId).toBe(dmMsg);
    expect((await (await req("/api/chat", fx.repB.session)).json()).threadsUnread).toBe(0);
  });

  it("does not exist for anyone else — not even a manager", async () => {
    expect((await (await req("/api/chat/threads", fx.manager.session)).json()).threads).toHaveLength(0);
    expect((await req(`/api/chat/threads/${dmId}`, fx.manager.session)).status).toBe(404);
    expect((await post(`/api/chat/threads/${dmId}`, fx.manager.session, { body: "hi" })).status).toBe(404);
    expect((await req(`/api/chat/threads/${dmId}`, fx.foreignRep.session)).status).toBe(404);
  });

  it("lets nobody moderate inside it — own words only", async () => {
    // The manager holds the moderation capability; a DM still refuses them.
    expect((await req(`/api/chat/${dmMsg}`, fx.manager.session, { method: "DELETE" })).status).toBe(404);
    // The author may always remove their own words.
    const own = await req(`/api/chat/${dmMsg}`, fx.repA.session, { method: "DELETE" });
    expect((await own.json()).ok).toBe(true);
  });

  it("cannot be dissolved by a third party — group deletion skips DMs", async () => {
    const r = await req(`/api/chat/threads/${dmId}`, fx.manager.session, { method: "DELETE" });
    expect(r.status).toBe(404);
  });
});

describe("groups", () => {
  it("takes the megaphone capability to create one", async () => {
    const denied = await post("/api/chat/threads", fx.repA.session, {
      kind: "group", name: "Rep club", memberIds: [fx.repB.memberId],
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()).need).toBe("commission.structure.manage");

    expect((await post("/api/chat/threads", fx.lead.session, { kind: "group", name: "   ", memberIds: [fx.repA.memberId] })).status).toBe(400);
    expect((await post("/api/chat/threads", fx.lead.session, { kind: "group", name: "Ghost crew", memberIds: [] })).status).toBe(400);

    const r = await post("/api/chat/threads", fx.lead.session, {
      kind: "group", name: "Lexington crew", memberIds: [fx.repA.memberId, fx.repB.memberId],
    });
    expect(r.status).toBe(201);
    const body = await r.json();
    groupId = body.threadId;
    expect(body.name).toBe("Lexington crew");

    const list = await (await req("/api/chat/threads", fx.repA.session)).json();
    const group = list.threads.find((t: any) => t.id === groupId);
    expect(group.kind).toBe("group");
    expect(group.members).toHaveLength(3);
  });

  it("moderation inside needs the capability AND a seat in the room", async () => {
    const posted = await post(`/api/chat/threads/${groupId}`, fx.repA.session, { body: "crew: gate code is 4412" });
    const msg1 = (await posted.json()).id;

    // Lee: capability + member → moderates.
    expect((await (await req(`/api/chat/${msg1}`, fx.lead.session, { method: "DELETE" })).json()).ok).toBe(true);

    // Mona: capability, NOT a member → the room doesn't exist for her.
    const posted2 = await post(`/api/chat/threads/${groupId}`, fx.repA.session, { body: "take two" });
    const msg2 = (await posted2.json()).id;
    expect((await req(`/api/chat/${msg2}`, fx.manager.session, { method: "DELETE" })).status).toBe(404);

    // Re-crewing is structural: Mona can add herself, and THEN moderate.
    const joined = await post(`/api/chat/threads/${groupId}/members`, fx.manager.session, { addMemberIds: [fx.manager.memberId] });
    expect(joined.status).toBe(200);
    expect((await (await req(`/api/chat/threads/${groupId}`, fx.manager.session)).json()).items.length).toBeGreaterThan(0);
    expect((await (await req(`/api/chat/${msg2}`, fx.manager.session, { method: "DELETE" })).json()).ok).toBe(true);
  });

  it("re-crewing is capability-gated, and removal closes the door", async () => {
    expect((await post(`/api/chat/threads/${groupId}/members`, fx.repA.session, { removeUserIds: [fx.repB.userId] })).status).toBe(403);

    const r = await post(`/api/chat/threads/${groupId}/members`, fx.lead.session, { removeUserIds: [fx.repB.userId] });
    expect(r.status).toBe(200);
    expect((await req(`/api/chat/threads/${groupId}`, fx.repB.session)).status).toBe(404);
    expect((await (await req("/api/chat/threads", fx.repB.session)).json())
      .threads.some((t: any) => t.id === groupId)).toBe(false);
  });

  it("dissolves whole — messages, members, room — and then 404s", async () => {
    expect((await req(`/api/chat/threads/${groupId}`, fx.repA.session, { method: "DELETE" })).status).toBe(403);
    expect((await (await req(`/api/chat/threads/${groupId}`, fx.manager.session, { method: "DELETE" })).json()).ok).toBe(true);
    expect((await req(`/api/chat/threads/${groupId}`, fx.repA.session)).status).toBe(404);
    expect((await (await req("/api/chat/threads", fx.repA.session)).json())
      .threads.some((t: any) => t.id === groupId)).toBe(false);
  });
});

describe("group guardrails", () => {
  it("refuses a member array longer than the room's ceiling, before any lookup", async () => {
    const r = await post("/api/chat/threads", fx.lead.session, {
      kind: "group", name: "Everyone ever", memberIds: Array.from({ length: 31 }, (_, i) => i + 1),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("tops out");
  });

  it("refuses picks that can't chat, naming them — never a quietly smaller crew", async () => {
    const r = await post("/api/chat/threads", fx.lead.session, {
      kind: "group", name: "Ghost crew", memberIds: [fx.repA.memberId, fx.caller.memberId],
    });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.memberIds).toEqual([fx.caller.memberId]);
  });

  it("refuses a removal that would empty the room — disbanding is the honest verb", async () => {
    const made = await post("/api/chat/threads", fx.lead.session, {
      kind: "group", name: "Two of us", memberIds: [fx.repA.memberId],
    });
    const tid = (await made.json()).threadId;
    const r = await post(`/api/chat/threads/${tid}/members`, fx.lead.session, {
      removeUserIds: [fx.lead.userId, fx.repA.userId],
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("Disband");

    // Cleanup for the tests below.
    await req(`/api/chat/threads/${tid}`, fx.manager.session, { method: "DELETE" });
  });
});

describe("leaving a group", () => {
  let tid = 0;

  it("is any member's own choice — no capability, gone from their list, 404 after", async () => {
    tid = (await (await post("/api/chat/threads", fx.lead.session, {
      kind: "group", name: "Walkable", memberIds: [fx.repA.memberId, fx.repB.memberId],
    })).json()).threadId;

    const r = await post(`/api/chat/threads/${tid}/leave`, fx.repA.session, {});
    expect((await r.json()).ok).toBe(true);
    expect((await req(`/api/chat/threads/${tid}`, fx.repA.session)).status).toBe(404);
    expect((await (await req("/api/chat/threads", fx.repA.session)).json())
      .threads.some((t: any) => t.id === tid)).toBe(false);
    // Leaving twice is a miss, not an error loop.
    expect((await post(`/api/chat/threads/${tid}/leave`, fx.repA.session, {})).status).toBe(404);
  });

  it("never applies to a DM — you can't walk out of a two-person room", async () => {
    const dm = (await (await post("/api/chat/threads", fx.repA.session, { kind: "dm", memberId: fx.repB.memberId })).json()).threadId;
    expect((await post(`/api/chat/threads/${dm}/leave`, fx.repA.session, {})).status).toBe(404);
  });

  it("dissolves the room when the last member walks out — no orphaned messages", async () => {
    await post(`/api/chat/threads/${tid}/leave`, fx.repB.session, {});
    await post(`/api/chat/threads/${tid}/leave`, fx.lead.session, {});
    // Nothing left to find — not even for a capability holder by id.
    expect((await req(`/api/chat/threads/${tid}`, fx.manager.session, { method: "DELETE" })).status).toBe(404);
  });
});

describe("the floor stays the floor", () => {
  it("never serves thread messages, and threads never count against it", async () => {
    await post("/api/chat", fx.repA.session, { body: "floor only message" });
    // Fresh DM traffic to prove isolation both ways.
    const dm2 = (await (await post("/api/chat/threads", fx.repA.session, { kind: "dm", memberId: fx.lead.memberId })).json()).threadId;
    await post(`/api/chat/threads/${dm2}`, fx.repA.session, { body: "private aside" });

    const floor = await (await req("/api/chat", fx.repB.session)).json();
    expect(floor.items.map((m: any) => m.body)).toContain("floor only message");
    expect(floor.items.map((m: any) => m.body)).not.toContain("private aside");
    // repB is in neither the fresh DM nor anything unread — the total says so.
    expect(floor.threadsUnread).toBe(0);
    // The lead IS the DM's other member — one unread, on the nav total.
    expect((await (await req("/api/chat", fx.lead.session)).json()).threadsUnread).toBe(1);
  });
});
