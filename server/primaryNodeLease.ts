/**
 * PRIMARY-NODE LEASE — run the background scan PRODUCERS on exactly one node
 * across a multi-server fleet, not once per server.
 *
 * The scanners already coordinate CONSUMPTION through the DB (provider admission
 * leases, durable runs, the reaper), so multiple app nodes pointed at one shared
 * database already share the scan queue safely. What is NOT safe across nodes is
 * PRODUCTION: the hot-market burst, yield engine, daily refresh, build-intel,
 * cluster expansion, radar, sweeps — each node's control worker would start its
 * own copy and double-enqueue. This lease elects ONE node to run producers; the
 * rest only serve HTTP and drain the shared queue.
 *
 * Mechanism: a single-row lease table. A node holds the lease for LEASE_TTL_MS;
 * it renews well before expiry. If the holder dies, another node takes over once
 * the lease goes stale. On a lone box the one node always holds it, so behaviour
 * is byte-for-byte unchanged from today — this is a no-op until a second node
 * pointed at the same DB appears.
 *
 * Fail-SAFE bias: if the DB is unavailable, a single-process/dev node assumes it
 * IS primary (so a bare box never silently stops producing). Only a genuine,
 * live competing holder in the shared DB makes a node stand down.
 */
import crypto from "node:crypto";
import os from "node:os";
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

export const LEASE_TTL_MS = Math.max(15_000, Number(process.env.PRIMARY_LEASE_TTL_MS) || 60_000);
export const LEASE_RENEW_MS = Math.max(5_000, Number(process.env.PRIMARY_LEASE_RENEW_MS) || 20_000);

// Stable identity for THIS node/process. Across boxes hostnames differ; within a
// box only the control worker ever calls this, so one id per node holds it.
const NODE_ID =
  process.env.HF_NODE_ID?.trim() ||
  `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString("hex")}`;

export function nodeId(): string {
  return NODE_ID;
}

let ensured = false;
function ensureTable(db = rawDb): void {
  if (ensured && db === rawDb) return;
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_primary_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  if (db === rawDb) ensured = true;
}

/**
 * Atomically become (or renew as) primary. Returns true iff THIS node holds the
 * lease afterwards. Pure over (db, id, now, ttl) so it is unit-testable with any
 * better-sqlite3 handle.
 *
 * The single UPSERT wins the lease when: the row is absent, the lease has
 * expired, OR we already hold it (renew). A live different holder blocks us —
 * the WHERE on the DO UPDATE makes it a no-op and we read back their id.
 */
export function tryAcquirePrimaryOn(
  db: import("better-sqlite3").Database,
  id: string,
  now: number,
  ttlMs: number,
): boolean {
  ensureTable(db);
  db.prepare(
    `INSERT INTO cluster_primary_lease (id, holder, acquired_at, expires_at)
       VALUES (1, @id, @now, @exp)
     ON CONFLICT(id) DO UPDATE SET
       holder      = @id,
       acquired_at = CASE WHEN cluster_primary_lease.holder = @id THEN cluster_primary_lease.acquired_at ELSE @now END,
       expires_at  = @exp
     WHERE cluster_primary_lease.expires_at <= @now
        OR cluster_primary_lease.holder = @id`,
  ).run({ id, now, exp: now + ttlMs });
  const row = db.prepare(`SELECT holder FROM cluster_primary_lease WHERE id = 1`).get() as { holder?: string } | undefined;
  return row?.holder === id;
}

/** Who currently holds the lease (unexpired), or null. */
export function currentPrimaryOn(
  db: import("better-sqlite3").Database,
  now: number,
): string | null {
  ensureTable(db);
  const row = db.prepare(`SELECT holder, expires_at FROM cluster_primary_lease WHERE id = 1`).get() as
    | { holder: string; expires_at: number }
    | undefined;
  return row && row.expires_at > now ? row.holder : null;
}

let isPrimary = false;
let renewTimer: ReturnType<typeof setInterval> | null = null;

/** True while THIS node is the elected primary producer. */
export function isPrimaryNode(): boolean {
  return isPrimary;
}

/**
 * Acquire the lease now and keep renewing it. Returns whether we became primary
 * on the FIRST attempt (so the caller can decide, at boot, whether to start the
 * producers). Fail-safe: if the DB throws (bare/replay), a lone node assumes it
 * is primary rather than silently going idle.
 */
export function startPrimaryElection(): boolean {
  try {
    isPrimary = tryAcquirePrimaryOn(rawDb, NODE_ID, Date.now(), LEASE_TTL_MS);
  } catch (e: any) {
    structuredLog("primary_lease.acquire_failed_assume_primary", { error: String(e?.message ?? e).slice(0, 120) });
    isPrimary = true; // fail open for a single node — never stop producing on a lone box
  }
  if (!renewTimer) {
    renewTimer = setInterval(() => {
      try {
        const held = tryAcquirePrimaryOn(rawDb, NODE_ID, Date.now(), LEASE_TTL_MS);
        if (held !== isPrimary) {
          structuredLog("primary_lease.transition", { nodeId: NODE_ID, isPrimary: held });
        }
        isPrimary = held;
      } catch { /* transient DB busy — keep the last known state until next tick */ }
    }, LEASE_RENEW_MS);
    if (typeof (renewTimer as any).unref === "function") (renewTimer as any).unref();
  }
  structuredLog("primary_lease.started", { nodeId: NODE_ID, isPrimary, ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS });
  return isPrimary;
}

export function stopPrimaryElectionForTest(): void {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
  isPrimary = false;
}
