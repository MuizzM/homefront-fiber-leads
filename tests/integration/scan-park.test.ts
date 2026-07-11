import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Per-address inconclusive circuit breaker (shared/scanPolicy.ts). A Mapbox-grid
 * over-capture that Kinetic doesn't recognize returns INCONCLUSIVE forever; left
 * un-parked it stays never-scanned and gets re-probed on every nightly + manual
 * sweep, burning proxy $ for zero leads. After INCONCLUSIVE_GIVEUP such probes the
 * row must drop OUT of the re-probe rotation — while staying distinguishable from a
 * real Kinetic answer and re-openable on demand. This proves that end to end with
 * ZERO proxy bandwidth.
 */

let rawDb: import("better-sqlite3").Database;
let storageMod: typeof import("../../server/storage");
let sources: typeof import("../../server/scanSources");
let GIVEUP: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-scan-park-"));
  ({ rawDb } = await import("../../server/db"));
  storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  sources = await import("../../server/scanSources");
  ({ INCONCLUSIVE_GIVEUP: GIVEUP } = await import("../../shared/scanPolicy"));
});

const seedTarget = (address: string, city = "Parkville") =>
  rawDb.prepare(`INSERT INTO scan_targets (address, city, state, zip, lat, lng, source) VALUES (?,?, 'NC','28300', 35.5, -80.4, 'test')`).run(address, city);

const attemptsFor = (address: string): number =>
  (rawDb.prepare(`SELECT inconclusive_attempts a FROM scan_targets WHERE address=?`).get(address) as any).a;

describe("inconclusive circuit breaker", () => {
  it("parks a row out of both re-probe selectors after GIVEUP inconclusive probes", () => {
    const { storage } = storageMod;
    seedTarget("1 Ghost Rd");

    // Below threshold: still queued in both selectors.
    for (let i = 1; i < GIVEUP; i++) storage.bumpScanTargetInconclusive({ address: "1 Ghost Rd" });
    expect(attemptsFor("1 Ghost Rd")).toBe(GIVEUP - 1);
    expect(sources.loadCityPoolAddresses("Parkville", undefined, 100).some(a => a.address === "1 Ghost Rd")).toBe(true);
    expect(storage.getScanTargetsToRescan(1000).some((r: any) => r.address === "1 Ghost Rd")).toBe(true);

    // Crossing the threshold parks it — gone from manual pool AND nightly rescan.
    storage.bumpScanTargetInconclusive({ address: "1 Ghost Rd" });
    expect(attemptsFor("1 Ghost Rd")).toBe(GIVEUP);
    expect(sources.loadCityPoolAddresses("Parkville", undefined, 100).some(a => a.address === "1 Ghost Rd")).toBe(false);
    expect(storage.getScanTargetsToRescan(1000).some((r: any) => r.address === "1 Ghost Rd")).toBe(false);

    // Still distinguishable from a real answer: never conclusively scanned.
    const row: any = rawDb.prepare(`SELECT last_scanned_at, last_inconclusive_at FROM scan_targets WHERE address='1 Ghost Rd'`).get();
    expect(row.last_scanned_at).toBeNull();
    expect(row.last_inconclusive_at).not.toBeNull();

    // And it's counted honestly, not silently dropped.
    expect(storage.getScanTargetExhaustedCount("Parkville")).toBe(1);
  });

  it("re-opens a parked row only when explicitly asked (--retryexhausted)", () => {
    // 1 Ghost Rd from the prior test is parked. Default excludes it; override includes.
    expect(sources.loadCityPoolAddresses("Parkville", undefined, 100, false).some(a => a.address === "1 Ghost Rd")).toBe(false);
    expect(sources.loadCityPoolAddresses("Parkville", undefined, 100, true).some(a => a.address === "1 Ghost Rd")).toBe(true);
  });

  it("a conclusive answer clears the streak and leaves the never-scanned pool", () => {
    const { storage } = storageMod;
    seedTarget("2 Maybe Ln");
    const id = (rawDb.prepare(`SELECT id FROM scan_targets WHERE address='2 Maybe Ln'`).get() as any).id;
    storage.bumpScanTargetInconclusive({ id });
    storage.bumpScanTargetInconclusive({ id });
    expect(attemptsFor("2 Maybe Ln")).toBe(2);

    // Kinetic finally answers → counter resets, row is now scanned.
    storage.recordScanTargetResult(id, { fiberStatus: "no_service", isNewFiber: false, billingStatus: null, availabilityStatus: "checked_unavailable" });
    expect(attemptsFor("2 Maybe Ln")).toBe(0);
    const row: any = rawDb.prepare(`SELECT last_scanned_at FROM scan_targets WHERE id=?`).get(id);
    expect(row.last_scanned_at).not.toBeNull();
    expect(sources.loadCityPoolAddresses("Parkville", undefined, 100, true).some(a => a.address === "2 Maybe Ln")).toBe(false);
  });

  it("never parks an already-scanned row (the nightly moat keeps re-checking it)", () => {
    const { storage } = storageMod;
    rawDb.prepare(`INSERT INTO scan_targets (address, city, state, zip, lat, lng, source, last_scanned_at, last_availability_status, scan_count)
                   VALUES ('3 Live Blvd','Parkville','NC','28300',35.5,-80.4,'test',datetime('now','-10 days'),'checked_unavailable',1)`).run();
    // Bumps are a no-op on a conclusively-scanned row (guarded by last_scanned_at IS NULL).
    for (let i = 0; i < GIVEUP + 2; i++) storage.bumpScanTargetInconclusive({ address: "3 Live Blvd" });
    expect(attemptsFor("3 Live Blvd")).toBe(0);
    expect(storage.getScanTargetsToRescan(1000).some((r: any) => r.address === "3 Live Blvd")).toBe(true);
  });

  it("ManualCitySource counts an inconclusive outcome toward parking (end to end)", async () => {
    const { storage } = storageMod;
    seedTarget("4 Fade Ct");
    const src = new sources.ManualCitySource("t", [{ address: "4 Fade Ct", city: "Parkville", state: "NC", zip: "28300" }], 1, "test");
    const task = { key: { kind: "addr" as const, address: "4 Fade Ct", city: "Parkville", state: "NC", zip: "28300" } };
    src.onResult(task, { kind: "inconclusive", reason: "AddressNeedsFix", latencyMs: 10 });
    expect(attemptsFor("4 Fade Ct")).toBe(1);
    expect(src.counters.inconclusive).toBe(1);
  });

  it("bump is a no-op for an address that isn't pooled (unpersisted fringe candidate)", () => {
    const { storage } = storageMod;
    // Must not throw and must not create a row.
    storage.bumpScanTargetInconclusive({ address: "999 Nowhere Unpooled St" });
    expect(rawDb.prepare(`SELECT COUNT(*) c FROM scan_targets WHERE address='999 Nowhere Unpooled St'`).get()).toEqual({ c: 0 });
  });
});
