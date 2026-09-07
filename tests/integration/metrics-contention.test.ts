// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
const fault = vi.hoisted(() => ({ mode: "none", calls: 0 }));
vi.mock("../../server/repMetricsStore", async original => {
  const actual = await original<typeof import("../../server/repMetricsStore")>();
  return { ...actual, recomputeRepDay: (...args: Parameters<typeof actual.recomputeRepDay>) => {
    fault.calls++;
    if (fault.mode !== "none") throw Object.assign(new Error("synthetic rollup failure"), { code: fault.mode });
    return actual.recomputeRepDay(...args);
  } };
});
vi.mock("../../server/resourcePressure", () => ({ readPressure: () => ({ state: "normal", level: "normal" }), PRESSURE_ORDER: { normal: 0, warn: 1, throttle: 2, critical: 3 } }));
let db: Database.Database;
let metrics: typeof import("../../server/repMetricsStore");
let rollups: typeof import("../../server/repMetricsAggregator");
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(),"hf-metrics-contention-"));
  (await import("../../server/storage")).runMigrations();
  db = (await import("../../server/db")).rawDb;
  metrics = await import("../../server/repMetricsStore"); rollups = await import("../../server/repMetricsAggregator");
  db.prepare("INSERT INTO team_members (id,name,role,active,tenant_id) VALUES (91,'Synthetic Rep','rep',1,1)").run();
});
it("retains historical dirty work and prior summaries on lock contention, then recomputes once", async () => {
  const date = "2026-01-12"; const key = `rep-hourly:v1:1:91:${date}`;
  db.prepare("INSERT INTO rep_metrics_dirty_days (tenant_id,rep_id,metric_date) VALUES (1,91,?)").run(date);
  db.prepare("INSERT INTO rep_metrics_state (k,v) VALUES (?,?)").run(key,JSON.stringify({ version: 1, hours: [{ hour: 9, knocks: 3 }] }));
  const before = db.prepare("SELECT v FROM rep_metrics_state WHERE k=?").get(key);
  fault.mode = "SQLITE_BUSY";
  expect(await rollups.runRollupSlice(1)).toBe(0);
  expect(metrics.claimDirtyDays(10)).toContainEqual({tenantId:1,repId:91,metricDate:date});
  expect(db.prepare("SELECT v FROM rep_metrics_state WHERE k=?").get(key)).toEqual(before);
  fault.mode = "none";
  expect(await rollups.runRollupSlice(1)).toBe(1);
  expect(metrics.claimDirtyDays(10)).toHaveLength(0);
  expect(JSON.parse((db.prepare("SELECT v FROM rep_metrics_state WHERE k=?").get(key) as any).v)).not.toHaveProperty("unavailable",true);
});
it("a competing writer does not block the loop or clear a historical day", async () => {
  const date = "2026-01-13";
  db.prepare("INSERT INTO rep_metrics_dirty_days (tenant_id,rep_id,metric_date) VALUES (1,91,?)").run(date);
  const peer = new Database(db.name); const previous = db.pragma("busy_timeout",{simple:true});
  peer.exec("BEGIN IMMEDIATE"); db.pragma("busy_timeout = 1000");
  try {
    const started = performance.now(); expect(await rollups.runRollupSlice(1)).toBe(0);
    expect(performance.now()-started).toBeLessThan(500);
    expect(metrics.claimDirtyDays(10)).toContainEqual({tenantId:1,repId:91,metricDate:date});
  } finally { peer.exec("ROLLBACK"); peer.close(); db.pragma(`busy_timeout = ${previous}`); }
  expect(await rollups.runRollupSlice(1)).toBe(1);
});
it("marks a deterministic failure unavailable without stranding later work", async () => {
  const date = "2026-01-14";
  db.prepare("INSERT INTO rep_metrics_dirty_days (tenant_id,rep_id,metric_date) VALUES (1,91,?)").run(date);
  fault.mode = "SQLITE_CONSTRAINT";
  expect(await rollups.runRollupSlice(1)).toBe(0); fault.mode = "none";
  expect(metrics.claimDirtyDays(10)).toHaveLength(0);
  expect(JSON.parse((db.prepare("SELECT v FROM rep_metrics_state WHERE k=?").get(`rep-hourly:v1:1:91:${date}`) as any).v)).toHaveProperty("unavailable",true);
});

it("keeps reporting reads outside the shared writer transaction", async () => {
  const date = "2026-01-15";
  db.prepare("INSERT INTO rep_metrics_dirty_days (tenant_id,rep_id,metric_date) VALUES (1,91,?)").run(date);
  const peer = new Database(db.name); peer.pragma("busy_timeout = 0");
  const original = db.prepare.bind(db); let checked = false;
  const prepare = vi.spyOn(db,"prepare").mockImplementation((sql: string) => {
    if(sql.includes("k.lead_id AS leadId") && sql.includes("FROM knock_log k")) {
      peer.exec("BEGIN IMMEDIATE"); peer.exec("ROLLBACK"); checked = true;
    }
    return original(sql);
  });
  try { expect(await rollups.runRollupSlice(1)).toBe(1); expect(checked).toBe(true); }
  finally { prepare.mockRestore(); peer.close(); }
});
