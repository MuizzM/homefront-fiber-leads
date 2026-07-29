// ── Territory assignment record ───────────────────────────────────────────────
// Who held an area, who put them there, when, and who took them off.
//
// territories.assignee_ids answers "who holds this NOW" and stays authoritative
// for visibility — every read path already goes through territoryHeldByAny, and
// that is deliberately not being moved. A JSON array of ids cannot carry the
// rest: it has no room for who assigned the rep, when, at whose instruction, or
// what the roster looked like last month. Those are the questions a manager asks
// when an area goes wrong, and they were unanswerable.
//
// So this table records the FACTS about each assignment alongside the array,
// written in the same transaction. Two stores, one write — and a test asserts
// they agree, because two sources of truth that can drift are worse than one
// that is merely incomplete.
//
// Durability rules, enforced by DATABASE triggers rather than convention so they
// survive a future writer that does not know them:
//
//   • a row is NEVER deleted — removal closes it, it does not erase it
//   • a CLOSED row is immutable — history cannot be rewritten after the fact
//   • at most one OPEN assignment per (territory, user) — a partial unique index,
//     so a double-submit cannot create two live claims on the same ground
//
// That last one is what makes the write idempotent: re-running the same
// assignment is a no-op rather than a duplicate.

import { db } from "./db";

function raw(): any {
  return (db as any).driver ?? (db as any).$client;
}

let schemaReady = false;

export function ensureTerritoryAssignmentSchema(): void {
  if (schemaReady) return;
  const r = raw();

  r.exec(`
    CREATE TABLE IF NOT EXISTS territory_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      territory_id INTEGER NOT NULL,
      rep_id INTEGER NOT NULL,
      -- "primary" drives the map label; supporting reps share the same ground.
      role_in_territory TEXT NOT NULL DEFAULT 'assignee',
      assigned_by_user_id INTEGER,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      unassigned_at TEXT,
      unassigned_by_user_id INTEGER,
      reason TEXT,
      -- The client-supplied key that produced this row. Lets a retried request
      -- be recognised rather than re-applied.
      idempotency_key TEXT
    )
  `);

  // At most ONE open assignment per rep per area. Partial index, so closed rows
  // accumulate freely — a rep can hold an area, be removed, and hold it again.
  r.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_terr_assign_active
          ON territory_assignments(territory_id, rep_id) WHERE unassigned_at IS NULL`);
  r.exec(`CREATE INDEX IF NOT EXISTS idx_terr_assign_territory ON territory_assignments(territory_id)`);
  r.exec(`CREATE INDEX IF NOT EXISTS idx_terr_assign_rep ON territory_assignments(rep_id, unassigned_at)`);
  r.exec(`CREATE INDEX IF NOT EXISTS idx_terr_assign_tenant ON territory_assignments(tenant_id)`);
  r.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_terr_assign_idem
          ON territory_assignments(idempotency_key) WHERE idempotency_key IS NOT NULL`);

  // Removal closes a row. It never deletes one — the whole point is that the
  // record of who worked this ground outlives their assignment.
  r.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_terr_assign_no_delete
    BEFORE DELETE ON territory_assignments
    BEGIN SELECT RAISE(ABORT, 'territory_assignments is append-only'); END
  `);

  // Once closed, a row is history and cannot be edited — including re-opening it
  // by clearing unassigned_at. Re-assigning a rep inserts a NEW row, which is
  // what makes "held it twice" visible instead of looking like one long tenure.
  r.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_terr_assign_closed_immutable
    BEFORE UPDATE ON territory_assignments
    WHEN OLD.unassigned_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'a closed territory assignment is immutable'); END
  `);

  // While open, only the closing fields may be written. Nothing may rewrite who
  // was assigned, by whom, or when.
  r.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_terr_assign_open_fields
    BEFORE UPDATE ON territory_assignments
    WHEN OLD.unassigned_at IS NULL AND (
      NEW.territory_id        != OLD.territory_id
      OR NEW.rep_id           != OLD.rep_id
      OR NEW.assigned_at      != OLD.assigned_at
      OR IFNULL(NEW.assigned_by_user_id, -1) != IFNULL(OLD.assigned_by_user_id, -1)
    )
    BEGIN SELECT RAISE(ABORT, 'an open territory assignment records who/when immutably'); END
  `);

  schemaReady = true;
}

export interface AssignmentRow {
  id: number;
  tenantId: number | null;
  territoryId: number;
  repId: number;
  roleInTerritory: string;
  assignedByUserId: number | null;
  assignedAt: string;
  unassignedAt: string | null;
  unassignedByUserId: number | null;
  reason: string | null;
}

function toRow(r: any): AssignmentRow {
  return {
    id: r.id,
    tenantId: r.tenant_id ?? null,
    territoryId: r.territory_id,
    repId: r.rep_id,
    roleInTerritory: r.role_in_territory,
    assignedByUserId: r.assigned_by_user_id ?? null,
    assignedAt: r.assigned_at,
    unassignedAt: r.unassigned_at ?? null,
    unassignedByUserId: r.unassigned_by_user_id ?? null,
    reason: r.reason ?? null,
  };
}

export interface OpenAssignmentInput {
  tenantId: number | null;
  territoryId: number;
  repId: number;
  actorUserId: number | null;
  roleInTerritory?: string;
  reason?: string | null;
  idempotencyKey?: string | null;
  at?: string;
}

/**
 * Record that a rep now holds this area.
 *
 * Idempotent by construction: the partial unique index means a rep who is
 * already on the area produces no second open row, so a double-submitted assign
 * cannot create two live claims. Returns whether a row was actually created,
 * which is what the caller reports as "added" versus "already there".
 */
export function openAssignment(input: OpenAssignmentInput): { created: boolean; id: number | null } {
  ensureTerritoryAssignmentSchema();
  const r = raw();
  const at = input.at ?? new Date().toISOString();
  // INSERT OR IGNORE leans on the partial unique index: re-assigning a rep who
  // is already on the area is a no-op, not a duplicate and not an error.
  const info = r.prepare(`
    INSERT OR IGNORE INTO territory_assignments
      (tenant_id, territory_id, rep_id, role_in_territory, assigned_by_user_id, assigned_at, reason, idempotency_key)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    input.tenantId, input.territoryId, input.repId,
    input.roleInTerritory ?? "assignee", input.actorUserId, at,
    input.reason ?? null, input.idempotencyKey ?? null,
  );
  return { created: info.changes > 0, id: info.changes > 0 ? Number(info.lastInsertRowid) : null };
}

export interface CloseAssignmentInput {
  territoryId: number;
  repId: number;
  actorUserId: number | null;
  reason?: string | null;
  at?: string;
}

/**
 * Record that a rep no longer holds this area.
 *
 * Closing an assignment that is already closed (or never existed) reports false
 * rather than throwing — removing someone twice is a normal double-tap, not an
 * error, and the spec asks for exactly that idempotence.
 */
export function closeAssignment(input: CloseAssignmentInput): boolean {
  ensureTerritoryAssignmentSchema();
  const r = raw();
  const at = input.at ?? new Date().toISOString();
  const info = r.prepare(`
    UPDATE territory_assignments
       SET unassigned_at = ?, unassigned_by_user_id = ?, reason = COALESCE(?, reason)
     WHERE territory_id = ? AND rep_id = ? AND unassigned_at IS NULL
  `).run(at, input.actorUserId, input.reason ?? null, input.territoryId, input.repId);
  return info.changes > 0;
}

/** Close every open assignment on an area. Returns the reps actually removed —
 *  the ones already gone are not reported, so "removed 3 reps" is a true count. */
export function closeAllAssignments(
  territoryId: number, actorUserId: number | null, reason?: string | null, at?: string,
): number[] {
  ensureTerritoryAssignmentSchema();
  const open = activeAssignments(territoryId).map((a) => a.repId);
  const stamp = at ?? new Date().toISOString();
  const removed: number[] = [];
  for (const repId of open) {
    if (closeAssignment({ territoryId, repId, actorUserId, reason, at: stamp })) removed.push(repId);
  }
  return removed;
}

/** Who currently holds this area, oldest tenure first. */
export function activeAssignments(territoryId: number): AssignmentRow[] {
  ensureTerritoryAssignmentSchema();
  return raw().prepare(
    `SELECT * FROM territory_assignments
      WHERE territory_id = ? AND unassigned_at IS NULL
      ORDER BY assigned_at ASC, id ASC`,
  ).all(territoryId).map(toRow);
}

/** Everything that ever happened to this area's roster, newest first. */
export function assignmentHistory(territoryId: number, limit = 200): AssignmentRow[] {
  ensureTerritoryAssignmentSchema();
  return raw().prepare(
    `SELECT * FROM territory_assignments
      WHERE territory_id = ?
      ORDER BY id DESC
      LIMIT ?`,
  ).all(territoryId, Math.max(1, Math.min(1000, limit))).map(toRow);
}

/**
 * Bring the record in line with the holder list.
 *
 * assignee_ids is authoritative for visibility, and it is written by routes that
 * predate this table. Rather than hunt down every one of them and risk missing a
 * path — which is exactly how the two stores would silently diverge — each write
 * calls this with the list it just saved, and the record is reconciled to match:
 * anyone newly present is opened, anyone newly absent is closed.
 *
 * Idempotent, so calling it on an unchanged list does nothing.
 */
export function syncAssignments(input: {
  tenantId: number | null;
  territoryId: number;
  repIds: readonly number[];
  actorUserId: number | null;
  primaryRepId?: number | null;
  reason?: string | null;
  at?: string;
}): { opened: number[]; closed: number[] } {
  ensureTerritoryAssignmentSchema();
  const at = input.at ?? new Date().toISOString();
  const want = Array.from(new Set(input.repIds.filter((id) => Number.isInteger(id) && id > 0)));
  const have = activeAssignments(input.territoryId).map((a) => a.repId);

  const opened: number[] = [];
  for (const repId of want) {
    if (have.includes(repId)) continue;
    const { created } = openAssignment({
      tenantId: input.tenantId, territoryId: input.territoryId, repId,
      actorUserId: input.actorUserId, at, reason: input.reason ?? null,
      roleInTerritory: input.primaryRepId === repId ? "primary" : "assignee",
    });
    if (created) opened.push(repId);
  }

  const closed: number[] = [];
  for (const repId of have) {
    if (want.includes(repId)) continue;
    if (closeAssignment({ territoryId: input.territoryId, repId, actorUserId: input.actorUserId, reason: input.reason ?? null, at })) {
      closed.push(repId);
    }
  }
  return { opened, closed };
}
