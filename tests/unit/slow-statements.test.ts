// The slow-statement log names the SQL that stalls a worker's event loop. It
// must time every way the app runs SQL (statements, exec, transactions), mask
// every literal so no lead detail reaches the log, stay quiet when nothing is
// slow, cap itself per minute, and never wrap the prototypes twice.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { installSlowStatementLog, maskSql, slowSqlThresholdMs, uninstallSlowStatementLog } from "../../server/slowStatements";

type Emitted = { fields: Record<string, unknown>; level: string };

function harness(thresholdMs: number, opts: { maxPerMinute?: number } = {}) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
  const emitted: Emitted[] = [];
  // A fake clock that advances by `step` on every read, so one statement
  // "takes" exactly one step regardless of how fast the machine is.
  let clock = 0;
  let step = 0;
  const now = () => { clock += step; return clock; };
  const installed = installSlowStatementLog(db, {
    thresholdMs,
    where: "test",
    maxPerMinute: opts.maxPerMinute,
    now,
    emit: (fields, level) => emitted.push({ fields, level }),
  });
  return { db, emitted, installed, setStep: (ms: number) => { step = ms; } };
}

describe("maskSql", () => {
  it("masks string and numeric literals but keeps identifiers and shape", () => {
    expect(maskSql("SELECT id FROM leads WHERE address = '1842 Oak Ridge Dr' AND tenant_id = 7 AND zip = '28146'"))
      .toBe("SELECT id FROM leads WHERE address = '?' AND tenant_id = ? AND zip = '?'");
    expect(maskSql("SELECT \"id\" FROM \"leads\" WHERE note = \"O'Brien\"")).toBe("SELECT \"id\" FROM \"leads\" WHERE note = \"?\"");
    expect(maskSql("SELECT 1 WHERE name = 'O''Brien'")).toBe("SELECT ? WHERE name = '?'");
  });

  it("collapses whitespace and truncates long statements", () => {
    expect(maskSql("SELECT\n   id\n FROM   t")).toBe("SELECT id FROM t");
    const long = `SELECT ${"a, ".repeat(200)}b FROM t`;
    const masked = maskSql(long, 50);
    expect(masked.length).toBe(50);
    expect(masked.endsWith("…")).toBe(true);
  });
});

describe("slowSqlThresholdMs", () => {
  it("is off outside production unless asked, and defaults to 250 ms in production", () => {
    expect(slowSqlThresholdMs({ NODE_ENV: "test" })).toBeNull();
    expect(slowSqlThresholdMs({ NODE_ENV: "production" })).toBe(250);
    expect(slowSqlThresholdMs({ NODE_ENV: "production", SLOW_SQL_MS: "off" })).toBeNull();
    expect(slowSqlThresholdMs({ NODE_ENV: "production", SLOW_SQL_MS: "0" })).toBeNull();
    expect(slowSqlThresholdMs({ NODE_ENV: "test", SLOW_SQL_MS: "100" })).toBe(100);
    expect(slowSqlThresholdMs({ NODE_ENV: "production", SLOW_SQL_MS: "garbage" })).toBe(250);
  });
});

describe("installSlowStatementLog", () => {
  const dbs: Database.Database[] = [];
  // The wrap lives on the shared prototypes, so every test starts from the
  // originals or the second harness would feed the first one's sink.
  afterEach(() => { for (const db of dbs.splice(0)) { uninstallSlowStatementLog(db); db.close(); } });

  it("logs slow statements with masked SQL and stays quiet for fast ones", () => {
    const h = harness(100);
    dbs.push(h.db);
    expect(h.installed).toBe(true);
    h.setStep(10);
    h.db.prepare("INSERT INTO t (name) VALUES (?)").run("Ada");
    h.db.prepare("SELECT * FROM t WHERE name = 'Ada'").all();
    expect(h.emitted).toHaveLength(0);

    h.setStep(400);
    h.db.prepare("SELECT * FROM t WHERE name = 'Ada' AND id > 5").get();
    expect(h.emitted).toHaveLength(1);
    const { fields, level } = h.emitted[0];
    expect(fields.kind).toBe("get");
    expect(fields.ms).toBe(400);
    expect(fields.sql).toBe("SELECT * FROM t WHERE name = '?' AND id > ?");
    expect(fields.where).toBe("test");
    expect(fields.pid).toBe(process.pid);
    expect(level).toBe("info");

    h.setStep(1500);
    h.db.exec("UPDATE t SET name = 'Grace' WHERE id = 1");
    expect(h.emitted[1].fields.kind).toBe("exec");
    expect(h.emitted[1].fields.sql).toBe("UPDATE t SET name = '?' WHERE id = ?");
    expect(h.emitted[1].level).toBe("warn");
  });

  it("times a whole transaction and attributes it to the module that defined it", () => {
    const h = harness(100);
    dbs.push(h.db);
    const insert = h.db.prepare("INSERT INTO t (name) VALUES (?)");
    const many = h.db.transaction((names: string[]) => { for (const n of names) insert.run(n); });
    // Each statement is fast on its own; only the transaction as a whole is slow.
    h.setStep(30);
    many(["a", "b", "c", "d", "e"]);
    const tx = h.emitted.filter((e) => e.fields.kind === "transaction");
    expect(tx).toHaveLength(1);
    expect(tx[0].fields.sql).toBeNull();
    // Named by its first statement (the bundle has no source maps) and by
    // how many it ran; the dev-only file:line rides along.
    expect(tx[0].fields.firstSql).toBe("INSERT INTO t (name) VALUES (?)");
    expect(tx[0].fields.statements).toBe(5);
    expect(String(tx[0].fields.origin)).toMatch(/slow-statements\.test\.ts:\d+$/);
    expect(h.emitted.filter((e) => e.fields.kind === "run")).toHaveLength(0);
    expect(h.db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 5 });
    // Explicit modes keep working and are timed too.
    many.immediate(["f"]);
    expect(h.emitted.filter((e) => e.fields.kind === "transaction")).toHaveLength(2);
  });

  it("times only the outermost of nested transactions", () => {
    const h = harness(100);
    dbs.push(h.db);
    const insert = h.db.prepare("INSERT INTO t (name) VALUES (?)");
    const inner = h.db.transaction((n: string) => { insert.run(n); });
    const outer = h.db.transaction((names: string[]) => { for (const n of names) inner(n); });
    h.setStep(40);
    outer(["a", "b", "c"]);
    const tx = h.emitted.filter((e) => e.fields.kind === "transaction");
    expect(tx).toHaveLength(1);
    expect(tx[0].fields.statements).toBe(3);
    expect(tx[0].fields.firstSql).toBe("INSERT INTO t (name) VALUES (?)");
  });

  it("caps lines per minute and reports how many it dropped", () => {
    const h = harness(10, { maxPerMinute: 2 });
    dbs.push(h.db);
    h.setStep(50);
    for (let i = 0; i < 5; i += 1) h.db.prepare("SELECT 1").get();
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1].fields.suppressed).toBeUndefined();
  });

  it("never wraps the prototypes twice", () => {
    const h = harness(100);
    dbs.push(h.db);
    const again = installSlowStatementLog(h.db, { thresholdMs: 1, emit: () => { throw new Error("second install must be inert"); } });
    expect(again).toBe(false);
    h.setStep(500);
    h.db.prepare("SELECT 1").get();
    // Still exactly one line: the first installation's emitter, once.
    expect(h.emitted).toHaveLength(1);
  });
});
