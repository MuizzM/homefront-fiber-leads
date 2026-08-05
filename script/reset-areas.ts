// ── Reset every Area and rep assignment, so the org restarts on the new process ──
//
// WHAT THIS IS FOR
// Areas were drawn under the old rules (one rep per area, and deleting an area
// left its doors assigned to whoever held it). This wipes that slate: every Area
// is deleted and every door goes back to the pool, so the team re-draws areas
// under the new process — a crew per area, and a delete that takes the doors
// with it.
//
// WHY A SCRIPT AND NOT SQL IN A SHELL
// `DELETE FROM territories` is wrong three ways, and two of them fail silently:
//
//   1. territory_assignments and territory_passes carry BEFORE DELETE triggers
//      that RAISE(ABORT) — they are append-only ledgers. Any cleanup that tries
//      to delete from them throws mid-way, after other statements have applied.
//   2. territories has no FK cascade, so deleting the rows leaves every one of
//      those ledgers pointing at areas that no longer exist, and every lead
//      holding a ghost assigned_territory_id. That is the exact orphan class
//      this release just fixed (2,855 of them, historically).
//   3. it would not clear leads.assigned_rep_id at all, which is the whole
//      point — the reps would keep every door.
//
// So this drives the SAME functions the DELETE /api/territories/:id route uses.
// Prod lands in exactly the state deleting each Area through the UI would
// produce, one area at a time, with nothing skipped.
//
// WHAT IT TOUCHES
//   leads.assigned_rep_id / assigned_territory_id / assignment_source /
//   assigned_by / assigned_at / unassigned_at   → cleared
//   territories                                  → deleted
//   territory_assignments (open rows)            → CLOSED, never deleted
//   area_skip_trace_runs (queued/running)        → closed as AREA_DELETED
//
// WHAT IT NEVER TOUCHES
//   the leads themselves · knock_log (every knock stays attributed to whoever
//   made it) · sales, commissions, payouts · team_members and users — REPS KEEP
//   THEIR ACCOUNTS, they just hold no ground · territory_events, closed
//   territory_assignments and territory_passes, which are history by design.
//
// USAGE — dry run is the default. Nothing is written without --apply.
//
//   tsx script/reset-areas.ts --tenant 1
//   tsx script/reset-areas.ts --tenant 1 --apply
//   tsx script/reset-areas.ts --all-tenants --apply
//   tsx script/reset-areas.ts --undo <file>        # put the assignments back
//
// In PRODUCTION nobody has a shell — run it through
// .github/workflows/reset-areas.yml, which executes the bundled build
// (`node dist/reset-areas.cjs`) in a one-off container on the live /data volume.
//
// --apply first writes a small UNDO FILE recording only the rows it is about to
// change. It is deliberately not a copy of the database: the volume holds a
// multi-gigabyte SQLite file with no room for a second one (the first attempt
// died with SQLITE_FULL), and restoring a whole-database snapshot would also
// erase every knock, sale and signature recorded since it was taken.

import fs from "node:fs";
import path from "node:path";
import { rawDb } from "../server/db";
import { storage, runMigrations } from "../server/storage";
import { releaseTerritoryLeads } from "../server/scanIntelStore";
import { recordTerritoryOutcome } from "../server/scanService";
import { closeAllAssignments } from "../server/territoryAssignments";
import { cancelAreaSkipTraceRuns } from "../server/areaSkipTrace";
import { recordAdminAudit } from "../server/adminAudit";

// ── Arguments ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const apply = has("--apply");
const allTenants = has("--all-tenants");
const tenantArg = valueOf("--tenant");
const undoArg = valueOf("--undo");

if (!allTenants && !tenantArg && !undoArg) {
  console.error(
    "Refusing to guess the scope.\n" +
    "  --tenant <id>   reset ONE organization\n" +
    "  --all-tenants   reset every organization on this database\n" +
    "  --undo <file>   put back the assignments an earlier --apply cleared\n" +
    "Add --apply to write; without it this is a dry run.",
  );
  process.exit(2);
}
const tenantId = tenantArg == null ? null : Number(tenantArg);
if (tenantId != null && (!Number.isInteger(tenantId) || tenantId <= 0)) {
  console.error(`--tenant must be a positive integer, got ${JSON.stringify(tenantArg)}`);
  process.exit(2);
}

// ── Undo file ───────────────────────────────────────────────────────────────
// NOT a copy of the database. The first production APPLY died with SQLITE_FULL
// three minutes into `VACUUM INTO`: the volume holds a multi-gigabyte SQLite
// file and there is no room for a second one.
//
// A targeted undo is the better instrument anyway, not merely the affordable
// one. This reset writes exactly three things — a lead's assignment columns, a
// ledger row's closing columns, and the territory rows themselves — so the undo
// only has to carry those. That makes it kilobytes instead of gigabytes, and it
// makes restoring SAFE: putting back a whole-database snapshot would also erase
// every knock, sale and signature recorded between the snapshot and the
// restore. This puts back the assignments and nothing else.
//
// Restore with:  node dist/reset-areas.cjs --undo <file>
interface UndoFile {
  schemaVersion: 1;
  takenAt: string;
  tenantIds: Array<number | null>;
  leads: Array<{
    id: number; assigned_rep_id: number | null; assigned_territory_id: number | null;
    assignment_source: string | null; assigned_by: string | null;
    assigned_at: string | null; unassigned_at: string | null;
  }>;
  ledger: Array<{ id: number }>;          // rows that were OPEN and will be closed
  territories: Array<Record<string, unknown>>;  // full rows, so a deleted area comes back
}

function writeUndoFile(tids: Array<number | null>): string {
  const dataDir = process.env.DATA_DIR || process.cwd();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dataDir, `area-reset-undo-${stamp}.json`);

  const scoped = (col = "tenant_id") =>
    tids.includes(null) ? "" : ` AND ${col} IN (${tids.map((t) => Number(t) | 0).join(",")})`;

  const undo: UndoFile = {
    schemaVersion: 1,
    takenAt: new Date().toISOString(),
    tenantIds: tids,
    leads: all(
      `SELECT id, assigned_rep_id, assigned_territory_id, assignment_source,
              assigned_by, assigned_at, unassigned_at
         FROM leads
        WHERE (assigned_rep_id IS NOT NULL OR assigned_territory_id IS NOT NULL)${scoped()}`),
    ledger: all(
      `SELECT id FROM territory_assignments WHERE unassigned_at IS NULL${scoped()}`),
    territories: all(`SELECT * FROM territories WHERE 1=1${scoped()}`),
  };

  fs.writeFileSync(target, JSON.stringify(undo));
  const bytes = fs.statSync(target).size;
  console.log(`\n  undo file  ${target}  (${(bytes / 1024).toFixed(0)} KB)`);
  console.log(`             ${undo.leads.length} lead assignments · ${undo.ledger.length} open ledger rows · ${undo.territories.length} areas`);
  console.log(`  restore    node dist/reset-areas.cjs --undo ${JSON.stringify(target)}\n`);
  return target;
}

/** Put the assignments back, and ONLY the assignments. */
function restoreUndo(file: string): void {
  const undo = JSON.parse(fs.readFileSync(file, "utf8")) as UndoFile;
  if (undo.schemaVersion !== 1) throw new Error(`unsupported undo file version ${undo.schemaVersion}`);
  console.log(`\nRESTORING from ${file}`);
  console.log(`  taken ${undo.takenAt} · ${undo.leads.length} leads · ${undo.ledger.length} ledger rows · ${undo.territories.length} areas`);

  const apply = rawDb.transaction(() => {
    let areas = 0;
    for (const t of undo.territories) {
      const cols = Object.keys(t);
      const sql = `INSERT OR REPLACE INTO territories (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      rawDb.prepare(sql).run(...cols.map((c) => (t as any)[c]));
      areas++;
    }
    let leads = 0;
    const put = rawDb.prepare(
      `UPDATE leads SET assigned_rep_id=?, assigned_territory_id=?, assignment_source=?,
              assigned_by=?, assigned_at=?, unassigned_at=?, updated_at=?
        WHERE id=?`);
    const now = new Date().toISOString();
    for (const l of undo.leads) {
      leads += put.run(l.assigned_rep_id, l.assigned_territory_id, l.assignment_source,
        l.assigned_by, l.assigned_at, l.unassigned_at, now, l.id).changes;
    }
    // Re-opening a closed ledger row is blocked by trigger
    // (trg_terr_assign_closed_immutable) — history is immutable by design. The
    // ids are recorded so an operator can see which tenures this reset ended,
    // not so they can be un-ended.
    return { areas, leads };
  });
  const r = apply.immediate() as { areas: number; leads: number };
  console.log(`  restored ${r.areas} areas and ${r.leads} lead assignments`);
  console.log(`  NOTE: closed ledger rows stay closed — territory_assignments is append-only by trigger.\n`);
}

const one = <T>(sql: string, ...args: unknown[]): T =>
  rawDb.prepare(sql).get(...args) as T;
const all = <T>(sql: string, ...args: unknown[]): T[] =>
  rawDb.prepare(sql).all(...args) as T[];

function census(tid: number | null) {
  const scope = tid == null ? "" : " WHERE tenant_id = ?";
  const args = tid == null ? [] : [tid];
  return {
    areas: one<{ n: number }>(`SELECT COUNT(*) AS n FROM territories${scope}`, ...args).n,
    leadsWithArea: one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM leads WHERE assigned_territory_id IS NOT NULL${tid == null ? "" : " AND tenant_id = ?"}`, ...args).n,
    leadsWithRep: one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM leads WHERE assigned_rep_id IS NOT NULL${tid == null ? "" : " AND tenant_id = ?"}`, ...args).n,
    openAssignments: one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM territory_assignments WHERE unassigned_at IS NULL${tid == null ? "" : " AND tenant_id = ?"}`, ...args).n,
    liveRuns: one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM area_skip_trace_runs WHERE status IN ('queued','running')${tid == null ? "" : " AND tenant_id = ?"}`, ...args).n,
    // Untouched by this script — printed so the operator can see they stay put.
    reps: one<{ n: number }>(`SELECT COUNT(*) AS n FROM team_members${scope}`, ...args).n,
    knocks: one<{ n: number }>(`SELECT COUNT(*) AS n FROM knock_log${scope}`, ...args).n,
  };
}

function resetTenant(tid: number | null, at: string) {
  const areas = storage.getTerritories(tid ?? undefined);
  let detached = 0, repCleared = 0, assignmentsClosed = 0, runsCancelled = 0;
  const repIdsCleared = new Set<number>();

  for (const area of areas) {
    // Same order as the route: teach the market from the area's outcome BEFORE
    // the release, because computeTerritoryOutcome reads assigned_territory_id
    // and the lesson is unrecoverable once the link is gone.
    recordTerritoryOutcome(area.tenantId ?? tid ?? 1, area.id, (area as any).createdAt ?? null);
    const released = releaseTerritoryLeads(area.id, { clearReps: true, at });
    detached += released.detached;
    repCleared += released.repCleared;
    for (const r of released.repIdsCleared) repIdsCleared.add(r);
    assignmentsClosed += closeAllAssignments(area.id, null, "area reset", at).length;
    runsCancelled += cancelAreaSkipTraceRuns(area.id, tid ?? undefined);
    storage.deleteTerritory(area.id, tid ?? undefined);
  }

  // Doors assigned to a rep with no area at all — a direct hand-off, a lasso
  // "Change Ownership", a scan deploy. "Reset the reps" means these too, or the
  // reps walk away from this holding doors nobody drew an area around.
  const strays = rawDb.prepare(
    `SELECT assigned_rep_id AS repId, COUNT(*) AS n FROM leads
      WHERE assigned_rep_id IS NOT NULL AND assigned_territory_id IS NULL
        ${tid == null ? "" : "AND tenant_id = ?"}
      GROUP BY assigned_rep_id`,
  ).all(...(tid == null ? [] : [tid])) as Array<{ repId: number; n: number }>;
  for (const s of strays) repIdsCleared.add(s.repId);
  const strayCleared = rawDb.prepare(
    `UPDATE leads
        SET assigned_rep_id = NULL, assignment_source = NULL, assigned_by = NULL,
            assigned_at = NULL, unassigned_at = ?, updated_at = ?
      WHERE assigned_rep_id IS NOT NULL AND assigned_territory_id IS NULL
        ${tid == null ? "" : "AND tenant_id = ?"}`,
  ).run(...(tid == null ? [at, at] : [at, at, tid])).changes;

  // ── Open ledger rows for areas that no longer exist ──────────────────────
  // The loop above only closes assignments for areas it can still see. Areas
  // deleted under the OLD code left their rows OPEN — the ledger still claims a
  // rep holds ground that is gone. Production had exactly this: zero areas, and
  // nine open rows. Sweeping them is the same hygiene as clearing the doors,
  // and without it a reset finishes and still reports "not fully clean".
  //
  // The table is append-only by trigger, so these are CLOSED, never deleted —
  // the record of who worked that ground outlives the area, which is the point.
  const orphanRows = rawDb.prepare(
    `SELECT id, territory_id AS territoryId, rep_id AS repId FROM territory_assignments
      WHERE unassigned_at IS NULL
        AND territory_id NOT IN (SELECT id FROM territories)
        ${tid == null ? "" : "AND tenant_id = ?"}`,
  ).all(...(tid == null ? [] : [tid])) as Array<{ id: number; territoryId: number; repId: number }>;
  let orphanAssignmentsClosed = 0;
  for (const row of orphanRows) {
    orphanAssignmentsClosed += rawDb.prepare(
      `UPDATE territory_assignments
          SET unassigned_at = ?, unassigned_by_user_id = NULL,
              reason = COALESCE(reason, 'area reset — area already gone')
        WHERE id = ? AND unassigned_at IS NULL`,
    ).run(at, row.id).changes;
    repIdsCleared.add(row.repId);
  }

  return {
    areasDeleted: areas.length,
    detached, repCleared: repCleared + strayCleared, strayCleared,
    assignmentsClosed, orphanAssignmentsClosed, runsCancelled,
    repIdsCleared: [...repIdsCleared],
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────
runMigrations();

if (undoArg) {
  restoreUndo(undoArg);
  process.exit(0);
}

const targets: Array<number | null> = allTenants
  ? (storage.getTenants().map((t) => t.id) as number[])
  : [tenantId];

console.log(`\n${apply ? "APPLYING" : "DRY RUN"} — area + rep-assignment reset`);
console.log(`  database  ${path.join(process.env.DATA_DIR || process.cwd(), "data.db")}`);
console.log(`  scope     ${allTenants ? `all ${targets.length} organizations` : `tenant ${tenantId}`}`);

for (const tid of targets) {
  const before = census(tid);
  console.log(`\n─ tenant ${tid ?? "(all)"} ─────────────────────────────────`);
  console.log(`  areas ${before.areas}  ·  doors in an area ${before.leadsWithArea}  ·  doors with a rep ${before.leadsWithRep}`);
  console.log(`  open assignment rows ${before.openAssignments}  ·  live skip-trace runs ${before.liveRuns}`);
  console.log(`  KEPT: ${before.reps} rep accounts, ${before.knocks} knocks, every lead and every sale`);

  if (!apply) {
    const orphanRows = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM territory_assignments
        WHERE unassigned_at IS NULL AND territory_id NOT IN (SELECT id FROM territories)
          ${tid == null ? "" : "AND tenant_id = ?"}`, ...(tid == null ? [] : [tid])).n;
    console.log(`  → would delete ${before.areas} areas and unassign ${before.leadsWithRep} doors`);
    if (orphanRows) {
      console.log(`  → would close ${orphanRows} ledger row${orphanRows === 1 ? "" : "s"} still claiming a rep holds an area that is already gone`);
    }
    continue;
  }
}

if (!apply) {
  console.log(`\nNothing was written. Re-run with --apply to commit.\n`);
  process.exit(0);
}

writeUndoFile(targets);

const at = new Date().toISOString();
for (const tid of targets) {
  const before = census(tid);
  // One transaction per organization: a failure leaves that org untouched
  // rather than half-reset.
  const result = rawDb.transaction(() => resetTenant(tid, at)).immediate() as ReturnType<typeof resetTenant>;
  const after = census(tid);

  recordAdminAudit({
    actor: null,
    action: "territory.bulk_reset", targetType: "territory",
    targetLabel: `${result.areasDeleted} area${result.areasDeleted === 1 ? "" : "s"}`,
    before: { areas: before.areas, leadsWithArea: before.leadsWithArea, leadsWithRep: before.leadsWithRep },
    after: {
      areasDeleted: result.areasDeleted, detached: result.detached,
      repCleared: result.repCleared, strayCleared: result.strayCleared,
      repIdsCleared: result.repIdsCleared,
      assignmentsClosed: result.assignmentsClosed,
      orphanAssignmentsClosed: result.orphanAssignmentsClosed,
      runsCancelled: result.runsCancelled,
      reason: "reset to the crew-based area process",
    },
    tenantId: tid, outcome: "success",
  });

  console.log(`\n─ tenant ${tid ?? "(all)"} — done ────────────────────────`);
  console.log(`  areas deleted        ${result.areasDeleted}`);
  console.log(`  doors detached       ${result.detached}`);
  console.log(`  doors unassigned     ${result.repCleared}  (${result.strayCleared} had no area)`);
  console.log(`  reps freed           ${result.repIdsCleared.length}`);
  console.log(`  assignment rows closed ${result.assignmentsClosed + result.orphanAssignmentsClosed}` +
    `${result.orphanAssignmentsClosed ? ` (${result.orphanAssignmentsClosed} for areas already gone)` : ""}` +
    `  ·  skip-trace runs closed ${result.runsCancelled}`);
  console.log(`  remaining: ${after.areas} areas, ${after.leadsWithArea} doors in an area, ${after.leadsWithRep} doors with a rep`);
  if (after.areas || after.leadsWithArea || after.leadsWithRep || after.openAssignments) {
    console.error(`  ⚠ NOT FULLY CLEAN — investigate before re-running`);
  }
}

// The invariant the whole exercise is about: nothing points at an area that
// does not exist.
const ghosts = one<{ n: number }>(
  `SELECT COUNT(*) AS n FROM leads
    WHERE assigned_territory_id IS NOT NULL
      AND assigned_territory_id NOT IN (SELECT id FROM territories)`).n;
console.log(`\n  orphaned area references: ${ghosts}${ghosts ? "  ⚠" : "  ✓"}`);
console.log(`\nReps keep their accounts and their history. Draw the new areas from the Field Map.\n`);

// EXPLICIT. Importing server/db starts the WAL checkpoint guard, whose timer
// holds the event loop open forever — without this the script finishes its work
// and then appears to hang, which in a production shell reads as "it's still
// running, don't touch it". Exiting also flushes stdout, which is fully
// buffered whenever the output is piped.
process.exit(ghosts ? 1 : 0);
