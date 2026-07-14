import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Budgeted scan ENGINE — verified end to end by REPLAYING real-shaped Kinetic
 * responses through the real engine code, with ZERO proxy bandwidth spent. This
 * is how we prove the money-spending pipeline (rank → persist → verify →
 * classify transition → preserve provisional evidence → resume) without a live scan or a bill.
 *
 * The fixture responses mirror real recorded Kinetic results from fiber_checks:
 * a NEW FIBER + billing-N hit (the door-knock target), a no-service miss, and a
 * failed check (timeout/error). The hard law under test: a failed check is NEVER
 * recorded as a negative and NEVER fabricates a lead.
 */

let rawDb: import("better-sqlite3").Database;
let storageMod: typeof import("../../server/storage");
let store: typeof import("../../server/scanIntelStore");
let engine: typeof import("../../server/scanEngine");
let priority: typeof import("../../shared/scanPriority");
let scoreMarket: typeof import("../../shared/marketIntel").scoreMarket;

const TENANT = 1;

// Real-shaped Kinetic ScanResult fixtures, keyed by street address.
function fixtureFor(address: string): any {
  const base = {
    address,
    city: "Testburg",
    state: "NC",
    zip: "28100",
    lat: 35.5,
    lng: -80.4,
    isTenured: false,
    maxDownloadKbps: 2000000,
    maxDownloadMbps: 2000,
    speedTier: "2gig",
    techType: "FIBER",
    chipSetType: "FTTP",
    placement: "BUR",
    maxQual: "QUAL UP TO 2 GIG RANGE VIA FIBER",
    competitorName: "Spectrum",
    competitorSpeedMbps: 1000,
    competitorTech: "Cable",
    inCompetitorArea: true,
    addressCatalogDate: "2025-11-01",
    exchangeId: "NC017",
    dfAddressId: "8000000000000043678844",
    accessId: "ACC1",
    confidence: "HIGH",
    notes: "New fiber deployment.",
    leadTag: "hot_lead",
    leadScore: 100,
    rawResponse: {
      success: true,
      address: { householdSegmentType: "NEW FIBER", billingStatus: "N" },
    },
  };
  if (address.startsWith("FAIL")) {
    return {
      ...base,
      apiSource: "failed",
      fiberStatus: "unknown",
      isNewFiber: false,
      fiberAvailable: false,
      billingStatus: null,
      householdSegmentType: null,
      confidence: "LOW",
      notes: "Check failed — no signal",
      rawResponse: undefined,
    };
  }
  if (address.startsWith("NOSVC")) {
    return {
      ...base,
      apiSource: "kinetic_live",
      fiberStatus: "no_service",
      isNewFiber: false,
      fiberAvailable: false,
      billingStatus: null,
      householdSegmentType: null,
      rawResponse: { success: false, validationResult: "AddressNotFound" },
    };
  }
  if (address.startsWith("COMING")) {
    return {
      ...base,
      apiSource: "kinetic_live",
      fiberStatus: "new_fiber",
      isNewFiber: true,
      fiberAvailable: true,
      billingStatus: "Y",
      householdSegmentType: "NEW FIBER",
      leadTag: "coming_soon",
      leadScore: 65,
      rawResponse: {
        success: true,
        address: { householdSegmentType: "NEW FIBER", billingStatus: "Y" },
      },
    };
  }
  // NEW FIBER + billing N — the target.
  return {
    ...base,
    apiSource: "kinetic_live",
    fiberStatus: "new_fiber",
    isNewFiber: true,
    fiberAvailable: true,
    billingStatus: "N",
    householdSegmentType: "NEW FIBER",
  };
}

// Replay checker — the injectable seam. Returns a real-shaped result, NO proxy.
const replay: import("../../server/scanEngine").Checker = async (a) => {
  const result = fixtureFor(a.address);
  return { result, bytes: 12000, checkFailed: result.apiSource === "failed" };
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-scan-engine-"));
  ({ rawDb } = await import("../../server/db"));
  storageMod = await import("../../server/storage");
  storageMod.runMigrations();
  store = await import("../../server/scanIntelStore");
  engine = await import("../../server/scanEngine");
  priority = await import("../../shared/scanPriority");
  ({ scoreMarket } = await import("../../shared/marketIntel"));

  // Seed a market of 8 pooled addresses, clustered so ranking has structure.
  const seed = rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, source) VALUES (?,?,?,?,?,?,'test')`,
  );
  const addrs = [
    ["100 New St", 35.5, -80.4],
    ["102 New St", 35.5001, -80.4001],
    ["104 New St", 35.5002, -80.4],
    ["NOSVC 200 Old Rd", 35.5003, -80.4002],
    ["106 New St", 35.5001, -80.4002],
    ["FAIL 300 Timeout Ave", 35.5002, -80.4003],
    ["108 New St", 35.5, -80.4003],
    ["110 New St", 35.5003, -80.4001],
  ] as const;
  for (const [a, lat, lng] of addrs)
    seed.run(a, "Testburg", "NC", "28100", lat, lng);
});

describe("budgeted scan engine (replay — zero proxy)", () => {
  it("silently enrolls active-service NEW FIBER in prioritized monitoring without creating a lead", async () => {
    const inserted = rawDb.prepare(`INSERT INTO scan_targets
      (tenant_id,address,city,state,zip,lat,lng,source) VALUES (1,'COMING 12 Watch Way','Monitorburg','NC','28100',35.51,-80.41,'test')`).run();
    const runId = "run_coming_soon_watch";
    store.createScanRun({ id: runId, tenantId: TENANT, kind: "address_discovery", label: "Coming Soon watch", city: "Monitorburg", state: "NC", budget: 1 });
    store.enqueueRunTargets(runId, [{ id: Number(inserted.lastInsertRowid), seq: 0 }]);

    await engine.runScanWorker(runId, TENANT, replay);

    expect(store.getRun(runId, TENANT)).toMatchObject({ status: "done", verified: 1, newFiber: 0 });
    expect(rawDb.prepare(`SELECT is_coming_soon AS isComingSoon,is_live AS isLive
      FROM kinetic_addresses WHERE tenant_id=? AND lower(address)=lower(?)`).get(TENANT, "COMING 12 Watch Way"))
      .toEqual({ isComingSoon: 1, isLive: 1 });
    expect(storageMod.storage.getLeads(TENANT).some((lead: any) => lead.address === "COMING 12 Watch Way")).toBe(false);
  });

  it("fails closed without an authorized provider session and never records a false negative", async () => {
    const priorAuthorization = process.env.KFS_AUTOMATION_AUTHORIZED;
    delete process.env.KFS_AUTOMATION_AUTHORIZED;
    const inserted = rawDb
      .prepare(
        `INSERT INTO scan_targets
      (tenant_id,address,city,state,zip,lat,lng,source) VALUES (?,?,?,?,?,?,?,'test')`,
      )
      .run(TENANT, "900 Offline Way", "Safetown", "NC", "28109", 35.6, -80.5);
    const targetId = Number(inserted.lastInsertRowid);
    const runId = "run_offline_evidence";
    store.createScanRun({
      id: runId,
      tenantId: TENANT,
      kind: "address_discovery",
      label: "Offline evidence",
      city: "Safetown",
      state: "NC",
      budget: 1,
    });
    store.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);

    try {
      await engine.runScanWorker(runId, TENANT);
    } finally {
      if (priorAuthorization === undefined)
        delete process.env.KFS_AUTOMATION_AUTHORIZED;
      else process.env.KFS_AUTOMATION_AUTHORIZED = priorAuthorization;
    }

    expect(store.getRun(runId, TENANT)).toMatchObject({
      status: "done",
      verified: 0,
      failed: 1,
    });
    const target = rawDb
      .prepare(
        `SELECT last_scanned_at AS lastScannedAt,last_availability_status AS status
      FROM scan_targets WHERE id=?`,
      )
      .get(targetId) as any;
    expect(target).toEqual({ lastScannedAt: null, status: null });
  });

  it("ranks, verifies, records evidence, keeps baseline-live results provisional, and stays truthful about failures", async () => {
    const targets = store.getPoolTargetsForCity("Testburg", "NC");
    expect(targets.length).toBe(8);
    const ranked = priority.rankTargets(targets, [{ lat: 35.5, lng: -80.4 }], {
      nowMs: Date.now(),
    });

    const runId = "run_test_1";
    store.createScanRun({
      id: runId,
      tenantId: TENANT,
      kind: "market",
      label: "Scan Testburg",
      city: "Testburg",
      state: "NC",
      budget: 8,
    });
    store.enqueueRunTargets(
      runId,
      ranked.map((r) => ({ id: r.id, seq: r.seq })),
    );

    await engine.runScanWorker(runId, TENANT, replay); // awaited → deterministic

    const run = store.getRun(runId, TENANT)!;
    expect(run.status).toBe("done");
    expect(run.verified).toBe(7); // 8 checked, 1 failed → 7 verified
    expect(run.failed).toBe(1);
    expect(run.newFiber).toBe(6); // 6 NEW FIBER targets (8 - 1 nosvc - 1 fail)
    expect(run.estBytes).toBe(8 * 12000); // every check (incl. failed) costs bytes

    // First observations establish a baseline. They are not proven fresh flips
    // and must never leak into the rep-facing lead table.
    const leads = storageMod.storage
      .getLeads(TENANT)
      .filter((l: any) => l.city === "Testburg");
    expect(leads.length).toBe(0);

    // FAILED address: pool row was NOT touched (no availability recorded), and no
    // lead exists for it. Product law — a non-answer is not a "no".
    const failRow: any = rawDb
      .prepare(
        `SELECT last_scanned_at, last_availability_status, scan_count FROM scan_targets WHERE address = ?`,
      )
      .get("FAIL 300 Timeout Ave");
    expect(failRow.last_scanned_at).toBeNull();
    expect(failRow.last_availability_status).toBeNull();
    expect(failRow.scan_count).toBe(0);
    const failTarget: any = rawDb
      .prepare(
        `SELECT t.target_id, t.state AS state FROM scan_run_targets t JOIN scan_targets s ON s.id=t.target_id WHERE s.address=? AND t.run_id=?`,
      )
      .get("FAIL 300 Timeout Ave", runId);
    expect(failTarget.state).toBe("failed");

    // No-service address: pool row WAS recorded (a real negative), no lead.
    const noSvc: any = rawDb
      .prepare(
        `SELECT last_scanned_at, last_availability_status FROM scan_targets WHERE address = ?`,
      )
      .get("NOSVC 200 Old Rd");
    expect(noSvc.last_scanned_at).not.toBeNull();
    expect(noSvc.last_availability_status).toBe("checked_unavailable");

    // Evidence preserved: every attempt, including a failed provider response, is
    // append-only so the sweep has a complete audit trail without changing truth.
    const evidence: any = rawDb
      .prepare(
        `SELECT COUNT(*) c FROM fiber_checks WHERE address LIKE '%Testburg%'`,
      )
      .get();
    expect(evidence.c).toBe(8);
    const snapshots: any = rawDb
      .prepare(`SELECT COUNT(*) c FROM availability_snapshots WHERE run_id=?`)
      .get(runId);
    expect(snapshots.c).toBe(8);
    const failedSnapshot: any = rawDb
      .prepare(
        `SELECT conclusive, error FROM availability_snapshots WHERE run_id=? AND scan_target_id=?`,
      )
      .get(runId, failTarget.target_id);
    expect(failedSnapshot.conclusive).toBe(0);
    expect(failedSnapshot.error).toBeTruthy();

    // The canonical operations stream is durable and replayable. It records
    // lifecycle + per-address outcomes without exposing raw provider payloads.
    const events: any[] = rawDb
      .prepare(
        `SELECT event_type FROM fiber_job_events WHERE run_id=? ORDER BY sequence`,
      )
      .all(runId) as any[];
    expect(events[0].event_type).toBe("job.started");
    expect(
      events.filter((event) => event.event_type === "address.completed"),
    ).toHaveLength(7);
    expect(
      events.filter((event) => event.event_type === "address.failed"),
    ).toHaveLength(1);
    expect(events.at(-1)?.event_type).toBe("job.completed");
    const freshness: any = rawDb
      .prepare(
        `SELECT COUNT(*) AS count FROM fiber_freshness_scores WHERE tenant_id=?`,
      )
      .get(TENANT);
    expect(freshness.count).toBeGreaterThanOrEqual(8);
    const failureAudit: any = rawDb
      .prepare(
        `SELECT category,attempt FROM fiber_job_failures WHERE run_id=? AND target_id=?`,
      )
      .get(runId, failTarget.target_id);
    expect(failureAudit).toMatchObject({
      category: "inconclusive",
      attempt: 1,
    });
  });

  it("detects a provable unavailable->live flip as newly_live on rescan", async () => {
    // Pre-seed one target as previously scanned + NOT live.
    const info = rawDb
      .prepare(
        `INSERT INTO scan_targets (address, city, state, zip, lat, lng, source, last_scanned_at, last_is_new_fiber, last_billing_status, last_availability_status, scan_count)
                   VALUES ('500 Flip Ln','Flipville','NC','28101',35.6,-80.5,'test',datetime('now','-10 days'),0,NULL,'checked_unavailable',1)`,
      )
      .run();
    const id = Number(info.lastInsertRowid);

    const runId = "run_test_flip";
    store.createScanRun({
      id: runId,
      tenantId: TENANT,
      kind: "rescan",
      label: "Rescan Flipville",
      city: "Flipville",
      state: "NC",
      budget: 1,
    });
    store.enqueueRunTargets(runId, [{ id, seq: 0 }]);
    // The fixture returns NEW FIBER for "500 Flip Ln" (default branch).
    await engine.runScanWorker(runId, TENANT, replay);

    const run = store.getRun(runId, TENANT)!;
    expect(run.newlyLive).toBe(1);
    const row: any = rawDb
      .prepare(
        `SELECT last_availability_status, first_seen_live_at FROM scan_targets WHERE id=?`,
      )
      .get(id);
    expect(row.last_availability_status).toBe("newly_live");
    expect(row.first_seen_live_at).not.toBeNull();
  });

  it("learning loop: a worked territory's outcome accumulates into its market", async () => {
    const svc = await import("../../server/scanService");
    // Seed 5 leads in 'Learnville' assigned to territory 777, 2 sold, with knocks.
    const insLead = rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, lat, lng, fiber_status, is_new_fiber, lead_status, assigned_territory_id, tenant_id, lead_score, created_at, updated_at) VALUES (?,?,?,?,?,?,'unknown',0,?,777,1,100,datetime('now'),datetime('now'))`,
    );
    const leadIds: number[] = [];
    for (let i = 0; i < 5; i++)
      leadIds.push(
        Number(
          insLead.run(
            `${i} Learn St`,
            "Learnville",
            "NC",
            "28200",
            35.9 + i * 1e-4,
            -80.9,
            i < 2 ? "sold" : "prospect",
          ).lastInsertRowid,
        ),
      );
    const insKnock = rawDb.prepare(
      `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at) VALUES (?,1,?,?,datetime('now'))`,
    );
    for (const id of leadIds) insKnock.run(id, "interested", 1); // 5 contacts
    insKnock.run(leadIds[0], "sold", 1);
    insKnock.run(leadIds[1], "sold", 1);

    const outcome = svc.recordTerritoryOutcome(
      TENANT,
      777,
      new Date(Date.now() - 3 * 86400000).toISOString(),
    );
    expect(outcome).not.toBeNull();
    expect(outcome!.city).toBe("Learnville");
    expect(outcome!.doors).toBe(5);
    expect(outcome!.sales).toBe(2);
    expect(outcome!.knocks).toBe(7);

    // The outcome landed in the market's memory (the learning-loop write).
    const row: any = rawDb
      .prepare(
        `SELECT knocks, sales FROM market_outcomes WHERE tenant_id=1 AND lower(city)='learnville'`,
      )
      .get();
    expect(row.knocks).toBe(7);
    expect(row.sales).toBe(2);

    // And once a market has ENOUGH field evidence, proven conversion lifts its
    // priority (small samples deliberately don't move it — honesty over noise).
    const mkt = {
      city: "Learnville",
      state: "NC",
      poolSize: 500,
      verified: 100,
      verifiedNewFiber: 40,
      newlyLive: 0,
      leads: 40,
      unworkedLeads: 20,
      workedLeads: 20,
      soldLeads: 2,
      lastVerifiedAtMs: Date.now() - 86400000,
    };
    const before = scoreMarket({ ...mkt, outcome: null }, Date.now());
    const proven = scoreMarket(
      {
        ...mkt,
        outcome: {
          knocks: 60,
          contacts: 30,
          sales: 12,
          lastDeployedAtMs: Date.now(),
        },
      },
      Date.now(),
    );
    const busted = scoreMarket(
      {
        ...mkt,
        outcome: {
          knocks: 60,
          contacts: 8,
          sales: 0,
          lastDeployedAtMs: Date.now(),
        },
      },
      Date.now(),
    );
    expect(proven.priority).toBeGreaterThan(before.priority);
    expect(busted.priority).toBeLessThan(before.priority);
  });

  it("delete detaches leads instead of orphaning them", async () => {
    const svc = await import("../../server/scanService");
    const ins = rawDb.prepare(
      `INSERT INTO leads (address, city, state, zip, lat, lng, fiber_status, is_new_fiber, lead_status, assigned_rep_id, assigned_territory_id, tenant_id, created_at, updated_at) VALUES (?,?,?,?,?,?,'unknown',0,'prospect',9,888,1,datetime('now'),datetime('now'))`,
    );
    const id = Number(
      ins.run("1 Orphan Rd", "Orphanton", "NC", "28201", 35.1, -80.1)
        .lastInsertRowid,
    );
    const detached = svc.detachTerritoryLeads(888);
    expect(detached).toBe(1);
    const row: any = rawDb
      .prepare(
        `SELECT assigned_territory_id, assigned_rep_id FROM leads WHERE id=?`,
      )
      .get(id);
    expect(row.assigned_territory_id).toBeNull(); // no orphan ref
    expect(row.assigned_rep_id).toBe(9); // rep assignment preserved
  });

  it("resumes a run from its persisted queue (survives 'restart')", async () => {
    // Seed a fresh market and enqueue, but only run PART of it, then 'restart'.
    const seed = rawDb.prepare(
      `INSERT INTO scan_targets (address, city, state, zip, lat, lng, source) VALUES (?,?,?,?,?,?,'test')`,
    );
    for (let i = 0; i < 6; i++)
      seed.run(
        `${i} Resume Way`,
        "Resumeton",
        "NC",
        "28102",
        35.7 + i * 0.0001,
        -80.6,
      );
    const targets = store.getPoolTargetsForCity("Resumeton", "NC");
    const ranked = priority.rankTargets(targets, [], { nowMs: Date.now() });
    const runId = "run_test_resume";
    store.createScanRun({
      id: runId,
      tenantId: TENANT,
      kind: "market",
      label: "Scan Resumeton",
      city: "Resumeton",
      state: "NC",
      budget: 6,
    });
    store.enqueueRunTargets(
      runId,
      ranked.map((r) => ({ id: r.id, seq: r.seq })),
    );

    // Simulate a crash after 2 checks: atomically claim + finalize 2 targets,
    // then leave one target CLAIMED but unfinished ('inflight' — mid-check crash)
    // and the rest queued, status 'running' with a stale heartbeat.
    const firstTwo = store.claimRunTargets(runId, 2);
    for (const t of firstTwo)
      store.finalizeRunTarget(runId, t.targetId, "verified", "other", {
        verified: 1,
        estBytes: 12000,
      });
    const orphaned = store.claimRunTargets(runId, 1); // claimed → inflight, never finalized (crash)
    expect(orphaned.length).toBe(1);
    rawDb
      .prepare(
        `UPDATE scan_runs SET heartbeat_at = datetime('now','-60 seconds') WHERE id=?`,
      )
      .run(runId);

    // Resume must find it, RESET the orphaned inflight claim to queued, and finish.
    const resumable = store.getResumableRuns(30).map((r) => r.id);
    expect(resumable).toContain(runId);
    store.resetInflightTargets(runId);
    await engine.runScanWorker(runId, TENANT, replay);

    const run = store.getRun(runId, TENANT)!;
    expect(run.status).toBe("done");
    expect(run.verified + run.failed).toBe(6); // all six eventually processed
    expect(store.countQueued(runId)).toBe(0);
  });
});
