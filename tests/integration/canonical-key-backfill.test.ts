import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The canonical_key backfill lane and the gate it unblocks.
//
// Rows written before upsertScanTargets stamped canonical_key carry NULL, and a
// NULL key is invisible to BOTH duplicate detectors in scanTargetCanonicalMerge:
// the group-by filters `canonical_key IS NOT NULL`, and the alias-twin predicate
// compares `b.canonical_key <> a.canonical_key`, which is NULL (never true) when
// either side is un-keyed. Measured on the local database 2026-08-27: the
// manifest reported 240 duplicate groups on a table holding 26,371, because
// 292,999 of 924,104 rows had no key.
//
// promoteCanonicalUnique() is gated on that duplicate count reaching zero, so an
// all-clear read off the blind detector would have made the index UNIQUE with
// thousands of collisions still latent — and the next write to stamp any of
// those keys would have failed mid-harvest. These tests pin both halves: the
// lane drains the backlog, and the gate refuses while anything is un-keyed.

let rawDb: import("better-sqlite3").Database;
let yieldRollups: typeof import("../../server/yieldRollups");
let merge: typeof import("../../server/scanTargetCanonicalMerge");
const TENANT = 1;

function legacyRow(address: string, city: string, opts: { lat?: number; lng?: number; scanned?: boolean } = {}): number {
  return Number(rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, street_key,
       canonical_key, last_scanned_at, created_at)
     VALUES (?, ?, 'NC', '28138', ?, ?, ?, 'harvest-overpass', ?, NULL, ?, datetime('now'))`,
  ).run(address, city, opts.lat ?? null, opts.lng ?? null, TENANT,
    address.replace(/^\d+\s+/, "").toUpperCase(),
    opts.scanned ? new Date().toISOString() : null).lastInsertRowid);
}

const nullKeyCount = () =>
  (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE canonical_key IS NULL`).get() as { n: number }).n;
const keyOf = (id: number) =>
  (rawDb.prepare(`SELECT canonical_key k FROM scan_targets WHERE id=?`).get(id) as { k: string | null }).k;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-canon-backfill-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  yieldRollups = await import("../../server/yieldRollups");
  merge = await import("../../server/scanTargetCanonicalMerge");
});

describe("canonical_key backfill lane", () => {
  it("drains legacy NULL keys in resumable chunks and is idempotent", () => {
    // The three spellings of one Rockwell house that became three rows.
    legacyRow("1131 Bird Dog Tr", "Rockwell");
    legacyRow("1131 Bird Dog Trl", "Rockwell");
    legacyRow("1131 Bird Dog Trail", "Rockwell");
    for (let i = 0; i < 20; i++) legacyRow(`${100 + i} Filler St`, "Rockwell");
    expect(nullKeyCount()).toBe(23);

    // Chunked: a small chunk leaves work behind and reports "not done".
    expect(yieldRollups.canonicalKeyBackfillChunk(5)).toBe(false);
    expect(nullKeyCount()).toBe(18);

    // Resuming from the persisted cursor finishes the job.
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = yieldRollups.canonicalKeyBackfillChunk(5);
    expect(done).toBe(true);
    expect(nullKeyCount()).toBe(0);

    // All three spellings now share one identity — which is what makes the
    // twin guard in upsertScanTargets able to see them as one door.
    const keys = rawDb.prepare(
      `SELECT DISTINCT canonical_key k FROM scan_targets WHERE address LIKE '1131 Bird Dog%'`,
    ).all() as Array<{ k: string }>;
    expect(keys).toHaveLength(1);
    expect(keys[0].k).toBe("1131 BIRD DOG TRL|ROCKWELL|NC");

    // Idempotent: a second pass is a no-op, not a rewrite.
    expect(yieldRollups.canonicalKeyBackfillChunk()).toBe(true);
    expect(nullKeyCount()).toBe(0);
  });

  it("skips an address with no street part instead of stamping a city-wide key", () => {
    // "Apt 5" canonicalizes to "UNIT 5" with no street. Stamping it would key
    // it as "UNIT 5|ROCKWELL|NC" and make every such row in the city a twin of
    // the others, merging genuinely distinct addresses.
    rawDb.prepare(`UPDATE yield_rollup_state SET v='0' WHERE k='canonkey_done'`).run();
    rawDb.prepare(`UPDATE yield_rollup_state SET v='0' WHERE k='canonkey_cursor'`).run();
    const blank = Number(rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, tenant_id, source, canonical_key, created_at)
       VALUES ('', 'Rockwell', 'NC', '28138', ?, 'gis', NULL, datetime('now'))`,
    ).run(TENANT).lastInsertRowid);
    const real = legacyRow("77 Real Rd", "Rockwell");

    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = yieldRollups.canonicalKeyBackfillChunk(5);

    expect(done).toBe(true);                       // the skipped row cannot trap the loop
    expect(keyOf(blank)).toBeNull();               // still un-keyed, deliberately
    expect(keyOf(real)).toBe("77 REAL RD|ROCKWELL|NC");
  });
});

describe("promoteCanonicalUnique fails closed on un-keyed rows", () => {
  it("reports what the manifest cannot see", () => {
    const m = merge.dryRunManifest();
    expect(m).toHaveProperty("unkeyedRows");
    expect(m.unkeyedRows).toBe(1); // the street-less row from the test above
  });

  const isUnique = () =>
    (rawDb.prepare(`SELECT "unique" u FROM pragma_index_list('scan_targets') WHERE name='idx_scan_targets_canonical'`)
      .get() as { u: number } | undefined)?.u;

  it("refuses on un-keyed rows first, then on the duplicates the backfill revealed", () => {
    // Backfilling the three Bird Dog spellings MADE a duplicate group visible —
    // that is the point of the lane, and it is why the promotion must wait.
    expect(merge.dryRunManifest().sameCanonicalGroups).toBe(1);

    // Gate 1: an un-keyed row means the duplicate count is a lower bound, not a
    // measurement. Refuse before even considering the group count.
    const blockedByNulls = merge.promoteCanonicalUnique();
    expect(blockedByNulls.promoted).toBe(false);
    expect(blockedByNulls.reason).toMatch(/no canonical_key/);
    expect(isUnique()).toBe(0);

    // Gate 2: with every row keyed the count is trustworthy — and it is not zero.
    rawDb.prepare(`DELETE FROM scan_targets WHERE canonical_key IS NULL`).run();
    const blockedByDupes = merge.promoteCanonicalUnique();
    expect(blockedByDupes.promoted).toBe(false);
    expect(blockedByDupes.reason).toMatch(/duplicate group/);
    expect(isUnique()).toBe(0);

    // Collapsing the revealed group is the separate, destructive decision this
    // lane deliberately does NOT make on its own. Done by hand here, the gate
    // opens.
    rawDb.prepare(
      `DELETE FROM scan_targets WHERE address LIKE '1131 Bird Dog%'
         AND id > (SELECT MIN(id) FROM scan_targets WHERE address LIKE '1131 Bird Dog%')`,
    ).run();
    expect(merge.promoteCanonicalUnique().promoted).toBe(true);
    expect(isUnique()).toBe(1);

    // And the duplicate spellings can no longer regrow.
    expect(() => rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, tenant_id, source, canonical_key, created_at)
       VALUES ('1131 Bird Dog Trail', 'Rockwell', 'NC', '28138', ?, 'gis', '1131 BIRD DOG TRL|ROCKWELL|NC', datetime('now'))`,
    ).run(TENANT)).toThrow(/UNIQUE/);
  });
});
