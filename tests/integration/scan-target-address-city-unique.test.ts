import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Two houses with the SAME street text in DIFFERENT cities are two distinct
// scan targets — and two distinct leads. The old global UNIQUE(address) made the
// second city's house collide with the first (route 409, sweep INSERT OR IGNORE),
// throwing away a real NEW FIBER + N lead. scan_targets is now unique by
// (address, city, state).

let rawDb: import("better-sqlite3").Database;
let persist: typeof import("../../server/kineticObservation").persistKineticObservation;
const TENANT = 1;

function freshObs(address: string, city: string, state: string, zip: string, lat = 35.5, lng = -80.4) {
  return {
    tenantId: TENANT,
    source: "route-field-scan",
    observation: {
      address, city, state, zip, lat, lng,
      fiberStatus: "new_fiber", fiberAvailable: true, isNewFiber: true, billingStatus: "N",
      householdSegmentType: "NEW FIBER", techType: "FTTP", apiSource: "kinetic_live",
      blocked: false, discoveredAt: new Date().toISOString(),
    },
  };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-scan-target-unique-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations();
  persist = (await import("../../server/kineticObservation")).persistKineticObservation;
});

describe("scan_targets uniqueness is (address, city, state), not address alone", () => {
  it("the migration removed the global UNIQUE(address) constraint", () => {
    const sql = (rawDb.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='scan_targets'`).get() as any).sql as string;
    expect(/address\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(sql)).toBe(false);
  });

  it("same street text in two cities → two targets, two leads (neither thrown away)", () => {
    // Broadway first, then Sanford — the second used to collide and be dropped.
    // Real houses ~15 miles apart carry distinct coordinates (the projector's
    // geo guard only merges same-rooftop twins, so distinct coords stay two).
    expect(() => persist(freshObs("104 Oak St", "Broadway", "NC", "27505", 35.46, -79.05))).not.toThrow();
    expect(() => persist(freshObs("104 Oak St", "Sanford", "NC", "27330", 35.48, -79.17))).not.toThrow();

    const targets = rawDb.prepare(`SELECT city FROM scan_targets WHERE lower(trim(address))='104 oak st' ORDER BY city`).all() as any[];
    expect(targets.map(t => t.city).sort()).toEqual(["Broadway", "Sanford"]);

    const leads = rawDb.prepare(`SELECT city FROM leads WHERE lower(trim(address))='104 oak st' AND tenant_id=? ORDER BY city`).all(TENANT) as any[];
    expect(leads.map(l => l.city).sort()).toEqual(["Broadway", "Sanford"]);
  });

  it("re-checking the SAME house (same city) reuses its one target — no duplicate", () => {
    persist(freshObs("500 Pine Ave", "Cary", "NC", "27511"));
    persist(freshObs("500 Pine Ave", "Cary", "NC", "27511"));
    const n = (rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE lower(trim(address))='500 pine ave' AND lower(trim(city))='cary'`).get() as any).n;
    expect(n).toBe(1);
  });
});
