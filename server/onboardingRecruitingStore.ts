import crypto from "node:crypto";
import { rawDb } from "./db";
import { createInviteToken, hashInviteToken, verifyInviteToken } from "./onboardingInviteToken";
import { normalizeCommissionTerms } from "@shared/commissionTerms";
import type { CommissionTier } from "@shared/commissionTiers";
import { MEMBER_ROLES, type MemberRole } from "@shared/teamHierarchy";

export type RecruitingInviteStatus =
  | "creating" | "invited" | "failed" | "under_review" | "approved"
  | "agreements_issued" | "partially_signed" | "active" | "rejected" | "expired";

export interface RecruitingInvite {
  id: number;
  recordId: string;
  tenantId: number;
  candidateName: string;
  candidateEmail: string;
  status: RecruitingInviteStatus;
  invitedBy: number | null;
  emailId: string | null;
  sentAt: string | null;
  expiresAt: string | null;
  applicationId: number | null;
  appliedAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  loginEmailId: string | null;
  loginSentAt: string | null;
  agreementsIssuedAt: string | null;
  activatedAt: string | null;
  // Comp terms chosen at invite time — seed the rep's plan + reserve at approval.
  commissionStructure: "FLAT" | "TIERED" | null;
  flatRateCents: number | null;
  reservePercent: number | null;
  reserveCapCents: number | null;
  /** TIERED only: the ladder the manager picked when sending the invite. This
   *  is what the rep's agreement states and what approval assigns them to. NULL
   *  means none was proposed — the org/house ladder is inherited instead. */
  commissionTiers: CommissionTier[] | null;
  /** Role + upline chosen at invite time — ride invite → approval like the comp
   *  terms above. NULL role = legacy invite = 'rep'; NULL supervisor =
   *  top-level. Hierarchy validation lives in the route; this is persistence. */
  invitedRole: MemberRole | null;
  invitedSupervisorId: number | null;
  deliveryAttempts: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Parse the stored ladder defensively: mapInvite runs over every row of
 *  listRecruitingInvites, and one unreadable blob must not 500 a manager's
 *  invitation list. Garbage reads as "no ladder proposed", which inherits. */
function parseTiers(raw: unknown): CommissionTier[] | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? (parsed as CommissionTier[]) : null;
  } catch { return null; }
}

function mapInvite(row: any): RecruitingInvite {
  return {
    id: Number(row.id), recordId: String(row.record_id), tenantId: Number(row.tenant_id),
    candidateName: String(row.candidate_name), candidateEmail: String(row.candidate_email),
    status: row.status === "sent" ? "invited" : row.status as RecruitingInviteStatus,
    invitedBy: row.invited_by == null ? null : Number(row.invited_by), emailId: row.email_id ?? null,
    sentAt: row.sent_at ?? null, expiresAt: row.expires_at ?? null,
    applicationId: row.application_id == null ? null : Number(row.application_id),
    appliedAt: row.applied_at ?? null, approvedAt: row.approved_at ?? null,
    rejectedAt: row.rejected_at ?? null, loginEmailId: row.login_email_id ?? null,
    loginSentAt: row.login_sent_at ?? null, agreementsIssuedAt: row.agreements_issued_at ?? null,
    activatedAt: row.activated_at ?? null,
    commissionStructure: row.commission_structure === "FLAT" || row.commission_structure === "TIERED" ? row.commission_structure : null,
    flatRateCents: row.flat_rate_cents == null ? null : Number(row.flat_rate_cents),
    reservePercent: row.reserve_percent == null ? null : Number(row.reserve_percent),
    reserveCapCents: row.reserve_cap_cents == null ? null : Number(row.reserve_cap_cents),
    commissionTiers: parseTiers(row.commission_tiers_json),
    // Fail closed: a role string outside MEMBER_ROLES reads as "none chosen",
    // which downstream treats as the legacy default ('rep').
    invitedRole: MEMBER_ROLES.includes(row.invited_role) ? (row.invited_role as MemberRole) : null,
    invitedSupervisorId: row.invited_supervisor_id == null ? null : Number(row.invited_supervisor_id),
    deliveryAttempts: Number(row.delivery_attempts ?? 0),
    failureReason: row.failure_reason ?? null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function expiryFrom(now = new Date()): string {
  return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
}

function persistToken(row: RecruitingInvite, expiresAt: string): string {
  const token = createInviteToken({ recordId: row.recordId, tenantId: row.tenantId, email: row.candidateEmail, expiresAt });
  rawDb.prepare(
    "UPDATE onboarding_recruiting_invites SET token_sha256 = ?, expires_at = ?, updated_at = ? WHERE id = ?",
  ).run(hashInviteToken(token), expiresAt, new Date().toISOString(), row.id);
  return token;
}

/** Structure + the money behind it, as the invite row will store them. */
export interface InviteCompTerms {
  structure: "FLAT" | "TIERED" | null;
  flatRateCents: number | null;
  tiers: CommissionTier[] | null;
}

/**
 * THE WRITE CONTRACT for an invite's comp terms.
 *
 * An invite used to be able to claim TIERED and carry nothing behind it, and
 * every reader downstream substituted the house ladder without complaining —
 * so the manager saw "Tiered", the rep signed the house bands, and the pay
 * engine assigned the house plan version. A half-configured invite is the bug;
 * it is refused here rather than stored and discovered at issuance, in front of
 * the candidate.
 *
 * Ladder correctness is NOT re-implemented: normalizeCommissionTerms already
 * owns it (via validateTiers), and it is the same verdict the agreements path
 * uses — so terms that cannot be invited cannot be contracted either. The one
 * thing it will not do is reject an EMPTY tiered ladder (it silently swaps in
 * DEFAULT_RETRO_TIERS and returns ok), which is precisely this bug, so that
 * case is checked explicitly first.
 */
export function normalizeInviteCompTerms(input: {
  commissionStructure?: "FLAT" | "TIERED" | null;
  flatRateCents?: number | null;
  tiers?: CommissionTier[] | null;
}): { ok: boolean; errors: string[]; terms: InviteCompTerms } {
  const structure = input.commissionStructure === "FLAT" || input.commissionStructure === "TIERED"
    ? input.commissionStructure : null;
  const proposed = Array.isArray(input.tiers) && input.tiers.length ? input.tiers : null;

  // No structure chosen = nothing proposed, inherit everything at approval.
  if (!structure) return { ok: true, errors: [], terms: { structure: null, flatRateCents: null, tiers: null } };

  if (structure === "TIERED" && !proposed) {
    return {
      ok: false,
      errors: ["A tiered invitation needs a tier ladder — pick the bands the candidate will be paid on."],
      terms: { structure, flatRateCents: null, tiers: null },
    };
  }

  // Reserve values are deliberately NOT taken from this check: on an invite they
  // may be null, meaning "inherit", and normalizeCommissionTerms would resolve
  // that null into the house 10%/$2,500 and quietly turn an inherited reserve
  // into an explicit one. Defaults go in only so they cannot raise errors.
  const check = normalizeCommissionTerms({
    structure,
    flatRateCents: input.flatRateCents ?? null,
    tiers: proposed ?? [],
    reservePercent: 0,
    reserveCapCents: 0,
  });
  if (!check.ok) return { ok: false, errors: check.errors, terms: { structure, flatRateCents: null, tiers: null } };

  return {
    ok: true,
    errors: [],
    terms: {
      structure,
      // Only a FLAT plan carries a per-rep rate; only a TIERED plan carries a
      // ladder. Storing both would leave a second, stale set of numbers on the
      // row for a later reader to pick the wrong one out of.
      flatRateCents: structure === "FLAT" ? check.normalized.flatRateCents : null,
      tiers: structure === "TIERED" ? check.normalized.tiers : null,
    },
  };
}

export function createRecruitingInvite(input: {
  tenantId: number; candidateName: string; candidateEmail: string; invitedBy: number | null;
  commissionStructure?: "FLAT" | "TIERED" | null;
  flatRateCents?: number | null;
  tiers?: CommissionTier[] | null;
  reservePercent?: number | null;
  reserveCapCents?: number | null;
  // Validated in the route (canHireRole + tenant roster) — stored as given.
  invitedRole?: MemberRole | null;
  invitedSupervisorId?: number | null;
}): RecruitingInvite {
  const candidateEmail = input.candidateEmail.trim().toLowerCase();
  const open = rawDb.prepare(
    `SELECT id FROM onboarding_recruiting_invites
      WHERE tenant_id = ? AND candidate_email = ? AND application_id IS NULL
        AND status IN ('creating','invited','failed') LIMIT 1`,
  ).get(input.tenantId, candidateEmail);
  if (open) throw new Error("An open invitation already exists for this candidate");
  const recordId = crypto.randomUUID();
  const now = new Date().toISOString();
  // A FLAT plan carries a per-rep rate; a TIERED plan carries a ladder. Validated
  // HERE and not only at the API boundary — JSON has no CHECK constraint, so if
  // a bad ladder gets past this it sits in the row until issuance throws in
  // front of the candidate. Reserve fields ride through as given (null = inherit).
  const comp = normalizeInviteCompTerms(input);
  if (!comp.ok) throw new Error(`Commission terms are not valid: ${comp.errors.join(" ")}`);
  const { structure, flatRateCents, tiers } = comp.terms;
  const reservePercent = input.reservePercent == null ? null : Math.min(100, Math.max(0, Math.trunc(input.reservePercent)));
  const reserveCapCents = input.reserveCapCents == null ? null : Math.max(0, Math.trunc(input.reserveCapCents));
  const result = rawDb.prepare(
    `INSERT INTO onboarding_recruiting_invites
      (record_id, tenant_id, candidate_name, candidate_email, status, invited_by,
       commission_structure, flat_rate_cents, commission_tiers_json, reserve_percent, reserve_cap_cents,
       invited_role, invited_supervisor_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(recordId, input.tenantId, input.candidateName.trim(), candidateEmail, input.invitedBy,
        structure, flatRateCents, tiers ? JSON.stringify(tiers) : null, reservePercent, reserveCapCents,
        input.invitedRole ?? null, input.invitedSupervisorId ?? null, now, now);
  const row = getRecruitingInvite(Number(result.lastInsertRowid))!;
  persistToken(row, expiryFrom());
  return getRecruitingInvite(row.id)!;
}

export function getRecruitingInvite(id: number): RecruitingInvite | null {
  const row = rawDb.prepare("SELECT * FROM onboarding_recruiting_invites WHERE id = ?").get(id);
  return row ? mapInvite(row) : null;
}

export function getRecruitingInviteByApplication(applicationId: number): RecruitingInvite | null {
  const row = rawDb.prepare("SELECT * FROM onboarding_recruiting_invites WHERE application_id = ?").get(applicationId);
  return row ? mapInvite(row) : null;
}

export function secureTokenForInvite(id: number, renew = false): string {
  const row = getRecruitingInvite(id);
  if (!row) throw new Error("Invitation not found");
  const expiresAt = renew || !row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()
    ? expiryFrom() : row.expiresAt;
  return persistToken(row, expiresAt);
}

export function resolveRecruitingInviteToken(token: string, now = new Date()): RecruitingInvite | null {
  const payload = verifyInviteToken(token, now);
  if (!payload) return null;
  const row = rawDb.prepare(
    "SELECT * FROM onboarding_recruiting_invites WHERE record_id = ? AND tenant_id = ? AND token_sha256 = ?",
  ).get(payload.rid, payload.tid, hashInviteToken(token));
  if (!row) return null;
  const invite = mapInvite(row);
  if (invite.candidateEmail !== payload.email || invite.applicationId || ["rejected", "active"].includes(invite.status)) return null;
  return invite;
}

export function markRecruitingInviteSent(id: number, emailId: string): RecruitingInvite {
  const now = new Date().toISOString();
  rawDb.prepare(
    `UPDATE onboarding_recruiting_invites SET status = CASE WHEN application_id IS NULL THEN 'invited' ELSE status END,
       email_id = ?, sent_at = COALESCE(sent_at, ?), delivery_attempts = delivery_attempts + 1,
       failure_reason = NULL, updated_at = ? WHERE id = ?`,
  ).run(emailId, now, now, id);
  return getRecruitingInvite(id)!;
}

export function markRecruitingInviteFailed(id: number, reason: string): RecruitingInvite {
  const now = new Date().toISOString();
  rawDb.prepare(
    `UPDATE onboarding_recruiting_invites SET status = CASE WHEN application_id IS NULL THEN 'failed' ELSE status END,
       failure_reason = ?, delivery_attempts = delivery_attempts + 1, updated_at = ? WHERE id = ?`,
  ).run(reason.slice(0, 500), now, id);
  return getRecruitingInvite(id)!;
}

export function attachApplicationToInvite(id: number, applicationId: number): RecruitingInvite {
  const now = new Date().toISOString();
  return rawDb.transaction(() => {
    const changed = rawDb.prepare(
      `UPDATE onboarding_recruiting_invites SET application_id = ?, applied_at = ?, status = 'under_review', updated_at = ?
       WHERE id = ? AND application_id IS NULL AND status IN ('invited','failed','creating')`,
    ).run(applicationId, now, now, id);
    if (!changed.changes) throw new Error("Invitation has already been used");
    rawDb.prepare("UPDATE rep_applications SET invite_id = ?, tenant_id = ?, updated_at = ? WHERE id = ?")
      .run(id, getRecruitingInvite(id)!.tenantId, now, applicationId);
    return getRecruitingInvite(id)!;
  }).immediate();
}

function updateMilestone(id: number, sql: string, args: unknown[]): RecruitingInvite {
  rawDb.prepare(sql).run(...args, id);
  return getRecruitingInvite(id)!;
}

export function markInviteApproved(id: number): RecruitingInvite {
  const now = new Date().toISOString();
  return updateMilestone(id, `UPDATE onboarding_recruiting_invites
    SET status = CASE WHEN status IN ('agreements_issued','partially_signed','active') THEN status ELSE 'approved' END,
        approved_at = COALESCE(approved_at, ?), updated_at = ? WHERE id = ?`, [now, now]);
}

export function markInviteRejected(id: number): RecruitingInvite {
  const now = new Date().toISOString();
  return updateMilestone(id, "UPDATE onboarding_recruiting_invites SET status = 'rejected', rejected_at = ?, updated_at = ? WHERE id = ?", [now, now]);
}

export function markInviteLoginSent(id: number, emailId: string): RecruitingInvite {
  const now = new Date().toISOString();
  return updateMilestone(id, "UPDATE onboarding_recruiting_invites SET login_email_id = ?, login_sent_at = ?, updated_at = ? WHERE id = ?", [emailId, now, now]);
}

export function markInviteAgreementsIssued(id: number): RecruitingInvite {
  const now = new Date().toISOString();
  return updateMilestone(id, `UPDATE onboarding_recruiting_invites
    SET status = CASE WHEN status IN ('partially_signed','active') THEN status ELSE 'agreements_issued' END,
        agreements_issued_at = COALESCE(agreements_issued_at, ?), updated_at = ? WHERE id = ?`, [now, now]);
}

export function markInvitePartiallySigned(id: number): RecruitingInvite {
  const now = new Date().toISOString();
  return updateMilestone(id, "UPDATE onboarding_recruiting_invites SET status = 'partially_signed', updated_at = ? WHERE id = ? AND status != 'active'", [now]);
}

export function markInviteActive(id: number): RecruitingInvite {
  const now = new Date().toISOString();
  return updateMilestone(id, "UPDATE onboarding_recruiting_invites SET status = 'active', activated_at = COALESCE(activated_at, ?), updated_at = ? WHERE id = ?", [now, now]);
}

export function listRecruitingInvites(tenantId: number, limit = 100): RecruitingInvite[] {
  const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit)));
  return rawDb.prepare(
    "SELECT * FROM onboarding_recruiting_invites WHERE tenant_id = ? ORDER BY id DESC LIMIT ?",
  ).all(tenantId, safeLimit).map(mapInvite);
}
