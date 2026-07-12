import { describe, it, expect } from "vitest";
import {
  planTiles, shouldRetry, runTile, runTileScan, createTileScanJob,
  type Tile, type TileScanDeps,
} from "../../server/tileScan";
import type { BBox, CoverageReport, RawAddress } from "../../server/providers/types";

const REGION: BBox = { south: 35.50, north: 35.54, west: -82.10, east: -82.06 };
const A = (address: string): RawAddress => ({ address, city: "Inman", state: "SC", zip: "29349", lat: 35.51, lng: -82.09 });

function fakeReport(merged: RawAddress[], newBuilds = 0): CoverageReport {
  return {
    bbox: REGION, providers: [], merged: merged.map((m) => ({ ...m, sources: ["mapbox"], primarySource: "mapbox", missedByPrimary: false })),
    knownCount: merged.length, primaryCount: merged.length, coverageRatio: 1, classification: "full",
    newBuildCandidates: merged.slice(0, newBuilds).map((m) => ({ ...m, sources: ["parcel"], primarySource: "parcel", missedByPrimary: true })),
    estimated: false,
  };
}
const NOW = () => "2026-07-12T00:00:00.000Z";

describe("planTiles", () => {
  it("splits a region into a clamped grid", () => {
    const tiles = planTiles(REGION, 0.02); // 0.04 / 0.02 = 2 × 2
    expect(tiles).toHaveLength(4);
    for (const t of tiles) {
      expect(t.bbox.north).toBeLessThanOrEqual(REGION.north + 1e-9);
      expect(t.bbox.east).toBeLessThanOrEqual(REGION.east + 1e-9);
      expect(t.status).toBe("pending");
    }
  });
});

describe("shouldRetry", () => {
  it("allows retries until the budget is spent, never for a done tile", () => {
    expect(shouldRetry({ status: "failed", attempts: 1 } as Tile, 3)).toBe(true);
    expect(shouldRetry({ status: "failed", attempts: 3 } as Tile, 3)).toBe(false);
    expect(shouldRetry({ status: "done", attempts: 0 } as Tile, 3)).toBe(false);
  });
});

describe("runTile state machine", () => {
  const mkTile = (): Tile => ({ id: "t", bbox: REGION, status: "pending", attempts: 0, addressCount: 0, newBuildCount: 0, leadCount: 0 });

  it("enumerate → qualify → done, carrying counts through", async () => {
    const deps: TileScanDeps = {
      gather: async () => fakeReport([A("1 Main St"), A("2 Main St")], 1),
      qualify: async (addrs) => ({ leads: 1, scanned: addrs.length }),
      now: NOW,
    };
    const t = await runTile(mkTile(), deps, 3);
    expect(t.status).toBe("done");
    expect(t.addressCount).toBe(2);
    expect(t.newBuildCount).toBe(1);
    expect(t.leadCount).toBe(1);
    expect(t.attempts).toBe(1);
  });

  it("retries a transient failure then succeeds", async () => {
    let calls = 0;
    const deps: TileScanDeps = {
      gather: async () => { if (++calls < 3) throw new Error("throttled"); return fakeReport([A("1 Main St")]); },
      qualify: async () => ({ leads: 0, scanned: 1 }),
    };
    const t = await runTile(mkTile(), deps, 3);
    expect(t.status).toBe("done");
    expect(t.attempts).toBe(3);
  });

  it("lands on failed once the retry budget is exhausted", async () => {
    const deps: TileScanDeps = {
      gather: async () => { throw new Error("permanently broken"); },
      qualify: async () => ({ leads: 0, scanned: 0 }),
    };
    const t = await runTile(mkTile(), deps, 2);
    expect(t.status).toBe("failed");
    expect(t.attempts).toBe(2);
    expect(t.error).toMatch(/broken/);
  });

  it("short-circuits to done when a tile has zero addresses", async () => {
    const deps: TileScanDeps = { gather: async () => fakeReport([]), qualify: async () => { throw new Error("should not qualify"); } };
    const t = await runTile(mkTile(), deps, 3);
    expect(t.status).toBe("done");
    expect(t.leadCount).toBe(0);
  });
});

describe("runTileScan (whole region)", () => {
  it("processes every tile and aggregates totals", async () => {
    const job = createTileScanJob("job1", REGION, { tileDeg: 0.02 }, NOW);
    const deps: TileScanDeps = {
      gather: async () => fakeReport([A("1 Main St"), A("2 Main St")], 1),
      qualify: async () => ({ leads: 2, scanned: 2 }),
      now: NOW,
    };
    const done = await runTileScan(job, deps, { tileDeg: 0.02, tileConcurrency: 2, maxAttempts: 3 });
    expect(done.status).toBe("done");
    expect(done.totals.tiles).toBe(4);
    expect(done.totals.tilesDone).toBe(4);
    expect(done.totals.addresses).toBe(8);   // 4 tiles × 2
    expect(done.totals.leads).toBe(8);        // 4 × 2
    expect(done.totals.newBuilds).toBe(4);    // 4 × 1
  });

  it("resumes — already-done tiles are not re-run", async () => {
    const job = createTileScanJob("job2", REGION, { tileDeg: 0.02 }, NOW);
    job.tiles[0].status = "done"; job.tiles[0].leadCount = 5; job.tiles[0].addressCount = 3;
    let gathers = 0;
    const deps: TileScanDeps = {
      gather: async () => { gathers++; return fakeReport([A("x")]); },
      qualify: async () => ({ leads: 1, scanned: 1 }),
      now: NOW,
    };
    await runTileScan(job, deps, { tileConcurrency: 4 });
    expect(gathers).toBe(3); // 4 tiles − 1 already done
  });

  it("stops cleanly when cancelled", async () => {
    const job = createTileScanJob("job3", REGION, { tileDeg: 0.02 }, NOW);
    const deps: TileScanDeps = {
      gather: async () => fakeReport([A("x")]),
      qualify: async () => ({ leads: 0, scanned: 1 }),
      cancelled: () => true,
      now: NOW,
    };
    const done = await runTileScan(job, deps, {});
    expect(done.status).toBe("cancelled");
  });
});
