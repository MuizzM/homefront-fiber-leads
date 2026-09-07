import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

/** Synchronous work only: restore the connection before any other task runs. */
export function withoutSqliteBusyWait<T>(db: Database.Database, work: () => T): T {
  const previous = Number(db.pragma("busy_timeout", { simple: true }));
  try {
    db.pragma("busy_timeout = 0");
    return work();
  } finally {
    db.pragma(`busy_timeout = ${previous}`);
  }
}

export function isSqliteContention(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code);
}

/** Only rolled-back database work belongs here; send responses/mail afterwards.
 * BEGIN IMMEDIATE acquires the writer before any counters or codes change.
 * Zero native wait keeps the HTTP event loop free while a scanner owns it.
 */
export async function interactiveTransaction<T>(db: Database.Database, work: () => T): Promise<T> {
  const transaction = db.transaction(work);
  return retrySqliteOperation(db, () => transaction.immediate());
}

/** The operation must be atomic itself (one statement or its own transaction).
 * Background maintenance can keep its existing longer lock budget while yielding
 * between attempts; an empty read does not acquire a writer just to do nothing.
 */
export async function retrySqliteOperation<T>(db: Database.Database, work: () => T, timeoutMs = 1_000): Promise<T> {
  const budget = Math.min(120_000, Math.max(1, timeoutMs));
  const deadline = performance.now() + budget;
  const maxAttempts = Math.ceil(budget / 25) + 1;
  let attempts = 0;
  for (;;) {
    try { return withoutSqliteBusyWait(db, work); }
    catch (error) {
      const remaining = deadline - performance.now();
      if (!isSqliteContention(error) || remaining <= 0 || ++attempts >= maxAttempts) throw error;
      await delay(Math.min(25 * attempts, 100, remaining));
    }
  }
}
