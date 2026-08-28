// The HTTP surface: authorization, the flag gate, the honest empty state, the
// honest-window contract, and tenant isolation.
//
// The authorization shape being pinned: reads are open to any authenticated
// user because the field map needs them, and every WRITE is scan.manage - the
// same capability that spends provider budget. A rep who can see the layer
// must not be able to import a vintage, promote leads, or revert evidence.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let store: typeof import("../../server/kineticBuildStore");
let rawDb: import("better-sqlite3").Database;

type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};

const WIN = "130623";
const BLOCK_EMPTY = "371590501001000";

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@k2026.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

function req(path: string, session?: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(session ? { "x-session-id": session, "x-csrf-token": session } : {}),
      ...init.headers,
    },
  });
}
const post = (path: string, session: string | undefined, body: unknown) =>
  req(path, session, { method: "POST", body: JSON.stringify(body ?? {}) });

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-k2026api-"));
  process.env.NODE_ENV = "test";
  delete process.env.KINETIC_2026_BUILDS;
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/kineticBuildStore");

  fx.admin = person("Ada Admin", "admin");
  fx.manager = person("Mona Manager", "manager");
  fx.lead = person("Lee Lead", "team_lead");
  fx.rep = person("Rep Ann", "rep");

  storage.createTenant({
    slug: "other-k2026", companyName: "Other", ownerName: "O", ownerEmail: "o@other-k2026.test",
    brandName: "Other", brandColor: "#111", plan: "trial", status: "active",
  } as any);
  fx.foreign = person("Zed Foreign", "admin", 2);

  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json({ limit: "8mb" }));
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

describe("authorization", () => {
  const WRITES: Array<[string, unknown]> = [
    ["/api/kinetic-2026/imports", { vintage: "D25", providerIds: [WIN], manifest: "m", expectedChunkCount: 1, expectedRowCount: 1 }],
    ["/api/kinetic-2026/imports/anything/chunks", { chunkIndex: 0, rows: [] }],
    ["/api/kinetic-2026/imports/anything/finalize", {}],
    ["/api/kinetic-2026/imports/anything/discard", {}],
    ["/api/kinetic-2026/denominators", { vintage: "D25", counts: [] }],
    ["/api/kinetic-2026/vintages/D25/revert", { confirm: "D25" }],
    ["/api/kinetic-2026/promote", { apply: true }],
    ["/api/kinetic-2026/territories/preview", {}],
  ];

  it("refuses every write to a rep and a team lead", async () => {
    for (const [path, body] of WRITES) {
      for (const who of [fx.rep, fx.lead]) {
        expect((await post(path, who.session, body)).status, `${path} for ${who.userId}`).toBe(403);
      }
    }
  });

  it("refuses every write to an unauthenticated caller", async () => {
    for (const [path, body] of WRITES) {
      expect([401, 403]).toContain((await post(path, undefined, body)).status);
    }
  });

  it("allows an admin to write", async () => {
    const res = await post("/api/kinetic-2026/imports", fx.admin.session, {
      vintage: "D24", providerIds: [WIN], manifest: "authz", expectedChunkCount: 1, expectedRowCount: 1,
    });
    expect(res.status).toBe(201);
    const { import: job } = await res.json();
    expect((await post(`/api/kinetic-2026/imports/${job.id}/discard`, fx.admin.session, {})).status).toBe(200);
  });

  it("lets any authenticated user read the layer, and no anonymous one", async () => {
    for (const path of ["/api/kinetic-2026/status", "/api/kinetic-2026/summary", "/api/kinetic-2026/ranked"]) {
      expect((await req(path, fx.rep.session)).status).toBe(200);
      expect([401, 403]).toContain((await req(path)).status);
    }
  });

  it("keeps the import list itself behind scan.manage", async () => {
    // The list exposes source URLs and operator manifests, so it is a write-
    // tier read rather than a field-facing one.
    expect((await req("/api/kinetic-2026/imports", fx.rep.session)).status).toBe(403);
    expect((await req("/api/kinetic-2026/imports", fx.admin.session)).status).toBe(200);
  });
});

describe("the flag gate", () => {
  afterEach(() => { delete process.env.KINETIC_2026_BUILDS; });

  it("404s the whole surface when switched off, without a restart", async () => {
    process.env.KINETIC_2026_BUILDS = "off";
    expect((await req("/api/kinetic-2026/status", fx.admin.session)).status).toBe(404);
    expect((await post("/api/kinetic-2026/promote", fx.admin.session, {})).status).toBe(404);
  });

  it("comes straight back when switched on", async () => {
    process.env.KINETIC_2026_BUILDS = "off";
    expect((await req("/api/kinetic-2026/status", fx.admin.session)).status).toBe(404);
    delete process.env.KINETIC_2026_BUILDS;
    expect((await req("/api/kinetic-2026/status", fx.admin.session)).status).toBe(200);
  });
});

describe("the honest empty state", () => {
  it("says plainly that no FCC filing can attest to 2026 yet", async () => {
    const body = await (await req("/api/kinetic-2026/status", fx.rep.session)).json();
    expect(body.targetYear).toBe(2026);
    // The fact that started this whole design. If this ever flips to true, it
    // is because a D26 filing was imported - not because the code drifted.
    expect(body.fccCanAttestTargetYear).toBe(false);
    expect(body.attestingVintage).toBeNull();
    expect(body.nextAttestingVintage).toBe("D26");
    expect(body.explanation).toContain("cannot yet report a 2026 build");
  });

  it("lists the seven authorized counties", async () => {
    const body = await (await req("/api/kinetic-2026/status", fx.admin.session)).json();
    expect(Object.keys(body.counties).sort()).toEqual(
      ["37025", "37057", "37097", "37119", "37159", "37167", "37179"],
    );
  });
});

describe("import over HTTP", () => {
  it("streams, finalizes, and reports a replayed chunk as duplicate", async () => {
    const opened = await (await post("/api/kinetic-2026/imports", fx.admin.session, {
      vintage: "D25", providerIds: [WIN], manifest: "http-stream",
      expectedChunkCount: 2, expectedRowCount: 4,
    })).json();
    const id = opened.import.id;
    const rows = (n: number) => Array.from({ length: 2 }, (_, i) => ({
      locationId: `http-${n}-${i}`, blockGeoid: BLOCK_EMPTY, providerId: WIN,
      technology: 50, brCode: "R", maxDownMbps: 1000, maxUpMbps: 1000,
    }));

    expect((await (await post(`/api/kinetic-2026/imports/${id}/chunks`, fx.admin.session, { chunkIndex: 0, rows: rows(0) })).json()).duplicate).toBe(false);
    expect((await (await post(`/api/kinetic-2026/imports/${id}/chunks`, fx.admin.session, { chunkIndex: 0, rows: rows(0) })).json()).duplicate).toBe(true);

    // Finalizing early is a conflict, not a silent partial write.
    expect((await post(`/api/kinetic-2026/imports/${id}/finalize`, fx.admin.session, {})).status).toBe(409);

    await post(`/api/kinetic-2026/imports/${id}/chunks`, fx.admin.session, { chunkIndex: 1, rows: rows(1) });
    const finalized = await post(`/api/kinetic-2026/imports/${id}/finalize`, fx.admin.session, {});
    expect(finalized.status).toBe(200);
    expect((await finalized.json()).blocksWritten).toBe(1);
  });

  it("409s a same-index chunk carrying different data", async () => {
    const opened = await (await post("/api/kinetic-2026/imports", fx.admin.session, {
      vintage: "J25", providerIds: [WIN], manifest: "http-conflict",
      expectedChunkCount: 1, expectedRowCount: 1,
    })).json();
    const id = opened.import.id;
    const one = { locationId: "c-1", blockGeoid: BLOCK_EMPTY, providerId: WIN, technology: 50, brCode: "R" };
    const two = { ...one, locationId: "c-2" };
    await post(`/api/kinetic-2026/imports/${id}/chunks`, fx.admin.session, { chunkIndex: 0, rows: [one] });
    expect((await post(`/api/kinetic-2026/imports/${id}/chunks`, fx.admin.session, { chunkIndex: 0, rows: [two] })).status).toBe(409);
    await post(`/api/kinetic-2026/imports/${id}/discard`, fx.admin.session, {});
  });

  it("refuses an oversized chunk rather than accepting a long transaction", async () => {
    const opened = await (await post("/api/kinetic-2026/imports", fx.admin.session, {
      vintage: "J24", providerIds: [WIN], manifest: "http-big",
      expectedChunkCount: 1, expectedRowCount: 1,
    })).json();
    const rows = Array.from({ length: 5_001 }, (_, i) => ({
      locationId: `big-${i}`, blockGeoid: BLOCK_EMPTY, providerId: WIN, technology: 50, brCode: "R",
    }));
    expect((await post(`/api/kinetic-2026/imports/${opened.import.id}/chunks`, fx.admin.session, { chunkIndex: 0, rows })).status).toBe(400);
    await post(`/api/kinetic-2026/imports/${opened.import.id}/discard`, fx.admin.session, {});
  });

  it("requires the vintage retyped before reverting it", async () => {
    expect((await post("/api/kinetic-2026/vintages/D25/revert", fx.admin.session, {})).status).toBe(400);
    expect((await post("/api/kinetic-2026/vintages/D25/revert", fx.admin.session, { confirm: "D24" })).status).toBe(400);
  });
});

describe("map reads", () => {
  const BBOX = "minLat=35.0&maxLat=36.5&minLng=-81.5&maxLng=-79.5";

  beforeAll(() => {
    for (let i = 0; i < 6; i++) {
      store.recordAuthorizedObservation({
        identity: {
          tenantId: 1, address: `${700 + i} Api Way`, city: "Salisbury", state: "NC", zip: "28144",
          lat: 35.67 + i * 0.001, lng: -80.47, blockGeoid: BLOCK_EMPTY,
        },
        isFiberLive: true, conclusive: true, billingStatus: "N",
        observedAtMs: Date.now() - 86_400_000,
      });
    }
  });

  it("rejects a malformed or inverted bbox", async () => {
    expect((await req("/api/kinetic-2026/map?minLat=abc", fx.rep.session)).status).toBe(400);
    expect((await req("/api/kinetic-2026/map?minLat=36&maxLat=35&minLng=-81&maxLng=-80", fx.rep.session)).status).toBe(400);
  });

  it("returns pins with paint tiers", async () => {
    const body = await (await req(`/api/kinetic-2026/map?${BBOX}`, fx.rep.session)).json();
    expect(body.truncated).toBe(false);
    expect(body.pins.length).toBeGreaterThan(0);
    expect(body.pins.every((p: any) => typeof p.tier === "string")).toBe(true);
  });

  it("filters by classification and by county", async () => {
    const confirmed = await (await req(`/api/kinetic-2026/map?${BBOX}&classification=confirmed_2026`, fx.rep.session)).json();
    expect(confirmed.pins.every((p: any) => p.classification === "confirmed_2026")).toBe(true);
    const none = await (await req(`/api/kinetic-2026/map?${BBOX}&county=37119`, fx.rep.session)).json();
    expect(none.pins).toEqual([]);
  });

  it("grid totals equal the pin count over the same predicate", async () => {
    const pins = await (await req(`/api/kinetic-2026/map?${BBOX}`, fx.rep.session)).json();
    const grid = await (await req(`/api/kinetic-2026/map/grid?${BBOX}&cell=0.01`, fx.rep.session)).json();
    expect(grid.cells.reduce((n: number, c: any) => n + c.count, 0)).toBe(pins.windowCount);
  });
});

describe("tenant isolation", () => {
  it("a foreign org cannot read another org's build evidence", async () => {
    const mine = rawDb.prepare(`SELECT id FROM kinetic_build_state WHERE tenant_id = 1 LIMIT 1`).get() as any;
    expect(mine).toBeTruthy();
    expect((await req(`/api/kinetic-2026/builds/${mine.id}/evidence`, fx.admin.session)).status).toBe(200);
    // Absent, not forbidden - a 403 here would confirm the row exists.
    expect((await req(`/api/kinetic-2026/builds/${mine.id}/evidence`, fx.foreign.session)).status).toBe(404);
  });

  it("a foreign org sees an empty map over the same bbox", async () => {
    const body = await (await req("/api/kinetic-2026/map?minLat=35.0&maxLat=36.5&minLng=-81.5&maxLng=-79.5", fx.foreign.session)).json();
    expect(body.pins).toEqual([]);
  });
});
