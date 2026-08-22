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

describe("run-kind exemption - the hinge the whole design hangs on", () => {
  // The coming lane may re-buy an answered door; a bulk flood may not. Both
  // facts come from ONE predicate, and nothing asserted it before.
  it("exempts the lanes that must re-verify and no others", async () => {
    const { isRecheckExemptKind } = await import("../../shared/scanPolicy");
    const sweep = await import("../../server/neighborhoodSweep");
    expect(isRecheckExemptKind(sweep.SWEEP_RUN_KIND.coming), "coming lane collects on promises").toBe(true);
    expect(isRecheckExemptKind(sweep.SWEEP_RUN_KIND.confirm), "confirm re-buys known greens").toBe(true);
    expect(isRecheckExemptKind(sweep.SWEEP_RUN_KIND.floodRecheck), "opt-in negative rescan").toBe(true);
    expect(isRecheckExemptKind(sweep.SWEEP_RUN_KIND.flood), "a bulk flood is bound by once-only").toBe(false);
    expect(isRecheckExemptKind(sweep.SWEEP_RUN_KIND.street)).toBe(false);
    expect(isRecheckExemptKind(sweep.SWEEP_RUN_KIND.probe)).toBe(false);
    // A rep's own action always re-verifies.
    for (const k of ["manual", "target_ids", "lasso_ring", "field_tap", "area_box"]) {
      expect(isRecheckExemptKind(k), k).toBe(true);
    }
    expect(isRecheckExemptKind("market")).toBe(false);
    expect(isRecheckExemptKind(undefined)).toBe(false);
  });

  it("once-only no longer depends on an unrelated tuning knob", async () => {
    const store = await import("../../server/scanIntelStore");
    const t = target(1040, "1600 Knob Rd", "Broadway");
    rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=datetime('now','-30 days'), scan_count=1,
      last_fiber_status='no_service', last_fiber_available=0 WHERE id=1040`).run();
    // SCAN_DEDUP_RECHECK_HOURS=0 used to disable the law for every producer,
    // because exemption was inferred from "the dedup window is zero".
    store.createScanRun({ id: "run_knob", tenantId: TENANT, kind: "market", label: "bulk", city: "Broadway", state: "NC", budget: 1 });
    store.enqueueRunTargets("run_knob", [{ id: 1040, seq: 0 }]);
    expect(store.claimRunTargets("run_knob", 5, 0, "market")).toEqual([]);
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

  it("writes off a promise the provider keeps restating after its date passed", () => {
    // Otherwise the one lane allowed to re-buy an answered door spins on it
    // every few hours forever - the exception eating the law it is exception to.
    const t = target(1050, "1700 Never Lands Way");
    const past = { ...frontier({ futureServiceDate: "2026-08-01" }) };
    let at = NOW;
    for (let i = 0; i < 5; i++) { ledger.recordFutureService(TENANT, t, {}, past, { nowMs: at }); at += 6 * 3_600_000; }
    const w = watchOf(1050);
    expect(w.status).toBe("overdue");
    expect(w.due_at).toBeNull();
    expect(ledger.dueComingTargets(TENANT, "NC", 50, at).map((d) => d.targetId)).not.toContain(1050);
  });

  it("a promise still inside its date is never written off, however often it is re-read", () => {
    const t = target(1051, "1800 Still Coming Rd");
    let at = NOW;
    for (let i = 0; i < 8; i++) { ledger.recordFutureService(TENANT, t, {}, frontier({ futureServiceDate: "2027-03-01" }), { nowMs: at }); at += 6 * 3_600_000; }
    expect(watchOf(1051)).toMatchObject({ status: "active", promised_date: "2027-03-01" });
  });

  it("expiry is measured against the promise, not the last touch", () => {
    // The old predicate keyed on updated_at, which the ledger re-stamps on every
    // collection - so an actively re-checked row could never expire, and a
    // far-future promise deliberately left untouched expired far too early.
    const fresh = target(1052, "1900 Future Promise Ln");
    ledger.recordFutureService(TENANT, fresh, {}, frontier({ futureServiceDate: "2027-03-01" }), { nowMs: NOW - 200 * DAY });
    const cold = target(1053, "2000 Long Gone Rd");
    ledger.recordFutureService(TENANT, cold, {}, frontier(), { nowMs: NOW - 200 * DAY }); // undated, first seen long ago
    ledger.expireStaleWatches(TENANT, NOW);
    expect(watchOf(1052).status, "a 2027 build is not stale in 2026").toBe("active");
    expect(watchOf(1053).status, "an undated promise first seen 200 days ago is").toBe("expired");
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

describe("mining promises out of evidence already paid for", () => {
  // 22,242 bodies were already on disk when this shipped; 1,327 of them carried
  // a promise nobody had read. The backfill is how the ledger starts full.
  const insertCheck = (address: string, raw: unknown, checkedAt: string) =>
    rawDb.prepare(`INSERT INTO fiber_checks (tenant_id, address, result, checked_at, api_source)
      VALUES (?,?,?,?,?)`).run(TENANT, address, JSON.stringify(raw), checkedAt, "kinetic");

  it("matches on the echoed address line, stamps the ORIGINAL check date, and takes the newest body", () => {
    target(1200, "1155 Bell Ridge Ct", "Rockwell");
    // fiber_checks.address is the full formatted string; scan_targets.address is
    // the street line alone. Matching those directly finds nothing.
    const body = (dt: string) => ({
      success: true, address: { addressLine1: "1155 BELL RIDGE CT", city: "ROCKWELL", stateProvinceCd: "NC",
        householdSegmentType: "COPPER", billingStatus: "N" },
      broadbandService: { futureQual: "FutureQual", futureTechnologyType: "FIBER", estimatedCompletionDt: dt },
    });
    insertCheck("1155 Bell Ridge Ct, Rockwell, NC 28138", body("SEP-2026"), "2026-07-04 09:00:00");
    insertCheck("1155 Bell Ridge Ct, Rockwell, NC 28138", body("NOV-2026"), "2026-07-30 09:00:00");

    const out = ledger.backfillFromStoredEvidence(TENANT, 500, NOW);
    expect(out.recorded).toBeGreaterThanOrEqual(1);
    expect(out.dated).toBeGreaterThanOrEqual(1);
    const w = watchOf(1200);
    expect(w.promised_date, "the newest body wins").toBe("2026-11-01");
    expect(w.provider_quote).toContain("NOV-2026");
    // Found-on is when the scan actually happened, NOT now: a July answer must
    // not look like today's discovery, or the flip window mis-measures it.
    expect(new Date(Number(w.first_seen_at)).toISOString().slice(0, 10)).toBe("2026-07-30");
  });

  it("falls back to the provider's corrected city, and skips doors we do not hold", () => {
    target(1201, "204 Sample St", "China Grove");
    insertCheck("204 Sample St, Rockwell, NC 28138", {
      address: { addressLine1: "204 SAMPLE ST", city: "CHINA GROVE", stateProvinceCd: "NC" },
      broadbandService: { futureQual: "FutureQual", estimatedCompletionDt: "DEC-2026" },
    }, "2026-08-01 09:00:00");
    insertCheck("999 Nobody Holds This Rd, Raleigh, NC 27601", {
      address: { addressLine1: "999 NOBODY HOLDS THIS RD", city: "RALEIGH", stateProvinceCd: "NC" },
      broadbandService: { futureQual: "FutureQual", estimatedCompletionDt: "DEC-2026" },
    }, "2026-08-01 09:00:00");
    const before = rawDb.prepare(`SELECT COUNT(*) AS n FROM coming_soon_watchlist`).get() as any;
    const out = ledger.backfillFromStoredEvidence(TENANT, 500, NOW);
    expect(watchOf(1201)?.promised_date).toBe("2026-12-01");
    // The unheld door produced no row and was not even counted as scanned.
    expect(out.scanned).toBeLessThan(
      (rawDb.prepare(`SELECT COUNT(*) AS n FROM fiber_checks`).get() as any).n + Number(before.n),
    );
    expect(rawDb.prepare(`SELECT COUNT(*) AS n FROM coming_soon_watchlist w
      JOIN scan_targets s ON s.id=w.scan_target_id WHERE s.address LIKE '999 %'`).get()).toMatchObject({ n: 0 });
  });

  it("is bounded by its limit and safe to run twice", () => {
    const first = ledger.backfillFromStoredEvidence(TENANT, 1, NOW);
    expect(first.scanned).toBeLessThanOrEqual(1);
    const n = () => (rawDb.prepare(`SELECT COUNT(*) AS n FROM coming_soon_watchlist`).get() as any).n;
    const before = n();
    ledger.backfillFromStoredEvidence(TENANT, 500, NOW);
    expect(n(), "re-running mints no duplicate watches").toBe(before);
  });
});

describe("the account pin - a door that is already a customer", () => {
  let account: typeof import("../../server/customerAccount");
  beforeAll(async () => { account = await import("../../server/customerAccount"); account.ensureAccountSchema(); });

  const tenured = {
    address: { householdSegmentType: "TENURED", billingStatus: "A", billingSystem: "CAMS",
      localAccountNumber: "000000123", accountTier: "Tier 10", accountSubTier: "Tier 10" },
  };

  it("pins the account to the door and hands the UI a tier and a masked tail only", () => {
    const t = target(1300, "300 Tenured Ln");
    account.recordAccount(TENANT, t.id, tenured);
    const pin = account.accountPinForTarget(TENANT, t.id);
    expect(pin).toMatchObject({ tier: "Tier 10", billingSystem: "CAMS", masked: "..0123" });
    // The whole number never leaves the server.
    expect(JSON.stringify(pin)).not.toContain("000000123");
    // ...but it is on the row, so a rep can be told which account to reference.
    expect(rawDb.prepare(`SELECT account_number FROM scan_targets WHERE id=?`).get(t.id))
      .toMatchObject({ account_number: "000000123" });
  });

  it("reports nothing for a door with no account, and never invents one", () => {
    const t = target(1301, "301 Prospect Way");
    account.recordAccount(TENANT, t.id, { address: { householdSegmentType: "NEW FIBER", billingStatus: "N" } });
    expect(account.accountPinForTarget(TENANT, t.id)).toBeNull();
    expect(account.accountPinForTarget(TENANT, 999_999)).toBeNull();
  });

  it("follows a lead back to its scan target", () => {
    const t = target(1302, "302 Sold Already Rd");
    account.recordAccount(TENANT, t.id, tenured);
    expect(account.accountPinForLead(TENANT, { id: 77, sourceScanTargetId: t.id })).toMatchObject({ masked: "..0123" });
    expect(account.accountPinForLead(TENANT, { id: 78, sourceScanTargetId: null })).toBeNull();
  });
});
