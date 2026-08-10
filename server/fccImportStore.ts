// ── FCC BDC vintage import - staged, streamed, idempotent, reversible ────────
//
// Acquisition is NOT here, and cannot be. Every broadbandmap.fcc.gov endpoint
// answers 403 to a server-side client (Akamai edge rule, re-verified
// 2026-08-10), so there is no background fetcher to write and no retry policy
// that would ever succeed. An operator pulls the provider file in a browser
// and streams it in through openImport/ingestChunk/finalizeImport.
//
// That constraint turns out to be the right shape anyway: it is the same
// chunked, checksummed, finalize-or-discard pipeline the DNC importer uses,
// and it means a 40-minute import can be resumed after a dropped connection
// instead of restarted.
//
// TRANSACTION DISCIPLINE
// Every write path here is bounded. A chunk is one short transaction; finalize
// walks the staged blocks in batches rather than rolling a whole vintage in a
// single statement. This is deliberate: server/db.ts documents an 8GB WAL
// incident caused by long writer transactions starving the checkpointer, and
// an import is exactly the kind of job that would reproduce it.

import { createHash, randomUUID } from "node:crypto";
import { rawDb } from "./db";
import {
  parseVintageCode, vintageOf, vintageAsOfMs, sortVintages,
  type FccVintageCode,
} from "@shared/fccVintage";
import type { FccBlockFacts } from "@shared/kineticBuild2026";

/**
 * Feature flag, read at CALL time rather than captured at module load.
 *
 * That matters operationally: this is the kill switch. If the layer ever
 * misbehaves in production the flag has to take effect on the next request,
 * not on the next restart - the same reason server/areaSkipTrace.ts reads its
 * flag inside the handler. It also makes the disabled path testable without a
 * module-registry reset.
 */
export function kinetic2026Enabled(): boolean {
  return process.env.KINETIC_2026_BUILDS !== "off";
}

/** Fiber to the Premises. The only technology code this pipeline accepts. */
export const TECH_FTTP = 50;

/** BDC business_residential_code values that include residential service.
 *  B (business only) is rejected - this is a door-to-door residential product. */
const RESIDENTIAL_BR_CODES = new Set(["R", "X"]);

/** The seven counties in the brief, by FIPS. A block outside this set is
 *  rejected at ingest rather than stored and filtered later, so the footprint
 *  table can never grow past the authorized territory. */
export const TARGET_COUNTY_FIPS: Readonly<Record<string, string>> = {
  "37119": "Mecklenburg",
  "37025": "Cabarrus",
  "37159": "Rowan",
  "37057": "Davidson",
  "37097": "Iredell",
  "37167": "Stanly",
  "37179": "Union",
};

/** Chunk bounds. Small enough that one chunk is a short transaction, large
 *  enough that a statewide provider file is thousands of requests, not
 *  hundreds of thousands. */
export const MAX_CHUNK_ROWS = 5_000;
/** Blocks rolled up per transaction at finalize. */
export const FINALIZE_BATCH_BLOCKS = 500;
/** Location ids kept per block for provenance. A dense block can hold
 *  hundreds; the full list is not needed to prove anything, the count is. */
export const MAX_LOCATION_IDS_PER_BLOCK = 250;

export interface FccAvailabilityRow {
  locationId: string;
  blockGeoid: string;
  providerId: string;
  technology: number;
  /** business_residential_code: R, B or X. */
  brCode: string;
  maxDownMbps?: number | null;
  maxUpMbps?: number | null;
}

export interface OpenImportInput {
  tenantId: number;
  vintage: string;
  stateFips?: string;
  providerIds: readonly string[];
  countyFips?: readonly string[];
  sourceUrl?: string | null;
  /** Operator's description of where the file came from. Hashed into the
   *  manifest so two imports of different files can never collide. */
  manifest: string;
  expectedChunkCount: number;
  expectedRowCount: number;
  createdBy?: number | null;
}

export interface ImportJob {
  id: string;
  tenantId: number;
  vintage: FccVintageCode;
  sourceAsOf: string;
  stateFips: string;
  providerIds: string[];
  countyFips: string[];
  status: "open" | "finalized" | "discarded" | "failed";
  expectedChunkCount: number;
  expectedRowCount: number;
  receivedRowCount: number;
  rejectedRowCount: number;
  createdAt: string;
  finalizedAt: string | null;
}

export interface ChunkResult {
  importId: string;
  chunkIndex: number;
  accepted: number;
  rejected: number;
  /** True when this exact chunk had already been applied - a replay. */
  duplicate: boolean;
  rejectionReasons: Record<string, number>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Stable digest of a chunk's contents. Field order is fixed here rather than
 *  taken from JSON.stringify's key order, so a client that serialises its
 *  objects differently still produces the same hash for the same data. */
export function chunkDigest(rows: readonly FccAvailabilityRow[]): string {
  const canonical = rows
    .map((r) => [r.locationId, r.blockGeoid, r.providerId, r.technology, r.brCode,
                 r.maxDownMbps ?? "", r.maxUpMbps ?? ""].join("|"))
    .join("\n");
  return sha256(canonical);
}

function rowFor(job: ImportJob, row: FccAvailabilityRow): { ok: true } | { ok: false; reason: string } {
  if (!row || typeof row.locationId !== "string" || !row.locationId.trim()) return { ok: false, reason: "missing_location_id" };
  if (typeof row.blockGeoid !== "string" || !/^\d{15}$/.test(row.blockGeoid)) return { ok: false, reason: "bad_block_geoid" };
  if (Number(row.technology) !== TECH_FTTP) return { ok: false, reason: "not_fttp" };
  if (!RESIDENTIAL_BR_CODES.has(String(row.brCode).toUpperCase())) return { ok: false, reason: "not_residential" };
  if (!row.blockGeoid.startsWith(job.stateFips)) return { ok: false, reason: "wrong_state" };
  // County FIPS is the first five digits of a block GEOID.
  const county = row.blockGeoid.slice(0, 5);
  if (job.countyFips.length && !job.countyFips.includes(county)) return { ok: false, reason: "out_of_scope_county" };
  if (job.providerIds.length && !job.providerIds.includes(String(row.providerId))) return { ok: false, reason: "other_provider" };
  return { ok: true };
}

function hydrate(raw: any): ImportJob {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    vintage: raw.vintage,
    sourceAsOf: raw.source_as_of,
    stateFips: raw.state_fips,
    providerIds: JSON.parse(raw.provider_ids_json || "[]"),
    countyFips: JSON.parse(raw.county_fips_json || "[]"),
    status: raw.status,
    expectedChunkCount: raw.expected_chunk_count,
    expectedRowCount: raw.expected_row_count,
    receivedRowCount: raw.received_row_count,
    rejectedRowCount: raw.rejected_row_count,
    createdAt: raw.created_at,
    finalizedAt: raw.finalized_at ?? null,
  };
}

export function getImport(importId: string): ImportJob | null {
  const raw = rawDb.prepare(`SELECT * FROM fcc_import_jobs WHERE id = ?`).get(importId) as any;
  return raw ? hydrate(raw) : null;
}

export function listImports(tenantId: number, limit = 50): ImportJob[] {
  const rows = rawDb.prepare(
    `SELECT * FROM fcc_import_jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`,
  ).all(tenantId, Math.max(1, Math.min(200, limit))) as any[];
  return rows.map(hydrate);
}

export function openImport(input: OpenImportInput): ImportJob {
  const vintage = parseVintageCode(input.vintage);
  if (!vintage) throw new Error(`Unrecognised BDC vintage: ${String(input.vintage)}`);
  const stateFips = String(input.stateFips ?? "37");
  const counties = [...new Set((input.countyFips ?? Object.keys(TARGET_COUNTY_FIPS)).map(String))];
  const unknown = counties.filter((c) => !TARGET_COUNTY_FIPS[c]);
  if (unknown.length) throw new Error(`County FIPS outside the authorized territory: ${unknown.join(", ")}`);
  if (!input.providerIds.length) throw new Error("At least one FCC provider id is required - an unfiltered import would ingest every carrier.");
  if (input.expectedChunkCount <= 0) throw new Error("expectedChunkCount must be positive");

  const id = randomUUID();
  const manifestHash = sha256(`${vintage}|${stateFips}|${counties.join(",")}|${input.providerIds.join(",")}|${input.manifest}`);
  rawDb.prepare(`
    INSERT INTO fcc_import_jobs (
      id, tenant_id, vintage, source_as_of, state_fips, provider_ids_json, county_fips_json,
      source_manifest_sha256, source_url, expected_chunk_count, expected_row_count, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, input.tenantId, vintage, vintageOf(vintage).asOf, stateFips,
    JSON.stringify([...input.providerIds].map(String)), JSON.stringify(counties),
    manifestHash, input.sourceUrl ?? null,
    input.expectedChunkCount, Math.max(0, input.expectedRowCount), input.createdBy ?? null,
  );
  return getImport(id)!;
}

/**
 * Apply one chunk. Idempotent on (import, chunk index): a replay carrying the
 * same digest is acknowledged as a duplicate and changes nothing; a replay
 * carrying DIFFERENT data for an index that was already applied is an error,
 * because silently accepting it would make the received counts a lie.
 */
export function ingestChunk(
  importId: string,
  chunkIndex: number,
  rows: readonly FccAvailabilityRow[],
): ChunkResult {
  const job = getImport(importId);
  if (!job) throw new Error(`Unknown import ${importId}`);
  if (job.status !== "open") throw new Error(`Import ${importId} is ${job.status}, not open`);
  if (rows.length > MAX_CHUNK_ROWS) throw new Error(`Chunk exceeds ${MAX_CHUNK_ROWS} rows`);

  const digest = chunkDigest(rows);
  const existing = rawDb.prepare(
    `SELECT chunk_sha256, accepted_count, rejected_count FROM fcc_import_chunks WHERE import_id = ? AND chunk_index = ?`,
  ).get(importId, chunkIndex) as any;
  if (existing) {
    if (existing.chunk_sha256 !== digest) {
      throw new Error(`Chunk ${chunkIndex} was already applied with different contents - refusing to reapply.`);
    }
    return {
      importId, chunkIndex, accepted: existing.accepted_count, rejected: existing.rejected_count,
      duplicate: true, rejectionReasons: {},
    };
  }

  const rejectionReasons: Record<string, number> = {};
  const accepted: FccAvailabilityRow[] = [];
  for (const row of rows) {
    const verdict = rowFor(job, row);
    if (verdict.ok) accepted.push(row);
    else rejectionReasons[verdict.reason] = (rejectionReasons[verdict.reason] ?? 0) + 1;
  }

  const insert = rawDb.prepare(`
    INSERT INTO fcc_import_staging (import_id, location_id, block_geoid, provider_id, technology, br_code, max_down_mbps, max_up_mbps)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(import_id, location_id, provider_id, technology) DO UPDATE SET
      max_down_mbps = MAX(COALESCE(excluded.max_down_mbps, 0), COALESCE(fcc_import_staging.max_down_mbps, 0)),
      max_up_mbps   = MAX(COALESCE(excluded.max_up_mbps, 0),   COALESCE(fcc_import_staging.max_up_mbps, 0))
  `);
  const rejected = rows.length - accepted.length;

  // One short transaction per chunk: the staged rows and the receipt that says
  // they landed commit together, so a crash mid-chunk leaves no half-applied
  // state for the resume to reconcile.
  const apply = rawDb.transaction(() => {
    for (const row of accepted) {
      insert.run(
        importId, row.locationId, row.blockGeoid, String(row.providerId), TECH_FTTP,
        String(row.brCode).toUpperCase(),
        row.maxDownMbps ?? null, row.maxUpMbps ?? null,
      );
    }
    rawDb.prepare(`
      INSERT INTO fcc_import_chunks (import_id, chunk_index, chunk_sha256, input_count, accepted_count, rejected_count)
      VALUES (?,?,?,?,?,?)
    `).run(importId, chunkIndex, digest, rows.length, accepted.length, rejected);
    rawDb.prepare(`
      UPDATE fcc_import_jobs
         SET received_row_count = received_row_count + ?,
             rejected_row_count = rejected_row_count + ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(accepted.length, rejected, importId);
  });
  apply();

  return { importId, chunkIndex, accepted: accepted.length, rejected, duplicate: false, rejectionReasons };
}

export interface FinalizeResult {
  importId: string;
  vintage: FccVintageCode;
  blocksWritten: number;
  locationsWritten: number;
}

/**
 * Roll staging into the durable per-block footprint and drop the staged rows.
 *
 * Refuses when chunks are missing: an import that received 9 of 10 chunks
 * would otherwise finalize a footprint with a hole in it, and a hole in the
 * BASELINE reads downstream as "Kinetic did not serve this block", which is
 * precisely the error that manufactures a false 2026 build.
 */
export function finalizeImport(importId: string): FinalizeResult {
  const job = getImport(importId);
  if (!job) throw new Error(`Unknown import ${importId}`);
  if (job.status !== "open") throw new Error(`Import ${importId} is ${job.status}, not open`);

  const chunkCount = (rawDb.prepare(
    `SELECT COUNT(*) AS n FROM fcc_import_chunks WHERE import_id = ?`,
  ).get(importId) as any).n as number;
  if (chunkCount !== job.expectedChunkCount) {
    throw new Error(`Refusing to finalize: received ${chunkCount} of ${job.expectedChunkCount} chunks. A partial baseline would read as absent coverage.`);
  }

  const blocks = rawDb.prepare(`
    SELECT block_geoid AS blockGeoid,
           COUNT(DISTINCT location_id) AS kineticLocations,
           MAX(max_down_mbps) AS maxDown,
           MAX(max_up_mbps) AS maxUp
      FROM fcc_import_staging
     WHERE import_id = ?
     GROUP BY block_geoid
     ORDER BY block_geoid
  `).all(importId) as Array<{ blockGeoid: string; kineticLocations: number; maxDown: number | null; maxUp: number | null }>;

  const idsFor = rawDb.prepare(`
    SELECT DISTINCT location_id FROM fcc_import_staging
     WHERE import_id = ? AND block_geoid = ? ORDER BY location_id LIMIT ?
  `);
  const upsert = rawDb.prepare(`
    INSERT INTO fcc_block_footprint (
      tenant_id, vintage, block_geoid, county_fips, state_fips,
      kinetic_locations, total_residential_locations, max_down_mbps, max_up_mbps,
      location_ids_json, source_as_of, import_id
    ) VALUES (?,?,?,?,?,?,COALESCE((SELECT total_residential_locations FROM fcc_block_footprint WHERE tenant_id=? AND vintage=? AND block_geoid=?),0),?,?,?,?,?)
    ON CONFLICT(tenant_id, vintage, block_geoid) DO UPDATE SET
      kinetic_locations = excluded.kinetic_locations,
      max_down_mbps     = excluded.max_down_mbps,
      max_up_mbps       = excluded.max_up_mbps,
      location_ids_json = excluded.location_ids_json,
      import_id         = excluded.import_id
  `);

  let locationsWritten = 0;
  // Batched so no single transaction holds the writer lock across a whole
  // vintage. See the WAL note at the top of this file.
  for (let offset = 0; offset < blocks.length; offset += FINALIZE_BATCH_BLOCKS) {
    const batch = blocks.slice(offset, offset + FINALIZE_BATCH_BLOCKS);
    // .immediate(), NOT deferred: this batch READS the staged location ids and
    // then WRITES the rollup. Under a deferred BEGIN the read takes a snapshot
    // and the later write throws SQLITE_BUSY_SNAPSHOT the instant any other
    // connection commits - a failure busy_timeout does not cover, and one a
    // long import running beside live scanners would hit routinely. Taking the
    // write lock up front makes the batch wait instead of exploding.
    rawDb.transaction(() => {
      for (const block of batch) {
        const ids = (idsFor.all(importId, block.blockGeoid, MAX_LOCATION_IDS_PER_BLOCK) as Array<{ location_id: string }>)
          .map((r) => r.location_id);
        upsert.run(
          job.tenantId, job.vintage, block.blockGeoid, block.blockGeoid.slice(0, 5), job.stateFips,
          block.kineticLocations,
          job.tenantId, job.vintage, block.blockGeoid,
          block.maxDown, block.maxUp,
          JSON.stringify(ids), job.sourceAsOf, importId,
        );
        locationsWritten += block.kineticLocations;
      }
    }).immediate();
  }

  rawDb.transaction(() => {
    rawDb.prepare(`DELETE FROM fcc_import_staging WHERE import_id = ?`).run(importId);
    rawDb.prepare(`UPDATE fcc_import_jobs SET status='finalized', finalized_at=datetime('now'), updated_at=datetime('now') WHERE id = ?`).run(importId);
  })();

  return { importId, vintage: job.vintage, blocksWritten: blocks.length, locationsWritten };
}

/** Abandon an open import. Staging goes, the receipt trail stays. */
export function discardImport(importId: string, reason?: string): void {
  const job = getImport(importId);
  if (!job) throw new Error(`Unknown import ${importId}`);
  if (job.status !== "open") throw new Error(`Import ${importId} is ${job.status}, not open`);
  rawDb.transaction(() => {
    rawDb.prepare(`DELETE FROM fcc_import_staging WHERE import_id = ?`).run(importId);
    rawDb.prepare(`UPDATE fcc_import_jobs SET status='discarded', error_code=?, updated_at=datetime('now') WHERE id = ?`)
      .run(reason ?? null, importId);
  })();
}

/**
 * Undo a finalized vintage. The durable footprint rows for that vintage are
 * removed; every other vintage is untouched, and the projector re-derives
 * classifications from what remains on its next pass.
 *
 * Deliberately does NOT touch leads or kinetic_build_state. Removing evidence
 * must never silently delete a door a rep has already worked - the projector
 * downgrades the classification instead, which is visible and reversible.
 */
export function revertVintage(tenantId: number, vintageRaw: string): { removedBlocks: number } {
  const vintage = parseVintageCode(vintageRaw);
  if (!vintage) throw new Error(`Unrecognised BDC vintage: ${String(vintageRaw)}`);
  const removed = rawDb.prepare(
    `DELETE FROM fcc_block_footprint WHERE tenant_id = ? AND vintage = ?`,
  ).run(tenantId, vintage);
  return { removedBlocks: removed.changes };
}

/** Vintages with a durable footprint, oldest first. */
export function importedVintages(tenantId: number): FccVintageCode[] {
  const rows = rawDb.prepare(
    `SELECT DISTINCT vintage FROM fcc_block_footprint WHERE tenant_id = ?`,
  ).all(tenantId) as Array<{ vintage: FccVintageCode }>;
  return sortVintages(rows.map((r) => r.vintage));
}

/** Populate the denominator used to tell a finished block from a half-built
 *  one. Kinetic's own filing cannot supply it (it only lists what Kinetic
 *  serves), so it arrives separately - Census block housing-unit counts, or
 *  the nationwide BDC file if the operator imports one. Absent a denominator
 *  the value stays 0, which the classifier reads as "unknown" and which stops
 *  likely_2026 from being asserted rather than guessing at it. */
export function setBlockDenominators(
  tenantId: number,
  vintage: string,
  counts: ReadonlyArray<{ blockGeoid: string; totalResidentialLocations: number }>,
): number {
  const code = parseVintageCode(vintage);
  if (!code) throw new Error(`Unrecognised BDC vintage: ${String(vintage)}`);
  const update = rawDb.prepare(
    `UPDATE fcc_block_footprint SET total_residential_locations = ?
      WHERE tenant_id = ? AND vintage = ? AND block_geoid = ?`,
  );
  let changed = 0;
  for (let offset = 0; offset < counts.length; offset += FINALIZE_BATCH_BLOCKS) {
    const batch = counts.slice(offset, offset + FINALIZE_BATCH_BLOCKS);
    rawDb.transaction(() => {
      for (const row of batch) {
        changed += update.run(Math.max(0, row.totalResidentialLocations), tenantId, code, row.blockGeoid).changes;
      }
    })();
  }
  return changed;
}

/**
 * Everything the classifier needs to know about one census block, assembled
 * from whichever vintages have been imported.
 *
 * The baseline is the newest vintage strictly older than the latest one, so
 * the comparison is always "the two most recent filings we hold" rather than a
 * hard-coded pair that would silently stop updating.
 */
export function blockFactsFor(tenantId: number, blockGeoid: string | null): FccBlockFacts | null {
  if (!blockGeoid) return null;
  const rows = rawDb.prepare(`
    SELECT vintage, kinetic_locations AS kineticLocations,
           total_residential_locations AS totalLocations,
           max_down_mbps AS maxDown, location_ids_json AS locationIds
      FROM fcc_block_footprint
     WHERE tenant_id = ? AND block_geoid = ?
  `).all(tenantId, blockGeoid) as Array<{
    vintage: FccVintageCode; kineticLocations: number; totalLocations: number;
    maxDown: number | null; locationIds: string;
  }>;

  const allVintages = importedVintages(tenantId);
  if (!allVintages.length) return null;
  const latestVintage = allVintages[allVintages.length - 1];
  const baselineVintage = allVintages.length > 1 ? allVintages[allVintages.length - 2] : null;

  const byVintage = new Map(rows.map((r) => [r.vintage, r]));
  const latest = byVintage.get(latestVintage) ?? null;
  const baseline = baselineVintage ? byVintage.get(baselineVintage) ?? null : null;

  // First vintage in which Kinetic reported ANY residential FTTP here. Rows
  // exist only for vintages where Kinetic filed something, so absence of a row
  // is absence of coverage - the whole basis of the pre-2026 baseline.
  const reportedVintages = sortVintages(
    rows.filter((r) => r.kineticLocations > 0).map((r) => r.vintage),
  );

  return {
    blockGeoid,
    firstReportedVintage: reportedVintages[0] ?? null,
    latestVintage,
    baselineVintage,
    reportedLocations: latest?.kineticLocations ?? 0,
    totalLocations: latest?.totalLocations ?? 0,
    // NO baseline vintage means NO diff, so nothing can be called an addition.
    // Subtracting from an absent baseline would report a block's entire
    // established footprint as newly built the moment a single vintage is
    // imported - manufacturing candidates out of a first-time load.
    addedLocations: baselineVintage == null
      ? 0
      : Math.max(0, (latest?.kineticLocations ?? 0) - (baseline?.kineticLocations ?? 0)),
    locationIds: latest ? safeIds(latest.locationIds) : [],
    maxDownMbps: latest?.maxDown ?? null,
  };
}

function safeIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

/** Blocks where Kinetic added coverage between the two newest vintages - the
 *  leading edge the candidate harvester walks. Bounded by `limit` so a caller
 *  can never pull the whole state into memory. */
export function additionBlocks(
  tenantId: number,
  opts: { countyFips?: readonly string[]; limit?: number } = {},
): Array<{ blockGeoid: string; countyFips: string; added: number; reported: number; total: number }> {
  const vintages = importedVintages(tenantId);
  if (vintages.length < 2) return [];
  const latest = vintages[vintages.length - 1];
  const baseline = vintages[vintages.length - 2];
  const counties = opts.countyFips?.length ? [...opts.countyFips] : [];
  const countyPred = counties.length ? ` AND l.county_fips IN (${counties.map(() => "?").join(",")})` : "";
  return rawDb.prepare(`
    SELECT l.block_geoid AS blockGeoid, l.county_fips AS countyFips,
           l.kinetic_locations - COALESCE(b.kinetic_locations, 0) AS added,
           l.kinetic_locations AS reported,
           l.total_residential_locations AS total
      FROM fcc_block_footprint l
      LEFT JOIN fcc_block_footprint b
        ON b.tenant_id = l.tenant_id AND b.block_geoid = l.block_geoid AND b.vintage = ?
     WHERE l.tenant_id = ? AND l.vintage = ?${countyPred}
       AND l.kinetic_locations > COALESCE(b.kinetic_locations, 0)
     ORDER BY added DESC
     LIMIT ?
  `).all(baseline, tenantId, latest, ...counties, Math.max(1, Math.min(50_000, opts.limit ?? 5_000))) as any[];
}

/** As-of date of the newest imported vintage, for operator-facing copy. */
export function latestVintageAsOf(tenantId: number): { vintage: FccVintageCode; asOfMs: number } | null {
  const vintages = importedVintages(tenantId);
  if (!vintages.length) return null;
  const vintage = vintages[vintages.length - 1];
  return { vintage, asOfMs: vintageAsOfMs(vintage) };
}
