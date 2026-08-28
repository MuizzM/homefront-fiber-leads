// ── Admin history — the append-only record of who changed what ────────────────
// Every privileged mutation lands here with enough context to answer, months
// later and without guesswork: WHO did it, WHAT action, to WHICH target, what
// the values were BEFORE and AFTER, WHEN, in which TENANT, under which REQUEST,
// and whether it actually SUCCEEDED.
//
// Two properties this table must never lose:
//
//  1. APPEND-ONLY. History that can be edited is not history. UPDATE and DELETE
//     are refused by SQLite triggers, so neither a future code change nor a
//     stray admin route can rewrite the record — the database enforces it, not
//     a convention.
//  2. DURABLE ACROSS DEPLOYS. It is an ordinary table in the same volume-backed
//     SQLite file as everything else, created through the normal migration path
//     (IF NOT EXISTS), so a redeploy re-runs the migration and finds the rows
//     already there. Nothing lives in memory or in the client.
//
// The existing activity_log stays exactly as it is (other screens read it).
// This is the richer, stricter stream the operations console needs, and the two
// are written together by recordAdminAudit so no caller has to remember both.
import type { JsonValue } from "@shared/json";
import { rawDb } from "./db";
import { structuredLog } from "./structuredLog";

export const ADMIN_AUDIT_OUTCOMES = ["success", "failure", "denied"] as const;
export type AdminAuditOutcome = (typeof ADMIN_AUDIT_OUTCOMES)[number];

let schemaReady = false;

/** Idempotent DDL. Safe to call on every boot and from any test. */
export function ensureAdminAuditSchema(): void {
  if (schemaReady) return;
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            TEXT    NOT NULL,
      tenant_id     INTEGER,
      actor_user_id INTEGER,
      actor_name    TEXT,
      actor_role    TEXT,
      action        TEXT    NOT NULL,
      target_type   TEXT,
      target_id     TEXT,
      target_label  TEXT,
      before_json   TEXT,
      after_json    TEXT,
      request_id    TEXT,
      outcome       TEXT    NOT NULL DEFAULT 'success',
      reason        TEXT,
      ip            TEXT,
      user_agent    TEXT
    );
    -- Newest-first listing, the console's default view.
    CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
    -- Tenant-scoped listing: the wall every non-super-admin read passes through.
    CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant_at ON admin_audit(tenant_id, at DESC);
    -- Filter facets.
    CREATE INDEX IF NOT EXISTS idx_admin_audit_action_at ON admin_audit(action, at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor_at ON admin_audit(actor_user_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit(target_type, target_id);
    -- "Show me what FAILED" is the highest-value filter in an incident, and it
    -- selects a small slice of a large table - measured at 100k rows it was the
    -- slowest indexed path (6ms) because it fell back to the at-ordered scan.
    CREATE INDEX IF NOT EXISTS idx_admin_audit_outcome_at ON admin_audit(outcome, at DESC);

    -- APPEND-ONLY, enforced by the database. RAISE(ABORT) rolls back the whole
    -- statement, so a mutation attempt fails loudly rather than silently
    -- succeeding against a tampered row.
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_update
      BEFORE UPDATE ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete
      BEFORE DELETE ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'admin_audit is append-only'); END;
  `);
  schemaReady = true;
}

/** Test-only: forget the memoised schema flag when the DB is rebuilt. */

export interface AdminAuditActor {
  id?: number | null;
  name?: string | null;
  role?: string | null;
  tenantId?: number | null;
  isSuperAdmin?: boolean | number | null;
}

export interface AdminAuditInput {
  actor: AdminAuditActor | null | undefined;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  targetLabel?: string | null;
  /** Values as they were BEFORE the change (omit for creates). */
  before?: unknown;
  /** Values as they are AFTER the change (omit for deletes). */
  after?: unknown;
  outcome?: AdminAuditOutcome;
  /** Why a failure/denial happened — never a stack trace. */
  reason?: string | null;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Override the tenant the row is filed under (defaults to the actor's). */
  tenantId?: number | null;
}

// Values are operator-facing, not a debugging dump: cap the payload so one
// pathological body can't bloat the table or the console response.
const MAX_JSON_CHARS = 8_000;
function encode(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const json = JSON.stringify(value, redactSecrets);
    if (json == null) return null;
    return json.length > MAX_JSON_CHARS ? json.slice(0, MAX_JSON_CHARS) + "…[truncated]" : json;
  } catch {
    return null; // circular / unserialisable — history is never worth a 500
  }
}

// Tenant rows carry provider credentials. History records THAT they changed,
// never what they changed to.
const SECRET_KEYS = new Set([
  "mapboxToken", "scannerSecret", "kfsAuthBasic", "enrichmentApiKey",
  "passwordHash", "password", "token", "secret",
]);
function redactSecrets(this: any, key: string, value: unknown) {
  if (SECRET_KEYS.has(key)) return value == null || value === "" ? null : "[redacted]";
  return value;
}

/**
 * Append one history row. NEVER throws and never blocks the caller's response:
 * a mutation that succeeded must not be reported as failed because the audit
 * write hiccuped. A failure here is itself logged (structured, alertable).
 */
export function recordAdminAudit(input: AdminAuditInput): void {
  try {
    ensureAdminAuditSchema();
    const actor = input.actor ?? {};
    // Super admins act ACROSS tenants; file the row under the tenant that was
    // actually touched (explicit tenantId) so the affected org can see its own
    // history, falling back to the actor's org for ordinary admins.
    const tenantId = input.tenantId !== undefined ? input.tenantId : (actor.tenantId ?? null);
    rawDb.prepare(
      `INSERT INTO admin_audit
        (at, tenant_id, actor_user_id, actor_name, actor_role, action, target_type, target_id,
         target_label, before_json, after_json, request_id, outcome, reason, ip, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      new Date().toISOString(),
      tenantId,
      actor.id ?? null,
      actor.name ?? null,
      actor.role ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId == null ? null : String(input.targetId),
      input.targetLabel ?? null,
      encode(input.before),
      encode(input.after),
      input.requestId ?? null,
      input.outcome ?? "success",
      input.reason ?? null,
      input.ip ?? null,
      (input.userAgent ?? null)?.slice(0, 200) ?? null,
    );
  } catch (error: any) {
    structuredLog("admin_audit.write_failed", {
      action: input.action,
      error: String(error?.message ?? error).slice(0, 200),
    }, "error");
  }
}

/** Convenience: pull actor + request context straight off an Express request. */
export function auditContext(req: any): Pick<AdminAuditInput, "actor" | "requestId" | "ip" | "userAgent"> {
  const user = req?.user;
  return {
    actor: user
      ? { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId ?? null, isSuperAdmin: user.isSuperAdmin }
      : null,
    requestId: req?.id ?? null,
    ip: req?.ip ?? null,
    userAgent: req?.headers?.["user-agent"] ?? null,
  };
}

export interface AdminAuditQuery {
  /** null = platform-wide (super admin only). A number scopes to one tenant. */
  tenantId: number | null;
  action?: string;
  actorUserId?: number;
  targetType?: string;
  outcome?: AdminAuditOutcome;
  /** ISO bounds, inclusive of `from`, exclusive of `to`. */
  from?: string;
  to?: string;
  /** Free text across action, actor, target label and reason. */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AdminAuditRow {
  id: number; at: string; tenantId: number | null;
  actorUserId: number | null; actorName: string | null; actorRole: string | null;
  action: string; targetType: string | null; targetId: string | null; targetLabel: string | null;
  before: unknown; after: unknown;
  requestId: string | null; outcome: string; reason: string | null; ip: string | null;
}

const MAX_PAGE = 200;

/**
 * Read history. The tenant wall is applied in SQL, not after the fact: a caller
 * scoped to a tenant can never receive another org's rows even if a filter
 * argument says otherwise. Returns a total so the console can paginate honestly.
 */
export function queryAdminAudit(query: AdminAuditQuery): { rows: AdminAuditRow[]; total: number; limit: number; offset: number } {
  ensureAdminAuditSchema();
  const where: string[] = [];
  const args: any[] = [];
  if (query.tenantId != null) {
    // Platform-level rows (tenant_id NULL) stay visible ONLY to super admins.
    where.push("tenant_id = ?");
    args.push(query.tenantId);
  }
  if (query.action) { where.push("action = ?"); args.push(query.action); }
  if (query.actorUserId != null) { where.push("actor_user_id = ?"); args.push(query.actorUserId); }
  if (query.targetType) { where.push("target_type = ?"); args.push(query.targetType); }
  if (query.outcome) { where.push("outcome = ?"); args.push(query.outcome); }
  if (query.from) { where.push("at >= ?"); args.push(query.from); }
  if (query.to) { where.push("at < ?"); args.push(query.to); }
  if (query.q) {
    where.push("(action LIKE ? OR actor_name LIKE ? OR target_label LIKE ? OR target_id LIKE ? OR reason LIKE ?)");
    const like = `%${query.q}%`;
    args.push(like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(query.limit) || 50)));
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));

  const total = Number((rawDb.prepare(`SELECT COUNT(*) AS c FROM admin_audit ${clause}`).get(...args) as any)?.c ?? 0);
  const rows = rawDb.prepare(
    `SELECT id, at, tenant_id AS tenantId, actor_user_id AS actorUserId, actor_name AS actorName,
            actor_role AS actorRole, action, target_type AS targetType, target_id AS targetId,
            target_label AS targetLabel, before_json AS beforeJson, after_json AS afterJson,
            request_id AS requestId, outcome, reason, ip
       FROM admin_audit ${clause}
      ORDER BY at DESC, id DESC
      LIMIT ? OFFSET ?`,
  ).all(...args, limit, offset) as any[];

  return {
    rows: rows.map((r) => ({
      ...r,
      before: parseJson(r.beforeJson),
      after: parseJson(r.afterJson),
      beforeJson: undefined,
      afterJson: undefined,
    })),
    total, limit, offset,
  };
}

function parseJson(raw: string | null): JsonValue {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; } // truncated payloads read as text
}

/** Distinct facet values for the console's filter menus (scoped like the list). */
export function adminAuditFacets(tenantId: number | null): { actions: string[]; actors: Array<{ id: number; name: string }> } {
  ensureAdminAuditSchema();
  const scope = tenantId != null ? "WHERE tenant_id = ?" : "";
  const args = tenantId != null ? [tenantId] : [];
  const actions = (rawDb.prepare(
    `SELECT DISTINCT action FROM admin_audit ${scope} ORDER BY action LIMIT 200`,
  ).all(...args) as any[]).map((r) => r.action);
  const actors = (rawDb.prepare(
    `SELECT DISTINCT actor_user_id AS id, actor_name AS name FROM admin_audit
      ${scope ? scope + " AND" : "WHERE"} actor_user_id IS NOT NULL ORDER BY actor_name LIMIT 200`,
  ).all(...args) as any[]).map((r) => ({ id: r.id, name: r.name ?? `User #${r.id}` }));
  return { actions, actors };
}
