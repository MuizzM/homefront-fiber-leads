// Synthetic, local-only evidence. No imports of the application database,
// environment credentials, HTTP server, email transport or provider adapters.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pruneTenantAlertBacklogs, OUTBOX_PRUNE_BATCH } from "../server/alertOutboxMaintenance";

const db = new Database(":memory:");
const fixtureRows = 200_000;
db.exec(`CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT, next_attempt_at TEXT, last_error TEXT,
  lease_owner TEXT, lease_expires_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_outbox_delivery_due ON notification_outbox(kind, status, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(status, created_at);
  CREATE TABLE domain_events (id INTEGER PRIMARY KEY,tenant_id INTEGER NOT NULL,subject_type TEXT,subject_id INTEGER);
  CREATE INDEX IF NOT EXISTS idx_domain_events_cursor ON domain_events(id, tenant_id);
  CREATE INDEX IF NOT EXISTS idx_domain_events_subject ON domain_events(tenant_id, subject_type, subject_id, id);`);
const insertAlert = db.prepare("INSERT INTO notification_outbox(id,tenant_id,kind,status,created_at) VALUES (?,?,'fresh_fiber','pending','2026-09-08 12:00:00')");
const insertEvent = db.prepare("INSERT INTO domain_events VALUES (?,?,'sale',?)");
db.transaction(() => {
  for (let id = 1; id <= fixtureRows; id++) {
    insertAlert.run(id, id <= 100 ? 1 : 2);
    insertEvent.run(id, id % 10 === 0 ? 2 : 1, id);
  }
})();

const queries = {
  tenantAlertCount: { sql: "SELECT COUNT(*) n FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=?", args: [1] },
  tenantAlertCutoff: { sql: "SELECT id FROM notification_outbox WHERE kind='fresh_fiber' AND status='pending' AND tenant_id=? AND id<=? ORDER BY id DESC LIMIT 1 OFFSET ?", args: [1, fixtureRows, 50] },
  tenantEventBacklog: { sql: "SELECT COUNT(*) n FROM domain_events WHERE tenant_id=? AND id>?", args: [1, fixtureRows - 100] },
};

function measure() {
  return Object.fromEntries(Object.entries(queries).map(([name, { sql, args }]) => {
    const stmt = db.prepare(sql);
    for (let i = 0; i < 3; i++) stmt.get(...args);
    const samples: number[] = [];
    for (let i = 0; i < 25; i++) {
      const start = performance.now(); stmt.get(...args); samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return [name, { result: stmt.get(...args), medianMs: samples[12], p95Ms: samples[23], maxMs: samples[24],
      plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) }];
  }));
}

try {
  const before = measure();
  const pagesBefore = Number(db.pragma("page_count", { simple: true }));
  const indexStarted = performance.now();
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outbox_fresh_pending_tenant ON notification_outbox(tenant_id, id DESC)
    WHERE kind='fresh_fiber' AND status='pending';
    CREATE INDEX IF NOT EXISTS idx_domain_events_tenant_cursor ON domain_events(tenant_id, id);`);
  const indexBuildMs = performance.now() - indexStarted;
  const indexBytes = (Number(db.pragma("page_count", { simple: true })) - pagesBefore) * Number(db.pragma("page_size", { simple: true }));
  const after = measure();
  for (const key of Object.keys(queries)) {
    if (JSON.stringify(before[key].result) !== JSON.stringify(after[key].result)) throw new Error(`result changed: ${key}`);
  }
  const changes = () => (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
  let last = changes();
  const batches: number[] = [];
  let observer: NodeJS.Immediate;
  const observe = () => {
    const current = changes();
    if (current > last) batches.push(current - last);
    last = current;
    observer = setImmediate(observe);
  };
  observer = setImmediate(observe);
  const pruneStarted = performance.now();
  const superseded = await pruneTenantAlertBacklogs(db, 2_000);
  const pruneMs = performance.now() - pruneStarted;
  clearImmediate(observer);
  const remaining = db.prepare("SELECT tenant_id, COUNT(*) n FROM notification_outbox WHERE status='pending' GROUP BY tenant_id").all();
  const repeated = await pruneTenantAlertBacklogs(db, 2_000);
  if (superseded !== fixtureRows - 100 - 2_000 || repeated !== 0 || batches.length === 0
    || batches.reduce((sum, n) => sum + n, 0) !== superseded || Math.max(...batches) > OUTBOX_PRUNE_BATCH
    || JSON.stringify(remaining) !== JSON.stringify([{ tenant_id: 1, n: 100 }, { tenant_id: 2, n: 2_000 }])) throw new Error("retention accounting/bounds changed");
  console.log(JSON.stringify({
    kind: "synthetic-foundation-index-and-retention", recordedAt: new Date().toISOString(),
    sourceBase: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    source: "working tree; pin final revision via containing commit/PR", node: process.version,
    platform: process.platform, arch: process.arch, sqlite: db.prepare("SELECT sqlite_version() version").get(),
    fixtureRowsPerTable: fixtureRows, warmups: 3, samples: 25,
    before, after, indexBuildMs, indexBytes,
    retention: { superseded, remaining, repeated, pruneMs, batches: batches.length, maxWritesBetweenYields: Math.max(...batches) },
    limits: "In-memory synthetic SQLite, sequential before/after samples; no production SLO, disk-lock or provider-delivery measurement. Indexes add ongoing write/storage cost.",
  }, null, 2));
} finally { db.close(); }
