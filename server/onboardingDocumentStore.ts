import { rawDb } from "./db";
import {
  shouldApplyDocumentStatus,
  type DocusignConnectIntent,
  type OnboardingDocumentStatus,
  type OnboardingDocumentType,
} from "../shared/onboardingDocuments";

export interface OnboardingEnvelope {
  id: number;
  tenantId: number;
  repId: number;
  documentType: OnboardingDocumentType;
  envelopeId: string | null;
  status: OnboardingDocumentStatus;
  signerName: string;
  signerEmail: string;
  sentBy: number | null;
  sentAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  declinedAt: string | null;
  voidedAt: string | null;
  statusChangedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PrivateEnvelope extends OnboardingEnvelope {
  templateId: string;
  clientUserId: string;
}

function mapEnvelope(row: any): PrivateEnvelope | null {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    repId: row.rep_id,
    documentType: row.document_type,
    templateId: row.template_id,
    envelopeId: row.envelope_id,
    status: row.status,
    signerName: row.signer_name,
    signerEmail: row.signer_email,
    clientUserId: row.client_user_id,
    sentBy: row.sent_by,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    completedAt: row.completed_at,
    declinedAt: row.declined_at,
    voidedAt: row.voided_at,
    statusChangedAt: row.status_changed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getEnvelope(id: number): PrivateEnvelope | null {
  return mapEnvelope(rawDb.prepare("SELECT * FROM onboarding_document_envelopes WHERE id = ?").get(id));
}

export function getEnvelopeByDocusignId(envelopeId: string): PrivateEnvelope | null {
  return mapEnvelope(rawDb.prepare("SELECT * FROM onboarding_document_envelopes WHERE envelope_id = ?").get(envelopeId));
}

export function listRepEnvelopes(tenantId: number, repId: number): OnboardingEnvelope[] {
  return rawDb.prepare(
    `SELECT * FROM onboarding_document_envelopes
      WHERE tenant_id = ? AND rep_id = ?
      ORDER BY created_at DESC, id DESC`,
  ).all(tenantId, repId).map(mapEnvelope) as OnboardingEnvelope[];
}

export function reserveEnvelope(input: {
  tenantId: number;
  repId: number;
  documentType: OnboardingDocumentType;
  templateId: string;
  signerName: string;
  signerEmail: string;
  clientUserId: string;
  sentBy: number | null;
}): { row: PrivateEnvelope; created: boolean } {
  const active = rawDb.prepare(
    `SELECT * FROM onboarding_document_envelopes
      WHERE tenant_id = ? AND rep_id = ? AND document_type = ?
        AND status IN ('creating','sent','delivered')
      ORDER BY id DESC LIMIT 1`,
  ).get(input.tenantId, input.repId, input.documentType);
  if (active) return { row: mapEnvelope(active)!, created: false };

  try {
    const result = rawDb.prepare(
      `INSERT INTO onboarding_document_envelopes
        (tenant_id, rep_id, document_type, template_id, status, signer_name,
         signer_email, client_user_id, sent_by)
       VALUES (?, ?, ?, ?, 'creating', ?, ?, ?, ?)`,
    ).run(
      input.tenantId,
      input.repId,
      input.documentType,
      input.templateId,
      input.signerName,
      input.signerEmail.toLowerCase(),
      input.clientUserId,
      input.sentBy,
    );
    return { row: getEnvelope(Number(result.lastInsertRowid))!, created: true };
  } catch (error) {
    const winner = rawDb.prepare(
      `SELECT * FROM onboarding_document_envelopes
        WHERE tenant_id = ? AND rep_id = ? AND document_type = ?
          AND status IN ('creating','sent','delivered')
        ORDER BY id DESC LIMIT 1`,
    ).get(input.tenantId, input.repId, input.documentType);
    if (winner) return { row: mapEnvelope(winner)!, created: false };
    throw error;
  }
}

export function markEnvelopeSent(id: number, envelopeId: string, occurredAt = new Date().toISOString()): void {
  rawDb.prepare(
    `UPDATE onboarding_document_envelopes
        SET envelope_id = ?, status = 'sent', sent_at = ?, status_changed_at = ?,
            failure_reason = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'creating'`,
  ).run(envelopeId, occurredAt, occurredAt, id);
}

export function markEnvelopeFailed(id: number, reason: string): void {
  rawDb.prepare(
    `UPDATE onboarding_document_envelopes
        SET status = 'failed', failure_reason = ?, status_changed_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ? AND status = 'creating'`,
  ).run(reason.slice(0, 500), id);
}

function statusTimestampColumn(status: OnboardingDocumentStatus): string | null {
  if (status === "delivered") return "delivered_at";
  if (status === "completed") return "completed_at";
  if (status === "declined") return "declined_at";
  if (status === "voided") return "voided_at";
  return null;
}

export function applyConnectIntent(intent: DocusignConnectIntent): { applied: boolean; row: PrivateEnvelope | null; reason?: string } {
  const current = getEnvelopeByDocusignId(intent.envelopeId);
  if (!current) return { applied: false, row: null, reason: "unknown envelope" };
  if (intent.occurredAt && current.statusChangedAt && intent.occurredAt < current.statusChangedAt) {
    return { applied: false, row: current, reason: "stale event" };
  }
  if (!shouldApplyDocumentStatus(current.status, intent.status)) {
    return { applied: false, row: current, reason: "no state change" };
  }
  const occurredAt = intent.occurredAt ?? new Date().toISOString();
  const stampColumn = statusTimestampColumn(intent.status);
  const stampSql = stampColumn ? `, ${stampColumn} = ?` : "";
  const args: any[] = [intent.status, occurredAt];
  if (stampColumn) args.push(occurredAt);
  args.push(current.id);
  rawDb.prepare(
    `UPDATE onboarding_document_envelopes
        SET status = ?, status_changed_at = ?${stampSql}, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(...args);
  return { applied: true, row: getEnvelope(current.id) };
}

export function processConnectEvent(input: {
  eventId: string;
  payloadSha256: string;
  intent: DocusignConnectIntent;
}): { duplicate: boolean; applied: boolean; row: PrivateEnvelope | null; reason?: string } {
  const transaction = rawDb.transaction(() => {
    const duplicate = rawDb.prepare("SELECT 1 FROM docusign_webhook_events WHERE event_id = ?").get(input.eventId);
    if (duplicate) return { duplicate: true, applied: false, row: getEnvelopeByDocusignId(input.intent.envelopeId) };
    const result = applyConnectIntent(input.intent);
    rawDb.prepare(
      `INSERT INTO docusign_webhook_events
        (event_id, envelope_id, event_type, payload_sha256)
       VALUES (?, ?, ?, ?)`,
    ).run(input.eventId, input.intent.envelopeId, input.intent.eventType, input.payloadSha256);
    return { duplicate: false, ...result };
  });
  return transaction.immediate();
}
