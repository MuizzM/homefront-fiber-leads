import crypto from "node:crypto";
import { rawDb } from "./db";
import type {
  AgreementSnapshot,
  OnboardingDocumentStatus,
  OnboardingDocumentType,
} from "../shared/onboardingDocuments";

export interface OnboardingDocumentRecord {
  id: number;
  recordId: string;
  tenantId: number;
  repId: number;
  documentType: OnboardingDocumentType;
  documentVersion: string;
  documentTitle: string;
  contentSha256: string;
  status: OnboardingDocumentStatus;
  signerName: string;
  signerEmail: string;
  sentBy: number | null;
  inviteEmailId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  statusChangedAt: string | null;
  signatureName: string | null;
  signatureSha256: string | null;
  electronicConsentVersion: string | null;
  electronicConsentAt: string | null;
  signedUserId: number | null;
  completedPdfSha256: string | null;
  completionEmailId: string | null;
  retentionUntil: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateOnboardingDocument extends OnboardingDocumentRecord {
  snapshot: AgreementSnapshot;
  signedIp: string | null;
  signedUserAgent: string | null;
  evidence: Record<string, unknown> | null;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

function mapRecord(row: any): PrivateOnboardingDocument | null {
  if (!row) return null;
  return {
    id: row.id,
    recordId: row.record_id,
    tenantId: row.tenant_id,
    repId: row.rep_id,
    documentType: row.document_type,
    documentVersion: row.document_version,
    documentTitle: row.document_title,
    contentSha256: row.content_sha256,
    status: row.status,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    sentBy: row.sent_by,
    inviteEmailId: row.invite_email_id,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    completedAt: row.completed_at,
    declinedAt: row.declined_at,
    voidedAt: row.voided_at,
    statusChangedAt: row.status_changed_at,
    signatureName: row.signature_name,
    signatureSha256: row.signature_sha256,
    electronicConsentVersion: row.electronic_consent_version,
    electronicConsentAt: row.electronic_consent_at,
    signedUserId: row.signed_user_id,
    signedIp: row.signed_ip,
    signedUserAgent: row.signed_user_agent,
    evidence: parseJson(row.evidence_json),
    completedPdfSha256: row.completed_pdf_sha256,
    completionEmailId: row.completion_email_id,
    retentionUntil: row.retention_until,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    snapshot: parseJson<AgreementSnapshot>(row.document_snapshot_json)!,
  };
}

export function getSigningDocument(id: number): PrivateOnboardingDocument | null {
  return mapRecord(rawDb.prepare("SELECT * FROM onboarding_signing_documents WHERE id = ?").get(id));
}

export function listRepDocuments(tenantId: number, repId: number): OnboardingDocumentRecord[] {
  return rawDb.prepare(
    `SELECT * FROM onboarding_signing_documents
      WHERE tenant_id = ? AND rep_id = ?
      ORDER BY created_at DESC, id DESC`,
  ).all(tenantId, repId).map(mapRecord) as OnboardingDocumentRecord[];
}

function appendEvent(input: {
  documentId: number;
  eventType: string;
  actorUserId: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}): string {
  const payloadJson = JSON.stringify(input.payload);
  const payloadSha256 = sha256(payloadJson);
  const previous = rawDb.prepare(
    "SELECT event_sha256 FROM onboarding_signature_events WHERE document_id = ? ORDER BY id DESC LIMIT 1",
  ).get(input.documentId) as { event_sha256?: string } | undefined;
  const previousHash = previous?.event_sha256 ?? null;
  const eventHash = sha256([
    input.documentId,
    input.eventType,
    input.actorUserId ?? "system",
    input.ipAddress ?? "",
    input.userAgent ?? "",
    input.createdAt,
    payloadSha256,
    previousHash ?? "genesis",
  ].join("\n"));
  rawDb.prepare(
    `INSERT INTO onboarding_signature_events
      (document_id, event_type, actor_user_id, ip_address, user_agent, payload_json,
       payload_sha256, previous_event_sha256, event_sha256, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.documentId,
    input.eventType,
    input.actorUserId,
    input.ipAddress,
    input.userAgent,
    payloadJson,
    payloadSha256,
    previousHash,
    eventHash,
    input.createdAt,
  );
  return eventHash;
}

export function reserveSigningDocument(input: {
  tenantId: number;
  repId: number;
  documentType: OnboardingDocumentType;
  snapshot: AgreementSnapshot;
  signerName: string;
  signerEmail: string;
  sentBy: number | null;
  actorIp: string | null;
  actorUserAgent: string | null;
}): { row: PrivateOnboardingDocument; created: boolean } {
  const active = rawDb.prepare(
    `SELECT * FROM onboarding_signing_documents
      WHERE tenant_id = ? AND rep_id = ? AND document_type = ?
        AND (status IN ('creating','sent','delivered') OR (status = 'completed' AND document_version = ?))
      ORDER BY id DESC LIMIT 1`,
  ).get(input.tenantId, input.repId, input.documentType, input.snapshot.documentVersion);
  if (active) return { row: mapRecord(active)!, created: false };

  const transaction = rawDb.transaction(() => {
    const snapshotJson = JSON.stringify(input.snapshot);
    const contentSha256 = sha256(snapshotJson);
    const recordId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const result = rawDb.prepare(
      `INSERT INTO onboarding_signing_documents
        (record_id, tenant_id, rep_id, document_type, document_version, document_title,
         document_snapshot_json, content_sha256, status, signer_name, signer_email,
         sent_by, status_changed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?, ?)`,
    ).run(
      recordId,
      input.tenantId,
      input.repId,
      input.documentType,
      input.snapshot.documentVersion,
      input.snapshot.title,
      snapshotJson,
      contentSha256,
      input.signerName,
      input.signerEmail.toLowerCase(),
      input.sentBy,
      createdAt,
      createdAt,
      createdAt,
    );
    const id = Number(result.lastInsertRowid);
    appendEvent({
      documentId: id,
      eventType: "document_created",
      actorUserId: input.sentBy,
      ipAddress: input.actorIp,
      userAgent: input.actorUserAgent,
      payload: { recordId, documentType: input.documentType, documentVersion: input.snapshot.documentVersion, contentSha256 },
      createdAt,
    });
    return getSigningDocument(id)!;
  });

  try {
    return { row: transaction.immediate(), created: true };
  } catch (error) {
    const winner = rawDb.prepare(
      `SELECT * FROM onboarding_signing_documents
        WHERE tenant_id = ? AND rep_id = ? AND document_type = ?
          AND (status IN ('creating','sent','delivered') OR (status = 'completed' AND document_version = ?))
        ORDER BY id DESC LIMIT 1`,
    ).get(input.tenantId, input.repId, input.documentType, input.snapshot.documentVersion);
    if (winner) return { row: mapRecord(winner)!, created: false };
    throw error;
  }
}

export function markDocumentsSent(ids: number[], emailId: string, actorUserId: number | null, occurredAt = new Date().toISOString()): void {
  rawDb.transaction(() => {
    for (const id of ids) {
      const changed = rawDb.prepare(
        `UPDATE onboarding_signing_documents
            SET status = 'sent', invite_email_id = ?, sent_at = ?, status_changed_at = ?,
                failure_reason = NULL, updated_at = ?
          WHERE id = ? AND status = 'creating'`,
      ).run(emailId, occurredAt, occurredAt, occurredAt, id);
      if (changed.changes) appendEvent({
        documentId: id,
        eventType: "invitation_sent",
        actorUserId,
        ipAddress: null,
        userAgent: null,
        payload: { emailProvider: "resend", emailId },
        createdAt: occurredAt,
      });
    }
  }).immediate();
}

export function markDocumentsFailed(ids: number[], reason: string, actorUserId: number | null): void {
  const occurredAt = new Date().toISOString();
  rawDb.transaction(() => {
    for (const id of ids) {
      const changed = rawDb.prepare(
        `UPDATE onboarding_signing_documents
            SET status = 'failed', failure_reason = ?, status_changed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'creating'`,
      ).run(reason.slice(0, 500), occurredAt, occurredAt, id);
      if (changed.changes) appendEvent({
        documentId: id,
        eventType: "invitation_failed",
        actorUserId,
        ipAddress: null,
        userAgent: null,
        payload: { reason: reason.slice(0, 500) },
        createdAt: occurredAt,
      });
    }
  }).immediate();
}

export function markDocumentViewed(id: number, actorUserId: number, ipAddress: string, userAgent: string): PrivateOnboardingDocument | null {
  return rawDb.transaction(() => {
    const current = getSigningDocument(id);
    if (!current || !["sent", "delivered"].includes(current.status)) return current;
    if (current.status === "sent") {
      const occurredAt = new Date().toISOString();
      rawDb.prepare(
        `UPDATE onboarding_signing_documents
            SET status = 'delivered', delivered_at = ?, status_changed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'sent'`,
      ).run(occurredAt, occurredAt, occurredAt, id);
      appendEvent({
        documentId: id,
        eventType: "document_viewed",
        actorUserId,
        ipAddress,
        userAgent,
        payload: { contentSha256: current.contentSha256 },
        createdAt: occurredAt,
      });
    }
    return getSigningDocument(id);
  }).immediate();
}

export function completeSigning(input: {
  id: number;
  expectedContentSha256: string;
  signatureName: string;
  signatureSha256: string;
  consentVersion: string;
  signedAt: string;
  signedUserId: number;
  ipAddress: string;
  userAgent: string;
  evidence: Record<string, unknown>;
  pdf: Buffer;
  pdfSha256: string;
}): PrivateOnboardingDocument {
  return rawDb.transaction(() => {
    const current = getSigningDocument(input.id);
    if (!current) throw new Error("Document not found");
    if (!["sent", "delivered"].includes(current.status)) throw new Error("Document is not available for signing");
    if (current.contentSha256 !== input.expectedContentSha256) throw new Error("Document content changed; reopen it before signing");
    const retentionUntil = new Date(new Date(input.signedAt).setUTCFullYear(new Date(input.signedAt).getUTCFullYear() + 7)).toISOString();
    const changed = rawDb.prepare(
      `UPDATE onboarding_signing_documents
          SET status = 'completed', completed_at = ?, status_changed_at = ?,
              signature_name = ?, signature_sha256 = ?, electronic_consent_version = ?,
              electronic_consent_at = ?, signed_user_id = ?, signed_ip = ?, signed_user_agent = ?,
              evidence_json = ?, completed_pdf = ?, completed_pdf_sha256 = ?,
              retention_until = ?, failure_reason = NULL, updated_at = ?
        WHERE id = ? AND status IN ('sent','delivered') AND content_sha256 = ?`,
    ).run(
      input.signedAt,
      input.signedAt,
      input.signatureName,
      input.signatureSha256,
      input.consentVersion,
      input.signedAt,
      input.signedUserId,
      input.ipAddress,
      input.userAgent,
      JSON.stringify(input.evidence),
      input.pdf,
      input.pdfSha256,
      retentionUntil,
      input.signedAt,
      input.id,
      input.expectedContentSha256,
    );
    if (!changed.changes) throw new Error("Document was already processed");
    appendEvent({
      documentId: input.id,
      eventType: "document_signed",
      actorUserId: input.signedUserId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      payload: {
        contentSha256: input.expectedContentSha256,
        signatureSha256: input.signatureSha256,
        completedPdfSha256: input.pdfSha256,
        consentVersion: input.consentVersion,
      },
      createdAt: input.signedAt,
    });
    return getSigningDocument(input.id)!;
  }).immediate();
}

export function declineSigning(input: { id: number; actorUserId: number; ipAddress: string; userAgent: string; reason: string }): PrivateOnboardingDocument {
  return rawDb.transaction(() => {
    const current = getSigningDocument(input.id);
    if (!current) throw new Error("Document not found");
    if (!["sent", "delivered"].includes(current.status)) throw new Error("Document is not available to decline");
    const occurredAt = new Date().toISOString();
    rawDb.prepare(
      `UPDATE onboarding_signing_documents
          SET status = 'declined', declined_at = ?, status_changed_at = ?, failure_reason = ?, updated_at = ?
        WHERE id = ? AND status IN ('sent','delivered')`,
    ).run(occurredAt, occurredAt, input.reason.slice(0, 500), occurredAt, input.id);
    appendEvent({
      documentId: input.id,
      eventType: "document_declined",
      actorUserId: input.actorUserId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      payload: { reason: input.reason.slice(0, 500) },
      createdAt: occurredAt,
    });
    return getSigningDocument(input.id)!;
  }).immediate();
}

export function getCompletedPdf(id: number): Buffer | null {
  const row = rawDb.prepare(
    "SELECT completed_pdf FROM onboarding_signing_documents WHERE id = ? AND status = 'completed'",
  ).get(id) as { completed_pdf?: Buffer } | undefined;
  return row?.completed_pdf ? Buffer.from(row.completed_pdf) : null;
}

export function markCompletionEmail(id: number, emailId: string): void {
  const occurredAt = new Date().toISOString();
  rawDb.transaction(() => {
    const changed = rawDb.prepare(
      `UPDATE onboarding_signing_documents SET completion_email_id = ?, updated_at = ?
        WHERE id = ? AND status = 'completed' AND completion_email_id IS NULL`,
    ).run(emailId, occurredAt, id);
    if (changed.changes) appendEvent({
      documentId: id,
      eventType: "completion_receipt_sent",
      actorUserId: null,
      ipAddress: null,
      userAgent: null,
      payload: { emailProvider: "resend", emailId },
      createdAt: occurredAt,
    });
  }).immediate();
}

export function listDocumentEvents(id: number): Array<Record<string, unknown>> {
  return rawDb.prepare(
    `SELECT event_type AS eventType, actor_user_id AS actorUserId, payload_sha256 AS payloadSha256,
            previous_event_sha256 AS previousEventSha256, event_sha256 AS eventSha256, created_at AS createdAt
       FROM onboarding_signature_events WHERE document_id = ? ORDER BY id`,
  ).all(id) as Array<Record<string, unknown>>;
}
