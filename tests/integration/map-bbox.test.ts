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
    "content-type": "application/json", "x-session-id": session, "x-csrf-token": session, ...(init.headers ?? {}) } });
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

  it("rejects a window spanning more than 3° on either axis", async () => {
    const res = await req("/api/leads/map?bbox=-81,35,-77.9,35.5", fx.manager.session); // 3.1° lng
    expect(res.status).toBe(400);
    const res2 = await req("/api/leads/map?bbox=-81,35,-80.5,38.2", fx.manager.session); // 3.2° lat
    expect(res2.status).toBe(400);
  });

  it("accepts a window whose span is exactly 3° and clamps out-of-world coords", async () => {
    const res = await req("/api/leads/map?bbox=-81,35,-78,38", fx.manager.session);
    expect(res.status).toBe(200);
    // Clamped to world bounds instead of rejected (lat 95 → 90, span still ≤3°)
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
    expect(body.v).toBe(8);
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

  it("cross-tenant bbox returns EMPTY — the tenant wall holds in window mode", async () => {
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

describe("the 25k row cap", () => {
  it("caps a denser-than-cap window at 25k rows and flags truncated", async () => {
    // Bulk-load 25,005 pins straight into a far-away window (raw SQL in one
    // transaction — 25k createLead calls would dominate the test's runtime).
    const insert = rawDb.prepare(`INSERT INTO leads
      (address, city, state, zip, lat, lng, tenant_id, lead_status, lead_tag, created_at, updated_at)
      VALUES (?, 'Capville', 'NC', '28100', ?, ?, 1, 'prospect', 'fcc_fiber_d25', datetime('now'), datetime('now'))`);
    const load = rawDb.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        // ~0.12° x 0.12° window — well under the 3° span guard.
        insert.run(`Cap ${i}`, 10.0 + (i % 500) * 0.00024, 20.0 + Math.floor(i / 500) * 0.00024);
      }
    });
    load(25_005);
    const res = await req("/api/leads/map?bbox=19.9,9.9,20.2,10.2", fx.manager.session);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.pins).toHaveLength(25_000);
    // Ordered by id: the cap keeps the LOWEST ids, deterministically.
    const ids = body.pins.map((p: any) => p.id);
    expect([...ids].sort((a: number, b: number) => a - b)).toEqual(ids);
    // …and a tag-narrowed window over the same box is also capped.
    const tagged = await (await req("/api/leads/map?bbox=19.9,9.9,20.2,10.2&tag=fcc", fx.manager.session)).json();
    expect(tagged.truncated).toBe(true);
    expect(tagged.pins).toHaveLength(25_000);
  }, 60_000);
});
