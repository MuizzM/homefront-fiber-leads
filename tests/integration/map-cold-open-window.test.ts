// Cold-open window contract for viewport-mode (big-map) orgs — the production
// "leads are not loading — so slow" incident.
//
// Drives the REAL server with the EXACT requests the client's boot path builds
// (currentFetchWindow → bboxParam for the pin tier; the clampToGridGuard flow
// for the grid tier) across representative zooms and screens, and pins the
// pieces the fix depends on:
//   - a >60k org: the count probe answers viewport mode (what the persisted
//     hint replays next boot), yet every boot window still answers complete;
//   - pin-tier boot windows across the whole zoom band answer 200 with pins
//     inside the requested window, complete (non-truncated) at knocking zooms;
//   - the pin window, density grid, and count probe all answer when fired
//     CONCURRENTLY — the no-waterfall boot fires them in parallel;
//   - the packed window response round-trips through the WINDOW snapshot
//     (write → read → camera-intersect gate → seed shape) and the next boot's
//     COMPLETE window fetch evicts rows the server has since disowned;
//   - the windowed query stays on the map-window covering index (the server
//     half of the latency fix — without it every pan walked the whole tenant).
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentFetchWindow, bboxParam, viewportTierForWindow, clampToGridGuard,
  gridCellForSpan, cameraViewBBox, bboxIntersects, keepRegion,
  mergeViewportPins, MAP_VIEWPORT_MODE_THRESHOLD,
} from "../../client/src/lib/mapViewport";
import {
  readMapWindowSnapshot, writeMapWindowSnapshot, type SnapshotStorage,
} from "../../client/src/lib/mapPinsSnapshot";
import { unpackMapPins } from "../../shared/mapPinsWire";

let server: Server; let baseUrl: string; let storage: any; let rawDb: any; let session: string;

const CENTER = { lng: -80.41, lat: 35.55 }; // the seeded metro core

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-coldopen-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  const m = storage.createTeamMember({ name: "Owner", email: "owner@coldopen.test", role: "admin", active: true, tenantId: 1 } as any);
  const u = storage.createUser({ name: "Owner", email: "owner@coldopen.test", role: "admin", active: true, tenantId: 1, teamMemberId: m.id } as any);
  session = storage.createSession(u.id).id;
  // A viewport-mode-class org: >60k pins, dense metro core + regional fill —
  // raw SQL in one transaction (createLead per row would dominate runtime).
  const insert = rawDb.prepare(`INSERT INTO leads
    (address, city, state, zip, lat, lng, tenant_id, lead_status, created_at, updated_at)
    VALUES (?, 'Coldopen', 'NC', '28100', ?, ?, 1, 'prospect', datetime('now'), datetime('now'))`);
  let seedState = 4242;
  const rand = () => { seedState = (seedState * 1103515245 + 12345) & 0x7fffffff; return seedState / 0x7fffffff; };
  let n = 0;
  rawDb.transaction(() => {
    for (let i = 0; i < 45_000; i++) { // metro core ~0.3°
      insert.run(`${++n} Core St`, CENTER.lat + (rand() - 0.5) * 0.3, CENTER.lng + (rand() - 0.5) * 0.3);
    }
    for (let i = 0; i < 16_000; i++) { // regional fill ~2°
      insert.run(`${++n} Fill Rd`, CENTER.lat + (rand() - 0.5) * 2, CENTER.lng + (rand() - 0.5) * 2);
    }
  })();
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 120_000);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function req(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { "x-session-id": session } });
}

/** Mercator-ish map stub — the same shape currentFetchWindow reads (and the
 *  same formula as the grid-window contract test). */
function mapAt(zoom: number, widthPx: number, heightPx: number, center = CENTER) {
  const spanLng = (360 * (widthPx / 512)) / 2 ** zoom;
  const spanLat = (360 * (heightPx / 512)) / 2 ** zoom / 1.3;
  return {
    getCenter: () => ({ lng: center.lng, lat: center.lat }),
    getBounds() {
      return {
        getWest: () => center.lng - spanLng / 2, getEast: () => center.lng + spanLng / 2,
        getSouth: () => Math.max(-85, center.lat - spanLat / 2), getNorth: () => Math.min(85, center.lat + spanLat / 2),
      };
    },
  };
}

/** EXACTLY fetchViewportPins' request construction (MapView.tsx). */
function pinRequestFor(map: ReturnType<typeof mapAt>) {
  const bounds = currentFetchWindow(map)!;
  return { ...bounds, url: `/api/leads/map?format=packed&bbox=${bboxParam(bounds.window)}` };
}

/** EXACTLY fetchViewportGrid's request construction (MapView.tsx). */
function gridRequestFor(map: ReturnType<typeof mapAt>) {
  const bounds = currentFetchWindow(map)!;
  const c = map.getCenter();
  const w = clampToGridGuard(bounds.window, undefined, c);
  const span = Math.max(w.maxLng - w.minLng, w.maxLat - w.minLat);
  return `/api/leads/map/grid?bbox=${bboxParam(w)}&cell=${gridCellForSpan(span)}`;
}

function fakeStorage(): SnapshotStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

describe("a viewport-mode org's cold-open requests", () => {
  it("the count probe answers > threshold — the value the persisted mode hint replays", async () => {
    const res = await req("/api/leads/map/count");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.total).toBeGreaterThan(MAP_VIEWPORT_MODE_THRESHOLD);
  });

  it("every pin-tier boot window across zooms/screens answers 200 with in-window pins", async () => {
    const failures: string[] = [];
    for (const [w, h] of [[1920, 1080], [390, 844]] as const) {
      for (const zoom of [17, 15, 13, 12, 11]) {
        const reqSpec = pinRequestFor(mapAt(zoom, w, h));
        if (viewportTierForWindow(reqSpec.window) !== "pins") continue; // grid tier owns it
        const res = await req(reqSpec.url);
        if (res.status !== 200) { failures.push(`z${zoom} ${w}x${h} -> ${res.status}`); continue; }
        const { pins, truncated } = unpackMapPins<any>(await res.json());
        if (!pins.length) { failures.push(`z${zoom} ${w}x${h} -> 200 but EMPTY`); continue; }
        const out = pins.filter((p) => p.lat < reqSpec.window.minLat - 1e-4 || p.lat > reqSpec.window.maxLat + 1e-4 ||
          p.lng < reqSpec.window.minLng - 1e-4 || p.lng > reqSpec.window.maxLng + 1e-4);
        if (out.length) failures.push(`z${zoom} ${w}x${h} -> ${out.length} pins OUTSIDE the window`);
        // Knocking zooms must be COMPLETE — the window snapshot only persists
        // complete windows, so a truncated street view would kill the seed.
        if (zoom >= 14 && truncated) failures.push(`z${zoom} ${w}x${h} -> truncated at knocking zoom`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  }, 60_000);

  it("probe + pin window + density grid fired CONCURRENTLY all answer (parallel boot)", async () => {
    const pinSpec = pinRequestFor(mapAt(15, 390, 844));
    const gridUrl = gridRequestFor(mapAt(6, 390, 844)); // wide-zoom boot's other tier
    const [count, pinsRes, gridRes] = await Promise.all([
      req("/api/leads/map/count"), req(pinSpec.url), req(gridUrl),
    ]);
    expect(count.status).toBe(200);
    expect(pinsRes.status).toBe(200);
    expect(gridRes.status).toBe(200);
    const { pins } = unpackMapPins<any>(await pinsRes.json());
    expect(pins.length).toBeGreaterThan(0);
    const grid: any = await gridRes.json();
    expect(grid.cells.length).toBeGreaterThan(0);
  });
});

describe("window snapshot round-trip — packed response to next-boot seed", () => {
  const scope = { tenantId: 1, userId: 1 };

  it("a fetched window seeds the next boot when the persisted camera reopens there, and the boot fetch evicts disowned rows", async () => {
    const s = fakeStorage();
    const spec = pinRequestFor(mapAt(16, 390, 844));
    const first = unpackMapPins<any>(await (await req(spec.url)).json());
    expect(first.truncated).toBe(false);
    expect(first.pins.length).toBeGreaterThan(0);
    // — session end: MapView persists the window (pins + bbox) —
    expect(writeMapWindowSnapshot(scope, first.pins, spec.window, s)).toBe(true);

    // — next cold open: same camera → the seed gate passes —
    const snap = readMapWindowSnapshot<any>(scope, s)!;
    expect(snap.pins.map((p: any) => p.id).sort()).toEqual(first.pins.map((p: any) => p.id).sort());
    const view = cameraViewBBox([CENTER.lng, CENTER.lat], 16, 390, 844);
    expect(bboxIntersects(view, snap.window)).toBe(true);
    // …a camera persisted two towns over must NOT seed
    expect(bboxIntersects(cameraViewBBox([-78.6, 35.8], 16, 390, 844), snap.window)).toBe(false);

    // — a lead was deleted between sessions —
    const victim = first.pins[0].id;
    rawDb.prepare(`DELETE FROM leads WHERE id = ?`).run(victim);
    const second = unpackMapPins<any>(await (await req(spec.url)).json());
    expect(second.truncated).toBe(false);
    // — the immediate boot fetch replaces the seed WITH eviction (the exact
    //   client merge: seed pins as prev, fetched window as evictWindow) —
    const merged = mergeViewportPins(snap.pins, second.pins, keepRegion(spec.view), spec.window);
    expect(merged.pins.some((p: any) => p.id === victim)).toBe(false);
    expect(merged.pins.length).toBe(second.pins.length);
  });
});

describe("server half — the windowed query plan", () => {
  it("uses the map-window covering index (not a whole-tenant walk per pan)", () => {
    const plan = rawDb.prepare(`EXPLAIN QUERY PLAN SELECT l.id FROM leads l
      WHERE l.tenant_id = 1 AND l.lat IS NOT NULL AND l.lng IS NOT NULL
        AND l.lead_status NOT IN ('competitor_suppressed','scope_suppressed','address_review')
        AND l.lat BETWEEN 35.5 AND 35.6 AND l.lng BETWEEN -80.5 AND -80.3
      LIMIT 25001`).all().map((r: any) => r.detail).join(" | ");
    expect(plan).toContain("idx_leads_map_window");
    expect(plan).toContain("tenant_id=? AND lat>");
  });

  it("the grid aggregate runs as a COVERING index scan", () => {
    const plan = rawDb.prepare(`EXPLAIN QUERY PLAN SELECT FLOOR(l.lat/0.4), FLOOR(l.lng/0.4), COUNT(*) FROM leads l
      WHERE l.tenant_id = 1 AND l.lat IS NOT NULL AND l.lng IS NOT NULL
        AND l.lead_status NOT IN ('competitor_suppressed','scope_suppressed','address_review')
        AND l.lat BETWEEN 33 AND 38 AND l.lng BETWEEN -83 AND -78
      GROUP BY 1, 2 LIMIT 5001`).all().map((r: any) => r.detail).join(" | ");
    expect(plan).toContain("COVERING INDEX idx_leads_map_window");
  });

  it("the sampled (over-cap) path is still deterministic and id-ordered — its ORDER BY survived", async () => {
    // A 2°+ window over 61k pins exceeds the 25k cap → sampled response.
    const spec = pinRequestFor(mapAt(9, 1920, 1080));
    const res = await req(spec.url);
    expect(res.status).toBe(200);
    const body = unpackMapPins<any>(await res.json());
    expect(body.truncated).toBe(true);
    const ids = body.pins.map((p: any) => p.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids); // id-ordered
    const again = unpackMapPins<any>(await (await req(spec.url)).json());
    expect(again.pins.map((p: any) => p.id)).toEqual(ids); // stable across pans
  });
});
