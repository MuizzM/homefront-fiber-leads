// ── Guarded actions - the concrete kinds ─────────────────────────────────────
//
// One executor per kind. The engine owns states, races and policy; everything
// here is domain work, and each executor answers the same five questions:
// what does this payload mean, how big is it, can it run, what does running it
// change, and what would put it back.
//
// THE INVERSE IS READ BEFORE THE WRITE, ALWAYS. Every execute() below selects
// the current values first and builds the inverse from what it saw, then
// writes. Doing it the other way round - deriving the inverse afterwards, or at
// undo time - produces a reversal to wherever the row happens to be later,
// which is not where it started. This ordering is the entire reason undo can be
// trusted.
//
// FINGERPRINTS COVER EXACTLY THE TARGETS. fingerprint() hashes the current
// state of the rows this payload touches and nothing else. Too narrow and drift
// slips through; too wide and unrelated activity blocks a legitimate undo.
//
// TENANCY IS IN EVERY WHERE CLAUSE. These run from an approval queue, which
// means the actor approving is often not the actor who submitted, and neither
// is necessarily the one whose organization owns the row.

import { createHash } from "node:crypto";
import { rawDb } from "./db";
import {
  GuardedActionError, registerExecutor,
  type ExecutorResult, type GuardedActionExecutor,
} from "./guardedActionEngine";

const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

const nowIso = () => new Date().toISOString();

/** Bounded so one request cannot ask the gate to rewrite an entire tenant. The
 *  lasso already caps a selection well below this; the limit exists so a
 *  hand-rolled API call cannot exceed what a human could have selected. */
const MAX_BULK_LEADS = 5_000;

function intOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function requireInt(value: unknown, field: string): number {
  const n = intOrNull(value);
  if (n == null) throw new GuardedActionError(400, `${field} is required.`, "bad_payload");
  return n;
}

/** A rep must exist, belong to this organization, and be active. Checked in the
 *  executor rather than at the route because an approval can land days after
 *  the request, by which time the rep may have left. */
function assertAssignableRep(tenantId: number, repId: number | null): void {
  if (repId == null) return;
  const row = rawDb.prepare(
    `SELECT id, active FROM team_members WHERE id = ? AND tenant_id = ?`,
  ).get(repId, tenantId) as { id: number; active: number | null } | undefined;
  if (!row) throw new GuardedActionError(400, "That rep is not on this organization's roster.", "unknown_rep");
  if (row.active === 0) throw new GuardedActionError(400, "That rep is no longer active.", "inactive_rep");
}

function repName(tenantId: number, repId: number | null): string {
  if (repId == null) return "nobody";
  const row = rawDb.prepare(
    `SELECT name FROM team_members WHERE id = ? AND tenant_id = ?`,
  ).get(repId, tenantId) as { name: string } | undefined;
  return row?.name ?? `rep ${repId}`;
}

// ── lead.reassign ────────────────────────────────────────────────────────────

interface ReassignPayload { leadId: number; toRepId: number | null }
interface ReassignInverse { leadId: number; repId: number | null; source: string | null; assignedBy: string | null; assignedAt: string | null }

const leadReassign: GuardedActionExecutor<ReassignPayload> = {
  kind: "lead.reassign",

  parse(raw: any): ReassignPayload {
    return { leadId: requireInt(raw?.leadId, "leadId"), toRepId: intOrNull(raw?.toRepId) };
  },

  magnitude() { return 1; },

  label(payload, ctx) {
    const lead = rawDb.prepare(
      `SELECT address, city FROM leads WHERE id = ? AND tenant_id = ?`,
    ).get(payload.leadId, ctx.tenantId) as { address: string; city: string } | undefined;
    const where = lead ? `${lead.address}, ${lead.city}` : `door ${payload.leadId}`;
    return `${where} to ${repName(ctx.tenantId, payload.toRepId)}`;
  },

  preflight(payload, ctx) {
    const lead = rawDb.prepare(
      `SELECT id FROM leads WHERE id = ? AND tenant_id = ?`,
    ).get(payload.leadId, ctx.tenantId);
    if (!lead) throw new GuardedActionError(404, "That door is not in this organization.", "not_found");
    assertAssignableRep(ctx.tenantId, payload.toRepId);
  },

  execute(payload, ctx): ExecutorResult {
    // Read first. The inverse describes where this door actually was, not where
    // anything later assumes it was.
    const before = rawDb.prepare(
      `SELECT assigned_rep_id, assignment_source, assigned_by, assigned_at
         FROM leads WHERE id = ? AND tenant_id = ?`,
    ).get(payload.leadId, ctx.tenantId) as
      { assigned_rep_id: number | null; assignment_source: string | null; assigned_by: string | null; assigned_at: string | null } | undefined;
    if (!before) throw new GuardedActionError(404, "That door is not in this organization.", "not_found");

    const at = nowIso();
    rawDb.prepare(
      `UPDATE leads SET assigned_rep_id = ?, assignment_source = 'manual', assigned_by = ?, assigned_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(payload.toRepId, ctx.name, at, at, payload.leadId, ctx.tenantId);

    const inverse: ReassignInverse = {
      leadId: payload.leadId,
      repId: before.assigned_rep_id,
      source: before.assignment_source,
      assignedBy: before.assigned_by,
      assignedAt: before.assigned_at,
    };
    return {
      summary: `Moved from ${repName(ctx.tenantId, before.assigned_rep_id)} to ${repName(ctx.tenantId, payload.toRepId)}.`,
      inverse,
    };
  },

  fingerprint(payload, ctx) {
    const row = rawDb.prepare(
      `SELECT assigned_rep_id, assigned_at FROM leads WHERE id = ? AND tenant_id = ?`,
    ).get(payload.leadId, ctx.tenantId) as { assigned_rep_id: number | null; assigned_at: string | null } | undefined;
    return sha(`${payload.leadId}:${row?.assigned_rep_id ?? "null"}:${row?.assigned_at ?? "null"}`);
  },

  reverse(inverse: ReassignInverse, ctx) {
    rawDb.prepare(
      `UPDATE leads SET assigned_rep_id = ?, assignment_source = ?, assigned_by = ?, assigned_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(inverse.repId, inverse.source, inverse.assignedBy, inverse.assignedAt, nowIso(), inverse.leadId, ctx.tenantId);
    return { summary: `Returned to ${repName(ctx.tenantId, inverse.repId)}.` };
  },
};

// ── lead.bulk_assign ─────────────────────────────────────────────────────────

interface BulkPayload { leadIds: number[]; toRepId: number | null }
interface BulkInverse { entries: ReassignInverse[] }

const leadBulkAssign: GuardedActionExecutor<BulkPayload> = {
  kind: "lead.bulk_assign",

  parse(raw: any): BulkPayload {
    const ids = Array.isArray(raw?.leadIds) ? raw.leadIds : [];
    // Deduplicated and sorted so the same selection always produces the same
    // payload, which is what makes an idempotency key over it meaningful.
    const leadIds: number[] = [...new Set(
      (ids as unknown[]).map((v) => intOrNull(v)).filter((v): v is number => v != null),
    )].sort((a, b) => a - b);
    if (!leadIds.length) throw new GuardedActionError(400, "Pick at least one door.", "bad_payload");
    if (leadIds.length > MAX_BULK_LEADS) {
      throw new GuardedActionError(400, `That is more than ${MAX_BULK_LEADS} doors in one action.`, "too_many");
    }
    return { leadIds, toRepId: intOrNull(raw?.toRepId) };
  },

  magnitude(payload) { return payload.leadIds.length; },

  label(payload, ctx) {
    return `${payload.leadIds.length} doors to ${repName(ctx.tenantId, payload.toRepId)}`;
  },

  preflight(payload, ctx) {
    assertAssignableRep(ctx.tenantId, payload.toRepId);
    const found = Number((rawDb.prepare(
      `SELECT COUNT(*) AS n FROM leads WHERE tenant_id = ? AND id IN (${payload.leadIds.map(() => "?").join(",")})`,
    ).get(ctx.tenantId, ...payload.leadIds) as { n: number }).n);
    if (found !== payload.leadIds.length) {
      // Refuse the whole thing rather than silently assigning the subset that
      // still exists. A partial bulk move is the outcome nobody asked for and
      // the hardest one to notice.
      throw new GuardedActionError(
        409,
        `${payload.leadIds.length - found} of these doors are no longer in this organization, so nothing was assigned.`,
        "stale_selection",
      );
    }
  },

  execute(payload, ctx): ExecutorResult {
    const placeholders = payload.leadIds.map(() => "?").join(",");
    const before = rawDb.prepare(
      `SELECT id, assigned_rep_id, assignment_source, assigned_by, assigned_at
         FROM leads WHERE tenant_id = ? AND id IN (${placeholders}) ORDER BY id`,
    ).all(ctx.tenantId, ...payload.leadIds) as Array<{
      id: number; assigned_rep_id: number | null; assignment_source: string | null;
      assigned_by: string | null; assigned_at: string | null;
    }>;

    const at = nowIso();
    // One statement, not a loop: the whole selection moves or none of it does,
    // and a single UPDATE holds the writer lock for the shortest possible time.
    const changed = rawDb.prepare(
      `UPDATE leads SET assigned_rep_id = ?, assignment_source = 'manual', assigned_by = ?, assigned_at = ?, updated_at = ?
        WHERE tenant_id = ? AND id IN (${placeholders})`,
    ).run(payload.toRepId, ctx.name, at, at, ctx.tenantId, ...payload.leadIds).changes;

    const inverse: BulkInverse = {
      entries: before.map((row) => ({
        leadId: row.id,
        repId: row.assigned_rep_id,
        source: row.assignment_source,
        assignedBy: row.assigned_by,
        assignedAt: row.assigned_at,
      })),
    };
    const from = new Set(before.map((r) => r.assigned_rep_id));
    return {
      summary: `Moved ${changed} doors from ${from.size} previous ${from.size === 1 ? "assignee" : "assignees"} to ${repName(ctx.tenantId, payload.toRepId)}.`,
      inverse,
    };
  },

  fingerprint(payload, ctx) {
    const rows = rawDb.prepare(
      `SELECT id, assigned_rep_id, assigned_at FROM leads
        WHERE tenant_id = ? AND id IN (${payload.leadIds.map(() => "?").join(",")}) ORDER BY id`,
    ).all(ctx.tenantId, ...payload.leadIds) as Array<{ id: number; assigned_rep_id: number | null; assigned_at: string | null }>;
    return sha(rows.map((r) => `${r.id}:${r.assigned_rep_id ?? "null"}:${r.assigned_at ?? "null"}`).join("|"));
  },

  reverse(inverse: BulkInverse, ctx) {
    const stmt = rawDb.prepare(
      `UPDATE leads SET assigned_rep_id = ?, assignment_source = ?, assigned_by = ?, assigned_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    );
    const at = nowIso();
    // Per-row because each door goes back to a DIFFERENT previous owner. Wrapped
    // in one transaction: a half-reversed bulk move is worse than none.
    const run = rawDb.transaction((entries: ReassignInverse[]) => {
      for (const e of entries) stmt.run(e.repId, e.source, e.assignedBy, e.assignedAt, at, e.leadId, ctx.tenantId);
    });
    run(inverse.entries);
    return { summary: `Returned ${inverse.entries.length} doors to their previous assignees.` };
  },
};

// ── recovery.case.assign ─────────────────────────────────────────────────────

interface CasePayload { caseId: number; toRepId: number | null }
interface CaseInverse { caseId: number; repId: number | null; userId: number | null }

const recoveryCaseAssign: GuardedActionExecutor<CasePayload> = {
  kind: "recovery.case.assign",

  parse(raw: any): CasePayload {
    return { caseId: requireInt(raw?.caseId, "caseId"), toRepId: intOrNull(raw?.toRepId) };
  },

  magnitude() { return 1; },

  label(payload, ctx) {
    return `Recovery case ${payload.caseId} to ${repName(ctx.tenantId, payload.toRepId)}`;
  },

  preflight(payload, ctx) {
    const row = rawDb.prepare(
      `SELECT status FROM order_recovery_cases WHERE id = ? AND tenant_id = ?`,
    ).get(payload.caseId, ctx.tenantId) as { status: string } | undefined;
    if (!row) throw new GuardedActionError(404, "That case is not in this organization.", "not_found");
    if (row.status === "resolved" || row.status === "closed") {
      throw new GuardedActionError(409, "That case is already closed.", "case_closed");
    }
    assertAssignableRep(ctx.tenantId, payload.toRepId);
  },

  execute(payload, ctx): ExecutorResult {
    const before = rawDb.prepare(
      `SELECT assigned_to_rep_id, assigned_to_user_id FROM order_recovery_cases WHERE id = ? AND tenant_id = ?`,
    ).get(payload.caseId, ctx.tenantId) as { assigned_to_rep_id: number | null; assigned_to_user_id: number | null } | undefined;
    if (!before) throw new GuardedActionError(404, "That case is not in this organization.", "not_found");

    rawDb.prepare(
      `UPDATE order_recovery_cases SET assigned_to_rep_id = ?, assigned_to_user_id = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(payload.toRepId, ctx.userId, nowIso(), payload.caseId, ctx.tenantId);

    const inverse: CaseInverse = {
      caseId: payload.caseId,
      repId: before.assigned_to_rep_id,
      userId: before.assigned_to_user_id,
    };
    return {
      summary: `Case reassigned from ${repName(ctx.tenantId, before.assigned_to_rep_id)} to ${repName(ctx.tenantId, payload.toRepId)}.`,
      inverse,
    };
  },

  fingerprint(payload, ctx) {
    const row = rawDb.prepare(
      `SELECT assigned_to_rep_id, updated_at FROM order_recovery_cases WHERE id = ? AND tenant_id = ?`,
    ).get(payload.caseId, ctx.tenantId) as { assigned_to_rep_id: number | null; updated_at: string | null } | undefined;
    return sha(`${payload.caseId}:${row?.assigned_to_rep_id ?? "null"}:${row?.updated_at ?? "null"}`);
  },

  reverse(inverse: CaseInverse, ctx) {
    rawDb.prepare(
      `UPDATE order_recovery_cases SET assigned_to_rep_id = ?, assigned_to_user_id = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(inverse.repId, inverse.userId, nowIso(), inverse.caseId, ctx.tenantId);
    return { summary: `Case returned to ${repName(ctx.tenantId, inverse.repId)}.` };
  },
};

// ── contact.suppression.lift ─────────────────────────────────────────────────
//
// The kind that justifies the whole layer. Somebody replied STOP; this action
// decides on their behalf that they can be contacted again. Its floor is
// `approval` in the catalogue, so no organization can configure it down to one
// click, and it is declared irreversible, so nobody is offered an undo that
// would not actually undo anything: re-adding the row restores the block but
// cannot recall a message sent while it was down.

interface LiftPayload { suppressionId: number; reason: string }

const suppressionLift: GuardedActionExecutor<LiftPayload> = {
  kind: "contact.suppression.lift",

  parse(raw: any): LiftPayload {
    const reason = String(raw?.reason ?? "").trim();
    // A required, substantive reason. This is the row an auditor reads first,
    // and "test" tells them nothing about why a person's STOP was overridden.
    if (reason.length < 10) {
      throw new GuardedActionError(400, "Give a reason of at least 10 characters for lifting this block.", "bad_payload");
    }
    return { suppressionId: requireInt(raw?.suppressionId, "suppressionId"), reason: reason.slice(0, 500) };
  },

  magnitude() { return 1; },

  label(payload, ctx) {
    const row = rawDb.prepare(
      `SELECT channel, destination_masked FROM customer_contact_suppressions WHERE id = ? AND tenant_id = ?`,
    ).get(payload.suppressionId, ctx.tenantId) as { channel: string; destination_masked: string | null } | undefined;
    return row ? `${row.channel} block on ${row.destination_masked ?? "a contact"}` : `suppression ${payload.suppressionId}`;
  },

  preflight(payload, ctx) {
    const row = rawDb.prepare(
      `SELECT lifted_at FROM customer_contact_suppressions WHERE id = ? AND tenant_id = ?`,
    ).get(payload.suppressionId, ctx.tenantId) as { lifted_at: string | null } | undefined;
    if (!row) throw new GuardedActionError(404, "That suppression is not in this organization.", "not_found");
    if (row.lifted_at) throw new GuardedActionError(409, "That block has already been lifted.", "already_lifted");
  },

  execute(payload, ctx): ExecutorResult {
    rawDb.prepare(
      `UPDATE customer_contact_suppressions
          SET lifted_at = ?, lifted_by_user_id = ?, lift_reason = ?
        WHERE id = ? AND tenant_id = ? AND lifted_at IS NULL`,
    ).run(nowIso(), ctx.userId, payload.reason, payload.suppressionId, ctx.tenantId);
    // No inverse, and that is the honest answer rather than an omission. See
    // the section header.
    return { summary: "Contact block lifted.", inverse: null };
  },

  fingerprint(payload, ctx) {
    const row = rawDb.prepare(
      `SELECT lifted_at FROM customer_contact_suppressions WHERE id = ? AND tenant_id = ?`,
    ).get(payload.suppressionId, ctx.tenantId) as { lifted_at: string | null } | undefined;
    return sha(`${payload.suppressionId}:${row?.lifted_at ?? "null"}`);
  },

  reverse() {
    // Unreachable: the catalogue marks this kind irreversible, so undoAvailability
    // refuses before the engine ever reaches an executor. Present so the
    // interface is total, and loud if that ever stops being true.
    throw new GuardedActionError(409, "Lifting a contact block cannot be undone.", "irreversible");
  },
};

// ── Registration ─────────────────────────────────────────────────────────────

let registered = false;

/** Idempotent. Called from route registration so a test that builds the app
 *  twice does not end up with a half-populated registry. */
export function registerGuardedActionExecutors(): void {
  if (registered) return;
  registerExecutor(leadReassign);
  registerExecutor(leadBulkAssign);
  registerExecutor(recoveryCaseAssign);
  registerExecutor(suppressionLift);
  registered = true;
}
