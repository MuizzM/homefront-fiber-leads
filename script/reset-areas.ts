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
//
// In production (Railway shell, where DATA_DIR=/data):
//   npx tsx script/reset-areas.ts --tenant <id>          # look first
//   npx tsx script/reset-areas.ts --tenant <id> --apply  # then commit
//
// --apply takes a `VACUUM INTO` snapshot of the whole database next to it first
// and prints the one-line restore. Litestream's 72h point-in-time window is the
// second net; this is the one that does not need a redeploy to use.

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

if (!allTenants && !tenantArg) {
  console.error(
    "Refusing to guess the scope.\n" +
    "  --tenant <id>   reset ONE organization\n" +
    "  --all-tenants   reset every organization on this database\n" +
    "Add --apply to write; without it this is a dry run.",
  );
  process.exit(2);
}
const tenantId = tenantArg == null ? null : Number(tenantArg);
if (tenantId != null && (!Number.isInteger(tenantId) || tenantId <= 0)) {
  console.error(`--tenant must be a positive integer, got ${JSON.stringify(tenantArg)}`);
  process.exit(2);
}

// ── Snapshot ────────────────────────────────────────────────────────────────
// VACUUM INTO writes a consistent copy of the live database without stopping
// it. Taken BEFORE any write, so "put it back" is a file copy rather than a
// point-in-time restore and a redeploy.
function snapshot(): string {
  const dataDir = process.env.DATA_DIR || process.cwd();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dataDir, `data.before-area-reset-${stamp}.db`);
  rawDb.prepare("VACUUM INTO ?").run(target);
  const bytes = fs.statSync(target).size;
  console.log(`\n  snapshot  ${target}  (${(bytes / 1_048_576).toFixed(1)} MB)`);
  console.log(`  restore   cp ${JSON.stringify(target)} ${JSON.stringify(path.join(dataDir, "data.db"))}   # with the app stopped\n`);
  return target;
}

const one = <T>(sql: string, ...args: unknown[]): T =>
  rawDb.prepare(sql).get(...args) as T;

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

  return {
    areasDeleted: areas.length,
    detached, repCleared: repCleared + strayCleared, strayCleared,
    assignmentsClosed, runsCancelled,
    repIdsCleared: [...repIdsCleared],
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────
runMigrations();

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
    console.log(`  → would delete ${before.areas} areas and unassign ${before.leadsWithRep} doors`);
    continue;
  }
}

if (!apply) {
  console.log(`\nNothing was written. Re-run with --apply to commit.\n`);
  process.exit(0);
}

snapshot();

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
      assignmentsClosed: result.assignmentsClosed, runsCancelled: result.runsCancelled,
      reason: "reset to the crew-based area process",
    },
    tenantId: tid, outcome: "success",
  });

  console.log(`\n─ tenant ${tid ?? "(all)"} — done ────────────────────────`);
  console.log(`  areas deleted        ${result.areasDeleted}`);
  console.log(`  doors detached       ${result.detached}`);
  console.log(`  doors unassigned     ${result.repCleared}  (${result.strayCleared} had no area)`);
  console.log(`  reps freed           ${result.repIdsCleared.length}`);
  console.log(`  assignment rows closed ${result.assignmentsClosed}  ·  skip-trace runs closed ${result.runsCancelled}`);
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
