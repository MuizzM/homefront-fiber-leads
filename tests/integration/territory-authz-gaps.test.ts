// Two holes an audit of the territory routes turned up, and the privacy leak
// sitting behind one of them.
//
// Both are the same class of mistake: a route that scopes the AREA correctly and
// then forgets to scope the thing it is about to do with it.
//
//   1. POST /:id/reclaim { mode: "reassign" } scoped the area and validated the
//      incoming rep's AREA CAP — and nothing else. Every other rep-taking route
//      (/share, /next-pass) validates the target's tenant and the caller's
//      visibility scope. This one did not, so a team lead could reclaim an area
//      they legitimately hold and hand it to a rep on another team, or another
//      tenant. A territory grab wearing a reclaim's clothes.
//
//   2. GET /:id/activity authorised on `territory.repId`. repId still names the
//      LAST holder after a reclaim, so a rep the area was taken from kept
//      reading its knock history — the exact defect already fixed for the lead
//      stream and the territory list, missed here. The same check 404'd a
//      SECONDARY assignee on a shared area, who genuinely holds it.
//
//   3. That same response carried every knock's rep NAME and rep GPS FIX to
//      anyone who passed the check. Door history is legitimate; a colleague's
//      movements are not.
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

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@authz-gaps.example.test`;
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

let patch = 0;
const nextWest = () => -83.4 + patch++ * 0.2;
function square(west: number, south: number): [number, number][] {
  const s = 0.03;
  return [[west, south], [west + s, south], [west + s, south + s], [west, south + s]];
}

const fx: Record<string, Person> = {};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-authz-gaps-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  fx.manager = person("Mona Manager", "manager");
  // Two teams under one manager. Each lead may only touch their own reps.
  fx.leadA = person("Lena LeadA", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.leadB = person("Levi LeadB", "team_lead", 1, { reportsToId: fx.manager.memberId });
  fx.repA = person("Rita RepA", "rep", 1, { reportsToId: fx.leadA.memberId });
  fx.repB = person("Rory RepB", "rep", 1, { reportsToId: fx.leadB.memberId });
  // A different tenant entirely.
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

/** An area held by a FRESH rep under leadA — legitimately manageable by leadA.
 *  Fresh, because MAX_ACTIVE_AREAS_PER_REP is 5 and reusing one rep across these
 *  specs makes the sixth assign 409 for reasons that have nothing to do with
 *  what is under test. */
let holderSeq = 0;
async function areaForLeadA(): Promise<{ id: number; holder: Person; west: number }> {
  const holder = person(`Hal Holder${holderSeq++}`, "rep", 1, { reportsToId: fx.leadA.memberId });
  const west = nextWest();
  const r = await req("/api/territories/assign-area", fx.leadA.session, {
    method: "POST",
    body: JSON.stringify({ polygon: square(west, 34.6), repId: holder.memberId, color: "#14C985" }),
  });
  expect(r.status).toBe(201);
  return { id: (await r.json() as any).territory.id, holder, west };
}

describe("reclaim-and-reassign cannot hand an area outside the caller's reach", () => {
  it("refuses a rep on another team", async () => {
    // leadA genuinely holds this area. The target is the hole.
    const { id } = await areaForLeadA();
    const res = await req(`/api/territories/${id}/reclaim`, fx.leadA.session, {
      method: "POST",
      body: JSON.stringify({ mode: "reassign", newRepId: fx.repB.memberId }),
    });
    expect(res.status).toBe(404);
  });

  it("refuses a rep in another tenant", async () => {
    const { id } = await areaForLeadA();
    const res = await req(`/api/territories/${id}/reclaim`, fx.leadA.session, {
      method: "POST",
      body: JSON.stringify({ mode: "reassign", newRepId: fx.foreign.memberId }),
    });
    expect(res.status).toBe(404);
  });

  it("leaves the area untouched when it refuses", async () => {
    // A rejected reassign must not half-apply — the area is still repA's.
    const { id, holder } = await areaForLeadA();
    await req(`/api/territories/${id}/reclaim`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: fx.repB.memberId }),
    });
    const after = storage.getTerritoryById(id) as any;
    expect(after.repId).toBe(holder.memberId);
    expect(after.status).toBe("active");
  });

  it("rejects a malformed target rather than coercing it", async () => {
    const { id } = await areaForLeadA();
    for (const bad of ["abc", -1, 0, 1.5]) {
      const res = await req(`/api/territories/${id}/reclaim`, fx.leadA.session, {
        method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: bad }),
      });
      expect([400, 404]).toContain(res.status);
    }
  });

  it("still allows a reassign the caller IS entitled to make", async () => {
    // The fix must not break the feature: a second rep under the same lead.
    const { id } = await areaForLeadA();
    const mate = person("Moe Mate", "rep", 1, { reportsToId: fx.leadA.memberId });
    const res = await req(`/api/territories/${id}/reclaim`, fx.leadA.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: mate.memberId }),
    });
    expect(res.status).toBe(200);
    expect((storage.getTerritoryById(id) as any).repId).toBe(mate.memberId);
  });

  it("lets a manager reassign across teams, because their scope is the org", async () => {
    const { id } = await areaForLeadA();
    const res = await req(`/api/territories/${id}/reclaim`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: fx.repB.memberId }),
    });
    expect(res.status).toBe(200);
  });
});

describe("area activity is authorised on who HOLDS the area", () => {
  it("stops serving a rep the area was reclaimed from", async () => {
    // repId still names them after the reclaim. That is exactly why testing it
    // is wrong: the field is history, not entitlement.
    const { id, holder } = await areaForLeadA();
    expect((await req(`/api/territories/${id}/activity`, holder.session)).status).toBe(200);

    await req(`/api/territories/${id}/reclaim`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    });

    expect((await req(`/api/territories/${id}/activity`, holder.session)).status).toBe(404);
  });

  it("serves a SECONDARY assignee on a shared area", async () => {
    // The old check was primary-only, so the second rep on a shared area was
    // refused their own area's history.
    const { id, holder } = await areaForLeadA();
    const second = person("Sid Second", "rep", 1, { reportsToId: fx.leadA.memberId });
    const shared = await req(`/api/territories/${id}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [holder.memberId, second.memberId] }),
    });
    expect(shared.status).toBe(200);

    expect((await req(`/api/territories/${id}/activity`, second.session)).status).toBe(200);
  });

  it("still refuses a rep who never held it", async () => {
    const { id } = await areaForLeadA();
    expect((await req(`/api/territories/${id}/activity`, fx.repB.session)).status).toBe(404);
  });

  it("refuses another tenant outright", async () => {
    const { id } = await areaForLeadA();
    expect((await req(`/api/territories/${id}/activity`, fx.foreign.session)).status).toBe(404);
  });
});

describe("one rep cannot read another rep's identity or GPS from an area's history", () => {
  /** Put a knock from `who` on a door inside `id`, and return the lead id. */
  function knockInside(id: number, who: Person, west: number) {
    const s = 0.03;
    const lead = storage.createLead({
      tenantId: 1, address: `${100 + patch} Shared St`, city: "Testville", state: "NC", zip: "27000",
      lat: 34.6 + s / 2, lng: west + s / 2, status: "new",
    } as any);
    storage.createKnock({
      tenantId: 1, leadId: lead.id, repId: who.memberId, outcome: "not_home",
      wasHome: false, knockedAt: new Date().toISOString(),
      repLat: 34.61, repLng: west + 0.01,
    } as any);
    return lead.id;
  }

  it("redacts a colleague's name and GPS fix, while keeping the door history", async () => {
    const west = nextWest();
    const r = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: square(west, 34.6), repId: fx.repA.memberId, color: "#F97316" }),
    });
    const id = (await r.json() as any).territory.id;
    const mate = person("Nia Neighbour", "rep", 1, { reportsToId: fx.leadB.memberId });
    knockInside(id, mate, west);

    await req(`/api/territories/${id}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA.memberId] }),
    });

    const rows = await (await req(`/api/territories/${id}/activity`, fx.repA.session)).json() as any;
    const list = Array.isArray(rows) ? rows : rows.activities ?? [];
    const foreignKnock = list.find((a: any) => a.leadLat != null);

    expect(foreignKnock, "the knock should still be visible as door history").toBeDefined();
    expect(foreignKnock.rep).toBeNull();       // who: hidden
    expect(foreignKnock.repLat).toBeNull();    // where they stood: hidden
    expect(foreignKnock.repLng).toBeNull();
    expect(foreignKnock.outcome).toBeTruthy(); // what happened at the door: kept
    expect(foreignKnock.leadLat).not.toBeNull(); // the PROPERTY's location is not a person
  });

  it("shows a manager everything, because their scope is the org", async () => {
    const west = nextWest();
    const r = await req("/api/territories/assign-area", fx.manager.session, {
      method: "POST",
      body: JSON.stringify({ polygon: square(west, 34.6), repId: fx.repA.memberId, color: "#8B5CF6" }),
    });
    const id = (await r.json() as any).territory.id;
    knockInside(id, fx.repA, west);

    const rows = await (await req(`/api/territories/${id}/activity`, fx.manager.session)).json() as any;
    const list = Array.isArray(rows) ? rows : rows.activities ?? [];
    const seen = list.find((a: any) => a.rep != null);
    expect(seen, "a manager must still be able to review who knocked").toBeDefined();
    expect(seen.repLat).not.toBeNull();
  });
});
