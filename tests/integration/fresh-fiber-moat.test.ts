import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let engine: typeof import("../../server/scanEngine");
let store: typeof import("../../server/scanIntelStore");
let monitor: typeof import("../../server/stateMonitorStore");
let scheduler: typeof import("../../server/stateMonitorScheduler");
let appStorage: typeof import("../../server/storage").storage;
const TENANT = 1;
const ids: number[] = [];
const delivered: any[] = [];

function result(address: string, live: boolean): any {
  return {
    address, city: "Flip City", state: "NC", zip: "28000", lat: 35.5, lng: -80.4,
    fiberStatus: live ? "new_fiber" : "no_service", isNewFiber: live, isTenured: false, fiberAvailable: live,
    maxDownloadKbps: live ? 2_000_000 : null, maxDownloadMbps: live ? 2_000 : null, speedTier: live ? "2gig" : null,
    techType: live ? "FIBER" : null, chipSetType: live ? "FTTP" : null, placement: null, maxQual: null,
    competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
    addressCatalogDate: null, householdSegmentType: live ? "NEW FIBER" : null,
    billingStatus: live ? "N" : null, exchangeId: null, dfAddressId: null, accessId: null,
    confidence: "HIGH", apiSource: "kinetic_live", blocked: false,
    notes: live ? "Provider indicates new fiber and no account." : "No service.",
    rawResponse: { serviceable: live, technology: live ? "FIBER" : null, billingStatus: live ? "N" : null },
    leadTag: live ? "hot_lead" : null, leadScore: live ? 100 : 0,
  };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-fresh-moat-"));
  process.env.APP_ORIGIN = "https://portal.example.test";
  process.env.FRESH_FIBER_WEBHOOK_URL = "https://alerts.example.test/fresh";
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  appStorage = storage.storage;
  engine = await import("../../server/scanEngine");
  store = await import("../../server/scanIntelStore");
  monitor = await import("../../server/stateMonitorStore");
  scheduler = await import("../../server/stateMonitorScheduler");

  const seed = rawDb.prepare(`INSERT INTO scan_targets
    (address,city,state,zip,lat,lng,tenant_id,source,last_scanned_at,last_fiber_available,last_is_new_fiber,last_availability_status,scan_count)
    VALUES (?,?,?,?,?,?,?,'test',datetime('now','-2 days'),0,0,'checked_unavailable',1)`);
  for (let i = 0; i < 4; i++) {
    ids.push(Number(seed.run(`${100 + i * 2} Moat St`, "Flip City", "NC", "28000", 35.5 + i * 0.0001, -80.4, TENANT).lastInsertRowid));
  }
  rawDb.prepare(`INSERT INTO territories (tenant_id,name,rep_id,polygon,status)
    VALUES (?, 'Flip City field area', 77, ?, 'active')`).run(TENANT, JSON.stringify([
      [-80.401, 35.499], [-80.399, 35.499], [-80.399, 35.502], [-80.401, 35.502],
    ]));
});

afterAll(() => {
  vi.unstubAllGlobals();
  delete process.env.FRESH_FIBER_WEBHOOK_URL;
});

describe("fresh-fiber moat simulated production flow", () => {
  it("fails closed when any non-projector path tries to insert an unverified fresh lead", () => {
    expect(() => rawDb.prepare(`INSERT INTO leads
      (address,city,state,zip,fiber_status,is_new_fiber,lead_status,tenant_id,created_at,updated_at)
      VALUES ('1 Forged Fresh St','Flip City','NC','28000','new_fiber',1,'prospect',?,datetime('now'),datetime('now'))`)
      .run(TENANT)).toThrow(/fresh_fiber_requires_cross_verification/);
  });

  it("publishes NEW FIBER + billing N immediately as single-source leads, deduped and idempotent", async () => {
    const runId = "run_moat_flip";
    // Fixture kind is "manual" (an explicit action) because this suite is about
    // FLIP DETECTION, not admission policy. It used "state-monitor", which was
    // exempt only by a substring collision with "monitor" - the accident that
    // let bulk producers re-buy answered doors. That exemption is gone; the
    // subject of these tests is not.
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "manual", label: "Moat flip replay", city: "Flip City", state: "NC", budget: ids.length });
    store.enqueueRunTargets(runId, ids.map((id, seq) => ({ id, seq })));
    await engine.runScanWorker(runId, TENANT, async (address) => ({
      result: result(address.address, !address.address.startsWith("106")), bytes: 12_000, checkFailed: false,
    }));

    expect((rawDb.prepare(`SELECT COUNT(*) n FROM availability_snapshots WHERE run_id=?`).get(runId) as any).n).toBe(4);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM scan_targets WHERE first_seen_fiber_at IS NOT NULL`).get() as any).n).toBe(3);
    // AUTHORITATIVE RULE: the 3 NEW FIBER + billing N flips publish IMMEDIATELY as
    // single-source (kinetic_new_fiber) leads — no corroboration wait — assigned to
    // the territory rep and on the map. The 4th (no service) is never a lead.
    const afterScan = rawDb.prepare(`SELECT fresh_confidence AS c, assigned_rep_id AS rep FROM leads WHERE tenant_id=? ORDER BY id`).all(TENANT) as any[];
    expect(afterScan).toHaveLength(3);
    expect(afterScan.every((l) => l.c === "kinetic_new_fiber")).toBe(true);
    expect(afterScan.every((l) => l.rep === 77)).toBe(true);
    expect(appStorage.getLeadsForMap(TENANT, 77)).toHaveLength(3);

    // Crash/reaper replay is idempotent — still exactly 3 leads, no duplicates.
    rawDb.prepare(`UPDATE scan_runs SET status='running',verified=verified-1 WHERE id=?`).run(runId);
    rawDb.prepare(`UPDATE scan_run_targets SET state='queued' WHERE run_id=? AND target_id=?`).run(runId, ids[0]);
    await engine.runScanWorker(runId, TENANT, async (address) => ({ result: result(address.address, true), bytes: 12_000, checkFailed: false }));
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE tenant_id=?`).get(TENANT) as any).n).toBe(3);
    expect(appStorage.getLeadsForMap(TENANT, 77)).toHaveLength(3);

    // Recording independent corroboration never creates a duplicate lead.
    const observedAt = new Date().toISOString();
    const validRows = ids.slice(0, 2).map((scanTargetId, index) => ({
      scanTargetId, source: "fcc_bdc_licensed" as const, sourceRecordId: `fcc-${index}`,
      observedAt, availability: "available" as const, technology: "Fiber to the Premises", maxDownMbps: 1_000,
      referenceUrl: "https://broadbandmap.fcc.gov/data-download", importBatchId: "fcc-simulated-v1",
    }));
    expect(monitor.recordCorroboration(TENANT, validRows)).toEqual({ accepted: 2, duplicates: 0 });
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE tenant_id=?`).get(TENANT) as any).n).toBe(3);
    expect(appStorage.getLeadsForMap(TENANT, 77)).toHaveLength(3);
  });

  it("projects and requests an immediate alert when independent evidence predates the flip", async () => {
    const targetId = Number(rawDb.prepare(`INSERT INTO scan_targets
      (address,city,state,zip,lat,lng,tenant_id,source,last_scanned_at,last_fiber_available,last_is_new_fiber,last_availability_status,scan_count)
      VALUES (?,?,?,?,?,?,?,'test',datetime('now','-2 days'),0,0,'checked_unavailable',1)`)
      .run("200 Preloaded Evidence St", "Flip City", "NC", "28000", 35.5005, -80.4, TENANT).lastInsertRowid);
    rawDb.prepare(`INSERT INTO availability_corroboration
      (tenant_id,scan_target_id,source,source_record_id,observed_at,availability,technology,max_down_mbps,evidence_hash,import_batch_id)
      VALUES (?,?, 'fcc_bdc_licensed','fcc-preloaded',datetime('now'),'available','FTTH',1000,'fcc-preloaded-hash','preloaded')`)
      .run(TENANT, targetId);
    const runId = "run_preloaded_evidence";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "manual", label: "Preloaded evidence", city: "Flip City", state: "NC", budget: 1 });
    store.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);
    const alertHook = vi.fn(async () => ({ queued: 1, delivered: 1 }));
    (globalThis as any).__flushFreshFiberAlerts = alertHook;

    await engine.runScanWorker(runId, TENANT, async (address) => ({ result: result(address.address, true), bytes: 12_000, checkFailed: false }));
    expect(store.getRun(runId, TENANT)).toMatchObject({ status: "done", verified: 1, newlyLive: 1 });
    expect(rawDb.prepare(`SELECT fresh_confidence FROM leads WHERE tenant_id=? AND source_scan_target_id=?`).get(TENANT, targetId)).toMatchObject({ fresh_confidence: "cross_verified" });
    await vi.waitFor(() => expect(alertHook).toHaveBeenCalledWith(TENANT));
    delete (globalThis as any).__flushFreshFiberAlerts;
  });
});
