import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "../shared/capabilities";
import { can } from "../shared/capabilities";
import {
  ELECTRONIC_CONSENT_DISCLOSURE,
  ELECTRONIC_CONSENT_VERSION,
  ONBOARDING_DOCUMENT_META,
  ONBOARDING_DOCUMENT_TYPES,
  canOpenSigning,
  signerNameMatches,
  type OnboardingDocumentType,
} from "../shared/onboardingDocuments";
import { storage } from "./storage";
import { AGREEMENT_VERSION, buildAgreementSnapshot } from "./onboardingAgreementTemplates";
import { renderSignedAgreementPdf } from "./onboardingPdf";
import {
  completeSigning,
  declineSigning,
  getCompletedPdf,
  getSigningDocument,
  listRepDocuments,
  markCompletionEmail,
  markDocumentViewed,
  markDocumentsFailed,
  markDocumentsSent,
  reserveSigningDocument,
  toPublicRecord,
} from "./onboardingDocumentStore";
import { resendConfigured, sendResendEmail } from "./resendMail";
import { escapeHtml } from "./mail";
import { inviteResolveLimiter, recruitingInviteLimiter } from "./limiters";
import {
  createRecruitingInvite,
  getRecruitingInvite,
  listRecruitingInvites,
  markInviteAgreementsIssued,
  markInviteLoginSent,
  markRecruitingInviteFailed,
  markRecruitingInviteSent,
  resolveRecruitingInviteToken,
  secureTokenForInvite,
} from "./onboardingRecruitingStore";
import { buildOnboardingPipeline, syncRepActivation } from "./onboardingPipeline";

interface Deps {
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  requireCapability: (cap: Capability) => (req: Request, res: Response, next: NextFunction) => void;
}

const repIdSchema = z.coerce.number().int().positive();
const documentIdSchema = z.coerce.number().int().positive();
const sendSchema = z.object({
  documentTypes: z.array(z.enum(ONBOARDING_DOCUMENT_TYPES)).min(1).max(ONBOARDING_DOCUMENT_TYPES.length),
}).strict();
const recruitingInviteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
}).strict();
const signSchema = z.object({
  typedName: z.string().trim().min(2).max(120),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  consentToElectronicRecords: z.literal(true),
  acknowledgeRead: z.literal(true),
  intentToSign: z.literal(true),
}).strict();
const declineSchema = z.object({ reason: z.string().trim().min(2).max(500) }).strict();

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function onboardingAppOrigin(req: Request): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("APP_ORIGIN must use HTTPS");
    return url.origin;
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.replace(/\/$/, "") : "";
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  const host = req.get("host") ?? "";
  if (process.env.NODE_ENV !== "production" && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  throw new Error("APP_ORIGIN must be configured before sending onboarding documents");
}

function publicCatalog() {
  return ONBOARDING_DOCUMENT_TYPES.map(type => ({ type, ...ONBOARDING_DOCUMENT_META[type], version: AGREEMENT_VERSION }));
}

function listPayload(tenantId: number, repId: number) {
  const records = listRepDocuments(tenantId, repId);
  const latestByType = new Map<string, typeof records[number]>();
  for (const record of records) if (!latestByType.has(record.documentType)) latestByType.set(record.documentType, record);
  const documents = publicCatalog().map(document => ({ ...document, envelope: latestByType.get(document.type) ?? null }));
  const completed = documents.filter(document => document.envelope?.status === "completed").length;
  return {
    configured: resendConfigured(),
    provider: "homefront_sign",
    emailProvider: "resend",
    documents,
    history: records,
    progress: { completed, total: documents.filter(document => document.required).length },
  };
}

function emailShell(heading: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;background:#eef1f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#12314c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border:1px solid #e3e8ee;border-radius:16px;overflow:hidden">
  <tr><td style="padding:28px 34px 12px;text-align:center"><div style="font-size:14px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#3EA394">Home Front Solutions</div><h1 style="font-size:22px;line-height:1.3;margin:14px 0 0">${heading}</h1></td></tr>
  <tr><td style="padding:12px 34px 34px;font-size:15px;line-height:1.65;color:#4a5a68">${body}</td></tr>
  </table></td></tr></table></body></html>`;
}

async function sendInvitation(input: { email: string; name: string; count: number; origin: string; recordIds: string[]; deliveryAttempt?: string }) {
  const link = `${input.origin}/#/my-documents`;
  const keyMaterial = `${input.recordIds.sort().join(",")}|${input.deliveryAttempt ?? "initial"}`;
  const key = `onboarding-invite-${sha256(keyMaterial).slice(0, 40)}`;
  return sendResendEmail({
    to: input.email,
    subject: "Your Home Front onboarding documents are ready",
    idempotencyKey: key,
    tags: [{ name: "category", value: "onboarding_invite" }],
    text: `Hi ${input.name}, ${input.count} onboarding agreement${input.count === 1 ? " is" : "s are"} ready. Sign in to review and sign: ${link}`,
    html: emailShell("Your onboarding documents are ready", `
      <p style="margin:0 0 18px">Hi ${escapeHtml(input.name)}, ${input.count} agreement${input.count === 1 ? " is" : "s are"} ready for your review and signature.</p>
      <p style="margin:0 0 20px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#3EA394;color:#fff;text-decoration:none;font-weight:700">Review and sign documents</a></p>
      <p style="margin:0;font-size:12px;color:#8a97a4">For your protection, sign in with your Home Front account. The portal records your consent and preserves the exact document you sign.</p>`),
  });
}

export async function sendOnboardingWelcome(input: {
  email: string;
  name: string;
  otp: string;
  origin: string;
}) {
  const link = `${input.origin}/#/my-documents`;
  return sendResendEmail({
    to: input.email,
    subject: "Welcome to Home Front Solutions — your sign-in code",
    idempotencyKey: `onboarding-welcome-${sha256(`${input.email.toLowerCase()}|${input.otp}`).slice(0, 48)}`,
    tags: [{ name: "category", value: "onboarding_welcome" }],
    text: `Welcome to the team, ${input.name}. Your one-time sign-in code is ${input.otp}. It expires in 10 minutes. Sign in and review your documents: ${link}`,
    html: emailShell("Welcome to the team", `
      <p style="margin:0 0 16px">Hi ${escapeHtml(input.name)}, your application has been approved.</p>
      <p style="margin:0 0 8px">Use this one-time code to sign in:</p>
      <div style="margin:0 0 18px;padding:16px;border-radius:12px;background:#eef8f6;text-align:center;font-size:32px;font-weight:800;letter-spacing:8px;color:#12314c">${escapeHtml(input.otp)}</div>
      <p style="margin:0 0 20px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#3EA394;color:#fff;text-decoration:none;font-weight:700">Sign in and review documents</a></p>
      <p style="margin:0;font-size:12px;color:#8a97a4">The code expires in 10 minutes. You can request a new code from the sign-in screen at any time.</p>`),
  });
}

export interface IssueOnboardingDocumentsResult {
  results: Array<{ documentType: string; sent?: true; resent?: true; skipped?: true; failed?: true; reason?: string; envelopeId?: number }>;
  emailId: string | null;
  createdCount: number;
}

export async function issueOnboardingDocuments(input: {
  tenantId: number;
  repId: number;
  documentTypes?: readonly OnboardingDocumentType[];
  sentBy: number | null;
  actorIp: string;
  actorUserAgent: string;
  origin: string;
  forceEmail?: boolean;
  deliveryAttempt?: string;
}): Promise<IssueOnboardingDocumentsResult> {
  if (!resendConfigured()) throw new Error("Resend email is not configured yet");
  const rep = storage.getTeamMemberById(input.repId);
  if (!rep || rep.tenantId !== input.tenantId) throw new Error("Rep not found");
  if (!rep.email) throw new Error("The rep needs an email address before documents can be sent");

  const tenant = storage.getTenantById(input.tenantId);
  const companyName = tenant?.companyName || "Home Front Solutions LLC";
  const issuedAt = new Date().toISOString();
  const results: IssueOnboardingDocumentsResult["results"] = [];
  const created: Array<{ id: number; recordId: string; documentType: OnboardingDocumentType }> = [];
  const existingActive: Array<{ id: number; recordId: string; documentType: OnboardingDocumentType }> = [];
  const requestedTypes = [...new Set(input.documentTypes ?? ONBOARDING_DOCUMENT_TYPES)];

  for (const documentType of requestedTypes) {
    const snapshot = buildAgreementSnapshot({ documentType, companyName, signerName: rep.name, signerEmail: rep.email, issuedAt });
    const reservation = reserveSigningDocument({
      tenantId: input.tenantId,
      repId: rep.id,
      documentType,
      snapshot,
      signerName: rep.name,
      signerEmail: rep.email,
      sentBy: input.sentBy,
      actorIp: input.actorIp,
      actorUserAgent: input.actorUserAgent,
    });
    if (!reservation.created) {
      if (input.forceEmail && ["sent", "delivered"].includes(reservation.row.status)) {
        existingActive.push({ id: reservation.row.id, recordId: reservation.row.recordId, documentType });
      } else {
        results.push({ documentType, skipped: true, reason: reservation.row.status === "completed" ? "The current agreement is already signed" : "An active agreement already exists", envelopeId: reservation.row.id });
      }
    } else {
      created.push({ id: reservation.row.id, recordId: reservation.row.recordId, documentType });
    }
  }

  let emailId: string | null = null;
  const notify = [...created, ...existingActive];
  if (notify.length) {
    try {
      const email = await sendInvitation({
        email: rep.email,
        name: rep.name,
        count: notify.length,
        origin: input.origin,
        recordIds: notify.map(item => item.recordId),
        deliveryAttempt: input.deliveryAttempt,
      });
      emailId = email.id;
      markDocumentsSent(created.map(item => item.id), email.id, input.sentBy);
      for (const item of created) {
        results.push({ documentType: item.documentType, sent: true, envelopeId: item.id });
        storage.logActivity(input.sentBy, "onboarding.document.sent", "onboarding_document", item.id, {
          repId: rep.id,
          documentType: item.documentType,
          signingProvider: "homefront_sign",
          emailProvider: "resend",
          emailId: email.id,
        }, input.actorIp);
      }
      for (const item of existingActive) {
        results.push({ documentType: item.documentType, resent: true, envelopeId: item.id });
        storage.logActivity(input.sentBy, "onboarding.document.resent", "onboarding_document", item.id, {
          repId: rep.id, documentType: item.documentType, signingProvider: "homefront_sign",
          emailProvider: "resend", emailId: email.id,
        }, input.actorIp);
      }
    } catch (error: any) {
      const reason = error?.message || "Resend invitation failed";
      markDocumentsFailed(created.map(item => item.id), reason, input.sentBy);
      for (const item of created) {
        results.push({ documentType: item.documentType, failed: true, reason, envelopeId: item.id });
        storage.logActivity(input.sentBy, "onboarding.document.send_failed", "onboarding_document", item.id, {
          repId: rep.id,
          documentType: item.documentType,
          emailProvider: "resend",
          reason,
        }, input.actorIp);
      }
      for (const item of existingActive) {
        results.push({ documentType: item.documentType, failed: true, reason, envelopeId: item.id });
        storage.logActivity(input.sentBy, "onboarding.document.resend_failed", "onboarding_document", item.id, {
          repId: rep.id, documentType: item.documentType, emailProvider: "resend", reason,
        }, input.actorIp);
      }
    }
  }

  return { results, emailId, createdCount: created.length };
}

async function sendRecruitingInvitation(input: { inviteId: number; origin: string; deliveryAttempt?: string }) {
  const invite = getRecruitingInvite(input.inviteId);
  if (!invite) throw new Error("Invitation not found");
  const tenant = storage.getTenantById(invite.tenantId);
  if (!tenant) throw new Error("Organization not found");
  const token = secureTokenForInvite(invite.id, !invite.expiresAt || new Date(invite.expiresAt).getTime() <= Date.now());
  const joinLink = `${input.origin}/join/${encodeURIComponent(tenant.slug)}?invite=${encodeURIComponent(token)}`;
  const delivery = await sendResendEmail({
    to: invite.candidateEmail,
    subject: "Apply to join Home Front Solutions",
    idempotencyKey: `recruiting-invite-${invite.recordId}-${input.deliveryAttempt ?? "initial"}`,
    tags: [{ name: "category", value: "recruiting_invite" }],
    text: `Hi ${invite.candidateName}, you have been invited to apply to join ${tenant.companyName}. Complete your application here: ${joinLink}`,
    html: emailShell("You’re invited to join our team", `
      <p style="margin:0 0 18px">Hi ${escapeHtml(invite.candidateName)}, Home Front Solutions invited you to apply for a field-sales position.</p>
      <p style="margin:0 0 20px"><a href="${escapeHtml(joinLink)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#3EA394;color:#fff;text-decoration:none;font-weight:700">Start your application</a></p>
      <p style="margin:0;font-size:12px;color:#8a97a4">This private link expires in 14 days and is tied to your email address. After approval, you’ll receive a secure sign-in code and your onboarding agreements through Home Front Sign.</p>`),
  });
  return { delivery, joinLink };
}

async function sendCompletionReceipt(input: { recordId: string; email: string; name: string; title: string; pdf: Buffer }) {
  return sendResendEmail({
    to: input.email,
    subject: `Signed copy: ${input.title}`,
    idempotencyKey: `onboarding-complete-${input.recordId}`,
    tags: [{ name: "category", value: "onboarding_complete" }],
    text: `Hi ${input.name}, your ${input.title} has been signed. A completed PDF is attached and remains available in My Documents.`,
    html: emailShell("Your signed agreement is complete", `
      <p style="margin:0 0 18px">Hi ${escapeHtml(input.name)}, your <strong>${escapeHtml(input.title)}</strong> has been signed successfully.</p>
      <p style="margin:0;font-size:13px;color:#617081">The completed agreement and electronic-signature certificate are attached. You can also download the same tamper-evident PDF from My Documents.</p>`),
    attachments: [{ filename: `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}.pdf`, content: input.pdf }],
  });
}

export function registerOnboardingDocumentRoutes(app: Express, { requireAuth, requireCapability }: Deps) {
  const tenantId = (req: Request) => Number((req as any).user?.tenantId ?? 0);
  const userId = (req: Request) => Number((req as any).user?.id ?? 0) || null;
  const myRepId = (req: Request) => Number((req as any).user?.teamMemberId ?? 0) || null;
  const userAgent = (req: Request) => String(req.headers["user-agent"] ?? "unknown").slice(0, 500);
  const ip = (req: Request) => String(req.ip || req.socket.remoteAddress || "unknown").slice(0, 100);

  app.get("/api/onboarding/documents/config", requireAuth, requireCapability("onboarding.documents.manage"), (_req, res) => {
    res.json({ configured: resendConfigured(), provider: "homefront_sign", emailProvider: "resend", documents: publicCatalog() });
  });

  app.get("/api/onboarding/invitations/resolve", inviteResolveLimiter, (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const invite = token ? resolveRecruitingInviteToken(token) : null;
    if (!invite) return res.status(404).json({ error: "This invitation is invalid or has expired" });
    const tenant = storage.getTenantById(invite.tenantId);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      name: invite.candidateName,
      email: invite.candidateEmail,
      expiresAt: invite.expiresAt,
      organization: tenant?.companyName ?? "Home Front Solutions",
      orgSlug: tenant?.slug ?? "",
    });
  });

  app.get("/api/onboarding/invitations", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    res.json({ configured: resendConfigured(), invitations: listRecruitingInvites(tenantId(req)) });
  });

  app.post("/api/onboarding/invitations", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsed = recruitingInviteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter the candidate's full name and a valid email address" });
    if (!resendConfigured()) return res.status(503).json({ error: "Resend email is not configured yet" });

    const tid = tenantId(req);
    const actorId = userId(req);
    const origin = onboardingAppOrigin(req);
    let invitation;
    try {
      invitation = createRecruitingInvite({
        tenantId: tid,
        candidateName: parsed.data.name,
        candidateEmail: parsed.data.email,
        invitedBy: actorId,
      });
    } catch (error: any) {
      if (/open invitation|unique/i.test(error?.message ?? "")) {
        return res.status(409).json({ error: "This candidate already has an open invitation. Select their record to copy or resend it." });
      }
      throw error;
    }

    try {
      const { delivery, joinLink } = await sendRecruitingInvitation({ inviteId: invitation.id, origin });
      const sent = markRecruitingInviteSent(invitation.id, delivery.id);
      storage.logActivity(actorId, "onboarding.recruiting_invite.sent", "onboarding_invitation", sent.id, {
        candidateEmail: sent.candidateEmail,
        emailProvider: "resend",
        emailId: delivery.id,
        secureInvite: true,
      }, req.ip);
      return res.status(201).json({ invitation: sent, joinLink });
    } catch (error: any) {
      const reason = error?.message || "Invitation delivery failed";
      const failed = markRecruitingInviteFailed(invitation.id, reason);
      storage.logActivity(actorId, "onboarding.recruiting_invite.failed", "onboarding_invitation", failed.id, {
        candidateEmail: failed.candidateEmail,
        emailProvider: "resend",
        reason,
      }, req.ip);
      return res.status(502).json({ error: "The invitation could not be delivered. Try again.", invitation: failed });
    }
  });

  app.get("/api/onboarding/pipeline", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    const records = buildOnboardingPipeline(tenantId(req), onboardingAppOrigin(req));
    const summary = {
      total: records.length,
      needsAction: records.filter(record => ["under_review", "failed"].includes(record.stage)).length,
      inProgress: records.filter(record => ["approved", "login_code_sent", "agreements_issued", "partially_signed", "fully_signed"].includes(record.stage)).length,
      active: records.filter(record => record.stage === "active").length,
    };
    res.json({ configured: resendConfigured(), summary, records });
  });

  app.post("/api/onboarding/invitations/:id/resend", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const invite = parsedId.success ? getRecruitingInvite(parsedId.data) : null;
    if (!invite || invite.tenantId !== tenantId(req)) return res.status(404).json({ error: "Invitation not found" });
    if (invite.applicationId || ["active", "rejected"].includes(invite.status)) return res.status(409).json({ error: "The candidate has already moved past the invitation step" });
    try {
      const { delivery, joinLink } = await sendRecruitingInvitation({
        inviteId: invite.id,
        origin: onboardingAppOrigin(req),
        deliveryAttempt: `retry-${invite.deliveryAttempts + 1}`,
      });
      const sent = markRecruitingInviteSent(invite.id, delivery.id);
      storage.logActivity(userId(req), "onboarding.recruiting_invite.resent", "onboarding_invitation", invite.id,
        { candidateEmail: invite.candidateEmail, emailProvider: "resend", emailId: delivery.id }, req.ip);
      res.json({ invitation: sent, joinLink });
    } catch (error: any) {
      markRecruitingInviteFailed(invite.id, error?.message || "Invitation delivery failed");
      res.status(502).json({ error: "The invitation could not be delivered. Try again." });
    }
  });

  app.post("/api/onboarding/pipeline/:id/resend-login", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const invite = parsedId.success ? getRecruitingInvite(parsedId.data) : null;
    if (!invite || invite.tenantId !== tenantId(req)) return res.status(404).json({ error: "Onboarding record not found" });
    const application = invite.applicationId ? storage.getRepApplicationById(invite.applicationId) : null;
    if (!application || application.status !== "approved" || !application.userId) return res.status(409).json({ error: "Approve the application before sending a login code" });
    try {
      const otp = storage.createOtp(application.email);
      const welcome = await sendOnboardingWelcome({ email: application.email, name: application.fullName, otp, origin: onboardingAppOrigin(req) });
      markInviteLoginSent(invite.id, welcome.id);
      storage.logActivity(userId(req), "onboarding.welcome.resent", "rep_application", application.id,
        { candidateEmail: application.email.toLowerCase(), emailProvider: "resend", emailId: welcome.id }, req.ip);
      res.json({ sent: true });
    } catch (error: any) {
      res.status(502).json({ error: error?.message || "The login code could not be sent" });
    }
  });

  app.post("/api/onboarding/pipeline/:id/resend-documents", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const invite = parsedId.success ? getRecruitingInvite(parsedId.data) : null;
    if (!invite || invite.tenantId !== tenantId(req)) return res.status(404).json({ error: "Onboarding record not found" });
    const application = invite.applicationId ? storage.getRepApplicationById(invite.applicationId) : null;
    const user = application?.userId ? storage.getUserById(application.userId) : null;
    if (!application || application.status !== "approved" || !user?.teamMemberId) return res.status(409).json({ error: "Approve the application before issuing agreements" });
    try {
      const issued = await issueOnboardingDocuments({
        tenantId: invite.tenantId, repId: user.teamMemberId, sentBy: userId(req), actorIp: ip(req), actorUserAgent: userAgent(req),
        origin: onboardingAppOrigin(req), forceEmail: true, deliveryAttempt: `pipeline-${invite.id}-${Date.now()}`,
      });
      if (issued.results.length === ONBOARDING_DOCUMENT_TYPES.length && !issued.results.some(result => result.failed)) {
        markInviteAgreementsIssued(invite.id);
      }
      res.json(issued);
    } catch (error: any) {
      res.status(502).json({ error: error?.message || "The agreements could not be sent" });
    }
  });

  app.get("/api/onboarding/documents/me", requireAuth, requireCapability("onboarding.documents.read.self"), (req, res) => {
    const repId = myRepId(req);
    if (!repId) return res.json({ configured: resendConfigured(), provider: "homefront_sign", documents: [], history: [], progress: { completed: 0, total: 0 }, noRepProfile: true });
    res.json(listPayload(tenantId(req), repId));
  });

  app.get("/api/onboarding/documents/reps/:repId", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    const parsed = repIdSchema.safeParse(req.params.repId);
    if (!parsed.success) return res.status(400).json({ error: "Invalid rep ID" });
    const rep = storage.getTeamMemberById(parsed.data);
    if (!rep || rep.tenantId !== tenantId(req)) return res.status(404).json({ error: "Rep not found" });
    res.json({ rep: { id: rep.id, name: rep.name, email: rep.email }, ...listPayload(tenantId(req), rep.id) });
  });

  app.post("/api/onboarding/documents/reps/:repId/send", requireAuth, requireCapability("onboarding.documents.manage"), async (req, res) => {
    const parsedRepId = repIdSchema.safeParse(req.params.repId);
    const parsedBody = sendSchema.safeParse(req.body);
    if (!parsedRepId.success || !parsedBody.success) return res.status(400).json({ error: "Choose one or more valid onboarding documents" });
    const tid = tenantId(req);
    const rep = storage.getTeamMemberById(parsedRepId.data);
    if (!rep || rep.tenantId !== tid) return res.status(404).json({ error: "Rep not found" });
    try {
      const issued = await issueOnboardingDocuments({
        tenantId: tid,
        repId: rep.id,
        documentTypes: parsedBody.data.documentTypes,
        sentBy: userId(req),
        actorIp: ip(req),
        actorUserAgent: userAgent(req),
        origin: onboardingAppOrigin(req),
      });
      res.json({ ...issued, ...listPayload(tid, rep.id) });
    } catch (error: any) {
      const status = /configured/.test(error?.message ?? "") ? 503 : /email address/.test(error?.message ?? "") ? 409 : 500;
      res.status(status).json({ error: error?.message || "Could not issue onboarding documents" });
    }
  });

  app.get("/api/onboarding/documents/:id/content", requireAuth, requireCapability("onboarding.documents.read.self"), (req, res) => {
    const parsed = documentIdSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
    const record = getSigningDocument(parsed.data);
    if (!record || record.tenantId !== tenantId(req) || record.repId !== myRepId(req)) return res.status(404).json({ error: "Document not found" });
    if (!canOpenSigning(record.status)) return res.status(409).json({ error: "This document is not available for signing" });
    const viewed = markDocumentViewed(record.id, userId(req)!, ip(req), userAgent(req))!;
    storage.logActivity(userId(req), "onboarding.document.viewed", "onboarding_document", record.id,
      { documentType: record.documentType, contentSha256: record.contentSha256, provider: "homefront_sign" }, req.ip);
    res.json({
      id: viewed.id,
      recordId: viewed.recordId,
      status: viewed.status,
      contentSha256: viewed.contentSha256,
      snapshot: viewed.snapshot,
      disclosure: ELECTRONIC_CONSENT_DISCLOSURE,
      consentVersion: ELECTRONIC_CONSENT_VERSION,
    });
  });

  app.post("/api/onboarding/documents/:id/sign", requireAuth, requireCapability("onboarding.documents.read.self"), async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const parsedBody = signSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) return res.status(400).json({ error: "Complete every acknowledgment and enter your full legal name" });
    const record = getSigningDocument(parsedId.data);
    const uid = userId(req);
    if (!record || record.tenantId !== tenantId(req) || record.repId !== myRepId(req) || !uid) return res.status(404).json({ error: "Document not found" });
    if (!canOpenSigning(record.status)) return res.status(409).json({ error: "This document is not available for signing" });
    if (!signerNameMatches(record.signerName, parsedBody.data.typedName)) return res.status(400).json({ error: `Type your full name exactly as ${record.signerName}` });
    if (record.contentSha256 !== parsedBody.data.documentSha256) return res.status(409).json({ error: "The agreement changed; reopen it before signing" });

    try {
      const signedAt = new Date().toISOString();
      const evidence = {
        recordId: record.recordId,
        signerName: record.signerName,
        signerEmail: record.signerEmail,
        signedAt,
        authenticatedUserId: uid,
        authenticatedSession: true,
        ipAddress: ip(req),
        userAgent: userAgent(req),
        contentSha256: record.contentSha256,
        consentVersion: ELECTRONIC_CONSENT_VERSION,
        consentToElectronicRecords: true,
        acknowledgeRead: true,
        intentToSign: true,
      };
      const signatureSha256 = sha256(JSON.stringify(evidence));
      const pdfEvidence = { ...evidence, signatureSha256 };
      const pdf = await renderSignedAgreementPdf(record.snapshot, pdfEvidence);
      const pdfSha256 = sha256(pdf);
      const completed = completeSigning({
        id: record.id,
        expectedContentSha256: record.contentSha256,
        signatureName: record.signerName,
        signatureSha256,
        consentVersion: ELECTRONIC_CONSENT_VERSION,
        signedAt,
        signedUserId: uid,
        ipAddress: ip(req),
        userAgent: userAgent(req),
        evidence,
        pdf,
        pdfSha256,
      });
      storage.logActivity(uid, "onboarding.document.signed", "onboarding_document", record.id,
        { documentType: record.documentType, recordId: record.recordId, contentSha256: record.contentSha256, signatureSha256, pdfSha256, provider: "homefront_sign" }, req.ip);
      const activation = syncRepActivation({ tenantId: record.tenantId, repId: record.repId });
      if (activation.activated) storage.logActivity(uid, "onboarding.rep.activated", "team_member", record.repId,
        { signedCount: activation.signedCount, inviteId: activation.inviteId }, req.ip);

      let receiptSent = false;
      try {
        const receipt = await sendCompletionReceipt({ recordId: completed.recordId, email: completed.signerEmail, name: completed.signerName, title: completed.documentTitle, pdf });
        markCompletionEmail(completed.id, receipt.id);
        receiptSent = true;
      } catch (emailError: any) {
        storage.logActivity(uid, "onboarding.document.receipt_failed", "onboarding_document", record.id,
          { emailProvider: "resend", reason: emailError?.message || "Completion receipt failed" }, req.ip);
      }
      res.json({ signed: true, receiptSent, activation, document: { id: completed.id, status: completed.status, completedAt: completed.completedAt } });
    } catch (error: any) {
      const status = /already processed|not available|changed/.test(error?.message ?? "") ? 409 : 500;
      res.status(status).json({ error: error?.message || "Could not complete signature" });
    }
  });

  app.post("/api/onboarding/documents/:id/decline", requireAuth, requireCapability("onboarding.documents.read.self"), (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const parsedBody = declineSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) return res.status(400).json({ error: "Provide a brief reason for declining" });
    const record = getSigningDocument(parsedId.data);
    const uid = userId(req);
    if (!record || record.tenantId !== tenantId(req) || record.repId !== myRepId(req) || !uid) return res.status(404).json({ error: "Document not found" });
    try {
      const declined = declineSigning({ id: record.id, actorUserId: uid, ipAddress: ip(req), userAgent: userAgent(req), reason: parsedBody.data.reason });
      storage.logActivity(uid, "onboarding.document.declined", "onboarding_document", record.id,
        { documentType: record.documentType, reason: parsedBody.data.reason, provider: "homefront_sign" }, req.ip);
      res.json({ declined: true, document: toPublicRecord(declined) });
    } catch (error: any) {
      res.status(409).json({ error: error?.message || "Could not decline document" });
    }
  });

  app.get("/api/onboarding/documents/:id/download", requireAuth, (req, res) => {
    const parsed = documentIdSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
    const record = getSigningDocument(parsed.data);
    if (!record || record.tenantId !== tenantId(req)) return res.status(404).json({ error: "Document not found" });
    const ownsDocument = record.repId === myRepId(req);
    if (!ownsDocument && !can((req as any).user?.role, "onboarding.documents.manage")) return res.status(403).json({ error: "Forbidden" });
    if (record.status !== "completed") return res.status(409).json({ error: "The signed document is not available yet" });
    const pdf = getCompletedPdf(record.id);
    if (!pdf) return res.status(500).json({ error: "The signed PDF could not be found" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="homefront-${record.documentType.replace(/_/g, "-")}.pdf"`);
    res.setHeader("Content-Length", String(pdf.length));
    res.setHeader("X-Document-SHA256", record.completedPdfSha256 || sha256(pdf));
    res.send(pdf);
  });
}
