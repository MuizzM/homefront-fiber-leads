// Regression for the production blank-map incident (map zoom tiers).
//
// The density tier's contract is "the client clamps its fetch window to the
// 15° grid guard, so a grid request can NEVER 400". It did 400: a window
// clamped to EXACTLY 15° serializes through bboxParam (5dp) and re-parses as
// binary doubles whose difference is 15.000000000000002° — the server's
// `span > 15` guard rejected it. The failure chain that blanked the owner's
// map:
//   - past the 3° pin boundary the pin fetch is tier-gated OFF (by design),
//   - the grid fetch 400'd and the catch swallowed it silently,
//   - the old "Zoom in to load pins" notice was removed with the dead state,
//   - the NEW persisted-camera restore reopens the map at the owner's last
//     (wide) zoom — a cold session with an empty pin cache and a failing
//     grid fetch shows NOTHING, with no explanation, on every launch.
// A second variant: at world zooms the margin-expanded window is clamped to
// ±180/±90 first, dragging its midpoint to 0°,0° — the "central 15°" fetch
// covered Greenwich ocean instead of the on-screen territory → 200 with zero
// cells, same blank map.
//
// This test drives the REAL server with the EXACT windows the client builds
// (currentFetchWindow → clampToGridGuard(view-center) → bboxParam) across the
// whole grid-tier zoom band on desktop and phone screens: every request must
// answer 200 with cells over the territory.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  currentFetchWindow, clampToGridGuard, gridCellForSpan, bboxParam,
  viewportTierForWindow,
} from "../../client/src/lib/mapViewport";

let server: Server; let baseUrl: string; let storage: any; let rawDb: any; let session: string;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-grid-contract-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  const m = storage.createTeamMember({ name: "Owner", email: "owner@contract.test", role: "admin", active: true, tenantId: 1 } as any);
  const u = storage.createUser({ name: "Owner", email: "owner@contract.test", role: "admin", active: true, tenantId: 1, teamMemberId: m.id } as any);
  session = storage.createSession(u.id).id;
  // A deterministic NC-wide lead field (the owner's territory).
  const insert = rawDb.prepare(`INSERT INTO leads
    (address, city, state, zip, lat, lng, tenant_id, lead_status, created_at, updated_at)
    VALUES (?, 'T', 'NC', '28100', ?, ?, 1, 'prospect', datetime('now'), datetime('now'))`);
  const load = rawDb.transaction(() => {
    let i = 0;
    for (let lat = 33.9; lat <= 36.6; lat += 0.09) {
      for (let lng = -84.3; lng <= -75.5; lng += 0.11) {
        insert.run(`A${i++}`, lat, lng);
      }
    }
  });
  load();
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json()); server = createServer(app);
  registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
}, 120_000);
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Mercator-ish map stub: bounds derived from zoom + screen size, exactly the
 *  shape currentFetchWindow reads. */
function mapAt(zoom: number, widthPx: number, heightPx: number, center: { lng: number; lat: number }) {
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

/** Exactly fetchViewportGrid's window construction (MapView.tsx): camera
 *  center anchor, raw-view midpoint fallback. */
function gridRequestFor(map: ReturnType<typeof mapAt>) {
  const bounds = currentFetchWindow(map)!;
  const c = map.getCenter();
  const window = clampToGridGuard(bounds.window, undefined, c ?? {
    lng: (bounds.view.minLng + bounds.view.maxLng) / 2,
    lat: (bounds.view.minLat + bounds.view.maxLat) / 2,
  });
  const span = Math.max(window.maxLng - window.minLng, window.maxLat - window.minLat);
  return { tier: viewportTierForWindow(bounds.window), bbox: bboxParam(window), cell: gridCellForSpan(span) };
}

describe("grid window contract — a client-built grid request can NEVER blank the map", () => {
  it("the observed production repro bbox answers 200 (float-dust span, not malformed)", async () => {
    // -72.9 − (-87.9) parses to 15.000000000000002 — this exact request 400'd
    // in production and silently blanked the density tier.
    const res = await fetch(`${baseUrl}/api/leads/map/grid?bbox=-87.9,26.9061,-72.9,41.9061&cell=1.25`, {
      headers: { "x-session-id": session },
    });
    const body: any = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.cells.length).toBeGreaterThan(0);
  });

  it("a genuinely over-guard request still 400s (the guard is tolerant, not gone)", async () => {
    const res = await fetch(`${baseUrl}/api/leads/map/grid?bbox=-90,30,-74.9,36`, {
      headers: { "x-session-id": session },
    }); // 15.1° lng — a whole zoom level past the guard
    expect(res.status).toBe(400);
  });

  it("every grid-tier window across zooms/screens/centers answers 200 WITH territory cells", async () => {
    const failures: string[] = [];
    const centers = [
      { lng: -80.4, lat: 35.3 },      // the repro camera (span parses > 15 pre-fix)
      { lng: -80.41, lat: 35.545 },   // Rockwell (the app's default center)
      { lng: -79.123456, lat: 35.98 },// arbitrary pan position
    ];
    for (const [w, h] of [[1920, 1080], [390, 844]] as const) {
      for (let zoom = 2; zoom <= 9.5; zoom += 0.5) {
        for (const center of centers) {
          const req = gridRequestFor(mapAt(zoom, w, h, center));
          if (req.tier !== "grid") continue; // pin tier handles it (unchanged path)
          const res = await fetch(`${baseUrl}/api/leads/map/grid?bbox=${req.bbox}&cell=${req.cell}`, {
            headers: { "x-session-id": session },
          });
          if (res.status !== 200) {
            failures.push(`z${zoom} ${w}x${h} @${center.lng},${center.lat} -> ${res.status} bbox=${req.bbox}`);
            continue;
          }
          const body: any = await res.json();
          // The view sits over a 174k-lead-class territory: a grid answer with
          // ZERO cells is the blank-map defect (Greenwich drift), not truth.
          if (!body.cells.length) {
            failures.push(`z${zoom} ${w}x${h} @${center.lng},${center.lat} -> 200 but EMPTY cells bbox=${req.bbox}`);
          }
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  }, 120_000);
});
