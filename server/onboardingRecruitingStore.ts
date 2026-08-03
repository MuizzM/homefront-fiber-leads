import crypto from "node:crypto";
import { rawDb } from "./db";
import { createInviteToken, hashInviteToken, verifyInviteToken } from "./onboardingInviteToken";

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
  deliveryAttempts: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
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

export function createRecruitingInvite(input: {
  tenantId: number; candidateName: string; candidateEmail: string; invitedBy: number | null;
  commissionStructure?: "FLAT" | "TIERED" | null;
  flatRateCents?: number | null;
  reservePercent?: number | null;
  reserveCapCents?: number | null;
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
  // Only persist a FLAT rate when the structure is FLAT (a TIERED plan uses the
  // tenant's ladder, not a per-rep rate). Reserve fields ride through as given.
  const structure = input.commissionStructure === "FLAT" || input.commissionStructure === "TIERED" ? input.commissionStructure : null;
  const flatRateCents = structure === "FLAT" && input.flatRateCents != null ? Math.max(0, Math.trunc(input.flatRateCents)) : null;
  const reservePercent = input.reservePercent == null ? null : Math.min(100, Math.max(0, Math.trunc(input.reservePercent)));
  const reserveCapCents = input.reserveCapCents == null ? null : Math.max(0, Math.trunc(input.reserveCapCents));
  const result = rawDb.prepare(
    `INSERT INTO onboarding_recruiting_invites
      (record_id, tenant_id, candidate_name, candidate_email, status, invited_by,
       commission_structure, flat_rate_cents, reserve_percent, reserve_cap_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(recordId, input.tenantId, input.candidateName.trim(), candidateEmail, input.invitedBy,
        structure, flatRateCents, reservePercent, reserveCapCents, now, now);
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
