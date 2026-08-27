// ── Backfill scan_targets.canonical_key ──────────────────────────────────────
//
// WHY THIS EXISTS
// storage.upsertScanTargets guards against re-spelling a house into a second
// row with a CANONICAL-TWIN lookup:
//     SELECT id FROM scan_targets WHERE tenant_id IS ? AND canonical_key = ?
// That guard cannot fire on a row whose canonical_key is NULL. Rows harvested
// before the key was stamped at insert time carry NULL, so the guard is blind
// on them and only the weaker city-alias twin (street_key + house number +
// coordinates within ~25m, which needs coordinates) remains. The observed cost
// is duplicate doors: "1131 Bird Dog Tr" / "Trl" / "Trail" as three rows for
// one house, and the same door scanned twice weeks apart.
//
// This is a REPAIR of legacy rows, not a fix to the insert path — both live
// insert paths (storage.upsertScanTargets and kineticObservation) already
// compute and stamp the key. Every NULL in the local database was created on
// or before 2026-07-18; every row created since carries a key.
//
// WHAT IT DOES / DOES NOT DO
//   DOES     set canonical_key = normalizeKineticAddressKey(address, city,
//            state, zip) wherever it is NULL and canonicalAddressPart(address)
//            is non-empty — the exact rule upsertScanTargets applies to new rows.
//   DOES NOT merge, delete, or rewrite anything. Backfilling REVEALS duplicate
//            groups (rows that now share a key); merging them is a separate,
//            destructive decision and this script only reports them.
//
// SAFETY PROPERTIES
//   * Forward-only. The only write is NULL -> non-NULL on one column.
//   * Restart-safe. The batch predicate is `canonical_key IS NULL AND id > ?`,
//     so an interrupted run resumes: finished rows have dropped out of the
//     predicate and the id watermark never revisits them. Re-running a
//     completed backfill is a no-op.
//   * WAL-friendly. The table is ~920k rows in a 3.4 GB file and the WAL guard
//     checkpoints synchronously (server/walGuard.ts), so a single long write
//     transaction would pin the WAL and stall every other writer. Writes go in
//     small BEGIN IMMEDIATE batches with a pause between them, which also lets
//     a concurrent scan run take the write lock.
//   * The dry run opens the database READ-ONLY, so it physically cannot write.
//
// USAGE — dry run is the default.
//   tsx script/backfill-scan-target-canonical-keys.ts
//   tsx script/backfill-scan-target-canonical-keys.ts --apply
// Options:
//   --tenant <id>   restrict to one tenant (default: all)
//   --batch <n>     rows per write transaction (default 2000)
//   --pause <ms>    idle gap between write batches (default 25)
//   --groups <n>    duplicate groups to print in full (default 25)
//   --csv <path>    write every revealed duplicate group to CSV

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { canonicalAddressPart, normalizeKineticAddressKey, streetKeyOf } from "../shared/addressKey";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes("--apply");
const TENANT = flag("tenant") != null ? Number(flag("tenant")) : null;
const BATCH = Math.max(100, Number(flag("batch") ?? 2000) || 2000);
const PAUSE_MS = Math.max(0, Number(flag("pause") ?? 25) || 0);
const SHOW_GROUPS = Math.max(0, Number(flag("groups") ?? 25) || 0);
const CSV_PATH = flag("csv") ?? null;

if (TENANT != null && (!Number.isInteger(TENANT) || TENANT <= 0)) {
  console.error("--tenant must be a positive integer");
  process.exit(1);
}

const dbPath = path.join(process.env.DATA_DIR || process.cwd(), "data.db");
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DATA_DIR to the directory holding data.db.`);
  process.exit(1);
}

// Dry run opens READ-ONLY: the safety property is enforced by SQLite, not by
// this script remembering to skip its writes.
const db = new Database(dbPath, { readonly: !APPLY });
db.pragma("busy_timeout = 30000");

type Row = { id: number; tenant_id: number | null; address: string; city: string; state: string; zip: string | null };

/** The key upsertScanTargets would stamp on this row, or null when the address
 *  has no canonical street part (a degenerate "|CITY|STATE" key must never be
 *  written — it would make every street-less row in a city one another's twin). */
function keyFor(r: Row): string | null {
  const streetPart = canonicalAddressPart(r.address ?? "");
  if (!streetPart) return null;
  return normalizeKineticAddressKey(r.address ?? "", r.city ?? "", r.state ?? "NC", r.zip ?? "");
}

// One SQL shape for both scopes: better-sqlite3 rejects a named parameter the
// statement does not reference, so @tenant is always bound and NULL means "all".
const tenantSql = "AND (@tenant IS NULL OR tenant_id = @tenant)";
const selectBatch = db.prepare(
  `SELECT id, tenant_id, address, city, state, zip FROM scan_targets
    WHERE canonical_key IS NULL AND id > @afterId ${tenantSql}
    ORDER BY id LIMIT @limit`,
);

/** Walk every NULL-key row once, in primary-key order. The watermark is what
 *  makes this both restart-safe and linear: each batch resumes where the last
 *  ended instead of re-scanning the table, and rows we deliberately SKIP (no
 *  street part) cannot trap the loop the way a bare `IS NULL LIMIT n` would. */
function* eachNullKeyRow(): Generator<Row[]> {
  let afterId = 0;
  for (;;) {
    const rows = selectBatch.all({ afterId, limit: BATCH, tenant: TENANT }) as Row[];
    if (!rows.length) return;
    afterId = rows[rows.length - 1].id;
    yield rows;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

async function main() {
  const t0 = Date.now();
  const scope = TENANT != null ? `tenant ${TENANT}` : "all tenants";
  console.log(`scan_targets canonical_key backfill — ${scope} — ${APPLY ? "APPLY (writing)" : "DRY RUN (read-only)"}`);
  console.log(`database ${dbPath}\n`);

  const totals = db.prepare(
    `SELECT COUNT(*) AS rows, SUM(canonical_key IS NULL) AS nullKey
       FROM scan_targets WHERE 1=1 ${tenantSql}`,
  ).get({ tenant: TENANT }) as { rows: number; nullKey: number };
  console.log(`rows ${totals.rows.toLocaleString()}   canonical_key IS NULL ${totals.nullKey.toLocaleString()} (${pct(totals.nullKey, totals.rows)})`);

  // ── Preflight: has the canonical index already been promoted to UNIQUE? ────
  // yieldRollups step 5 promotes idx_scan_targets_canonical to UNIQUE via
  // scanTargetCanonicalMerge.promoteCanonicalUnique(), gated on
  // dryRunManifest().sameCanonicalGroups === 0. That manifest counts only rows
  // WHERE canonical_key IS NOT NULL, so NULL-key duplicates are invisible to it
  // and the gate can read "all clear" while thousands of duplicate groups hide
  // behind NULL. If the index is already UNIQUE, stamping those keys makes the
  // collisions real and every colliding UPDATE throws — this backfill must run
  // BEFORE the promotion, never after.
  const canonIdx = db.prepare(
    `SELECT "unique" AS uniq FROM pragma_index_list('scan_targets') WHERE name = 'idx_scan_targets_canonical'`,
  ).get() as { uniq: number } | undefined;
  const canonUnique = Number(canonIdx?.uniq ?? 0) === 1;
  console.log(`idx_scan_targets_canonical: ${canonIdx ? (canonUnique ? "UNIQUE" : "non-unique") : "absent"}`);
  if (canonUnique && APPLY) {
    console.error(
      `\nREFUSING TO APPLY — idx_scan_targets_canonical is already UNIQUE.\n` +
      `Backfilling would make hidden duplicate groups collide and every colliding\n` +
      `UPDATE would fail. Re-run the dry run to size the duplicate groups, decide\n` +
      `the merge, drop the UNIQUE index, backfill, merge, then re-promote.`);
    process.exit(2);
  }

  // ── Pass 1: compute the key every NULL row would get ───────────────────────
  // Staged in TEMP (a separate database, writable even on a read-only main
  // connection) so the collision analysis below is plain SQL against the real
  // table instead of a 900k-entry map in this process.
  db.exec(`CREATE TEMP TABLE bf (id INTEGER PRIMARY KEY, tenant_id INTEGER, ck TEXT NOT NULL, streetless INTEGER NOT NULL)`);
  const stageOne = db.prepare(`INSERT INTO bf (id, tenant_id, ck, streetless) VALUES (?,?,?,?)`);
  const stage = db.transaction((rows: Array<[number, number | null, string, number]>) => {
    for (const r of rows) stageOne.run(r[0], r[1], r[2], r[3]);
  });

  let seen = 0, keyable = 0, skipped = 0, streetless = 0;
  const skippedSamples: Row[] = [];
  const writeStmt = APPLY
    ? db.prepare(`UPDATE scan_targets SET canonical_key = ? WHERE id = ? AND canonical_key IS NULL`)
    : null;
  // One BEGIN IMMEDIATE per batch, deliberately short. Applying all ~295k rows
  // in one transaction would hold the write lock for minutes and pin the WAL.
  const writeBatch = APPLY
    ? db.transaction((rows: Array<[number, string]>) => {
        let n = 0;
        for (const [id, ck] of rows) n += writeStmt!.run(ck, id).changes;
        return n;
      })
    : null;

  let written = 0, batches = 0, slowestBatchMs = 0;
  const failures: Array<{ id: number; ck: string; error: string }> = [];

  for (const rows of eachNullKeyRow()) {
    const staged: Array<[number, number | null, string, number]> = [];
    const writes: Array<[number, string]> = [];
    for (const r of rows) {
      seen++;
      const ck = keyFor(r);
      if (!ck) {
        skipped++;
        if (skippedSamples.length < 10) skippedSamples.push(r);
        continue;
      }
      keyable++;
      // An address with no street name ("Apt 5", "#") still has a canonical
      // part, so it passes the guard upsertScanTargets uses — but its key is
      // effectively city-wide. Counted and reported, never silently dropped.
      const isStreetless = streetKeyOf(r.address) === "" ? 1 : 0;
      streetless += isStreetless;
      staged.push([r.id, r.tenant_id, ck, isStreetless]);
      writes.push([r.id, ck]);
    }
    if (staged.length) stage(staged);
    if (APPLY && writes.length) {
      const tb = Date.now();
      try {
        // .immediate() takes the write lock up front. A deferred transaction
        // would start as a reader and try to upgrade on the first UPDATE, which
        // is the shape that returns SQLITE_BUSY when a scan run holds the lock.
        written += writeBatch!.immediate(writes);
      } catch (e: any) {
        // One bad row must not cost the other 1,999. Retry the batch row by row
        // so the run continues and the failures are named rather than swallowed.
        console.warn(`\n  batch failed (${String(e?.message ?? e).slice(0, 120)}) — retrying row by row`);
        for (const [id, ck] of writes) {
          try { written += writeStmt!.run(ck, id).changes; }
          catch (rowErr: any) { failures.push({ id, ck, error: String(rowErr?.message ?? rowErr).slice(0, 120) }); }
        }
      }
      const ms = Date.now() - tb;
      if (ms > slowestBatchMs) slowestBatchMs = ms;
      batches++;
      if (batches % 20 === 0) process.stdout.write(`\r  written ${written.toLocaleString()}/${keyable.toLocaleString()}`);
      // Yield the write lock so a concurrent scan run is not starved.
      if (PAUSE_MS) await sleep(PAUSE_MS);
    } else if (!APPLY && seen % 50000 < BATCH) {
      process.stdout.write(`\r  examined ${seen.toLocaleString()}`);
    }
  }
  process.stdout.write("\r".padEnd(48) + "\r");

  console.log(`\nrows examined            ${seen.toLocaleString()}`);
  console.log(`keys ${APPLY ? "written  " : "computable"}          ${keyable.toLocaleString()} (${pct(keyable, seen)})`);
  console.log(`skipped (no street part) ${skipped.toLocaleString()}`);
  if (streetless) {
    console.log(`  of which street-less    ${streetless.toLocaleString()}  <-- key is city-wide ("UNIT|CITY|ST"); see note below`);
  }
  if (skippedSamples.length) {
    console.log(`  sample skipped addresses: ${skippedSamples.map((r) => JSON.stringify(r.address)).join(", ")}`);
  }
  if (APPLY) {
    console.log(`rows actually updated    ${written.toLocaleString()} in ${batches.toLocaleString()} transactions (slowest ${slowestBatchMs} ms)`);
    if (written !== keyable) {
      console.log(`  NOTE ${(keyable - written).toLocaleString()} row(s) were keyed by another writer mid-run (the UPDATE is guarded on canonical_key IS NULL).`);
    }
    if (failures.length) {
      console.log(`rows that FAILED to write   ${failures.length.toLocaleString()}`);
      for (const f of failures.slice(0, 10)) console.log(`  #${f.id} ${f.ck}: ${f.error}`);
      console.log(`  Re-running the script retries them (the predicate is still canonical_key IS NULL).`);
    }
  }

  db.exec(`CREATE INDEX temp.bf_ck ON bf(tenant_id, ck)`);

  // ── Pass 2: which duplicate groups does this reveal? ──────────────────────
  // The post-backfill key universe = the keys we just computed, plus the keys
  // already stored. A group is any (tenant_id, canonical_key) holding more than
  // one row. Reported only, never merged.
  // The NOT EXISTS matters whenever another writer is live: a row read as NULL
  // in pass 1 (so it is in bf) can be keyed by a concurrent harvest before this
  // query runs, and would then appear in BOTH arms — one row counted twice,
  // inventing a duplicate group of a row with itself. bf wins for those ids.
  db.exec(`
    CREATE TEMP TABLE post AS
      SELECT id, tenant_id, ck, 1 AS is_new FROM bf
      UNION ALL
      SELECT t.id, t.tenant_id, t.canonical_key AS ck, 0 AS is_new
        FROM scan_targets t
       WHERE t.canonical_key IS NOT NULL ${TENANT != null ? `AND t.tenant_id = ${TENANT}` : ""}
         AND NOT EXISTS (SELECT 1 FROM bf WHERE bf.id = t.id)`);
  db.exec(`CREATE INDEX temp.post_ck ON post(tenant_id, ck)`);

  const groupRows = db.prepare(`
    SELECT p.tenant_id AS tenantId, p.ck AS ck, COUNT(*) AS n, SUM(p.is_new) AS nNew,
           SUM(t.last_scanned_at IS NOT NULL) AS nScanned,
           SUM(t.converted_to_lead_id IS NOT NULL) AS nLeads,
           MIN(t.city) AS city
      FROM post p JOIN scan_targets t ON t.id = p.id
     GROUP BY p.tenant_id, p.ck HAVING COUNT(*) > 1`).all() as Array<{
      tenantId: number; ck: string; n: number; nNew: number; nScanned: number; nLeads: number; city: string;
    }>;

  const revealed = groupRows.filter((g) => g.nNew > 0);
  const preExisting = groupRows.filter((g) => g.nNew === 0);
  const extraRows = (gs: typeof revealed) => gs.reduce((s, g) => s + g.n - 1, 0);

  console.log(`\n── duplicate groups revealed by the backfill ────────────────────`);
  console.log(`groups                       ${revealed.length.toLocaleString()}`);
  console.log(`extra rows in them           ${extraRows(revealed).toLocaleString()}  (rows beyond one survivor per door)`);
  console.log(`  groups with 0 scanned copies  ${revealed.filter((g) => g.nScanned === 0).length.toLocaleString()}`);
  console.log(`  groups with 1 scanned copy    ${revealed.filter((g) => g.nScanned === 1).length.toLocaleString()}   (unscanned twin is redundant)`);
  console.log(`  groups with 2+ scanned copies ${revealed.filter((g) => g.nScanned >= 2).length.toLocaleString()}   <-- the same door was paid for more than once`);
  console.log(`  groups touching a lead        ${revealed.filter((g) => g.nLeads > 0).length.toLocaleString()}   (merging these would repoint a lead FK)`);
  // scanTargetCanonicalMerge.dryRunManifest() counts duplicate groups with
  // `WHERE canonical_key IS NOT NULL`, i.e. exactly the number below — it cannot
  // see the groups above. yieldRollups step 5 promotes the canonical index to
  // UNIQUE when that number reaches 0, so the promotion gate reads "all clear"
  // on a table that is a third un-keyed. Backfill first, then re-measure.
  console.log(`\nduplicate groups VISIBLE to scanTargetCanonicalMerge.dryRunManifest() today: ${preExisting.length.toLocaleString()} (${extraRows(preExisting).toLocaleString()} extra rows)`);
  console.log(`  That manifest filters canonical_key IS NOT NULL, so it under-reports by ${revealed.length.toLocaleString()} group(s).`);
  console.log(`  promoteCanonicalUnique() is gated on that count reaching 0 — do not let it`);
  console.log(`  promote before this backfill runs, or the hidden collisions become write errors.`);

  const byCity: Record<string, number> = {};
  for (const g of revealed) byCity[g.city ?? "(unknown)"] = (byCity[g.city ?? "(unknown)"] ?? 0) + 1;
  const topCities = Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (topCities.length) {
    console.log(`\ntop cities by revealed duplicate groups:`);
    console.table(Object.fromEntries(topCities));
  }

  // Per-member detail: which copy is scanned and which is not.
  const membersStmt = db.prepare(`
    SELECT t.id, t.address, t.city, t.state, t.source, t.last_scanned_at AS scannedAt,
           t.scan_count AS scanCount, t.last_fiber_status AS fiberStatus,
           t.converted_to_lead_id AS leadId, p.is_new AS isNew
      FROM post p JOIN scan_targets t ON t.id = p.id
     WHERE p.tenant_id IS ? AND p.ck = ? ORDER BY t.id`);

  const worstFirst = [...revealed].sort((a, b) => b.nScanned - a.nScanned || b.n - a.n);
  if (SHOW_GROUPS && worstFirst.length) {
    console.log(`\n── ${Math.min(SHOW_GROUPS, worstFirst.length)} groups, most-scanned first ──────────────────────────`);
    for (const g of worstFirst.slice(0, SHOW_GROUPS)) {
      console.log(`\n  ${g.ck}`);
      for (const m of membersStmt.all(g.tenantId, g.ck) as any[]) {
        const state = m.scannedAt ? `SCANNED ${String(m.scannedAt).slice(0, 10)} (${m.scanCount}x, ${m.fiberStatus ?? "no status"})` : "not scanned";
        console.log(`    #${String(m.id).padEnd(8)} ${String(m.address).padEnd(34)} ${m.isNew ? "[key backfilled]" : "[key already set]"} ${state}${m.leadId ? `  lead #${m.leadId}` : ""}   src=${m.source ?? "—"}`);
      }
    }
  }

  if (CSV_PATH) {
    const out: string[] = ["canonical_key,city,group_size,scanned_copies,lead_copies,target_id,address,source,last_scanned_at,scan_count,converted_to_lead_id,key_backfilled"];
    for (const g of worstFirst) {
      for (const m of membersStmt.all(g.tenantId, g.ck) as any[]) {
        const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        out.push([cell(g.ck), cell(g.city), g.n, g.nScanned, g.nLeads, m.id, cell(m.address), cell(m.source),
                  cell(m.scannedAt), m.scanCount, m.leadId ?? "", m.isNew].join(","));
      }
    }
    fs.writeFileSync(CSV_PATH, out.join("\n") + "\n");
    console.log(`\nfull group detail written to ${CSV_PATH} (${out.length - 1} member rows)`);
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN — nothing was written"} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!APPLY) console.log(`Re-run with --apply to write the ${keyable.toLocaleString()} keys. Duplicate groups are NOT merged by this script.`);
}

main().then(() => { db.close(); process.exit(0); })
      .catch((e) => { console.error(e); db.close(); process.exit(1); });
