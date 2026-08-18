import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runScanWorker = vi.fn(async () => undefined);
vi.mock("../../server/scanEngine", () => ({
  runScanWorker,
  isRunActive: () => false,
}));

let rawDb: import("better-sqlite3").Database;
let storage: (typeof import("../../server/storage"))["storage"];
let scanStore: typeof import("../../server/scanIntelStore");
let scanService: typeof import("../../server/scanService");
let olderTarget = 0;
let newerTarget = 0;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-lead-scan-recency-"));
  process.env.NODE_ENV = "test";
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  ({ rawDb } = await import("../../server/db"));
  scanStore = await import("../../server/scanIntelStore");
  scanService = await import("../../server/scanService");

  const addTarget = rawDb.prepare(
    `INSERT INTO scan_targets
      (tenant_id,address,city,state,zip,lat,lng,source,last_scanned_at)
     VALUES (1,?,?,?,?,?,?,'test',?)`,
  );
  olderTarget = Number(addTarget.run("10 Older Scan Rd", "Concord", "NC", "28025", 35.40, -80.58, "2026-08-17 23:30:00").lastInsertRowid);
  newerTarget = Number(addTarget.run("20 Newer Scan Rd", "Concord", "NC", "28025", 35.41, -80.59, "2026-08-18T08:30:00.000Z").lastInsertRowid);

  const addLead = rawDb.prepare(
    `INSERT INTO leads
      (tenant_id,address,city,state,zip,lead_status,fiber_status,source_scan_target_id,created_at,updated_at)
     VALUES (1,?,?,?,?, 'prospect','unknown',?,?,?)`,
  );
  // Creation order intentionally opposes scan order.
  addLead.run("10 Older Scan Rd", "Concord", "NC", "28025", olderTarget, "2026-08-18T10:00:00.000Z", "2026-08-18T10:00:00.000Z");
  addLead.run("20 Newer Scan Rd", "Concord", "NC", "28025", newerTarget, "2026-08-18T09:00:00.000Z", "2026-08-18T09:00:00.000Z");
});

describe("lead list scan evidence", () => {
  it("sorts on canonical scan time and returns that exact timestamp", () => {
    const result = storage.getLeadsPage(1, undefined, {
      sort: "scanned_desc", limit: 100, offset: 0,
    });
    expect(result.rows.map((row) => row.address)).toEqual([
      "20 Newer Scan Rd",
      "10 Older Scan Rd",
    ]);
    expect(result.rows.map((row) => row.lastScannedAt)).toEqual([
      "2026-08-18T08:30:00.000Z",
      "2026-08-17 23:30:00",
    ]);
  });

  it("filters mixed SQLite/ISO timestamp formats chronologically", () => {
    const result = storage.getLeadsPage(1, undefined, {
      scannedSince: "2026-08-18T00:00:00.000Z",
      sort: "scanned_desc", limit: 100, offset: 0,
    });
    expect(result.rows.map((row) => row.address)).toEqual(["20 Newer Scan Rd"]);
    expect(result.total).toBe(1);
  });
});

describe("deduplicated scan accounting", () => {
  it("reports and persists only work that was actually queued", () => {
    scanStore.createScanRun({
      id: "run_existing", tenantId: 1, kind: "fresh_harvest", label: "Existing",
      city: "Concord", state: "NC", budget: 1,
    });
    expect(scanStore.enqueueRunTargets("run_existing", [{ id: olderTarget, seq: 0 }])).toBe(1);

    const started = scanService.startTargetRun({
      tenantId: 1, city: "Concord", state: "NC",
      targetIds: [olderTarget, newerTarget], runKind: "lead_expansion",
    });

    expect(started.queued).toBe(1);
    expect(started.budget).toBe(1);
    expect(scanStore.getRun(started.runId, 1)?.budget).toBe(1);
    expect(scanStore.countQueued(started.runId)).toBe(1);
    expect(runScanWorker).toHaveBeenCalledWith(started.runId, 1);
  });
});
