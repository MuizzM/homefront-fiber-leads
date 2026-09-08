// @vitest-environment node
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, expect, it } from "vitest";

let db: Database.Database;
let prune: typeof import("../../server/stateMonitorScheduler").pruneAlertOutboxBacklog;
let migrate: () => void;
let sequence = 1;
beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-alert-retention-"));
  ({ runMigrations: migrate } = await import("../../server/storage"));
  migrate();
  ({ rawDb: db } = await import("../../server/db"));
  ({ pruneAlertOutboxBacklog: prune } = await import("../../server/stateMonitorScheduler"));
});
beforeEach(() => db.exec("DELETE FROM notification_outbox"));

function add(tenantId: number, lease: string | null = null, kind = "fresh_fiber", status = "pending") {
  return Number(db.prepare(`INSERT INTO notification_outbox
    (tenant_id,dedupe_key,kind,status,payload,lease_owner,lease_expires_at) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, `fixture-${sequence++}`, kind, status, "{}", lease ? "fixture-worker" : null, lease).lastInsertRowid);
}
const rows = () => db.prepare("SELECT * FROM notification_outbox ORDER BY id").all();
const pending = (tenant: number) => (db.prepare("SELECT id FROM notification_outbox WHERE tenant_id=? AND kind='fresh_fiber' AND status='pending' ORDER BY id").all(tenant) as { id: number }[]).map(r => r.id);

it("applies retention per tenant so a busy tenant cannot erase a quieter tenant's alerts", async () => {
  const quiet = [add(1), add(1)];
  const busy = [add(2), add(2), add(2), add(2)];
  expect(await prune(2)).toBe(2);
  expect(pending(1)).toEqual(quiet);
  expect(pending(2)).toEqual(busy.slice(-2));
  const after = rows();
  expect(await prune(2)).toBe(0);
  expect(rows()).toEqual(after);
});

it("preserves live leases, other kinds, terminal rows and the newest pending rows", async () => {
  const leased = add(1, "2999-01-01 00:00:00");
  add(1, "2000-01-01 00:00:00");
  const other = add(1, null, "primary_candidate_new");
  const sent = add(1, null, "fresh_fiber", "sent");
  const failed = add(1, null, "fresh_fiber", "failed");
  const fresh = [add(1), add(1)];
  const before = rows() as any[];
  expect(await prune(2)).toBe(1);
  expect(pending(1)).toEqual([leased, ...fresh]);
  const after = rows() as any[];
  for (const id of [leased, other, sent, failed, ...fresh]) expect(after.find(r => r.id === id)).toEqual(before.find(r => r.id === id));
});

it("does no writes when all tenants fit their own budget", async () => {
  for (let tenant = 1; tenant <= 4; tenant++) { add(tenant); add(tenant); }
  db.pragma("query_only = 1");
  try { expect(await prune(2)).toBe(0); }
  finally { db.pragma("query_only = 0"); }
});

it("yields during a large backlog and leaves new arrivals beyond the fixed cutoff alone", async () => {
  db.transaction(() => { for (let i = 0; i < 1_200; i++) add(1); })();
  const initialWrites = (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
  let arrived = 0;
  let writesBeforeYield = 0;
  const arrival = new Promise<void>(resolve => setImmediate(() => {
    writesBeforeYield = (db.prepare("SELECT total_changes() n").get() as { n: number }).n - initialWrites;
    arrived = add(1); resolve();
  }));
  expect(await prune(2)).toBe(1_198);
  await arrival;
  expect(writesBeforeYield).toBeGreaterThan(0);
  expect(writesBeforeYield).toBeLessThanOrEqual(500);
  expect(pending(1)).toContain(arrived);
  expect(pending(1)).toHaveLength(3);
});

it("retries a held writer without blocking its release or leaking the native wait setting", async () => {
  add(1); add(1); add(1);
  const peer = new Database(db.name);
  const previous = db.pragma("busy_timeout", { simple: true });
  db.pragma("busy_timeout = 2500");
  peer.exec("BEGIN IMMEDIATE");
  let released = false;
  const timer = setTimeout(() => { peer.exec("ROLLBACK"); released = true; }, 1_200);
  try {
    expect(await prune(2)).toBe(1);
    expect(released).toBe(true);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(2500);
  } finally {
    clearTimeout(timer);
    if (peer.inTransaction) peer.exec("ROLLBACK");
    peer.close();
    db.pragma(`busy_timeout = ${previous}`);
  }
});

it("creates the tenant lookup index on upgrade, repeats safely and seeks by tenant", async () => {
  add(1); add(2);
  const before = rows();
  db.exec("DROP INDEX IF EXISTS idx_outbox_fresh_pending_tenant");
  migrate(); migrate();
  expect(rows()).toEqual(before);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM notification_outbox
    WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=? ORDER BY id DESC LIMIT 1 OFFSET ?`).all(1, 2) as any[];
  expect(plan.map(r => r.detail).join(" ")).toContain("idx_outbox_fresh_pending_tenant");
  expect(plan.map(r => r.detail).join(" ")).not.toContain("TEMP B-TREE");
});

it.each([0, -1, NaN, Infinity, 1.5])("rejects unsafe retention input %s without changing rows", async keep => {
  add(1);
  const before = rows();
  await expect(prune(keep)).rejects.toThrow(/positive integer/);
  expect(rows()).toEqual(before);
});

it("resumes after a failed chunk without touching rows already retained", async () => {
  const ids: number[] = [];
  db.transaction(() => { for (let i = 0; i < 1_100; i++) ids.push(add(1)); })();
  db.exec(`CREATE TRIGGER fixture_prune_failure BEFORE UPDATE ON notification_outbox
    WHEN OLD.id=${ids[500]} BEGIN SELECT RAISE(ABORT, 'fixture prune failure'); END`);
  try { await expect(prune(2)).rejects.toThrow(/fixture prune failure/); }
  finally { db.exec("DROP TRIGGER fixture_prune_failure"); }
  expect(pending(1)).toHaveLength(600);
  expect(await prune(2)).toBe(598);
  expect(pending(1)).toEqual(ids.slice(-2));
  expect(await prune(2)).toBe(0);
});
