#!/usr/bin/env node
/**
 * VERIFY A STREAMED SQL DUMP BY RESTORING IT — ONE TABLE AT A TIME.
 *
 * Why this exists. `db-backup.yml` used to prove a dump by restoring the WHOLE
 * database into one throwaway SQLite file on the runner. Production grew past
 * what a hosted runner's disk holds (~13 GiB free, measured; the data-only
 * restore needs more), so from 2026-08-16 the verify step died with
 * `database or disk is full (13)` — and because the upload was gated behind it,
 * every scheduled run since produced ZERO artifacts. The dump itself was fine
 * the whole time; the proof was what stopped fitting.
 *
 * The fix is to bound the working set, not to weaken the proof. The dumper
 * (`db-dump-stream.cjs`) writes each table's CREATE immediately followed by
 * that table's own INSERTs, tables one after another, so the stream can be cut
 * on `CREATE TABLE` boundaries and each table restored into its OWN throwaway
 * database, counted, integrity-checked, and deleted before the next begins.
 *
 *   peak disk  =  the largest SINGLE table          (was: the entire database)
 *
 * What is still proven, per table, on every row:
 *   · real SQLite parses and executes every INSERT (not a text scan)
 *   · `PRAGMA integrity_check` walks the btree it just built
 *   · `SELECT COUNT(*)` equals the dumper's own embedded rowcount manifest
 *   · every table named in the manifest was actually seen in the stream
 *
 * What this does NOT prove, exactly as the whole-database version did not:
 * index/trigger/view DDL is not executed (it is emitted after the data, behind
 * the `-- section:post-data-ddl` marker, and stays in the artifact for real
 * restores), and cross-table foreign keys are not enforced. Restoring for real
 * is still `zstdcat data.sql.zst | sqlite3 data.db`.
 *
 * Usage:  zstdcat backup/data.sql.zst | node scripts/db-verify-stream.cjs
 *         --workdir <dir>   where throwaway per-table databases are built
 *         --summary <file>  write a one-line human summary here
 *         --sqlite3 <path>  sqlite3 binary (default: sqlite3 on PATH)
 *
 * Exits non-zero on: a missing/truncated dump, a table whose restored count
 * disagrees with the manifest, a failed integrity_check, or a manifest table
 * the stream never contained.
 */
"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const WORKDIR = arg("workdir", path.join(process.env.RUNNER_TEMP || "/tmp", "hf-verify"));
const SUMMARY = arg("summary", null);
const SQLITE3 = arg("sqlite3", "sqlite3");
// The manifest lives at the very end of the stream, so per-table counts can only
// be CHECKED once the stream is done. Observed counts are held here meanwhile —
// one integer per table, never rows.
const observed = new Map();
const integrity = new Map();
const log = (s) => process.stderr.write(`${s}\n`);

/** A table currently being restored: its own database, and the sqlite3 eating its stream. */
class TableRestore {
  constructor(name, index) {
    this.name = name;
    this.dbPath = path.join(WORKDIR, `t${index}.db`);
    this.bytes = 0;
    // journal_mode=OFF: this database is thrown away on the next line, so a
    // rollback journal would only double the peak for nothing.
    this.proc = spawn(SQLITE3, [this.dbPath], { stdio: ["pipe", "ignore", "pipe"] });
    this.stderr = "";
    this.proc.stderr.on("data", (b) => { this.stderr += String(b); });
    this.failed = new Promise((resolve) => {
      this.proc.on("error", (e) => resolve(new Error(`sqlite3 could not start: ${e.message}`)));
      this.proc.on("close", (code) => resolve(code === 0 ? null : new Error(`sqlite3 exited ${code}: ${this.stderr.trim().slice(0, 400)}`)));
    });
    this.write("PRAGMA journal_mode=OFF;\nPRAGMA synchronous=OFF;\nBEGIN;\n");
  }

  /** Backpressure matters: a 20 GB stream will outrun sqlite3 and balloon RSS otherwise. */
  write(chunk) {
    if (this.proc.stdin.destroyed) return Promise.resolve();
    return this.proc.stdin.write(chunk) ? Promise.resolve() : new Promise((r) => this.proc.stdin.once("drain", r));
  }

  async finish() {
    await this.write("COMMIT;\n");
    this.proc.stdin.end();
    const err = await this.failed;
    if (err) throw new Error(`restoring ${this.name}: ${err.message}`);

    // Ask the restored database itself, rather than trusting our own line count.
    const q = spawnSync(SQLITE3, [this.dbPath, "PRAGMA integrity_check;", `SELECT COUNT(*) FROM "${this.name.replace(/"/g, '""')}";`], { encoding: "utf8" });
    if (q.status !== 0) throw new Error(`querying ${this.name}: ${(q.stderr || "").trim().slice(0, 400)}`);
    const out = String(q.stdout).trim().split("\n").map((s) => s.trim()).filter(Boolean);
    const count = Number(out[out.length - 1]);
    const ic = out.slice(0, -1).join("; ") || "ok";
    integrity.set(this.name, ic);
    observed.set(this.name, Number.isFinite(count) ? count : -1);
    // Delete BEFORE the next table starts — this is the whole point.
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      try { fs.unlinkSync(this.dbPath + suffix); } catch { /* absent is fine */ }
    }
    return { name: this.name, count, ic };
  }
}

async function main() {
  fs.mkdirSync(WORKDIR, { recursive: true });
  for (const f of fs.readdirSync(WORKDIR)) {
    if (/^t\d+\.db/.test(f)) { try { fs.unlinkSync(path.join(WORKDIR, f)); } catch { /* ignore */ } }
  }

  const manifest = new Map();
  let sawComplete = false;
  let inPostDataDdl = false;
  let current = null;
  let tableIndex = 0;
  let biggest = { name: null, bytes: 0 };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  // A stream cut mid-INSERT (SSH drop, OOM-kill on the box) reaches sqlite3 as a
  // syntax error, which reads like a corrupt dump. It is not — it is a short
  // one, and saying so is the difference between "re-run the backup" and a
  // corruption hunt. The sentinel is what tells the two apart.
  try {
    await consume();
  } catch (e) {
    if (!sawComplete) {
      log(`FAIL: stream ended without the \`-- dump-complete\` sentinel — it was CUT, not corrupt.`);
      log(`      (the failure surfaced as: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)})`);
      process.exit(1);
    }
    throw e;
  }

  async function consume() {
  for await (const line of rl) {
    // ── the trailer: manifest + completeness sentinel ─────────────────────
    if (line.startsWith("-- ")) {
      if (line === "-- section:post-data-ddl") {
        // Everything after this is index/trigger/view DDL, deliberately not
        // executed here (it is what made the old full restore too big).
        if (current) { await closeTable(); }
        inPostDataDdl = true;
        continue;
      }
      if (line === "-- dump-complete") { sawComplete = true; continue; }
      const m = /^-- rowcount "((?:[^"]|"")*)" (\d+)$/.exec(line);
      if (m) { manifest.set(m[1].replace(/""/g, '"'), Number(m[2])); continue; }
      continue;
    }
    if (inPostDataDdl) continue;

    // ── the AUTOINCREMENT high-water block ────────────────────────────────
    // The dumper writes `DELETE FROM sqlite_sequence;` + its INSERTs AFTER the
    // last table and before the post-data marker. It belongs to no table and
    // carries no manifest rowcount, and feeding it into the last table's
    // throwaway database fails outright when that table is an rtree (no
    // sqlite_sequence exists there). End the current table and skip it.
    if (/^(DELETE FROM sqlite_sequence|INSERT INTO sqlite_sequence)\b/.test(line)) {
      if (current) await closeTable();
      continue;
    }

    // ── table boundary ────────────────────────────────────────────────────
    // The dumper emits `CREATE TABLE ...` — or `CREATE VIRTUAL TABLE ... USING
    // rtree(...)` for address_points_rtree — at the start of a line for each
    // table, then only that table's INSERTs (each one a single line) until the
    // next CREATE. An INSERT line always begins `INSERT INTO`, so a stored
    // VALUE that merely CONTAINS "CREATE TABLE" cannot be mistaken for a
    // boundary (there is a row in the test fixture that does exactly that).
    const create = /^CREATE (?:VIRTUAL )?TABLE (?:IF NOT EXISTS )?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*)/.exec(line);
    if (create) {
      if (current) await closeTable();
      current = new TableRestore(unquote(create[1]), tableIndex++);
    }
    if (!current) continue;   // PRAGMA/BEGIN preamble before the first table
    current.bytes += line.length + 1;
    if (current.bytes > biggest.bytes) biggest = { name: current.name, bytes: current.bytes };
    await current.write(line + "\n");
  }
  if (current) await closeTable();
  }

  async function closeTable() {
    const t = current;
    current = null;
    const r = await t.finish();
    log(`  ${r.name.padEnd(38)} ${String(r.count).padStart(10)} rows   integrity=${r.ic}`);
  }

  // ── verdicts ────────────────────────────────────────────────────────────
  if (!sawComplete) {
    log("FAIL: stream ended without the `-- dump-complete` sentinel — it was cut, not finished");
    process.exit(1);
  }
  if (!manifest.size) {
    log("FAIL: no `-- rowcount` manifest in the dump; nothing to verify counts against");
    process.exit(1);
  }

  const problems = [];
  for (const [table, expected] of manifest) {
    if (!observed.has(table)) { problems.push(`${table}: in the manifest but never appeared in the stream`); continue; }
    const got = observed.get(table);
    if (got !== expected) problems.push(`${table}: dumped ${expected}, restored ${got}`);
    const ic = integrity.get(table);
    if (ic !== "ok") problems.push(`${table}: integrity_check said "${ic}"`);
  }
  for (const table of observed.keys()) {
    if (!manifest.has(table)) problems.push(`${table}: restored but absent from the manifest`);
  }

  const rows = [...manifest.values()].reduce((a, b) => a + b, 0);
  const summary = `${manifest.size} tables, ${rows} rows, restored and count-verified one table at a time`
    + (biggest.name ? ` (largest: ${biggest.name}, ${(biggest.bytes / 1048576).toFixed(0)} MiB of SQL — that, not the whole database, is the peak disk)` : "");
  log("");
  if (problems.length) {
    log(`FAIL: ${problems.length} problem(s)`);
    for (const p of problems.slice(0, 25)) log(`  ${p}`);
    process.exit(1);
  }
  log(`OK: ${summary}`);
  if (SUMMARY) fs.writeFileSync(SUMMARY, summary);
}

function unquote(id) {
  if (id.startsWith('"')) return id.slice(1, -1).replace(/""/g, '"');
  if (id.startsWith("`")) return id.slice(1, -1).replace(/``/g, "`");
  if (id.startsWith("[")) return id.slice(1, -1);
  return id;
}

main().catch((e) => {
  log(`[db-verify-stream] FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
