import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let store: typeof import("../../server/scanIntelStore");
let engine: typeof import("../../server/scanEngine");
let events: typeof import("../../server/scanEvents");
let normalizeKey: typeof import("../../server/addressKey").normalizeKineticAddressKey;
let targetId: number;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-inspector-lifecycle-"));
  const { rawDb } = await import("../../server/db");
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/scanIntelStore");
  engine = await import("../../server/scanEngine");
  events = await import("../../server/scanEvents");
  ({ normalizeKineticAddressKey: normalizeKey } = await import("../../server/addressKey"));
  events.startScanEvents();
  targetId = Number(rawDb.prepare(
    `INSERT INTO scan_targets (address, city, state, zip, lat, lng, source)
     VALUES ('100 Lifecycle Dr','Apex','NC','27502',35.7,-78.8,'test')`,
  ).run().lastInsertRowid);
});

describe("scan engine inspector lifecycle", () => {
  it("finishes persisted checks as Classified after Saving and keeps provider latency", async () => {
    const runId = "run_inspector_lifecycle";
    store.createScanRun({
      id: runId, tenantId: 1, kind: "address_discovery",
      label: "inspector lifecycle", city: "Apex", state: "NC", budget: 1,
    });
    store.enqueueRunTargets(runId, [{ id: targetId, seq: 0 }]);

    const checker: import("../../server/scanEngine").Checker = async (a) => ({
      result: {
        address: a.address, city: a.city, state: a.state, zip: a.zip,
        lat: 35.7, lng: -78.8,
        fiberStatus: "no_service", fiberAvailable: false,
        isNewFiber: false, isTenured: false,
        billingStatus: null, householdSegmentType: null,
        apiSource: "kinetic_live", blocked: false, confidence: "HIGH",
        notes: "AddressUnserviceableOutOfTerritory",
        providerLatencyMs: 543,
        rawResponse: { success: false, validationResult: "AddressUnserviceableOutOfTerritory" },
      } as any,
      bytes: 12_000,
      checkFailed: false,
    });

    await engine.runScanWorker(runId, 1, checker);

    const key = normalizeKey("100 Lifecycle Dr", "Apex", "NC", "27502");
    const timeline = events.getAddressTimeline(key, 20);
    expect(timeline.slice(-2).map((event) => event.stage)).toEqual(["saving", "classified"]);
    expect(timeline.at(-1)).toMatchObject({
      stage: "classified",
      status: "ok",
      classification: "no_service",
      latencyMs: 543,
      detail: "snapshot saved · no_service",
    });

    const snapshot = events.getInspectorSnapshot({ runId, limit: 20 });
    expect(snapshot.rows[0]).toMatchObject({ stage: "classified", classification: "no_service", latencyMs: 543 });
    expect(snapshot.counters).toMatchObject({ found: 1, checked: 1, checking: 0 });
  });
});
