import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slice 1: postal-city alias twin merge — survivor order, FK repoint, invariant
// checks, idempotency; neighbors/units never pair.

let rawDb: import("better-sqlite3").Database;
let merge: typeof import("../../server/scanTargetCanonicalMerge");
const TENANT = 1;

function target(address: string, city: string, opts: { lat: number; lng: number; scanned?: boolean; lead?: number | null }): number {
  const id = Number(rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, street_key, canonical_key,
       last_fiber_status, last_scanned_at, scan_count, converted_to_lead_id, created_at)
     VALUES (?, ?, 'NC', '', ?, ?, ?, 'osm', ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(address, city, opts.lat, opts.lng, TENANT,
    "STONEWYCK DR", `${address}|${city}|NC`.toUpperCase(),
    opts.scanned ? "new_fiber" : null, opts.scanned ? new Date().toISOString() : null,
    opts.scanned ? 3 : 0, opts.lead ?? null).lastInsertRowid);
  return id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-canon-merge-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  merge = await import("../../server/scanTargetCanonicalMerge");
});

describe("city-alias twin merge", () => {
  it("merges the twin into the conclusive survivor, repoints FKs, idempotent", () => {
    const survivor = target("1315 Stonewyck Dr", "Salisbury", { lat: 35.6056, lng: -80.4351, scanned: true });
    const loser = target("1315 Stonewyck Drive", "Lexington", { lat: 35.60561, lng: -80.43511, scanned: false });
    rawDb.prepare(`INSERT INTO availability_snapshots (tenant_id, scan_target_id, run_id, checked_at, checked_at_epoch,
        conclusive, fiber_available, fiber_status, transition_status, fresh, api_source, evidence_hash)
      VALUES (?, ?, 'r-x', datetime('now'), ?, 1, 0, 'no_service', 'baseline_unavailable', 0, 'test', 'h-x')`)
      .run(TENANT, loser, Date.now());
    const dry = merge.dryRunManifest();
    expect(dry.cityAliasPairs).toBe(1);
    const res = merge.mergeCityAliasTwins({ apply: true });
    expect(res.halted).toBeNull();
    expect(res.merged).toBe(1);
    expect(res.fksRepointed).toBeGreaterThanOrEqual(1);
    // Loser gone; snapshot repointed to the survivor.
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE id=?`).get(loser)).toMatchObject({ n: 0 });
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM availability_snapshots WHERE scan_target_id=?`).get(survivor)).toMatchObject({ n: 1 });
    // Idempotent — nothing left to merge.
    expect(merge.mergeCityAliasTwins({ apply: true }).merged).toBe(0);
  });

  it("neighbors and units never pair", () => {
    target("1317 Stonewyck Dr", "Salisbury", { lat: 35.60562, lng: -80.43508 });
    target("1319 Stonewyck Dr", "Lexington", { lat: 35.60563, lng: -80.43507 });
    const before = merge.dryRunManifest();
    expect(before.cityAliasPairs).toBe(0); // different house numbers — no pair
  });

  it("promotes the canonical UNIQUE index only at zero duplicate groups", () => {
    const r = merge.promoteCanonicalUnique();
    expect(r.promoted).toBe(true);
    // Regrowth now impossible: same tenant+canonical insert violates UNIQUE.
    expect(() => rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, tenant_id, source, canonical_key, created_at)
       VALUES ('1315 Stonewyck Dr', 'Salisbury', 'NC', '', ?, 'osm', '1315 STONEWYCK DR|SALISBURY|NC', datetime('now'))`,
    ).run(TENANT)).toThrow(/UNIQUE/);
  });
});
