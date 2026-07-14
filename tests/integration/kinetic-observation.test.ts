import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let persistKineticObservation: typeof import("../../server/kineticObservation").persistKineticObservation;
let persistScanResult: typeof import("../../server/scanSources").persistScanResult;

const TENANT = 1;

function cnsObservation(address: string, isNewFiber: boolean, discoveredAt = new Date().toISOString()): any {
  return {
    address, city: "Evidence City", state: "NC", zip: "28000",
    lat: 35.5, lng: -80.4, dfAddressId: `MS${address.replace(/\D/g, "").padStart(7, "0")}`,
    fiberStatus: isNewFiber ? "new_fiber" : "other",
    isNewFiber, billingStatus: isNewFiber ? "N" : null,
    householdSegmentType: isNewFiber ? "NEW FIBER" : "EXISTING FIBER",
    techType: isNewFiber ? "FTTP" : null, maxDownloadMbps: isNewFiber ? 1000 : null,
    discoveredAt,
  };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-kinetic-observation-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  ({ persistKineticObservation } = await import("../../server/kineticObservation"));
  ({ persistScanResult } = await import("../../server/scanSources"));
});

beforeEach(() => {
  rawDb.exec(`
    DELETE FROM notification_outbox;
    DELETE FROM lead_events;
    DELETE FROM leads;
    DELETE FROM availability_corroboration;
    DELETE FROM availability_snapshots;
    DELETE FROM scan_targets;
  `);
});

afterEach(() => {
  delete (globalThis as any).__flushFreshFiberAlerts;
});

describe("persistKineticObservation", () => {
  it("stores a first-seen CNS NEW FIBER hit as an available baseline, never a fresh lead", () => {
    const result = persistKineticObservation({
      tenantId: TENANT,
      source: "test-cns",
      observation: cnsObservation("100 Baseline Ave", true),
    });

    expect(result).toMatchObject({
      targetCreated: true,
      conclusive: true,
      fiberAvailable: true,
      rawNewFiberHit: true,
      transition: { status: "baseline_available", fresh: false },
      projection: { published: 0 },
    });
    expect(rawDb.prepare(`SELECT last_fiber_available,first_seen_fiber_at,tenant_id FROM scan_targets WHERE id=?`)
      .get(result.targetId)).toEqual({ last_fiber_available: 1, first_seen_fiber_at: null, tenant_id: TENANT });
    expect(rawDb.prepare(`SELECT conclusive,fiber_available,transition_status,fresh FROM availability_snapshots WHERE scan_target_id=?`)
      .get(result.targetId)).toEqual({ conclusive: 1, fiber_available: 1, transition_status: "baseline_available", fresh: 0 });
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads`).get() as any).n).toBe(0);
  });

  it("treats a non-new CNS hit as inconclusive instead of fabricating unavailable", () => {
    const result = persistKineticObservation({
      tenantId: TENANT,
      source: "test-cns",
      observation: cnsObservation("200 Unknown Ave", false),
    });

    expect(result).toMatchObject({ conclusive: false, fiberAvailable: null, transition: { status: "check_failed", fresh: false } });
    expect(rawDb.prepare(`SELECT last_scanned_at,last_fiber_available,scan_count FROM scan_targets WHERE id=?`)
      .get(result.targetId)).toEqual({ last_scanned_at: null, last_fiber_available: null, scan_count: 0 });
    expect(rawDb.prepare(`SELECT conclusive,fiber_available,fresh FROM availability_snapshots WHERE scan_target_id=?`)
      .get(result.targetId)).toEqual({ conclusive: 0, fiber_available: null, fresh: 0 });
  });

  it("publishes and alerts once only when timestamped prior-unavailable and independent fiber evidence exist", async () => {
    const now = Date.now();
    const first = persistKineticObservation({
      tenantId: TENANT,
      source: "test-cns",
      observation: cnsObservation("300 Proven Flip Ave", false, new Date(now - 2 * 86_400_000).toISOString()),
    });
    rawDb.prepare(`INSERT INTO availability_corroboration
      (tenant_id,scan_target_id,source,source_record_id,observed_at,availability,technology,max_down_mbps,evidence_hash,import_batch_id)
      VALUES (?,?, 'fcc_bdc_licensed','fcc-300',?,'available','FTTH',1000,'fcc-300-hash','test')`)
      .run(TENANT, first.targetId, new Date(now).toISOString());
    const alertHook = vi.fn(async () => ({ queued: 1, delivered: 1 }));
    (globalThis as any).__flushFreshFiberAlerts = alertHook;

    const live = persistKineticObservation({
      tenantId: TENANT,
      source: "test-cns",
      observation: cnsObservation("300 Proven Flip Ave", true, new Date(now).toISOString()),
      legacyPriorUnavailableEvidence: {
        observedAt: new Date(now - 86_400_000).toISOString(),
        source: "legacy-nightly-scan",
        evidenceId: "legacy-no-service-300",
      },
    });

    expect(live.transition).toMatchObject({ status: "freshly_available", fresh: true });
    expect(live.customerSegment).toBe("new_opportunity");
    expect(live.projection.published).toBe(1);
    expect(rawDb.prepare(`SELECT fresh_confidence,source_scan_target_id,tenant_id FROM leads WHERE source_scan_target_id=?`)
      .get(first.targetId)).toEqual({ fresh_confidence: "cross_verified", source_scan_target_id: first.targetId, tenant_id: TENANT });
    await vi.waitFor(() => expect(alertHook).toHaveBeenCalledTimes(1));

    const replay = persistKineticObservation({
      tenantId: TENANT,
      source: "test-cns",
      observation: cnsObservation("300 Proven Flip Ave", true, new Date(now + 1_000).toISOString()),
    });
    expect(replay.transition).toMatchObject({ status: "still_available", fresh: false });
    expect(replay.projection.published).toBe(0);
    expect(alertHook).toHaveBeenCalledTimes(1);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads`).get() as any).n).toBe(1);
  });

  it("rejects cross-tenant target reuse", () => {
    persistKineticObservation({ tenantId: TENANT, source: "test", observation: {
      ...cnsObservation("400 Tenant Boundary Ave", false), fiberStatus: "no_service",
    } });
    expect(() => persistKineticObservation({ tenantId: 99, source: "test", observation: {
      ...cnsObservation("400 Tenant Boundary Ave", true),
    } })).toThrow(/KINETIC_OBSERVATION_TENANT_CONFLICT/);
  });

  it("keeps raw scan-source hits separate from the confirmed-lead counter", () => {
    const counters = {
      answered: 0, newFiber: 0, leads: 0, comingSoon: 0, noService: 0,
      existing: 0, blocked: 0, inconclusive: 0, dropped: 0,
      fringeQueued: 0, fringeLeads: 0,
    };
    const address = "500 Counter Law Ave";
    const now = Date.now();
    persistScanResult({
      ...cnsObservation(address, false, new Date(now - 1_000).toISOString()), fiberAvailable: false,
      fiberStatus: "no_service", apiSource: "kinetic_live",
    }, TENANT, "counter-test", counters);
    const target = rawDb.prepare(`SELECT id FROM scan_targets WHERE address=?`).get(address) as any;
    rawDb.prepare(`INSERT INTO availability_corroboration
      (tenant_id,scan_target_id,source,source_record_id,observed_at,availability,technology,max_down_mbps,evidence_hash,import_batch_id)
      VALUES (?,?,'fcc_bdc_licensed','fcc-500',datetime('now'),'available','Fiber to the Premises',1000,'fcc-500-hash','test')`)
      .run(TENANT, target.id);

    persistScanResult({
      ...cnsObservation(address, true, new Date(now).toISOString()), fiberAvailable: true,
      fiberStatus: "new_fiber", apiSource: "kinetic_live",
    }, TENANT, "counter-test", counters);
    expect(counters.newFiber).toBe(1); // raw Kinetic hit
    expect(counters.leads).toBe(1);    // independently confirmed publication

    persistScanResult({
      ...cnsObservation("501 Baseline Counter Ave", true), fiberAvailable: true,
      fiberStatus: "new_fiber", apiSource: "kinetic_live",
    }, TENANT, "counter-test", counters);
    expect(counters.newFiber).toBe(2); // another raw hit
    expect(counters.leads).toBe(1);    // first-seen live did not become a lead
  });
});
