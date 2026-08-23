import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MP BOX INCREMENTAL SCAN.
 *
 * The claim under test is the one the whole feature rests on: a repeated scan
 * of an unchanged area returns the SAME answers while classifying far fewer
 * records. Everything else here defends a way that could go wrong - a resumed
 * run double-counting, a transport failure poisoning the cache, a classifier
 * bump being ignored, a cosmetic edit invalidating everything.
 *
 * Tenured and Fresh Fiber are the project's own definitions, not invented here:
 *   TENURED      last_fiber_status='tenured_fiber' (shared/buyerScore.ts:159)
 *   FRESH FIBER  NEW FIBER + billing N + fiber available
 *                (server/freshFiberProjector.ts:299)
 */
let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/mpboxScanStore");
let engine: typeof import("../../server/mpboxScanEngine");

const TENANT = 1;
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-mpbox-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  store = await import("../../server/mpboxScanStore");
  engine = await import("../../server/mpboxScanEngine");
  store.ensureMpboxSchema();
});

let seq = 0;
function target(o: { status?: string | null; newFiber?: number; billing?: string | null; avail?: number } = {}): number {
  const id = ++seq + 500_000;
  rawDb.prepare(
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,
       last_fiber_status,last_is_new_fiber,last_billing_status,last_fiber_available)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, `${id} Box Rd`, "Rockwell", "NC", "28138", 35.55, -80.42, "test",
    o.status ?? null, o.newFiber ?? 0, o.billing ?? null, o.avail ?? 0);
  return id;
}
const rec = (id: number): import("../../server/mpboxScanEngine").MpboxRecord => {
  const r = rawDb.prepare(
    `SELECT id,address,city,state,zip,last_fiber_status,last_is_new_fiber,
            last_billing_status,last_customer_segment,last_fiber_available
       FROM scan_targets WHERE id=?`).get(id) as any;
  return {
    targetId: r.id, address: r.address, city: r.city, state: r.state, zip: r.zip,
    lastFiberStatus: r.last_fiber_status, isNewFiber: r.last_is_new_fiber,
    billingStatus: r.last_billing_status, customerSegment: r.last_customer_segment,
    fiberAvailable: r.last_fiber_available,
  };
};

let runSeq = 0;
function newRun(): string {
  const id = `mpbox_test_${++runSeq}_${Date.now()}`;
  rawDb.prepare(
    `INSERT INTO scan_runs (id,tenant_id,kind,label,city,state,budget,status)
     VALUES (?,?,?,?,?,?,?,?)`).run(id, TENANT, "area", "box test", "Rockwell", "NC", 1000, "running");
  return id;
}

/** A classifier that echoes the row back - i.e. the provider agrees with us. */
const echo: import("../../server/mpboxScanEngine").Classifier = async (r) => ({
  lastFiberStatus: r.lastFiberStatus, isNewFiber: r.isNewFiber,
  billingStatus: r.billingStatus, fiberAvailable: r.fiberAvailable,
});

describe("classification uses the project's definitions", () => {
  it("reads TENURED and FRESH FIBER exactly as the codebase defines them", () => {
    expect(store.classify({ lastFiberStatus: "tenured_fiber" }))
      .toMatchObject({ tenured: true });
    expect(store.classify({ lastFiberStatus: "new_fiber", isNewFiber: 1, billingStatus: "N", fiberAvailable: 1 }))
      .toEqual({ tenured: false, freshFiber: true });
    // NEW FIBER that somebody already bought is NOT fresh.
    expect(store.classify({ lastFiberStatus: "new_fiber", isNewFiber: 1, billingStatus: "A", fiberAvailable: 1 }).freshFiber)
      .toBe(false);
    // Tenured is ALL tenured doors, regardless of billing (operator's decision).
    expect(store.classify({ lastFiberStatus: "tenured_fiber", billingStatus: "N" }).tenured).toBe(true);
    expect(store.classify({ lastFiberStatus: "tenured_fiber", billingStatus: "A" }).tenured).toBe(true);
  });

  it("says CANNOT DETERMINE rather than guessing false", () => {
    // No provider answer at all.
    expect(store.classify({})).toEqual({ tenured: null, freshFiber: null });
    // NEW FIBER but the billing status the projector requires is missing.
    expect(store.classify({ lastFiberStatus: "new_fiber", isNewFiber: 1, fiberAvailable: 1 }).freshFiber).toBeNull();
  });
});

describe("the fingerprint decides what changed, never a timestamp", () => {
  it("ignores fields that cannot change a classification", () => {
    const a = store.fingerprintOf({ lastFiberStatus: "new_fiber", isNewFiber: 1, billingStatus: "N", fiberAvailable: 1 });
    const b = store.fingerprintOf({ lastFiberStatus: "NEW_FIBER", isNewFiber: true, billingStatus: " n ", fiberAvailable: true });
    expect(b, "case and whitespace are not a change").toBe(a);
  });
  it("moves when the classifying evidence moves", () => {
    const a = store.fingerprintOf({ lastFiberStatus: "new_fiber", billingStatus: "N" });
    expect(store.fingerprintOf({ lastFiberStatus: "new_fiber", billingStatus: "A" })).not.toBe(a);
    expect(store.fingerprintOf({ lastFiberStatus: "tenured_fiber", billingStatus: "N" })).not.toBe(a);
  });
});

describe("incremental scanning", () => {
  let ids: number[] = [];
  beforeEach(() => {
    ids = [
      target({ status: "tenured_fiber" }),
      target({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1 }),
      target({ status: "no_service" }),
    ];
  });

  it("first-ever scan classifies everything and caches nothing beforehand", async () => {
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW,
    });
    expect(s.discovered).toBe(3);
    expect(s.new).toBe(3);
    expect(s.skippedFromCache).toBe(0);
    expect(s.succeeded).toBe(3);
    expect(s.tenured).toBe(1);
    expect(s.freshFiber).toBe(1);
    expect(s.cacheHitPct).toBe(0);
  });

  it("THE POINT: a repeated unchanged scan gives the same answers for less work", async () => {
    const first = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW,
    });
    let classifierCalls = 0;
    const counting: typeof echo = async (r) => { classifierCalls++; return echo(r); };
    const second = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: counting, nowMs: NOW + 1000,
    });
    expect(classifierCalls, "nothing changed, so nothing is re-classified").toBe(0);
    expect(second.skippedFromCache).toBe(3);
    expect(second.cacheHitPct).toBe(100);
    // Same answers.
    expect(second.tenured).toBe(first.tenured);
    expect(second.freshFiber).toBe(first.freshFiber);
    expect(second.matched).toBe(first.matched);
  });

  it("re-classifies a record whose classifying evidence changed", async () => {
    await engine.runIncrementalScan({ scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW });
    // The door was sold: NEW FIBER + billing N becomes billing A.
    rawDb.prepare(`UPDATE scan_targets SET last_billing_status='A' WHERE id=?`).run(ids[1]);
    let calls = 0;
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec),
      classify: async (r) => { calls++; return echo(r); }, nowMs: NOW + 1000,
    });
    expect(calls, "only the changed record").toBe(1);
    expect(s.changed).toBe(1);
    expect(s.skippedFromCache).toBe(2);
    expect(s.freshFiber, "it is no longer fresh - somebody bought it").toBe(0);
  });

  it("re-classifies everything when the classifier version changes", async () => {
    await engine.runIncrementalScan({ scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW });
    rawDb.prepare(`UPDATE record_scan_state SET classifier_version='older'`).run();
    let calls = 0;
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec),
      classify: async (r) => { calls++; return echo(r); }, nowMs: NOW + 1000,
    });
    expect(calls).toBe(3);
    expect(s.skippedFromCache).toBe(0);
  });

  it("re-scans a stale cache entry and counts it as stale, not new", async () => {
    await engine.runIncrementalScan({ scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW });
    rawDb.prepare(`UPDATE record_scan_state SET cache_expires_at=?`).run(NOW - 1);
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW + 1000,
    });
    expect(s.staleRescanned).toBe(3);
    expect(s.new).toBe(0);
  });

  it("removes duplicates on the stable id and reports how many", async () => {
    const dup = [...ids.map(rec), rec(ids[0]), rec(ids[1])];
    const s = await engine.runIncrementalScan({ scanId: newRun(), tenantId: TENANT, records: dup, classify: echo, nowMs: NOW });
    expect(s.discovered).toBe(5);
    expect(s.duplicatesRemoved).toBe(2);
    expect(s.eligible).toBe(3);
  });

  it("records a partial failure without poisoning the cache", async () => {
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: ids.map(rec), nowMs: NOW,
      classify: async (r) => { if (r.targetId === ids[1]) throw new Error("provider 503"); return echo(r); },
    });
    expect(s.failed).toBe(1);
    expect(s.succeeded).toBe(2);
    const cached = store.loadPriorState([ids[1]]);
    expect(cached.has(ids[1]), "a transport error teaches nothing about the door").toBe(false);
  });

  it("cancels cleanly, then RESUMES without counting anything twice", async () => {
    const scanId = newRun();
    let seen = 0;
    const partial = await engine.runIncrementalScan({
      scanId, tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW,
      batchSize: 1, shouldStop: () => seen++ >= 2, // let two through, then stop
    });
    expect(partial.processed).toBeLessThan(3);
    expect(partial.cancelled).toBeGreaterThan(0);

    const resumed = await engine.runIncrementalScan({
      scanId, tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW + 1000,
    });
    const rows = rawDb.prepare(`SELECT COUNT(*) n FROM mpbox_scan_results WHERE scan_id=?`).get(scanId) as any;
    expect(rows.n, "three records, one row each - never duplicated by the resume").toBe(3);
    expect(resumed.processed + partial.processed).toBeLessThanOrEqual(3 + 1);
  });

  it("writes a checkpoint that survives the run", async () => {
    const scanId = newRun();
    await engine.runIncrementalScan({
      scanId, tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW, batchSize: 1,
    });
    const cp = store.readCheckpoint(scanId);
    expect(cp).toMatchObject({ version: store.CLASSIFIER_VERSION });
    expect(cp.lastTargetId).toBeGreaterThan(0);
  });

  it("keeps the run explainable: stats and classifier version are persisted", async () => {
    const scanId = newRun();
    const s = await engine.runIncrementalScan({ scanId, tenantId: TENANT, records: ids.map(rec), classify: echo, nowMs: NOW });
    const saved = store.readStats(scanId);
    expect(saved).toMatchObject({ discovered: s.discovered, tenured: s.tenured, freshFiber: s.freshFiber });
    const row = rawDb.prepare(`SELECT classifier_version, status, duration_ms FROM scan_runs WHERE id=?`).get(scanId) as any;
    expect(row.classifier_version).toBe(store.CLASSIFIER_VERSION);
    expect(row.status).toBe("done");
  });
});

describe("filters agree with what was persisted", () => {
  let scanId: string;
  beforeAll(async () => {
    const both = target({ status: "tenured_fiber", newFiber: 1, billing: "N", avail: 1 });
    const tOnly = target({ status: "tenured_fiber" });
    const fOnly = target({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1 });
    const neither = target({ status: "no_service" });
    scanId = newRun();
    await engine.runIncrementalScan({
      scanId, tenantId: TENANT, records: [both, tOnly, fOnly, neither].map(rec), classify: echo, nowMs: NOW,
    });
  });

  it("counts match the rows a filter can actually return", () => {
    const c = store.filterCounts(scanId);
    expect(c.total).toBe(4);
    expect(c.tenured).toBe(2);
    expect(c.freshFiber).toBe(2);
    expect(c.both).toBe(1);
    expect(store.listResults(scanId, { tenured: true })).toHaveLength(c.tenured);
    expect(store.listResults(scanId, { freshFiber: true })).toHaveLength(c.freshFiber);
    expect(store.listResults(scanId, { tenured: true, freshFiber: true })).toHaveLength(c.both);
  });

  it("each filter works alone, and together they mean AND", () => {
    const t = store.listResults(scanId, { tenured: true });
    const f = store.listResults(scanId, { freshFiber: true });
    const b = store.listResults(scanId, { tenured: true, freshFiber: true });
    expect(t.every((r) => r.tenured)).toBe(true);
    expect(f.every((r) => r.freshFiber)).toBe(true);
    expect(b.every((r) => r.tenured && r.freshFiber)).toBe(true);
    expect(b.length).toBeLessThanOrEqual(Math.min(t.length, f.length));
  });

  it("a filter with no matches is empty, not an error", () => {
    const empty = newRun();
    expect(store.listResults(empty, { tenured: true })).toEqual([]);
    expect(store.filterCounts(empty)).toMatchObject({ total: 0, tenured: 0, freshFiber: 0 });
  });

  it("paginates by keyset, so a deep page costs the same as a shallow one", () => {
    const page1 = store.listResults(scanId, {}, { limit: 2 });
    const page2 = store.listResults(scanId, {}, { limit: 2, afterTargetId: page1[page1.length - 1].targetId });
    expect(page1).toHaveLength(2);
    expect(page2.every((r) => r.targetId > page1[1].targetId)).toBe(true);
    expect(page1.map((r) => r.targetId)).not.toEqual(page2.map((r) => r.targetId));
  });
});

describe("migration and integrity", () => {
  it("is idempotent and leaves the database sound", () => {
    store._resetMpboxSchemaForTests();
    expect(() => store.ensureMpboxSchema()).not.toThrow();
    const iv = store.verifyIntegrity();
    expect(iv.foreignKeyViolations).toBe(0);
    expect(iv.quickCheck).toBe("ok");
  });

  it("enforces foreign keys, so a result cannot outlive its run", () => {
    expect((rawDb.pragma("foreign_keys") as any)[0].foreign_keys).toBe(1);
    const scanId = newRun();
    const id = target({ status: "tenured_fiber" });
    store.persistBatch(scanId, [{ targetId: id, fingerprint: "f", outcome: "classified", tenured: true, freshFiber: false, scannedAt: NOW }]);
    rawDb.prepare(`DELETE FROM scan_runs WHERE id=?`).run(scanId);
    const left = rawDb.prepare(`SELECT COUNT(*) n FROM mpbox_scan_results WHERE scan_id=?`).get(scanId) as any;
    expect(left.n, "ON DELETE CASCADE removed the orphans").toBe(0);
  });
});

describe("publishLeads: the step that makes a door walkable", () => {
  // Without this the scan records a verdict nobody can act on. A sellable door
  // lives only in mpbox_scan_results, never becomes a lead, never reaches the
  // projector, and never appears as a pin on the field map. That gap is the
  // difference between "the scanner found it" and "a rep can walk to it".
  it("is OFF by default, so a dry classification pass stays dry", async () => {
    const id = target({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1 });
    const before = (rawDb.prepare(`SELECT COUNT(*) n FROM availability_snapshots`).get() as any).n;
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: [rec(id)], classify: echo, nowMs: NOW,
    });
    expect(s.published ?? 0).toBe(0);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM availability_snapshots`).get() as any).n).toBe(before);
  });

  it("writes a conclusive snapshot when switched on, which is what the projector reads", async () => {
    const id = target({ status: "new_fiber", newFiber: 1, billing: "N", avail: 1 });
    const s = await engine.runIncrementalScan({
      scanId: newRun(), tenantId: TENANT, records: [rec(id)], nowMs: NOW,
      publishLeads: true, source: "mpbox-test",
      // A real classifier carries the provider's own segment through - without
      // it the projector cannot tell NEW FIBER from anything else.
      classify: async (r) => ({
        ...(await echo(r)), householdSegmentType: "NEW FIBER", techType: "FIBER",
      }),
    });
    expect(s.published).toBe(1);
    const snap = rawDb.prepare(
      `SELECT conclusive, household_segment_type seg, billing_status bill
         FROM availability_snapshots WHERE scan_target_id=? ORDER BY id DESC LIMIT 1`).get(id) as any;
    expect(snap, "a snapshot exists for the door").toBeTruthy();
    expect(snap.conclusive).toBe(1);
    expect(snap.seg).toBe("NEW FIBER");
    expect(snap.bill).toBe("N");
  });

  it("a publish failure never loses the classification already paid for", async () => {
    // An address the observation writer rejects (no city) must still leave a
    // usable scan result behind - the provider answer cost money.
    const id = ++seq + 600_000;
    rawDb.prepare(`INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,source,
        last_fiber_status,last_is_new_fiber,last_billing_status,last_fiber_available)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, TENANT, "500 No City Rd", "", "NC", "28138", "test", "new_fiber", 1, "N", 1);
    const scanId = newRun();
    const s = await engine.runIncrementalScan({
      scanId, tenantId: TENANT, nowMs: NOW, publishLeads: true,
      records: [{ targetId: id, address: "500 No City Rd", city: "", state: "NC", zip: "28138",
                  lastFiberStatus: "new_fiber", isNewFiber: 1, billingStatus: "N", fiberAvailable: 1 }],
      classify: echo,
    });
    expect(s.succeeded, "the classification survived").toBe(1);
    expect(s.published ?? 0, "but nothing was published").toBe(0);
    const row = rawDb.prepare(`SELECT is_fresh_fiber FROM mpbox_scan_results WHERE scan_id=? AND target_id=?`)
      .get(scanId, id) as any;
    expect(row?.is_fresh_fiber, "and the result is still on file").toBe(1);
  });
});
