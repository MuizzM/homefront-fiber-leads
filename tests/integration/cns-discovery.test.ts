import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Zero-Mapbox city discovery — verified against a REAL SQLite DB with a MOCK
 * Kinetic probe (no network, no proxy, no Mapbox, never a real scan). Proves:
 * harvest-as-you-scan grows the pool with df ids; the city↔CNS index targets a
 * city's frontier; raw NEW-FIBER hits remain evidence rather than becoming
 * unverified leads; a provider failure is never recorded as a miss; and the
 * adaptive stop halts when we walk out of the city's locality.
 */

let storage: typeof import("../../server/storage").storage;
let rawDb: import("better-sqlite3").Database;
let disc: typeof import("../../server/cnsDiscovery");
let cns: typeof import("../../server/cns-scanner");

const TEN = 7;

function seedCity(env: string, city: string, cnsList: number[], newFiber = false) {
  storage.upsertScanTargets(cnsList.map(c => ({
    address: `${c} ${city} St`, city, state: "NC", zip: "28100",
    lat: 35.2, lng: -80.8, source: "seed", tenantId: null,
    dfAddressId: `${env}${String(c).padStart(7, "0")}`, scannedNow: true,
    fiberStatus: newFiber ? "new_fiber" : "other", isNewFiber: newFiber, billingStatus: "Y",
  })));
}

// A mock probe: returns a NEW-FIBER+billing-N hit in `city` for the given df ids,
// a conclusive miss otherwise, and a transient fail for any df id in `failSet`.
function mockProbe(hitCity: string, failSet = new Set<string>()) {
  return async (dfId: string): Promise<import("../../server/cns-scanner").CnsProbe> => {
    if (failSet.has(dfId)) return { kind: "fail", reason: "http" };
    const m = /^([A-Za-z]+)(\d+)$/.exec(dfId)!;
    const cnsNum = parseInt(m[2], 10);
    // Frontier of the seeded band (>2000) is "live new fiber"; everything else misses.
    if (cnsNum >= 2000 && cnsNum < 3000) {
      return {
        kind: "hit",
        result: {
          env: m[1], cns: cnsNum, dfAddressId: dfId,
          address: `${cnsNum} ${hitCity} Ave`, city: hitCity, state: "NC", zip: "28100",
          lat: 35.2, lng: -80.8, householdSegmentType: "NEW FIBER", isNewFiber: true,
          techType: "FTTP", speedTier: "1gig", maxDownloadMbps: 1000, billingStatus: "N",
          addressCatalogDate: "2026-06-01", competitorName: null, discoveredAt: new Date().toISOString(),
        },
      };
    }
    return { kind: "miss" };
  };
}

const poolCount = () => (rawDb.prepare("SELECT COUNT(*) c FROM scan_targets").get() as any).c;
const leadCount = (city: string) => (rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE lower(city)=lower(?)").get(city) as any).c;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cnsdisc-"));
  ({ storage } = await import("../../server/storage"));
  ({ rawDb } = await import("../../server/db"));
  const storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  disc = await import("../../server/cnsDiscovery");
  cns = await import("../../server/cns-scanner");
});
beforeEach(() => { rawDb.exec("DELETE FROM scan_targets; DELETE FROM leads; DELETE FROM cns_probes;"); });

describe("upsertScanTargets — Kinetic-native pool", () => {
  it("fails closed before a CNS provider request when automation is not authorized", async () => {
    const prior = process.env.KFS_AUTOMATION_AUTHORIZED;
    delete process.env.KFS_AUTOMATION_AUTHORIZED;
    try {
      await expect(cns.probeKineticDfId("MS0000001", "token-that-must-not-be-used"))
        .resolves.toEqual({ kind: "fail", reason: "unauthorized" });
    } finally {
      if (prior == null) delete process.env.KFS_AUTOMATION_AUTHORIZED;
      else process.env.KFS_AUTOMATION_AUTHORIZED = prior;
    }
  });

  it("persists df_address_id + provider coords + status on a fresh Kinetic discovery", () => {
    storage.upsertScanTargets([{ address: "1 A St", city: "Charlotte", state: "NC", zip: "28100", lat: 35, lng: -80, source: "kinetic-cns", dfAddressId: "MS0002000", scannedNow: true, fiberStatus: "new_fiber", isNewFiber: true, billingStatus: "N" }]);
    const r = rawDb.prepare("SELECT * FROM scan_targets WHERE address='1 A St'").get() as any;
    expect(r.df_address_id).toBe("MS0002000");
    expect(r.last_is_new_fiber).toBe(1);
    expect(r.last_scanned_at).not.toBeNull();
    expect(r.scan_count).toBe(1);
    expect(r.lat).toBe(35);
  });

  it("enriches an existing Mapbox-seeded row with a later Kinetic df id, without clobbering", () => {
    storage.upsertScanTargets([{ address: "2 B St", city: "Charlotte", state: "NC", zip: "", lat: null, lng: null, source: "mapbox" }]);
    storage.upsertScanTargets([{ address: "2 B St", city: "Charlotte", state: "NC", zip: "28100", lat: 35.1, lng: -80.1, source: "kinetic-cns", dfAddressId: "MS0002050" }]);
    const r = rawDb.prepare("SELECT * FROM scan_targets WHERE address='2 B St'").get() as any;
    expect(r.df_address_id).toBe("MS0002050"); // backfilled
    expect(r.lat).toBe(35.1);                   // backfilled
    expect(r.zip).toBe("28100");                // backfilled
    expect(r.source).toBe("mapbox");            // first writer wins on source
    expect(poolCount()).toBe(1);                // still ONE row (no duplicate)
  });
});

describe("planCityDiscovery + runCityDiscovery — zero Mapbox", () => {
  it("needsAnchor when the city has no CNS history", () => {
    const plan = disc.planCityDiscovery("Nowhere", "NC", 500);
    expect(plan.hasCoverage).toBe(false);
    expect(plan.needsAnchor).toBe(true);
    expect(plan.probeDfIds).toHaveLength(0);
  });

  it("targets the city's CNS frontier and pools every hit without promoting first-seen live baselines", async () => {
    // Band ends at 1999 → frontier starts at 2000, which is the mock's "live" range.
    seedCity("MS", "Charlotte", [1997, 1998, 1999]);
    const before = poolCount();
    const res = await disc.runCityDiscovery({
      city: "Charlotte", state: "NC", budget: 40, tenantId: TEN,
      probe: mockProbe("Charlotte"), getToken: async () => "tok", warmup: 9999,
    });
    expect(res.env).toBe("MS");
    expect(res.probed).toBeGreaterThan(0);
    expect(res.hits).toBeGreaterThan(0);          // frontier probes in 2000..2503 are hits
    expect(res.sameCityHits).toBe(res.hits);      // all hits are Charlotte
    expect(res.newFiber).toBe(res.hits);
    expect(poolCount()).toBeGreaterThan(before);  // pool grew from Kinetic, zero Mapbox
    expect(leadCount("Charlotte")).toBe(res.leadsCreated);
    expect(res.leadsCreated).toBe(0);              // no unavailable baseline / no independent evidence
    const snapshots = rawDb.prepare(`SELECT transition_status,fresh FROM availability_snapshots
      WHERE tenant_id=? AND transition_status='baseline_available'`).all(TEN) as any[];
    expect(snapshots.length).toBe(res.hits);
    expect(snapshots.every((row) => row.fresh === 0)).toBe(true);
  });

  it("a provider FAILURE is never recorded as a miss — no pool row, no lead, counted as failure", async () => {
    seedCity("MS", "Denver", [1000, 1001, 1002]);
    const plan = disc.planCityDiscovery("Denver", "NC", 20);
    const failAll = new Set(plan.probeDfIds);
    const res = await disc.runCityDiscovery({
      city: "Denver", state: "NC", budget: 20, tenantId: TEN,
      probe: mockProbe("Denver", failAll), getToken: async () => "tok", maxConsecFail: 999,
    });
    expect(res.failures).toBeGreaterThan(0);
    expect(res.hits).toBe(0);
    expect(res.leadsCreated).toBe(0);
    expect(poolCount()).toBe(3); // only the 3 seeded rows — no failures persisted
  });

  it("stops early when the same-city hit-rate collapses (walked out of locality)", async () => {
    seedCity("MS", "Huntersville", [1000, 1001, 1002]);
    // Mock that yields OTHER-city hits for the whole frontier → same-city rate ~0.
    const otherCity = async (dfId: string): Promise<import("../../server/cns-scanner").CnsProbe> => {
      const m = /^([A-Za-z]+)(\d+)$/.exec(dfId)!; const c = parseInt(m[2], 10);
      return { kind: "hit", result: { env: m[1], cns: c, dfAddressId: dfId, address: `${c} Other St`, city: "Concord", state: "NC", zip: "28025", lat: 35.4, lng: -80.6, householdSegmentType: "EXISTING FIBER", isNewFiber: false, techType: null, speedTier: null, maxDownloadMbps: null, billingStatus: "Y", addressCatalogDate: null, competitorName: null, discoveredAt: new Date().toISOString() } };
    };
    const res = await disc.runCityDiscovery({
      city: "Huntersville", state: "NC", budget: 2000, tenantId: TEN,
      probe: otherCity, getToken: async () => "tok",
      warmup: 5, window: 10, minSameCityRate: 0.5,
    });
    expect(res.stoppedEarly).toBe(true);
    expect(res.probed).toBeLessThan(2000);          // did NOT burn the whole budget
    expect(res.sameCityHits).toBe(0);
    expect(poolCount()).toBeGreaterThan(3);          // other-city hits still grew the pool (free)
  });

  it("budget hard-caps the number of probes", async () => {
    seedCity("MS", "Matthews", [1000, 1001, 1002]);
    const res = await disc.runCityDiscovery({
      city: "Matthews", state: "NC", budget: 12,
      probe: mockProbe("Matthews"), getToken: async () => "tok", warmup: 9999,
    });
    expect(res.probed).toBeLessThanOrEqual(12);
  });

  it("negative cache: a second run WALKS PAST the misses of the first (no re-buying)", async () => {
    seedCity("MS", "Belmont", [1000, 1001, 1002]); // frontier 1003.. all miss (mock lights up >=2000)
    const r1 = await disc.runCityDiscovery({ city: "Belmont", state: "NC", budget: 20, probe: mockProbe("Belmont"), getToken: async () => "tok", warmup: 9999 });
    const firstProbes = new Set<number>();
    (rawDb.prepare("SELECT cns FROM cns_probes WHERE env='MS'").all() as any[]).forEach(x => firstProbes.add(x.cns));
    expect(firstProbes.size).toBe(r1.probed); // every conclusive probe recorded
    // Second run must NOT re-propose the same missed control numbers.
    const plan2 = disc.planCityDiscovery("Belmont", "NC", 20);
    const parse = (df: string) => parseInt(df.slice(2), 10);
    expect(plan2.probeDfIds.every(df => !firstProbes.has(parse(df)))).toBe(true);
  });

  it("same-city check is STATE-aware — a same-name city in another state doesn't suppress the stop", async () => {
    seedCity("MS", "Charlotte", [1000, 1001, 1002]);
    // Mock returns Charlotte, MICHIGAN hits for the whole frontier (same env MS).
    const charlotteMI = async (dfId: string): Promise<import("../../server/cns-scanner").CnsProbe> => {
      const m = /^([A-Za-z]+)(\d+)$/.exec(dfId)!; const c = parseInt(m[2], 10);
      return { kind: "hit", result: { env: m[1], cns: c, dfAddressId: dfId, address: `${c} Charlotte St`, city: "Charlotte", state: "MI", zip: "48813", lat: 42.5, lng: -84.8, householdSegmentType: "NEW FIBER", isNewFiber: true, techType: null, speedTier: null, maxDownloadMbps: null, billingStatus: "N", addressCatalogDate: null, competitorName: null, discoveredAt: new Date().toISOString() } };
    };
    const res = await disc.runCityDiscovery({
      city: "Charlotte", state: "NC", budget: 2000, probe: charlotteMI, getToken: async () => "tok",
      warmup: 5, window: 10,
    });
    expect(res.stoppedEarly).toBe(true);      // MI hits do NOT count as same-city → stop fires
    expect(res.sameCityHits).toBe(0);
    expect(res.probed).toBeLessThan(2000);
  });
});
