import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "../shared/capabilities";
import { can } from "../shared/capabilities";
import {
  ONBOARDING_DOCUMENT_TYPES,
  canOpenSigning,
  parseDocusignConnectEvent,
} from "../shared/onboardingDocuments";
import { storage } from "./storage";
import {
  configuredDocumentCatalog,
  createOnboardingEnvelope,
  createSigningView,
  docusignConfigured,
  docusignWebhookConfigured,
  downloadCompletedEnvelope,
  publicDocumentCatalog,
  verifyDocusignHmac,
} from "./docusignAdapter";
import {
  getEnvelope,
  listRepEnvelopes,
  markEnvelopeFailed,
  markEnvelopeSent,
  processConnectEvent,
  reserveEnvelope,
} from "./onboardingDocumentStore";
import { emailNote, emailParagraph, emailShell, escapeHtml, logoAttachment, mailFrom, mailTransport } from "./mail";

interface Deps {
  requireAuth: (req: Request, res: Response, next: NextFunction) => void;
  requireCapability: (cap: Capability) => (req: Request, res: Response, next: NextFunction) => void;
}

const repIdSchema = z.coerce.number().int().positive();
const envelopeIdSchema = z.coerce.number().int().positive();
const sendSchema = z.object({
  documentTypes: z.array(z.enum(ONBOARDING_DOCUMENT_TYPES)).min(1).max(ONBOARDING_DOCUMENT_TYPES.length),
}).strict();

function appOrigin(req: Request): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new Error("APP_ORIGIN must use HTTPS");
    }
    return url.origin;
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.replace(/\/$/, "") : "";
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  const host = req.get("host") ?? "";
  if (process.env.NODE_ENV !== "production" && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return `http://${host}`;
  throw new Error("APP_ORIGIN must be configured before sending DocuSign documents");
}

function listPayload(tenantId: number, repId: number) {
  const catalog = publicDocumentCatalog();
  const envelopes = listRepEnvelopes(tenantId, repId);
  const latestByType = new Map<string, typeof envelopes[number]>();
  for (const envelope of envelopes) if (!latestByType.has(envelope.documentType)) latestByType.set(envelope.documentType, envelope);
  const documents = catalog.map(document => ({
    ...document,
    envelope: latestByType.get(document.type) ?? null,
  }));
  const completed = documents.filter(document => document.envelope?.status === "completed").length;
  return {
    configured: docusignConfigured(),
    documents,
    history: envelopes,
    progress: { completed, total: documents.filter(document => document.required).length },
  };
}

async function sendDocumentNotice(input: { email: string; name: string; documentCount: number; origin: string }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const logo = logoAttachment();
  await mailTransport().sendMail({
    from: mailFrom(),
    to: input.email,
    subject: "Your Home Front onboarding documents are ready",
    text: `Hi ${input.name}, ${input.documentCount} onboarding document${input.documentCount === 1 ? " is" : "s are"} ready for your signature. Sign in at ${input.origin}/#/my-documents to review and sign securely through DocuSign.`,
    html: emailShell({
      preheader: "Your onboarding agreements are ready to review and sign.",
      heading: "Your onboarding documents are ready",
      bodyHtml:
        emailParagraph(`Hi ${escapeHtml(input.name)}, ${input.documentCount} agreement${input.documentCount === 1 ? " is" : "s are"} ready for your review and signature.`) +
        emailParagraph(`<a href="${escapeHtml(input.origin)}/#/my-documents" style="display:inline-block;padding:12px 18px;background:#3EA394;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;">Review and sign documents</a>`) +
        emailNote("Signing happens securely through DocuSign. Home Front does not store your signature credentials."),
    }),
    attachments: logo ? [logo] : [],
  });
}

export function registerOnboardingDocumentRoutes(app: Express, { requireAuth, requireCapability }: Deps) {
  const tenantId = (req: Request) => Number((req as any).user?.tenantId ?? 0);
  const userId = (req: Request) => Number((req as any).user?.id ?? 0) || null;
  const myRepId = (req: Request) => Number((req as any).user?.teamMemberId ?? 0) || null;

  app.get(
    "/api/onboarding/documents/config",
    requireAuth,
    requireCapability("onboarding.documents.manage"),
    (_req, res) => res.json({ configured: docusignConfigured(), documents: publicDocumentCatalog() }),
  );

  app.get(
    "/api/onboarding/documents/me",
    requireAuth,
    requireCapability("onboarding.documents.read.self"),
    (req, res) => {
      const repId = myRepId(req);
      if (!repId) return res.json({ configured: docusignConfigured(), documents: [], history: [], progress: { completed: 0, total: 0 }, noRepProfile: true });
      res.json(listPayload(tenantId(req), repId));
    },
  );

  app.get(
    "/api/onboarding/documents/reps/:repId",
    requireAuth,
    requireCapability("onboarding.documents.manage"),
    (req, res) => {
      const parsed = repIdSchema.safeParse(req.params.repId);
      if (!parsed.success) return res.status(400).json({ error: "Invalid rep ID" });
      const rep = storage.getTeamMemberById(parsed.data);
      if (!rep || rep.tenantId !== tenantId(req)) return res.status(404).json({ error: "Rep not found" });
      res.json({ rep: { id: rep.id, name: rep.name, email: rep.email }, ...listPayload(tenantId(req), rep.id) });
    },
  );

  app.post(
    "/api/onboarding/documents/reps/:repId/send",
    requireAuth,
    requireCapability("onboarding.documents.manage"),
    async (req, res) => {
      const parsedRepId = repIdSchema.safeParse(req.params.repId);
      const parsedBody = sendSchema.safeParse(req.body);
      if (!parsedRepId.success || !parsedBody.success) return res.status(400).json({ error: "Choose one or more valid onboarding documents" });
      if (!docusignConfigured()) return res.status(503).json({ error: "DocuSign is not configured yet" });
      const tid = tenantId(req);
      const rep = storage.getTeamMemberById(parsedRepId.data);
      if (!rep || rep.tenantId !== tid) return res.status(404).json({ error: "Rep not found" });
      if (!rep.email) return res.status(409).json({ error: "The rep needs an email address before documents can be sent" });

      const catalog = new Map(configuredDocumentCatalog().map(document => [document.type, document]));
      const origin = appOrigin(req);
      const webhookUrl = process.env.DOCUSIGN_CONNECT_WEBHOOK_URL?.trim() || `${origin}/api/onboarding/documents/webhook/docusign`;
      const results: Array<{ documentType: string; sent?: true; skipped?: true; failed?: true; reason?: string; envelopeId?: number }> = [];

      for (const documentType of [...new Set(parsedBody.data.documentTypes)]) {
        const document = catalog.get(documentType);
        if (!document) {
          results.push({ documentType, failed: true, reason: "Template is not configured" });
          continue;
        }
        const clientUserId = `homefront-${tid}-${rep.id}`;
        const reservation = reserveEnvelope({
          tenantId: tid,
          repId: rep.id,
          documentType,
          templateId: document.templateId,
          signerName: rep.name,
          signerEmail: rep.email,
          clientUserId,
          sentBy: userId(req),
        });
        if (!reservation.created) {
          results.push({ documentType, skipped: true, reason: "An active envelope already exists", envelopeId: reservation.row.id });
          continue;
        }
        try {
          const created = await createOnboardingEnvelope({
            document,
            signerName: rep.name,
            signerEmail: rep.email,
            clientUserId,
            tenantId: tid,
            repId: rep.id,
            reservationId: reservation.row.id,
            webhookUrl,
          });
          markEnvelopeSent(reservation.row.id, created.envelopeId);
          storage.logActivity(userId(req), "onboarding.document.sent", "onboarding_document", reservation.row.id,
            { repId: rep.id, documentType, provider: "docusign" }, req.ip);
          results.push({ documentType, sent: true, envelopeId: reservation.row.id });
        } catch (error: any) {
          markEnvelopeFailed(reservation.row.id, error?.message || "DocuSign send failed");
          storage.logActivity(userId(req), "onboarding.document.send_failed", "onboarding_document", reservation.row.id,
            { repId: rep.id, documentType }, req.ip);
          results.push({ documentType, failed: true, reason: error?.message || "DocuSign send failed", envelopeId: reservation.row.id });
        }
      }

      const sentCount = results.filter(result => result.sent).length;
      if (sentCount > 0) {
        sendDocumentNotice({ email: rep.email, name: rep.name, documentCount: sentCount, origin })
          .catch(error => console.warn(`[docusign] onboarding email failed: ${error?.message ?? error}`));
      }
      res.json({ results, ...listPayload(tid, rep.id) });
    },
  );

  app.post(
    "/api/onboarding/documents/:id/sign",
    requireAuth,
    requireCapability("onboarding.documents.read.self"),
    async (req, res) => {
      const parsed = envelopeIdSchema.safeParse(req.params.id);
      if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
      const row = getEnvelope(parsed.data);
      if (!row || row.tenantId !== tenantId(req) || row.repId !== myRepId(req)) return res.status(404).json({ error: "Document not found" });
      if (!row.envelopeId || !canOpenSigning(row.status)) return res.status(409).json({ error: "This document is not available for signing" });
      try {
        const url = await createSigningView({
          envelopeId: row.envelopeId,
          signerName: row.signerName,
          signerEmail: row.signerEmail,
          clientUserId: row.clientUserId,
          returnUrl: `${appOrigin(req)}/#/my-documents?signing=returned`,
        });
        storage.logActivity(userId(req), "onboarding.document.signing_opened", "onboarding_document", row.id,
          { documentType: row.documentType, provider: "docusign" }, req.ip);
        res.json({ url });
      } catch (error: any) {
        res.status(502).json({ error: error?.message || "Could not open DocuSign" });
      }
    },
  );

  app.get("/api/onboarding/documents/:id/download", requireAuth, async (req, res) => {
    const parsed = envelopeIdSchema.safeParse(req.params.id);
    if (!parsed.success) return res.status(400).json({ error: "Invalid document ID" });
    const row = getEnvelope(parsed.data);
    if (!row || row.tenantId !== tenantId(req)) return res.status(404).json({ error: "Document not found" });
    const role = (req as any).user?.role;
    const ownsDocument = row.repId === myRepId(req);
    if (!ownsDocument && !can(role, "onboarding.documents.manage")) return res.status(403).json({ error: "Forbidden" });
    if (row.status !== "completed" || !row.envelopeId) return res.status(409).json({ error: "The signed document is not available yet" });
    try {
      const pdf = await downloadCompletedEnvelope(row.envelopeId);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="homefront-${row.documentType.replace(/_/g, "-")}.pdf"`);
      res.setHeader("Content-Length", String(pdf.length));
      res.send(pdf);
    } catch (error: any) {
      res.status(502).json({ error: error?.message || "Could not download signed document" });
    }
  });

  app.post("/api/onboarding/documents/webhook/docusign", (req, res) => {
    if (!docusignWebhookConfigured()) return res.status(503).json({ error: "DocuSign webhook is not configured" });
    const raw = (req as any).rawBody as Buffer | undefined;
    const header = req.headers["x-docusign-signature-1"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!raw || !verifyDocusignHmac(raw, signature)) return res.status(400).json({ error: "Invalid DocuSign signature" });
    const intent = parseDocusignConnectEvent(req.body);
    if (!intent) return res.status(202).json({ received: true, applied: false, reason: "Unsupported event" });
    const payloadSha256 = crypto.createHash("sha256").update(raw).digest("hex");
    const result = processConnectEvent({ eventId: payloadSha256, payloadSha256, intent });
    if (result.row && result.applied) {
      storage.logActivity(null, "onboarding.document.status_changed", "onboarding_document", result.row.id,
        { repId: result.row.repId, documentType: result.row.documentType, status: intent.status, provider: "docusign" }, req.ip, result.row.tenantId);
    }
    res.json({ received: true, applied: result.applied, duplicate: result.duplicate });
  });
}
