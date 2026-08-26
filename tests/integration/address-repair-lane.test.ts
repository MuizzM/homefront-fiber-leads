import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INCONCLUSIVE_GIVEUP, ANF_PARK_MAX_GENERATIONS } from "../../shared/scanPolicy";

// The repair lane consumes what the escalating park window terminates: real
// homes whose stored spelling Kinetic never matched (the Stonewyck pattern —
// a Mapbox-seeded address filed under the wrong postal city). Repairs come from
// our OWN verified neighbours, so no Mapbox spend is possible here.

let rawDb: import("better-sqlite3").Database;
let lane: typeof import("../../server/addressRepairLane");
const TERMINAL = INCONCLUSIVE_GIVEUP + ANF_PARK_MAX_GENERATIONS + 1;

function seed(opts: {
  address: string; city?: string | null; zip?: string | null; street?: string;
  scanned?: boolean; attempts?: number; lat?: number; lng?: number;
}): number {
  return Number(rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source,
       street_key, last_scanned_at, inconclusive_attempts, last_inconclusive_at, created_at)
     VALUES (?,?,'NC',?,?,?,1,'osm',?, ?, ?, ?, datetime('now'))`,
  ).run(
    opts.address, opts.city ?? "Salisbury", opts.zip ?? "", opts.lat ?? 35.60, opts.lng ?? -80.43,
    opts.street ?? "STONEWYCK DR",
    opts.scanned ? new Date().toISOString() : null,
    opts.attempts ?? (opts.scanned ? 0 : TERMINAL),
    opts.scanned ? null : new Date().toISOString(),
  ).lastInsertRowid);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-repair-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  lane = await import("../../server/addressRepairLane");
  lane.ensureRepairSchema();
});

describe("repair planning (pure)", () => {
  const base = { id: 1, state: "NC", street_key: "STONEWYCK DR", lat: 35.60, lng: -80.43 };

  it("POSTAL_CITY_ALIAS: adopts the city its verified neighbours use", () => {
    const plan = lane.planRepair(
      { ...base, address: "1315 Stonewyck Dr", city: "Lexington", zip: "28146" },
      [{ city: "Salisbury", zip: "28146", address: "1317 Stonewyck Dr", lat: 35.6, lng: -80.43 },
       { city: "Salisbury", zip: "28146", address: "1319 Stonewyck Dr", lat: 35.6, lng: -80.43 }] as any,
    );
    expect(plan.code).toBe("POSTAL_CITY_ALIAS");
    expect(plan.patch.city).toBe("Salisbury");
  });

  it("ZIP_MISSING: adopts the neighbours' agreed ZIP", () => {
    const plan = lane.planRepair(
      { ...base, address: "1315 Stonewyck Dr", city: "Salisbury", zip: "" },
      [{ city: "Salisbury", zip: "28146", address: "1317 Stonewyck Dr", lat: 35.6, lng: -80.43 }] as any,
    );
    expect(plan.code).toBe("ZIP_MISSING");
    expect(plan.patch.zip).toBe("28146");
  });

  it("SUFFIX_VARIANT: rewrites to the verified street spelling", () => {
    const plan = lane.planRepair(
      { ...base, address: "1315 Stonewyck Drive", city: "Salisbury", zip: "28146" },
      [{ city: "Salisbury", zip: "28146", address: "1317 Stonewyck Dr", lat: 35.6, lng: -80.43 }] as any,
    );
    expect(plan.code).toBe("SUFFIX_VARIANT");
    expect(plan.patch.address).toBe("1315 Stonewyck Dr");
  });

  it("UNREPAIRABLE when no scanned neighbour exists, or when the address already matches", () => {
    expect(lane.planRepair({ ...base, address: "1315 Stonewyck Dr", city: "Salisbury", zip: "28146" }, []).code)
      .toBe("UNREPAIRABLE");
    expect(lane.planRepair(
      { ...base, address: "1315 Stonewyck Dr", city: "Salisbury", zip: "28146" },
      [{ city: "Salisbury", zip: "28146", address: "1315 Stonewyck Dr", lat: 35.6, lng: -80.43 }] as any,
    ).code).toBe("UNREPAIRABLE");
  });

  it("never repairs an address with no house number", () => {
    expect(lane.planRepair({ ...base, address: "Stonewyck Dr", city: "Salisbury", zip: "28146" }, []).code)
      .toBe("UNREPAIRABLE");
  });
});

describe("repair pass (single-writer, bounded)", () => {
  it("repairs the city twin and RE-ARMS it for exactly one more scan", () => {
    seed({ address: "1317 Stonewyck Dr", city: "Salisbury", zip: "28146", scanned: true });
    seed({ address: "1319 Stonewyck Dr", city: "Salisbury", zip: "28146", scanned: true });
    const broken = seed({ address: "1315 Stonewyck Dr", city: "Lexington", zip: "" });

    const res = lane.runAddressRepairPass(50);
    expect(res.halted).toBeNull();
    expect(res.repaired).toBeGreaterThanOrEqual(1);

    const row = rawDb.prepare(`SELECT city, inconclusive_attempts, repair_code FROM scan_targets WHERE id=?`).get(broken) as any;
    expect(row.city).toBe("Salisbury");
    expect(row.repair_code).toBe("POSTAL_CITY_ALIAS");
    expect(row.inconclusive_attempts).toBe(0); // re-armed: scans once more, then re-escalates
  });

  it("quarantines the unrepairable and never re-examines a processed row (idempotent)", () => {
    seed({ address: "900 Orphan Rd", city: "Nowhere", zip: "", street: "ORPHAN RD" });
    const first = lane.runAddressRepairPass(50);
    expect(first.quarantined).toBeGreaterThanOrEqual(1);
    const again = lane.runAddressRepairPass(50);
    expect(again.examined).toBe(0); // repair_code set → out of the candidate query
  });
});

// COHORT PASS — the Rockwell case. A full-city run leaves its unmatched tail at
// 3-4 inconclusive attempts, which is BELOW the scheduled lane's floor of
// INCONCLUSIVE_GIVEUP + ANF_PARK_MAX_GENERATIONS + 1. Those rows are exactly the
// ones worth repairing and exactly the ones runAddressRepairPass can never see.
describe("cohort pass (operator-named ids)", () => {
  it("repairs a stuck row sitting BELOW the park threshold, which the scheduled pass skips", () => {
    seed({ address: "412 Holshouser Rd", city: "Rockwell", zip: "28138", street: "HOLSHOUSER RD", scanned: true });
    seed({ address: "414 Holshouser Rd", city: "Rockwell", zip: "28138", street: "HOLSHOUSER RD", scanned: true });
    const stuck = seed({
      address: "410 Holshouser Road", city: "Rockwell", zip: "28138",
      street: "HOLSHOUSER RD", attempts: INCONCLUSIVE_GIVEUP, // 3 — the real Rockwell depth
    });

    // The scheduled pass cannot reach it: its floor is TERMINAL (7).
    expect(lane.terminalParkedBatch(500).some((c) => c.id === stuck)).toBe(false);

    const res = lane.runAddressRepairForTargets([stuck]);
    expect(res.examined).toBe(1);
    expect(res.repaired).toBe(1);
    expect(res.byCode.SUFFIX_VARIANT).toBe(1);

    const row = rawDb.prepare(`SELECT address, repair_code, inconclusive_attempts FROM scan_targets WHERE id=?`).get(stuck) as any;
    expect(row.address).toBe("410 Holshouser Rd");
    expect(row.repair_code).toBe("SUFFIX_VARIANT");
    expect(row.inconclusive_attempts).toBe(0); // re-armed for exactly one more scan
  });

  it("never touches an address that already has an answer, and is idempotent", () => {
    const answered = seed({ address: "900 Cannon Street", city: "Rockwell", zip: "28138", street: "CANNON ST", scanned: true });
    const stuck = seed({ address: "902 Cannon Street", city: "Rockwell", zip: "28138", street: "CANNON ST", attempts: 4 });
    seed({ address: "904 Cannon St", city: "Rockwell", zip: "28138", street: "CANNON ST", scanned: true });

    const first = lane.runAddressRepairForTargets([answered, stuck], { quarantine: true });
    expect(first.examined).toBe(1); // the answered door is filtered out, not repaired
    expect(rawDb.prepare(`SELECT repair_code FROM scan_targets WHERE id=?`).get(answered)).toMatchObject({ repair_code: null });

    const again = lane.runAddressRepairForTargets([answered, stuck], { quarantine: true });
    expect(again.examined).toBe(0); // repair_code set → one repair per row, ever
  });

  it("leaves an unrepairable row inside the park ladder ALONE rather than parking it forever", () => {
    const orphan = seed({ address: "77 Brooks Farm Rd", city: "Rockwell", zip: "28138", street: "BROOKS FARM RD", attempts: 3 });
    const res = lane.runAddressRepairForTargets([orphan]);
    expect(res.repaired).toBe(0);
    expect(res.quarantined).toBe(0);   // permanent parking is NOT the default for a cohort
    expect(res.skipped).toBe(1);
    const row = rawDb.prepare(`SELECT repair_code, inconclusive_attempts, address_review_reason FROM scan_targets WHERE id=?`).get(orphan) as any;
    expect(row.repair_code).toBeNull();          // still the park ladder's to re-probe
    expect(row.inconclusive_attempts).toBe(3);   // schedule untouched
    expect(row.address_review_reason).toBeNull();
  });

  it("quarantines only when the caller explicitly opts in", () => {
    const orphan = seed({ address: "79 Brooks Farm Rd", city: "Rockwell", zip: "28138", street: "BROOKS FARM RD", attempts: 3 });
    const res = lane.runAddressRepairForTargets([orphan], { quarantine: true });
    expect(res.quarantined).toBe(1);
    expect(rawDb.prepare(`SELECT repair_code FROM scan_targets WHERE id=?`).get(orphan))
      .toMatchObject({ repair_code: "UNREPAIRABLE" });
  });

  it("returns an empty result for an empty cohort without touching the database", () => {
    const res = lane.runAddressRepairForTargets([]);
    expect(res).toMatchObject({ examined: 0, repaired: 0, quarantined: 0, halted: null });
  });
});

// NEIGHBOUR SCOPE — measured against the live table, street_key 'S MAIN ST' in
// NC matched 414 scanned rows across 14 cities and not one shared the target's
// ZIP. Adopting a "verified city" from that pool relabelled 21 Rockwell doors
// as Norwood / Concord / High Point while keeping ZIP 28138.
describe("a neighbour must be in the same PLACE, not just the same street name", () => {
  it("ignores same-named streets in other ZIPs, so no cross-town city is ever adopted", () => {
    // Two towns, one street name. Only the Rockwell twin is a real neighbour.
    seed({ address: "1002 N Main St", city: "China Grove", zip: "28023", street: "N MAIN ST", scanned: true });
    seed({ address: "1004 N Main St", city: "Norwood", zip: "28128", street: "N MAIN ST", scanned: true });
    seed({ address: "1006 N Main St", city: "Wingate", zip: "28174", street: "N MAIN ST", scanned: true });
    const door = seed({ address: "400 N Main St", city: "Rockwell", zip: "28138", street: "N MAIN ST", attempts: 4 });

    const res = lane.runAddressRepairForTargets([door]);
    expect(res.byCode.POSTAL_CITY_ALIAS ?? 0).toBe(0);
    const row = rawDb.prepare(`SELECT city, repair_code FROM scan_targets WHERE id=?`).get(door) as any;
    expect(row.city).toBe("Rockwell");          // NOT relabelled to another town
    expect(res.byCode.UNREPAIRABLE).toBe(1);
  });

  it("still adopts a genuine postal-city alias from twins in the SAME ZIP", () => {
    seed({ address: "2117 Bramble Ct", city: "Salisbury", zip: "28146", street: "BRAMBLE CT", scanned: true });
    seed({ address: "2119 Bramble Ct", city: "Salisbury", zip: "28146", street: "BRAMBLE CT", scanned: true });
    const door = seed({ address: "2121 Bramble Ct", city: "Lexington", zip: "28146", street: "BRAMBLE CT", attempts: 3 });

    expect(lane.runAddressRepairForTargets([door]).byCode.POSTAL_CITY_ALIAS).toBe(1);
    expect(rawDb.prepare(`SELECT city FROM scan_targets WHERE id=?`).get(door)).toMatchObject({ city: "Salisbury" });
  });

  it("falls back to proximity when the row's own ZIP was overwritten by the house number", () => {
    // 533 rows in the live table look like this: '10540 US HWY 52' under ZIP 10540.
    seed({ address: "10500 Us Hwy 52", city: "Rockwell", zip: "28138", street: "US HWY 52", scanned: true, lat: 35.549, lng: -80.395 });
    seed({ address: "10520 Us Hwy 52", city: "Rockwell", zip: "28138", street: "US HWY 52", scanned: true, lat: 35.550, lng: -80.396 });
    const door = seed({ address: "10540 Us Hwy 52", city: "Lexington", zip: "10540", street: "US HWY 52", attempts: 3, lat: 35.5495, lng: -80.3955 });

    // The corrupt ZIP must not fence the row off from its real neighbours.
    expect(lane.runAddressRepairForTargets([door]).byCode.POSTAL_CITY_ALIAS).toBe(1);
    expect(rawDb.prepare(`SELECT city FROM scan_targets WHERE id=?`).get(door)).toMatchObject({ city: "Rockwell" });
  });

  it("refuses to guess when there is neither a usable ZIP nor coordinates", () => {
    seed({ address: "12 Blind Aly", city: "Rockwell", zip: "28138", street: "BLIND ALY", scanned: true });
    const door = Number(rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, street_key,
         last_scanned_at, inconclusive_attempts, created_at)
       VALUES ('14 Blind Aly','Nowhere','NC','',NULL,NULL,1,'osm','BLIND ALY',NULL,3,datetime('now'))`).run().lastInsertRowid);
    expect(lane.runAddressRepairForTargets([door]).byCode.UNREPAIRABLE).toBe(1);
  });
});

// SUFFIX DIRECTION — the original rule adopted the first neighbour's spelling
// whatever it was, and rewrote 25 Rockwell doors "Quail Haven Dr" -> "Quail
// Haven Drive", away from the form Kinetic itself returns.
describe("suffix repair moves towards the canonical spelling, never away", () => {
  it("never expands an already-abbreviated suffix, even when a neighbour spells it out", () => {
    seed({ address: "1007 Quail Haven Drive", city: "Rockwell", zip: "28138", street: "QUAIL HAVEN DR", scanned: true });
    const door = seed({ address: "1009 Quail Haven Dr", city: "Rockwell", zip: "28138", street: "QUAIL HAVEN DR", attempts: 4 });

    expect(lane.runAddressRepairForTargets([door]).byCode.SUFFIX_VARIANT ?? 0).toBe(0);
    expect(rawDb.prepare(`SELECT address FROM scan_targets WHERE id=?`).get(door))
      .toMatchObject({ address: "1009 Quail Haven Dr" }); // unchanged
  });

  it("does abbreviate when OURS is the spelled-out form and verified neighbours are canonical", () => {
    seed({ address: "7620 China Grove Hwy", city: "Rockwell", zip: "28138", street: "CHINA GROVE HWY", scanned: true });
    seed({ address: "7622 China Grove Hwy", city: "Rockwell", zip: "28138", street: "CHINA GROVE HWY", scanned: true });
    const door = seed({ address: "7630 China Grove Highway", city: "Rockwell", zip: "28138", street: "CHINA GROVE HWY", attempts: 3 });

    expect(lane.runAddressRepairForTargets([door]).byCode.SUFFIX_VARIANT).toBe(1);
    expect(rawDb.prepare(`SELECT address FROM scan_targets WHERE id=?`).get(door))
      .toMatchObject({ address: "7630 China Grove Hwy" });
  });
});

// A repair that cannot be WRITTEN must still leave the row terminal, or every
// later pass re-plans the same doomed UPDATE forever.
describe("an unwritable repair is marked, not retried forever", () => {
  it("quarantines a row whose corrected address collides with an existing target", () => {
    seed({ address: "500 Collide Hwy", city: "Rockwell", zip: "28139", street: "COLLIDE HWY", scanned: true });
    seed({ address: "502 Collide Hwy", city: "Rockwell", zip: "28139", street: "COLLIDE HWY", scanned: true });
    // The exact row the repair below will try to become.
    seed({ address: "504 Collide Hwy", city: "Rockwell", zip: "28139", street: "COLLIDE HWY", scanned: true });
    const dup = seed({ address: "504 Collide Highway", city: "Rockwell", zip: "28139", street: "COLLIDE HWY", attempts: 3 });

    const res = lane.runAddressRepairForTargets([dup], { quarantine: true });
    expect(res.repaired).toBe(0);
    expect(res.quarantined).toBe(1);
    expect(res.byCode.UNREPAIRABLE).toBe(1);        // re-attributed off SUFFIX_VARIANT
    expect(res.byCode.SUFFIX_VARIANT ?? 0).toBe(0);

    const row = rawDb.prepare(`SELECT repair_code, address_review_reason FROM scan_targets WHERE id=?`).get(dup) as any;
    expect(row.repair_code).toBe("UNREPAIRABLE");
    expect(row.address_review_reason).toMatch(/could not be applied/);
    expect(lane.runAddressRepairForTargets([dup], { quarantine: true }).examined).toBe(0);  // never re-planned
  });
});
