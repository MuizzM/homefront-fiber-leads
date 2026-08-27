import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The invariant that keeps the CANONICAL-TWIN guard usable.
//
// storage.upsertScanTargets stops the same house being inserted twice under a
// different spelling with
//     SELECT id FROM scan_targets WHERE tenant_id IS ? AND canonical_key = ?
// That lookup cannot fire on a row whose canonical_key is NULL. A third of the
// production table (295,144 of 921,912 rows, all created on or before
// 2026-07-18) carries NULL because the key was not always stamped at insert
// time, and the measured cost is duplicate doors: "1131 Bird Dog Tr" / "Trl" /
// "Trail" as three rows for one house, and "115 Mason Hill Dr" (scanned
// 2026-07-10) plus "115 Mason Hill Drive" (scanned 2026-08-26) as one door
// bought twice.
//
// These tests pin the insert path so the backlog cannot grow again: every row
// upsertScanTargets creates carries a key, and a re-spelled twin enriches the
// existing row instead of minting a second one. The last test documents the
// exact failure the legacy NULLs cause, so a regression that reintroduces them
// fails here with an explanation rather than silently doubling the pool.

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage");
const TENANT = 1;

const rowsFor = (like: string) => rawDb.prepare(
  `SELECT id, address, city, canonical_key AS canonicalKey, last_scanned_at AS scannedAt, df_address_id AS dfId
     FROM scan_targets WHERE address LIKE ? ORDER BY id`,
).all(like) as Array<{ id: number; address: string; city: string; canonicalKey: string | null; scannedAt: string | null; dfId: string | null }>;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-canon-stamp-"));
  ({ rawDb } = await import("../../server/db"));
  storage = await import("../../server/storage");
  storage.runMigrations();
});

describe("upsertScanTargets stamps canonical_key", () => {
  it("stamps a key on every inserted row, without the caller supplying one", () => {
    const added = storage.storage.upsertScanTargets([
      { address: "1131 Bird Dog Tr", city: "Rockwell", state: "NC", zip: "28138", tenantId: TENANT, source: "gis" },
      { address: "115 Mason Hill Dr", city: "Rockwell", state: "NC", zip: "28138", tenantId: TENANT, source: "leads-backfill" },
    ]);
    expect(added).toBe(2);
    const stamped = rawDb.prepare(
      `SELECT COUNT(*) AS n FROM scan_targets WHERE tenant_id = ? AND canonical_key IS NULL`,
    ).get(TENANT) as { n: number };
    expect(stamped.n).toBe(0);
    expect(rowsFor("1131 Bird Dog%")[0].canonicalKey).toBe("1131 BIRD DOG TRL|ROCKWELL|NC");
  });

  it("folds a re-spelled twin onto the existing row instead of inserting", () => {
    // The three spellings that produced three production rows for one house.
    const added = storage.storage.upsertScanTargets([
      { address: "1131 Bird Dog Trl", city: "Rockwell", state: "NC", zip: "28138", tenantId: TENANT, source: "live-route-area-scan" },
      { address: "1131 Bird Dog Trail", city: "Rockwell", state: "NC", zip: "28138", tenantId: TENANT, source: "unified:gis+mapbox" },
    ]);
    expect(added).toBe(0);
    expect(rowsFor("1131 Bird Dog%")).toHaveLength(1);
  });

  it("carries a probe result onto the twin rather than minting a second door", () => {
    // "115 Mason Hill Drive" is the mapbox-grid spelling of a door already
    // pooled as "115 Mason Hill Dr". Without the key it became a second row and
    // Kinetic was paid twice; with it the result lands on the original.
    storage.storage.upsertScanTargets([{
      address: "115 Mason Hill Drive", city: "Rockwell", state: "NC", zip: "28138",
      tenantId: TENANT, source: "mapbox-grid", dfAddressId: "DF-MASON-115",
      scannedNow: true, fiberStatus: "new_fiber", isNewFiber: true, billingStatus: "none",
    }]);
    const rows = rowsFor("115 Mason Hill%");
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("115 Mason Hill Dr");   // original spelling kept
    expect(rows[0].dfId).toBe("DF-MASON-115");           // probe identity enriched on
    expect(rows[0].scannedAt).not.toBeNull();            // baseline recorded, no re-probe owed
  });

  it("a NULL canonical_key makes the twin guard blind — the defect the backfill repairs", async () => {
    // Legacy shape: a row inserted before the stamp existed. Reproduced by
    // clearing the key, which is exactly what 295,144 production rows look like.
    rawDb.prepare(`UPDATE scan_targets SET canonical_key = NULL WHERE address = '115 Mason Hill Dr'`).run();

    storage.storage.upsertScanTargets([{
      address: "115 Mason Hill Drive", city: "Rockwell", state: "NC", zip: "28138",
      tenantId: TENANT, source: "mapbox-grid",
    }]);
    // The guard could not fire: the same door is now two rows.
    expect(rowsFor("115 Mason Hill%")).toHaveLength(2);

    // Backfilling the key is what makes the guard work again.
    const { canonicalAddressPart, normalizeKineticAddressKey } = await import("../../shared/addressKey");
    for (const r of rowsFor("115 Mason Hill%")) {
      if (r.canonicalKey || !canonicalAddressPart(r.address)) continue;
      rawDb.prepare(`UPDATE scan_targets SET canonical_key = ? WHERE id = ?`)
        .run(normalizeKineticAddressKey(r.address, r.city, "NC", "28138"), r.id);
    }
    const keys = rowsFor("115 Mason Hill%").map((r) => r.canonicalKey);
    expect(new Set(keys).size).toBe(1);          // both rows now share one identity
    expect(keys.every(Boolean)).toBe(true);

    // Which is precisely why the backfill only REPORTS these groups: collapsing
    // them is a row deletion, and scan_targets(tenant_id, canonical_key) is a
    // NON-unique index, so nothing in the schema forces the choice here.
    storage.storage.upsertScanTargets([{
      address: "115 Mason Hill Dr.", city: "Rockwell", state: "NC", zip: "28138",
      tenantId: TENANT, source: "overpass",
    }]);
    expect(rowsFor("115 Mason Hill%")).toHaveLength(2); // no third spelling added
  });
});
