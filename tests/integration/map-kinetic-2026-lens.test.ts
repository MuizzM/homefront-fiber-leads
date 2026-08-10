// The "Kinetic 2026 builds" lens on the EXISTING lead map (?view=kinetic_2026).
//
// Promoted builds are ordinary leads carrying one tag, which is what lets them
// reuse the field map's clustering, bbox windows, density grid, territory and
// assignment machinery unchanged. This file pins the one thing that reuse
// depends on: the lens narrows the count probe, the feed, the bbox window AND
// the grid to exactly the same set - so a rep zoomed out never sees aggregate
// counts for doors the chip says are filtered out.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];

const TAG = "kinetic_build_2026";
let admin: { session: string };

// bbox is ONE param: minLng,minLat,maxLng,maxLat. Covers every seeded pin.
const BBOX = "bbox=-80.7,35.3,-80.5,35.5";

function req(path: string, session: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session, "x-csrf-token": session } });
}

let seq = 0;
function seed(tag: string | null, n: number) {
  for (let i = 0; i < n; i++) {
    storage.createLead({
      address: `${++seq} Lens Way`, city: "Concord", state: "NC", zip: "28025",
      lat: 35.4 + (seq % 50) * 0.001, lng: -80.6 + (seq % 50) * 0.001,
      tenantId: 1, leadStatus: "prospect", leadTag: tag,
    } as any);
  }
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-k2026lens-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;

  const member = storage.createTeamMember({ name: "Ada", email: "ada@lens.test", role: "admin", active: true, tenantId: 1 } as any);
  const user = storage.createUser({ name: "Ada", email: "ada@lens.test", role: "admin", active: true, tenantId: 1, teamMemberId: member.id } as any);
  admin = { session: storage.createSession(user.id).id };

  seed(TAG, 12);            // confirmed 2026 builds
  seed("fcc_fresh_block", 20);
  seed("fcc_fiber_d25", 30);
  seed(null, 8);            // organic

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

describe("?view=kinetic_2026", () => {
  it("counts only the confirmed builds", async () => {
    const scoped = await (await req("/api/leads/map/count?view=kinetic_2026", admin.session)).json();
    expect(scoped.total).toBe(12);
    const all = await (await req("/api/leads/map/count", admin.session)).json();
    expect(all.total).toBe(70);
    // The map tells the rep how many doors the lens is hiding, rather than
    // just looking empty.
    expect(scoped.hiddenByView).toBe(58);
  });

  it("returns only tagged pins from the full feed", async () => {
    const body = await (await req("/api/leads/map?view=kinetic_2026", admin.session)).json();
    expect(body.pins).toHaveLength(12);
    expect(body.pins.every((p: any) => p.leadTag === TAG)).toBe(true);
  });

  it("returns only tagged pins from a bbox window", async () => {
    const body = await (await req(`/api/leads/map?${BBOX}&view=kinetic_2026`, admin.session)).json();
    expect(body.pins.length).toBeGreaterThan(0);
    expect(body.pins.every((p: any) => p.leadTag === TAG)).toBe(true);
  });

  it("narrows the density grid to the SAME set, so zooming out cannot inflate counts", async () => {
    const grid = await (await req(`/api/leads/map/grid?${BBOX}&view=kinetic_2026&cell=0.5`, admin.session)).json();
    expect(grid.cells.reduce((n: number, c: any) => n + c.n, 0)).toBe(12);
    const all = await (await req(`/api/leads/map/grid?${BBOX}&cell=0.5`, admin.session)).json();
    expect(all.cells.reduce((n: number, c: any) => n + c.n, 0)).toBe(70);
  });

  it("is a positive tag match, so an unrelated new tag cannot leak in", async () => {
    seed("some_future_tag", 5);
    const body = await (await req("/api/leads/map?view=kinetic_2026", admin.session)).json();
    expect(body.pins).toHaveLength(12);
  });

  it("rejects an unknown view rather than silently showing everything", async () => {
    const res = await req("/api/leads/map/count?view=not_a_view", admin.session);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("kinetic_2026");
  });

  it("still serves the whole map when no view is given", async () => {
    const body = await (await req("/api/leads/map", admin.session)).json();
    expect(body.pins).toHaveLength(75);
  });
});
