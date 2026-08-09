#!/usr/bin/env node
/**
 * Stream a consistent SQL dump of the SQLite database to stdout.
 *
 * WHY THIS EXISTS
 * The box cannot hold a backup of its own database: data.db is ~19 GB and the
 * disk has ~6 GB free, which is why scripts/backup.sh (on-box staging + age
 * encryption, cron per INFRASTRUCTURE.md) has never once run in production.
 * The only viable copy is one that LEAVES the machine as it is produced. This
 * dumper is that stream: db-backup.yml mounts it into the app image on the
 * host, pipes stdout over SSH to the Actions runner, and the runner compresses,
 * restores, verifies, and uploads — the box never stages a byte.
 *
 * Plain CommonJS on purpose: it runs with the image's node + node_modules
 * (better-sqlite3 is a production dep), so it needs no build step and works
 * against the CURRENTLY RUNNING image, whatever that is.
 *
 * CONSISTENCY: one read transaction for the whole dump (WAL MVCC snapshot).
 * Writers are never blocked, but the long-held read mark starves
 * wal_checkpoint(TRUNCATE) for the duration — run this off-hours and expect
 * the WAL to grow until the dump ends (db.ts wal_guard reclaims after).
 *
 * OUTPUT CONTRACT (consumed by db-backup.yml's verifier):
 *   · valid SQL for `sqlite3 fresh.db` — schema, data, then indexes/triggers/
 *     views, wrapped in one transaction with foreign_keys off;
 *   · one `-- rowcount "table" N` comment line per table AT THE END, counted
 *     during row iteration inside the same snapshot — the restore verifier
 *     compares COUNT(*) per restored table against exactly these lines;
 *   · a final `-- dump-complete` line. A stream that ends without it (SSH cut,
 *     OOM-kill, crash) MUST be treated as no backup at all.
 *
 * Refuses virtual tables (FTS etc.): their shadow tables need writable_schema
 * tricks this deliberately does not do. The schema has none today; if one
 * appears, this fails loudly rather than uploading a backup that cannot
 * restore. Generated columns are handled (excluded from INSERT column lists).
 */
const path = require("node:path");

const DB_PATH = process.argv[2] || path.join(process.env.DATA_DIR || "/data", "data.db");
const Database = require("better-sqlite3");
const db = new Database(DB_PATH, { readonly: true });
db.pragma("busy_timeout = 30000");

const CHUNK = 1024 * 1024; // ~1 MiB write batches keep syscall count sane
let buf = "";
async function out(line) {
  buf += line + "\n";
  if (buf.length >= CHUNK) {
    const chunk = buf;
    buf = "";
    if (!process.stdout.write(chunk)) {
      await new Promise((r) => process.stdout.once("drain", r));
    }
  }
}
async function flush() {
  if (buf.length) {
    const chunk = buf;
    buf = "";
    process.stdout.write(chunk);
  }
  await new Promise((r) => process.stdout.write("", r));
}

const qid = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function main() {
  db.exec("BEGIN"); // deferred; the first read below pins the snapshot

  const master = db
    .prepare(`SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)
    .all();

  const virtual = master.filter((r) => r.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql));
  if (virtual.length) {
    throw new Error(`virtual tables present (${virtual.map((v) => v.name).join(", ")}) — dumper does not support their shadow tables; extend it before backing up`);
  }

  const tables = master.filter((r) => r.type === "table");
  const counts = [];

  await out("PRAGMA foreign_keys=OFF;");
  await out("BEGIN TRANSACTION;");

  for (const t of tables) {
    await out(t.sql.replace(/\s+$/, "") + ";");
    // table_xinfo lists generated columns with hidden 2 (VIRTUAL) / 3 (STORED);
    // both are computed by the restore-side schema and must not be inserted.
    const cols = db
      .prepare(`PRAGMA table_xinfo(${qid(t.name)})`)
      .all()
      .filter((c) => c.hidden === 0)
      .map((c) => c.name);
    if (!cols.length) { counts.push([t.name, 0]); continue; }
    const colList = cols.map(qid).join(",");
    const selectList = cols.map((c) => `quote(${qid(c)})`).join(`||','||`);
    const prefix = `INSERT INTO ${qid(t.name)}(${colList}) VALUES(`;
    let n = 0;
    for (const row of db.prepare(`SELECT ${selectList} AS v FROM ${qid(t.name)}`).raw().iterate()) {
      await out(prefix + row[0] + ");");
      n++;
    }
    counts.push([t.name, n]);
  }

  // AUTOINCREMENT high-water marks. sqlite_sequence exists on the restore side
  // as soon as the first AUTOINCREMENT table above is created.
  const hasSeq = db.prepare(`SELECT 1 FROM sqlite_master WHERE name='sqlite_sequence'`).get();
  if (hasSeq) {
    await out("DELETE FROM sqlite_sequence;");
    for (const row of db.prepare(`SELECT quote(name)||','||quote(seq) AS v FROM sqlite_sequence`).raw().iterate()) {
      await out(`INSERT INTO sqlite_sequence(name,seq) VALUES(${row[0]});`);
    }
  }

  // Indexes/triggers/views after the data: restoring rows into indexed tables
  // would rebuild every index per-insert instead of once here.
  for (const r of master) {
    if (r.type !== "table") await out(r.sql.replace(/\s+$/, "") + ";");
  }

  await out("COMMIT;");
  for (const [name, n] of counts) await out(`-- rowcount ${qid(name)} ${n}`);
  await out("-- dump-complete");
  await flush();
  db.exec("COMMIT");
  db.close();
}

main().catch((e) => {
  console.error(`[db-dump-stream] FAILED: ${e?.message ?? e}`);
  process.exit(1);
});
