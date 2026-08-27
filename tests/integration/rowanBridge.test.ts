import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// script/import-rowan.ts puts Rowan County's E911 inventory into scan_targets.
// Two things decide whether the doors it writes are askable at all:
//
//   1. the street spelling it derives from E911's SCREAMING CASE, and
//   2. the two dedup guards inside storage.upsertScanTargets that it leans on
//      instead of re-implementing.
//
// Both are covered here. The dedup cases are written as the bridge actually
// runs - street_key populated, canonical_key populated - because that is what
// changes the answers, and a fixture that leaves either NULL passes for the
// wrong reason.

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage").storage;
let bridge: typeof import("../../script/import-rowan");
let addressKey: typeof import("../../shared/addressKey");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rowan-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  storage = s.storage;
  addressKey = await import("../../shared/addressKey");
  bridge = await import("../../script/import-rowan");
});

describe("E911 street normalization", () => {
  it("folds the two route spellings Kinetic was measured to answer", () => {
    // Measured live on Rockwell 2026-08-27, same house, same minute: the E911
    // forms came home FAILED and these came home FIBER.
    expect(bridge.normalize("6735 EAST NORTH CAROLINA 152 HIGHWAY")).toMatchObject({
      address: "6735 E Nc 152 Hwy", proven: true,
    });
    expect(bridge.normalize("12300 UNITED STATES HIGHWAY 52 HIGHWAY")).toMatchObject({
      address: "12300 US Hwy 52", proven: true,
    });
  });

  it("folds the nine Rowan route names Rockwell never measured, and flags them unproven", () => {
    // These are analogies, not measurements. `proven: false` is what makes the
    // door count visible in every report instead of riding along silently.
    const byAnalogy: Array<[string, string]> = [
      ["275 WEST NORTH CAROLINA 152 HIGHWAY", "275 W Nc 152 Hwy"],
      ["1234 NORTH CAROLINA 801 HIGHWAY", "1234 Nc 801 Hwy"],
      ["1234 NORTH CAROLINA 153 HIGHWAY", "1234 Nc 153 Hwy"],
      ["1965 SOUTH UNITED STATES HIGHWAY 29 HIGHWAY", "1965 S US Hwy 29"],
      ["1965 NORTH UNITED STATES HIGHWAY 29 HIGHWAY", "1965 N US Hwy 29"],
      ["2625 OLD UNITED STATES HIGHWAY 80 HIGHWAY", "2625 Old US Hwy 80"],
      ["1500 OLD UNITED STATES HIGHWAY 70 HIGHWAY", "1500 Old US Hwy 70"],
    ];
    for (const [raw, want] of byAnalogy) {
      expect(bridge.normalize(raw)).toMatchObject({ address: want, proven: false });
    }
  });

  it("keeps the directional that distinguishes two sides of a divided highway", () => {
    // Rowan E911 carries BOTH of these at house number 1965 - two premises. A
    // fold that dropped the directional to match the "1965 US Route 29" we
    // already hold would collapse them into one door.
    const north = bridge.normalize("1965 NORTH UNITED STATES HIGHWAY 29 HIGHWAY").address;
    const south = bridge.normalize("1965 SOUTH UNITED STATES HIGHWAY 29 HIGHWAY").address;
    expect(north).not.toBe(south);
  });

  it("abbreviates the trailing street type and leaves mid-name words alone", () => {
    // "520 Sawtooth Oak Drive" returned AddressSuggestions/no match and
    // "520 Sawtooth Oak Dr" returned AddressFound + exactMatch, same door, same
    // minute (Landis, 2026-08-27).
    expect(bridge.normalize("520 SAWTOOTH OAK DRIVE").address).toBe("520 Sawtooth Oak Dr");
    expect(bridge.normalize("100 OAK RIDGE COURT").address).toBe("100 Oak Ridge Ct");
    expect(bridge.normalize("704 WEST 8TH STREET").address).toBe("704 West 8th St");
  });

  it("never abbreviates a street type the canonical key does not fold", () => {
    // shared/addressKey.ts folds a deliberately limited set. Abbreviating
    // TRACE/POINT/GREENWAY here would move the canonical key away from every
    // row we already hold and mint a duplicate of each one.
    expect(bridge.normalize("900 BAKERS CREEK GREENWAY").address).toBe("900 Bakers Creek Greenway");
    expect(bridge.normalize("120 HUNTERS TRACE").address).toBe("120 Hunters Trace");
    expect(bridge.normalize("55 SHADY POINT").address).toBe("55 Shady Point");
  });

  it("splits E911's unit clause off before folding the street", () => {
    const n = bridge.normalize("2114 ENGLEWOOD STREET, UNIT A, BUILDING A");
    expect(n.address).toBe("2114 Englewood St, Unit A, Building A");
    expect(n.clause).toBe("Unit A, Building A");
    // Without the split the trailing token is "A", the suffix fold never fires,
    // and the door goes in as "...Englewood Street" - the exact spelling Landis
    // measured as unanswerable.
    expect(bridge.splitUnitClause("2114 ENGLEWOOD STREET, UNIT A").base).toBe("2114 ENGLEWOOD STREET");
  });
});

describe("what normalization does and does not do to the canonical identity", () => {
  const suffixOnly = [
    "520 SAWTOOTH OAK DRIVE", "331 LADUE LANE", "100 OAK RIDGE COURT",
    "704 WEST 8TH STREET", "2114 ENGLEWOOD STREET, UNIT A, BUILDING A",
  ];

  it("suffix and case folding leave the canonical key exactly where it was", () => {
    // This is the property the whole import rests on: re-spelling a door for
    // Kinetic must not turn it into a different premise, or the canonical-twin
    // guard stops recognising doors we already hold.
    for (const raw of suffixOnly) {
      expect(addressKey.canonicalAddressPart(bridge.normalize(raw).address))
        .toBe(addressKey.canonicalAddressPart(raw));
    }
  });

  it("route folds DO move the canonical key, deliberately", () => {
    // "UNITED STATES HWY 52 HWY" and "US HWY 52" are different canonical keys,
    // so a door already held under E911's raw spelling is NOT a canonical twin
    // of the folded one. The postal-city alias twin (street_key + house number
    // + coordinates) is what catches those, which is why the bridge fills
    // street_key as it writes rather than leaving it to the janitor.
    const raw = "12300 UNITED STATES HIGHWAY 52 HIGHWAY";
    expect(addressKey.canonicalAddressPart(bridge.normalize(raw).address))
      .not.toBe(addressKey.canonicalAddressPart(raw));
  });
});

describe("the dedup guards the bridge leans on", () => {
  it("a re-spelled door attaches to the row we already hold when canonical_key is set", () => {
    storage.upsertScanTargets([{
      address: "1131 Bird Dog Trail", city: "Rockwell", state: "NC", zip: "28138",
      lat: 35.5501, lng: -80.4001, tenantId: TENANT, source: "field",
    }] as any);
    const added = storage.upsertScanTargets([{
      address: "1131 Bird Dog Trl", city: "Rockwell", state: "NC", zip: "28138",
      lat: 35.5501, lng: -80.4001, tenantId: TENANT, source: "e911-nc-onemap",
    }] as any);
    expect(added).toBe(0);
    const rows = rawDb.prepare(`SELECT id FROM scan_targets WHERE address LIKE '1131 Bird Dog%'`).all();
    expect(rows.length).toBe(1);
  });

  it("the same door DUPLICATES when the row we hold has canonical_key NULL", () => {
    // This is why the bridge backfills canonical_key BEFORE it upserts. The
    // twin guard is `WHERE canonical_key = ?` and cannot fire on a NULL; 292,999
    // of tenant 1's 924,104 rows were NULL when this was written. Legacy shape
    // reproduced with raw SQL because upsertScanTargets always stamps the key.
    rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, tenant_id, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
    ).run("115 Mason Hill Drive", "Rockwell", "NC", "28138", 35.5502, -80.4002, TENANT, "gis");

    storage.upsertScanTargets([{
      address: "115 Mason Hill Dr", city: "Rockwell", state: "NC", zip: "28138",
      lat: 35.5502, lng: -80.4002, tenantId: TENANT, source: "e911-nc-onemap",
    }] as any);
    const rows = rawDb.prepare(`SELECT id FROM scan_targets WHERE address LIKE '115 Mason Hill%'`).all();
    expect(rows.length).toBe(2); // one house, two rows, and it gets scanned twice

    // Stamp the key the way the bridge's backfill does, and the next re-spelling
    // attaches instead of minting a third.
    rawDb.prepare(`UPDATE scan_targets SET canonical_key=? WHERE address=?`).run(
      addressKey.normalizeKineticAddressKey("115 Mason Hill Drive", "Rockwell", "NC", "28138"),
      "115 Mason Hill Drive",
    );
    const added = storage.upsertScanTargets([{
      address: "115 Mason Hill DRIVE", city: "Rockwell", state: "NC", zip: "28138",
      lat: 35.5502, lng: -80.4002, tenantId: TENANT, source: "e911-nc-onemap",
    }] as any);
    expect(added).toBe(0);
  });

  it("distinct UNITS at one premise are ABSORBED once street_key is populated", () => {
    // Documented, not desired. storage.upsertScanTargets says of the alias-twin
    // guard "distinct units differ in street_key's retained unit token and never
    // merge", but streetKeyOf CUTS the address at the first unit token rather
    // than retaining it - so every unit at a premise shares a street_key and a
    // house number, and the ~25m coordinate window does the rest.
    //
    // tests/integration/anti-miss-controls.test.ts asserts the opposite and
    // passes only because street_key is still NULL on its first row, where the
    // guard cannot match. The bridge fills street_key as it writes, so it gets
    // this behavior - which is why it holds Rowan's 6,793 unit doors back.
    // When the guard is fixed, this test is the one that has to flip.
    expect(addressKey.streetKeyOf("2715 Statesville Blvd Unit 101"))
      .toBe(addressKey.streetKeyOf("2715 Statesville Blvd Unit 102"));

    storage.upsertScanTargets([{
      address: "2715 Statesville Blvd Unit 101", city: "Salisbury", state: "NC", zip: "28147",
      lat: 35.6700, lng: -80.5200, tenantId: TENANT, source: "e911-nc-onemap",
    }] as any);
    rawDb.prepare(`UPDATE scan_targets SET street_key=? WHERE address LIKE '2715 Statesville%' AND street_key IS NULL`)
      .run(addressKey.streetKeyOf("2715 Statesville Blvd Unit 101"));

    const added = storage.upsertScanTargets([{
      address: "2715 Statesville Blvd Unit 102", city: "Salisbury", state: "NC", zip: "28147",
      lat: 35.6700, lng: -80.5200, tenantId: TENANT, source: "e911-nc-onemap",
    }] as any);
    expect(added).toBe(0);
    const rows = rawDb.prepare(`SELECT address FROM scan_targets WHERE address LIKE '2715 Statesville%'`).all();
    expect(rows.length).toBe(1);
  });

  it("genuine neighbours on the same street are never absorbed", () => {
    storage.upsertScanTargets([{
      address: "2717 Statesville Blvd", city: "Salisbury", state: "NC", zip: "28147",
      lat: 35.6700, lng: -80.5200, tenantId: TENANT, source: "e911-nc-onemap",
    }] as any);
    const rows = rawDb.prepare(`SELECT address FROM scan_targets WHERE address='2717 Statesville Blvd'`).all();
    expect(rows.length).toBe(1); // different house number, same rooftop coordinates
  });
});
