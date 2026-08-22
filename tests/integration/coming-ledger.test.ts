import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE COMING LEDGER — the one door the once-only law leaves open.
 *
 * An address the provider itself says will be serviceable later is recorded
 * with the date it stated, and re-bought exactly once when that date comes due.
 * Everything else, answered once, is never bought again.
 *
 * The payload shapes here are real, taken from the bodies this install has
 * stored (fiber_checks.result, 22,242 rows). BOTH carriers state future service:
 * Frontier ships fiberBuildOutStatus / futureServiceDate / isFutureFiberEligible,
 * and Kinetic ships broadbandService.{futureQual, futureTechnologyType,
 * estimatedCompletionDt} with values like "NOV-2026".
 */

let rawDb: import("better-sqlite3").Database;
let ledger: typeof import("../../server/comingLedger");

const TENANT = 1;
const NOW = Date.parse("2026-08-22T12:00:00.000Z");
const DAY = 86_400_000;

const frontier = (over: Record<string, unknown> = {}) => ({
  success: true, matchType: "EXACT", techAvailable: "FIBER", offerType: "CHALLENGER1",
  addressHasExistingService: false, fiberModernization: true, fiberBuildOutStatus: "PENDING",
  isFutureFiberEligible: true, plantType: "OVERLAY", hasPendingOrder: false, ...over,
});
const kineticNewFiber = {
  success: true, validationResult: "AddressFound", exactMatch: true, techType: "FIBER",
  address: { householdSegmentType: "NEW FIBER", billingStatus: "N", addressCatalogDt: "2019-03-11" },
};

function target(id: number, address: string, city = "Durham"): { id: number; address: string; city: string; state: string; zip: string } {
  rawDb.prepare(`INSERT INTO scan_targets (id, tenant_id, address, city, state, zip, lat, lng, source, carrier)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, TENANT, address, city, "NC", "27701", 35.99, -78.9, "test", "frontier");
  return { id, address, city, state: "NC", zip: "27701" };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-coming-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  // The watchlist table is created by the snapshot choke point; make sure it exists.
  const { ensureAvailabilitySnapshotSchema } = await import("../../server/availabilitySnapshot").catch(() => ({} as any));
  if (typeof ensureAvailabilitySnapshotSchema === "function") ensureAvailabilitySnapshotSchema();
  if (!rawDb.prepare(`SELECT name FROM sqlite_master WHERE name='coming_soon_watchlist'`).get()) {
    rawDb.exec(`CREATE TABLE coming_soon_watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, scan_target_id INTEGER NOT NULL UNIQUE,
      address_key TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_checked_at INTEGER,
      estimated_completion TEXT, source TEXT, confidence TEXT, cluster_id TEXT,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  }
  ledger = await import("../../server/comingLedger");
  ledger.ensureComingLedgerSchema();
});

const watchOf = (id: number): any => rawDb.prepare(`SELECT * FROM coming_soon_watchlist WHERE scan_target_id=?`).get(id);

describe("recording a provider promise", () => {
  it("saves the address AND the date the provider stated, with its provenance", () => {
    const t = target(1001, "100 Pending Way");
    const read = ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-09-18" }), { nowMs: NOW });
    expect(read.isFuture).toBe(true);
    expect(read.promisedDate).toBe("2026-09-18");

    const w = watchOf(1001);
    expect(w).toMatchObject({
      status: "active", promised_date: "2026-09-18", estimated_completion: "2026-09-18",
      date_source: "provider", date_path: "futureServiceDate", confidence: "dated", band: "soon",
    });
    expect(JSON.parse(w.signals)).toEqual(expect.arrayContaining(["build_pending", "provider_date", "provider_future_eligible"]));
    // A far promise waits for its window instead of being polled: due 14 days before.
    expect(w.due_at).toBe(Date.parse("2026-09-18T00:00:00Z") - 14 * DAY);
  });

  it("a pending build with no date is still recorded, scheduled by the flip window", () => {
    const t = target(1002, "200 Undated Rd");
    const read = ledger.recordFutureService(TENANT, t, {}, frontier(), { nowMs: NOW });
    expect(read.isFuture).toBe(true);
    expect(read.promisedDate).toBeNull();
    expect(watchOf(1002)).toMatchObject({ status: "active", promised_date: null, confidence: "high", band: "watch" });
  });

  it("a date already passed is hot: they said it would be on by now", () => {
    const t = target(1003, "300 Overdue Ln");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-08-14" }), { nowMs: NOW });
    const w = watchOf(1003);
    expect(w.band).toBe("hot");
    expect(w.due_at).toBe(NOW + 6 * 3_600_000);
  });

  it("a settled answer closes the promise instead of leaving it to be re-bought", () => {
    const t = target(1004, "400 Settled St");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-08-26" }), { nowMs: NOW });
    expect(watchOf(1004).status).toBe("active");
    // Next answer: the build landed and fiber is live.
    ledger.recordFutureService(TENANT, t, {}, { ...frontier({ fiberBuildOutStatus: "", isFutureFiberEligible: false }) },
      { fiberAvailable: true, nowMs: NOW + DAY });
    expect(watchOf(1004)).toMatchObject({ status: "promoted", due_at: null });
  });

  it("a door somebody already bought is closed as now_active, not watched", () => {
    const t = target(1005, "500 Sold Ave");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-08-26" }), { nowMs: NOW });
    ledger.recordFutureService(TENANT, t, { householdSegmentType: "NEW FIBER", billingStatus: "A" }, kineticNewFiber, { nowMs: NOW + DAY });
    expect(watchOf(1005).status).toBe("now_active");
  });

  it("a Kinetic answer with no future block opens no promise", () => {
    const t = target(1006, "600 Kinetic Ct", "Rockwell");
    const read = ledger.recordFutureService(TENANT, t, { householdSegmentType: "NEW FIBER", billingStatus: "N" }, kineticNewFiber, { nowMs: NOW });
    expect(read.isFuture).toBe(false);
    expect(read.promisedDate).toBeNull();
    expect(watchOf(1006)).toBeUndefined();
  });

  it("never overwrites a stated date with a later vaguer answer", () => {
    const t = target(1007, "700 Keep Date Dr");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-12-31" }), { nowMs: NOW });
    ledger.recordFutureService(TENANT, t, {}, frontier(), { nowMs: NOW + DAY }); // still pending, no date
    expect(watchOf(1007)).toMatchObject({ promised_date: "2026-12-31", date_source: "provider" });
  });
});

describe("collecting on promises", () => {
  it("only returns promises that have come due, overdue dates first", () => {
    const due = ledger.dueComingTargets(TENANT, "NC", 50, NOW + 60 * DAY);
    const ids = due.map((d) => d.targetId);
    // 1003 (date passed) and 1002 (undated, window elapsed) and 1001 (Sept date, now due) are in.
    expect(ids).toContain(1003);
    expect(ids).toContain(1001);
    // Closed and never-opened rows are not.
    expect(ids).not.toContain(1004);
    expect(ids).not.toContain(1005);
    expect(ids).not.toContain(1006);
    // The overdue date sorts ahead of the undated watch.
    expect(ids.indexOf(1003)).toBeLessThan(ids.indexOf(1002));
  });

  it("nothing is due before its window opens", () => {
    const t = target(1008, "800 Far Future Blvd");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2027-06-01" }), { nowMs: NOW });
    expect(ledger.dueComingTargets(TENANT, "NC", 50, NOW).map((d) => d.targetId)).not.toContain(1008);
  });

  it("marking a collection pushes the next due date out, so one promise is never bought twice in a cycle", () => {
    ledger.markComingChecked(TENANT, [1003], NOW);
    expect(watchOf(1003).due_at).toBe(NOW + 6 * 3_600_000);
    expect(ledger.dueComingTargets(TENANT, "NC", 50, NOW).map((d) => d.targetId)).not.toContain(1003);
  });

  it("a target already queued in a running run is not collected again", () => {
    const store = rawDb;
    store.prepare(`INSERT INTO scan_runs (id, tenant_id, kind, label, city, state, budget, status, heartbeat_at)
      VALUES ('run_hold', ?, 'market', 'holding', 'Durham', 'NC', 1, 'running', datetime('now'))`).run(TENANT);
    store.prepare(`INSERT INTO scan_run_targets (run_id, target_id, seq, state) VALUES ('run_hold', 1002, 0, 'queued')`).run();
    expect(ledger.dueComingTargets(TENANT, "NC", 50, NOW + 60 * DAY).map((d) => d.targetId)).not.toContain(1002);
  });
});

describe("the once-only law and the ledger together", () => {
  // THE critical interaction. Measured on the production-shaped copy: all 931
  // NC doors that Kinetic gave a future-build date are ALREADY recorded as
  // conclusive terminal negatives (675 copper, 256 no_service). A once-only law
  // keyed on `last_scanned_at IS NOT NULL` blacklists every one of them unless
  // the coming lane is exempt. It is - by run kind - and this proves it.
  it("collects a promise on a door that is already a terminal negative", async () => {
    const store = await import("../../server/scanIntelStore");
    const t = target(1020, "1100 Copper Now Fiber Later Rd", "Broadway");
    // The real shape: answered, conclusive, copper - and a future fiber build.
    rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=datetime('now','-30 days'), scan_count=1,
      last_fiber_status='copper', last_fiber_available=0, carrier='kinetic' WHERE id=1020`).run();
    ledger.recordFutureService(TENANT, t, { householdSegmentType: "DSL", billingStatus: "N" }, {
      address: { householdSegmentType: "DSL", billingStatus: "N", city: "BROADWAY" },
      broadbandService: { futureQual: "FutureQual", technologyType: "FUTURE_QUAL_EXTENDED",
        futureTechnologyType: "FIBER", estimatedCompletionDt: "NOV-2026" },
    }, { nowMs: NOW });
    expect(watchOf(1020)).toMatchObject({ promised_date: "2026-11-01", status: "active" });

    // Due once its window opens.
    const due = ledger.dueComingTargets(TENANT, "NC", 10, Date.parse("2026-11-01T00:00:00Z"));
    expect(due.map((d) => d.targetId)).toContain(1020);

    // A BULK run may not buy it - it is answered.
    store.createScanRun({ id: "run_bulk_neg", tenantId: TENANT, kind: "market", label: "bulk", city: "Broadway", state: "NC", budget: 1 });
    store.enqueueRunTargets("run_bulk_neg", [{ id: 1020, seq: 0 }]);
    expect(store.claimRunTargets("run_bulk_neg", 5, 18 * 3600)).toEqual([]);

    // The COMING lane may: its kind contains "watch", so dedupSkipSecondsForRun
    // returns 0 and the once-only guard is not applied to it.
    store.createScanRun({ id: "run_coming_neg", tenantId: TENANT, kind: "fresh_sweep_coming_soon_watch", label: "coming", city: "Broadway", state: "NC", budget: 1 });
    store.enqueueRunTargets("run_coming_neg", [{ id: 1020, seq: 0 }]);
    expect(store.claimRunTargets("run_coming_neg", 5, 0).map((c: any) => c.targetId)).toEqual([1020]);
  });
});

describe("correcting the old inference", () => {
  it("closes watches whose target is really a door somebody already bought", () => {
    // The shape that produced 294 of 330 live watches: NEW FIBER + active billing,
    // inferred as "coming soon" by availabilitySnapshot.ts.
    const t = target(1010, "900 Mislabelled Way");
    rawDb.prepare(`UPDATE scan_targets SET last_is_new_fiber=1, last_billing_status='Y' WHERE id=1010`).run();
    rawDb.prepare(`INSERT INTO coming_soon_watchlist (tenant_id, scan_target_id, address_key, first_seen_at, last_checked_at,
      source, confidence, status, created_at, updated_at) VALUES (?,?,?,?,?,'scan','medium','active',?,?)`)
      .run(TENANT, t.id, "900 mislabelled way|durham|NC", NOW, NOW, NOW, NOW);
    expect(watchOf(1010).status).toBe("active");

    expect(ledger.reconcileNowActiveWatches(TENANT, NOW)).toBe(1);
    expect(watchOf(1010)).toMatchObject({ status: "now_active", due_at: null });
    // Idempotent.
    expect(ledger.reconcileNowActiveWatches(TENANT, NOW)).toBe(0);
  });

  it("never closes a Frontier build as now_active: frontierScanner encodes a future build as NEW FIBER + billing Y", () => {
    const t = target(1012, "1200 Frontier Build Way");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-12-31" }), { nowMs: NOW });
    // The exact shape frontierScanner writes for a pending build.
    rawDb.prepare(`UPDATE scan_targets SET last_is_new_fiber=1, last_billing_status='Y' WHERE id=1012`).run();
    ledger.reconcileNowActiveWatches(TENANT, NOW);
    expect(watchOf(1012)).toMatchObject({ status: "active", promised_date: "2026-12-31" });
  });

  it("never expires a dated promise before its own date arrives", () => {
    const t = target(1013, "1300 Far Promise Ln");
    // Recorded long ago, parked until 14 days before a 2027 build: untouched for
    // months by design. A staleness rule keyed on updated_at would kill it.
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2027-03-01" }), { nowMs: NOW - 200 * DAY });
    expect(ledger.expireStaleWatches(TENANT, NOW)).toBeGreaterThanOrEqual(0);
    expect(watchOf(1013).status).toBe("active");
  });

  it("expires promises nobody honoured, visibly rather than by deletion", () => {
    const t = target(1011, "1000 Cold Rd");
    ledger.recordFutureService(TENANT, t, {}, frontier(), { nowMs: NOW - 200 * DAY });
    expect(ledger.expireStaleWatches(TENANT, NOW)).toBeGreaterThan(0);
    expect(watchOf(1011).status).toBe("expired");
  });

  it("records WHEN we found the promise, not when the row was written", () => {
    const t = target(1030, "1500 Found In July Rd");
    const july = Date.parse("2026-07-18T09:00:00.000Z");
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-11-01" }),
      { nowMs: NOW, observedAt: july });
    const w = watchOf(1030);
    expect(w.first_seen_at).toBe(july);   // when the provider said it
    expect(w.last_checked_at).toBe(july); // the answer we replayed, not "now"
    expect(w.promised_date).toBe("2026-11-01"); // when it turns on
    // Re-observing later never moves the discovery date backwards or forwards.
    ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2026-11-01" }),
      { nowMs: NOW, observedAt: NOW });
    expect(watchOf(1030).first_seen_at).toBe(july);
    expect(watchOf(1030).last_checked_at).toBe(NOW);
  });

  it("summarises found-on days beside promised months", () => {
    const s = ledger.comingSummary(TENANT, "NC", NOW);
    expect(s.foundOn.length).toBeGreaterThan(0);
    expect(s.foundOn[0]).toHaveProperty("day");
    expect(s.foundOn.some((f) => f.day === "2026-07-18")).toBe(true);
    expect(s.oldestFoundAt).toBeLessThanOrEqual(s.newestFoundAt!);
  });

  it("summarises the ledger for the operator", () => {
    const s = ledger.comingSummary(TENANT, "NC", NOW);
    expect(s.active).toBeGreaterThan(0);
    expect(s.dated).toBeGreaterThan(0);
    expect(s.byStatus.now_active).toBeGreaterThanOrEqual(1);
    expect(s.byStatus.promoted).toBeGreaterThanOrEqual(1);
    expect(s.nextDates.length).toBeGreaterThan(0);
    expect(s.nextDates[0].date <= s.nextDates[s.nextDates.length - 1].date).toBe(true);
  });
});
