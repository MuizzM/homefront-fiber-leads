// Bbox windowing on /api/leads/map — the 100k+-pin loading path.
//
// Pins the contract the viewport client depends on:
//   - bbox validation (malformed → 400, overspan → 400, world-bounds clamp)
//   - the 25k hard cap with truncated:true (never a silent sample)
//   - tag exact-or-prefix matching ("fcc" → fcc_fresh_block + fcc_fiber_d25)
//   - the EXISTING tenant/rep scoping preserved exactly: a cross-tenant bbox
//     returns EMPTY, and a rep's window shows only their own doors
//   - the full feed (no bbox) is untouched: same shape, still ETag'd.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAP_PINS_WIRE_VERSION } from "../../shared/mapPinsWire";

let server: Server; let baseUrl: string; let storage: any; let rawDb: any;
const fx: Record<string, any> = {};

function person(name: string, role: string, tenantId = 1, reportsToId: number | null = null) {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@bbox.test`;
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
    address: `${++n} Window St`, city: "Testburg", state: "NC", zip: "28100",
    lat, lng, tenantId, assignedRepId: repId, leadStatus: "prospect", ...extra,
  } as any).id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-bbox-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  fx.manager = person("Marge Manager", "manager");
  fx.rep = person("Rita Rep", "rep", 1, fx.manager.memberId);
  storage.createTenant({ slug: "other-bbox", companyName: "O", ownerName: "O",
    ownerEmail: "o@otherbbox.test", brandName: "O", brandColor: "#111", plan: "trial", status: "active" } as any);
  fx.foreign = person("Frank Foreign", "manager", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

describe("bbox validation", () => {
  it("rejects a malformed bbox", async () => {
    for (const bad of ["1,2,3", "a,b,c,d", "1,2,3,four", "1,2,3,4,5"]) {
      const res = await req(`/api/leads/map?bbox=${encodeURIComponent(bad)}`, fx.manager.session);
      expect(res.status, `bbox=${bad}`).toBe(400);
    }
  });

  it("rejects only an absurd window (>40° per axis) - a malformed request, not a zoom level", async () => {
    const res = await req("/api/leads/map?bbox=-125,20,-66,30", fx.manager.session); // 59° lng
    expect(res.status).toBe(400);
    const res2 = await req("/api/leads/map?bbox=-81,5,-80.5,50", fx.manager.session); // 45° lat
    expect(res2.status).toBe(400);
  });

  it("accepts region/state windows the OLD 3° guard rejected (owner blank-map report)", async () => {
    const res = await req("/api/leads/map?bbox=-81,35,-77.9,35.5", fx.manager.session); // 3.1° lng
    expect(res.status).toBe(200);
    const res2 = await req("/api/leads/map?bbox=-84.5,33.7,-75.4,36.6", fx.manager.session); // all of NC ~9°
    expect(res2.status).toBe(200);
  });

  it("accepts a window whose span is exactly 40° and clamps out-of-world coords", async () => {
    const res = await req("/api/leads/map?bbox=-100,10,-60,20", fx.manager.session);
    expect(res.status).toBe(200);
    // Clamped to world bounds instead of rejected (lat 95 → 90, span still ≤40°)
    const res2 = await req("/api/leads/map?bbox=-80.6,88,-79.9,95", fx.manager.session);
    expect(res2.status).toBe(200);
  });

  it("normalizes swapped corners instead of failing", async () => {
    const res = await req("/api/leads/map?bbox=-79.9,35.6,-80.6,35.4", fx.manager.session);
    expect(res.status).toBe(200);
  });

  it("rejects a dangerous tag", async () => {
    const res = await req(`/api/leads/map?bbox=-81,35,-80,36&tag=${encodeURIComponent("fcc' OR 1=1 --")}`, fx.manager.session);
    expect(res.status).toBe(400);
  });
});

describe("bbox window rows", () => {
  it("returns only pins inside the window, with fresh_sources/fresh_confirmed_at", async () => {
    const inside = lead(1, null, 35.50, -80.40, { leadTag: "fcc_fiber_d25", freshSources: "[\"fcc\"]", freshConfirmedAt: "2026-07-01T00:00:00Z" });
    lead(1, null, 36.50, -80.40); // outside lat
    lead(1, null, 35.50, -79.00); // outside lng (window -80.6..-80.1)
    const body = await (await req("/api/leads/map?bbox=-80.6,35.4,-80.1,35.6", fx.manager.session)).json();
    const ids = body.pins.map((p: any) => p.id);
    expect(ids).toContain(inside);
    expect(body.pins).toHaveLength(1);
    const pin = body.pins[0];
    expect(pin.leadTag).toBe("fcc_fiber_d25");
    expect(pin.freshSources).toBe("[\"fcc\"]");
    expect(pin.freshConfirmedAt).toBe("2026-07-01T00:00:00Z");
    expect(body.truncated).toBe(false);
  });

  it("packed format carries the same window + truncated flag", async () => {
    const res = await req("/api/leads/map?format=packed&bbox=-80.6,35.4,-80.1,35.6", fx.manager.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    // The window declares the CURRENT wire version (server + client ship
    // together), not a literal: every field added to the projection bumps it.
    expect(body.v).toBe(MAP_PINS_WIRE_VERSION);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.truncated ?? false).toBe(false);
  });

  it("tag filter matches exactly and by family prefix", async () => {
    const fresh = lead(1, null, 35.51, -80.41, { leadTag: "fcc_fresh_block" });
    const fiber = lead(1, null, 35.52, -80.42, { leadTag: "fcc_fiber_d25" });
    const other = lead(1, null, 35.53, -80.43, { leadTag: "hot_lead" });
    const bbox = "bbox=-80.6,35.4,-80.1,35.6";
    const fcc = await (await req(`/api/leads/map?${bbox}&tag=fcc`, fx.manager.session)).json();
    const fccIds = fcc.pins.map((p: any) => p.id);
    expect(fccIds).toEqual(expect.arrayContaining([fresh, fiber]));
    expect(fccIds).not.toContain(other);
    const exact = await (await req(`/api/leads/map?${bbox}&tag=fcc_fresh_block`, fx.manager.session)).json();
    const exactIds = exact.pins.map((p: any) => p.id);
    expect(exactIds).toContain(fresh);
    expect(exactIds).not.toContain(fiber);
    // A prefix must not match a merely-similar tag ("fccx" matches nothing).
    const nope = await (await req(`/api/leads/map?${bbox}&tag=fccx`, fx.manager.session)).json();
    expect(nope.pins).toHaveLength(0);
  });

  it("LIKE metacharacters in the tag match literally (escaped)", async () => {
    // "fcc_fresh" as a PREFIX: must match fcc_fresh_block but NOT
    // fccXfresh_block — an unescaped '_' would wildcard-match the X.
    const lookalike = lead(1, null, 35.56, -80.46, { leadTag: "fccXfresh_block" });
    const real = lead(1, null, 35.57, -80.47, { leadTag: "fcc_fresh_block" });
    const bbox = "bbox=-80.6,35.4,-80.1,35.6";
    const body = await (await req(`/api/leads/map?${bbox}&tag=fcc_fresh`, fx.manager.session)).json();
    const ids = body.pins.map((p: any) => p.id);
    expect(ids).toContain(real);
    expect(ids).not.toContain(lookalike);
  });

  it("a wide (region-zoom) window under the cap returns EVERY town, truncated:false", async () => {
    // Two towns ~7° of longitude apart in ONE window — the case the old 3°
    // rejection turned into a blank map. Under the row cap nothing is thinned.
    const west = lead(1, null, 35.05, -82.95);
    const east = lead(1, null, 35.95, -76.05);
    const body = await (await req("/api/leads/map?bbox=-83.5,34.5,-75.5,36.5", fx.manager.session)).json();
    const ids = body.pins.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining([west, east]));
    expect(body.truncated).toBe(false);
  });

  it("cross-tenant bbox returns EMPTY - the tenant wall holds in window mode", async () => {
    // The window covers tenant 1's pins, but the caller belongs to tenant 2.
    const body = await (await req("/api/leads/map?bbox=-80.6,35.4,-80.1,35.6", fx.foreign.session)).json();
    expect(body.pins).toHaveLength(0);
    const count = await (await req("/api/leads/map/count", fx.foreign.session)).json();
    expect(count.total).toBe(0);
  });

  it("a rep's window shows only their own doors (scope preserved)", async () => {
    const mine = lead(1, fx.rep.memberId, 35.54, -80.44);
    const someoneElses = lead(1, fx.manager.memberId, 35.55, -80.45);
    const body = await (await req("/api/leads/map?bbox=-80.6,35.4,-80.1,35.6", fx.rep.session)).json();
    const ids = body.pins.map((p: any) => p.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(someoneElses);
    // The count endpoint agrees with the window scope.
    const count = await (await req("/api/leads/map/count", fx.rep.session)).json();
    expect(count.total).toBeGreaterThanOrEqual(1);
    const mgrCount = await (await req("/api/leads/map/count", fx.manager.session)).json();
    expect(mgrCount.total).toBeGreaterThan(count.total);
  });

  // The wire SCHEMA evolved (v7→v8: freshSources/freshConfirmedAt joined every
  // packed row), so "byte-identical" is NOT the claim. What is preserved: the
  // full-feed response SHAPE (pins/total, no truncated key) and the ETag/304
  // semantics existing clients rely on (the ETag busts on redeploy, so no
  // client can 304 a v7 payload into a v8 reader).
  it("the full feed (no bbox) keeps its shape and ETag/304 semantics: no truncated key, ETag present, 304 works", async () => {
    const res = await req("/api/leads/map", fx.manager.session);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
    const body = await res.json();
    expect(body.pins.length).toBeGreaterThan(0);
    expect("truncated" in body).toBe(false);
    const res304 = await fetch(`${baseUrl}/api/leads/map`, {
      headers: { "x-session-id": fx.manager.session, "if-none-match": res.headers.get("etag")! },
    });
    expect(res304.status).toBe(304);
  });
});

describe("the 25k row cap → even deterministic sampling", () => {
  it("an over-cap window returns an evenly-thinned sample with truncated:true", async () => {
    // Bulk-load 25,005 pins straight into a far-away window (raw SQL in one
    // transaction — 25k createLead calls would dominate the test's runtime).
    // lng advances with insertion order (one 0.00024° row per 500 pins), so
    // insertion order correlates with geography — exactly the shape that made
    // the old ORDER BY id LIMIT prefix a one-town sample.
    const insert = rawDb.prepare(`INSERT INTO leads
      (address, city, state, zip, lat, lng, tenant_id, lead_status, lead_tag, created_at, updated_at)
      VALUES (?, 'Capville', 'NC', '28100', ?, ?, 1, 'prospect', 'fcc_fiber_d25', datetime('now'), datetime('now'))`);
    const load = rawDb.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        insert.run(`Cap ${i}`, 10.0 + (i % 500) * 0.00024, 20.0 + Math.floor(i / 500) * 0.00024);
      }
    });
    load(25_005);
    const res = await req("/api/leads/map?bbox=19.9,9.9,20.2,10.2", fx.manager.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    // count=25,005 → step=ceil(25005/25000)=2 → every even id, ~half the rows.
    const ids: number[] = body.pins.map((p: any) => p.id);
    expect(ids.length).toBeGreaterThan(12_000);
    expect(ids.length).toBeLessThanOrEqual(12_503);
    expect(ids.every((id) => id % 2 === 0)).toBe(true);
    // Ordered by id, still deterministic.
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    // EVEN across insertion order — the sample spans the whole 25k id block,
    // not the old lowest-25k prefix…
    expect(Math.max(...ids) - Math.min(...ids)).toBeGreaterThan(24_000);
    // …which here means the whole GEOGRAPHIC extent: every ~0.00024° lng
    // column of the grid is represented, first through last.
    const lngs: number[] = body.pins.map((p: any) => p.lng);
    expect(Math.min(...lngs)).toBeCloseTo(20.0, 3);
    expect(Math.max(...lngs)).toBeCloseTo(20.012, 3);
    expect(new Set(lngs).size).toBeGreaterThanOrEqual(50);
    // Stable across pans: the identical window returns the identical sample.
    const again = await (await req("/api/leads/map?bbox=19.9,9.9,20.2,10.2", fx.manager.session)).json();
    expect(again.pins.map((p: any) => p.id)).toEqual(ids);
    // …and a tag-narrowed over-cap window over the same box samples too.
    const tagged = await (await req("/api/leads/map?bbox=19.9,9.9,20.2,10.2&tag=fcc", fx.manager.session)).json();
    expect(tagged.truncated).toBe(true);
    expect(tagged.pins.length).toBeGreaterThan(12_000);
    expect(tagged.pins.length).toBeLessThanOrEqual(12_503);
    expect(tagged.pins.every((p: any) => p.id % 2 === 0)).toBe(true);
  }, 60_000);
});
