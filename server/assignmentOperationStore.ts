import type Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { interactiveTransaction } from "./interactiveDb";
import { recoveryActorAllowed } from "./recoveryAuthority";

export type AssignmentKind = "selection" | "bulk";
export interface AssignmentOwner { tenantId: number; userId: number; sessionId?: string }
export interface AssignmentAuthority { actorName: string | null; repName: string | null; scope?: number[] }
interface Prior { id: number; assignedRepId: number | null; assignedBy: string | null; assignedAt: string | null; unassignedAt: string | null; assignmentVersion: number }
export interface AssignmentOperation {
  id: string; tenant_id: number; actor_user_id: number; kind: AssignmentKind; client_id: string; request_hash: string;
  rep_id: number | null; applied_at: string | null; created_at: number; updated_at: number;
  state: "running" | "completed" | "undoing" | "undone" | "cancelled"; total: number; chunk_count: number; next_chunk: number;
  updated: number; undo_enabled: number; undo_token: string | null; undo_expires_at: number | null;
  undo_chunk: number; restored: number; undo_skipped: number; metadata: string; result: string | null; replays: number;
}
export class AssignmentOperationError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}
export function requireAssignmentOwner(owner: AssignmentOwner): void {
  if (![owner.tenantId, owner.userId].every(n => Number.isSafeInteger(n) && n > 0))
    throw new AssignmentOperationError("TENANT_REQUIRED", 400, "An authenticated organization is required");
}
export function assignmentFingerprint(kind: AssignmentKind, body: Record<string, unknown>): string {
  const intent = kind === "bulk"
    ? { repId: body.repId == null ? null : Number(body.repId), leadIds: [...new Set((body.leadIds as unknown[]).map(Number))].sort((a, b) => a - b) }
    : { repId: body.repId == null ? null : Number(body.repId), polygon: body.polygon ?? null,
      polygons: body.polygons ?? null, includeStates: body.includeStates ?? null, excludeLeadIds: body.excludeLeadIds ?? null,
      view: body.view ?? null, source: body.source ?? null, repFilter: body.repFilter ?? null };
  return createHash("sha256").update(JSON.stringify(["assignment-v1", kind, intent])).digest("hex");
}
export function ensureAssignmentOperationSchema(db: Database.Database): void {
  // Every writer, including legacy/manual/import paths, advances ownership.
  // Wall-clock milliseconds cannot distinguish two concurrent assignments.
  const columns = db.pragma("table_info(leads)") as Array<{ name: string }>;
  if (!columns.some(column => column.name === "assignment_version"))
    db.exec("ALTER TABLE leads ADD COLUMN assignment_version INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_lead_assignment_version
    AFTER UPDATE OF assigned_rep_id,assigned_by,assigned_at,unassigned_at ON leads
    BEGIN UPDATE leads SET assignment_version=OLD.assignment_version+1 WHERE id=NEW.id; END`);
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_operations (
    id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL CHECK(tenant_id>0), actor_user_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('selection','bulk')), client_id TEXT NOT NULL, request_hash TEXT NOT NULL,
    rep_id INTEGER, applied_at TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','completed','undoing','undone','cancelled')),
    total INTEGER NOT NULL, chunk_count INTEGER NOT NULL, next_chunk INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0, undo_enabled INTEGER NOT NULL, undo_token TEXT UNIQUE, undo_expires_at INTEGER,
    undo_chunk INTEGER NOT NULL DEFAULT 0, restored INTEGER NOT NULL DEFAULT 0, undo_skipped INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL, result TEXT, replays INTEGER NOT NULL DEFAULT 0,
    UNIQUE(tenant_id,actor_user_id,kind,client_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS assignment_operation_chunks (
    operation_id TEXT NOT NULL REFERENCES assignment_operations(id), chunk INTEGER NOT NULL,
    ids_json TEXT NOT NULL, prior_json TEXT, PRIMARY KEY(operation_id,chunk))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignment_operations_owner ON assignment_operations(tenant_id,actor_user_id,created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignment_operations_undo ON assignment_operations(tenant_id,undo_expires_at)
    WHERE undo_expires_at IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignment_operations_pending ON assignment_operations(tenant_id,actor_user_id,created_at)
    WHERE state IN ('running','undoing')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignment_operations_live_undo ON assignment_operations(undo_expires_at)
    WHERE state IN ('completed','undoing')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignment_operations_retention ON assignment_operations(state,updated_at)`);
}
export function findAssignmentOperation(db: Database.Database, owner: AssignmentOwner, kind: AssignmentKind, clientId: string): AssignmentOperation | undefined {
  requireAssignmentOwner(owner);
  return db.prepare(`SELECT * FROM assignment_operations WHERE tenant_id=? AND actor_user_id=? AND kind=? AND client_id=?`)
    .get(owner.tenantId, owner.userId, kind, clientId) as AssignmentOperation | undefined;
}
export function getAssignmentOperation(db: Database.Database, owner: AssignmentOwner, id: string): AssignmentOperation | undefined {
  requireAssignmentOwner(owner);
  return db.prepare(`SELECT * FROM assignment_operations WHERE tenant_id=? AND actor_user_id=? AND id=?`)
    .get(owner.tenantId, owner.userId, id) as AssignmentOperation | undefined;
}
export function listAssignmentOperations(db: Database.Database, owner: AssignmentOwner): AssignmentOperation[] {
  requireAssignmentOwner(owner);
  const pending = db.prepare(`SELECT * FROM assignment_operations WHERE tenant_id=? AND actor_user_id=?
    AND state IN ('running','undoing') ORDER BY created_at DESC LIMIT 8`).all(owner.tenantId, owner.userId) as AssignmentOperation[];
  const recent = db.prepare(`SELECT * FROM assignment_operations WHERE tenant_id=? AND actor_user_id=?
    AND state NOT IN ('running','undoing') ORDER BY created_at DESC LIMIT 20`).all(owner.tenantId, owner.userId) as AssignmentOperation[];
  return [...pending, ...recent];
}
export function assignmentOperationSummary(op: AssignmentOperation) {
  return { id: op.id, clientId: op.client_id, kind: op.kind, state: op.state, repId: op.rep_id,
    total: op.total, updated: op.updated, processedChunks: op.next_chunk, totalChunks: op.chunk_count,
    createdAt: new Date(op.created_at).toISOString(), updatedAt: new Date(op.updated_at).toISOString(),
    canUndo: op.state === "completed" && !!op.undo_token && (op.undo_expires_at ?? 0) > Date.now(),
    undoExpiresAt: op.undo_expires_at == null ? null : new Date(op.undo_expires_at).toISOString(),
    result: op.result ? JSON.parse(op.result) : null, restored: op.restored, skipped: op.undo_skipped };
}

export async function admitAssignmentOperation(db: Database.Database, owner: AssignmentOwner,
  input: { kind: AssignmentKind; clientId: string; requestHash: string; repId: number | null; ids: number[]; metadata: object; authorize?: () => void }, now = Date.now()): Promise<AssignmentOperation> {
  requireAssignmentOwner(owner);
  if (!/^[\w-]{1,80}$/.test(input.clientId)) throw new AssignmentOperationError("OP_ID_REQUIRED", 400, "A valid operation id is required");
  const ids = [...new Set(input.ids.filter(n => Number.isSafeInteger(n) && n > 0))];
  if (ids.length > 250_000) throw new AssignmentOperationError("BULK_TOO_LARGE", 400, "Selection is too large");
  // Freeze in modest chunks BEFORE taking the writer. No repeated parsing of a
  // quarter-million-ID selection on every resume/progress step.
  const chunks: string[] = [];
  for (let i = 0; i < ids.length; i += 500) chunks.push(JSON.stringify(ids.slice(i, i + 500)));
  return interactiveTransaction(db, () => {
    input.authorize?.();
    const prior = findAssignmentOperation(db, owner, input.kind, input.clientId);
    if (prior) {
      if (prior.request_hash !== input.requestHash) throw new AssignmentOperationError("OP_REUSED", 409, "That operation id was already used for different work");
      return prior;
    }
    const running = db.prepare(`SELECT COUNT(*) AS n FROM assignment_operations WHERE tenant_id=? AND state IN ('running','undoing')`).get(owner.tenantId) as { n: number };
    if (running.n >= 8) throw new AssignmentOperationError("OPERATIONS_PENDING", 409, "Finish or recover pending assignments first");
    const id = randomUUID();
    db.prepare(`INSERT INTO assignment_operations(id,tenant_id,actor_user_id,kind,client_id,request_hash,rep_id,applied_at,
      created_at,updated_at,total,chunk_count,undo_enabled,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, owner.tenantId, owner.userId, input.kind, input.clientId, input.requestHash, input.repId,
        input.repId == null ? null : new Date(now).toISOString(), now, now, ids.length, chunks.length,
        ids.length <= 5000 && (input.kind === "selection" || input.repId != null) ? 1 : 0, JSON.stringify(input.metadata));
    const put = db.prepare(`INSERT INTO assignment_operation_chunks(operation_id,chunk,ids_json) VALUES (?,?,?)`);
    chunks.forEach((json, index) => put.run(id, index, json));
    return getAssignmentOperation(db, owner, id)!;
  });
}

function audit(db: Database.Database, op: AssignmentOperation, action: string, details: object) {
  db.prepare(`INSERT INTO activity_log(tenant_id,user_id,action,entity_type,details,at) VALUES (?,?,?,'lead',?,?)`)
    .run(op.tenant_id, op.actor_user_id, action, JSON.stringify({ operationId: op.id, ...details }), new Date().toISOString());
}
function scopePredicate(scope: number[] | undefined): string {
  return scope === undefined ? "1=1" : `(assigned_rep_id IS NULL OR assigned_rep_id IN (${scope.filter(Number.isSafeInteger).map(Number).join(",") || "-1"}))`;
}
function finishAssignment(db: Database.Database, op: AssignmentOperation, now: number): void {
  let undo: { undoToken?: string; undoExpiresAt?: string } = {};
  if (op.undo_enabled && op.updated > 0) {
    // Match the existing tenant-fair eight-receipt/64-total budget. Never evict
    // an undo already in progress; if all slots are active, return no new token.
    for (const [where, args, cap] of [["tenant_id=?", [op.tenant_id], 8], ["1=1", [], 64]] as const) {
      const entries = db.prepare(`SELECT id,state FROM assignment_operations WHERE ${where}
        AND undo_expires_at>? AND state IN ('completed','undoing') ORDER BY undo_expires_at`).all(...args, now) as Array<{ id: string; state: string }>;
      let excess = entries.length - cap + 1;
      for (const entry of entries) {
        if (excess <= 0) break;
        if (entry.state !== "completed") continue;
        db.prepare(`UPDATE assignment_operations SET undo_expires_at=? WHERE id=?`).run(now, entry.id); excess--;
      }
      if (excess > 0) { op.undo_enabled = 0; break; }
    }
    if (op.undo_enabled) {
      const token = `durable-${randomUUID()}`;
      const expires = now + 600_000;
      db.prepare(`UPDATE assignment_operations SET undo_token=?,undo_expires_at=? WHERE id=?`).run(token, expires, op.id);
      undo = { undoToken: token, undoExpiresAt: new Date(expires).toISOString() };
    }
  }
  const metadata = JSON.parse(op.metadata);
  const result = { ...metadata, operationId: op.id, updated: op.updated, skipped: op.total - op.updated, repId: op.rep_id,
    ...(op.kind === "selection" ? { assigned: op.updated, total: op.total } : {}), ...undo };
  audit(db, op, op.kind === "bulk" ? "lead.bulk_assign" : "lead.assign_selection", { repId: op.rep_id, requested: op.total, updated: op.updated, skipped: op.total - op.updated });
  db.prepare(`UPDATE assignment_operations SET state='completed',result=?,updated_at=? WHERE id=?`).run(JSON.stringify(result), now, op.id);
}

/** No lease is needed for synchronous SQLite effects: the writer serializes
 * cursor read, lead changes, inverse and receipt. Two HTTP workers can safely
 * help the SAME operation without processing the same chunk twice. */
export async function continueAssignmentOperation(db: Database.Database, owner: AssignmentOwner, id: string,
  authorize: (repId: number | null, undo: boolean) => AssignmentAuthority,
  afterCommit: (ids: number[]) => void = () => {}): Promise<AssignmentOperation> {
  for (;;) {
    const result = await interactiveTransaction(db, () => {
      const op = getAssignmentOperation(db, owner, id);
      if (!op) throw new AssignmentOperationError("NOT_FOUND", 404, "Assignment not found");
      const authority = authorize(op.state === "running" ? op.rep_id : null, op.state !== "running");
      if (op.state !== "running") return { op, changed: [] as number[] };
      if (op.next_chunk >= op.chunk_count) {
        finishAssignment(db, op, Date.now());
        return { op: getAssignmentOperation(db, owner, id)!, changed: [] as number[] };
      }
      const chunk = db.prepare(`SELECT ids_json FROM assignment_operation_chunks WHERE operation_id=? AND chunk=?`).get(op.id, op.next_chunk) as { ids_json: string };
      const ids = JSON.parse(chunk.ids_json) as number[];
      const predicate = `tenant_id=? AND ${scopePredicate(authority.scope)} AND id IN (${ids.map(() => "?").join(",")})
        ${op.kind === "selection" ? "AND assigned_rep_id IS NOT ?" : ""}`;
      const args = [owner.tenantId, ...ids, ...(op.kind === "selection" ? [op.rep_id] : [])];
      const prior = op.undo_enabled ? db.prepare(`SELECT id,assigned_rep_id AS assignedRepId,assigned_by AS assignedBy,
        assigned_at AS assignedAt,unassigned_at AS unassignedAt,assignment_version AS assignmentVersion FROM leads WHERE ${predicate}`).all(...args) : [];
      if (op.rep_id != null) db.prepare(`INSERT INTO lead_events(lead_id,type,actor,detail,at)
        SELECT id,'assignment',?,?,datetime('now') FROM leads WHERE ${predicate}`)
        .run(authority.actorName, JSON.stringify({ assignedTo: authority.repName, assignedBy: authority.actorName }), ...args);
      const changed = db.prepare(`UPDATE leads SET assigned_rep_id=?,assigned_by=?,assigned_at=?,
        unassigned_at=CASE WHEN ? IS NULL THEN ? ELSE unassigned_at END,updated_at=datetime('now') WHERE ${predicate} RETURNING id`)
        .all(op.rep_id, op.rep_id == null ? null : authority.actorName, op.applied_at, op.rep_id, new Date(op.created_at).toISOString(), ...args) as Array<{ id: number }>;
      db.prepare(`UPDATE assignment_operation_chunks SET prior_json=? WHERE operation_id=? AND chunk=?`).run(JSON.stringify(prior), op.id, op.next_chunk);
      db.prepare(`UPDATE assignment_operations SET next_chunk=next_chunk+1,updated=updated+?,updated_at=? WHERE id=?`).run(changed.length, Date.now(), op.id);
      return { op: getAssignmentOperation(db, owner, id)!, changed: changed.map(r => r.id) };
    });
    if (result.changed.length) afterCommit(result.changed);
    if (result.op.state !== "running") return result.op;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

export async function undoAssignmentOperation(db: Database.Database, owner: AssignmentOwner, token: string,
  authorize: (repId: number | null, undo: boolean) => AssignmentAuthority,
  afterCommit: (ids: number[]) => void = () => {}): Promise<{ restored: number; skipped: number }> {
  requireAssignmentOwner(owner);
  for (;;) {
    const result = await interactiveTransaction(db, () => {
      const op = db.prepare(`SELECT * FROM assignment_operations WHERE tenant_id=? AND actor_user_id=? AND undo_token=?`)
        .get(owner.tenantId, owner.userId, token) as AssignmentOperation | undefined;
      if (!op) throw new AssignmentOperationError("UNDO_EXPIRED", 410, "That assignment can no longer be undone");
      const authority = authorize(null, true);
      if (op.state === "undone") return { done: true, restored: op.restored, skipped: op.undo_skipped, changed: [] as number[] };
      if ((op.state !== "completed" && op.state !== "undoing") || (op.state === "completed" && (op.undo_expires_at ?? 0) <= Date.now()))
        throw new AssignmentOperationError("UNDO_EXPIRED", 410, "That assignment can no longer be undone");
      // Once admitted within the ten-minute window, a crash cannot strand an
      // incomplete undo merely because its deadline elapsed during recovery.
      db.prepare(`UPDATE assignment_operations SET state='undoing' WHERE id=?`).run(op.id);
      if (op.undo_chunk >= op.chunk_count) {
        audit(db, op, "lead.assign_selection.undo", { restored: op.restored, skipped: op.undo_skipped });
        db.prepare(`UPDATE assignment_operations SET state='undone',updated_at=? WHERE id=?`).run(Date.now(), op.id);
        return { done: true, restored: op.restored, skipped: op.undo_skipped, changed: [] as number[] };
      }
      const chunk = db.prepare(`SELECT prior_json FROM assignment_operation_chunks WHERE operation_id=? AND chunk=?`).get(op.id, op.undo_chunk) as { prior_json: string };
      const prior = JSON.parse(chunk.prior_json || "[]") as Prior[];
      const changed: number[] = [];
      const put = db.prepare(`UPDATE leads SET assigned_rep_id=?,assigned_by=?,assigned_at=?,unassigned_at=?,updated_at=datetime('now')
          WHERE tenant_id=? AND id=? AND assigned_rep_id IS ? AND assigned_at IS ? AND assignment_version=? AND ${scopePredicate(authority.scope)}
            AND (? IS NOT NULL OR unassigned_at IS ?) RETURNING id`)
;
      const event = db.prepare(`INSERT INTO lead_events(lead_id,type,actor,detail,at) VALUES (?,'assignment',?,?,datetime('now'))`);
      const member = db.prepare(`SELECT name FROM team_members WHERE id=? AND tenant_id=?`);
      const names = new Map<number, string | null>();
      for (const row of prior) {
        if (row.assignedRepId != null && (authority.scope !== undefined && !authority.scope.includes(row.assignedRepId))) continue;
        if (row.assignedRepId != null && !names.has(row.assignedRepId)) {
          names.set(row.assignedRepId, (member.get(row.assignedRepId, owner.tenantId) as { name: string } | undefined)?.name ?? null);
        }
        if (row.assignedRepId != null && !names.get(row.assignedRepId)) continue;
        const hit = put          .get(row.assignedRepId, row.assignedBy, row.assignedAt, row.unassignedAt, owner.tenantId, row.id, op.rep_id, op.applied_at,
            row.assignmentVersion + 1, op.rep_id, new Date(op.created_at).toISOString()) as { id: number } | undefined;
        if (!hit) continue;
        event
          .run(row.id, authority.actorName, JSON.stringify({ undo: true, operationId: op.id, assignedTo: row.assignedRepId == null ? null : names.get(row.assignedRepId), assignedBy: authority.actorName }));
        changed.push(row.id);
      }
      db.prepare(`UPDATE assignment_operations SET undo_chunk=undo_chunk+1,restored=restored+?,undo_skipped=undo_skipped+?,updated_at=? WHERE id=?`)
        .run(changed.length, prior.length - changed.length, Date.now(), op.id);
      return { done: false, restored: 0, skipped: 0, changed };
    });
    if (result.changed.length) afterCommit(result.changed);
    if (result.done) return { restored: result.restored, skipped: result.skipped };
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

export function assignmentReceiptCleanupDue(db: Database.Database, now = Date.now()): boolean {
  return !!db.prepare(`SELECT 1 FROM assignment_operations o WHERE o.state IN ('completed','undone','cancelled')
    AND ((o.updated_at<?) OR ((o.undo_expires_at IS NULL OR o.undo_expires_at<=? OR o.state!='completed')
      AND EXISTS (SELECT 1 FROM assignment_operation_chunks c WHERE c.operation_id=o.id))) LIMIT 1`)
    .get(now - 30 * 86400_000, now);
}
export function purgeAssignmentReceipts(db: Database.Database, now = Date.now()): number {
  // Bounded by operations AND by at most 500 stored chunks per invocation.
  const eligible = db.prepare(`SELECT c.operation_id,c.chunk FROM assignment_operation_chunks c JOIN assignment_operations o ON o.id=c.operation_id
    WHERE o.state IN ('completed','undone','cancelled') AND (o.undo_expires_at IS NULL OR o.undo_expires_at<=? OR o.state!='completed') LIMIT 500`).all(now) as Array<{ operation_id: string; chunk: number }>;
  const remove = db.prepare(`DELETE FROM assignment_operation_chunks WHERE operation_id=? AND chunk=?`);
  for (const row of eligible) remove.run(row.operation_id, row.chunk);
  db.prepare(`DELETE FROM assignment_operations WHERE id IN (SELECT id FROM assignment_operations o
    WHERE state IN ('completed','undone','cancelled') AND updated_at<? AND NOT EXISTS (
      SELECT 1 FROM assignment_operation_chunks c WHERE c.operation_id=o.id) LIMIT 100)`).run(now - 30 * 86400_000);
  return eligible.length;
}

/** Explicit operator stop: committed assignments/restorations remain, and the
 * terminal state fences every further chunk. Never delete the audit evidence. */
export async function stopAssignmentOperation(db: Database.Database, owner: AssignmentOwner, id: string, reason: string): Promise<boolean> {
  requireAssignmentOwner(owner);
  if (reason.trim().length < 5 || reason.length > 500) throw new AssignmentOperationError("REASON_REQUIRED", 400, "Explain why this work should stop");
  return interactiveTransaction(db, () => {
    if (!recoveryActorAllowed(db, owner)) throw new AssignmentOperationError("FORBIDDEN", 403, "Recovery access has changed");
    const op = db.prepare(`SELECT * FROM assignment_operations WHERE tenant_id=? AND id=?`).get(owner.tenantId, id) as AssignmentOperation | undefined;
    if (!op) throw new AssignmentOperationError("NOT_FOUND", 404, "Assignment not found");
    if (op.state !== "running" && op.state !== "undoing") return false;
    audit(db, { ...op, actor_user_id: owner.userId }, "lead.assignment.stop", { reason: reason.trim(), originalActor: op.actor_user_id, updated: op.updated, restored: op.restored });
    db.prepare(`UPDATE assignment_operations SET state='cancelled',undo_expires_at=?,updated_at=?,result=? WHERE id=? AND tenant_id=?`)
      .run(Date.now(), Date.now(), JSON.stringify({ operationId: op.id, state: "cancelled", updated: op.updated, skipped: op.total - op.updated, restored: op.restored }), id, owner.tenantId);
    return true;
  });
}
