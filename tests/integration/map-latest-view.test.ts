// ?view=latest — the "Latest fiber" lens across ALL FOUR map surfaces.
//
// Pins the contract the default map view depends on:
//   - the full feed, bbox windows, the count probe, AND the density grid all
//     drop lead_tag='fcc_fiber_d25' and keep everything else (NULL tags,
//     fcc_fresh_block, field-verified, organic) — one shared predicate, so
//     the counts agree across every tier
//   - the EXISTING tenant/rep scoping is preserved under the lens, and a
//     cross-tenant request is EMPTY
//   - an absent view is byte-stable: the unfiltered feed still ships the
//     footprint, its ETag shape is unchanged, and the two views' caches/ETags
//     can never validate each other
//   - garbage views are a 400 everywhere
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any;
const fx: Record<string, any> = {};
const ids: Record<string, number> = {};

function person(name: string, role: string, tenantId = 1, reportsToId: number | null = null) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@latest.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { memberId: m.id, userId: u.id, session: storage.createSession(u.id).id };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...init.headers } });
}

let n = 0;
function lead(tenantId: number, repId: number | null, lat: number, lng: number, extra: Record<string, any> = {}) {
  return storage.createLead({
    address: `${++n} Lens St`, city: "Testburg", state: "NC", zip: "28100",
    lat, lng, tenantId, assignedRepId: repId, leadStatus: "prospect", ...extra,
  } as any).id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-latest-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  fx.manager = person("Marge Manager", "manager");
  fx.rep = person("Rita Rep", "rep", 1, fx.manager.memberId);
  storage.createTenant({ slug: "other-latest", companyName: "O", ownerName: "O",
    ownerEmail: "o@otherlatest.test", brandName: "O", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreign = person("Frank Foreign", "manager", 2);

  // The lens population, all inside the test window (-80.6..-80.1, 35.4..35.6):
  ids.fiber1 = lead(1, null, 35.50, -80.40, { leadTag: "fcc_fiber_d25" });
  ids.fiber2 = lead(1, null, 35.51, -80.41, { leadTag: "fcc_fiber_d25", freshConfirmedAt: "2026-07-01T00:00:00Z" });
  ids.fresh = lead(1, null, 35.52, -80.42, { leadTag: "fcc_fresh_block" });
  ids.untagged = lead(1, null, 35.53, -80.43); // NULL tag — organic/manual add
  ids.otherTag = lead(1, null, 35.54, -80.44, { leadTag: "hot_lead" });
  ids.verified = lead(1, null, 35.55, -80.45, { freshConfirmedAt: "2026-07-02T00:00:00Z" });
  ids.repFiber = lead(1, fx.rep.memberId, 35.56, -80.46, { leadTag: "fcc_fiber_d25" });
  ids.repDoor = lead(1, fx.rep.memberId, 35.57, -80.47);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const LATEST_KEPT = () => [ids.fresh, ids.untagged, ids.otherTag, ids.verified, ids.repDoor];
const LATEST_DROPPED = () => [ids.fiber1, ids.fiber2, ids.repFiber];

describe("view=latest - full feed", () => {
  it("drops the footprint import and keeps NULL/fresh/organic/verified pins", async () => {
    const body = await (await req("/api/leads/map?view=latest", fx.manager.session)).json();
    const pinIds = body.pins.map((p: any) => p.id);
    for (const id of LATEST_KEPT()) expect(pinIds).toContain(id);
    for (const id of LATEST_DROPPED()) expect(pinIds).not.toContain(id);
    expect("truncated" in body).toBe(false);
  });

  it("its total agrees with the filtered count probe (feed ≡ count)", async () => {
    const feed = await (await req("/api/leads/map?view=latest", fx.manager.session)).json();
    const count = await (await req("/api/leads/map/count?view=latest", fx.manager.session)).json();
    expect(feed.pins.length).toBe(count.total);
    const all = await (await req("/api/leads/map/count", fx.manager.session)).json();
    expect(all.total).toBe(count.total + LATEST_DROPPED().length);
  });

  it("the lens has its own ETag: 304 works and never validates the unfiltered feed", async () => {
    const latest = await req("/api/leads/map?view=latest", fx.manager.session);
    const latestEtag = latest.headers.get("etag")!;
    expect(latestEtag).toContain("-latest-");
    const res304 = await fetch(`${baseUrl}/api/leads/map?view=latest`, {
      headers: { "x-session-id": fx.manager.session, "if-none-match": latestEtag },
    });
    expect(res304.status).toBe(304);
    // …and the byte-stable rule: the unfiltered ETag keeps its old shape.
    const unfiltered = await req("/api/leads/map", fx.manager.session);
    const allEtag = unfiltered.headers.get("etag")!;
    expect(allEtag).not.toContain("-latest-");
    expect(allEtag).not.toBe(latestEtag);
    // Cache separation: after the filtered feed was served, the unfiltered
    // feed STILL ships the footprint (one tap away, never deleted).
    const allBody = await unfiltered.json();
    const allIds = allBody.pins.map((p: any) => p.id);
    for (const id of LATEST_DROPPED()) expect(allIds).toContain(id);
  });
});

describe("view=latest - bbox windows", () => {
  const bbox = "bbox=-80.6,35.4,-80.1,35.6";

  it("filters the window exactly like the feed (and the window count agrees)", async () => {
    const body = await (await req(`/api/leads/map?${bbox}&view=latest`, fx.manager.session)).json();
    const pinIds = body.pins.map((p: any) => p.id);
    expect(pinIds.sort((a: number, b: number) => a - b)).toEqual(LATEST_KEPT().sort((a, b) => a - b));
    expect(body.truncated).toBe(false);
  });

  it("composes with the tag family lens (tag=fcc + view=latest → fresh only)", async () => {
    const body = await (await req(`/api/leads/map?${bbox}&view=latest&tag=fcc`, fx.manager.session)).json();
    expect(body.pins.map((p: any) => p.id)).toEqual([ids.fresh]);
  });

  it("the unfiltered window still ships the footprint", async () => {
    const body = await (await req(`/api/leads/map?${bbox}`, fx.manager.session)).json();
    const pinIds = body.pins.map((p: any) => p.id);
    for (const id of [...LATEST_KEPT(), ...LATEST_DROPPED()]) expect(pinIds).toContain(id);
  });
});

describe("view=latest - density grid", () => {
  const grid = "/api/leads/map/grid?bbox=-80.6,35.4,-80.1,35.6&cell=0.5";
  const sum = (cells: Array<{ n: number }>) => cells.reduce((a, c) => a + c.n, 0);

  it("counts only the lens population", async () => {
    const body = await (await req(`${grid}&view=latest`, fx.manager.session)).json();
    expect(sum(body.cells)).toBe(LATEST_KEPT().length);
    const all = await (await req(grid, fx.manager.session)).json();
    expect(sum(all.cells)).toBe(LATEST_KEPT().length + LATEST_DROPPED().length);
  });

  it("the grid total agrees with the filtered count probe over the window", async () => {
    // The probe is scope-wide (no bbox), so compare against the windowed pin
    // count instead: same predicate, different rendering.
    const body = await (await req(`${grid}&view=latest`, fx.manager.session)).json();
    const win = await (await req("/api/leads/map?bbox=-80.6,35.4,-80.1,35.6&view=latest", fx.manager.session)).json();
    expect(sum(body.cells)).toBe(win.pins.length);
  });
});

describe("view=latest - scoping preserved", () => {
  it("the lens composes with rep scope: the rep's workable set, minus the footprint tag", async () => {
    // Self-serve open field is OPT-IN and off for this tenant, so the rep's
    // scope is exactly the two doors assigned to them. The lens then drops the
    // one tagged fcc_fiber_d25, leaving repDoor.
    const workable = [ids.repFiber, ids.repDoor];
    const afterLens = [ids.repDoor];

    const count = await (await req("/api/leads/map/count?view=latest", fx.rep.session)).json();
    expect(count.total).toBe(afterLens.length);
    // …and the response says what the lens removed, so the field is never left
    // guessing why a street looks empty.
    expect(count.hiddenByView).toBe(workable.length - afterLens.length);

    const feed = await (await req("/api/leads/map?view=latest", fx.rep.session)).json();
    expect(feed.pins.map((p: any) => p.id).sort()).toEqual([...afterLens].sort());
    const win = await (await req("/api/leads/map?bbox=-80.6,35.4,-80.1,35.6&view=latest", fx.rep.session)).json();
    expect(win.pins.map((p: any) => p.id).sort()).toEqual([...afterLens].sort());

    // Unfiltered, the rep sees every door they may work — footprint included.
    const all = await (await req("/api/leads/map/count", fx.rep.session)).json();
    expect(all.total).toBe(workable.length);
    expect(all.hiddenByView).toBe(0);
  });

  it("cross-tenant is EMPTY under the lens on every surface", async () => {
    const count = await (await req("/api/leads/map/count?view=latest", fx.foreign.session)).json();
    expect(count.total).toBe(0);
    const feed = await (await req("/api/leads/map?view=latest", fx.foreign.session)).json();
    expect(feed.pins).toHaveLength(0);
    const win = await (await req("/api/leads/map?bbox=-80.6,35.4,-80.1,35.6&view=latest", fx.foreign.session)).json();
    expect(win.pins).toHaveLength(0);
    const grid = await (await req("/api/leads/map/grid?bbox=-80.6,35.4,-80.1,35.6&cell=0.5&view=latest", fx.foreign.session)).json();
    expect(grid.cells).toHaveLength(0);
  });
});

describe("view parsing", () => {
  it("rejects a garbage view on all four surfaces", async () => {
    for (const path of [
      "/api/leads/map?view=everything",
      "/api/leads/map?view=latest'; DROP TABLE leads; --",
      "/api/leads/map/count?view=nope",
      "/api/leads/map?bbox=-80.6,35.4,-80.1,35.6&view=nope",
      "/api/leads/map/grid?bbox=-80.6,35.4,-80.1,35.6&cell=0.5&view=nope",
    ]) {
      const res = await req(path, fx.manager.session);
      expect(res.status, path).toBe(400);
    }
  });

  it("view=all is the explicit no-op (same payload as an absent view)", async () => {
    const explicit = await (await req("/api/leads/map?view=all", fx.manager.session)).json();
    const absent = await (await req("/api/leads/map", fx.manager.session)).json();
    expect(explicit.pins.length).toBe(absent.pins.length);
    const count = await (await req("/api/leads/map/count?view=all", fx.manager.session)).json();
    const allCount = await (await req("/api/leads/map/count", fx.manager.session)).json();
    expect(count.total).toBe(allCount.total);
  });
});
