import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cellKey, selectProbe } from "../../shared/neighborhoodSweep";

/**
 * NEIGHBORHOOD SWEEP — the producer, end to end on a temp DB with the engine
 * dispatch stubbed (zero proxy). The laws under test:
 *   - a cell with a hit is flooded WHOLE (every claimable unscanned door plus
 *     its due negatives), street by street, never a sample;
 *   - cold cells are probed one address per street in ONE run per cycle, the
 *     cell beside a hot one before an isolated one;
 *   - a probed cell with nothing live is parked, then re-probed once its park
 *     window lapses;
 *   - known NEW FIBER doors the projector can publish (billing N, identity
 *     intact) are re-confirmed first, a bounded number of times;
 *   - stale bulk runs from other producers are superseded; live, fresh, manual
 *     and other-tenant runs are not;
 *   - county E911 points fill a hot cell before it floods, once per window;
 *   - tenant rows, parked address_not_found rows and recent negatives are
 *     never enqueued; a second cycle is idempotent; the manager read model
 *     counts unworked fresh leads per neighborhood.
 */

let rawDb: import("better-sqlite3").Database;
let sweep: typeof import("../../server/neighborhoodSweep");
let store: typeof import("../../server/scanIntelStore");

const TENANT = 1;
const NOW = Date.parse("2026-08-22T15:00:00.000Z");
const sqlTime = (msAgo: number) => new Date(NOW - msAgo).toISOString().replace("T", " ").slice(0, 19);
const DAY = 86_400_000;

// Cells (ROUND 2 grid): A hot (Tryon), D cold beside A, B cold (Concord), C sink (Charlotte).
const A = { lat: 35.21, lng: -82.23, city: "Tryon" };
const D = { lat: 35.22, lng: -82.23, city: "Tryon" };
const B = { lat: 35.30, lng: -80.60, city: "Concord" };
const C = { lat: 35.22, lng: -80.84, city: "Charlotte" };

const ids: Record<string, number[]> = {
  aUnscanned: [], aGreensUnlinked: [], aGreensLinked: [], aGreenActive: [], aGreenReview: [], aStaleNeg: [], aRecentNeg: [],
  aTenured: [], aParked: [], aOtherTenant: [], d: [], b: [], cUnscanned: [],
};

function insertTarget(row: Record<string, unknown>): number {
  const cols = Object.keys(row);
  const r = rawDb.prepare(`INSERT INTO scan_targets (${cols.join(",")}) VALUES (${cols.map((c) => `@${c}`).join(",")})`).run(row);
  return Number(r.lastInsertRowid);
}
const addressOf = (id: number): string => (rawDb.prepare(`SELECT address FROM scan_targets WHERE id=?`).get(id) as any).address;
const streetOf = (id: number): string => addressOf(id).replace(/^\d+ /, "");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-nsweep-"));
  process.env.NEIGHBORHOOD_SWEEP = "on";
  process.env.NEIGHBORHOOD_SWEEP_FLOOR = "1000";
  process.env.NEIGHBORHOOD_SWEEP_E911 = "off";
  ({ rawDb } = await import("../../server/db"));
  const storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  store = await import("../../server/scanIntelStore");
  sweep = await import("../../server/neighborhoodSweep");

  const base = (c: { lat: number; lng: number; city: string }, i: number, street: string) => ({
    tenant_id: TENANT, address: `${100 + i * 2} ${street}`, city: c.city, state: "NC", zip: "28782",
    lat: c.lat + ((i % 7) - 3) * 0.0007, lng: c.lng + ((i % 5) - 2) * 0.0007, source: "test", carrier: "kinetic",
  });
  const green = (extra: Record<string, unknown> = {}) => ({
    last_scanned_at: sqlTime(30 * DAY), scan_count: 1, last_fiber_status: "new_fiber", last_is_new_fiber: 1,
    last_fiber_available: 1, last_billing_status: "N", ...extra,
  });
  const streetsA = ["Oak St", "Elm Ave", "Pine Ct"];
  // A: 40 unscanned across 3 streets.
  for (let i = 0; i < 40; i++) ids.aUnscanned.push(insertTarget(base(A, i, streetsA[i % 3])));
  // A: 5 publishable hits, 3 unlinked (never became leads), 2 linked.
  for (let i = 0; i < 5; i++) {
    const linked = i >= 3;
    ids[linked ? "aGreensLinked" : "aGreensUnlinked"].push(insertTarget({ ...base(A, 50 + i, "Oak St"), ...green({ converted_to_lead_id: linked ? 999_000 + i : null }) }));
  }
  // A: two NEW FIBER doors the projector can never publish: an active customer and a broken identity.
  ids.aGreenActive.push(insertTarget({ ...base(A, 55, "Oak St"), ...green({ last_billing_status: "A" }) }));
  ids.aGreenReview.push(insertTarget({ ...base(A, 56, "Oak St"), ...green({ address_review_reason: "identity_mismatch" }) }));
  // A: 4 stale negatives (due) and 1 recent negative (not due).
  for (let i = 0; i < 4; i++) ids.aStaleNeg.push(insertTarget({ ...base(A, 60 + i, "Elm Ave"), last_scanned_at: sqlTime(40 * DAY), scan_count: 1, last_fiber_status: "no_service", last_fiber_available: 0 }));
  ids.aRecentNeg.push(insertTarget({ ...base(A, 70, "Elm Ave"), last_scanned_at: sqlTime(2 * DAY), scan_count: 1, last_fiber_status: "no_service", last_fiber_available: 0 }));
  // A: a legacy tenured-fiber row with last_fiber_available NULL: live, never a negative.
  ids.aTenured.push(insertTarget({ ...base(A, 72, "Elm Ave"), last_scanned_at: sqlTime(40 * DAY), scan_count: 1, last_fiber_status: "tenured_fiber", last_fiber_available: null }));
  // A: an address_not_found-parked row (never answered, 3 needs-fix attempts just now).
  ids.aParked.push(insertTarget({ ...base(A, 71, "Pine Ct"), inconclusive_attempts: 3, last_inconclusive_at: sqlTime(DAY) }));
  // A: another tenant's rows.
  for (let i = 0; i < 3; i++) ids.aOtherTenant.push(insertTarget({ ...base(A, 80 + i, "Oak St"), tenant_id: 2 }));
  // D: cold, beside A, 30 unscanned on 3 streets.
  for (let i = 0; i < 30; i++) ids.d.push(insertTarget(base(D, i, ["Ridge Rd", "Vale Ln", "Crest Dr"][i % 3])));
  // B: cold, isolated, 60 unscanned on 6 streets.
  for (let i = 0; i < 60; i++) ids.b.push(insertTarget(base(B, i, `Street ${i % 6}`)));
  // C: sink, 20 scanned nothing live, 50 unscanned.
  for (let i = 0; i < 20; i++) insertTarget({ ...base(C, i, "Dead End"), last_scanned_at: sqlTime(35 * DAY), scan_count: 1, last_fiber_status: "no_service", last_fiber_available: 0 });
  for (let i = 0; i < 50; i++) ids.cUnscanned.push(insertTarget(base(C, 100 + i, "Quiet Way")));

  // A stale daily-diff run from a producer that is now off still "owns" half of A's unscanned rows.
  store.createScanRun({ id: "run_1_stale_dailydiff", tenantId: TENANT, kind: "daily-diff", label: "stale", city: "Tryon", state: "NC", budget: 20 });
  store.enqueueRunTargets("run_1_stale_dailydiff", ids.aUnscanned.slice(0, 20).map((id, seq) => ({ id, seq })));
  rawDb.prepare(`UPDATE scan_runs SET heartbeat_at=? WHERE id='run_1_stale_dailydiff'`).run(sqlTime(3 * DAY));
  rawDb.prepare(`UPDATE scan_run_targets SET state='inflight' WHERE run_id='run_1_stale_dailydiff' AND target_id=?`).run(ids.aUnscanned[0]);
  // Runs that must be left alone: a live daily-diff (fresh heartbeat), a manual run, another tenant's stale run.
  store.createScanRun({ id: "run_1_live_dailydiff", tenantId: TENANT, kind: "daily-diff", label: "live", city: "Concord", state: "NC", budget: 1 });
  store.enqueueRunTargets("run_1_live_dailydiff", [{ id: ids.cUnscanned[0], seq: 0 }]);
  store.createScanRun({ id: "run_1_live_manual", tenantId: TENANT, kind: "manual", label: "live", city: "Concord", state: "NC", budget: 1 });
  rawDb.prepare(`UPDATE scan_runs SET heartbeat_at=? WHERE id='run_1_live_manual'`).run(sqlTime(3 * DAY));
  // The manual run holds the very door B's probe would pick first, so the cross-run dedup is exercised.
  const bRows = ids.b.map((id) => ({ id, streetKey: streetOf(id), houseNumber: Number(addressOf(id).match(/^\d+/)![0]) }));
  store.enqueueRunTargets("run_1_live_manual", [{ id: selectProbe(bRows, 12)[0], seq: 0 }]);
  store.createScanRun({ id: "run_2_stale_dailydiff", tenantId: 2, kind: "daily-diff", label: "other tenant", city: "Tryon", state: "NC", budget: 1 });
  store.enqueueRunTargets("run_2_stale_dailydiff", [{ id: ids.aOtherTenant[0], seq: 0 }]);
  rawDb.prepare(`UPDATE scan_runs SET heartbeat_at=? WHERE id='run_2_stale_dailydiff'`).run(sqlTime(3 * DAY));
});

const dispatched: string[] = [];
const dispatch = (runId: string) => { dispatched.push(runId); };

function runTargets(runId: string): Array<{ id: number; seq: number; state: string }> {
  return rawDb.prepare(`SELECT target_id AS id, seq, state FROM scan_run_targets WHERE run_id=? ORDER BY seq`).all(runId) as any;
}
function cellOf(id: number): string {
  const r = rawDb.prepare(`SELECT cell_lat, cell_lng FROM scan_targets WHERE id=?`).get(id) as any;
  return cellKey(r.cell_lat, r.cell_lng);
}
function sweepCell(c: { lat: number; lng: number }): any {
  return rawDb.prepare(`SELECT * FROM sweep_cells WHERE tenant_id=? AND cell_lat=? AND cell_lng=?`).get(TENANT, c.lat, c.lng);
}

describe("neighborhood sweep cycle (temp DB, zero proxy)", () => {
  let first: import("../../server/neighborhoodSweep").CycleResult;

  it("supersedes the stale bulk run and leaves live, manual and other-tenant runs alone", async () => {
    first = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW });
    expect(first.skipped).toBeUndefined();
    expect(first.supersededRuns).toBe(1);
    expect(first.supersededTargets).toBe(20);
    expect(store.getRun("run_1_stale_dailydiff", TENANT)?.status).toBe("cancelled");
    expect(runTargets("run_1_stale_dailydiff").every((t) => t.state === "skipped")).toBe(true); // queued AND inflight
    expect(store.getRun("run_1_live_dailydiff", TENANT)?.status).toBe("running");
    expect(store.getRun("run_1_live_manual", TENANT)?.status).toBe("running");
    expect(store.getRun("run_2_stale_dailydiff", 2)?.status).toBe("running");
  });

  it("re-confirms only the NEW FIBER doors the projector can publish, first", () => {
    const confirmRun = first.runIds.find((id) => id.includes("_confirm_"))!;
    expect(confirmRun).toBeDefined();
    expect(first.runIds[0]).toBe(confirmRun);
    const targets = runTargets(confirmRun).map((t) => t.id).sort();
    expect(targets).toEqual([...ids.aGreensUnlinked].sort());
    for (const id of [...ids.aGreensLinked, ...ids.aGreenActive, ...ids.aGreenReview]) expect(targets).not.toContain(id);
    expect(store.getRun(confirmRun, TENANT)?.kind).toBe("fresh_sweep_confirm");
    expect(dispatched).toContain(confirmRun);
  });

  it("floods the hot cell whole: every claimable door and every due negative, street by street", () => {
    const floodRun = first.runIds.find((id) => id.includes(`_${cellKey(A.lat, A.lng)}_`) && id.endsWith("_f1"))!;
    expect(floodRun).toBeDefined();
    const targets = runTargets(floodRun);
    const got = targets.map((t) => t.id).sort();
    const want = [...ids.aUnscanned, ...ids.aStaleNeg].sort();
    expect(got).toEqual(want);
    // Excluded on purpose: the recent negative, the parked row, other tenant, linked greens, the tenured door.
    for (const id of [...ids.aRecentNeg, ...ids.aParked, ...ids.aOtherTenant, ...ids.aGreensLinked, ...ids.aTenured]) expect(got).not.toContain(id);
    // Street order: the run walks Elm Ave, then Oak St, then Pine Ct, house numbers ascending.
    const streets = targets.map((t) => streetOf(t.id));
    expect(streets.lastIndexOf("Elm Ave")).toBeLessThan(streets.indexOf("Oak St"));
    expect(streets.lastIndexOf("Oak St")).toBeLessThan(streets.indexOf("Pine Ct"));
    const elm = targets.filter((t) => streetOf(t.id) === "Elm Ave").map((t) => Number(addressOf(t.id).match(/^\d+/)![0]));
    expect(elm).toEqual([...elm].sort((a, b) => a - b));
    expect(store.getRun(floodRun, TENANT)).toMatchObject({ kind: "fresh_sweep_flood", budget: want.length, status: "running" });
    expect(first.flood).toBe(want.length);
    expect(first.floodCells).toBe(1);
  });

  it("probes cold cells in one run, one address per street, the cell beside the hot one first, never the sink", () => {
    const probeRuns = first.runIds.filter((id) => id.includes("_probe_"));
    expect(probeRuns).toHaveLength(1);
    const targets = runTargets(probeRuns[0]);
    expect(first.probeCells).toBe(2);
    // D's 12 doors come before B's 11 (one of B's picks is held by the live manual run and deduped away).
    const cells = targets.map((t) => cellOf(t.id));
    expect(cells.slice(0, 12).every((c) => c === cellKey(D.lat, D.lng))).toBe(true);
    expect(cells.slice(12).every((c) => c === cellKey(B.lat, B.lng))).toBe(true);
    expect(cells.slice(12)).toHaveLength(11);
    expect(first.probe).toBe(23);
    expect(store.getRun(probeRuns[0], TENANT)?.budget).toBe(23);
    // B's probe covers all six streets before repeating any.
    const bStreets = targets.slice(12, 18).map((t) => streetOf(t.id));
    expect(new Set(bStreets).size).toBe(6);
    // D's probe covers its three streets, one per street first.
    expect(new Set(targets.slice(0, 3).map((t) => streetOf(t.id))).size).toBe(3);
    // The sink got nothing and is parked with a window.
    expect(cells).not.toContain(cellKey(C.lat, C.lng));
    expect(sweepCell(C)).toMatchObject({ phase: "parked", parked_reason: "cell_no_fiber" });
    expect(sweepCell(C).parked_until > new Date(NOW).toISOString()).toBe(true);
    expect(sweepCell(D)).toMatchObject({ last_run_id: probeRuns[0], probes: 1 });
    expect(sweepCell(B)).toMatchObject({ last_run_id: probeRuns[0], probes: 1 });
  });

  it("persists the frontier with the decision for every cell", () => {
    expect(sweepCell(A)).toMatchObject({ phase: "flood", hits: 7, live: 8, unscanned: 40, stale_negatives: 4, unlinked_greens: 3 });
    expect(sweepCell(D)).toMatchObject({ phase: "probe", neighbor_hits: 7 });
    expect(sweepCell(B)).toMatchObject({ phase: "probe", neighbor_hits: 0 });
    expect(rawDb.prepare(`SELECT COUNT(*) AS n FROM sweep_cycles WHERE tenant_id=?`).get(TENANT)).toEqual({ n: 1 });
  });

  it("a second cycle is idempotent: nothing is enqueued twice while the runs are still open", async () => {
    const before = rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_run_targets WHERE state='queued'`).get() as any;
    const runsBefore = rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_runs WHERE kind LIKE 'fresh_sweep%'`).get() as any;
    const second = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 60_000 });
    expect(second.flood).toBe(0);
    expect(second.probe).toBe(0);
    expect(second.confirm).toBe(0);
    expect((rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_runs WHERE kind LIKE 'fresh_sweep%'`).get() as any).n).toBe(runsBefore.n);
    const after = rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_run_targets WHERE state='queued'`).get() as any;
    expect(after.n).toBe(before.n);
    // The park window is kept, not extended, cycle after cycle.
    const c1 = sweepCell(C).parked_until;
    await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 120_000 });
    expect(sweepCell(C).parked_until).toBe(c1);
  });

  it("a probe hit turns the cold cell into a flood on the next cycle", async () => {
    const probeRun = first.runIds.find((id) => id.includes("_probe_"))!;
    const probedD = runTargets(probeRun).map((t) => t.id).filter((id) => cellOf(id) === cellKey(D.lat, D.lng));
    expect(probedD).toHaveLength(12);
    // Simulate the engine finishing the probe: mark the run done, stamp one hit in D and the rest negative.
    rawDb.prepare(`UPDATE scan_run_targets SET state='verified' WHERE run_id=?`).run(probeRun);
    store.setRunStatus(probeRun, "done");
    rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=?, scan_count=1, last_fiber_status='new_fiber', last_is_new_fiber=1, last_fiber_available=1, last_billing_status='N' WHERE id=?`).run(sqlTime(0), probedD[0]);
    rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=?, scan_count=1, last_fiber_status='no_service', last_fiber_available=0 WHERE id IN (${probedD.slice(1).join(",")})`).run(sqlTime(0));

    const third = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 180_000 });
    const floodD = third.runIds.find((id) => id.includes(`_${cellKey(D.lat, D.lng)}_`) && id.endsWith("_f1"))!;
    expect(floodD).toBeDefined();
    const targets = runTargets(floodD).map((t) => t.id).sort();
    // Every door the probe did not touch, and nothing it did (all answered today).
    expect(targets).toEqual(ids.d.filter((id) => !probedD.includes(id)).sort());
    expect(targets).toHaveLength(30 - 12);
    expect(sweepCell(D).phase).toBe("flood");
  });

  it("a parked sink is re-probed once its window lapses, then parked again", async () => {
    const parkedUntil = sweepCell(C).parked_until as string;
    const later = Date.parse(parkedUntil) + DAY;
    const r = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: later });
    const probeRun = r.runIds.find((id) => id.includes("_probe_"))!;
    expect(probeRun).toBeDefined();
    const probedC = runTargets(probeRun).map((t) => t.id).filter((id) => cellOf(id) === cellKey(C.lat, C.lng));
    // 12 picked; one of them is still held by the live daily-diff run, so the dedup drops it.
    expect(probedC).toHaveLength(11);
    expect(probedC).not.toContain(ids.cUnscanned[0]);
    expect(sweepCell(C)).toMatchObject({ phase: "probe", parked_until: null });
    expect(JSON.parse(sweepCell(C).reasons)).toContain("park_expired");
    // Nothing lit: the probe answers negative, the cell parks again for a fresh window.
    rawDb.prepare(`UPDATE scan_run_targets SET state='verified' WHERE run_id=?`).run(probeRun);
    store.setRunStatus(probeRun, "done");
    rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=?, scan_count=1, last_fiber_status='no_service', last_fiber_available=0 WHERE id IN (${probedC.join(",")})`)
      .run(new Date(later).toISOString().replace("T", " ").slice(0, 19));
    await sweep.runSweepCycle(TENANT, { dispatch, nowMs: later + 60_000 });
    expect(sweepCell(C).phase).toBe("parked");
    expect(sweepCell(C).parked_until > new Date(later).toISOString()).toBe(true);
  });

  it("bounds confirm attempts per door", async () => {
    // The unlinked greens have been in one confirm run; simulate two more attempts that never published.
    const confirmRun = first.runIds.find((id) => id.includes("_confirm_"))!;
    rawDb.prepare(`UPDATE scan_run_targets SET state='failed' WHERE run_id=?`).run(confirmRun);
    store.setRunStatus(confirmRun, "done");
    for (let n = 2; n <= 3; n++) {
      const id = `nsweep_${TENANT}_NC_confirm_20260801_c${n}`;
      store.createScanRun({ id, tenantId: TENANT, kind: "fresh_sweep_confirm", label: "earlier", city: "sweep-confirm", state: "NC", budget: 3 });
      store.enqueueRunTargets(id, ids.aGreensUnlinked.map((t, seq) => ({ id: t, seq })));
      rawDb.prepare(`UPDATE scan_run_targets SET state='failed' WHERE run_id=?`).run(id);
      store.setRunStatus(id, "done");
    }
    const r = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 10 * DAY });
    expect(r.confirm).toBe(0);
    expect(r.runIds.some((id) => id.includes("_confirm_"))).toBe(false);
  });

  it("respects the cycle budget and skips when its own backlog is warm", async () => {
    process.env.NEIGHBORHOOD_SWEEP_FLOOR = "10";
    process.env.NEIGHBORHOOD_SWEEP_MAX_PER_CYCLE = "10";
    try {
      const r = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 11 * DAY });
      expect(r.skipped).toBe("backlog_warm");
      expect(r.runIds).toEqual([]);
    } finally {
      process.env.NEIGHBORHOOD_SWEEP_FLOOR = "1000";
      delete process.env.NEIGHBORHOOD_SWEEP_MAX_PER_CYCLE;
    }
  });

  it("the manager read model ranks neighborhoods by fresh leads nobody has knocked", () => {
    const now = new Date(NOW).toISOString();
    const lead = rawDb.prepare(`INSERT INTO leads (tenant_id, address, city, state, zip, lat, lng, lead_status, lead_tag, last_outcome, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const a1 = Number(lead.run(TENANT, "100 Oak St", "Tryon", "NC", "28782", A.lat, A.lng, "prospect", "fresh_fiber_confirmed", null, now, now).lastInsertRowid);
    lead.run(TENANT, "102 Oak St", "Tryon", "NC", "28782", A.lat + 0.001, A.lng, "prospect", "fresh_fiber_confirmed", null, now, now);
    lead.run(TENANT, "104 Oak St", "Tryon", "NC", "28782", A.lat, A.lng + 0.001, "prospect", "fresh_fiber_confirmed", null, now, now);
    // Touched without a knock row (legacy status writes): not unworked.
    lead.run(TENANT, "106 Oak St", "Tryon", "NC", "28782", A.lat, A.lng + 0.002, "prospect", "fresh_fiber_confirmed", "not_home", now, now);
    lead.run(2, "1 Elsewhere", "Tryon", "NC", "28782", A.lat, A.lng, "prospect", "fresh_fiber_confirmed", null, now, now);
    rawDb.prepare(`INSERT INTO knock_log (lead_id, rep_id, was_home, outcome, tenant_id) VALUES (?,?,?,?,?)`).run(a1, 7, 1, "not_interested", TENANT);
    // A finished cell full of unknocked fresh doors outranks a cell still being swept.
    const E = { lat: 35.40, lng: -80.70 };
    rawDb.prepare(`INSERT INTO sweep_cells (tenant_id, state, cell_lat, cell_lng, city, phase, score, expected_rate, reasons, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(TENANT, "NC", E.lat, E.lng, "davidson", "complete", 0, 0, '["no_work"]', now);
    for (let i = 0; i < 4; i++) lead.run(TENANT, `${i} Done St`, "Davidson", "NC", "28036", E.lat, E.lng, "prospect", "fresh_fiber_confirmed", null, now, now);

    const rows = sweep.listNeighborhoods(TENANT, { state: "NC", limit: 10 });
    expect(rows[0]).toMatchObject({ city: "davidson", phase: "complete", leads: 4, unworkedLeads: 4, knockedLeads: 0 });
    expect(rows[1]).toMatchObject({ city: "tryon", cellLat: A.lat, cellLng: A.lng, phase: "flood", leads: 4, unworkedLeads: 2, knockedLeads: 1 });
    expect(rows[1].run).toMatchObject({ status: "running" });
    expect(rows[1].sampleLeadId).not.toBe(a1); // the knocked door is never the map target
    expect(rows.some((r) => r.cellLat === C.lat && r.cellLng === C.lng)).toBe(false);
    expect(sweep.listNeighborhoods(TENANT, { state: "NC", phase: "flood" }).every((r) => r.phase === "flood")).toBe(true);
    const summary = sweep.sweepSummary(TENANT);
    expect(summary.enabled).toBe(true);
    expect(summary.neighborhoodsWithUnworked).toBe(2); // Tryon A and Davidson E, not the other tenant's door
    expect(summary.unworkedFreshDoors).toBe(6);
    expect(summary.cells.flood).toBe(2);
    expect(summary.cells.parked).toBe(1);
    expect(summary.pending).toBeGreaterThan(0);
  });
});

describe("E911 bridge (county address points fill a hot cell before it floods)", () => {
  it("adds the county's doors to the cell once per window, and the flood includes them", async () => {
    const { upsertAddressPoints } = await import("../../server/addressPointStore");
    upsertAddressPoints(Array.from({ length: 6 }, (_, i) => ({
      source: "test", sourceId: `ap-${i}`,
      houseNumber: String(300 + i), street: "Laurel Way",
      fullAddress: `${300 + i} Laurel Way`,
      city: "Tryon", state: "NC", zip: "28782", county: "POLK",
      lat: A.lat + 0.001, lng: A.lng - 0.001 + i * 0.0001,
    })));
    // One point shares its address with a row that already exists: must not duplicate.
    upsertAddressPoints([{ source: "test", sourceId: "ap-dup", houseNumber: "100", street: "Oak St", fullAddress: "100 Oak St", city: "Tryon", state: "NC", zip: "28782", county: "POLK", lat: A.lat, lng: A.lng }]);
    process.env.NEIGHBORHOOD_SWEEP_E911 = "on";
    try {
      // Close A's open flood so the cell is eligible again.
      const open = rawDb.prepare(`SELECT id FROM scan_runs WHERE kind='fresh_sweep_flood' AND status='running' AND city='tryon'`).all() as any[];
      for (const r of open) { rawDb.prepare(`UPDATE scan_run_targets SET state='verified' WHERE run_id=?`).run(r.id); store.setRunStatus(r.id, "done"); }
      rawDb.prepare(`UPDATE scan_targets SET last_scanned_at=?, scan_count=1, last_fiber_status='no_service', last_fiber_available=0 WHERE id IN (${[...ids.aUnscanned, ...ids.aStaleNeg].join(",")})`).run(sqlTime(0));

      const r = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 12 * DAY });
      expect(r.e911Added).toBe(6);
      const added = rawDb.prepare(`SELECT id, address, source, tenant_id FROM scan_targets WHERE source='e911-sweep' ORDER BY address`).all() as any[];
      expect(added).toHaveLength(6);
      expect(added.every((t) => t.tenant_id === TENANT)).toBe(true);
      expect(rawDb.prepare(`SELECT COUNT(*) AS n FROM scan_targets WHERE lower(address)='100 oak st'`).get()).toEqual({ n: 1 });
      const floodA = r.runIds.find((id) => id.includes(`_${cellKey(A.lat, A.lng)}_`) && id.endsWith("_f2"))!;
      expect(floodA).toBeDefined();
      const targets = runTargets(floodA).map((t) => t.id);
      for (const t of added) expect(targets).toContain(t.id);
      expect(sweepCell(A).e911_bridged_at).toBeTruthy();

      // Next cycle inside the window: no re-bridge, nothing new.
      rawDb.prepare(`UPDATE scan_run_targets SET state='verified' WHERE run_id=?`).run(floodA);
      store.setRunStatus(floodA, "done");
      const again = await sweep.runSweepCycle(TENANT, { dispatch, nowMs: NOW + 12 * DAY + 60_000 });
      expect(again.e911Added).toBe(0);
    } finally {
      process.env.NEIGHBORHOOD_SWEEP_E911 = "off";
    }
  });
});
