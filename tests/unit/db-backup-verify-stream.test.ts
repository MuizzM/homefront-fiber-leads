// The off-host backup's verifier, end to end against a REAL dump.
//
// This pair (scripts/db-dump-stream.cjs -> scripts/db-verify-stream.cjs) is the
// only proof production has a restorable copy, and it silently produced nothing
// for two weeks: the old whole-database restore outgrew the runner's disk, the
// upload was gated behind it, and every scheduled run since 2026-08-16 uploaded
// zero artifacts. So the thing worth testing is not "does it pass on a good
// dump" but "does it still FAIL on a bad one" — a verifier that cannot fail is
// what turned a capacity problem into a silent two-week gap.
//
// Everything here runs on a tiny fixture database built in a temp dir, and
// shells out to the same `sqlite3` binary CI uses.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const DUMPER = path.join(ROOT, "scripts/db-dump-stream.cjs");
const VERIFIER = path.join(ROOT, "scripts/db-verify-stream.cjs");

let tmp: string;
let dump: string;
let hasSqlite3 = false;

/** Run the verifier over `sql`, returning its exit code and stderr. */
function verify(sql: string): { code: number; err: string } {
  const work = fs.mkdtempSync(path.join(tmp, "wk-"));
  const r = spawnSync(process.execPath, [VERIFIER, "--workdir", work], {
    input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? -1, err: `${r.stderr ?? ""}` };
}

beforeAll(() => {
  hasSqlite3 = spawnSync("sqlite3", ["--version"]).status === 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hf-backup-verify-"));
  const db = path.join(tmp, "fixture.db");
  // Deliberately includes every shape that has broken a dump/verify round trip:
  // an AUTOINCREMENT table (sqlite_sequence trailer), a quote-in-name table, an
  // EMPTY table, a GENERATED column (excluded from INSERT column lists), an
  // rtree VIRTUAL table (address_points_rtree in production), and a stored
  // VALUE whose text is itself "CREATE TABLE ..." — the string the verifier
  // splits tables on.
  execFileSync("sqlite3", [db, `
    CREATE TABLE plain (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, note TEXT);
    INSERT INTO plain(name,note) VALUES('a','hello'),('b','CREATE TABLE sneaky (x);'),('c',NULL);
    CREATE TABLE "weird name""quoted" (id INTEGER, v TEXT);
    INSERT INTO "weird name""quoted" VALUES(1,'x'),(2,'y');
    CREATE TABLE empty_one (id INTEGER);
    CREATE TABLE gen (id INTEGER PRIMARY KEY, lat REAL, cell REAL GENERATED ALWAYS AS (ROUND(lat,2)) VIRTUAL);
    INSERT INTO gen(id,lat) VALUES(1,35.5512),(2,-80.5947);
    CREATE VIRTUAL TABLE pts USING rtree(id, minx, maxx, miny, maxy);
    INSERT INTO pts VALUES(1,0.0,1.0,0.0,1.0),(2,2.0,3.0,2.0,3.0);
    CREATE INDEX idx_plain_name ON plain(name);
    CREATE TRIGGER trg AFTER INSERT ON plain BEGIN SELECT 1; END;
    CREATE VIEW v AS SELECT id FROM plain;
  `]);
  dump = execFileSync(process.execPath, [DUMPER, db], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
});

afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

describe("off-host backup: dump -> verify round trip", () => {
  it("dumps every table with its own rowcount and a completeness sentinel", () => {
    expect(dump).toContain("-- dump-complete");
    expect(dump).toContain('-- rowcount "plain" 3');
    expect(dump).toContain('-- rowcount "empty_one" 0');
    expect(dump).toContain('-- rowcount "pts" 2');            // rtree virtual table
    expect(dump).toContain("-- section:post-data-ddl");
    // Generated columns must not be inserted — the restore side computes them.
    expect(dump).not.toMatch(/INSERT INTO "gen"\([^)]*"cell"/);
  });

  it("accepts a good dump", () => {
    if (!hasSqlite3) return;
    const { code, err } = verify(dump);
    expect(err).toContain("OK:");
    expect(code).toBe(0);
  });

  it("verifies EVERY table, including the empty one and the rtree", () => {
    if (!hasSqlite3) return;
    const { err } = verify(dump);
    for (const t of ["plain", 'weird name"quoted', "empty_one", "gen", "pts"]) {
      expect(err).toContain(t);
    }
    expect(err).toContain("5 tables, 9 rows");
  });

  it("does not split a table on a stored VALUE that contains 'CREATE TABLE'", () => {
    if (!hasSqlite3) return;
    // The fixture stores that exact text in plain.note. If the splitter took it
    // for a boundary, plain would restore 2 rows, not 3, and the manifest check
    // would catch it — this asserts the splitter, via the count.
    const { code, err } = verify(dump);
    expect(err).toMatch(/plain\s+3 rows/);
    expect(code).toBe(0);
  });

  // ── the cases that matter: it must REFUSE ──────────────────────────────
  it("refuses a stream cut short, and says it was cut rather than corrupt", () => {
    if (!hasSqlite3) return;
    const { code, err } = verify(dump.slice(0, 700));
    expect(code).toBe(1);
    expect(err).toContain("CUT, not corrupt");
  });

  it("refuses a dump whose manifest disagrees with what restored", () => {
    if (!hasSqlite3) return;
    const { code, err } = verify(dump.replace('-- rowcount "plain" 3', '-- rowcount "plain" 4'));
    expect(code).toBe(1);
    expect(err).toContain("plain: dumped 4, restored 3");
  });

  it("refuses a dump missing a table the manifest promises", () => {
    if (!hasSqlite3) return;
    const without = dump.split("\n").filter((l) => !l.startsWith("CREATE TABLE empty_one")).join("\n");
    const { code, err } = verify(without);
    expect(code).toBe(1);
    expect(err).toContain("empty_one: in the manifest but never appeared");
  });

  it("refuses a dump with no rowcount manifest at all", () => {
    if (!hasSqlite3) return;
    const without = dump.split("\n").filter((l) => !l.startsWith("-- rowcount")).join("\n");
    const { code, err } = verify(without);
    expect(code).toBe(1);
    expect(err).toContain("no `-- rowcount` manifest");
  });

  it("refuses a dump whose SQL does not execute", () => {
    if (!hasSqlite3) return;
    const { code } = verify(dump.replace("VALUES(1,'a','hello')", "VALUES(1,'a', NOT VALID SQL)"));
    expect(code).toBe(1);
  });

  it("leaves no per-table database behind — that is what bounds peak disk", () => {
    if (!hasSqlite3) return;
    const work = fs.mkdtempSync(path.join(tmp, "clean-"));
    spawnSync(process.execPath, [VERIFIER, "--workdir", work], { input: dump, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(fs.readdirSync(work).filter((f) => f.endsWith(".db"))).toEqual([]);
  });
});
