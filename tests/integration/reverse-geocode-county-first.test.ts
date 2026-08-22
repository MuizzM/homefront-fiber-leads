// Tap-to-add resolves against the county address file before it pays for a
// reverse geocode: a tap within 45 m of an E911 point snaps to that door and
// never touches Mapbox; a tap with no point nearby falls through to the
// geocoder (which, unconfigured here, answers 503).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server; let baseUrl: string; let session = "";
const realFetch = globalThis.fetch;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-revgeo-"));
  process.env.NODE_ENV = "test";
  delete process.env.MAPBOX_TOKEN; delete process.env.MAPBOX_PUBLIC_TOKEN;
  const mod = await import("../../server/storage");
  mod.runMigrations();
  const storage = mod.storage;
  const { upsertAddressPoints } = await import("../../server/addressPointStore");
  upsertAddressPoints([
    { source: "test", sourceId: "a", houseNumber: "1842", street: "1842 Oak Ridge Dr", fullAddress: "1842 Oak Ridge Dr, Salisbury NC, 28146", city: "Salisbury", state: "NC", zip: "28146", county: "ROWAN", lat: 35.6700, lng: -80.4700 },
    { source: "test", sourceId: "b", houseNumber: "1846", street: "1846 Oak Ridge Dr", fullAddress: "1846 Oak Ridge Dr, Salisbury NC, 28146", city: "Salisbury", state: "NC", zip: "28146", county: "ROWAN", lat: 35.6700, lng: -80.4697 },
  ]);
  const m = storage.createTeamMember({ name: "Tess Lead", email: "tess@revgeo.test", role: "team_lead", active: true, tenantId: 1 } as any);
  const u = storage.createUser({ name: "Tess Lead", email: "tess@revgeo.test", role: "team_lead", active: true, tenantId: 1, teamMemberId: m.id } as any);
  session = storage.createSession(u.id).id;
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json({ limit: "64kb" }));
  server = createServer(app); registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const reverse = (lat: number, lng: number) =>
  realFetch(`${baseUrl}/api/geocode/reverse?lat=${lat}&lng=${lng}`, { headers: { "x-session-id": session } });

describe("GET /api/geocode/reverse", () => {
  it("snaps a tap beside a county point to that door, without calling Mapbox", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    // 0.00008 deg lat is ~9 m north of 1842.
    const r = await reverse(35.67008, -80.47);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.source).toBe("county");
    expect(body.address).toBe("1842 Oak Ridge Dr");
    expect(body.city).toBe("Salisbury"); expect(body.state).toBe("NC"); expect(body.zip).toBe("28146");
    expect(body.lat).toBe(35.67); expect(body.lng).toBe(-80.47);
    expect(body.meters).toBeLessThan(15);
    // The neighbour is offered as an alternate, nearest first.
    expect(body.alternates.map((a: any) => a.address)).toEqual(["1846 Oak Ridge Dr"]);
    expect(spy.mock.calls.filter(c => String(c[0]).includes("mapbox"))).toHaveLength(0);
    spy.mockRestore();
  });

  it("falls through to the geocoder when no county point is within 45 m", async () => {
    const r = await reverse(35.68, -80.48); // ~1.4 km away
    expect(r.status).toBe(503); // not configured in tests: the fall-through reached the geocoder
  });

  it("serves a snapped answer from the cache on the next tap in the same 11 m cell", async () => {
    const r = await reverse(35.67008, -80.47);
    expect((await r.json()).cached).toBe(true);
  });
});
