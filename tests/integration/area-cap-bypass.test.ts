// The max-active-areas cap, enforced consistently.
//
// canRepTakeAnotherArea exists so a rep can't be buried under more ground than
// they can knock — 5 areas. /assign checks it. Three other routes hand a rep an
// area without checking anything: reclaim in reassign mode, share, and next-pass
// in reassign mode. Any of them walks a rep straight past the cap, which makes
// the cap advisory rather than real.
//
// The failure isn't theoretical: "reclaim from Ann and give it to Bo" is the
// single most common way an area changes hands, and it was the one path that
// never asked whether Bo could take it.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ACTIVE_AREAS_PER_REP } from "../../shared/territory";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

function person(name: string, role: string, tenantId = 1, opts: { reportsToId?: number | null } = {}): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@cap.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId: opts.reportsToId ?? null } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers },
  });
}

let n = 0;
function square() {
  // Distinct polygons so areas don't overlap into each other's lead sets.
  const b = 35 + (++n) * 0.05;
  return [[-80.4, b], [-80.38, b], [-80.38, b + 0.02], [-80.4, b + 0.02], [-80.4, b]];
}

function seedArea(repId: number, status = "active") {
  return storage.createTerritory({
    tenantId: 1, name: `Area ${n}`, repId, polygon: JSON.stringify(square()),
    color: "#3EA394", status, assigneeIds: JSON.stringify(status === "unassigned" ? [] : [repId]),
  } as any).id;
}

/** Fill a rep right up to the cap so the next area is the one too many. */
function fillToCap(repId: number) {
  for (let i = 0; i < MAX_ACTIVE_AREAS_PER_REP; i++) seedArea(repId);
}

const activeAreaCount = (repId: number) =>
  storage.getTerritoriesByRep(repId).filter((t: any) => t.status === "active" || t.status === "shared").length;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cap-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  fx.manager = person("Mona Manager", "manager");
  fx.donor = person("Dana Donor", "rep", 1, { reportsToId: fx.manager.memberId });
  fx.full = person("Fay Full", "rep", 1, { reportsToId: fx.manager.memberId });

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => new Promise<void>(r => server.close(() => r())));

describe(`a rep at the ${MAX_ACTIVE_AREAS_PER_REP}-area cap cannot be given more`, () => {
  it("via /assign - the path that already checked", async () => {
    fillToCap(fx.full.memberId);
    const pooled = seedArea(fx.donor.memberId, "unassigned");
    const res = await req(`/api/territories/${pooled}/assign`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repId: fx.full.memberId }),
    });
    expect(res.status).toBe(409);
  });

  it("via /reclaim in reassign mode", async () => {
    // The everyday "take it off Ann, give it to Bo" move.
    const before = activeAreaCount(fx.full.memberId);
    const area = seedArea(fx.donor.memberId);
    const res = await req(`/api/territories/${area}/reclaim`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: fx.full.memberId }),
    });
    expect(res.status).toBe(409);
    expect(activeAreaCount(fx.full.memberId)).toBe(before);
  });

  it("via /share", async () => {
    const before = activeAreaCount(fx.full.memberId);
    const area = seedArea(fx.donor.memberId);
    const res = await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.donor.memberId, fx.full.memberId] }),
    });
    expect(res.status).toBe(409);
    expect(activeAreaCount(fx.full.memberId)).toBe(before);
  });

  it("via /next-pass in reassign mode", async () => {
    const before = activeAreaCount(fx.full.memberId);
    const area = seedArea(fx.donor.memberId);
    const res = await req(`/api/territories/${area}/next-pass`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ territoryAction: "reassign", newRepId: fx.full.memberId }),
    });
    expect(res.status).toBe(409);
    expect(activeAreaCount(fx.full.memberId)).toBe(before);
    // And the refusal must land BEFORE the reset: a rejected hand-off must not
    // have already wiped the area's outcomes on the way out.
    const passes = await (await req(`/api/territories/${area}/passes`, fx.manager.session)).json();
    expect(passes.passes).toHaveLength(0);
    expect(passes.currentPass).toBe(1);
  });
});

describe("the cap does not block legitimate moves", () => {
  it("a rep below the cap can still be handed an area by reclaim", async () => {
    const room = person("Ray Room", "rep", 1, { reportsToId: fx.manager.memberId });
    const area = seedArea(fx.donor.memberId);
    const res = await req(`/api/territories/${area}/reclaim`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ mode: "reassign", newRepId: room.memberId }),
    });
    expect(res.status).toBe(200);
    expect(activeAreaCount(room.memberId)).toBe(1);
  });

  it("returning an area to the pool is never capped - it frees ground, not takes it", async () => {
    const area = seedArea(fx.full.memberId);
    const res = await req(`/api/territories/${area}/reclaim`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ mode: "return_to_pool" }),
    });
    expect(res.status).toBe(200);
  });

  it("a rep already ON the area keeps it when others are added by share", async () => {
    // Re-sharing an area a rep already holds must not count as a new area and
    // trip the cap against them.
    const holder = person("Hal Holder", "rep", 1, { reportsToId: fx.manager.memberId });
    const area = seedArea(holder.memberId);
    for (let i = 0; i < MAX_ACTIVE_AREAS_PER_REP - 1; i++) seedArea(holder.memberId);
    const res = await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [holder.memberId] }),
    });
    expect(res.status).toBe(200);
  });
});
