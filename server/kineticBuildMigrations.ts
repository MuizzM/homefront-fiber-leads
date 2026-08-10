// ── Kinetic 2026 builds - schema ─────────────────────────────────────────────
//
// Five tables, in two groups.
//
// IMPORT (fcc_import_jobs / _chunks / _staging)
//   Mirrors the DNC import rails already in server/calling/migrations.ts, for
//   the same reasons: an import that cannot be resumed, cannot be verified and
//   cannot be undone is one that nobody dares run against production.
//     streamed    rows arrive in bounded chunks, never one big payload
//     staged      nothing touches the durable footprint until finalize
//     idempotent  a replayed chunk is recognised by its sha256 and ignored
//     reversible  discard drops the staging rows; a finalized vintage is
//                 removed by deleting its fcc_block_footprint rows, which the
//                 projector then re-derives from whatever remains
//
//   The acquisition step deliberately lives OUTSIDE the server: every
//   broadbandmap.fcc.gov endpoint returns 403 to a server-side client (Akamai),
//   verified again on 2026-08-10. So there is no background fetcher to write.
//   An operator pulls the file, and it enters here through a chunked API.
//
// CLASSIFICATION (fcc_block_footprint / kinetic_build_state)
//   fcc_block_footprint is the durable per-vintage census-block rollup - the
//   only durable product of an import. Row counts are in the thousands of
//   blocks, not the millions of locations, so vintage comparison is a join
//   over a small table rather than a scan of raw filings.
//
//   kinetic_build_state is one row per address per tenant, carrying the
//   verdict and every field the brief requires preserved: source, FCC location
//   ids, first observed, first confirmed, last verified, speeds, build year,
//   quarter when proven, confidence. It holds its own lat/lng so the map's
//   bbox window never has to reach into leads, and an optional lead_id for the
//   confirmed doors that were promoted.
//
// WHY NOT COLUMNS ON `leads`
//   Most classified addresses must never become leads (likely, planned,
//   unverified, suppressed). Hanging this off leads would either mint pins for
//   candidates - the exact mistake the brief forbids - or leave the columns
//   null on most rows. A separate table keeps "we know something about this
//   address" and "a rep should knock this door" as different statements.

import { rawDb } from "./db";
import { KINETIC_BUILD_CLASSES } from "@shared/kineticBuild2026";

/** CHECK constraint body listing every legal classification. Generated from
 *  the shared union so the database and the classifier cannot drift. */
const CLASS_CHECK = KINETIC_BUILD_CLASSES.map((c) => `'${c}'`).join(",");

export function runKineticBuildMigrations(): void {
  rawDb.exec("BEGIN IMMEDIATE");
  try {
    rawDb.exec(`
      -- ── Import job: one per (tenant, vintage, provider scope) ─────────────
      CREATE TABLE IF NOT EXISTS fcc_import_jobs (
        id TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL,
        -- Filing code as published: D25, J26. shared/fccVintage.ts parses it.
        vintage TEXT NOT NULL,
        -- The filing's own as-of date, denormalised so a query never has to
        -- re-derive it, and so a mislabelled import is visible in the row.
        source_as_of TEXT NOT NULL,
        state_fips TEXT NOT NULL DEFAULT '37',
        -- JSON array of FCC provider_ids this job covers (the Windstream
        -- entities). Recorded because provider ids change between vintages.
        provider_ids_json TEXT NOT NULL DEFAULT '[]',
        -- JSON array of county FIPS the job is scoped to. A job may never
        -- write a block outside its declared scope - checked at finalize.
        county_fips_json TEXT NOT NULL DEFAULT '[]',
        -- sha256 of the operator's manifest: what file, from where, when.
        source_manifest_sha256 TEXT NOT NULL,
        source_url TEXT,
        expected_chunk_count INTEGER NOT NULL CHECK(expected_chunk_count > 0),
        expected_row_count INTEGER NOT NULL CHECK(expected_row_count >= 0),
        received_row_count INTEGER NOT NULL DEFAULT 0,
        rejected_row_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open'
          CHECK(status IN ('open','finalized','discarded','failed')),
        error_code TEXT,
        created_by INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        finalized_at TEXT
      );
      -- One OPEN job per vintage scope at a time: two concurrent operators
      -- streaming the same vintage would interleave into one staging set.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_fcc_import_open
        ON fcc_import_jobs(tenant_id, vintage, state_fips) WHERE status='open';
      CREATE INDEX IF NOT EXISTS idx_fcc_import_status
        ON fcc_import_jobs(tenant_id, status, created_at DESC);

      -- ── Chunk receipts: the idempotency ledger ────────────────────────────
      -- A retried chunk (dropped connection, operator refresh) presents the
      -- same sha256 and is acknowledged without being applied twice.
      CREATE TABLE IF NOT EXISTS fcc_import_chunks (
        import_id TEXT NOT NULL REFERENCES fcc_import_jobs(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        chunk_sha256 TEXT NOT NULL,
        input_count INTEGER NOT NULL,
        accepted_count INTEGER NOT NULL,
        rejected_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(import_id, chunk_index)
      );

      -- ── Staging: raw availability rows, dropped at finalize ───────────────
      -- PRIMARY KEY collapses a duplicated location within one job, which the
      -- BDC files legitimately contain (one row per provider per technology).
      CREATE TABLE IF NOT EXISTS fcc_import_staging (
        import_id TEXT NOT NULL REFERENCES fcc_import_jobs(id) ON DELETE CASCADE,
        location_id TEXT NOT NULL,
        block_geoid TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        technology INTEGER NOT NULL,
        -- BDC business_residential_code: R residential, B business, X both.
        br_code TEXT NOT NULL,
        max_down_mbps INTEGER,
        max_up_mbps INTEGER,
        PRIMARY KEY(import_id, location_id, provider_id, technology)
      );
      CREATE INDEX IF NOT EXISTS idx_fcc_staging_block
        ON fcc_import_staging(import_id, block_geoid);

      -- ── Durable footprint: one row per (vintage, block) ───────────────────
      -- The whole point of the import. kinetic_locations is what Kinetic
      -- reported; total_residential_locations is the denominator used to tell
      -- a fully-built block from a half-built one.
      CREATE TABLE IF NOT EXISTS fcc_block_footprint (
        tenant_id INTEGER NOT NULL,
        vintage TEXT NOT NULL,
        block_geoid TEXT NOT NULL,
        county_fips TEXT NOT NULL,
        state_fips TEXT NOT NULL DEFAULT '37',
        kinetic_locations INTEGER NOT NULL DEFAULT 0,
        total_residential_locations INTEGER NOT NULL DEFAULT 0,
        max_down_mbps INTEGER,
        max_up_mbps INTEGER,
        -- JSON array of FCC fabric location ids Kinetic reported here. Kept
        -- for provenance and audit. Binding one to a street address needs the
        -- licensed fabric, which we do not hold - so these are never treated
        -- as addresses, only as evidence that N premises exist in this block.
        location_ids_json TEXT NOT NULL DEFAULT '[]',
        source_as_of TEXT NOT NULL,
        import_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(tenant_id, vintage, block_geoid)
      );
      CREATE INDEX IF NOT EXISTS idx_fcc_block_county
        ON fcc_block_footprint(tenant_id, county_fips, vintage);
      CREATE INDEX IF NOT EXISTS idx_fcc_block_import
        ON fcc_block_footprint(import_id);

      -- ── Per-address verdict ──────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS kinetic_build_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        -- Same normalisation as leads.canonical_key (shared/addressKey.ts), so
        -- an address has ONE identity across leads, scan targets and this
        -- table, and units stay distinct records.
        canonical_key TEXT NOT NULL,
        address TEXT NOT NULL,
        unit TEXT,
        city TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'NC',
        zip TEXT,
        county_fips TEXT,
        block_geoid TEXT,
        lat REAL,
        lng REAL,

        classification TEXT NOT NULL DEFAULT 'unverified' CHECK(classification IN (${CLASS_CHECK})),
        confidence TEXT NOT NULL DEFAULT 'none' CHECK(confidence IN ('high','medium','low','none')),
        -- Null is a real, meaningful value on both of these: "not established".
        -- Never defaulted, never inferred. See shared/fccVintage.ts.
        build_year INTEGER,
        quarter_when_proven TEXT,
        detection_from TEXT,
        detection_to TEXT,

        -- Evidence timeline the brief requires preserved.
        first_observed_at TEXT,
        -- When this address FIRST classified as a confirmed 2026 build.
        first_confirmed_at TEXT,
        last_verified_at TEXT,
        last_verification_outcome TEXT,
        -- The two dated bounds that turn a serviceable reading into a proven
        -- transition. Maintained incrementally so classification never has to
        -- re-scan the evidence ledger, and monotonic by construction: the
        -- earliest fiber-live and the latest non-fiber only ever move outward.
        first_fiber_live_at TEXT,
        last_non_fiber_at TEXT,
        -- JSON array of provenance labels, most authoritative first.
        sources_json TEXT NOT NULL DEFAULT '[]',
        fcc_location_ids_json TEXT NOT NULL DEFAULT '[]',
        fcc_first_reported_vintage TEXT,
        max_down_mbps INTEGER,
        max_up_mbps INTEGER,

        -- Set when the door was promoted to a workable lead. Null for every
        -- candidate class, which is most of this table.
        lead_id INTEGER,
        suppression_reason TEXT,
        residential INTEGER NOT NULL DEFAULT 1,
        -- Monotonic guard: a late projector pass cannot overwrite a newer one.
        state_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- One address, one verdict. The same invariant leads enforces.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kbs_canonical
        ON kinetic_build_state(tenant_id, canonical_key);
      -- The map's bbox window: tenant scope then a lat/lng range scan, the
      -- same shape as idx_leads_lat_lng which the pin path already relies on.
      CREATE INDEX IF NOT EXISTS idx_kbs_bbox
        ON kinetic_build_state(tenant_id, lat, lng);
      -- Classification-first for the layer's default lens, so the common
      -- "confirmed builds in this viewport" query never scans candidates.
      CREATE INDEX IF NOT EXISTS idx_kbs_class_bbox
        ON kinetic_build_state(tenant_id, classification, lat, lng);
      CREATE INDEX IF NOT EXISTS idx_kbs_geo
        ON kinetic_build_state(tenant_id, county_fips, city, zip);
      CREATE INDEX IF NOT EXISTS idx_kbs_lead
        ON kinetic_build_state(lead_id) WHERE lead_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_kbs_block
        ON kinetic_build_state(tenant_id, block_geoid);

      -- ── Append-only evidence history ─────────────────────────────────────
      -- Never updated, never deleted by the projector. A classification can
      -- change; the reasons it ever held cannot. evidence_key makes a replayed
      -- observation a no-op rather than a duplicate history entry.
      CREATE TABLE IF NOT EXISTS kinetic_build_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        build_state_id INTEGER NOT NULL REFERENCES kinetic_build_state(id) ON DELETE CASCADE,
        evidence_key TEXT NOT NULL,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        conclusive INTEGER NOT NULL DEFAULT 0,
        -- The classification this evidence produced, for a readable timeline.
        resulting_classification TEXT,
        resulting_confidence TEXT,
        detail_json TEXT,
        -- Pointer to the underlying row (fiber_checks id, target_observations
        -- id, import id) rather than a copy of the payload.
        reference TEXT,
        recorded_by INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_kbe_key
        ON kinetic_build_evidence(tenant_id, evidence_key);
      CREATE INDEX IF NOT EXISTS idx_kbe_state
        ON kinetic_build_evidence(build_state_id, observed_at DESC);
    `);

    // Defensive ADD COLUMNs, house style: a table created by an earlier build
    // of this feature keeps its rows and gains the new columns rather than
    // needing a drop. Each is guarded by the column list, so re-running is
    // free and a missing table (creation failed above) cannot mask an error.
    const columns = new Set(
      (rawDb.prepare(`PRAGMA table_info('kinetic_build_state')`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (columns.size) {
      if (!columns.has("first_fiber_live_at")) rawDb.exec(`ALTER TABLE kinetic_build_state ADD COLUMN first_fiber_live_at TEXT`);
      if (!columns.has("last_non_fiber_at")) rawDb.exec(`ALTER TABLE kinetic_build_state ADD COLUMN last_non_fiber_at TEXT`);
    }

    rawDb.exec("COMMIT");
  } catch (error) {
    try { rawDb.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}
