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
