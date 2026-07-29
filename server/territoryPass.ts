// ── Territory pass store ──────────────────────────────────────────────────────
// Persistence for multi-pass knocking. The contract this file exists to keep:
// closing a pass resets what reps SEE and never touches what HAPPENED.
//
//   knock_log            append-only, untouched by a reset, stamped with pass_number
//   territory_passes     append-only ledger, one row per closed pass
//   commission_sales     never read-modified here at all
//   leads                the only table a reset writes, and only 4 columns
//
// The reset runs in ONE transaction. A half-applied reset is the worst outcome
// available — leads re-opened but the pass never recorded means the history gap
// is invisible and unrecoverable — so it's all-or-nothing by construction.

import { db } from "./db";
import {
  planPass, rollUpPass, PASS_RESET_FIELDS,
  type PassLeadInput, type PassPlan, type PassStats,
  type TerritoryPassAction, type FreezeReason,
} from "@shared/territoryPass";

function raw(): any {
  return (db as any).driver ?? (db as any).$client;
}

let schemaReady = false;

/**
 * Idempotent schema. Mirrors the admin_audit approach: the append-only guarantee
 * is a DATABASE trigger, not a code convention, so it survives a future writer
 * that doesn't know the rule — including a hand-run UPDATE in a psql session.
 */
export function ensureTerritoryPassSchema(): void {
  if (schemaReady) return;
  const r = raw();

  r.exec(`
    CREATE TABLE IF NOT EXISTS territory_passes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      territory_id INTEGER NOT NULL,
      pass_number INTEGER NOT NULL,
      opened_at TEXT,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_by_user_id INTEGER,
      closed_by_name TEXT,
      territory_action TEXT NOT NULL,
      new_rep_id INTEGER,
      rep_ids TEXT,
      leads_total INTEGER NOT NULL DEFAULT 0,
      leads_reset INTEGER NOT NULL DEFAULT 0,
      leads_frozen INTEGER NOT NULL DEFAULT 0,
      frozen_by_reason TEXT,
      stats TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_territory_passes_terr
      ON territory_passes(territory_id, pass_number DESC);
    CREATE INDEX IF NOT EXISTS idx_territory_passes_tenant
      ON territory_passes(tenant_id, closed_at DESC);

    -- The history guarantee, enforced by the database rather than by reviewers.
    CREATE TRIGGER IF NOT EXISTS territory_passes_no_update
      BEFORE UPDATE ON territory_passes
      BEGIN SELECT RAISE(ABORT, 'territory_passes is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS territory_passes_no_delete
      BEFORE DELETE ON territory_passes
      BEGIN SELECT RAISE(ABORT, 'territory_passes is append-only'); END;
  `);

  // Columns added defensively — this module can boot ahead of runMigrations() in
  // tests, and ALTER on an existing column is an error rather than a no-op.
  const add = (sql: string) => { try { r.exec(sql); } catch { /* already present */ } };
  add(`ALTER TABLE territories ADD COLUMN current_pass INTEGER NOT NULL DEFAULT 1`);
  add(`ALTER TABLE knock_log ADD COLUMN pass_number INTEGER`);
  add(`ALTER TABLE leads ADD COLUMN do_not_knock INTEGER NOT NULL DEFAULT 0`);

  // Legacy knocks predate the concept and all belong to the first sweep. Doing
  // this once at migration time means every read path can treat pass_number as
  // present instead of scattering COALESCE(pass_number, 1) through the codebase.
  try { r.exec(`UPDATE knock_log SET pass_number = 1 WHERE pass_number IS NULL`); } catch { /* fresh db */ }

  schemaReady = true;
}

export function __resetTerritoryPassSchemaForTests(): void {
  schemaReady = false;
}

/** Test-only: the append-only triggers block DELETE, so a suite that needs a
 *  clean ledger has to drop the table wholesale rather than truncate it. */
export function __hardResetTerritoryPassesForTests(): void {
  const r = raw();
  try {
    r.exec(`DROP TRIGGER IF EXISTS territory_passes_no_update`);
    r.exec(`DROP TRIGGER IF EXISTS territory_passes_no_delete`);
    r.exec(`DROP TABLE IF EXISTS territory_passes`);
  } catch { /* nothing to drop */ }
  schemaReady = false;
  ensureTerritoryPassSchema();
}

// ── Reading the current pass ──────────────────────────────────────────────────

export function currentPassOf(territoryId: number): number {
  ensureTerritoryPassSchema();
  const row = raw().prepare(`SELECT current_pass AS p FROM territories WHERE id = ?`).get(territoryId);
  // Absent/legacy territories are on their first pass by definition.
  return Math.max(1, Number(row?.p ?? 1) || 1);
}

/**
 * Load the doors in an area in the shape the planner wants.
 *
 * The sale check is a LEFT JOIN rather than a per-lead query: an area can hold a
 * few thousand doors, and the N+1 version turns a preview into a visible stall
 * on a phone. Statuses that mean the sale is no longer live are excluded so a
 * reversed sale doesn't freeze a door forever.
 */
export function loadLeadsForPass(territoryId: number, tenantId?: number | null): PassLeadInput[] {
  ensureTerritoryPassSchema();
  const params: any[] = [territoryId];
  let tenantClause = "";
  if (tenantId != null) { tenantClause = ` AND (l.tenant_id IS NULL OR l.tenant_id = ?)`; params.push(tenantId); }

  const rows = raw().prepare(`
    SELECT
      l.id                AS id,
      l.lead_status       AS leadStatus,
      l.do_not_knock      AS doNotKnock,
      (SELECT COUNT(1) FROM commission_sales cs
         WHERE cs.lead_id = l.id
           AND cs.status NOT IN ('CANCELLED','REVERSED','DISQUALIFIED')) AS saleCount,
      (SELECT MAX(k.callback_date) FROM knock_log k
         WHERE k.lead_id = l.id AND k.outcome = 'callback'
           AND (k.superseded IS NULL OR k.superseded = 0)) AS pendingCallbackAt
    FROM leads l
    WHERE l.assigned_territory_id = ?${tenantClause}
  `).all(...params);

  return rows.map((r: any) => ({
    id: Number(r.id),
    leadStatus: r.leadStatus ?? null,
    doNotKnock: r.doNotKnock === 1 || r.doNotKnock === true,
    hasActiveSale: Number(r.saleCount ?? 0) > 0,
    pendingCallbackAt: r.pendingCallbackAt ?? null,
  }));
}

/** Roll up the knocks belonging to one pass of one area. Reads only. */
export function statsForPass(territoryId: number, passNumber: number): PassStats {
  ensureTerritoryPassSchema();
  const rows = raw().prepare(`
    SELECT k.outcome AS outcome, k.was_home AS wasHome, k.rep_id AS repId, k.superseded AS superseded
    FROM knock_log k
    JOIN leads l ON l.id = k.lead_id
    WHERE l.assigned_territory_id = ? AND COALESCE(k.pass_number, 1) = ?
  `).all(territoryId, passNumber);
  return rollUpPass(rows as any[]);
}

export interface PassPreview extends PassPlan {
  territoryId: number;
  currentPass: number;
  nextPass: number;
  stats: PassStats;
}

/** Everything the confirm dialog needs, computed without writing anything. */
export function previewNextPass(
  territoryId: number,
  tenantId: number | null | undefined,
  opts: { keepPendingCallbacks?: boolean; now?: string } = {},
): PassPreview {
  const currentPass = currentPassOf(territoryId);
  const plan = planPass(loadLeadsForPass(territoryId, tenantId), opts);
  return {
    ...plan,
    territoryId,
    currentPass,
    nextPass: currentPass + 1,
    stats: statsForPass(territoryId, currentPass),
  };
}

// ── Closing a pass ────────────────────────────────────────────────────────────

export interface StartNextPassInput {
  territoryId: number;
  tenantId?: number | null;
  actorUserId?: number | null;
  actorName?: string | null;
  action: TerritoryPassAction;
  newRepId?: number | null;
  note?: string | null;
  keepPendingCallbacks?: boolean;
  now?: string;
  /** Applies the territory-side change (assignment, status, colour). Injected so
   *  the assignment rules stay in routes.ts with the rest of them, and this file
   *  keeps a single job: the atomic boundary. Runs INSIDE the transaction. */
  applyTerritoryAction?: (ctx: { passNumber: number; nextPass: number }) => void;
  /** The doors that were actually re-opened, handed over AFTER the transaction
   *  commits. Injected for the same reason as applyTerritoryAction — and it has
   *  to be a callback rather than a return value because the reset ids are the
   *  one thing this function knows that its caller cannot reconstruct: once
   *  last_outcome is NULL there is no query that says which doors it cleared.
   *
   *  Post-commit is not a detail. A notification sent from inside the boundary
   *  would outlive a rollback that erased the reset it describes, and nothing
   *  downstream can retract it. Note this fires for `keep` too — the action that
   *  changes nothing about the territory still re-opens every eligible door. */
  onLeadsReset?: (leadIds: number[]) => void;
}

export interface StartNextPassResult {
  passNumber: number;
  nextPass: number;
  leadsReset: number;
  leadsFrozen: number;
  frozenByReason: Record<FreezeReason, number>;
  callbacksCleared: number;
  stats: PassStats;
  passId: number;
}

/**
 * Close the current pass and open the next one, atomically.
 *
 * Order inside the transaction matters: the ledger row is written BEFORE the
 * leads are reset, so if anything downstream throws, the rollback removes the
 * ledger row too and we're back to a coherent "pass still open" state. There is
 * no ordering that can leave reset leads with no record of why.
 */
export function startNextPass(input: StartNextPassInput): StartNextPassResult {
  ensureTerritoryPassSchema();
  const r = raw();
  const now = input.now ?? new Date().toISOString();
  const tenantId = input.tenantId ?? null;

  const passNumber = currentPassOf(input.territoryId);
  const nextPass = passNumber + 1;
  const plan = planPass(
    loadLeadsForPass(input.territoryId, tenantId),
    { keepPendingCallbacks: input.keepPendingCallbacks, now },
  );
  const stats = statsForPass(input.territoryId, passNumber);

  // When the previous pass was closed — the natural "opened_at" for this one.
  const prevClose = r.prepare(
    `SELECT MAX(closed_at) AS at FROM territory_passes WHERE territory_id = ?`,
  ).get(input.territoryId);

  let passId = 0;

  const tx = r.transaction(() => {
    const ins = r.prepare(`
      INSERT INTO territory_passes
        (tenant_id, territory_id, pass_number, opened_at, closed_at, closed_by_user_id,
         closed_by_name, territory_action, new_rep_id, rep_ids, leads_total, leads_reset,
         leads_frozen, frozen_by_reason, stats, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenantId, input.territoryId, passNumber,
      prevClose?.at ?? null, now,
      input.actorUserId ?? null, input.actorName ?? null,
      input.action, input.newRepId ?? null,
      JSON.stringify(stats.reps),
      plan.totals.total, plan.totals.reset, plan.totals.frozen,
      JSON.stringify(plan.frozenByReason), JSON.stringify(stats),
      input.note ?? null,
    );
    passId = Number(ins.lastInsertRowid);

    // Re-open the eligible doors. Chunked because SQLite caps variables per
    // statement (default 999) and a dense suburban area clears that easily.
    if (plan.reset.length) {
      // These four columns are the entire blast radius of a reset. Spelled out
      // literally rather than generated from PASS_RESET_FIELDS so that widening
      // the set is a visible diff in a file that says "append-only" at the top.
      const upd = (ids: number[]) => r.prepare(`
        UPDATE leads
           SET lead_status = ?, last_outcome = NULL, last_outcome_at = NULL,
               assign_mark = NULL, updated_at = ?
         WHERE id IN (${ids.map(() => "?").join(",")})
      `).run(PASS_RESET_FIELDS.leadStatus, now, ...ids);
      for (let i = 0; i < plan.reset.length; i += 400) upd(plan.reset.slice(i, i + 400));
    }

    // Open the new pass. Every knock recorded from here on is stamped nextPass,
    // which is what keeps pass 1's history distinguishable from pass 2's.
    r.prepare(`UPDATE territories SET current_pass = ?, updated_at = ? WHERE id = ?`)
      .run(nextPass, now, input.territoryId);

    input.applyTerritoryAction?.({ passNumber, nextPass });
  });

  tx();

  // Outside the boundary by construction. Swallowed on throw: a subscriber's
  // problem must not turn a committed pass reset into a 500 the caller retries.
  if (plan.reset.length) {
    try { input.onLeadsReset?.(plan.reset); } catch { /* best-effort notification */ }
  }

  return {
    passNumber, nextPass,
    leadsReset: plan.totals.reset,
    leadsFrozen: plan.totals.frozen,
    frozenByReason: plan.frozenByReason,
    callbacksCleared: plan.callbacksAtRisk,
    stats, passId,
  };
}

// ── History ───────────────────────────────────────────────────────────────────

export interface TerritoryPassRow {
  id: number;
  territoryId: number;
  passNumber: number;
  openedAt: string | null;
  closedAt: string;
  closedByName: string | null;
  territoryAction: string;
  leadsTotal: number;
  leadsReset: number;
  leadsFrozen: number;
  frozenByReason: Record<string, number>;
  stats: PassStats | null;
  note: string | null;
}

function parse<T>(s: any, fallback: T): T {
  if (typeof s !== "string" || !s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/**
 * Closed passes for an area, newest first.
 *
 * The tenant predicate is in the SQL rather than applied after the fact, so a
 * caller cannot forget it, and a cross-tenant read comes back empty instead of
 * leaking a row count.
 */
export function listTerritoryPasses(
  territoryId: number,
  tenantId?: number | null,
  limit = 50,
): TerritoryPassRow[] {
  ensureTerritoryPassSchema();
  const params: any[] = [territoryId];
  let clause = "";
  if (tenantId != null) { clause = ` AND (tenant_id IS NULL OR tenant_id = ?)`; params.push(tenantId); }
  params.push(Math.min(200, Math.max(1, limit)));

  const rows = raw().prepare(`
    SELECT * FROM territory_passes
     WHERE territory_id = ?${clause}
     ORDER BY pass_number DESC, id DESC
     LIMIT ?
  `).all(...params);

  return rows.map((x: any) => ({
    id: Number(x.id),
    territoryId: Number(x.territory_id),
    passNumber: Number(x.pass_number),
    openedAt: x.opened_at ?? null,
    closedAt: x.closed_at,
    closedByName: x.closed_by_name ?? null,
    territoryAction: x.territory_action,
    leadsTotal: Number(x.leads_total ?? 0),
    leadsReset: Number(x.leads_reset ?? 0),
    leadsFrozen: Number(x.leads_frozen ?? 0),
    frozenByReason: parse(x.frozen_by_reason, {} as Record<string, number>),
    stats: parse(x.stats, null as PassStats | null),
    note: x.note ?? null,
  }));
}
