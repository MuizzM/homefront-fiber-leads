// ── Tiled scan worker (state machine) ─────────────────────────────────────────
// Cover a whole region without missing anything: split it into tiles, and drive
// each tile through pending → enumerating → qualifying → done, with bounded retry
// on failure. Each tile enumerates via ALL providers (gatherCoverage → merged +
// coverageReport), then qualifies the merged addresses through Kinetic. Because a
// tile is small, a failure/throttle only costs one tile's worth of work and the
// tile just retries — the region always finishes.
//
// Dependencies are injected (gather, qualify) so the state machine is unit-tested
// with fakes; the route wires the real provider gather + the rate-limited Kinetic
// qualifier.
import type { BBox, CoverageReport, CoverageClassification, RawAddress } from "./providers/types";
import { pooledMap } from "./bboxScan";

export type TileStatus = "pending" | "enumerating" | "qualifying" | "done" | "failed";

export interface Tile {
  id: string;
  bbox: BBox;
  status: TileStatus;
  attempts: number;
  addressCount: number;
  newBuildCount: number;
  leadCount: number;
  coverage?: CoverageClassification;
  coverageRatio?: number;
  error?: string;
}

export interface TileScanJob {
  id: string;
  region: BBox;
  tiles: Tile[];
  status: "running" | "paused" | "done" | "cancelled" | "error";
  totals: { tiles: number; tilesDone: number; tilesFailed: number; addresses: number; newBuilds: number; leads: number };
  startedAt: string;
  completedAt?: string;
}

export interface QualifyResult { leads: number; scanned: number }

export interface TileScanDeps {
  gather: (bbox: BBox) => Promise<CoverageReport>;
  qualify: (addresses: RawAddress[], tile: Tile) => Promise<QualifyResult>;
  /** called after each tile settles (for progress emit / persistence). */
  onTile?: (tile: Tile, job: TileScanJob) => void;
  /** cooperative cancel — checked between tiles and between attempts. */
  cancelled?: () => boolean;
  /** ISO timestamp source (injected so the worker stays deterministic in tests). */
  now?: () => string;
}

export interface TileScanOpts {
  tileDeg?: number;       // tile size in degrees (~0.02° ≈ 1.4 mi)
  tileConcurrency?: number; // tiles processed at once
  maxAttempts?: number;    // retry budget per tile
}

// ── Pure: split a region into a grid of tiles ─────────────────────────────────
export function planTiles(region: BBox, tileDeg = 0.02): Tile[] {
  const tiles: Tile[] = [];
  const step = Math.max(0.002, tileDeg);
  const EPS = 1e-7; // ~1 cm — skip float-drift sliver tiles at the top/right edge
  let r = 0;
  for (let s = region.south; s < region.north - EPS; s += step, r++) {
    let c = 0;
    for (let w = region.west; w < region.east - EPS; w += step, c++) {
      const north = Math.min(s + step, region.north);
      const east = Math.min(w + step, region.east);
      if (north - s < EPS || east - w < EPS) continue; // degenerate — no area to scan
      tiles.push({
        id: `t_${r}_${c}`,
        bbox: { south: s, north, west: w, east },
        status: "pending", attempts: 0, addressCount: 0, newBuildCount: 0, leadCount: 0,
      });
    }
  }
  return tiles;
}

// ── Pure: may a failed tile be retried? ───────────────────────────────────────
export function shouldRetry(tile: Tile, maxAttempts: number): boolean {
  return tile.status !== "done" && tile.attempts < maxAttempts;
}

function recomputeTotals(job: TileScanJob) {
  const t = job.totals;
  t.tilesDone = job.tiles.filter((x) => x.status === "done").length;
  t.tilesFailed = job.tiles.filter((x) => x.status === "failed").length;
  t.addresses = job.tiles.reduce((n, x) => n + x.addressCount, 0);
  t.newBuilds = job.tiles.reduce((n, x) => n + x.newBuildCount, 0);
  t.leads = job.tiles.reduce((n, x) => n + x.leadCount, 0);
}

/**
 * Run one tile through the state machine, with retry. Mutates `tile` in place and
 * returns it. enumerating (gather) → qualifying (Kinetic) → done; any throw bumps
 * attempts and retries until the budget is spent, then lands on `failed`.
 */
export async function runTile(tile: Tile, deps: TileScanDeps, maxAttempts: number): Promise<Tile> {
  while (shouldRetry(tile, maxAttempts)) {
    tile.attempts++;
    tile.error = undefined;
    try {
      tile.status = "enumerating";
      if (deps.cancelled?.()) return tile;
      const report = await deps.gather(tile.bbox);
      tile.addressCount = report.merged.length;
      tile.newBuildCount = report.newBuildCandidates.length;
      tile.coverage = report.classification;
      tile.coverageRatio = report.coverageRatio ?? undefined;

      if (report.merged.length === 0) { tile.status = "done"; return tile; }

      tile.status = "qualifying";
      if (deps.cancelled?.()) return tile;
      const q = await deps.qualify(report.merged, tile);
      tile.leadCount = q.leads;
      tile.status = "done";
      return tile;
    } catch (e: any) {
      tile.error = e?.message ?? "tile failed";
      tile.status = "failed";
      // loop: retry if budget remains
    }
  }
  return tile; // exhausted retries → stays "failed"
}

/**
 * Drive an entire region. Tiles run at `tileConcurrency` at a time (so a big
 * region doesn't open unbounded Kinetic load); the job object is updated live so
 * a caller can poll progress, and `cancelled()` stops it cleanly between tiles.
 */
export async function runTileScan(job: TileScanJob, deps: TileScanDeps, opts: TileScanOpts = {}): Promise<TileScanJob> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const concurrency = Math.max(1, opts.tileConcurrency ?? 2);
  const now = deps.now ?? (() => new Date().toISOString());

  await pooledMap(job.tiles, concurrency, async (tile) => {
    if (deps.cancelled?.()) return tile;
    if (tile.status === "done") return tile; // resume: skip finished tiles
    await runTile(tile, deps, maxAttempts);
    recomputeTotals(job);
    deps.onTile?.(tile, job);
    return tile;
  });

  recomputeTotals(job);
  if (deps.cancelled?.()) job.status = "cancelled";
  else if (job.totals.tilesFailed > 0 && job.totals.tilesDone === 0) job.status = "error";
  else job.status = "done";
  job.completedAt = now();
  return job;
}

/** Build a fresh job for a region. */
export function createTileScanJob(id: string, region: BBox, opts: TileScanOpts = {}, now = () => new Date().toISOString()): TileScanJob {
  const tiles = planTiles(region, opts.tileDeg);
  return {
    id, region, tiles, status: "running",
    totals: { tiles: tiles.length, tilesDone: 0, tilesFailed: 0, addresses: 0, newBuilds: 0, leads: 0 },
    startedAt: now(),
  };
}
