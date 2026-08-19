import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "../shared/capabilities";
import { can } from "../shared/capabilities";
import { MEMBER_ROLES, canHireRole, isValidSupervisorRole } from "../shared/teamHierarchy";
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
import { gustoConfigured } from "./gustoAdapter";
import { AGREEMENT_VERSION, buildAgreementSnapshot } from "./onboardingAgreementTemplates";
import { resolveCommissionTerms, saveRepCommissionTerms } from "./commissionTermsResolver";
import { normalizeCommissionTerms, type CommissionTerms } from "@shared/commissionTerms";
import { renderAgreementPreviewPdf, renderOnboardingPacketPdf, renderSignedAgreementPdf } from "./onboardingPdf";
import { loadW9Template } from "./w9Pdf";
import {
  completeSigning,
  counterSignDocument,
  declineSigning,
  getCompletedPdf,
  getSigningDocument,
  listCounterSignQueue,
  listRepDocuments,
  markCompletionEmail,
  markDocumentViewed,
  markDocumentsFailed,
  markDocumentsSent,
  listDocumentEvents,
  reserveSigningDocument,
  toPublicRecord,
  verifyDocumentChain,
  voidSigningDocument,
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
  normalizeInviteCompTerms,
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
const tierSchema = z.object({
  position: z.number().int().min(0).max(20),
  minimumSales: z.number().int().min(1).max(10_000),
  maximumSales: z.number().int().min(1).max(10_000).nullable(),
  rateCents: z.number().int().min(0).max(100_000),
  label: z.string().trim().max(60).default(""),
}).strict();
// The comp terms a manager may set AT THE MOMENT they send the paperwork —
// which is the point of the feature: the agreement states this engagement's
// numbers instead of incorporating "the portal" by reference. Same bounds as
// the invite schema, so a rate that cannot be invited cannot be contracted.
const compTermsSchema = z.object({
  structure: z.enum(["FLAT", "TIERED"]).optional(),
  flatRateCents: z.number().int().min(0).max(100_000).nullable().optional(),
  tiers: z.array(tierSchema).min(1).max(12).optional(),
  reservePercent: z.number().int().min(0).max(100).optional(),
  reserveCapCents: z.number().int().min(0).max(100_000_000).optional(),
}).strict();
const sendSchema = z.object({
  documentTypes: z.array(z.enum(ONBOARDING_DOCUMENT_TYPES)).min(1).max(ONBOARDING_DOCUMENT_TYPES.length),
  compTerms: compTermsSchema.optional(),
}).strict();
const recruitingInviteSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform(value => value.toLowerCase()),
  // Comp terms the manager sets when sending the invite (all optional; absent =
  // inherit the org default at approval). flatRateCents ≤ $1,000/sale, reserve
  // ceiling ≤ $1,000,000 — sane bounds so a typo can't set absurd pay.
  commissionStructure: z.enum(["FLAT", "TIERED"]).optional(),
  flatRateCents: z.number().int().min(0).max(100_000).optional(),
  // The tier ladder a TIERED invite is actually offering. Same tierSchema and
  // the same ≤12 bound as the agreements path, so a ladder that cannot be
  // invited cannot be contracted — and a bounded array keeps an arbitrarily
  // large blob off a row written before the candidate even has an account.
  tiers: z.array(tierSchema).min(1).max(12).optional(),
  reservePercent: z.number().int().min(0).max(100).optional(),
  reserveCapCents: z.number().int().min(0).max(100_000_000).optional(),
  // Role + upline chosen at invite time. The schema only shapes them — the
  // POST handler validates against the actor's own hiring authority and the
  // tenant roster. Absent role = 'rep'; absent supervisor = default to the
  // inviter's own roster row; explicit null = top-level.
  invitedRole: z.enum(MEMBER_ROLES).optional(),
  invitedSupervisorId: z.number().int().positive().nullable().optional(),
  // Per-hire override rates: what the team-lead / manager slots keep from each
  // of this hire's qualified sales. Whole integer cents; null/absent = inherit
  // the org default. Never surfaced to the candidate.
  invitedOverrideTeamLeadCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  invitedOverrideManagerCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  // Existing members the new LEADER hire brings under them at approval. Only
  // meaningful for team_lead/manager invites; the handler validates every id
  // against the tenant roster and the strictly-above rule.
  invitedDownlineIds: z.array(z.number().int().positive()).max(200).optional(),
}).strict();
const signSchema = z.object({
  typedName: z.string().trim().min(2).max(120),
  documentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  consentToElectronicRecords: z.literal(true),
  acknowledgeRead: z.literal(true),
  intentToSign: z.literal(true),
}).strict();
const declineSchema = z.object({ reason: z.string().trim().min(2).max(500) }).strict();
const voidSchema = z.object({ reason: z.string().trim().min(2).max(500) }).strict();
const counterSignSchema = z.object({
  signatureName: z.string().trim().min(2).max(120),
}).strict();

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
      <p style="margin:0;font-size:12px;color:#8a97a4">For your protection, sign in with the same email address that received this message. If another Home Front account is already open on the device, sign it out first. The portal records your consent and preserves the exact document you sign.</p>`),
  });
}

// A CODE-FREE approval notification. It used to embed a live one-time sign-in
// code, which meant approval (a manager action, not the rep's) minted and
// mailed an authentication secret — the exact anti-pattern where a code is
// generated before the rep ever asks for one: it sits in an inbox for its whole
// lifetime, is emitted on every approval/resend, and reveals to anyone who sees
// the mail that the account exists. Now the email only tells the rep they are
// approved and links them to the sign-in screen, where THEY enter their email
// and request a fresh, short-lived code through /api/auth/otp/request. The code
// is born from the rep's explicit tap and nowhere else.
export async function sendOnboardingWelcome(input: {
  email: string;
  name: string;
  origin: string;
}) {
  const link = `${input.origin}/#/my-documents`;
  return sendResendEmail({
    to: input.email,
    subject: "Your Home Front Solutions application is approved",
    // Idempotent on the recipient alone (no code to key on) so a double-tapped
    // approval or a manager resend collapses to one email per applicant.
    idempotencyKey: `onboarding-welcome-${sha256(input.email.toLowerCase()).slice(0, 48)}`,
    tags: [{ name: "category", value: "onboarding_welcome" }],
    text: `Welcome to the team, ${input.name}. Your application has been approved. Sign in to review and complete your onboarding: ${link} - on the sign-in screen, enter this email and tap "Send code" to get a one-time sign-in code.`,
    html: emailShell("Welcome to the team", `
      <p style="margin:0 0 16px">Hi ${escapeHtml(input.name)}, your application has been <strong>approved</strong>.</p>
      <p style="margin:0 0 20px">Sign in to review and complete your onboarding documents:</p>
      <p style="margin:0 0 20px"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#3EA394;color:#fff;text-decoration:none;font-weight:700">Sign in to get started</a></p>
      <p style="margin:0;font-size:12px;color:#8a97a4">If another Home Front account is already open on this device, sign it out first. On the sign-in screen, enter this email and tap &ldquo;Send code&rdquo; - a one-time sign-in code will arrive that expires in 10 minutes.</p>`),
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
  /** Comp terms the manager set in the send-paperwork dialog. Resolved against
   *  the rep's stored/inherited terms, persisted, then rendered into the
   *  commission agreement — so the paperwork states this engagement's actual
   *  numbers rather than incorporating "the portal" by reference. */
  compTerms?: Partial<CommissionTerms> | null;
}): Promise<IssueOnboardingDocumentsResult> {
  if (!resendConfigured()) throw new Error("Resend email is not configured yet");
  const rep = storage.getTeamMemberById(input.repId);
  if (!rep || rep.tenantId !== input.tenantId) throw new Error("Rep not found");
  if (!rep.email) throw new Error("The rep needs an email address before documents can be sent");

  const tenant = storage.getTenantById(input.tenantId);
  const companyName = tenant?.companyName || "Home Front Solutions LLC";
  const issuedAt = new Date().toISOString();

  // Resolve BEFORE building any document, and refuse an invalid ladder outright
  // — a contract that states a tier ladder the commission engine would not pay
  // against is worse than no contract.
  const compTerms = resolveCommissionTerms(input.tenantId, rep.id, input.compTerms);
  const check = normalizeCommissionTerms(compTerms);
  if (!check.ok) throw new Error(`Commission terms are not valid: ${check.errors.join(" ")}`);
  // Persisted so the portal pays what the paper says. Written once here, at the
  // moment the terms become a commitment.
  saveRepCommissionTerms(rep.id, check.normalized);
  const results: IssueOnboardingDocumentsResult["results"] = [];
  const created: Array<{ id: number; recordId: string; documentType: OnboardingDocumentType }> = [];
  const existingActive: Array<{ id: number; recordId: string; documentType: OnboardingDocumentType }> = [];
  const requestedTypes = [...new Set(input.documentTypes ?? ONBOARDING_DOCUMENT_TYPES)];

  for (const documentType of requestedTypes) {
    const snapshot = buildAgreementSnapshot({ documentType, companyName, signerName: rep.name, signerEmail: rep.email, issuedAt, compTerms: check.normalized });
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

  // What the join page may show a candidate about the role they were invited
  // to. Display copy only — this endpoint is PUBLIC (token-gated, no session),
  // so the supervisor id/name is deliberately NEVER exposed here: that is org
  // structure behind an unauthenticated token.
  const ROLE_LABELS: Record<string, string> = { rep: "Field Representative", team_lead: "Team Lead", manager: "Manager" };

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
      roleLabel: ROLE_LABELS[invite.invitedRole ?? "rep"] ?? "Field Representative",
    });
  });

  app.get("/api/onboarding/invitations", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    res.json({ configured: resendConfigured(), invitations: listRecruitingInvites(tenantId(req)) });
  });

  app.post("/api/onboarding/invitations", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsed = recruitingInviteSchema.safeParse(req.body);
    if (!parsed.success) {
      // Say which half failed. The invite form now carries a full comp editor —
      // a free reserve-cap field where there used to be a three-option select —
      // so "a number is out of range" is a reachable mistake, and answering it
      // with "check the name and email" sends the manager to the wrong field.
      const compFields = new Set(["commissionStructure", "flatRateCents", "tiers", "reservePercent", "reserveCapCents"]);
      const badTerms = parsed.error.issues.some(issue => compFields.has(String(issue.path[0])));
      return res.status(400).json({
        error: badTerms
          ? "Check the commission terms - a rate, ladder or reserve is outside the allowed range."
          : "Enter the candidate's full name and a valid email address",
      });
    }
    // Comp terms get their own 400. Reported through the name/email message,
    // a bad ladder would send a manager hunting for a typo in the email address.
    // The verdict is normalizeCommissionTerms' — the same one the agreements
    // path uses — plus the explicit refusal of a TIERED invite with no ladder,
    // which normalizeCommissionTerms alone would answer "ok" to by silently
    // substituting the house bands. That substitution IS the bug being fixed.
    const compCheck = normalizeInviteCompTerms({
      commissionStructure: parsed.data.commissionStructure ?? null,
      flatRateCents: parsed.data.flatRateCents ?? null,
      tiers: parsed.data.tiers ?? null,
    });
    if (!compCheck.ok) return res.status(400).json({ error: `Commission terms are not valid: ${compCheck.errors.join(" ")}` });
    if (!resendConfigured()) return res.status(503).json({ error: "Resend email is not configured yet" });

    const tid = tenantId(req);
    const actorId = userId(req);

    // ── Role + upline, decided AT INVITE TIME ────────────────────────────────
    // Same authority rule as POST /api/team: you may only invite a role you
    // could also hire directly, so a manager can never invite a fellow manager.
    const actor = (req as any).user;
    const invitedRole = parsed.data.invitedRole ?? "rep";
    if (!canHireRole(actor?.role, invitedRole)) {
      return res.status(403).json({ error: `Your role cannot invite a ${invitedRole.replace("_", " ")}` });
    }
    // Supervisor: field ABSENT → default the hire under the inviter's own
    // roster row when it exists, is active, and outranks the invited role
    // (else top-level). Explicit null → top-level. Explicit id → the POST
    // /api/team rule: in-tenant, active, ranks strictly above the new member.
    const roster = storage.getTeamMembers(tid);
    let invitedSupervisorId: number | null = null;
    if (parsed.data.invitedSupervisorId === undefined) {
      const mine = actor?.teamMemberId ? roster.find(member => member.id === actor.teamMemberId) : undefined;
      invitedSupervisorId = mine && mine.active && isValidSupervisorRole(invitedRole, mine.role) ? mine.id : null;
    } else if (parsed.data.invitedSupervisorId !== null) {
      // A team lead may only build under themselves. Inert while invitations
      // are manager+; live the day the capability widens. Reject, not rewrite —
      // a silently re-homed hire is worse than a refused form.
      if (actor?.role === "team_lead" && parsed.data.invitedSupervisorId !== actor?.teamMemberId) {
        return res.status(400).json({ error: "A team lead can only place new hires under themselves", code: "INVALID_SUPERVISOR" });
      }
      const supervisor = roster.find(member => member.id === parsed.data.invitedSupervisorId);
      if (!supervisor || !supervisor.active) {
        return res.status(400).json({ error: "Supervisor must be an active member of your organization", code: "INVALID_SUPERVISOR" });
      }
      if (!isValidSupervisorRole(invitedRole, supervisor.role)) {
        return res.status(400).json({ error: "A supervisor must rank above the member they manage", code: "INVALID_SUPERVISOR" });
      }
      invitedSupervisorId = supervisor.id;
    }

    // Downline the new LEADER brings with them. Every entry must be an active
    // in-tenant member the invited role would rank strictly above — the same
    // rule a supervisor edge obeys, read in the other direction. The chosen
    // supervisor can never also be in the downline (that loop would only
    // surface at approval, as a cycle-check fallback — refuse it loudly now).
    const invitedDownlineIds = [...new Set(parsed.data.invitedDownlineIds ?? [])];
    if (invitedDownlineIds.length > 0) {
      if (invitedRole === "rep") {
        return res.status(400).json({ error: "A rep cannot be given a downline - only team leads and managers supervise", code: "INVALID_DOWNLINE" });
      }
      for (const downlineId of invitedDownlineIds) {
        if (downlineId === invitedSupervisorId) {
          return res.status(400).json({ error: "The new hire's supervisor cannot also report to them", code: "INVALID_DOWNLINE" });
        }
        const member = roster.find(candidate => candidate.id === downlineId);
        if (!member || !member.active) {
          return res.status(400).json({ error: "Every downline member must be an active member of your organization", code: "INVALID_DOWNLINE" });
        }
        if (!isValidSupervisorRole(member.role, invitedRole)) {
          return res.status(400).json({ error: `A ${String(invitedRole).replace("_", " ")} cannot supervise ${member.name} (${String(member.role).replace("_", " ")})`, code: "INVALID_DOWNLINE" });
        }
      }
    }

    const origin = onboardingAppOrigin(req);
    let invitation;
    try {
      invitation = createRecruitingInvite({
        tenantId: tid,
        candidateName: parsed.data.name,
        candidateEmail: parsed.data.email,
        invitedBy: actorId,
        commissionStructure: parsed.data.commissionStructure ?? null,
        flatRateCents: parsed.data.flatRateCents ?? null,
        tiers: parsed.data.tiers ?? null,
        reservePercent: parsed.data.reservePercent ?? null,
        reserveCapCents: parsed.data.reserveCapCents ?? null,
        invitedRole,
        invitedSupervisorId,
        invitedOverrideTeamLeadCents: parsed.data.invitedOverrideTeamLeadCents ?? null,
        invitedOverrideManagerCents: parsed.data.invitedOverrideManagerCents ?? null,
        invitedDownlineIds,
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
    res.json({ configured: resendConfigured(), gustoConfigured: gustoConfigured(), summary, records });
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

  // Resend the CODE-FREE approval notification (the sign-in invite), not a
  // login code. A manager can nudge an approved applicant who lost the email,
  // but the code itself is only ever minted by the rep's own request on the
  // sign-in screen — a manager can never push an authentication secret into
  // someone's inbox. (Endpoint path kept for client compatibility.)
  app.post("/api/onboarding/pipeline/:id/resend-login", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const invite = parsedId.success ? getRecruitingInvite(parsedId.data) : null;
    if (!invite || invite.tenantId !== tenantId(req)) return res.status(404).json({ error: "Onboarding record not found" });
    const application = invite.applicationId ? storage.getRepApplicationById(invite.applicationId) : null;
    if (!application || application.status !== "approved" || !application.userId) return res.status(409).json({ error: "Approve the application before sending the sign-in invite" });
    try {
      const welcome = await sendOnboardingWelcome({ email: application.email, name: application.fullName, origin: onboardingAppOrigin(req) });
      markInviteLoginSent(invite.id, welcome.id);
      storage.logActivity(userId(req), "onboarding.welcome.resent", "rep_application", application.id,
        { candidateEmail: application.email.toLowerCase(), emailProvider: "resend", emailId: welcome.id }, req.ip);
      res.json({ sent: true });
    } catch (error: any) {
      res.status(502).json({ error: error?.message || "The sign-in invite could not be sent" });
    }
  });

  app.post("/api/onboarding/pipeline/:id/resend-documents", requireAuth, requireCapability("onboarding.documents.manage"), recruitingInviteLimiter, async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const invite = parsedId.success ? getRecruitingInvite(parsedId.data) : null;
    if (!invite || invite.tenantId !== tenantId(req)) return res.status(404).json({ error: "Onboarding record not found" });
    const application = invite.applicationId ? storage.getRepApplicationById(invite.applicationId) : null;
    const user = application?.userId ? storage.getUserById(application.userId) : null;
    if (!application || application.status !== "approved" || !user?.teamMemberId) return res.status(409).json({ error: "Approve the application before issuing agreements" });
    // Terms are optional here; absent means "use whatever this rep already
    // resolves to" rather than silently reverting them to the house default.
    const parsedTerms = compTermsSchema.safeParse(req.body?.compTerms ?? {});
    if (!parsedTerms.success) return res.status(400).json({ error: "Those commission terms aren't valid" });
    try {
      const issued = await issueOnboardingDocuments({
        tenantId: invite.tenantId, repId: user.teamMemberId, sentBy: userId(req), actorIp: ip(req), actorUserAgent: userAgent(req),
        origin: onboardingAppOrigin(req), forceEmail: true, deliveryAttempt: `pipeline-${invite.id}-${Date.now()}`,
        compTerms: parsedTerms.success ? parsedTerms.data : null,
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

  // What terms would this rep get if the paperwork went out right now? The
  // editor opens on these rather than on a blank form, so a manager edits the
  // real offer instead of unknowingly retyping it.
  app.get("/api/onboarding/documents/reps/:repId/comp-terms", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    const parsed = repIdSchema.safeParse(req.params.repId);
    if (!parsed.success) return res.status(400).json({ error: "Invalid rep ID" });
    const rep = storage.getTeamMemberById(parsed.data);
    if (!rep || rep.tenantId !== tenantId(req)) return res.status(404).json({ error: "Rep not found" });
    res.json({ terms: resolveCommissionTerms(tenantId(req), rep.id, null) });
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
        compTerms: parsedBody.data.compTerms ?? null,
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

  // ── Review the REAL document, before signing anything ──────────────────────
  // The ceremony used to show the agreement as HTML sections and only produced
  // a PDF once the rep had already signed. So the thing a signer reviewed was a
  // re-creation of the instrument, and the actual PDF first appeared when it was
  // too late to decline. This serves the complete, paginated agreement — the
  // same body the executed copy is rendered from — watermarked REVIEW COPY so a
  // saved preview can never pass for an executed agreement.
  //
  // Same scope wall as /content: a rep gets their OWN document or a 404. It is
  // deliberately available for any status a rep can legitimately look at,
  // including already-completed ones, because "let me re-read what I signed" is
  // a reasonable thing to want and the executed copy is a separate download.
  // ── The whole packet, as one PDF ────────────────────────────────────────
  // A rep had to open four separate agreements to see what they were joining.
  // This is all of them in one file, cover sheet first with the commission
  // terms on it, so "what am I agreeing to" is one read rather than four.
  //
  // Built from the rep's LIVE envelopes where they exist, so the packet shows
  // the same documents the ceremony will ask them to sign — never a freshly
  // rendered ideal that could differ from what was actually issued.
  async function packetFor(tid: number, repId: number): Promise<{ pdf: Buffer; count: number } | null> {
    const rep = storage.getTeamMemberById(repId);
    if (!rep || rep.tenantId !== tid) return null;
    const records = listRepDocuments(tid, repId);
    // Newest envelope per type, in the catalogue's presentation order.
    const latest = new Map<string, typeof records[number]>();
    for (const record of records) if (!latest.has(record.documentType)) latest.set(record.documentType, record);
    // listRepDocuments returns the envelope summary; the snapshot itself hangs
    // off the full record, so re-read each by id.
    const snapshots = ONBOARDING_DOCUMENT_TYPES
      .map(type => {
        const id = latest.get(type)?.id;
        return id == null ? null : getSigningDocument(id)?.snapshot ?? null;
      })
      .filter((snapshot): snapshot is NonNullable<typeof snapshot> => Boolean(snapshot));
    if (!snapshots.length) return null;
    const tenant = storage.getTenantById(tid);
    return {
      count: snapshots.length,
      pdf: await renderOnboardingPacketPdf({
        snapshots,
        signerName: rep.name,
        signerEmail: rep.email ?? "",
        companyName: tenant?.companyName || "Home Front Solutions LLC",
        brandColor: (tenant as any)?.brandColor ?? null,
      }),
    };
  }

  function sendPacket(res: Response, packet: { pdf: Buffer; count: number }, who: string) {
    res.setHeader("Content-Type", "application/pdf");
    // Inline: it should open where the reader already is, not become a download.
    res.setHeader("Content-Disposition", `inline; filename="homefront-onboarding-${who}.pdf"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(packet.pdf);
  }

  // The rep's own packet.
  app.get("/api/onboarding/documents/me/packet.pdf", requireAuth, requireCapability("onboarding.documents.read.self"), async (req, res) => {
    const repId = myRepId(req);
    if (!repId) return res.status(404).json({ error: "No rep profile" });
    try {
      const packet = await packetFor(tenantId(req), repId);
      if (!packet) return res.status(404).json({ error: "No agreements have been issued yet" });
      storage.logActivity(userId(req), "onboarding.packet.opened", "team_member", repId, { documents: packet.count }, req.ip);
      sendPacket(res, packet, "agreements");
    } catch {
      res.status(500).json({ error: "Could not build the agreement packet" });
    }
  });

  // A manager reviewing what a given rep was sent.
  app.get("/api/onboarding/documents/reps/:repId/packet.pdf", requireAuth, requireCapability("onboarding.documents.manage"), async (req, res) => {
    const parsed = repIdSchema.safeParse(req.params.repId);
    if (!parsed.success) return res.status(400).json({ error: "Invalid rep ID" });
    try {
      const packet = await packetFor(tenantId(req), parsed.data);
      if (!packet) return res.status(404).json({ error: "No agreements have been issued yet" });
      sendPacket(res, packet, String(parsed.data));
    } catch {
      res.status(500).json({ error: "Could not build the agreement packet" });
    }
  });

  app.get("/api/onboarding/documents/:id/preview.pdf", requireAuth, requireCapability("onboarding.documents.read.self"), async (req, res) => {
    const parsed = documentIdSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
    const record = getSigningDocument(parsed.data);
    if (!record || record.tenantId !== tenantId(req) || record.repId !== myRepId(req)) return res.status(404).json({ error: "Document not found" });
    try {
      const pdf = await renderAgreementPreviewPdf(record.snapshot);
      // warm=1 is the list screen pre-warming its blob cache, not a human
      // opening anything — the preview_opened audit row must record only real
      // opens. A cache-served real open reports itself via the beacon below.
      if (req.query.warm !== "1") {
        storage.logActivity(userId(req), "onboarding.document.preview_opened", "onboarding_document", record.id,
          { documentType: record.documentType, contentSha256: record.contentSha256 }, req.ip);
      }
      res.setHeader("Content-Type", "application/pdf");
      // INLINE, not an attachment: the point is that it opens in the viewer the
      // rep is already looking at. A download prompt is a dead end mid-ceremony.
      res.setHeader("Content-Disposition", `inline; filename="${record.documentType.replace(/_/g, "-")}-review.pdf"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(pdf);
    } catch (error: any) {
      res.status(500).json({ error: "Could not render this document for review" });
    }
  });

  // A real open served from the client's warm blob cache never reaches the
  // preview.pdf route, so the pane reports it here instead — log-only, same
  // ownership check, no render. Without this, prefetching would trade one audit
  // falsehood (opens that never happened) for another (opens that did, unrecorded).
  app.post("/api/onboarding/documents/:id/preview-opened", requireAuth, requireCapability("onboarding.documents.read.self"), (req, res) => {
    const parsed = documentIdSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
    const record = getSigningDocument(parsed.data);
    if (!record || record.tenantId !== tenantId(req) || record.repId !== myRepId(req)) return res.status(404).json({ error: "Document not found" });
    storage.logActivity(userId(req), "onboarding.document.preview_opened", "onboarding_document", record.id,
      { documentType: record.documentType, contentSha256: record.contentSha256, servedFrom: "prefetch_cache" }, req.ip);
    res.json({ ok: true });
  });

  // The OFFICIAL IRS Form W-9 — the vendored template itself, all six pages
  // including the IRS instructions, byte-for-byte. Not a re-creation: a rep
  // filling out a tax form signed under penalty of perjury is entitled to read
  // the actual form the government publishes, including the certification text
  // and the instructions that explain it, before entering a TIN.
  //
  // Any authenticated user in the tenant may read it. It is a public IRS
  // document containing nobody's data — the FILLED copy is the one behind
  // payouts.pay (see /api/me/w9/pdf and /api/team-members/:id/w9/pdf).
  app.get("/api/onboarding/w9/blank.pdf", requireAuth, (_req, res) => {
    try {
      const template = loadW9Template();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="fw9-official-irs.pdf"');
      // The template is immutable and integrity-pinned, so it is safe to cache
      // hard — this is the one PDF in the system that never varies by user.
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.send(template);
    } catch {
      res.status(503).json({ error: "The official W-9 form is unavailable on this server", code: "W9_TEMPLATE_UNAVAILABLE" });
    }
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
        // The verbatim keystrokes, preserved beside the canonical account name.
        // What the signer actually wrote is the signature; the canonical name is
        // only what it was matched against.
        typedSignatureName: parsedBody.data.typedName,
        signerEmail: record.signerEmail,
        signedAt,
        authenticatedUserId: uid,
        authenticatedSession: true,
        ipAddress: ip(req),
        userAgent: userAgent(req),
        contentSha256: record.contentSha256,
        consentVersion: ELECTRONIC_CONSENT_VERSION,
        // Read back from the parsed request, never asserted. The schema already
        // requires literal true, so the values are the same — but evidence must
        // record what was RECEIVED, not what the server assumed was received.
        consentToElectronicRecords: parsedBody.data.consentToElectronicRecords,
        acknowledgeRead: parsedBody.data.acknowledgeRead,
        intentToSign: parsedBody.data.intentToSign,
      };
      const signatureSha256 = sha256(JSON.stringify(evidence));
      const pdfEvidence = { ...evidence, signatureSha256 };
      const pdf = await renderSignedAgreementPdf(record.snapshot, pdfEvidence);
      const pdfSha256 = sha256(pdf);
      const completed = completeSigning({
        id: record.id,
        expectedContentSha256: record.contentSha256,
        signatureName: record.signerName,
        signatureTypedName: parsedBody.data.typedName,
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
      res.json({
        signed: true,
        receiptSent,
        activation,
        // The rep can hash their downloaded PDF and compare it against this and
        // the certificate page — self-verification without asking anyone.
        completedPdfSha256: completed.completedPdfSha256,
        document: { id: completed.id, status: completed.status, completedAt: completed.completedAt, completedPdfSha256: completed.completedPdfSha256 },
      });
    } catch (error: any) {
      const status = /already processed|not available|changed/.test(error?.message ?? "") ? 409 : 500;
      res.status(status).json({ error: error?.message || "Could not complete signature" });
    }
  });

  // ── Company counter-signature ─────────────────────────────────────────────
  // The rep's signature completes the rep half and queues the document for the
  // company (counterSignStatus 'pending'); a manager counter-signs here to
  // execute it fully. The capability is the same HIGH_RISK
  // onboarding.documents.manage that issues and voids agreements — team_lead
  // deliberately does NOT hold it, so a team lead can never bind the company.
  // SELF-DEAL GUARD: the company signer must be a different person than the
  // rep who signed — one human may not execute both halves of a contract.
  app.get("/api/onboarding/documents/counter-sign-queue", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    res.json({ queue: listCounterSignQueue(tenantId(req)) });
  });

  app.post("/api/onboarding/documents/:id/counter-sign", requireAuth, requireCapability("onboarding.documents.manage"), async (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const parsedBody = counterSignSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) return res.status(400).json({ error: "Type your full legal name to counter-sign for the company" });
    const record = getSigningDocument(parsedId.data);
    const uid = userId(req);
    if (!record || record.tenantId !== tenantId(req) || !uid) return res.status(404).json({ error: "Document not found" });
    if (record.status !== "completed") return res.status(409).json({ error: "Only a signed agreement can be counter-signed" });
    if (record.counterSignStatus === "none") {
      // Grandfathered: completed before the counter-sign step existed. It was
      // fully executed under the then-current ceremony and stays as-is.
      return res.status(409).json({ error: "This agreement predates company counter-signing and is already fully executed" });
    }
    if (record.counterSignStatus !== "pending") return res.status(409).json({ error: "This agreement is already counter-signed" });
    // Self-deal: the company signer must not be the rep who signed.
    if (record.signedUserId === uid || (record.repId && record.repId === myRepId(req))) {
      return res.status(403).json({ error: "You cannot counter-sign your own agreement", code: "COUNTER_SIGN_SELF_DEAL" });
    }
    const signer = storage.getUserById(uid);
    if (!signer) return res.status(404).json({ error: "Document not found" });
    if (!signerNameMatches(signer.name, parsedBody.data.signatureName)) {
      return res.status(400).json({ error: `Type your full name exactly as ${signer.name}` });
    }

    try {
      const signedAt = new Date().toISOString();
      // Re-stamp the certificate with the company block: the final PDF carries
      // BOTH signatures, rendered by the same builder from the same frozen
      // snapshot and rep evidence, so the dual-stamped copy cannot drift from
      // the rep-signed one it replaces.
      const repEvidence = { ...(record.evidence ?? {}), signatureSha256: record.signatureSha256 } as any;
      const pdf = await renderSignedAgreementPdf(record.snapshot, repEvidence, {
        companySignatureName: parsedBody.data.signatureName,
        companySignedAt: signedAt,
        companySignerUserId: uid,
      });
      const pdfSha256 = sha256(pdf);
      const counterSigned = counterSignDocument({
        id: record.id,
        companySignerUserId: uid,
        companySignatureName: parsedBody.data.signatureName,
        signedAt,
        pdf,
        pdfSha256,
        ipAddress: ip(req),
        userAgent: userAgent(req),
      });
      storage.logActivity(uid, "onboarding.document.counter_signed", "onboarding_document", record.id,
        { documentType: record.documentType, recordId: record.recordId, repId: record.repId, contentSha256: record.contentSha256, pdfSha256, provider: "homefront_sign" }, req.ip);
      res.json({
        counterSigned: true,
        completedPdfSha256: pdfSha256,
        document: toPublicRecord(counterSigned),
        verification: verifyDocumentChain(record.id),
      });
    } catch (error: any) {
      const status = /already counter-signed|not awaiting/.test(error?.message ?? "") ? 409 : 500;
      res.status(status).json({ error: error?.message || "Could not counter-sign this agreement" });
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

  // The hash chain existed but nothing could read it — evidence nobody can see
  // is evidence nobody can rely on. Both audiences reach it here: the rep who
  // signed (their own record) and a manager (any record in the tenant), with
  // the chain re-verified on every read so "the events are listed" and "the
  // events still hash to what was written" are never confused for each other.
  app.get("/api/onboarding/documents/:id/events", requireAuth, (req, res) => {
    const parsed = documentIdSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
    const record = getSigningDocument(parsed.data);
    if (!record || record.tenantId !== tenantId(req)) return res.status(404).json({ error: "Document not found" });
    const role = (req as any).user?.role;
    const isManager = can(role, "onboarding.documents.manage");
    const ownsDocument = record.repId === myRepId(req) && can(role, "onboarding.documents.read.self");
    if (!isManager && !ownsDocument) return res.status(403).json({ error: "Forbidden" });
    res.json({
      documentId: record.id,
      recordId: record.recordId,
      documentType: record.documentType,
      status: record.status,
      contentSha256: record.contentSha256,
      // Session forensics (IP, user-agent, raw payload) are projected out for a
      // non-manager — see PUBLIC_EVENT_KEYS in onboardingDocumentStore.
      events: listDocumentEvents(record.id, { includePrivate: isManager }),
      verification: verifyDocumentChain(record.id),
    });
  });

  // Void an ISSUED-BUT-UNSIGNED agreement (wrong version, wrong rep, candidate
  // withdrew). A completed agreement is never voidable: a signature is a fact,
  // and no manager may erase one — that request is refused with 409.
  app.post("/api/onboarding/documents/:id/void", requireAuth, requireCapability("onboarding.documents.manage"), (req, res) => {
    const parsedId = documentIdSchema.safeParse(req.params.id);
    const parsedBody = voidSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) return res.status(400).json({ error: "Provide a brief reason for voiding this agreement" });
    const record = getSigningDocument(parsedId.data);
    if (!record || record.tenantId !== tenantId(req)) return res.status(404).json({ error: "Document not found" });
    if (record.status === "completed") return res.status(409).json({ error: "A signed agreement cannot be voided" });
    if (!["sent", "delivered"].includes(record.status)) return res.status(409).json({ error: "Only an issued, unsigned agreement can be voided" });
    try {
      const voided = voidSigningDocument({
        id: record.id,
        actorUserId: userId(req),
        ipAddress: ip(req),
        userAgent: userAgent(req),
        reason: parsedBody.data.reason,
      });
      storage.logActivity(userId(req), "onboarding.document.voided", "onboarding_document", record.id,
        { documentType: record.documentType, recordId: record.recordId, previousStatus: record.status, reason: parsedBody.data.reason, provider: "homefront_sign" }, req.ip);
      res.json({ voided: true, document: toPublicRecord(voided) });
    } catch (error: any) {
      res.status(409).json({ error: error?.message || "Could not void document" });
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
