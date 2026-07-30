// ── Ready-to-Call store ──────────────────────────────────────────────────────
// Self-contained: the callable queue, an advisory TTL soft-lock so two reps
// don't unknowingly dial the same lead, and idempotent phone-disposition writes.
// Built on the leads table + a dedicated call_log — NOT the knock/commission
// path, so a phone "Sold" never mints a field commission sale.
import { rawDb } from "./db";
import { callOutcomeMeta } from "@shared/readyToCall";

const LOCK_TTL_SECONDS = 120;
const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export interface QueueLead {
  id: number; address: string; city: string; state: string; zip: string;
  contactName: string | null; contactPhone: string | null;
  ownerName: string | null; ownerPhone: string | null;
  leadStatus: string; lastCallOutcome: string | null; lastCallAt: string | null;
  lockedByUserId: number | null; lockedByName: string | null; lockedUntil: string | null;
}

// The queue: this tenant's leads that (a) have a usable phone, (b) are not
// Do-Not-Call, (c) haven't reached a terminal call outcome. Never-called leads
// first, then oldest-touched. Scope walls a rep/team_lead to their own leads;
// undefined scope (admin/manager) is the whole tenant. A null tenant is refused
// by the caller — it must never reach here (would cross-read tenants).
export function getReadyToCallQueue(input: { tenantId: number; scope: number[] | undefined; limit?: number }): QueueLead[] {
  const { tenantId, scope } = input;
  const limit = Math.min(500, Math.max(1, input.limit ?? 200));
  const params: any[] = [tenantId];
  let scopeSql = "";
  if (scope !== undefined) {
    if (scope.length === 0) return []; // fail-closed: empty scope sees nothing
    scopeSql = ` AND l.assigned_rep_id IN (${scope.map(() => "?").join(",")})`;
    params.push(...scope);
  }
  const rows = rawDb.prepare(
    `SELECT l.id, l.address, l.city, l.state, l.zip,
            l.contact_name AS contactName, l.contact_phone AS contactPhone,
            NULL AS ownerName, NULL AS ownerPhone,
            l.lead_status AS leadStatus, l.last_call_outcome AS lastCallOutcome, l.last_call_at AS lastCallAt,
            lk.owner_user_id AS lockedByUserId, lk.owner_name AS lockedByName, lk.expires_at AS lockedUntil
       FROM leads l
       LEFT JOIN calling_lead_locks lk
         ON lk.tenant_id = l.tenant_id AND lk.lead_id = l.id AND lk.expires_at > ?
      WHERE l.tenant_id = ?
        AND COALESCE(l.do_not_call, 0) = 0
        AND nullif(trim(l.contact_phone), '') IS NOT NULL
        AND COALESCE(l.last_call_outcome, '') NOT IN ('sold','already_has_service','wrong_number','do_not_call')
        ${scopeSql}
      ORDER BY (l.last_call_at IS NOT NULL), l.last_call_at ASC, l.id ASC
      LIMIT ?`,
  ).all(iso(), tenantId, ...params.slice(1), limit) as any[];
  return rows as QueueLead[];
}

export interface ClaimResult {
  ok: boolean;
  holder: { userId: number; name: string | null; until: string } | null;
}

// Acquire the advisory soft-lock. IMMEDIATE tx: drop an expired lease for this
// lead, then INSERT OR IGNORE — .changes === 1 is the win. A loser gets the
// current holder so the card can say "Rhea is calling this now". Re-acquiring
// your OWN live lock succeeds (refreshes it) — idempotent for double-taps.
export function claimLead(input: { tenantId: number; leadId: number; userId: number; userName?: string | null }): ClaimResult {
  const { tenantId, leadId, userId } = input;
  const tx = rawDb.transaction((): ClaimResult => {
    rawDb.prepare(`DELETE FROM calling_lead_locks WHERE tenant_id = ? AND lead_id = ? AND expires_at <= ?`)
      .run(tenantId, leadId, iso());
    const existing = rawDb.prepare(
      `SELECT owner_user_id AS userId, owner_name AS name, expires_at AS until FROM calling_lead_locks WHERE tenant_id = ? AND lead_id = ?`,
    ).get(tenantId, leadId) as any;
    if (existing) {
      if (Number(existing.userId) === userId) {
        rawDb.prepare(`UPDATE calling_lead_locks SET expires_at = ?, version = version + 1 WHERE tenant_id = ? AND lead_id = ?`)
          .run(iso(LOCK_TTL_SECONDS * 1000), tenantId, leadId);
        return { ok: true, holder: { userId, name: input.userName ?? existing.name ?? null, until: iso(LOCK_TTL_SECONDS * 1000) } };
      }
      return { ok: false, holder: { userId: Number(existing.userId), name: existing.name ?? null, until: existing.until } };
    }
    rawDb.prepare(
      `INSERT INTO calling_lead_locks (tenant_id, lead_id, owner_user_id, owner_name, expires_at, created_at, version)
       VALUES (?,?,?,?,?,?,1)`,
    ).run(tenantId, leadId, userId, input.userName ?? null, iso(LOCK_TTL_SECONDS * 1000), iso());
    return { ok: true, holder: { userId, name: input.userName ?? null, until: iso(LOCK_TTL_SECONDS * 1000) } };
  });
  return tx.immediate();
}

/** Heartbeat: extend your own lease. No-op if you no longer hold it. */
export function refreshLeadClaim(input: { tenantId: number; leadId: number; userId: number }): boolean {
  const r = rawDb.prepare(
    `UPDATE calling_lead_locks SET expires_at = ?, version = version + 1
      WHERE tenant_id = ? AND lead_id = ? AND owner_user_id = ? AND expires_at > ?`,
  ).run(iso(LOCK_TTL_SECONDS * 1000), input.tenantId, input.leadId, input.userId, iso());
  return r.changes === 1;
}

/** Release your own lock (leaving the card / saving an outcome). */
export function releaseLeadClaim(input: { tenantId: number; leadId: number; userId: number }): void {
  rawDb.prepare(`DELETE FROM calling_lead_locks WHERE tenant_id = ? AND lead_id = ? AND owner_user_id = ?`)
    .run(input.tenantId, input.leadId, input.userId);
}

/** Periodic sweep — a rep who closed the tab frees their leads automatically. */
export function reapExpiredLeadLocks(): number {
  return rawDb.prepare(`DELETE FROM calling_lead_locks WHERE expires_at <= ?`).run(iso()).changes;
}

export interface OutcomeResult { saved: boolean; duplicate: boolean; leadStatus: string; terminal: boolean; }

// Record a phone disposition. Idempotent on client_id (a replay returns the
// prior write, never a second row). Advances lead_status, flips do_not_call for
// a DNC, and stamps last_call_* so the queue reorders/drops the lead. All in one
// IMMEDIATE tx so a lead is never half-updated.
export function recordCallOutcome(input: {
  tenantId: number; leadId: number; repId: number | null; userId: number | null;
  outcome: string; notes?: string | null; callbackDate?: string | null; callbackTime?: string | null;
  dialedE164?: string | null; clientId?: string | null;
}): OutcomeResult {
  const meta = callOutcomeMeta(input.outcome);
  if (!meta) throw new Error("UNKNOWN_OUTCOME");
  if (meta.requiresCallback && !(input.callbackDate && input.callbackTime)) throw new Error("CALLBACK_REQUIRED");

  const tx = rawDb.transaction((): OutcomeResult => {
    const lead = rawDb.prepare(`SELECT lead_status FROM leads WHERE id = ? AND tenant_id = ?`).get(input.leadId, input.tenantId) as any;
    if (!lead) throw new Error("LEAD_NOT_FOUND");

    if (input.clientId) {
      const dup = rawDb.prepare(`SELECT id, outcome FROM call_log WHERE tenant_id = ? AND client_id = ?`).get(input.tenantId, input.clientId) as any;
      if (dup) return { saved: false, duplicate: true, leadStatus: lead.lead_status, terminal: !!callOutcomeMeta(dup.outcome)?.terminal };
    }
    const now = iso();
    rawDb.prepare(
      `INSERT INTO call_log (tenant_id, lead_id, rep_id, user_id, outcome, notes, callback_date, callback_time, dialed_e164, client_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(input.tenantId, input.leadId, input.repId, input.userId, meta.code, input.notes ?? null,
      input.callbackDate ?? null, input.callbackTime ?? null, input.dialedE164 ?? null, input.clientId ?? null, now);

    const sets = ["last_call_outcome = ?", "last_call_at = ?", "updated_at = ?"];
    const params: any[] = [meta.code, now, now];
    if (meta.leadStatus) { sets.push("lead_status = ?"); params.push(meta.leadStatus); }
    if (meta.setsDoNotCall) sets.push("do_not_call = 1");
    if (meta.invalidatesPhone) sets.push("contact_phone = NULL");
    params.push(input.leadId, input.tenantId);
    rawDb.prepare(`UPDATE leads SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...params);

    const after = rawDb.prepare(`SELECT lead_status FROM leads WHERE id = ? AND tenant_id = ?`).get(input.leadId, input.tenantId) as any;
    return { saved: true, duplicate: false, leadStatus: after.lead_status, terminal: meta.terminal };
  });
  return tx.immediate();
}
