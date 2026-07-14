import { ONBOARDING_DOCUMENT_META, ONBOARDING_DOCUMENT_TYPES, type OnboardingDocumentType } from "../shared/onboardingDocuments";
import { rawDb } from "./db";
import { listRepDocuments } from "./onboardingDocumentStore";
import {
  getRecruitingInviteByApplication,
  listRecruitingInvites,
  markInviteActive,
  markInvitePartiallySigned,
  secureTokenForInvite,
  type RecruitingInvite,
} from "./onboardingRecruitingStore";

export type OnboardingPipelineStage =
  | "invited" | "under_review" | "approved" | "login_code_sent"
  | "agreements_issued" | "partially_signed" | "fully_signed" | "active"
  | "rejected" | "failed";

export interface OnboardingPipelineRecord {
  key: string;
  inviteId: number | null;
  applicationId: number | null;
  tenantId: number;
  candidateName: string;
  candidateEmail: string;
  stage: OnboardingPipelineStage;
  progress: { completed: number; total: number };
  milestones: {
    invited: boolean; applied: boolean; approved: boolean; loginCodeSent: boolean;
    agreementsIssued: boolean; signedCount: number; fullySigned: boolean; active: boolean;
  };
  invite: null | {
    status: string; sentAt: string | null; expiresAt: string | null; deliveryAttempts: number;
    failureReason: string | null; secureUrl: string;
  };
  application: null | {
    status: string; phone: string; city: string; state: string; zip: string;
    preferredCarriers: string; hasSalesExperience: boolean; salesExperienceDetails: string | null;
    referralSource: string | null; headshotPath: string | null; licensePath: string | null;
    reviewNotes: string | null; createdAt: string;
  };
  account: null | { userId: number; repId: number | null; active: boolean };
  documents: Array<{
    type: OnboardingDocumentType; label: string; required: boolean;
    status: string; envelopeId: number | null; sentAt: string | null; completedAt: string | null;
  }>;
  timeline: Array<{ label: string; at: string; done: boolean }>;
}

function applicationById(id: number | null): any | null {
  return id == null ? null : rawDb.prepare("SELECT * FROM rep_applications WHERE id = ?").get(id) ?? null;
}

function userAndRep(application: any | null): { user: any | null; rep: any | null } {
  if (!application?.user_id) return { user: null, rep: null };
  const user: any = rawDb.prepare("SELECT * FROM users WHERE id = ?").get(application.user_id) ?? null;
  const rep: any = user?.team_member_id
    ? rawDb.prepare("SELECT * FROM team_members WHERE id = ?").get(user.team_member_id) ?? null
    : null;
  return { user, rep };
}

function deriveRecord(invite: RecruitingInvite | null, application: any | null, origin: string, tenantId: number): OnboardingPipelineRecord {
  const { user, rep } = userAndRep(application);
  const history = rep ? listRepDocuments(tenantId, Number(rep.id)) : [];
  const latestByType = new Map<string, typeof history[number]>();
  for (const document of history) if (!latestByType.has(document.documentType)) latestByType.set(document.documentType, document);
  const documents = ONBOARDING_DOCUMENT_TYPES.map(type => {
    const envelope = latestByType.get(type);
    return {
      type, label: ONBOARDING_DOCUMENT_META[type].label, required: ONBOARDING_DOCUMENT_META[type].required,
      status: envelope?.status ?? "not_issued", envelopeId: envelope?.id ?? null,
      sentAt: envelope?.sentAt ?? null, completedAt: envelope?.completedAt ?? null,
    };
  });
  const signedCount = documents.filter(document => document.status === "completed").length;
  const agreementsIssued = documents.every(document => document.status !== "not_issued" && document.status !== "failed");
  const fullySigned = signedCount === ONBOARDING_DOCUMENT_TYPES.length;
  const active = Boolean(rep?.active) && fullySigned;
  const applied = Boolean(application);
  const approved = application?.status === "approved";
  const loginCodeSent = Boolean(invite?.loginSentAt);
  const rejected = application?.status === "rejected" || invite?.status === "rejected";

  let stage: OnboardingPipelineStage = "invited";
  if (invite?.status === "failed" && !applied) stage = "failed";
  if (applied) stage = "under_review";
  if (approved) stage = "approved";
  if (approved && loginCodeSent) stage = "login_code_sent";
  if (agreementsIssued) stage = "agreements_issued";
  if (signedCount > 0) stage = "partially_signed";
  if (fullySigned) stage = "fully_signed";
  if (active) stage = "active";
  if (rejected) stage = "rejected";

  const completedMilestones = [Boolean(invite?.sentAt), applied, approved, loginCodeSent, agreementsIssued, fullySigned, active].filter(Boolean).length;
  const tenantRow = rawDb.prepare("SELECT slug FROM tenants WHERE id = ?").get(tenantId) as { slug?: string } | undefined;
  const secureUrl = invite && !application
    ? `${origin}/join/${encodeURIComponent(tenantRow?.slug ?? "")}?invite=${encodeURIComponent(secureTokenForInvite(invite.id))}`
    : "";
  const timeline = [
    { label: "Invitation sent", at: invite?.sentAt ?? invite?.createdAt ?? "", done: Boolean(invite?.sentAt) },
    { label: "Application received", at: invite?.appliedAt ?? application?.created_at ?? "", done: applied },
    { label: rejected ? "Application rejected" : "Application approved", at: invite?.rejectedAt ?? invite?.approvedAt ?? application?.updated_at ?? "", done: rejected || approved },
    { label: "Login code sent", at: invite?.loginSentAt ?? "", done: loginCodeSent },
    { label: "Agreements issued", at: invite?.agreementsIssuedAt ?? "", done: agreementsIssued },
    { label: "All agreements signed", at: documents.map(document => document.completedAt).filter(Boolean).sort().at(-1) ?? "", done: fullySigned },
    { label: "Rep activated", at: invite?.activatedAt ?? "", done: active },
  ];

  return {
    key: invite ? `invite-${invite.id}` : `application-${application.id}`,
    inviteId: invite?.id ?? null,
    applicationId: application?.id ?? null,
    tenantId,
    candidateName: invite?.candidateName ?? application?.full_name ?? "Applicant",
    candidateEmail: invite?.candidateEmail ?? application?.email ?? "",
    stage,
    progress: { completed: completedMilestones, total: 7 },
    milestones: { invited: Boolean(invite?.sentAt), applied, approved, loginCodeSent, agreementsIssued, signedCount, fullySigned, active },
    invite: invite ? {
      status: invite.status, sentAt: invite.sentAt, expiresAt: invite.expiresAt,
      deliveryAttempts: invite.deliveryAttempts, failureReason: invite.failureReason, secureUrl,
    } : null,
    application: application ? {
      status: application.status, phone: application.phone, city: application.city, state: application.state, zip: application.zip,
      preferredCarriers: application.preferred_carriers, hasSalesExperience: Boolean(application.has_sales_experience),
      salesExperienceDetails: application.sales_experience_details ?? null, referralSource: application.referral_source ?? null,
      headshotPath: application.headshot_path ?? null, licensePath: application.license_path ?? null,
      reviewNotes: application.review_notes ?? null, createdAt: application.created_at,
    } : null,
    account: user ? { userId: Number(user.id), repId: rep?.id == null ? null : Number(rep.id), active } : null,
    documents,
    timeline,
  };
}

export function buildOnboardingPipeline(tenantId: number, origin: string): OnboardingPipelineRecord[] {
  const invites = listRecruitingInvites(tenantId, 250);
  const records = invites.map(invite => deriveRecord(invite, applicationById(invite.applicationId), origin, tenantId));
  const linkedApplications = new Set(invites.map(invite => invite.applicationId).filter((id): id is number => id != null));
  const unlinked: any[] = rawDb.prepare(
    "SELECT * FROM rep_applications WHERE tenant_id = ? ORDER BY id DESC LIMIT 250",
  ).all(tenantId).filter((application: any) => !linkedApplications.has(Number(application.id)));
  records.push(...unlinked.map(application => deriveRecord(null, application, origin, tenantId)));
  return records.sort((a, b) => {
    const latest = (record: OnboardingPipelineRecord) => record.timeline
      .filter(item => item.done && item.at)
      .map(item => item.at)
      .sort()
      .at(-1) ?? "";
    const aAt = latest(a);
    const bAt = latest(b);
    return bAt.localeCompare(aAt);
  });
}

export function syncRepActivation(input: { tenantId: number; repId: number }): { signedCount: number; activated: boolean; inviteId: number | null } {
  const rows: Array<{ document_type: string }> = rawDb.prepare(
    `SELECT DISTINCT document_type FROM onboarding_signing_documents
      WHERE tenant_id = ? AND rep_id = ? AND status = 'completed'`,
  ).all(input.tenantId, input.repId) as Array<{ document_type: string }>;
  const signedCount = ONBOARDING_DOCUMENT_TYPES.filter(type => rows.some(row => row.document_type === type)).length;
  const application: any = rawDb.prepare(
    `SELECT a.* FROM rep_applications a JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ? AND u.team_member_id = ? ORDER BY a.id DESC LIMIT 1`,
  ).get(input.tenantId, input.repId);
  const invite = application ? getRecruitingInviteByApplication(Number(application.id)) : null;
  if (invite && signedCount > 0 && signedCount < ONBOARDING_DOCUMENT_TYPES.length) markInvitePartiallySigned(invite.id);
  if (signedCount !== ONBOARDING_DOCUMENT_TYPES.length) return { signedCount, activated: false, inviteId: invite?.id ?? null };
  rawDb.prepare("UPDATE team_members SET active = 1 WHERE id = ? AND tenant_id = ?").run(input.repId, input.tenantId);
  if (invite) markInviteActive(invite.id);
  return { signedCount, activated: true, inviteId: invite?.id ?? null };
}
