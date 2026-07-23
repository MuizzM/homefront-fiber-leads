import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cancel WINS, even against a check already in the air. A provider check can
// take seconds of network time; if the run is cancelled while one is mid-flight,
// the returning answer must record NOTHING — no verified/failed counters, no
// snapshot, no lead. The claimed target stays 'inflight' for resume/reaper.
// (This is the deterministic version of a race CI hit: a cancelled run showing
// failed=1 from a check that finalized after the cancel landed.)

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/scanIntelStore");
let engine: typeof import("../../server/scanEngine");
let storageMod: typeof import("../../server/storage");
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-cancel-race-"));
  ({ rawDb } = await import("../../server/db"));
  storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  store = await import("../../server/scanIntelStore");
  engine = await import("../../server/scanEngine");
});

describe("mid-flight cancel", () => {
  it("records nothing from a check that returns after the run was cancelled", async () => {
    const targetId = Number(rawDb.prepare(
      `INSERT INTO scan_targets (tenant_id,address,city,state,zip,lat,lng,source)
       VALUES (?,?,?,?,?,?,?,'test')`,
    ).run(TENANT, "42 Midflight Way", "Racetown", "NC", "28200", 35.7, -80.6).lastInsertRowid);
    const runId = "run_cancel_midflight";
    store.createScanRun({
      id: runId, tenantId: TENANT, kind: "address_discovery",
      label: "Cancel race", city: "Racetown", state: "NC", budget: 1,
    });
    store.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);

    // The checker cancels its own run while "on the wire", then returns a fully
    // conclusive NEW FIBER answer — the strongest temptation to record.
    const cancelMidFlight: import("../../server/scanEngine").Checker = async (a) => {
      rawDb.prepare(`UPDATE scan_runs SET status='cancelled' WHERE id=?`).run(runId);
      return {
        result: {
          address: a.address, city: a.city, state: a.state, zip: a.zip,
          lat: 35.7, lng: -80.6, apiSource: "kinetic_live", fiberStatus: "new_fiber",
          isNewFiber: true, fiberAvailable: true, billingStatus: "N",
          householdSegmentType: "NEW FIBER", confidence: "HIGH", notes: "live answer",
          rawResponse: { success: true, address: { householdSegmentType: "NEW FIBER", billingStatus: "N" } },
        } as any,
        bytes: 12000,
        checkFailed: false,
      };
    };

    await engine.runScanWorker(runId, TENANT, cancelMidFlight);

    // Nothing recorded on the cancelled run — not verified, not failed.
    expect(store.getRun(runId, TENANT)).toMatchObject({
      status: "cancelled", verified: 0, failed: 0, newFiber: 0,
    });
    // The claimed target is left 'inflight' for resume/reaper to requeue.
    const t = rawDb.prepare(
      `SELECT state FROM scan_run_targets WHERE run_id=? AND target_id=?`,
    ).get(runId, targetId) as any;
    expect(t.state).toBe("inflight");
    // No availability snapshot, no scan-memory write, no lead.
    expect((rawDb.prepare(
      `SELECT COUNT(*) c FROM availability_snapshots WHERE scan_target_id=?`,
    ).get(targetId) as any).c).toBe(0);
    expect((rawDb.prepare(
      `SELECT last_scanned_at AS lastScannedAt FROM scan_targets WHERE id=?`,
    ).get(targetId) as any).lastScannedAt).toBeNull();
    expect(storageMod.storage.getLeads(TENANT).some((l: any) => l.address === "42 Midflight Way")).toBe(false);
  });
});
