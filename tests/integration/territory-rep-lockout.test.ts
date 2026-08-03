// Fixture accounts are marked TRAINED. New accounts now owe training before the
// field opens (server/trainingGateStore.ts); these suites are about territory,
// RBAC, spiffs, and offboarding, so their people start on the far side of that
// gate rather than every assertion here re-testing it.
// A rep holds ground. A rep does not MANAGE ground.
//
// Every territory management route is reachable by anyone with a session, so the
// only thing standing between a rep and reassigning/renaming/deleting the area
// they are standing in is the role gate on the route. This file proves that gate
// exists on ALL of them, using the strong case: a rep who genuinely HOLDS the
// area. "Not your area" is not an acceptable reason for the refusal here —
// it is the area's holder asking, so a missing role check would sail straight
// through the ownership guard (canManageTerritory returns TRUE for the holder).
//
// The mirror-image assertion matters just as much: that same rep must keep
// reading their own area's stats and knock history. Locking a rep out of
// management must not lock them out of their job.
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

let personSeq = 0;
function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}.${personSeq++}@rep-lockout.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  __gateDb?.prepare("UPDATE users SET training_required = 0 WHERE id = ?").run((user as any).id);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) },
  });
}

let patch = 0;
const nextWest = () => -87.4 + patch++ * 0.2;
function square(west: number, south: number): [number, number][] {
  const s = 0.03;
  return [[west, south], [west + s, south], [west + s, south + s], [west, south + s]];
}

const fx: Record<string, Person> = {};

let __gateDb: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rep-lockout-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb: __gateDb } = await import("../../server/db"));

  fx.manager = person("Mona Manager", "manager");
  fx.leadA = person("Lena LeadA", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.leadB = person("Levi LeadB", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repB = person("Rory RepB", "rep", 1, { reportsToId: fx.leadB.memberId });
  fx.foreign = person("Fay Foreign", "rep", 2);

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

type Held = { id: number; holder: Person; west: number };

/** An area a FRESH rep under leadA genuinely holds. Fresh every time, because
 *  MAX_ACTIVE_AREAS_PER_REP is 5 and a shared holder would start 409ing on the
 *  sixth area for reasons that have nothing to do with authorization. */
let holderSeq = 0;
async function heldArea(): Promise<Held> {
  const holder = person(`Hank Holder${holderSeq++}`, "rep", 1, { reportsToId: fx.leadA.memberId });
  const west = nextWest();
  const r = await req("/api/territories/assign-area", fx.manager.session, {
    method: "POST",
    body: JSON.stringify({ polygon: square(west, 34.6), repId: holder.memberId, color: "#14C985", name: `Area ${holderSeq}` }),
  });
  expect(r.status).toBe(201);
  return { id: (await r.json() as any).territory.id, holder, west };
}

/** The fields a management action would move. Snapshot before, compare after —
 *  a 403/404 that still wrote something is not a refusal. */
function snapshot(id: number) {
  const t = storage.getTerritoryById(id) as any;
  if (!t) return null;
  return { repId: t.repId, status: t.status, name: t.name, color: t.color, assigneeIds: t.assigneeIds };
}

/** Every route that MANAGES an area, invoked by whoever `caller` says.
 *  Each takes the area and its holder so a caller can aim the action at the
 *  legitimate holder — the strongest form of "this should still be refused". */
type Invoke = (id: number, held: Held, session: string) => Promise<Response>;

const MANAGEMENT: { label: string; invoke: Invoke }[] = [
  {
    label: "POST /:id/assign",
    invoke: (id, held, s) => req(`/api/territories/${id}/assign`, s, { method: "POST", body: JSON.stringify({ repId: held.holder.memberId }) }),
  },
  {
    label: "POST /:id/share",
    invoke: (id, held, s) => req(`/api/territories/${id}/share`, s, { method: "POST", body: JSON.stringify({ repIds: [held.holder.memberId] }) }),
  },
  {
    label: "POST /:id/unassign",
    invoke: (id, held, s) => req(`/api/territories/${id}/unassign`, s, { method: "POST", body: JSON.stringify({ repId: held.holder.memberId }) }),
  },
  {
    label: "POST /:id/reclaim",
    invoke: (id, _held, s) => req(`/api/territories/${id}/reclaim`, s, { method: "POST", body: JSON.stringify({ mode: "return_to_pool" }) }),
  },
  {
    label: "POST /:id/complete",
    invoke: (id, _held, s) => req(`/api/territories/${id}/complete`, s, { method: "POST", body: JSON.stringify({ notes: "done" }) }),
  },
  {
    label: "POST /:id/archive",
    invoke: (id, _held, s) => req(`/api/territories/${id}/archive`, s, { method: "POST", body: JSON.stringify({}) }),
  },
  {
    label: "PATCH /:id (rename)",
    invoke: (id, _held, s) => req(`/api/territories/${id}`, s, { method: "PATCH", body: JSON.stringify({ name: "Mine now" }) }),
  },
  {
    label: "PATCH /:id (recolour)",
    invoke: (id, _held, s) => req(`/api/territories/${id}`, s, { method: "PATCH", body: JSON.stringify({ color: "#FF0000" }) }),
  },
  {
    label: "DELETE /:id",
    invoke: (id, _held, s) => req(`/api/territories/${id}`, s, { method: "DELETE" }),
  },
  {
    label: "POST /:id/next-pass",
    invoke: (id, _held, s) => req(`/api/territories/${id}/next-pass`, s, { method: "POST", body: JSON.stringify({ territoryAction: "keep" }) }),
  },
  {
    label: "GET /:id/next-pass/preview",
    invoke: (id, _held, s) => req(`/api/territories/${id}/next-pass/preview`, s),
  },
];

describe("a rep cannot manage the area they hold", () => {
  // assign-area has no :id — it MAKES an area, which is the management action.
  it("refuses POST /assign-area, even to themselves", async () => {
    const rep = person("Solo Selfassign", "rep", 1, { reportsToId: fx.leadA.memberId });
    const before = storage.getTerritoriesByRep(rep.memberId).length;
    const res = await req("/api/territories/assign-area", rep.session, {
      method: "POST",
      body: JSON.stringify({ polygon: square(nextWest(), 34.6), repId: rep.memberId, color: "#14C985" }),
    });
    expect([403, 404]).toContain(res.status);
    expect(storage.getTerritoriesByRep(rep.memberId).length).toBe(before);
  });

  it("refuses POST /api/territories (raw create)", async () => {
    const rep = person("Raw Creator", "rep", 1, { reportsToId: fx.leadA.memberId });
    const res = await req("/api/territories", rep.session, {
      method: "POST",
      body: JSON.stringify({ name: "Smuggled", polygon: JSON.stringify(square(nextWest(), 34.6)), repId: rep.memberId, color: "#14C985" }),
    });
    expect([403, 404]).toContain(res.status);
  });

  for (const { label, invoke } of MANAGEMENT) {
    it(`refuses ${label}`, async () => {
      const held = await heldArea();
      const before = snapshot(held.id);
      expect(before, "the fixture area must exist before the attempt").not.toBeNull();

      const res = await invoke(held.id, held, held.holder.session);
      expect([403, 404], `${label} let a rep through with ${res.status}`).toContain(res.status);

      // Refused means nothing moved — not "refused, but the write already landed".
      expect(snapshot(held.id), `${label} mutated the area it refused`).toEqual(before);
    });
  }
});

describe("a rep keeps read access to the area they hold", () => {
  it("lists it in GET /api/territories", async () => {
    const { id, holder } = await heldArea();
    const res = await req("/api/territories", holder.session);
    expect(res.status).toBe(200);
    const list = await res.json() as any[];
    expect(list.map((t) => t.id)).toContain(id);
    // ...and only theirs. A read grant is not an org-wide one.
    const other = await heldArea();
    const list2 = await (await req("/api/territories", holder.session)).json() as any[];
    expect(list2.map((t) => t.id)).not.toContain(other.id);
  });

  it("returns its numbers from GET /api/territories/progress", async () => {
    const { id, holder } = await heldArea();
    const res = await req("/api/territories/progress", holder.session);
    expect(res.status).toBe(200);
    const rows = await res.json() as any[];
    const mine = rows.find((r) => r.territoryId === id || r.id === id);
    expect(mine, "the holder must see their own area's progress card").toBeDefined();
  });

  it("serves GET /:id/activity", async () => {
    const { id, holder } = await heldArea();
    const res = await req(`/api/territories/${id}/activity`, holder.session);
    expect(res.status).toBe(200);
  });

  it("still refuses reads for an area they do NOT hold", async () => {
    const mine = await heldArea();
    const theirs = await heldArea();
    expect((await req(`/api/territories/${theirs.id}/activity`, mine.holder.session)).status).toBe(404);
    const list = await (await req("/api/territories", mine.holder.session)).json() as any[];
    expect(list.map((t) => t.id)).not.toContain(theirs.id);
  });

  it("reads survive every refused management attempt", async () => {
    // The point of the whole file in one spec: locked out of management, still
    // fully able to work the ground.
    const held = await heldArea();
    for (const { invoke } of MANAGEMENT) await invoke(held.id, held, held.holder.session);
    expect((await req(`/api/territories/${held.id}/activity`, held.holder.session)).status).toBe(200);
    const list = await (await req("/api/territories", held.holder.session)).json() as any[];
    expect(list.map((t) => t.id)).toContain(held.id);
  });
});

describe("a rep cannot escalate by naming a different rep", () => {
  it("cannot draw an area onto another rep", async () => {
    const rep = person("Grabby Rep", "rep", 1, { reportsToId: fx.leadA.memberId });
    const victim = person("Victim Rep", "rep", 1, { reportsToId: fx.leadA.memberId });
    const before = storage.getTerritoriesByRep(victim.memberId).length;
    const res = await req("/api/territories/assign-area", rep.session, {
      method: "POST",
      body: JSON.stringify({ polygon: square(nextWest(), 34.6), repId: victim.memberId, color: "#14C985" }),
    });
    expect([403, 404]).toContain(res.status);
    expect(storage.getTerritoriesByRep(victim.memberId).length).toBe(before);
  });

  it("cannot hand their own area to someone else via /reclaim reassign", async () => {
    const held = await heldArea();
    const before = snapshot(held.id);
    const res = await req(`/api/territories/${held.id}/reclaim`, held.holder.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: fx.repB.memberId }),
    });
    expect([403, 404]).toContain(res.status);
    expect(snapshot(held.id)).toEqual(before);
  });

  it("cannot pull a teammate onto their area via /share", async () => {
    const held = await heldArea();
    const mate = person("Mate Rep", "rep", 1, { reportsToId: fx.leadA.memberId });
    const before = snapshot(held.id);
    const res = await req(`/api/territories/${held.id}/share`, held.holder.session, {
      method: "POST", body: JSON.stringify({ repIds: [held.holder.memberId, mate.memberId] }),
    });
    expect([403, 404]).toContain(res.status);
    expect(snapshot(held.id)).toEqual(before);
    expect(storage.getTerritoriesByRep(mate.memberId).map((t: any) => t.id)).not.toContain(held.id);
  });

  it("cannot push a teammate off an area via /unassign", async () => {
    const held = await heldArea();
    const mate = person("Sticky Mate", "rep", 1, { reportsToId: fx.leadA.memberId });
    const shared = await req(`/api/territories/${held.id}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [held.holder.memberId, mate.memberId] }),
    });
    expect(shared.status).toBe(200);

    const before = snapshot(held.id);
    const res = await req(`/api/territories/${held.id}/unassign`, held.holder.session, {
      method: "POST", body: JSON.stringify({ repId: mate.memberId }),
    });
    expect([403, 404]).toContain(res.status);
    expect(snapshot(held.id)).toEqual(before);
    // The mate is still on the area, and can still read it.
    expect((await req(`/api/territories/${held.id}/activity`, mate.session)).status).toBe(200);
  });

  it("cannot spoof a privileged role in the request body", async () => {
    // Role comes from the session's user row, never the payload.
    const held = await heldArea();
    const before = snapshot(held.id);
    const res = await req(`/api/territories/${held.id}`, held.holder.session, {
      method: "PATCH",
      body: JSON.stringify({ name: "Escalated", role: "manager", user: { role: "admin" }, tenantId: 1 }),
    });
    expect([403, 404]).toContain(res.status);
    expect(snapshot(held.id)).toEqual(before);
  });

  it("refuses a rep from another tenant outright", async () => {
    const held = await heldArea();
    const before = snapshot(held.id);
    for (const { invoke } of MANAGEMENT) {
      const res = await invoke(held.id, held, fx.foreign.session);
      expect([403, 404]).toContain(res.status);
    }
    expect(snapshot(held.id)).toEqual(before);
  });
});

describe("a team lead cannot act on an area outside their own reps", () => {
  // leadB outranks a rep, so rank alone would let these through — scope is what
  // stops them. These share the rep-lockout table because the routes are the same.
  for (const { label, invoke } of MANAGEMENT) {
    it(`refuses leadB on leadA's area: ${label}`, async () => {
      const held = await heldArea(); // holder reports to leadA
      const before = snapshot(held.id);
      const res = await invoke(held.id, held, fx.leadB.session);
      expect([403, 404], `${label} let a foreign team lead through with ${res.status}`).toContain(res.status);
      expect(snapshot(held.id), `${label} mutated an area outside the lead's team`).toEqual(before);
    });
  }

  it("still lets leadA manage their OWN rep's area", async () => {
    // The lockout must not become a blanket denial: the legitimate case works.
    const held = await heldArea();
    const res = await req(`/api/territories/${held.id}`, fx.leadA.session, {
      method: "PATCH", body: JSON.stringify({ name: "Renamed by LeadA" }),
    });
    expect(res.status).toBe(200);
    expect((storage.getTerritoryById(held.id) as any).name).toBe("Renamed by LeadA");
  });

  it("still lets a manager manage any area in the tenant", async () => {
    const held = await heldArea();
    const res = await req(`/api/territories/${held.id}/complete`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ notes: "wrapped" }),
    });
    expect(res.status).toBe(200);
    expect((storage.getTerritoryById(held.id) as any).status).toBe("completed");
  });
});
