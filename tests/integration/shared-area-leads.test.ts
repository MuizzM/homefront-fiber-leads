// Shared areas: several reps work the same ground and the same doors.
//
// The defect: leads.assigned_rep_id names ONE rep. Access and the map both hung
// on that column, so on a shared area exactly one assignee saw the doors and
// every other assignee got an empty map for ground they were assigned to.
//
// Access now also passes through the AREA, which is where "who works this" is
// genuinely many-to-many. These tests pin both halves — the sharing works, and
// the tenant wall is untouched by it.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1, reportsToId: number | null = null) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@shared.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { memberId: m.id, userId: u.id, session: storage.createSession(u.id).id };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) } });
}
const SQ = [[-80.41, 35.49], [-80.39, 35.49], [-80.39, 35.51], [-80.41, 35.51], [-80.41, 35.49]];
let n = 0;

function sharedArea(repIds: number[], tenantId = 1) {
  return storage.createTerritory({
    tenantId, name: `Shared ${++n}`, repId: repIds[0], polygon: JSON.stringify(SQ),
    color: "#3EA394", status: repIds.length > 1 ? "shared" : "active",
    assigneeIds: JSON.stringify(repIds),
  } as any).id;
}
function lead(territoryId: number, repId: number | null, tenantId = 1) {
  return storage.createLead({
    address: `${++n} Shared St`, city: "Testburg", state: "NC", zip: "28100",
    lat: 35.50, lng: -80.40, tenantId, assignedRepId: repId,
    assignedTerritoryId: territoryId, leadStatus: "prospect",
  } as any).id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-shared-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  fx.manager = person("Mona Manager", "manager");
  fx.repA = person("Ann Rivera", "rep", 1, fx.manager?.memberId ?? null);
  fx.repB = person("Bo Chen", "rep", 1, fx.manager?.memberId ?? null);
  fx.outsider = person("Cam Outside", "rep");
  storage.createTenant({ slug: "other-shared", companyName: "O", ownerName: "O",
    ownerEmail: "o@othershared.test", brandName: "O", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreign = person("Zed Foreign", "rep", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe("both reps on a shared area see the same doors", () => {
  it("the non-primary assignee can open a lead they don't directly hold", async () => {
    // THE bug: the door is stamped repA, but repB is on the area too.
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);
    expect((await req(`/api/leads/${id}`, fx.repA.session)).status).toBe(200);
    expect((await req(`/api/leads/${id}`, fx.repB.session)).status).toBe(200);
  });

  it("the door appears on BOTH reps' maps, once each", async () => {
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);
    for (const who of [fx.repA, fx.repB]) {
      const body = await (await req("/api/leads/map", who.session)).json();
      const hits = (body.pins ?? []).filter((p: any) => p.id === id);
      // Exactly one — a join across assignees would fan out and double the pin.
      expect(hits).toHaveLength(1);
    }
  });

  it("a rep NOT on the area still cannot see it", async () => {
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);
    expect((await req(`/api/leads/${id}`, fx.outsider.session)).status).toBe(404);
    const body = await (await req("/api/leads/map", fx.outsider.session)).json();
    expect((body.pins ?? []).some((p: any) => p.id === id)).toBe(false);
  });

  it("removing a rep from the area removes their access", async () => {
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);
    expect((await req(`/api/leads/${id}`, fx.repB.session)).status).toBe(200);

    await req(`/api/territories/${area}/share`, fx.manager.session, {
      method: "POST", body: JSON.stringify({ repIds: [fx.repA.memberId] }),
    });
    expect((await req(`/api/leads/${id}`, fx.repB.session)).status).toBe(404);
  });

  // ── The wall sharing must not breach ────────────────────────────────────────
  it("never crosses the tenant boundary, even for an identically-shaped area", async () => {
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);
    expect((await req(`/api/leads/${id}`, fx.foreign.session)).status).toBe(404);
    const body = await (await req("/api/leads/map", fx.foreign.session)).json();
    expect((body.pins ?? []).some((p: any) => p.id === id)).toBe(false);
  });

  it("a lead with no area is still only its own rep's", async () => {
    // The area path must not become a way to see unassigned-to-you loose leads.
    const id = lead(null as any, fx.repA.memberId);
    expect((await req(`/api/leads/${id}`, fx.repB.session)).status).toBe(404);
  });
});

describe("an update by one rep is visible to the other", () => {
  it("a knock by rep A shows in rep B's read of the same door", async () => {
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);

    const res = await req(`/api/leads/${id}/knock`, fx.repA.session, {
      method: "POST", body: JSON.stringify({ outcome: "sold", wasHome: true }),
    });
    expect([200, 201]).toContain(res.status);

    // B reads the same door and sees A's outcome — one row of truth, no copy.
    const seen = await (await req(`/api/leads/${id}`, fx.repB.session)).json();
    expect(seen.leadStatus).toBe("sold");

    // …and the history credits A, not B.
    const hist = await (await req(`/api/leads/${id}/history`, fx.repB.session)).json();
    expect(hist.length).toBeGreaterThan(0);
    expect(hist[0].actor).toBe("Ann Rivera");
  });

  it("the second rep can also knock it — shared means shared", async () => {
    const area = sharedArea([fx.repA.memberId, fx.repB.memberId]);
    const id = lead(area, fx.repA.memberId);
    const res = await req(`/api/leads/${id}/knock`, fx.repB.session, {
      method: "POST", body: JSON.stringify({ outcome: "not_home", wasHome: false }),
    });
    expect([200, 201]).toContain(res.status);
  });
});
