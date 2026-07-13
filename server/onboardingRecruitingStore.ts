import crypto from "node:crypto";
import { rawDb } from "./db";

export type RecruitingInviteStatus = "creating" | "sent" | "failed";

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
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapInvite(row: any): RecruitingInvite {
  return {
    id: Number(row.id),
    recordId: String(row.record_id),
    tenantId: Number(row.tenant_id),
    candidateName: String(row.candidate_name),
    candidateEmail: String(row.candidate_email),
    status: row.status as RecruitingInviteStatus,
    invitedBy: row.invited_by == null ? null : Number(row.invited_by),
    emailId: row.email_id ?? null,
    sentAt: row.sent_at ?? null,
    failureReason: row.failure_reason ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function createRecruitingInvite(input: {
  tenantId: number;
  candidateName: string;
  candidateEmail: string;
  invitedBy: number | null;
}): RecruitingInvite {
  const recordId = crypto.randomUUID();
  const now = new Date().toISOString();
  const result = rawDb.prepare(
    `INSERT INTO onboarding_recruiting_invites
      (record_id, tenant_id, candidate_name, candidate_email, status, invited_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'creating', ?, ?, ?)`,
  ).run(
    recordId,
    input.tenantId,
    input.candidateName.trim(),
    input.candidateEmail.trim().toLowerCase(),
    input.invitedBy,
    now,
    now,
  );
  return getRecruitingInvite(Number(result.lastInsertRowid))!;
}

export function getRecruitingInvite(id: number): RecruitingInvite | null {
  const row = rawDb.prepare("SELECT * FROM onboarding_recruiting_invites WHERE id = ?").get(id);
  return row ? mapInvite(row) : null;
}

export function markRecruitingInviteSent(id: number, emailId: string): RecruitingInvite {
  const now = new Date().toISOString();
  rawDb.prepare(
    `UPDATE onboarding_recruiting_invites
        SET status = 'sent', email_id = ?, sent_at = ?, failure_reason = NULL, updated_at = ?
      WHERE id = ? AND status = 'creating'`,
  ).run(emailId, now, now, id);
  return getRecruitingInvite(id)!;
}

export function markRecruitingInviteFailed(id: number, reason: string): RecruitingInvite {
  const now = new Date().toISOString();
  rawDb.prepare(
    `UPDATE onboarding_recruiting_invites
        SET status = 'failed', failure_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'creating'`,
  ).run(reason.slice(0, 500), now, id);
  return getRecruitingInvite(id)!;
}

export function listRecruitingInvites(tenantId: number, limit = 20): RecruitingInvite[] {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  return rawDb.prepare(
    `SELECT * FROM onboarding_recruiting_invites
      WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`,
  ).all(tenantId, safeLimit).map(mapInvite);
}
