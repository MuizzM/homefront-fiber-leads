// ── Slow statement log ───────────────────────────────────────────────────────
// better-sqlite3 is synchronous: every statement runs ON the event loop, so a
// four-second query is a four-second stall for every request that worker is
// holding. The production perf report proves the stalls (loop-lag maxima of
// tens of seconds, /api/health at 2.6 s from outside while connect and TLS
// stay at 90 ms) but cannot name the statement, because nothing times SQL
// except the map feed.
//
// This wraps the better-sqlite3 prototypes ONCE per process so that any
// statement, exec or transaction slower than SLOW_SQL_MS emits a
// `db.slow_statement` line the perf report can aggregate and line up against
// the loop-lag minutes. What it logs is the statement's SOURCE with literals
// masked, never its bound parameters or rows, so no lead detail reaches the
// log. A per-minute cap keeps a pathological burst from flooding the ring.
//
// Cost when nothing is slow: two performance.now() reads per call.

import type Database from "better-sqlite3";
import { structuredLog } from "./structuredLog";

export const SLOW_SQL_DEFAULT_MS = 250;
const CONTROL_SQL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const INSTALLED = Symbol.for("homefront.slowStatements");

/** Collapse whitespace and mask every literal so the SQL shape survives but
 *  no value does. `'O''Brien'` and `'1 Main St'` both become `'?'`; numbers
 *  become `?`. Truncated to keep one log line one line. */
export function maskSql(sql: string, max = 220): string {
  const masked = String(sql)
    .replace(/'(?:[^']|'')*'/g, "'?'")
    .replace(/"(?:[^"]|"")*"/g, (q) => (/^"[A-Za-z_][A-Za-z0-9_]*"$/.test(q) ? q : '"?"'))
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
  return masked.length > max ? `${masked.slice(0, max - 1)}…` : masked;
}

/** Resolve the threshold from the environment. `SLOW_SQL_MS=off` disables the
 *  log; unset falls back to the default only in production so test output and
 *  local runs stay quiet unless asked. */
export function slowSqlThresholdMs(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.SLOW_SQL_MS;
  if (raw != null) {
    if (/^(off|0|false)$/i.test(raw.trim())) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : SLOW_SQL_DEFAULT_MS;
  }
  return env.NODE_ENV === "production" ? SLOW_SQL_DEFAULT_MS : null;
}

export interface SlowStatementOptions {
  /** Log calls at or above this many milliseconds. */
  thresholdMs: number;
  /** Process attribution carried on every line (worker role or primary). */
  where?: string;
  /** Lines per minute before the rest of the minute is counted, not logged. */
  maxPerMinute?: number;
  /** Test seam; defaults to performance.now(). */
  now?: () => number;
  /** Test seam; defaults to structuredLog. */
  emit?: (fields: Record<string, string | number | boolean | null | undefined>, level: "info" | "warn") => void;
}

/** First frame outside better-sqlite3 and this file. Useful in dev; in the
 *  production bundle (one dist/index.cjs, no source maps) it is only a line
 *  number, which is why a transaction is ALSO named by its first statement. */
function callerOrigin(): string | null {
  const stack = new Error().stack?.split("\n").slice(2) ?? [];
  for (const frame of stack) {
    if (/better-sqlite3|slowStatements|node:internal/.test(frame)) continue;
    const m = frame.match(/\(?((?:file:\/\/)?[^\s()]+):(\d+):\d+\)?$/);
    if (m) return `${m[1].replace(/^.*\/(server|shared|scripts|dist)\//, "$1/")}:${m[2]}`;
  }
  return null;
}

/**
 * Install on a connection; every connection created from the same
 * better-sqlite3 module shares the prototypes, so one install covers the app
 * handle, drizzle, and the maintenance handles alike. Returns false when the
 * prototypes were already wrapped (a second install is a no-op, never a
 * double wrap).
 */
export function installSlowStatementLog(db: Database.Database, opts: SlowStatementOptions): boolean {
  const dbProto = Object.getPrototypeOf(db) as Record<PropertyKey, any>;
  if (dbProto[INSTALLED]) return false;
  const stmtProto = Object.getPrototypeOf(db.prepare("SELECT 1")) as Record<string, any>;
  const originals: Array<() => void> = [];
  const now = opts.now ?? (() => performance.now());
  const emit = opts.emit ?? ((fields, level) => structuredLog("db.slow_statement", fields, level));
  const threshold = opts.thresholdMs;
  const maxPerMinute = opts.maxPerMinute ?? 40;
  const where = opts.where ?? null;

  let minuteKey = -1;
  let emittedThisMinute = 0;
  let suppressed = 0;

  // The transaction currently running on this (single) thread, so the first
  // statement inside it can name it: "transaction: INSERT INTO knock_log ..."
  // says far more than a bundle line number.
  let activeTx: { firstSql: string | null; statements: number } | null = null;

  const report = (kind: string, sql: string | null, ms: number, origin: string | null, extra?: Record<string, string | number | null>) => {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== minuteKey) { minuteKey = minute; emittedThisMinute = 0; }
    if (emittedThisMinute >= maxPerMinute) { suppressed++; return; }
    emittedThisMinute++;
    const fields: Record<string, string | number | boolean | null | undefined> = {
      pid: process.pid,
      where,
      kind,
      ms: Number(ms.toFixed(1)),
      sql: sql == null ? null : maskSql(sql),
      origin,
      ...extra,
    };
    if (suppressed > 0) { fields.suppressed = suppressed; suppressed = 0; }
    emit(fields, ms >= 1000 ? "warn" : "info");
  };

  const timedStatement = <T extends (...args: any[]) => any>(kind: string, fn: T, sqlOf: (self: any, args: any[]) => string | null) =>
    function (this: any, ...args: any[]) {
      const started = now();
      if (activeTx) {
        // better-sqlite3 runs BEGIN / SAVEPOINT / COMMIT through this same
        // method; those are the transaction, not its work.
        const sql = sqlOf(this, args);
        if (sql === null || !CONTROL_SQL.test(sql)) {
          activeTx.statements++;
          if (activeTx.firstSql === null) activeTx.firstSql = sql;
        }
      }
      try {
        return fn.apply(this, args);
      } finally {
        const ms = now() - started;
        if (ms >= threshold) report(kind, sqlOf(this, args), ms, null);
      }
    } as unknown as T;

  for (const op of ["all", "get", "run"] as const) {
    const orig = stmtProto[op];
    if (typeof orig !== "function") continue;
    stmtProto[op] = timedStatement(op, orig, (self) => (typeof self.source === "string" ? self.source : null));
    originals.push(() => { stmtProto[op] = orig; });
  }

  const origExec = dbProto.exec;
  if (typeof origExec === "function") {
    dbProto.exec = timedStatement("exec", origExec, (_self, args) => (typeof args[0] === "string" ? args[0] : null));
    originals.push(() => { dbProto.exec = origExec; });
  }

  // transaction() hands back a function that runs the whole body under one
  // write lock; statement timing alone would miss a transaction of ten
  // thousand fast inserts, which blocks the loop for its total just the same.
  const origTransaction = dbProto.transaction;
  if (typeof origTransaction === "function") {
    dbProto.transaction = function (this: any, fn: (...args: any[]) => any) {
      const origin = callerOrigin();
      const wrapped = origTransaction.call(this, fn);
      const wrapMode = (run: (...args: any[]) => any) =>
        function (this: any, ...args: any[]) {
          // Nested transactions become savepoints in better-sqlite3; only the
          // outermost one is timed, so a slow outer never logs as N slow inners.
          const outer = activeTx === null;
          if (outer) activeTx = { firstSql: null, statements: 0 };
          const started = now();
          try {
            return run.apply(this, args);
          } finally {
            const ms = now() - started;
            const tx = activeTx;
            if (outer) activeTx = null;
            if (outer && ms >= threshold) {
              report("transaction", null, ms, origin, {
                firstSql: tx?.firstSql == null ? null : maskSql(tx.firstSql),
                statements: tx?.statements ?? 0,
              });
            }
          }
        };
      const timedRun: any = wrapMode(wrapped);
      for (const mode of ["deferred", "immediate", "exclusive"] as const) {
        if (typeof wrapped[mode] === "function") timedRun[mode] = wrapMode(wrapped[mode]);
      }
      return timedRun;
    };
    originals.push(() => { dbProto.transaction = origTransaction; });
  }

  dbProto[INSTALLED] = () => { for (const restore of originals) restore(); delete dbProto[INSTALLED]; };
  return true;
}

/** Restore the untouched prototypes. For tests; production never uninstalls. */
export function uninstallSlowStatementLog(db: Database.Database): void {
  const dbProto = Object.getPrototypeOf(db) as Record<PropertyKey, any>;
  if (typeof dbProto[INSTALLED] === "function") dbProto[INSTALLED]();
}
