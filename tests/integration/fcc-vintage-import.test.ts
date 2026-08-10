// FCC BDC vintage import: streamed, staged, idempotent, reversible.
//
// The failure this whole pipeline is built against: a partially-received
// baseline. If the D25 import lands 9 of its 10 chunks and finalizes anyway,
// the missing blocks read downstream as "Kinetic served nothing here", and
// every address in them becomes a false 2026 build with FCC evidence attached.
// finalizeImport refuses, and there is a test for it below.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let store: typeof import("../../server/fccImportStore");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
/** A Rowan County block (37159) and a Cabarrus one (37025). */
const ROWAN_A = "371590501001000";
const ROWAN_B = "371590501001001";
const CABARRUS_A = "370250401002000";
/** Wake County - outside the seven authorized counties. */
const WAKE = "371830501001000";

const WIN = "130623";

function row(over: Partial<import("../../server/fccImportStore").FccAvailabilityRow> = {}) {
  return {
    locationId: `loc-${Math.random().toString(36).slice(2, 10)}`,
    blockGeoid: ROWAN_A,
    providerId: WIN,
    technology: 50,
    brCode: "R",
    maxDownMbps: 1000,
    maxUpMbps: 1000,
    ...over,
  };
}

function importVintage(vintage: string, rows: ReturnType<typeof row>[], opts: { finalize?: boolean } = {}) {
  const job = store.openImport({
    tenantId: TENANT, vintage, providerIds: [WIN],
    manifest: `test-${vintage}-${rows.length}`, expectedChunkCount: 1, expectedRowCount: rows.length,
  });
  store.ingestChunk(job.id, 0, rows);
  if (opts.finalize !== false) store.finalizeImport(job.id);
  return job;
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fccimport-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/fccImportStore");
});

describe("scope enforcement at ingest", () => {
  it("rejects non-fiber technologies, business-only, foreign providers and out-of-scope counties", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN],
      manifest: "scope", expectedChunkCount: 1, expectedRowCount: 6,
    });
    const result = store.ingestChunk(job.id, 0, [
      row(),                                    // kept
      row({ technology: 10 }),                  // copper
      row({ brCode: "B" }),                     // business only
      row({ providerId: "999999" }),            // a different carrier
      row({ blockGeoid: WAKE }),                // outside the seven counties
      row({ blockGeoid: "nonsense" }),          // malformed
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(5);
    expect(result.rejectionReasons).toMatchObject({
      not_fttp: 1, not_residential: 1, other_provider: 1, out_of_scope_county: 1, bad_block_geoid: 1,
    });
    store.discardImport(job.id, "scope test");
  });

  it("accepts X (business and residential) as residential", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN],
      manifest: "brcode-x", expectedChunkCount: 1, expectedRowCount: 1,
    });
    expect(store.ingestChunk(job.id, 0, [row({ brCode: "X" })]).accepted).toBe(1);
    store.discardImport(job.id, "brcode test");
  });

  it("refuses to open an import with no provider filter", () => {
    expect(() => store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [],
      manifest: "x", expectedChunkCount: 1, expectedRowCount: 1,
    })).toThrow(/provider id is required/i);
  });

  it("refuses a county outside the authorized territory", () => {
    expect(() => store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN], countyFips: ["37183"],
      manifest: "x", expectedChunkCount: 1, expectedRowCount: 1,
    })).toThrow(/outside the authorized territory/i);
  });

  it("refuses an unrecognised vintage code", () => {
    expect(() => store.openImport({
      tenantId: TENANT, vintage: "Q26", providerIds: [WIN],
      manifest: "x", expectedChunkCount: 1, expectedRowCount: 1,
    })).toThrow(/Unrecognised BDC vintage/);
  });
});

describe("idempotency", () => {
  it("a replayed chunk is acknowledged, not applied twice", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN],
      manifest: "replay", expectedChunkCount: 2, expectedRowCount: 4,
    });
    const rows = [row(), row()];
    const first = store.ingestChunk(job.id, 0, rows);
    const second = store.ingestChunk(job.id, 0, rows);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(store.getImport(job.id)!.receivedRowCount).toBe(2);   // not 4
    store.discardImport(job.id, "replay test");
  });

  it("the digest ignores serialisation order of object keys", () => {
    const a = { locationId: "L1", blockGeoid: ROWAN_A, providerId: WIN, technology: 50, brCode: "R", maxDownMbps: 1000, maxUpMbps: 1000 };
    const b = { maxUpMbps: 1000, maxDownMbps: 1000, brCode: "R", technology: 50, providerId: WIN, blockGeoid: ROWAN_A, locationId: "L1" };
    expect(store.chunkDigest([a])).toBe(store.chunkDigest([b as any]));
  });

  it("REFUSES a same-index chunk carrying different data", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN],
      manifest: "conflict", expectedChunkCount: 1, expectedRowCount: 1,
    });
    store.ingestChunk(job.id, 0, [row({ locationId: "L-a" })]);
    expect(() => store.ingestChunk(job.id, 0, [row({ locationId: "L-b" })]))
      .toThrow(/already applied with different contents/);
    store.discardImport(job.id, "conflict test");
  });

  it("collapses a location repeated inside one chunk", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN],
      manifest: "dupe-loc", expectedChunkCount: 1, expectedRowCount: 2,
    });
    store.ingestChunk(job.id, 0, [row({ locationId: "SAME" }), row({ locationId: "SAME" })]);
    const staged = rawDb.prepare(`SELECT COUNT(*) n FROM fcc_import_staging WHERE import_id = ?`).get(job.id) as any;
    expect(staged.n).toBe(1);
    store.discardImport(job.id, "dupe test");
  });
});

describe("finalize refuses a partial baseline", () => {
  it("throws when chunks are missing, and leaves the job open for resume", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D24", providerIds: [WIN],
      manifest: "partial", expectedChunkCount: 3, expectedRowCount: 3,
    });
    store.ingestChunk(job.id, 0, [row()]);
    store.ingestChunk(job.id, 1, [row()]);
    expect(() => store.finalizeImport(job.id)).toThrow(/received 2 of 3 chunks/);
    expect(store.getImport(job.id)!.status).toBe("open");

    // Resume: the last chunk arrives and finalize now succeeds.
    store.ingestChunk(job.id, 2, [row()]);
    expect(store.finalizeImport(job.id).blocksWritten).toBe(1);
    expect(store.getImport(job.id)!.status).toBe("finalized");
  });

  it("drops staging on finalize but keeps the chunk receipts", () => {
    const staged = rawDb.prepare(`SELECT COUNT(*) n FROM fcc_import_staging`).get() as any;
    expect(staged.n).toBe(0);
    const receipts = rawDb.prepare(`SELECT COUNT(*) n FROM fcc_import_chunks`).get() as any;
    expect(receipts.n).toBeGreaterThan(0);
  });

  it("refuses a second open import for the same vintage scope", () => {
    const a = store.openImport({
      tenantId: TENANT, vintage: "J25", providerIds: [WIN],
      manifest: "one", expectedChunkCount: 1, expectedRowCount: 1,
    });
    expect(() => store.openImport({
      tenantId: TENANT, vintage: "J25", providerIds: [WIN],
      manifest: "two", expectedChunkCount: 1, expectedRowCount: 1,
    })).toThrow();
    store.discardImport(a.id, "cleanup");
  });
});

describe("vintage comparison", () => {
  beforeAll(() => {
    // Wipe whatever the earlier blocks left so the footprint reads cleanly.
    rawDb.prepare(`DELETE FROM fcc_block_footprint WHERE tenant_id = ?`).run(TENANT);

    // D24: Kinetic serves 5 locations in ROWAN_A only.
    importVintage("D24", Array.from({ length: 5 }, (_, i) => row({ locationId: `d24-${i}`, blockGeoid: ROWAN_A })));

    // D25: ROWAN_A grows to 8, ROWAN_B lights up with 3, CABARRUS_A with 4.
    importVintage("D25", [
      ...Array.from({ length: 8 }, (_, i) => row({ locationId: `d25a-${i}`, blockGeoid: ROWAN_A })),
      ...Array.from({ length: 3 }, (_, i) => row({ locationId: `d25b-${i}`, blockGeoid: ROWAN_B })),
      ...Array.from({ length: 4 }, (_, i) => row({ locationId: `d25c-${i}`, blockGeoid: CABARRUS_A })),
    ]);
  });

  it("records one durable row per vintage per block", () => {
    expect(store.importedVintages(TENANT)).toEqual(["D24", "D25"]);
    const a = rawDb.prepare(
      `SELECT kinetic_locations n FROM fcc_block_footprint WHERE tenant_id=? AND vintage='D25' AND block_geoid=?`,
    ).get(TENANT, ROWAN_A) as any;
    expect(a.n).toBe(8);
  });

  it("computes additions against the previous vintage, not against zero", () => {
    const facts = store.blockFactsFor(TENANT, ROWAN_A)!;
    expect(facts.latestVintage).toBe("D25");
    expect(facts.baselineVintage).toBe("D24");
    expect(facts.reportedLocations).toBe(8);
    expect(facts.addedLocations).toBe(3);          // 8 now, 5 before
    expect(facts.firstReportedVintage).toBe("D24");
  });

  it("reports a newly lit block as first reported at the newer vintage", () => {
    const facts = store.blockFactsFor(TENANT, ROWAN_B)!;
    expect(facts.firstReportedVintage).toBe("D25");
    expect(facts.addedLocations).toBe(3);
    expect(facts.reportedLocations).toBe(3);
  });

  it("treats a block with no row at all as unserved, not as unknown", () => {
    const facts = store.blockFactsFor(TENANT, "371590501009999")!;
    expect(facts.reportedLocations).toBe(0);
    expect(facts.firstReportedVintage).toBeNull();
  });

  it("lists addition blocks newest-vintage-first, scoped by county", () => {
    const all = store.additionBlocks(TENANT);
    expect(all.map((b) => b.blockGeoid).sort()).toEqual([CABARRUS_A, ROWAN_A, ROWAN_B].sort());
    const rowanOnly = store.additionBlocks(TENANT, { countyFips: ["37159"] });
    expect(rowanOnly.map((b) => b.blockGeoid).sort()).toEqual([ROWAN_A, ROWAN_B].sort());
  });

  it("leaves the denominator at zero until it is supplied separately", () => {
    // Kinetic's own filing lists only what Kinetic serves, so it can never
    // say how many premises exist in the block. Zero means unknown here, and
    // the classifier is required to read it that way rather than as "empty".
    expect(store.blockFactsFor(TENANT, ROWAN_A)!.totalLocations).toBe(0);
    store.setBlockDenominators(TENANT, "D25", [{ blockGeoid: ROWAN_A, totalResidentialLocations: 20 }]);
    expect(store.blockFactsFor(TENANT, ROWAN_A)!.totalLocations).toBe(20);
  });

  it("keeps the denominator when the same vintage is re-imported", () => {
    const job = store.openImport({
      tenantId: TENANT, vintage: "D25", providerIds: [WIN],
      manifest: "reimport", expectedChunkCount: 1, expectedRowCount: 9,
    });
    store.ingestChunk(job.id, 0, Array.from({ length: 9 }, (_, i) => row({ locationId: `re-${i}`, blockGeoid: ROWAN_A })));
    store.finalizeImport(job.id);
    const facts = store.blockFactsFor(TENANT, ROWAN_A)!;
    expect(facts.reportedLocations).toBe(9);       // refreshed
    expect(facts.totalLocations).toBe(20);         // preserved
  });
});

describe("baked footprint - the artifact production actually loads", () => {
  // Production has no shell and the raw availability rows are ~40MB, so what
  // ships in the image is the per-block rollup. These pin the round trip and
  // the one rule that makes re-loading safe.
  const T3 = 903;
  const A = "370250401002090";
  const B = "370250401002091";

  function seedInto(tenant: number, vintage: string, blocks: Record<string, number>) {
    const rows = Object.entries(blocks).flatMap(([blockGeoid, n]) =>
      Array.from({ length: n }, (_, i) => ({
        // Location ids are STABLE across vintages in real BDC data - that is
        // what makes a diff a diff. Embedding the vintage here would make every
        // row look newly added.
        locationId: `${tenant}-${blockGeoid}-${i}`,
        blockGeoid, providerId: WIN, technology: 50, brCode: "R",
        maxDownMbps: 1000, maxUpMbps: 1000,
      })));
    const job = store.openImport({
      tenantId: tenant, vintage, providerIds: [WIN],
      manifest: `bake-${tenant}-${vintage}`, expectedChunkCount: 1, expectedRowCount: rows.length,
    });
    store.ingestChunk(job.id, 0, rows);
    store.finalizeImport(job.id);
  }

  /** Present at both vintages with the SAME count - gained nothing. */
  const C = "370250401002092";

  beforeAll(() => {
    seedInto(T3, "D24", { [A]: 4, [C]: 6 });
    seedInto(T3, "D25", { [A]: 9, [B]: 5, [C]: 6 });
    store.setBlockDenominators(T3, "D25", [{ blockGeoid: A, totalResidentialLocations: 20 }]);
  });

  it("round-trips the footprint into a different org unchanged", () => {
    const exported = store.exportFootprint(T3);
    expect(exported.vintages).toEqual(["D24", "D25"]);
    expect(exported.rows.length).toBe(5);   // A@D24, A@D25, B@D25, C@D24, C@D25

    const T4 = 904;
    const applied = store.loadFootprint(T4, exported);
    expect(applied.blocks).toBe(5);

    const facts = store.blockFactsFor(T4, A)!;
    expect(facts.latestVintage).toBe("D25");
    expect(facts.baselineVintage).toBe("D24");
    expect(facts.reportedLocations).toBe(9);
    expect(facts.addedLocations).toBe(5);
    // The denominator survives the trip - without it likely_2026 cannot fire.
    expect(facts.totalLocations).toBe(20);
    expect(store.additionBlocks(T4).map((b) => b.blockGeoid).sort()).toEqual([A, B].sort());  // not C
  });

  it("carries FCC location ids across BOTH vintages of an addition block", () => {
    const exported = store.exportFootprint(T3);
    const now = exported.rows.find((r) => r.blockGeoid === A && r.vintage === "D25")!;
    const before = exported.rows.find((r) => r.blockGeoid === A && r.vintage === "D24")!;
    expect(now.locationIds?.length).toBe(9);
    // Both sides, deliberately: with the before-set AND the after-set, WHICH
    // locations were added is derivable, not merely how many. Counting alone
    // would leave the central claim unevidenced.
    expect(before.locationIds?.length).toBe(4);
    const added = now.locationIds!.filter((id) => !before.locationIds!.includes(id));
    expect(added).toHaveLength(5);
  });

  it("carries no ids for a block that gained nothing", () => {
    // Shipping ~100k ids to evidence a claim nobody makes about untouched
    // blocks would add tens of megabytes to the production image.
    const exported = store.exportFootprint(T3);
    for (const vintage of ["D24", "D25"]) {
      expect(exported.rows.find((r) => r.blockGeoid === C && r.vintage === vintage)!.locationIds).toBeUndefined();
    }
  });

  it("REPLACES a vintage wholesale rather than merging into a stale one", () => {
    const T5 = 905;
    store.loadFootprint(T5, store.exportFootprint(T3));
    expect(store.blockFactsFor(T5, B)!.reportedLocations).toBe(5);

    // A later dataset in which block B no longer appears at D25. Merging would
    // leave B still reporting coverage - service that is not there.
    const shrunk = store.exportFootprint(T3);
    shrunk.rows = shrunk.rows.filter((r) => r.blockGeoid !== B);
    store.loadFootprint(T5, shrunk);
    expect(store.blockFactsFor(T5, B)!.reportedLocations).toBe(0);
    expect(store.blockFactsFor(T5, A)!.reportedLocations).toBe(9);
  });

  it("is idempotent - loading twice changes nothing", () => {
    const T6 = 906;
    const exported = store.exportFootprint(T3);
    store.loadFootprint(T6, exported);
    const first = store.blockFactsFor(T6, A)!;
    store.loadFootprint(T6, exported);
    expect(store.blockFactsFor(T6, A)).toEqual(first);
    expect(rawDb.prepare(`SELECT COUNT(*) n FROM fcc_block_footprint WHERE tenant_id = ?`).get(T6)).toEqual({ n: 5 });
  });
});

describe("reversibility", () => {
  it("removing a vintage leaves every other vintage intact", () => {
    const before = store.blockFactsFor(TENANT, ROWAN_A)!;
    expect(before.latestVintage).toBe("D25");

    const { removedBlocks } = store.revertVintage(TENANT, "D25");
    expect(removedBlocks).toBeGreaterThan(0);
    expect(store.importedVintages(TENANT)).toEqual(["D24"]);

    const after = store.blockFactsFor(TENANT, ROWAN_A)!;
    expect(after.latestVintage).toBe("D24");
    expect(after.reportedLocations).toBe(5);
    expect(after.baselineVintage).toBeNull();
    // With one vintage there is nothing to diff, so nothing is claimed as new.
    expect(after.addedLocations).toBe(0);
    expect(store.additionBlocks(TENANT)).toEqual([]);
  });
});
