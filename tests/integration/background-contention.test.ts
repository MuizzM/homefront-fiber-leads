// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
let db: Database.Database;
let peer: Database.Database;
let coordinator: import("../../server/distributedProviderCoordinator").DistributedProviderCoordinator<unknown>;
let events: typeof import("../../server/scanEvents");
let bus: typeof import("../../server/scanStageBus");
let budget: typeof import("../../server/mapboxBudget");
let purge: typeof import("../../server/globalMaintenance").purgeExpiredAuthBatch;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-background-contention-"));
  (await import("../../server/storage")).runMigrations();
  db = (await import("../../server/db")).rawDb;
  peer = new Database(db.name); peer.pragma("busy_timeout = 0");
  const C = await import("../../server/distributedProviderCoordinator"); C.ensureSchema();
  coordinator = new C.DistributedProviderCoordinator({ maxConcurrency: 2, maxRequestsPerMinute: 100, resultCacheTtlMs: 100 });
  events = await import("../../server/scanEvents"); events.startScanEvents();
  bus = await import("../../server/scanStageBus");
  budget = await import("../../server/mapboxBudget"); budget.mapboxBudgetState();
  purge = (await import("../../server/globalMaintenance")).purgeExpiredAuthBatch;
});
function heldWriter(work: () => void) {
  const previous = db.pragma("busy_timeout", { simple: true });
  db.pragma("busy_timeout = 1000"); peer.exec("BEGIN IMMEDIATE");
  try { work(); expect(db.pragma("busy_timeout", { simple: true })).toBe(1000); }
  finally { peer.exec("ROLLBACK"); db.pragma(`busy_timeout = ${previous}`); }
}
it("status snapshots are read-only and exclude expired jobs without deleting them", () => {
  const now = Date.now();
  const own = coordinator.snapshot().instanceId;
  const insert = db.prepare(`INSERT INTO provider_admission_queue
    (id,dedupe_key,source,priority,instance_id,state,enqueued_at,updated_at,started_at,lease_expires_at)
    VALUES (?,?,'city',200,?,?,?, ?,?,?)`);
  insert.run("live","live","peer","active",now,now,now,now+60_000);
  insert.run("expired","expired","peer","active",now,now,now,now-1);
  insert.run("dead-queue","dead-queue","peer","queued",now-900_000,now-900_000,null,null);
  insert.run("own-queue","own-queue",own,"queued",now-900_000,now-900_000,null,null);
  db.pragma("query_only = 1");
  try { expect(coordinator.snapshot()).toMatchObject({ active: 1, queued: 1 }); }
  finally { db.pragma("query_only = 0"); }
  heldWriter(() => { expect(coordinator.snapshot()).toMatchObject({ active: 1, queued: 1 }); });
  expect((db.prepare("SELECT COUNT(*) n FROM provider_admission_queue").get() as any).n).toBe(4);
});
it("scan telemetry relays immediately under a writer and persists each buffered event after release", () => {
  const relay = vi.fn(); const unsubscribe = events.onScanEvent(relay);
  heldWriter(() => {
    const start = performance.now();
    for (let i=0; i<501; i++) bus.emitStage({ addressKey: `contention-${i}`, stage: "queued", tsEpoch: Date.now() });
    expect(events.flushScanEvents()).toBe(0);
    expect(relay).toHaveBeenCalledTimes(501);
    expect(performance.now()-start).toBeLessThan(500);
  });
  while (events.flushScanEvents()) { /* bounded fixture */ }
  expect((db.prepare("SELECT COUNT(*) n FROM scan_events WHERE address_key LIKE 'contention-%'").get() as any).n).toBe(501);
  unsubscribe();
});
it("Mapbox accounting retains the full pending spend without blocking or a threshold retry storm", () => {
  budget._resetMapboxBudgetForTests();
  heldWriter(() => {
    const prepare = vi.spyOn(db, "prepare"); const start = performance.now();
    for(let i=0;i<501;i++) budget.recordMapboxRequests();
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("INSERT INTO mapbox_ledger"))).toHaveLength(1);
    expect(performance.now()-start).toBeLessThan(500); prepare.mockRestore();
    expect(budget.mapboxBudgetState().dayUsed).toBe(501);
  });
  budget.flushMapboxLedger(); budget.flushMapboxLedger();
  expect(budget.mapboxBudgetState().dayUsed).toBe(501);
  expect((db.prepare("SELECT SUM(requests) n FROM mapbox_ledger").get() as any).n).toBe(501);
});
it("auth cleanup bounds each batch, preserves unexpired rows, and needs no writer when idle", () => {
  const expiry = new Date(Date.now()-60_000).toISOString();
  const future = new Date(Date.now()+60_000).toISOString();
  // Use the actual schema with synthetic addresses and hashes; no codes are sent.
  const insert = db.prepare("INSERT INTO otp_codes (email,code,expires_at) VALUES (?,?,?)");
  db.transaction(() => { for(let i=0;i<1100;i++) insert.run(`expiry-${i}@example.invalid`,"000000",expiry); insert.run("keep@example.invalid","000000",future); })();
  const now = new Date().toISOString();
  expect(purge("otp_codes",now)).toBe(500); expect(purge("otp_codes",now)).toBe(500); expect(purge("otp_codes",now)).toBe(100);
  heldWriter(() => expect(purge("otp_codes",now)).toBe(0));
  expect((db.prepare("SELECT COUNT(*) n FROM otp_codes WHERE email='keep@example.invalid'").get() as any).n).toBe(1);
});
