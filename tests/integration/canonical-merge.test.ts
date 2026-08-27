import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Slice 1: postal-city alias twin merge — survivor order, FK repoint, invariant
// checks, idempotency; neighbors/units never pair.

let rawDb: import("better-sqlite3").Database;
let merge: typeof import("../../server/scanTargetCanonicalMerge");
let streetKeyOf: typeof import("../../shared/addressKey").streetKeyOf;
const TENANT = 1;

// street_key comes from the real streetKeyOf, not a literal: the whole defect
// class this module got wrong lives in what that function does and does not
// keep, and a hand-written key hides it.
function target(address: string, city: string, opts: { lat: number; lng: number; scanned?: boolean; lead?: number | null; tenantId?: number }): number {
  const id = Number(rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, street_key, canonical_key,
       last_fiber_status, last_scanned_at, scan_count, converted_to_lead_id, created_at)
     VALUES (?, ?, 'NC', '', ?, ?, ?, 'osm', ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(address, city, opts.lat, opts.lng, opts.tenantId ?? TENANT,
    streetKeyOf(address), `${address}|${city}|NC`.toUpperCase(),
    opts.scanned ? "new_fiber" : null, opts.scanned ? new Date().toISOString() : null,
    opts.scanned ? 3 : 0, opts.lead ?? null).lastInsertRowid);
  return id;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-canon-merge-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  ({ streetKeyOf } = await import("../../shared/addressKey"));
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

  it("neighbors never pair", () => {
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

// This module DELETES the loser row. Its predicate used to be street_key +
// state + CAST(address AS INTEGER) + a ~25m box, and called that "the same
// premise". It is not: streetKeyOf cuts the unit clause off, and CAST reads
// "313", "313A" and "313-B" as the same house. Measured on the live dev
// database 2026-08-27: 6,696 queued pairs, 943 of them different doors,
// 655 distinct real rows facing deletion.
//
// Each case asserts cityAliasPairs, not just `merged`. The pairs have to leave
// the MANIFEST: server/yieldRollups.ts only stops calling this (and only sets
// alias_merge_done) when pairsFound hits 0, so a pair refused in JS after the
// LIMIT would leave the janitor re-running a ~1M-row self-join every 30s.
describe("a twin must be the same DOOR", () => {
  it("distinct units of one building never pair", () => {
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0); // clean baseline
    const at = { lat: 35.6700, lng: -80.5200 };
    target("2715 Statesville Blvd Unit 101", "Salisbury", at);
    target("2715 Statesville Blvd Unit 102", "Salisbury", at);
    target("2715 Statesville Blvd Unit 240", "Salisbury", { lat: 35.67015, lng: -80.52015 });
    target("2715 Statesville Blvd", "Salisbury", at); // the building is not a unit
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0);
    expect(merge.mergeCityAliasTwins({ apply: true }).merged).toBe(0);
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '2715 Statesville%'`)
      .get()).toMatchObject({ n: 4 });
  });

  it("a LOT is a unit - the mobile-home-park pair that was live in the manifest", () => {
    const at = { lat: 35.0001, lng: -82.0001 };
    target("77 Lake Vista Dr", "Lyman", at);
    target("77 LAKE VISTA DR LOT 16", "Lyman", at);
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0);
    expect(merge.mergeCityAliasTwins({ apply: true }).merged).toBe(0);
  });

  it("letter-suffixed house numbers are different doors", () => {
    // CAST('313-B Charlotte Avenue' AS INTEGER) is 313, and streetKeyOf drops
    // the orphan letter onto neither side — so both rows read as "313 CHARLOTTE
    // AVE" to the old predicate. Two duplexes, one row.
    const at = { lat: 35.4800, lng: -79.1800 };
    target("313-A Charlotte Avenue", "Sanford", at);
    target("313-B Charlotte Avenue", "Sanford", at);
    target("511 South White Street", "Marshville", { lat: 34.9900, lng: -80.3700 });
    target("511a South White Street", "Marshville", { lat: 34.99001, lng: -80.37001 });
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0);
    expect(merge.mergeCityAliasTwins({ apply: true }).merged).toBe(0);
  });

  it("a secondary number is part of the house, not noise", () => {
    const at = { lat: 34.9500, lng: -82.1000 };
    target("314 318 MALCOLM WAY", "Wellford", at);
    target("314 322 MALCOLM WAY", "Wellford", at);
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0);
    expect(merge.mergeCityAliasTwins({ apply: true }).merged).toBe(0);
  });

  it("two TENANTS holding one premise never pair - the merge deletes across the boundary", () => {
    // No tenant term at all until 2026-08-27: tenant 2's row would have been
    // deleted and its leads/snapshots repointed at tenant 1's row.
    const at = { lat: 36.1000, lng: -80.2500 };
    target("900 Shared Premise Rd", "Salisbury", at);
    target("900 Shared Premise Road", "Lexington", { ...at, tenantId: 2 });
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0);
    expect(merge.mergeCityAliasTwins({ apply: true }).merged).toBe(0);
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE address LIKE '900 Shared Premise%'`)
      .get()).toMatchObject({ n: 2 });
  });

  it("the SAME door under two postal cities still merges, unit clause and all", () => {
    // The narrowing must not cost the module its actual job.
    const survivor = target("48 Bella Dr Apt 3", "Salisbury", { lat: 35.7000, lng: -80.4000, scanned: true });
    const loser = target("48 Bella Drive Unit 3", "Lexington", { lat: 35.70001, lng: -80.40001 });
    expect(merge.dryRunManifest().cityAliasPairs).toBe(1);
    const res = merge.mergeCityAliasTwins({ apply: true });
    expect(res.halted).toBeNull();
    expect(res.merged).toBe(1);
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE id=?`).get(loser)).toMatchObject({ n: 0 });
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE id=?`).get(survivor)).toMatchObject({ n: 1 });
    // Drained: the janitor can now finish instead of looping.
    expect(merge.dryRunManifest().cityAliasPairs).toBe(0);
  });
});
