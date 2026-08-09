// Density grid on /api/leads/map/grid — the wide-zoom aggregate tier.
//
// Pins the contract the three-tier client depends on:
//   - bbox validation mirrors the pin path (malformed → 400, world-bounds
//     clamp) with its own 15°/axis span guard (beyond → 400)
//   - cell=auto formula: span/24 snapped to 0.01° steps, clamped [0.01°, 5°]
//   - counts are SQL-side floor buckets over the SAME mapScopeWhere scoping:
//     sums match the raw pin window EXACTLY, cell centers sit within half a
//     cell of every lead they aggregate
//   - cross-tenant EMPTY and rep-scoped subsets — the tenant wall holds in
//     the aggregate tier
//   - the tag exact-or-prefix filter applies (FCC lens at state zoom)
//   - the 5k cell cap with truncated:true (never a silent sample)
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string; let storage: any; let rawDb: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1, reportsToId: number | null = null) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@grid.test`;
  const m = storage.createTeamMember({ name, email, role, active: true, tenantId, reportsToId } as any);
  const u = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: m.id } as any);
  return { memberId: m.id, userId: u.id, session: storage.createSession(u.id).id };
}
function req(path: string, session: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: {
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) } });
}

let n = 0;
function lead(tenantId: number, repId: number | null, lat: number, lng: number, extra: Record<string, any> = {}) {
  return storage.createLead({
    address: `${++n} Grid Ave`, city: "Testburg", state: "NC", zip: "28100",
    lat, lng, tenantId, assignedRepId: repId, leadStatus: "prospect", ...extra,
  } as any).id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-grid-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  fx.manager = person("Gail Manager", "manager");
  fx.rep = person("Ron Rep", "rep", 1, fx.manager.memberId);
  storage.createTenant({ slug: "other-grid", companyName: "O", ownerName: "O",
    ownerEmail: "o@othergrid.test", brandName: "O", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreign = person("Fay Foreign", "manager", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe("grid validation", () => {
  it("requires a bbox", async () => {
    const res = await req("/api/leads/map/grid", fx.manager.session);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed bbox like the pin path", async () => {
    for (const bad of ["1,2,3", "a,b,c,d", "1,2,3,4,5"]) {
      const res = await req(`/api/leads/map/grid?bbox=${encodeURIComponent(bad)}`, fx.manager.session);
      expect(res.status, `bbox=${bad}`).toBe(400);
    }
  });

  it("rejects a window spanning more than 15° on either axis", async () => {
    const res = await req("/api/leads/map/grid?bbox=-90,30,-74.9,36", fx.manager.session); // 15.1° lng
    expect(res.status).toBe(400);
    const res2 = await req("/api/leads/map/grid?bbox=-80,20,-79,35.2", fx.manager.session); // 15.2° lat
    expect(res2.status).toBe(400);
  });

  it("accepts wide spans (3°-15°) - and the pin path now answers them too, with a sample", async () => {
    const res = await req("/api/leads/map/grid?bbox=-84.5,33.5,-75.5,36.6", fx.manager.session); // NC ~9° x 3.1°
    expect(res.status).toBe(200);
    // #91 raised the pin ceiling to 40°: the pin path no longer 400s here —
    // it returns a bounded even SAMPLE (truncated flag). The client still
    // renders the GRID tier at this span (exact counts, ~2KB vs a 25k-pin
    // sample); the sampled pin path remains the over-cap contract for
    // pin-tier windows and any direct caller.
    const pin = await req("/api/leads/map?bbox=-84.5,33.5,-75.5,36.6", fx.manager.session);
    expect(pin.status).toBe(200);
  });

  it("rejects a bad cell and a dangerous tag", async () => {
    const bbox = "bbox=-81,35,-78,36";
    for (const bad of ["0", "-1", "6", "xyz"]) {
      const res = await req(`/api/leads/map/grid?${bbox}&cell=${encodeURIComponent(bad)}`, fx.manager.session);
      expect(res.status, `cell=${bad}`).toBe(400);
    }
    const res = await req(`/api/leads/map/grid?${bbox}&tag=${encodeURIComponent("fcc' OR 1=1 --")}`, fx.manager.session);
    expect(res.status).toBe(400);
  });
});

describe("grid cells", () => {
  it("cell=auto is span/24 snapped to 0.01° steps (cluster-like pitch)", async () => {
    const body = await (await req("/api/leads/map/grid?bbox=-84,34,-76,37", fx.manager.session)).json(); // span 8 → 8/24 = 0.333 → 0.33
    expect(body.cell).toBe(0.33);
    const small = await (await req("/api/leads/map/grid?bbox=-81,35,-78,36", fx.manager.session)).json(); // span 3 → 0.125 → 0.13
    expect(small.cell).toBe(0.13);
  });

  it("counts sum to EXACTLY the raw pin window over the same bbox", async () => {
    // Three leads in one cell, one alone in another, one outside the window.
    lead(1, null, 35.51, -80.41);
    lead(1, null, 35.52, -80.42);
    lead(1, null, 35.53, -80.43);
    lead(1, null, 35.90, -80.90);
    lead(1, null, 37.50, -80.50); // outside (lat > 36)
    const bbox = "-81,35,-78,36";
    const gridRes = await req(`/api/leads/map/grid?bbox=${bbox}`, fx.manager.session);
    const grid = await gridRes.json();
    expect(gridRes.status, JSON.stringify(grid)).toBe(200);
    const pins = await (await req(`/api/leads/map?bbox=${bbox}`, fx.manager.session)).json();
    const sum = grid.cells.reduce((a: number, c: any) => a + c.n, 0);
    expect(sum).toBe(pins.pins.length);
    expect(sum).toBe(4);
    // Every returned cell center is inside the window…
    for (const c of grid.cells) {
      expect(c.lat).toBeGreaterThanOrEqual(35);
      expect(c.lat).toBeLessThanOrEqual(36);
      expect(c.lng).toBeGreaterThanOrEqual(-81);
      expect(c.lng).toBeLessThanOrEqual(-78);
      expect(c.n).toBeGreaterThanOrEqual(1);
    }
    // …and the densest cell (3 leads) comes first (n DESC).
    expect(grid.cells[0].n).toBe(3);
    expect(grid.truncated).toBe(false);
  });

  it("every lead sits within half a cell of its bucket center (floor buckets)", async () => {
    const grid = await (await req("/api/leads/map/grid?bbox=-81,35,-78,36&cell=0.25", fx.manager.session)).json();
    const pins = await (await req("/api/leads/map?bbox=-81,35,-78,36", fx.manager.session)).json();
    // Assign each raw pin to the nearest cell center — it must be within
    // cell/2 on both axes, and the per-cell assignment counts must equal n.
    const tally = new Map<string, number>();
    for (const p of pins.pins) {
      const key = grid.cells.find((c: any) =>
        Math.abs(c.lat - p.lat) <= 0.125 && Math.abs(c.lng - p.lng) <= 0.125);
      expect(key, `pin ${p.id} must fall inside a returned cell`).toBeTruthy();
      const k = `${key.lat},${key.lng}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    for (const c of grid.cells) {
      expect(tally.get(`${c.lat},${c.lng}`) ?? 0).toBe(c.n);
    }
  });

  it("cross-tenant grid returns EMPTY - the tenant wall holds in the aggregate tier", async () => {
    const body = await (await req("/api/leads/map/grid?bbox=-81,35,-78,36", fx.foreign.session)).json();
    expect(body.cells).toHaveLength(0);
  });

  it("a rep's grid counts only the doors ASSIGNED to them", async () => {
    // The grid must agree with the one visibility rule in shared/leadVisibility.
    // Self-serve open field is OPT-IN and off for this tenant, so unowned ground
    // is not a rep's to work — an org that imported a whole market's footprint
    // must not hand every rep every unassigned door.
    lead(1, fx.rep.memberId, 35.54, -80.44);
    lead(1, fx.manager.memberId, 35.55, -80.45);
    const inBox = "bbox=-81,35,-78,36&cell=0.25";
    const body = await (await req(`/api/leads/map/grid?${inBox}`, fx.rep.session)).json();
    const sum = body.cells.reduce((a: number, c: any) => a + c.n, 0);

    // The grid is an aggregate, so compare it against the pin feed's own scope
    // decision rather than a hand-counted constant that rots as fixtures grow.
    const pins = await (await req("/api/leads/map?bbox=-81,35,-78,36", fx.rep.session)).json();
    const inWindow = pins.pins.filter((p: any) =>
      p.lat >= 35 && p.lat <= 36 && p.lng >= -81 && p.lng <= -78);
    expect(sum).toBe(inWindow.length);

    // The rep's own door is in; the manager's is not — widening open field must
    // never widen access to somebody else's assigned ground.
    const at = (lat: number, lng: number) => inWindow.some((p: any) =>
      Math.abs(p.lat - lat) < 1e-6 && Math.abs(p.lng - lng) < 1e-6);
    expect(at(35.54, -80.44), "the rep's own door").toBe(true);
    expect(at(35.55, -80.45), "the manager's door").toBe(false);
    // …and the unassigned doors seeded earlier are NOT counted.
    expect(at(35.51, -80.41), "an unassigned door").toBe(false);
  });

  it("the tag filter scopes the aggregate (FCC lens at state zoom)", async () => {
    lead(1, null, 35.61, -80.61, { leadTag: "fcc_fresh_block" });
    lead(1, null, 35.62, -80.62, { leadTag: "fcc_fiber_d25" });
    lead(1, null, 35.63, -80.63, { leadTag: "hot_lead" });
    const bbox = "bbox=-81,35,-78,36&cell=0.5";
    const fcc = await (await req(`/api/leads/map/grid?${bbox}&tag=fcc`, fx.manager.session)).json();
    expect(fcc.cells.reduce((a: number, c: any) => a + c.n, 0)).toBe(2);
    const fresh = await (await req(`/api/leads/map/grid?${bbox}&tag=fcc_fresh_block`, fx.manager.session)).json();
    expect(fresh.cells.reduce((a: number, c: any) => a + c.n, 0)).toBe(1);
    const nope = await (await req(`/api/leads/map/grid?${bbox}&tag=fccx`, fx.manager.session)).json();
    expect(nope.cells).toHaveLength(0);
  });

  it("a state-zoom payload is tiny (hundreds of cells, kilobytes - not pins)", async () => {
    const res = await req("/api/leads/map/grid?bbox=-84.5,33.5,-75.5,36.6", fx.manager.session); // NC state view
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cells.length).toBeLessThan(200);
    expect(JSON.stringify(body).length).toBeLessThan(20_000);
  });
});

describe("the 5k cell cap", () => {
  it("caps a denser-than-cap grid and flags truncated", async () => {
    // 6,000 DISTINCT cells (75 lat bands x 80 lng bands at cell=0.05), one
    // lead each — raw SQL in one transaction, like the pin cap test.
    const insert = rawDb.prepare(`INSERT INTO leads
      (address, city, state, zip, lat, lng, tenant_id, lead_status, lead_tag, created_at, updated_at)
      VALUES (?, 'Gridville', 'NC', '28100', ?, ?, 1, 'prospect', 'fcc_fiber_d25', datetime('now'), datetime('now'))`);
    const load = rawDb.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        insert.run(`Grid ${i}`, 10.01 + (i % 75) * 0.05, 20.01 + Math.floor(i / 75) * 0.05);
      }
    });
    load(6_000);
    const res = await req("/api/leads/map/grid?bbox=19.9,9.9,24.2,14&cell=0.05", fx.manager.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.cells).toHaveLength(5_000);
    // Even at the cap the payload stays inside the 200KB budget.
    expect(JSON.stringify(body).length).toBeLessThan(200_000);
    // …and an untruncated read over a slice of the same field sums exactly.
    const slice = await (await req("/api/leads/map/grid?bbox=19.9,9.9,21,10.5&cell=0.05", fx.manager.session)).json();
    expect(slice.truncated).toBe(false);
    expect(slice.cells.reduce((a: number, c: any) => a + c.n, 0)).toBe(
      slice.cells.length, // one lead per cell in this fixture
    );
  }, 60_000);
});
