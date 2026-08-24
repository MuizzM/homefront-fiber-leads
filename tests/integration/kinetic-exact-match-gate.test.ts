import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KINETIC_345_JAMES_ALLGOOD as EXACT_FRESH } from "../fixtures/kinetic345JamesAllgood";

const { proxyFetch, rotateProxySession } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  rotateProxySession: vi.fn(async () => {}),
}));

vi.mock("../../server/proxy-fetch", () => ({
  proxyFetch,
  rotateProxySession,
  advanceProxyEgress: async () => {},
  // Direct carrier egress is OFF, exactly as an unconfigured deployment has it
  // (server/proxy-fetch.ts). directCarrierFetch throws here for the same reason
  // it throws in production: a test that reaches it is leaking, and should say so.
  setEgressGenerationHook: () => {},
  directCarrierEgressAllowed: () => false,
  directCarrierFetch: async () => { throw new Error("direct carrier egress is off"); },
  getProxySessionId: () => "exact-match-gate-session",
  isProxyConnected: () => true,
  getProxyStatus: () => ({
    enabled: true,
    url: "http://redacted@proxy",
    slots: 1,
    sessionId: "exact-match-gate-session",
  }),
}));

vi.mock("../../server/distributedProviderCoordinator", () => {
  class DistributedProviderCoordinator<T> {
    async execute(_key: string, _source: string, task: () => Promise<T>): Promise<T> {
      return task();
    }
    pauseFor() { return Date.now(); }
    halt() {}
    resume() {}
    snapshot() {
      return {
        active: 0,
        queued: 0,
        startsLastMinute: 0,
        maxConcurrency: 1,
        maxRequestsPerMinute: 100,
        pausedUntil: null,
        halted: false,
        haltReason: null,
        instanceId: "exact-match-gate-test",
      };
    }
  }
  return { DistributedProviderCoordinator, DistributedProviderHaltedError: Error };
});

let rawDb: import("better-sqlite3").Database;
let scanner: typeof import("../../server/scanner");
let scanEngine: typeof import("../../server/scanEngine");
let scanStore: typeof import("../../server/scanIntelStore");
let projectConfirmedFreshLeads: typeof import("../../server/freshFiberProjector").projectConfirmedFreshLeads;
let recordAvailabilitySnapshot: typeof import("../../server/availabilitySnapshot").recordAvailabilitySnapshot;

const TENANT = 1;
let manualTokenSequence = 0;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installSearchHandler(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  proxyFetch.mockReset();
  proxyFetch.mockImplementation(async (url: string, init?: RequestInit) =>
    url.includes("/address/search")
      ? handler(url, init)
      : json(200, { access_token: "exact-match-gate-minted-token", expires_in: 2_100 }));
  manualTokenSequence += 1;
  scanner.setManualToken(`exact-match-gate-manual-token-${manualTokenSequence}`);
}

function installResponse(response: unknown): void {
  installSearchHandler(() => json(200, response));
}

function seedTarget(address: string, city: string, state: string, zip: string, lat: number, lng: number): number {
  return Number(rawDb.prepare(
    `INSERT INTO scan_targets
      (address, city, state, zip, lat, lng, tenant_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'test')`,
  ).run(address, city, state, zip, lat, lng, TENANT).lastInsertRowid);
}

async function passThroughWorker(
  runId: string,
  targetId: number,
  result: import("../../server/scanner").ScanResult,
): Promise<void> {
  const target = rawDb.prepare(
    "SELECT city, state FROM scan_targets WHERE id=?",
  ).get(targetId) as { city: string; state: string };
  scanStore.createScanRun({
    id: runId,
    tenantId: TENANT,
    kind: "manual",
    label: "Exact-match gate",
    city: target.city,
    state: target.state,
    budget: 1,
  });
  scanStore.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);
  await scanEngine.runScanWorker(runId, TENANT, async () => ({
    result,
    bytes: 12_000,
    checkFailed: result.apiSource === "failed",
  }));
}

function conclusiveSnapshotCount(targetId: number): number {
  return Number((rawDb.prepare(
    "SELECT COUNT(*) AS count FROM availability_snapshots WHERE scan_target_id=? AND conclusive=1",
  ).get(targetId) as { count: number }).count);
}

function projectedLeadCount(targetId: number): number {
  return Number((rawDb.prepare(
    "SELECT COUNT(*) AS count FROM leads WHERE tenant_id=? AND source_scan_target_id=?",
  ).get(TENANT, targetId) as { count: number }).count);
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-kinetic-exact-match-gate-"));
  process.env.NODE_ENV = "test";
  process.env.KFS_AUTOMATION_AUTHORIZED = "false";
  process.env.KFS_TOKEN_POOL_WARM_MIN = "0";
  process.env.KFS_MINT_MIN_INTERVAL_MS = "0";

  proxyFetch.mockImplementation(async () =>
    json(200, { access_token: "exact-match-gate-bootstrap-token", expires_in: 2_100 }));

  ({ rawDb } = await import("../../server/db"));
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  scanner = await import("../../server/scanner");
  scanEngine = await import("../../server/scanEngine");
  scanStore = await import("../../server/scanIntelStore");
  projectConfirmedFreshLeads = (await import("../../server/freshFiberProjector")).projectConfirmedFreshLeads;
  recordAvailabilitySnapshot = (await import("../../server/availabilitySnapshot")).recordAvailabilitySnapshot;
  process.env.KFS_AUTOMATION_AUTHORIZED = "true";
});

describe("Kinetic exact-address and explicit-availability gates", () => {
  it("keeps exactMatch=false NEW FIBER/N/fiber unresolved and out of snapshots and leads", async () => {
    const requested = {
      address: "100 Fuzzy Gate Ln",
      city: "Concord",
      state: "NC",
      zip: "28025",
      lat: 35.4081,
      lng: -80.5794,
    };
    const targetId = seedTarget(
      requested.address,
      requested.city,
      requested.state,
      requested.zip,
      requested.lat,
      requested.lng,
    );
    installResponse({
      ...EXACT_FRESH,
      exactMatch: false,
      address: {
        ...EXACT_FRESH.address,
        addressLine1: "999 WRONG ROOFTOP RD",
        city: "CONCORD",
        stateProvinceCd: "NC",
        postalCd: "28025",
      },
    });

    const result = await scanner.scanAddress(
      requested.address,
      requested.city,
      requested.state,
      requested.zip,
      { source: "manual" },
    );

    expect(result).toMatchObject({
      apiSource: "failed",
      fiberStatus: "unknown",
      isNewFiber: false,
      fiberAvailable: false,
    });
    expect(result.notes).toMatch(/failed address identity/i);
    expect(result.fiberStatus).not.toBe("no_service");

    await passThroughWorker("run_exact_gate_fuzzy", targetId, result);
    expect(conclusiveSnapshotCount(targetId)).toBe(0);
    expect(projectedLeadCount(targetId)).toBe(0);
  });

  it("keeps exactMatch=true unresolved when the echoed address is a different canonical rooftop", async () => {
    const targetId = seedTarget(
      "101 Exact Flag Wrong Echo Ln",
      "Concord",
      "NC",
      "28025",
      35.4082,
      -80.5795,
    );
    installResponse({
      ...EXACT_FRESH,
      exactMatch: true,
      address: {
        ...EXACT_FRESH.address,
        addressLine1: "999 DIFFERENT ROOFTOP RD",
        city: "CONCORD",
        stateProvinceCd: "NC",
        postalCd: "28025",
      },
    });

    const result = await scanner.scanAddress(
      "101 Exact Flag Wrong Echo Ln",
      "Concord",
      "NC",
      "28025",
      { source: "manual" },
    );

    expect(result).toMatchObject({
      apiSource: "failed",
      fiberStatus: "unknown",
      isNewFiber: false,
      fiberAvailable: false,
    });
    expect(result.notes).toMatch(/echoedIdentity=mismatch/);

    await passThroughWorker("run_exact_gate_wrong_echo", targetId, result);
    expect(conclusiveSnapshotCount(targetId)).toBe(0);
    expect(projectedLeadCount(targetId)).toBe(0);
  });

  it("keeps a successful response without AddressFound unresolved and unprojected", async () => {
    const requested = {
      address: "102 Missing AddressFound Ln",
      city: "Concord",
      state: "NC",
      zip: "28025",
      lat: 35.4083,
      lng: -80.5796,
    };
    const targetId = seedTarget(
      requested.address,
      requested.city,
      requested.state,
      requested.zip,
      requested.lat,
      requested.lng,
    );
    installResponse({
      ...EXACT_FRESH,
      validationResult: "AddressSuggestions",
      exactMatch: true,
      address: {
        ...EXACT_FRESH.address,
        city: "CONCORD",
        stateProvinceCd: "NC",
        postalCd: "28025",
      },
    });

    const result = await scanner.scanAddress(
      requested.address,
      requested.city,
      requested.state,
      requested.zip,
      { source: "manual" },
    );

    expect(result).toMatchObject({
      apiSource: "failed",
      fiberStatus: "unknown",
      isNewFiber: false,
      fiberAvailable: false,
    });
    expect(result.notes).toMatch(/validation=AddressSuggestions/);
    expect(result.fiberStatus).not.toBe("no_service");

    await passThroughWorker("run_exact_gate_not_found", targetId, result);
    expect(conclusiveSnapshotCount(targetId)).toBe(0);
    expect(projectedLeadCount(targetId)).toBe(0);
  });

  it("keeps an explicit AddressNotFound response conclusive without creating a lead", async () => {
    const requested = {
      address: "103 Explicit No Service Ln",
      city: "Concord",
      state: "NC",
      zip: "28025",
      lat: 35.4084,
      lng: -80.5797,
    };
    const targetId = seedTarget(
      requested.address,
      requested.city,
      requested.state,
      requested.zip,
      requested.lat,
      requested.lng,
    );
    installResponse({
      success: true,
      validationResult: "AddressNotFound",
      errorCode: 0,
      techType: "",
      maxQual: "",
      dfAddressId: "",
      accessId: "",
      exchangeId: "",
      exactMatch: false,
      fiberFastFlag: false,
    });

    const result = await scanner.scanAddress(
      requested.address,
      requested.city,
      requested.state,
      requested.zip,
      { source: "manual" },
    );

    expect(result).toMatchObject({
      apiSource: "kinetic_live",
      fiberStatus: "no_service",
      confidence: "HIGH",
      isNewFiber: false,
    });

    await passThroughWorker("run_exact_gate_explicit_no_service", targetId, result);
    expect(conclusiveSnapshotCount(targetId)).toBe(1);
    expect(projectedLeadCount(targetId)).toBe(0);
  });

  it("rejects NEW FIBER/N projection when fiber availability is null", () => {
    const targetId = seedTarget(
      "104 Null Fiber Ln",
      "Concord",
      "NC",
      "28025",
      35.4085,
      -80.5798,
    );
    rawDb.prepare(
      `UPDATE scan_targets
          SET first_seen_fiber_at=datetime('now'),
              -- Deliberately stale target memory: the latest same-epoch snapshot
              -- below is null and must win over this historical true.
              last_fiber_available=1,
              last_fiber_status='new_fiber',
              last_billing_status='N',
              last_customer_segment='new_opportunity'
        WHERE id=?`,
    ).run(targetId);
    recordAvailabilitySnapshot({
      tenantId: TENANT,
      scanTargetId: targetId,
      runId: "null-fiber-evidence",
      conclusive: true,
      fiberAvailable: null,
      fiberStatus: "new_fiber",
      householdSegmentType: "NEW FIBER",
      billingStatus: "N",
      transitionStatus: "baseline_available",
      apiSource: "kinetic_live",
      evidenceHash: "null-fiber-evidence-hash",
    });

    const projection = projectConfirmedFreshLeads(TENANT, [targetId]);

    expect(projection).toMatchObject({
      considered: 1,
      created: 0,
      published: 0,
      rejected: 1,
    });
    expect(projectedLeadCount(targetId)).toBe(0);
  });

  it("preserves competitive suppression for an explicit false latest availability tuple", () => {
    const targetId = seedTarget(
      "106 Explicit False Competitor Ln",
      "Concord",
      "NC",
      "28025",
      35.4087,
      -80.5800,
    );
    rawDb.prepare(
      `UPDATE scan_targets
          SET first_seen_fiber_at='2026-07-27T12:00:00.000Z',
              last_fiber_available=1,
              last_fiber_status='new_fiber',
              last_billing_status='N',
              last_customer_segment='new_opportunity'
        WHERE id=?`,
    ).run(targetId);
    recordAvailabilitySnapshot({
      tenantId: TENANT,
      scanTargetId: targetId,
      runId: "explicit-false-control-live",
      checkedAt: "2026-07-27T12:00:00.000Z",
      conclusive: true,
      fiberAvailable: true,
      fiberStatus: "new_fiber",
      householdSegmentType: "NEW FIBER",
      billingStatus: "N",
      transitionStatus: "baseline_available",
      apiSource: "kinetic_live",
      evidenceHash: "explicit-false-control-live-hash",
    });
    expect(projectConfirmedFreshLeads(TENANT, [targetId]).created).toBe(1);
    const lead = rawDb.prepare(
      "SELECT id, lead_status FROM leads WHERE tenant_id=? AND source_scan_target_id=?",
    ).get(TENANT, targetId) as { id: number; lead_status: string };
    expect(lead.lead_status).toBe("prospect");

    // Keep scan_targets memory deliberately true. The latest conclusive snapshot
    // is explicitly false and carries the same-epoch competitor decision.
    recordAvailabilitySnapshot({
      tenantId: TENANT,
      scanTargetId: targetId,
      runId: "explicit-false-fiber-competitor",
      checkedAt: "2026-07-27T12:01:00.000Z",
      conclusive: true,
      fiberAvailable: false,
      fiberStatus: "no_service",
      householdSegmentType: "NEW FIBER",
      billingStatus: "N",
      transitionStatus: "became_unavailable",
      apiSource: "kinetic_live",
      competitorName: "Fiber Rival",
      competitorTech: "FTTH",
      evidenceHash: "explicit-false-fiber-competitor-hash",
    });

    const projection = projectConfirmedFreshLeads(TENANT, [targetId]);
    expect(projection.rejected).toBe(1);
    expect((rawDb.prepare(
      "SELECT lead_status FROM leads WHERE id=?",
    ).get(lead.id) as { lead_status: string }).lead_status).toBe("competitor_suppressed");
  });

  it("does not attach a materially-different suggestion's exact result to the original target", async () => {
    const typo = {
      address: "345 Jame Allgod Drive",
      city: "Inman",
      state: "SC",
      zip: "29349",
    };
    const targetId = seedTarget(typo.address, typo.city, typo.state, typo.zip, 35.0204, -82.0785);
    const searched: string[] = [];
    installSearchHandler((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const requestedAddress = String(body.addressLine1 ?? "");
      searched.push(requestedAddress);
      if (requestedAddress === "345 James Allgood Dr") return json(200, EXACT_FRESH);
      return json(200, {
        success: false,
        validationResult: "AddressNeedsFix",
        errorCode: 0,
        techType: "",
        maxQual: "",
        dfAddressId: "",
        accessId: "",
        exchangeId: "",
        exactMatch: false,
        fiberFastFlag: false,
        addressCandidates: [{
          addressLine1: "345 James Allgood Dr",
          city: "Inman",
          stateProvinceCd: "SC",
          postalCd: "29349",
        }],
      });
    });

    const result = await scanner.scanAddress(
      typo.address,
      typo.city,
      typo.state,
      typo.zip,
      { source: "manual" },
    );
    expect(searched).toEqual([typo.address, "345 James Allgood Dr"]);
    expect(result).toMatchObject({
      apiSource: "failed",
      fiberStatus: "unknown",
      isNewFiber: false,
    });
    expect(result.notes).toMatch(/materially different address/i);

    await passThroughWorker("run_exact_gate_suggestion_changed_identity", targetId, result);
    expect(conclusiveSnapshotCount(targetId)).toBe(0);
    expect(projectedLeadCount(targetId)).toBe(0);
  });

  it("preserves exact active-service and explicit Coming Soon controls without publishing leads", async () => {
    const controls = [
      {
        address: "200 Active Service Dr",
        segment: "NEW FIBER",
        billing: "Y",
        expectedFiberStatus: "new_fiber",
      },
      {
        address: "202 Coming Soon Dr",
        segment: "COMING SOON",
        billing: "N",
        expectedFiberStatus: "existing_fiber",
      },
    ];

    for (const [index, control] of controls.entries()) {
      const targetId = seedTarget(
        control.address,
        "Inman",
        "SC",
        "29349",
        35.021 + index * 0.0002,
        -82.079 - index * 0.0002,
      );
      installResponse({
        ...EXACT_FRESH,
        address: {
          ...EXACT_FRESH.address,
          addressLine1: control.address.toUpperCase(),
          householdSegmentType: control.segment,
          billingStatus: control.billing,
          geoLat: String(35.021 + index * 0.0002),
          geoLong: String(-82.079 - index * 0.0002),
        },
      });
      const result = await scanner.scanAddress(
        control.address,
        "Inman",
        "SC",
        "29349",
        { source: "manual" },
      );
      expect(result).toMatchObject({
        apiSource: "kinetic_live",
        fiberAvailable: true,
        fiberStatus: control.expectedFiberStatus,
        householdSegmentType: control.segment,
        billingStatus: control.billing,
      });

      await passThroughWorker(`run_exact_gate_control_${index}`, targetId, result);
      expect(conclusiveSnapshotCount(targetId)).toBe(1);
      expect(projectedLeadCount(targetId)).toBe(0);
    }
  });

  it("preserves the exact AddressFound NEW FIBER/N/fiber control through snapshot and projection", async () => {
    const targetId = seedTarget(
      "345 James Allgood Dr",
      "Inman",
      "SC",
      "29349",
      35.020537,
      -82.078668,
    );
    installResponse(EXACT_FRESH);

    const result = await scanner.scanAddress(
      "345 James Allgood Dr",
      "Inman",
      "SC",
      "29349",
      { source: "manual" },
    );

    expect(result).toMatchObject({
      apiSource: "kinetic_live",
      fiberStatus: "new_fiber",
      isNewFiber: true,
      fiberAvailable: true,
      householdSegmentType: "NEW FIBER",
      billingStatus: "N",
    });

    await passThroughWorker("run_exact_gate_control", targetId, result);
    expect(conclusiveSnapshotCount(targetId)).toBe(1);
    expect(projectedLeadCount(targetId)).toBe(1);
    expect(rawDb.prepare(
      `SELECT lead_tag, fiber_status, household_segment_type, billing_status
         FROM leads WHERE tenant_id=? AND source_scan_target_id=?`,
    ).get(TENANT, targetId)).toMatchObject({
      lead_tag: "fresh_fiber_confirmed",
      fiber_status: "new_fiber",
      household_segment_type: "NEW FIBER",
      billing_status: "N",
    });
  });
});
