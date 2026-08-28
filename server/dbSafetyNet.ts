// ── The safety net under data.db ─────────────────────────────────────────────
// On 2026-08-06 the development database was destroyed and nobody found out for
// twenty minutes. Not by a bad DELETE — by the FILE going away. SQLite creates
// a database when one is missing, the app migrated it, bootstrapped a tenant,
// and served a perfectly healthy-looking empty portal. Every row of field work
// was gone and the only symptom was a login screen.
//
// Two things were missing, and this module is both of them.
//
// ── 1. A TRIPWIRE THAT LIVES OUTSIDE THE DATABASE ───────────────────────────
//
// The obvious guard — "remember in the database how much data we had" — is
// worthless here, because the event being guarded against destroys the
// database. Any marker inside data.db dies with the rows it was supposed to
// vouch for, and a blank database plus a blank marker reads as a brand-new
// install, which is exactly the story that took twenty minutes to disbelieve.
//
// So the high-water mark is a SIDECAR FILE. If the database comes up empty
// while the sidecar remembers 6,048 leads, that is not a new install — it is a
// loss, and boot says so at error level with the newest snapshot named in the
// log line.
//
// ── 2. A LOCAL SNAPSHOT ─────────────────────────────────────────────────────
//
// Litestream replicates PRODUCTION (deploy/litestream.yml). Development had
// nothing, so the only copy that existed on 2026-08-06 was one another process
// happened to leave in a temp directory — and it was a hot `cp`, torn across
// pages, salvageable only because the business tables happened to sit on intact
// ones. That is luck, not a backup.
//
// `VACUUM INTO` is the SQLite-sanctioned way to take a consistent copy of a
// live database: it reads inside a transaction, so it cannot tear, and it
// writes a compacted file. It is not free on a gigabyte, which is why it is
// interval-gated, deferred well past boot, and skipped entirely when the newest
// snapshot is still young.
//
// NEVER RUNS IN TESTS. The suite points DATA_DIR at a temp directory per file;
// snapshotting each one would be pure cost.

import fs from "node:fs";
import path from "node:path";
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

const dataDir = process.env.DATA_DIR || process.cwd();
const dbPath = path.join(dataDir, "data.db");
const backupDir = path.join(dataDir, "backups");
/** Outside the database ON PURPOSE — see the header. */
const watermarkPath = path.join(backupDir, "watermark.json");

/** Hours between snapshots. A boot inside the window takes none. */
const SNAPSHOT_EVERY_HOURS = Number(process.env.DB_SNAPSHOT_EVERY_HOURS ?? 6);
/** How many snapshots to keep. Oldest are removed after a successful write. */
const SNAPSHOT_KEEP = Number(process.env.DB_SNAPSHOT_KEEP ?? 3);
/** Refuse to snapshot when the volume is this close to full — a backup that
 *  fills the disk takes the app down, which is worse than no backup. */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

function enabled(): boolean {
  if (process.env.NODE_ENV === "test") return false;
  if (process.env.DB_SNAPSHOTS === "off") return false;
  return true;
}

/** The tables whose emptiness means something went wrong, rather than that the
 *  org has not started yet. Deliberately business data, not telemetry: a scan
 *  cache is empty on plenty of healthy days. */
const WITNESS_TABLES = ["users", "team_members", "leads", "knock_log", "commissions"] as const;

export interface DbCensus { [table: string]: number }

function census(): DbCensus {
  const out: DbCensus = {};
  for (const t of WITNESS_TABLES) {
    try {
      out[t] = Number((rawDb.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as any)?.n ?? 0);
    } catch {
      out[t] = 0; // table not created yet on this database
    }
  }
  return out;
}

interface Watermark {
  /** Highest count ever seen per table. Monotonic: a legitimate delete must not
   *  quietly lower the bar the next check is measured against. */
  peak: DbCensus;
  /** When the peak was last raised. */
  at: string;
}

function readWatermark(): Watermark | null {
  try {
    const raw = fs.readFileSync(watermarkPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.peak) return null;
    return parsed as Watermark;
  } catch { return null; }
}

function writeWatermark(w: Watermark): void {
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated file that
    // reads as "this database never had anything".
    const tmp = `${watermarkPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(w, null, 2));
    fs.renameSync(tmp, watermarkPath);
  } catch (e: any) {
    console.warn("[db-safety] could not record watermark:", e?.message);
  }
}

export function newestSnapshot(): string | null {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith("data-") && f.endsWith(".db"))
      .sort();
    return files.length ? path.join(backupDir, files[files.length - 1]) : null;
  } catch { return null; }
}

/**
 * Did this database come up empty when it should not have?
 *
 * Returns the tables that lost everything. Called at boot BEFORE anything is
 * written, so the answer describes the database as it was found.
 *
 * A first-ever boot has no watermark and is silent — the check can only fire
 * once a previous run has seen real data, which is exactly the condition that
 * makes emptiness suspicious.
 */
export function checkForSilentReset(): { lost: string[]; watermark: Watermark | null } {
  const mark = readWatermark();
  if (!mark) return { lost: [], watermark: null };

  const now = census();
  const lost = WITNESS_TABLES.filter(t => (mark.peak[t] ?? 0) > 0 && (now[t] ?? 0) === 0);
  if (lost.length === 0) return { lost: [], watermark: mark };

  const snapshot = newestSnapshot();
  // Error level, one line, with the restore path already in it. The whole point
  // is that nobody should have to work out what happened from a login screen.
  structuredLog("db.blank_start", {
    lostTables: lost.join(","),
    peak: JSON.stringify(mark.peak),
    peakAt: mark.at,
    newestSnapshot: snapshot,
    hint: snapshot
      ? `data.db appears to have been replaced. Restore with: cp '${snapshot}' '${dbPath}' (stop the server first)`
      : "data.db appears to have been replaced and NO local snapshot exists.",
  }, "error");
  console.error(
    `\n[db-safety] ${lost.join(", ")} came up EMPTY but this database previously held ` +
    `${lost.map(t => `${mark.peak[t]} ${t}`).join(", ")} (as of ${mark.at}).\n` +
    (snapshot
      ? `[db-safety] Newest snapshot: ${snapshot}\n[db-safety] Restore: stop the server, then  cp '${snapshot}' '${dbPath}'\n`
      : `[db-safety] No local snapshot exists to restore from.\n`),
  );
  return { lost, watermark: mark };
}

/** Raise the high-water mark to whatever this database now holds. Monotonic —
 *  see Watermark.peak. */
export function recordWatermark(): DbCensus {
  const now = census();
  const prev = readWatermark();
  const peak: DbCensus = { ...prev?.peak };
  let raised = false;
  for (const t of WITNESS_TABLES) {
    if ((now[t] ?? 0) > (peak[t] ?? 0)) { peak[t] = now[t]; raised = true; }
  }
  if (raised || !prev) writeWatermark({ peak, at: new Date().toISOString() });
  return now;
}

function freeBytes(dir: string): number {
  try {
    const s: any = (fs as any).statfsSync?.(dir);
    if (s && Number.isFinite(s.bavail) && Number.isFinite(s.bsize)) return s.bavail * s.bsize;
  } catch { /* statfs unavailable on this platform/node */ }
  return Number.POSITIVE_INFINITY; // unknown → do not block the backup
}

function snapshotIsDue(): boolean {
  const newest = newestSnapshot();
  if (!newest) return true;
  try {
    const ageMs = Date.now() - fs.statSync(newest).mtimeMs;
    return ageMs >= SNAPSHOT_EVERY_HOURS * 3_600_000;
  } catch { return true; }
}

function pruneSnapshots(): string[] {
  const removed: string[] = [];
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith("data-") && f.endsWith(".db"))
      .sort();
    while (files.length > Math.max(1, SNAPSHOT_KEEP)) {
      const victim = files.shift()!;
      fs.unlinkSync(path.join(backupDir, victim));
      removed.push(victim);
    }
  } catch { /* best effort */ }
  return removed;
}

/**
 * Take a consistent snapshot, if one is due.
 *
 * `VACUUM INTO` reads inside a transaction, so unlike `cp` it cannot produce
 * the torn file that made the 2026-08-06 recovery a salvage job. Returns the
 * path written, or null when nothing was due (or it was skipped).
 */
export function snapshotIfDue(): string | null {
  if (!enabled()) return null;
  try {
    if (!fs.existsSync(dbPath)) return null;
    // An empty database is not worth a backup, and worse, rotating one in could
    // push the last GOOD snapshot out of retention.
    const now = census();
    if (WITNESS_TABLES.every(t => (now[t] ?? 0) === 0)) return null;
    if (!snapshotIsDue()) return null;

    fs.mkdirSync(backupDir, { recursive: true });
    const free = freeBytes(backupDir);
    const need = fs.statSync(dbPath).size;
    if (free < need + MIN_FREE_BYTES) {
      structuredLog("db.snapshot_skipped", { reason: "low_disk", freeBytes: free, needBytes: need }, "warn");
      return null;
    }

    // Millisecond precision, then a collision guard. VACUUM INTO refuses to
    // overwrite — good, that is what stops a backup clobbering a backup — but it
    // means a second-resolution stamp turns two snapshots in the same second
    // into a hard failure. The interval gate makes that rare in production and
    // routine anywhere the interval is set to 0.
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/[.]/, "-").replace(/Z$/, "");
    let target = path.join(backupDir, `data-${stamp}.db`);
    for (let n = 1; fs.existsSync(target) && n <= 50; n++) {
      target = path.join(backupDir, `data-${stamp}-${n}.db`);
    }
    const started = Date.now();
    rawDb.prepare(`VACUUM INTO ?`).run(target);
    const bytes = fs.statSync(target).size;
    const removed = pruneSnapshots();

    structuredLog("db.snapshot", {
      path: target, bytes, ms: Date.now() - started, keep: SNAPSHOT_KEEP,
      removed: removed.join(",") || null,
    });
    return target;
  } catch (e: any) {
    // A failed backup must never take the app down. It is a safety net, not a
    // dependency.
    structuredLog("db.snapshot_failed", { error: String(e?.message ?? e).slice(0, 200) }, "error");
    console.warn("[db-safety] snapshot failed:", e?.message);
    return null;
  }
}

/**
 * Boot entry point. Order matters:
 *
 *   1. CHECK first, while the database is still exactly as it was found. Doing
 *      it after any write would race the very thing being detected.
 *   2. Record the watermark, so the next boot has something to measure against.
 *   3. Defer the snapshot well past startup — it reads the whole file, and
 *      nothing about a backup deserves to sit in front of the health gate.
 */
export function installDbSafetyNet(deferMs = 3 * 60_000): { lost: string[] } {
  if (!enabled()) return { lost: [] };
  const { lost } = checkForSilentReset();
  recordWatermark();
  const t = setTimeout(() => {
    try { snapshotIfDue(); } catch { /* already logged */ }
  }, deferMs);
  if (typeof (t as any).unref === "function") t.unref();
  // …and keep checking, so a long-lived process still snapshots on schedule.
  const every = setInterval(() => {
    try { recordWatermark(); snapshotIfDue(); } catch { /* already logged */ }
  }, 30 * 60_000);
  if (typeof (every as any).unref === "function") every.unref();
  return { lost };
}
