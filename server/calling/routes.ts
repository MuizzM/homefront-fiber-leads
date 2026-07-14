import crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { can, type Capability, type Role } from "@shared/capabilities";
import { CALLING_DECISIONS } from "@shared/calling";
import { rawDb } from "../db";
import { callingEnvironment, sha256, verifyConsentArtifactManifest } from "./crypto";
import { enrichCallingLead, validateCallingLeadPhone } from "./providers";
import {
  createConsentRecord,
  evaluateLeadCompliance,
  issueCallAuthorization,
  providerCostMetrics,
  recordCallDisposition,
  revokeConsent,
  startManualAttempt,
} from "./service";
import {
  activeRuleVersion,
  activeSellerAuthorization,
  activeScript,
  appendDncImportChunk,
  appendCallingAudit,
  assertRepresentativeCallingNotHeld,
  auditTimeline,
  beginDncImport,
  createInternalOptOut,
  currentConsent,
  dncStatus,
  ensureCallingProfile,
  getActiveRepresentativeCallingHold,
  getCallingCandidate,
  getDecision,
  importDncDataset,
  finalizeDncImport,
  internalDncHit,
  listDncImports,
  listCallingQueue,
  listCallingRepresentatives,
  listRepresentativeCallingHolds,
  placeRepresentativeCallingHold,
  platformDncHit,
  storeManualContact,
  syncFreshFiberQueue,
  updateCallingAssignment,
  updateCallingProfile,
  releaseRepresentativeCallingHold,
  validatePhoneManually,
  type CallingCandidate,
} from "./store";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

export type CallingRouteDeps = {
  requireAuth: Middleware;
  requireCapability: (capability: Capability) => Middleware;
};

const idSchema = z.coerce.number().int().positive();
const uuidSchema = z.string().uuid();
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const isoSchema = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const idempotencySchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);

function localMinute(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

const queueQuerySchema = z.object({
  stage: z.string().trim().min(1).max(80).regex(/^[A-Z0-9_]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(100),
}).strict();

const manualContactSchema = z.object({
  phone: z.string().trim().min(7).max(40),
  name: z.string().trim().max(200).nullable().optional(),
  relationship: z.enum(["resident", "owner", "unknown"]).default("unknown"),
  identityConfidence: z.number().min(0).max(1),
  providerConfigId: uuidSchema,
  providerRecordId: z.string().trim().min(3).max(300),
  humanVerified: z.literal(true),
}).strict();

const validationSchema = z.object({
  providerConfigId: uuidSchema,
  lineType: z.enum(["landline", "wireless", "voip", "fixed_voip", "non_fixed_voip", "other"]),
  reachable: z.boolean(),
  reassignedRisk: z.boolean(),
  evidenceRef: z.string().trim().min(3).max(500),
  validDays: z.number().int().min(1).max(31).default(30),
}).strict();

const enrichmentSchema = z.object({
  providerConfigId: uuidSchema.optional(),
  idempotencyKey: idempotencySchema.optional(),
}).strict();

const authorizeSchema = z.object({
  // Copying is a separately audited action after a manual attempt starts.
  // No click-to-call transport exists in this release, so accepting those
  // labels here would imply behavior the server does not implement.
  action: z.literal("reveal_and_hand_dial"),
  manualActionConfirmed: z.literal(true),
}).strict();

const startAttemptSchema = z.object({ authorizationToken: z.string().min(80).max(4_000) }).strict();

const dispositionCodes = [
  "NO_ANSWER", "BUSY", "DISCONNECTED", "VOICEMAIL_REACHED", "LEFT_NO_MESSAGE",
  "CALLBACK_REQUESTED", "INTERESTED", "NOT_INTERESTED", "WRONG_NUMBER", "WRONG_PARTY",
  "PROPERTY_OWNER_NOT_RESIDENT", "ALREADY_HAS_SERVICE", "NOT_SERVICEABLE", "APPOINTMENT_SCHEDULED",
  "SALE_STARTED", "SALE_COMPLETED", "DO_NOT_CALL", "CONSENT_GRANTED", "CONSENT_REVOKED",
  "LANGUAGE_BARRIER", "REVIEW_REQUIRED",
] as const;

const dispositionSchema = z.object({
  code: z.enum(dispositionCodes),
  notes: z.string().trim().max(2_000).nullable().optional(),
  callbackAt: isoSchema.nullable().optional(),
  callbackTimeZone: z.string().trim().min(1).max(100).nullable().optional(),
  callbackConsentEvidenceRef: uuidSchema.nullable().optional(),
  idempotencyKey: idempotencySchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.code === "CALLBACK_REQUESTED"
      && (!value.callbackAt || !value.callbackTimeZone || !value.callbackConsentEvidenceRef)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "Callback date, time zone, and consent evidence reference are required" });
  }
});

const optOutSchema = z.object({
  reason: z.enum(["do_not_call", "stop_request", "wrong_number", "wrong_party", "consent_revoked"]),
  channel: z.enum(["live_call", "voicemail_return", "written", "email", "in_person", "other"]),
  sourceRef: z.string().trim().max(500).nullable().optional(),
}).strict();

const consentSchema = z.object({
  consumerIdentity: z.string().trim().min(1).max(300),
  consentType: z.string().trim().min(1).max(100),
  channels: z.array(z.enum(["manual_voice_call"])).min(1).max(1),
  scope: z.string().trim().min(1).max(500),
  disclosureVersion: z.string().trim().min(1).max(100),
  disclosureTextSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  capturedAt: isoSchema,
  timeZone: z.string().trim().min(1).max(100),
  method: z.enum(["signed_form", "recorded_call", "written", "other"]),
  affirmativeAction: z.string().trim().min(3).max(1_000),
  evidenceArtifactRef: uuidSchema,
  voiceRecordingRef: uuidSchema.nullable().optional(),
  signatureRef: uuidSchema.nullable().optional(),
  sourceRef: z.string().trim().min(3).max(1_000),
  expiresAt: isoSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (!value.voiceRecordingRef && !value.signatureRef) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Voice recording or signature proof is required" });
  }
  if (value.method === "recorded_call" && !value.voiceRecordingRef) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Recorded-call consent requires a voice recording" });
  }
  if (Date.parse(value.capturedAt) > Date.now() + 5 * 60_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Consent capture time cannot be in the future" });
  }
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.capturedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Consent expiration must follow capture time" });
  }
});

const consentArtifactSchema = z.object({
  leadId: idSchema,
  phoneId: idSchema,
  callAttemptId: uuidSchema.nullable().optional(),
  artifactType: z.enum(["voice_recording", "signed_form", "written_record"]),
  storageProvider: z.string().trim().min(2).max(100),
  storageRef: z.string().trim().min(3).max(2_000),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  capturedAt: isoSchema,
  retentionUntil: isoSchema,
  verificationEvidenceRef: z.string().trim().min(3).max(2_000),
  manifestSignature: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict().superRefine((value, context) => {
  const minimumRetention = Date.parse(value.capturedAt) + 5 * 365 * 86_400_000;
  if (Date.parse(value.capturedAt) > Date.now() + 5 * 60_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Artifact capture time cannot be in the future" });
  }
  if (Date.parse(value.retentionUntil) < minimumRetention) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Consent evidence must be retained for at least five years" });
  }
  if (value.artifactType === "voice_recording" && !value.callAttemptId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Voice recordings must be bound to a call attempt" });
  }
});

const revokeSchema = z.object({
  scope: z.string().trim().min(1).max(500),
  method: z.enum(["live_call", "written", "email", "in_person", "other"]),
  evidenceRef: z.string().trim().min(3).max(1_000),
}).strict();

const profilePatchSchema = z.object({
  callingEnabled: z.boolean().optional(),
  emergencyDisabled: z.boolean().optional(),
  counselApproved: z.boolean().optional(),
  sellerAuthorized: z.boolean().optional(),
  sellerName: z.string().trim().max(200).optional(),
  sellerAuthorizationRef: z.string().trim().max(500).optional(),
  stateRulesApproved: z.boolean().optional(),
  defaultTimeZone: z.string().trim().min(1).max(100).optional(),
  allowedStartLocal: timeSchema.optional(),
  allowedEndLocal: timeSchema.optional(),
  minimumIdentityConfidence: z.number().min(0.5).max(1).optional(),
  maxAttempts7Days: z.number().int().min(0).max(20).optional(),
  maxAttempts30Days: z.number().int().min(0).max(50).optional(),
  dncMaxAgeDays: z.number().int().min(1).max(31).optional(),
  propagateOptOutPlatformWide: z.boolean().optional(),
  callerIdAuthorized: z.boolean().optional(),
  callerIdReference: z.string().trim().max(500).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one field is required");

const callingWindowSchema = z.object({
  startLocal: timeSchema,
  endLocal: timeSchema,
}).strict().superRefine((value, context) => {
  const start = localMinute(value.startLocal);
  const end = localMinute(value.endLocal);
  if (start < 8 * 60 || end > 21 * 60 || start >= end) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: "Calling windows may narrow but never exceed 08:00–21:00 local time" });
  }
});

const scriptSchema = z.object({
  version: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(20).max(20_000),
  sellerName: z.string().trim().min(1).max(200),
  companyName: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(500),
  active: z.boolean(),
  counselApproved: z.boolean(),
  counselApprovalReference: z.string().trim().min(3).max(1_000).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.active || value.counselApproved) && !value.counselApprovalReference) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Counsel approval reference is required" });
  }
});

const ruleSchema = z.object({
  version: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  config: z.object({
    allowedStates: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(50).optional(),
    blockedLineTypes: z.array(z.enum(["landline", "wireless", "voip", "fixed_voip", "non_fixed_voip", "other"]))
      .max(6).optional(),
    minimumIdentityConfidence: z.number().min(0.5).max(1).optional(),
    maxAttempts7Days: z.number().int().min(0).max(20).optional(),
    maxAttempts30Days: z.number().int().min(0).max(50).optional(),
    stateCallingWindows: z.record(callingWindowSchema).optional(),
  }).strict().superRefine((config, context) => {
    if (config.maxAttempts7Days != null && config.maxAttempts30Days != null
        && config.maxAttempts30Days < config.maxAttempts7Days) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: "30-day attempt limit cannot be lower than the 7-day limit" });
    }
    for (const state of Object.keys(config.stateCallingWindows ?? {})) {
      if (!/^[A-Z]{2}$/.test(state)) context.addIssue({ code: z.ZodIssueCode.custom,
        message: `Invalid state calling-window key: ${state}` });
    }
  }),
  active: z.boolean(),
  counselApprovalReference: z.string().trim().min(3).max(1_000).nullable(),
}).strict().superRefine((value, context) => {
  if (value.active && !value.counselApprovalReference) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Counsel approval reference is required" });
  }
  if (JSON.stringify(value.config).length > 30_000) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Rule configuration is too large" });
  }
});

const registrationSchema = z.object({
  state: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()),
  legalEntity: z.string().trim().min(1).max(300),
  registrationType: z.enum(["registration", "documented_exemption"]),
  registrationNumber: z.string().trim().max(200).nullable().optional(),
  exemptionType: z.string().trim().max(300).nullable().optional(),
  evidenceRef: z.string().trim().min(3).max(1_000),
  counselApproved: z.boolean(),
  effectiveAt: isoSchema,
  expiresAt: isoSchema.nullable().optional(),
  lastReviewedAt: isoSchema,
  status: z.enum(["pending", "active", "expired", "revoked"]),
}).strict().superRefine((value, context) => {
  if (value.registrationType === "registration" && !value.registrationNumber) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Registration number is required" });
  }
  if (value.registrationType === "documented_exemption" && !value.exemptionType) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Exemption type is required" });
  }
  if (value.status === "active" && !value.counselApproved) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Active registration must be counsel approved" });
  }
});

const sellerAuthorizationSchema = z.object({
  sellerName: z.string().trim().min(1).max(300),
  authorizationRef: z.string().trim().min(3).max(1_000),
  effectiveAt: isoSchema,
  expiresAt: isoSchema.nullable().optional(),
  status: z.enum(["pending", "active", "expired", "revoked"]),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict().superRefine((value, context) => {
  if (value.expiresAt && Date.parse(value.expiresAt) <= Date.parse(value.effectiveAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Seller authorization expiration must follow its effective date" });
  }
});

const providerBaseSchema = z.object({
  providerName: z.string().trim().min(1).max(200),
  adapterType: z.enum(["manual_import_v1", "generic_http_v1"]),
  enabled: z.boolean().default(false),
  priority: z.number().int().min(0).max(10_000).default(100),
  contractStatus: z.enum(["unapproved", "pending", "approved", "expired", "revoked"]).default("unapproved"),
  permittedUseApproved: z.boolean().default(false),
  permittedUses: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
  contractReference: z.string().trim().max(1_000).nullable().optional(),
  contractEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  queryCostMicros: z.number().int().min(0).max(1_000_000_000).default(0),
  cacheTtlSeconds: z.number().int().min(0).max(31_536_000).default(0),
  retentionDays: z.number().int().min(0).max(1_825).default(0),
  deletionObligations: z.string().trim().max(2_000).nullable().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10_000).default(1),
  secretEnvName: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,99}$/).nullable().optional(),
  baseUrl: z.string().url().max(1_000).nullable().optional(),
  dailyBudgetMicros: z.number().int().min(0).max(100_000_000_000).default(0),
  monthlyBudgetMicros: z.number().int().min(0).max(1_000_000_000_000).default(0),
}).strict();

const providerSchema = providerBaseSchema.superRefine((value, context) => {
  if (value.adapterType === "generic_http_v1" && (!value.baseUrl || !value.secretEnvName)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "HTTP providers require a base URL and secret env name" });
  }
  if (value.enabled && (value.contractStatus !== "approved" || !value.permittedUseApproved || !value.contractReference)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Enabled providers require approved contract and permitted use evidence" });
  }
});

const providerPatchSchema = providerBaseSchema.partial().strict()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

const dncImportSchema = z.object({
  sourceType: z.enum(["national", "state"]),
  state: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).nullable().optional(),
  versionLabel: z.string().trim().min(1).max(200),
  authorizedAccountRef: z.string().trim().min(3).max(1_000),
  // "ALL" is an explicit full-coverage marker. A list of individual area
  // codes is accepted for evidence/reporting but intentionally remains
  // fail-closed for call eligibility in currentDncDataset().
  coveredAreaCodes: z.array(z.union([
    z.literal("ALL"),
    z.string().regex(/^\d{3}$/),
  ])).max(1_000).default([]),
  phones: z.array(z.string().min(7).max(40)).min(1).max(10_000),
  maxAgeDays: z.number().int().min(1).max(31).default(31),
}).strict().superRefine((value, context) => {
  if (value.sourceType === "state" && !value.state) context.addIssue({ code: z.ZodIssueCode.custom, message: "State is required" });
  if (value.sourceType === "national" && value.state) context.addIssue({ code: z.ZodIssueCode.custom, message: "National dataset must not specify a state" });
});

const dncManifestBaseSchema = z.object({
  sourceType: z.enum(["national", "state"]),
  state: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).nullable().optional(),
  versionLabel: z.string().trim().min(1).max(200),
  authorizedAccountRef: z.string().trim().min(3).max(1_000),
  coveredAreaCodes: z.array(z.union([z.literal("ALL"), z.string().regex(/^\d{3}$/)])).min(1).max(1_000),
  expectedRecordCount: z.number().int().min(1).max(100_000_000),
  expectedChunkCount: z.number().int().min(1).max(100_000),
  chunkSize: z.number().int().min(1).max(3_000),
  sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  sourceAsOf: isoSchema,
  sourceRetrievedAt: isoSchema,
  manifestSignature: z.string().regex(/^[a-f0-9]{64}$/i),
  maxAgeDays: z.number().int().min(1).max(31).default(31),
}).strict().superRefine((value, context) => {
  if (value.sourceType === "state" && !value.state) context.addIssue({ code: z.ZodIssueCode.custom, message: "State is required" });
  if (value.sourceType === "national" && value.state) context.addIssue({ code: z.ZodIssueCode.custom, message: "National dataset must not specify a state" });
  if (!value.coveredAreaCodes.includes("ALL")) context.addIssue({ code: z.ZodIssueCode.custom, message: "Signed manifest must attest complete authorized coverage with ALL" });
  if (Date.parse(value.sourceRetrievedAt) < Date.parse(value.sourceAsOf)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source retrieval cannot predate the source as-of time" });
  }
});

const dncChunkSchema = z.object({
  chunkIndex: z.number().int().min(0).max(99_999),
  phones: z.array(z.string().min(7).max(40)).min(1).max(3_000),
}).strict();

const representativeHoldReasonSchema = z.object({
  reason: z.string().trim().min(3).max(1_000),
}).strict();

function tenantId(req: Request): number | null {
  const value = Number((req as any).user?.tenantId);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function userId(req: Request): number {
  return Number((req as any).user?.id);
}

function role(req: Request): Role | string {
  return String((req as any).user?.role ?? "");
}

function correlationId(req: Request): string {
  return String((req as any).id ?? req.headers["x-request-id"] ?? crypto.randomUUID()).slice(0, 200);
}

function isManager(req: Request): boolean {
  return can(role(req), "calling.manage");
}

function canInspectAllCallingRecords(req: Request): boolean {
  return isManager(req) || can(role(req), "calling.compliance.read");
}

function requireDecisionRead(req: Request, res: Response, next: NextFunction): unknown {
  if (can(role(req), "calling.evaluate") || can(role(req), "calling.compliance.read")) return next();
  return res.status(403).json({ error: "Missing capability: calling compliance decision read" });
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function requireTenant(req: Request, res: Response): number | null {
  const value = tenantId(req);
  if (!value) res.status(403).json({ error: "Organization membership required" });
  return value;
}

function parseBody<T>(schema: z.ZodType<T>, req: Request, res: Response): T | null {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return null;
  }
  return parsed.data;
}

function parseLeadId(req: Request, res: Response): number | null {
  const parsed = idSchema.safeParse(param(req, "leadId"));
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid lead id" });
    return null;
  }
  return parsed.data;
}

function publicCandidate(candidate: CallingCandidate): Record<string, unknown> {
  return {
    queueId: candidate.queueId,
    leadId: candidate.leadId,
    address: candidate.address,
    city: candidate.city,
    state: candidate.state,
    zip: candidate.zip,
    freshConfirmedAt: candidate.freshConfirmedAt,
    freshConfidence: candidate.freshConfidence,
    stage: candidate.queueStage,
    priority: candidate.priority,
    assignedUserId: candidate.assignedUserId,
    contact: candidate.contactId ? {
      id: candidate.contactId,
      status: candidate.contactStatus,
      name: candidate.contactName,
      residentStatus: candidate.residentStatus,
    } : null,
    phone: candidate.phoneId ? {
      id: candidate.phoneId,
      masked: candidate.maskedPhone,
      validationStatus: candidate.phoneValidationStatus,
      verifiedAt: candidate.phoneLastVerifiedAt,
      verificationExpiresAt: candidate.phoneVerificationExpiresAt,
      lineType: candidate.lineType,
      reassignedRisk: candidate.reassignedRisk,
    } : null,
    identityConfidence: candidate.identityConfidence,
    wrongParty: candidate.wrongParty,
    provider: candidate.providerName ? {
      id: candidate.providerConfigId,
      name: candidate.providerName,
      permittedUseApproved: candidate.providerPermittedUseApproved,
    } : null,
    lastDecision: candidate.lastDecisionId ? {
      id: candidate.lastDecisionId,
      status: candidate.lastDecisionStatus,
      expiresAt: candidate.lastDecisionExpiresAt,
    } : null,
  };
}

function scopedCandidate(req: Request, res: Response, tid: number, leadId: number): CallingCandidate | null {
  const candidate = getCallingCandidate(tid, leadId);
  if (!candidate || (!canInspectAllCallingRecords(req) && candidate.assignedUserId != null && candidate.assignedUserId !== userId(req))) {
    res.status(404).json({ error: "Calling lead not found" });
    return null;
  }
  return candidate;
}

function validTimeZone(value: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return true; } catch { return false; }
}

function fail(res: Response, error: unknown): Response {
  const detail = error as any;
  const message = error instanceof Error ? error.message : "Request failed";
  const explicit = Number(detail?.status);
  const status = [400, 403, 404, 409, 429].includes(explicit) ? explicit
    : /not found/i.test(message) ? 404
      : /blocked|disabled|stale|changed|already used|budget|circuit|exhausted|idempotency/i.test(message) ? 409
        : /required|invalid|unsupported|incomplete|approved|configured|allowlist|contract|permitted|callback/i.test(message) ? 400
          : 500;
  const body: Record<string, unknown> = { error: status === 500 ? "Calling request failed" : message };
  if (detail?.decision) body.decision = detail.decision;
  return res.status(status).json(body);
}

function providerPublic(row: any): Record<string, unknown> {
  let permittedUses: unknown[] = [];
  try { permittedUses = JSON.parse(row.permittedUsesJson ?? "[]"); } catch { permittedUses = []; }
  return {
    id: row.id,
    providerName: row.providerName,
    adapterType: row.adapterType,
    enabled: Number(row.enabled) === 1,
    priority: row.priority,
    contractStatus: row.contractStatus,
    permittedUseApproved: Number(row.permittedUseApproved) === 1,
    permittedUses,
    contractReference: row.contractReference,
    contractEvidenceSha256: row.contractEvidenceSha256,
    queryCostMicros: row.queryCostMicros,
    cacheTtlSeconds: row.cacheTtlSeconds,
    retentionDays: row.retentionDays,
    deletionObligations: row.deletionObligations,
    rateLimitPerMinute: row.rateLimitPerMinute,
    secretEnvName: row.secretEnvName,
    secretConfigured: Boolean(row.secretEnvName && process.env[row.secretEnvName]),
    baseUrl: row.baseUrl,
    dailyBudgetMicros: row.dailyBudgetMicros,
    monthlyBudgetMicros: row.monthlyBudgetMicros,
    circuitOpenUntil: row.circuitOpenUntil,
    lastHealthAt: row.lastHealthAt,
    lastHealthStatus: row.lastHealthStatus,
  };
}

export function registerCallingRoutes(app: Express, deps: CallingRouteDeps): void {
  const cap = deps.requireCapability;

  app.get("/api/v1/calling/status", cap("calling.queue.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    try {
      const environment = callingEnvironment(tid);
      const profile = ensureCallingProfile(tid);
      const dnc = dncStatus(tid);
      const script = activeScript(tid);
      const rules = activeRuleVersion(tid);
      const sellerAuthorization = activeSellerAuthorization(tid, profile.sellerName, profile.sellerAuthorizationRef, new Date().toISOString());
      const representativeHold = getActiveRepresentativeCallingHold(tid, userId(req));
      const blockers = [
        !environment.moduleEnabled && "module_flag_off",
        environment.emergencyDisabled && "global_emergency_stop_on",
        !environment.pilotAllowed && "organization_not_in_pilot",
        !environment.secretsReady && "calling_secrets_missing",
        !environment.nationalDncEnabled && "national_dnc_flag_off",
        !environment.stateDncEnabled && "state_dnc_flag_off",
        !environment.manualClickToCallEnabled && "manual_call_flag_off",
        !profile.callingEnabled && "organization_calling_off",
        profile.emergencyDisabled && "organization_emergency_stop_on",
        representativeHold && "representative_hold_active",
        !profile.counselApproved && "counsel_approval_missing",
        !profile.sellerAuthorized && "seller_authorization_missing",
        !sellerAuthorization && "active_seller_authorization_evidence_missing",
        !profile.callerIdAuthorized && "caller_id_authorization_missing",
        !script && "approved_script_missing",
        !rules && "approved_rules_missing",
        !dnc.national?.fresh && "national_dnc_missing_or_stale",
      ].filter(Boolean);
      res.json({
        enabled: blockers.length === 0,
        environment: {
          moduleEnabled: environment.moduleEnabled,
          enrichmentEnabled: environment.enrichmentEnabled,
          nationalDncEnabled: environment.nationalDncEnabled,
          stateDncEnabled: environment.stateDncEnabled,
          manualClickToCallEnabled: environment.manualClickToCallEnabled,
          emergencyDisabled: environment.emergencyDisabled,
          pilotAllowed: environment.pilotAllowed,
          secretsReady: environment.secretsReady,
        },
        organization: {
          callingEnabled: profile.callingEnabled,
          emergencyDisabled: profile.emergencyDisabled,
          policyVersion: profile.policyVersion,
          sellerConfigured: profile.sellerAuthorized && Boolean(profile.sellerAuthorizationRef),
          counselApproved: profile.counselApproved,
          stateRulesApproved: profile.stateRulesApproved,
          callerIdConfigured: profile.callerIdAuthorized && Boolean(profile.callerIdReference),
        },
        activeScript: script ? { version: script.version, title: script.title } : null,
        activeRuleVersion: rules?.version ?? null,
        representativeHold: representativeHold ? {
          id: representativeHold.id,
          reason: representativeHold.reason,
          placedAt: representativeHold.placedAt,
        } : null,
        blockers,
      });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/queue", cap("calling.queue.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const parsed = queueQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid queue query", details: parsed.error.flatten() });
    try {
      const synced = syncFreshFiberQueue(tid);
      const queue = listCallingQueue(tid, userId(req), canInspectAllCallingRecords(req), parsed.data.stage, parsed.data.limit);
      res.json({ queue: queue.map(publicCandidate), synced, fullPhoneNumbersExposed: false });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/leads/:leadId", cap("calling.lead.read"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    try {
      const candidate = scopedCandidate(req, res, tid, leadId); if (!candidate) return;
      const attempts = rawDb.prepare(`SELECT id,started_at AS startedAt,ended_at AS endedAt,duration_seconds AS durationSeconds,
        disposition_code AS dispositionCode,notes,script_version AS scriptVersion,representative_user_id AS representativeUserId
        FROM call_attempts WHERE tenant_id=? AND lead_id=? ORDER BY started_at DESC LIMIT 100`).all(tid, leadId);
      const callbacks = rawDb.prepare(`SELECT id,due_at AS dueAt,time_zone AS timeZone,status,cancelled_at AS cancelledAt,
        completed_at AS completedAt FROM callback_tasks WHERE tenant_id=? AND lead_id=? ORDER BY due_at DESC LIMIT 100`).all(tid, leadId);
      const profile = ensureCallingProfile(tid);
      const consent = currentConsent(tid, candidate.phoneId, leadId, profile.sellerName, new Date().toISOString());
      const openAttempt = rawDb.prepare(`SELECT a.id AS attemptId,a.started_at AS startedAt,p.masked_display AS maskedPhone,
        s.id AS scriptId,s.version AS scriptVersion,s.title AS scriptTitle,s.body AS scriptBody,
        s.disclosure_sha256 AS disclosureSha256,s.seller_name AS sellerName,s.company_name AS companyName,s.purpose
        FROM call_attempts a JOIN phone_numbers p ON p.tenant_id=a.tenant_id AND p.id=a.phone_id
        JOIN approved_calling_scripts s ON s.tenant_id=a.tenant_id AND s.version=a.script_version
        WHERE a.tenant_id=? AND a.lead_id=? AND a.representative_user_id=? AND a.ended_at IS NULL
        ORDER BY a.started_at DESC LIMIT 1`).get(tid, leadId, userId(req)) as any;
      res.json({ lead: publicCandidate(candidate), attempts, callbacks, consent,
        openAttempt: openAttempt ? { attemptId: openAttempt.attemptId, startedAt: openAttempt.startedAt,
          maskedPhone: openAttempt.maskedPhone, script: { id: openAttempt.scriptId, version: openAttempt.scriptVersion,
            title: openAttempt.scriptTitle, body: openAttempt.scriptBody, disclosureSha256: openAttempt.disclosureSha256,
            sellerName: openAttempt.sellerName, companyName: openAttempt.companyName, purpose: openAttempt.purpose } } : null,
        timeline: auditTimeline(tid, leadId), fullPhoneNumberExposed: false });
    } catch (error) { fail(res, error); }
  });

  app.patch("/api/v1/calling/leads/:leadId/assignment", cap("calling.manage"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(z.object({ assignedUserId: idSchema.nullable() }).strict(), req, res); if (!body) return;
    try {
      const result = updateCallingAssignment({ tenantId: tid, leadId, assignedUserId: body.assignedUserId,
        actorUserId: userId(req), correlationId: correlationId(req) });
      res.json({ lead: publicCandidate(result.candidate), invalidatedAuthorizations: result.invalidatedAuthorizations,
        changed: result.changed });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/contacts", cap("calling.enrichment.request"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(manualContactSchema, req, res); if (!body) return;
    try {
      const environment = callingEnvironment(tid);
      if (!environment.enrichmentEnabled || !environment.pilotAllowed || !environment.secretsReady) {
        return res.status(409).json({ error: "Contact enrichment is disabled for this organization" });
      }
      const candidate = storeManualContact({ tenantId: tid, leadId, ...body });
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "contact.manual_imported",
        entityType: "lead", entityId: String(leadId), actorUserId: userId(req),
        metadata: { leadId, contactId: candidate.contactId, phoneId: candidate.phoneId,
          relationship: body.relationship, providerConfigId: body.providerConfigId } });
      res.status(201).json({ lead: publicCandidate(candidate) });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/enrich", cap("calling.enrichment.request"), async (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(enrichmentSchema, req, res); if (!body) return;
    try {
      const idempotencyKey = body.idempotencyKey ?? String(req.headers["idempotency-key"] ?? "");
      const parsedKey = idempotencySchema.safeParse(idempotencyKey);
      if (!parsedKey.success) return res.status(400).json({ error: "An idempotency key of at least 8 characters is required" });
      const result = await enrichCallingLead({ tenantId: tid, leadId, providerConfigId: body.providerConfigId,
        actorUserId: userId(req), idempotencyKey: parsedKey.data, correlationId: correlationId(req) });
      res.status(result.replayed ? 200 : 201).json({ ...result, candidate: result.candidate ? publicCandidate(result.candidate) : null });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/validate-phone", cap("calling.enrichment.request"), async (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(z.object({
      providerConfigId: uuidSchema.optional(),
      idempotencyKey: idempotencySchema.optional(),
    }).strict(), req, res); if (!body) return;
    try {
      if (!scopedCandidate(req, res, tid, leadId)) return;
      const idempotencyKey = body.idempotencyKey ?? String(req.headers["idempotency-key"] ?? "");
      const parsedKey = idempotencySchema.safeParse(idempotencyKey);
      if (!parsedKey.success) return res.status(400).json({ error: "An idempotency key of at least 8 characters is required" });
      const result = await validateCallingLeadPhone({ tenantId: tid, leadId,
        providerConfigId: body.providerConfigId, actorUserId: userId(req),
        idempotencyKey: parsedKey.data, correlationId: correlationId(req) });
      res.status(result.replayed ? 200 : 201).json({ ...result, candidate: publicCandidate(result.candidate) });
    } catch (error) { fail(res, error); }
  });

  // Manual evidence entry is deliberately manager-only. Calling reps cannot
  // assert line type, reachability, or reassignment status themselves.
  app.post("/api/v1/calling/leads/:leadId/phones/:phoneId/validation", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res);
    const phoneId = idSchema.safeParse(param(req, "phoneId")); if (!tid || !leadId) return;
    if (!phoneId.success) return res.status(400).json({ error: "Invalid phone id" });
    const body = parseBody(validationSchema, req, res); if (!body) return;
    try {
      const environment = callingEnvironment(tid);
      if (!environment.enrichmentEnabled || !environment.pilotAllowed || !environment.secretsReady) {
        return res.status(409).json({ error: "Phone validation is disabled for this organization" });
      }
      const provider = rawDb.prepare(`SELECT enabled,contract_status AS contractStatus,permitted_use_approved AS permittedUseApproved,
        contract_reference AS contractReference FROM contact_enrichment_providers WHERE tenant_id=? AND id=?`).get(tid, body.providerConfigId) as any;
      if (!provider || Number(provider.enabled) !== 1 || provider.contractStatus !== "approved"
          || Number(provider.permittedUseApproved) !== 1 || !provider.contractReference) {
        return res.status(400).json({ error: "Validation provider permitted use has not been approved" });
      }
      validatePhoneManually({ tenantId: tid, leadId, phoneId: phoneId.data, ...body, validDays: body.validDays ?? 30 });
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "phone.validated",
        entityType: "lead", entityId: String(leadId), actorUserId: userId(req), metadata: {
          leadId, phoneId: phoneId.data, providerConfigId: body.providerConfigId, lineType: body.lineType,
          reachable: body.reachable, reassignedRisk: body.reassignedRisk, evidenceRef: body.evidenceRef,
        } });
      res.json({ lead: publicCandidate(getCallingCandidate(tid, leadId)!) });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/evaluate", cap("calling.evaluate"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(z.object({}).strict(), req, res); if (!body) return;
    try {
      if (!scopedCandidate(req, res, tid, leadId)) return;
      const result = evaluateLeadCompliance({ tenantId: tid, actorUserId: userId(req), actorRole: role(req), leadId,
        canManage: isManager(req), manualActionConfirmed: false, correlationId: correlationId(req) });
      res.json(result);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/authorize-call", cap("calling.attempt.manual"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(authorizeSchema, req, res); if (!body) return;
    try {
      if (!scopedCandidate(req, res, tid, leadId)) return;
      const environment = callingEnvironment(tid);
      if (!environment.manualClickToCallEnabled) return res.status(409).json({ error: "Manual calling is disabled" });
      const result = issueCallAuthorization({ tenantId: tid, actorUserId: userId(req), actorRole: role(req), leadId,
        canManage: isManager(req), action: body.action, correlationId: correlationId(req) });
      res.status(201).json({ authorizationToken: result.token, expiresAt: result.expiresAt, decisionId: result.decisionId,
        maskedPhone: result.maskedPhone, script: result.script, manualActionRequired: true });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/attempts/start", cap("calling.attempt.manual"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(startAttemptSchema, req, res); if (!body) return;
    try {
      const result = startManualAttempt({ tenantId: tid, actorUserId: userId(req), actorRole: role(req),
        token: body.authorizationToken, correlationId: correlationId(req) });
      // This is the only endpoint allowed to return a full phone number. The
      // one-use token has already been atomically consumed before this response.
      res.status(201).json(result);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/attempts/:attemptId/copy-number", cap("calling.attempt.manual"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const attemptId = uuidSchema.safeParse(param(req, "attemptId"));
    if (!attemptId.success) return res.status(400).json({ error: "Invalid attempt id" });
    const body = parseBody(z.object({}).strict(), req, res); if (!body) return;
    try {
      assertRepresentativeCallingNotHeld(tid, userId(req));
      rawDb.transaction(() => {
        const attempt = rawDb.prepare(`SELECT lead_id AS leadId,phone_id AS phoneId FROM call_attempts
          WHERE tenant_id=? AND id=? AND representative_user_id=? AND ended_at IS NULL`)
          .get(tid, attemptId.data, userId(req)) as any;
        if (!attempt) throw Object.assign(new Error("Open manual attempt not found"), { status: 404 });
        const environment = callingEnvironment(tid);
        const profile = ensureCallingProfile(tid);
        if (!environment.moduleEnabled || !environment.manualClickToCallEnabled || environment.emergencyDisabled
            || !environment.pilotAllowed || !environment.secretsReady || !profile.callingEnabled
            || profile.emergencyDisabled || !profile.callerIdAuthorized || !profile.callerIdReference) {
          throw Object.assign(new Error("Calling is currently disabled; the number was not copied"), { status: 409 });
        }
        const candidate = getCallingCandidate(tid, attempt.leadId);
        if (!candidate || candidate.phoneId !== attempt.phoneId || candidate.queueStage === "SUPPRESSED"
            || candidate.phoneValidationStatus === "INTERNAL_DNC"
            || internalDncHit(tid, candidate.phoneHash) || platformDncHit(tid, attempt.phoneId)) {
          throw Object.assign(new Error("This number is suppressed; the number was not copied"), { status: 409 });
        }
        appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "call.number_copied",
          entityType: "lead", entityId: String(attempt.leadId), actorUserId: userId(req),
          metadata: { leadId: attempt.leadId, phoneId: attempt.phoneId, attemptId: attemptId.data,
            manualAction: true, automaticDial: false } });
      }).immediate();
      res.json({ audited: true });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/attempts/:attemptId/dispositions", cap("calling.disposition.write"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const attemptId = uuidSchema.safeParse(param(req, "attemptId"));
    if (!attemptId.success) return res.status(400).json({ error: "Invalid attempt id" });
    const body = parseBody(dispositionSchema, req, res); if (!body) return;
    if (body.callbackTimeZone && !validTimeZone(body.callbackTimeZone)) return res.status(400).json({ error: "Invalid callback time zone" });
    const headerKey = String(req.headers["idempotency-key"] ?? "");
    const key = idempotencySchema.safeParse(body.idempotencyKey ?? headerKey);
    if (!key.success) return res.status(400).json({ error: "An idempotency key of at least 8 characters is required" });
    try {
      const result = recordCallDisposition({ tenantId: tid, actorUserId: userId(req), attemptId: attemptId.data,
        code: body.code, notes: body.notes, callbackAt: body.callbackAt, callbackTimeZone: body.callbackTimeZone,
        callbackConsentEvidenceRef: body.callbackConsentEvidenceRef,
        idempotencyKey: key.data, correlationId: correlationId(req) });
      res.status(result.replayed ? 200 : 201).json({ ...result, automaticNextCall: false });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/opt-out", cap("calling.opt_out.write"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(optOutSchema, req, res); if (!body) return;
    try {
      const candidate = scopedCandidate(req, res, tid, leadId); if (!candidate) return;
      if (!candidate.phoneId) return res.status(409).json({ error: "Lead has no phone to suppress" });
      const result = createInternalOptOut({ tenantId: tid, leadId, phoneId: candidate.phoneId, actorUserId: userId(req),
        reason: body.reason, channel: body.channel, sourceRef: body.sourceRef, correlationId: correlationId(req) });
      res.status(result.alreadySuppressed ? 200 : 201).json({ ...result, stage: "SUPPRESSED" });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/leads/:leadId/consent", cap("calling.disposition.write"), (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    const body = parseBody(consentSchema, req, res); if (!body) return;
    if (!validTimeZone(body.timeZone)) return res.status(400).json({ error: "Invalid consent time zone" });
    try {
      const candidate = scopedCandidate(req, res, tid, leadId); if (!candidate) return;
      const profile = ensureCallingProfile(tid);
      if (!candidate.phoneId || !candidate.contactId || !profile.sellerName || !profile.sellerAuthorized) {
        return res.status(409).json({ error: "Seller, contact, and phone must be configured before recording consent" });
      }
      const consentId = createConsentRecord({ ...body, tenantId: tid, organizationId: tid, leadId,
        contactId: candidate.contactId, phoneId: candidate.phoneId, seller: profile.sellerName,
        serviceAddress: `${candidate.address}, ${candidate.city}, ${candidate.state} ${candidate.zip}`,
        ipAddress: req.ip || null, actorUserId: userId(req), correlationId: correlationId(req) });
      res.status(201).json({ consentId, retainedYears: 5 });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/consents/:consentId/revoke", cap("calling.opt_out.write"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const consentId = uuidSchema.safeParse(param(req, "consentId"));
    if (!consentId.success) return res.status(400).json({ error: "Invalid consent id" });
    const body = parseBody(revokeSchema, req, res); if (!body) return;
    try {
      const consent = rawDb.prepare(`SELECT lead_id AS leadId,phone_id AS phoneId FROM consent_records WHERE tenant_id=? AND id=?`)
        .get(tid, consentId.data) as any;
      if (!consent?.leadId || !consent.phoneId) return res.status(404).json({ error: "Consent record not found" });
      const candidate = scopedCandidate(req, res, tid, Number(consent.leadId)); if (!candidate) return;
      const revocationId = revokeConsent({ tenantId: tid, leadId: Number(consent.leadId), consentId: consentId.data,
        phoneId: Number(consent.phoneId), actorUserId: userId(req), ...body, correlationId: correlationId(req) });
      res.status(201).json({ revocationId, stage: "SUPPRESSED" });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/callbacks", cap("calling.callback.write"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const limit = z.coerce.number().int().min(1).max(250).safeParse(req.query.limit ?? 100);
    if (!limit.success) return res.status(400).json({ error: "Invalid limit" });
    const rows = rawDb.prepare(`SELECT cb.id,cb.lead_id AS leadId,cb.due_at AS dueAt,cb.time_zone AS timeZone,cb.status,
      cb.assigned_user_id AS assignedUserId,l.address,l.city,l.state,l.zip,p.masked_display AS maskedPhone
      FROM callback_tasks cb JOIN leads l ON l.id=cb.lead_id AND l.tenant_id=cb.tenant_id
      JOIN phone_numbers p ON p.id=cb.phone_id AND p.tenant_id=cb.tenant_id
      WHERE cb.tenant_id=? AND cb.status='scheduled' AND (?=1 OR cb.assigned_user_id=?)
      ORDER BY cb.due_at LIMIT ?`).all(tid, isManager(req) ? 1 : 0, userId(req), limit.data);
    res.json({ callbacks: rows });
  });

  app.post("/api/v1/calling/callbacks/:callbackId/cancel", cap("calling.callback.write"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const callbackId = uuidSchema.safeParse(param(req, "callbackId"));
    if (!callbackId.success) return res.status(400).json({ error: "Invalid callback id" });
    const body = parseBody(z.object({ reason: z.string().trim().min(1).max(500) }).strict(), req, res); if (!body) return;
    const row = rawDb.prepare(`SELECT lead_id AS leadId,assigned_user_id AS assignedUserId FROM callback_tasks
      WHERE tenant_id=? AND id=? AND status='scheduled'`).get(tid, callbackId.data) as any;
    if (!row || (!isManager(req) && row.assignedUserId !== userId(req))) return res.status(404).json({ error: "Callback not found" });
    rawDb.prepare(`UPDATE callback_tasks SET status='cancelled',cancelled_at=datetime('now') WHERE tenant_id=? AND id=? AND status='scheduled'`)
      .run(tid, callbackId.data);
    appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "callback.cancelled",
      entityType: "lead", entityId: String(row.leadId), actorUserId: userId(req),
      metadata: { leadId: row.leadId, callbackId: callbackId.data, reason: body.reason } });
    res.json({ callbackId: callbackId.data, status: "cancelled" });
  });

  app.get("/api/v1/calling/leads/:leadId/decisions", requireDecisionRead, (req, res) => {
    const tid = requireTenant(req, res); const leadId = parseLeadId(req, res); if (!tid || !leadId) return;
    if (!scopedCandidate(req, res, tid, leadId)) return;
    const rows = rawDb.prepare(`SELECT id FROM compliance_decisions WHERE tenant_id=? AND lead_id=?
      ORDER BY evaluated_at DESC LIMIT 100`).all(tid, leadId) as Array<{ id: string }>;
    res.json({ decisions: rows.map((row) => getDecision(tid, row.id)) });
  });

  app.get("/api/v1/calling/decisions/:decisionId", requireDecisionRead, (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const decisionId = uuidSchema.safeParse(param(req, "decisionId"));
    if (!decisionId.success) return res.status(400).json({ error: "Invalid decision id" });
    const decision = getDecision(tid, decisionId.data);
    if (!decision) return res.status(404).json({ error: "Decision not found" });
    if (!scopedCandidate(req, res, tid, Number(decision.leadId))) return;
    res.json({ decision });
  });

  registerComplianceAdministration(app, deps);
}

function registerComplianceAdministration(app: Express, deps: CallingRouteDeps): void {
  const cap = deps.requireCapability;

  app.get("/api/v1/calling/compliance/representative-holds", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    try {
      res.json({
        representatives: listCallingRepresentatives(tid),
        history: listRepresentativeCallingHolds(tid),
      });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/representative-holds/:userId", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const representativeUserId = idSchema.safeParse(param(req, "userId"));
    if (!representativeUserId.success) return res.status(400).json({ error: "Invalid representative user id" });
    const body = parseBody(representativeHoldReasonSchema, req, res); if (!body) return;
    try {
      const result = placeRepresentativeCallingHold({ tenantId: tid,
        representativeUserId: representativeUserId.data, actorUserId: userId(req), reason: body.reason,
        correlationId: correlationId(req) });
      res.status(result.changed ? 201 : 200).json(result);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/representative-holds/:userId/release", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const representativeUserId = idSchema.safeParse(param(req, "userId"));
    if (!representativeUserId.success) return res.status(400).json({ error: "Invalid representative user id" });
    const body = parseBody(representativeHoldReasonSchema, req, res); if (!body) return;
    try {
      const hold = releaseRepresentativeCallingHold({ tenantId: tid,
        representativeUserId: representativeUserId.data, actorUserId: userId(req), reason: body.reason,
        correlationId: correlationId(req) });
      res.json({ hold, released: true, requiresFreshComplianceEvaluation: true });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/consent-artifacts", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(consentArtifactSchema, req, res); if (!body) return;
    try {
      const association = rawDb.prepare(`SELECT 1 FROM phone_address_associations
        WHERE tenant_id=? AND lead_id=? AND phone_id=?`).get(tid, body.leadId, body.phoneId);
      if (!association) return res.status(404).json({ error: "Lead phone association not found" });
      if (body.callAttemptId) {
        const attempt = rawDb.prepare(`SELECT 1 FROM call_attempts WHERE tenant_id=? AND id=? AND lead_id=? AND phone_id=?`)
          .get(tid, body.callAttemptId, body.leadId, body.phoneId);
        if (!attempt) return res.status(400).json({ error: "Artifact call attempt does not match this lead and phone" });
      }
      if (!verifyConsentArtifactManifest({ tenantId: tid, leadId: body.leadId, phoneId: body.phoneId,
        callAttemptId: body.callAttemptId ?? null, artifactType: body.artifactType,
        storageProvider: body.storageProvider, storageRef: body.storageRef,
        artifactSha256: body.artifactSha256, capturedAt: body.capturedAt,
        retentionUntil: body.retentionUntil, verificationEvidenceRef: body.verificationEvidenceRef,
      }, body.manifestSignature)) {
        return res.status(400).json({ error: "Consent artifact storage attestation signature is invalid or unavailable" });
      }
      const signatureHash = sha256(body.manifestSignature.toLowerCase());
      const existing = rawDb.prepare(`SELECT id,lead_id AS leadId,phone_id AS phoneId,call_attempt_id AS callAttemptId,
        artifact_type AS artifactType,storage_provider AS storageProvider,storage_ref AS storageRef,
        artifact_sha256 AS artifactSha256,captured_at AS capturedAt,retention_until AS retentionUntil,
        verification_evidence_ref AS verificationEvidenceRef,manifest_signature_sha256 AS manifestSignatureSha256,
        verified_at AS verifiedAt FROM consent_evidence_artifacts
        WHERE tenant_id=? AND (storage_ref=? OR artifact_sha256=?) LIMIT 1`)
        .get(tid, body.storageRef, body.artifactSha256.toLowerCase()) as any;
      if (existing) {
        const exact = Number(existing.leadId) === body.leadId && Number(existing.phoneId) === body.phoneId
          && (existing.callAttemptId ?? null) === (body.callAttemptId ?? null)
          && existing.artifactType === body.artifactType && existing.storageProvider === body.storageProvider
          && existing.storageRef === body.storageRef && existing.artifactSha256 === body.artifactSha256.toLowerCase()
          && existing.capturedAt === body.capturedAt && existing.retentionUntil === body.retentionUntil
          && existing.verificationEvidenceRef === body.verificationEvidenceRef
          && existing.manifestSignatureSha256 === signatureHash;
        if (!exact) return res.status(409).json({ error: "Artifact storage reference or hash was already registered with different evidence" });
        return res.status(200).json({ artifactId: existing.id, artifactSha256: existing.artifactSha256,
          verifiedAt: existing.verifiedAt, replayed: true });
      }
      const id = crypto.randomUUID();
      const verifiedAt = new Date().toISOString();
      rawDb.prepare(`INSERT INTO consent_evidence_artifacts
        (id,tenant_id,lead_id,phone_id,call_attempt_id,artifact_type,storage_provider,storage_ref,artifact_sha256,
         captured_at,retention_until,verification_method,verification_evidence_ref,manifest_signature_sha256,verified_by,verified_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tid, body.leadId, body.phoneId, body.callAttemptId ?? null,
          body.artifactType, body.storageProvider, body.storageRef, body.artifactSha256.toLowerCase(), body.capturedAt,
          body.retentionUntil, "signed_storage_attestation_v1", body.verificationEvidenceRef,
          signatureHash, userId(req), verifiedAt);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "consent.artifact_verified",
        entityType: "consent_artifact", entityId: id, actorUserId: userId(req), metadata: {
          leadId: body.leadId, phoneId: body.phoneId, callAttemptId: body.callAttemptId ?? null,
          artifactType: body.artifactType, artifactSha256: body.artifactSha256.toLowerCase(),
          storageProvider: body.storageProvider, storageRefSha256: sha256(body.storageRef),
          verificationEvidenceRefSha256: sha256(body.verificationEvidenceRef), retentionUntil: body.retentionUntil,
        } });
      res.status(201).json({ artifactId: id, artifactSha256: body.artifactSha256.toLowerCase(), verifiedAt, replayed: false });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/consent-artifacts", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const query = z.object({ leadId: idSchema, limit: z.coerce.number().int().min(1).max(100).default(25) })
      .strict().safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid artifact query", details: query.error.flatten() });
    const rows = rawDb.prepare(`SELECT id,lead_id AS leadId,phone_id AS phoneId,call_attempt_id AS callAttemptId,
      artifact_type AS artifactType,artifact_sha256 AS artifactSha256,captured_at AS capturedAt,
      retention_until AS retentionUntil,storage_provider AS storageProvider,verification_method AS verificationMethod,
      verification_evidence_ref AS verificationEvidenceRef,verified_by AS verifiedBy,verified_at AS verifiedAt
      FROM consent_evidence_artifacts WHERE tenant_id=? AND lead_id=? ORDER BY captured_at DESC LIMIT ?`)
      .all(tid, query.data.leadId, query.data.limit);
    res.json({ artifacts: rows });
  });

  app.get("/api/v1/calling/compliance/summary", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    try {
      const stages = rawDb.prepare(`SELECT stage,count(*) AS count FROM calling_queue_entries WHERE tenant_id=? GROUP BY stage ORDER BY stage`).all(tid);
      const decisions = rawDb.prepare(`SELECT final_status AS status,count(*) AS count FROM compliance_decisions
        WHERE tenant_id=? AND evaluated_at>=datetime('now','-30 days') GROUP BY final_status ORDER BY final_status`).all(tid);
      const profile = ensureCallingProfile(tid);
      res.json({ profile, environment: callingEnvironment(tid), dnc: dncStatus(tid), stages, decisions,
        allowedDecisions: CALLING_DECISIONS, activeScript: activeScript(tid), activeRuleVersion: activeRuleVersion(tid) });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/config", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    try { res.json({ profile: ensureCallingProfile(tid), environment: callingEnvironment(tid) }); }
    catch (error) { fail(res, error); }
  });

  app.patch("/api/v1/calling/compliance/config", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(profilePatchSchema, req, res); if (!body) return;
    if (body.defaultTimeZone && !validTimeZone(body.defaultTimeZone)) return res.status(400).json({ error: "Invalid default time zone" });
    try {
      const current = ensureCallingProfile(tid);
      const merged = {
        callingEnabled: body.callingEnabled ?? current.callingEnabled,
        emergencyDisabled: body.emergencyDisabled ?? current.emergencyDisabled,
        counselApproved: body.counselApproved ?? current.counselApproved,
        sellerAuthorized: body.sellerAuthorized ?? current.sellerAuthorized,
        sellerName: body.sellerName ?? current.sellerName ?? "",
        sellerAuthorizationRef: body.sellerAuthorizationRef ?? current.sellerAuthorizationRef ?? "",
        stateRulesApproved: body.stateRulesApproved ?? current.stateRulesApproved,
        defaultTimeZone: body.defaultTimeZone ?? current.defaultTimeZone,
        allowedStartLocal: body.allowedStartLocal ?? current.allowedStartLocal,
        allowedEndLocal: body.allowedEndLocal ?? current.allowedEndLocal,
        minimumIdentityConfidence: body.minimumIdentityConfidence ?? current.minimumIdentityConfidence,
        maxAttempts7Days: body.maxAttempts7Days ?? current.maxAttempts7Days,
        maxAttempts30Days: body.maxAttempts30Days ?? current.maxAttempts30Days,
        dncMaxAgeDays: body.dncMaxAgeDays ?? current.dncMaxAgeDays,
        propagateOptOutPlatformWide: body.propagateOptOutPlatformWide ?? current.propagateOptOutPlatformWide,
        callerIdAuthorized: body.callerIdAuthorized ?? current.callerIdAuthorized,
        callerIdReference: body.callerIdReference ?? current.callerIdReference ?? "",
      };
      const startMinute = localMinute(merged.allowedStartLocal);
      const endMinute = localMinute(merged.allowedEndLocal);
      if (startMinute < 8 * 60 || endMinute > 21 * 60 || startMinute >= endMinute) {
        return res.status(400).json({ error: "Calling hours may narrow but never exceed 08:00–21:00 local time" });
      }
      if (merged.maxAttempts30Days < merged.maxAttempts7Days) {
        return res.status(400).json({ error: "30-day attempt limit cannot be lower than the 7-day limit" });
      }
      const profile = updateCallingProfile(tid, userId(req), merged);
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='POLICY_CHANGED'
        WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "compliance.profile_updated",
        entityType: "organization", entityId: String(tid), actorUserId: userId(req),
        metadata: { changedFields: Object.keys(body), policyVersion: profile.policyVersion,
          callingEnabled: profile.callingEnabled, emergencyDisabled: profile.emergencyDisabled } });
      res.json({ profile });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/scripts", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const rows = rawDb.prepare(`SELECT id,version,title,body,disclosure_sha256 AS disclosureSha256,seller_name AS sellerName,
      company_name AS companyName,purpose,active,counsel_approved AS counselApproved,approved_by AS approvedBy,
      approved_at AS approvedAt,counsel_approval_reference AS counselApprovalReference,created_at AS createdAt
      FROM approved_calling_scripts WHERE tenant_id=? ORDER BY created_at DESC`).all(tid) as any[];
    res.json({ scripts: rows.map((row) => ({ ...row, active: Number(row.active) === 1, counselApproved: Number(row.counselApproved) === 1 })) });
  });

  app.post("/api/v1/calling/compliance/scripts", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(scriptSchema, req, res); if (!body) return;
    try {
      const id = crypto.randomUUID();
      rawDb.transaction(() => {
        if (body.active) rawDb.prepare("UPDATE approved_calling_scripts SET active=0 WHERE tenant_id=?").run(tid);
        rawDb.prepare(`INSERT INTO approved_calling_scripts
          (id,tenant_id,version,title,body,disclosure_sha256,seller_name,company_name,purpose,active,counsel_approved,
           counsel_approval_reference,approved_by,approved_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tid, body.version, body.title, body.body, sha256(body.body), body.sellerName,
            body.companyName, body.purpose, body.active ? 1 : 0, body.counselApproved ? 1 : 0,
            body.counselApprovalReference,
            body.counselApproved ? userId(req) : null, body.counselApproved ? new Date().toISOString() : null);
        rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='SCRIPT_CHANGED'
          WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
        appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "calling.script_created",
          entityType: "script", entityId: id, actorUserId: userId(req), metadata: { version: body.version,
            active: body.active, counselApproved: body.counselApproved,
            counselApprovalReference: body.counselApprovalReference, disclosureSha256: sha256(body.body) } });
      }).immediate();
      res.status(201).json({ id, version: body.version, active: body.active });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/rules", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const rows = rawDb.prepare(`SELECT id,version,rules_sha256 AS rulesSha256,config_json AS configJson,active,
      counsel_approval_reference AS counselApprovalReference,approved_by AS approvedBy,approved_at AS approvedAt,created_at AS createdAt
      FROM calling_rule_versions WHERE tenant_id=? ORDER BY created_at DESC`).all(tid) as any[];
    res.json({ rules: rows.map((row) => ({ ...row, active: Number(row.active) === 1,
      config: JSON.parse(row.configJson), configJson: undefined })) });
  });

  app.post("/api/v1/calling/compliance/rules", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(ruleSchema, req, res); if (!body) return;
    try {
      const id = crypto.randomUUID();
      const configJson = JSON.stringify(body.config);
      rawDb.transaction(() => {
        if (body.active) rawDb.prepare("UPDATE calling_rule_versions SET active=0 WHERE tenant_id=?").run(tid);
        rawDb.prepare(`INSERT INTO calling_rule_versions
          (id,tenant_id,version,rules_sha256,config_json,active,counsel_approval_reference,approved_by,approved_at)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(id, tid, body.version, sha256(configJson), configJson, body.active ? 1 : 0,
            body.counselApprovalReference,
            body.active ? userId(req) : null, body.active ? new Date().toISOString() : null);
        rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='RULES_CHANGED'
          WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
        appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "compliance.rules_created",
          entityType: "rule_version", entityId: id, actorUserId: userId(req), metadata: { version: body.version,
            active: body.active, rulesSha256: sha256(configJson), counselApprovalReference: body.counselApprovalReference } });
      }).immediate();
      res.status(201).json({ id, version: body.version, active: body.active });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/registrations", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const rows = rawDb.prepare(`SELECT id,state,legal_entity AS legalEntity,registration_type AS registrationType,
      registration_number AS registrationNumber,exemption_type AS exemptionType,evidence_ref AS evidenceRef,
      counsel_approved AS counselApproved,effective_at AS effectiveAt,expires_at AS expiresAt,
      last_reviewed_at AS lastReviewedAt,status,created_at AS createdAt,updated_at AS updatedAt
      FROM state_registrations WHERE tenant_id=? ORDER BY state,effective_at DESC`).all(tid) as any[];
    res.json({ registrations: rows.map((row) => ({ ...row, counselApproved: Number(row.counselApproved) === 1 })) });
  });

  app.get("/api/v1/calling/compliance/seller-authorizations", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const rows = rawDb.prepare(`SELECT id,seller_name AS sellerName,authorization_ref AS authorizationRef,
      effective_at AS effectiveAt,expires_at AS expiresAt,status,evidence_sha256 AS evidenceSha256,
      created_by AS createdBy,created_at AS createdAt FROM seller_authorizations
      WHERE tenant_id=? ORDER BY effective_at DESC`).all(tid);
    res.json({ authorizations: rows });
  });

  app.post("/api/v1/calling/compliance/seller-authorizations", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(sellerAuthorizationSchema, req, res); if (!body) return;
    try {
      const id = crypto.randomUUID();
      rawDb.prepare(`INSERT INTO seller_authorizations
        (id,tenant_id,seller_name,authorization_ref,effective_at,expires_at,status,evidence_sha256,created_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, tid, body.sellerName, body.authorizationRef, body.effectiveAt,
          body.expiresAt ?? null, body.status, body.evidenceSha256.toLowerCase(), userId(req));
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='SELLER_AUTHORIZATION_CHANGED'
        WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "compliance.seller_authorization_created",
        entityType: "seller_authorization", entityId: id, actorUserId: userId(req), metadata: {
          sellerName: body.sellerName, authorizationRef: body.authorizationRef, effectiveAt: body.effectiveAt,
          expiresAt: body.expiresAt ?? null, status: body.status, evidenceSha256: body.evidenceSha256.toLowerCase(),
        } });
      res.status(201).json({ id });
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/registrations", cap("calling.policy.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(registrationSchema, req, res); if (!body) return;
    try {
      const id = crypto.randomUUID();
      rawDb.prepare(`INSERT INTO state_registrations
        (id,tenant_id,state,legal_entity,registration_type,registration_number,exemption_type,evidence_ref,
         counsel_approved,effective_at,expires_at,last_reviewed_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tid, body.state, body.legalEntity, body.registrationType,
          body.registrationNumber ?? null, body.exemptionType ?? null, body.evidenceRef, body.counselApproved ? 1 : 0,
          body.effectiveAt, body.expiresAt ?? null, body.lastReviewedAt, body.status);
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='REGISTRATION_CHANGED'
        WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "compliance.registration_created",
        entityType: "state_registration", entityId: id, actorUserId: userId(req), metadata: {
          state: body.state, registrationType: body.registrationType, status: body.status, evidenceRef: body.evidenceRef,
        } });
      res.status(201).json({ id });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/providers", cap("calling.providers.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const rows = rawDb.prepare(`SELECT id,provider_name AS providerName,adapter_type AS adapterType,enabled,priority,
      contract_status AS contractStatus,permitted_use_approved AS permittedUseApproved,
      permitted_uses_json AS permittedUsesJson,contract_reference AS contractReference,
      contract_evidence_sha256 AS contractEvidenceSha256,query_cost_micros AS queryCostMicros,
      cache_ttl_seconds AS cacheTtlSeconds,retention_days AS retentionDays,deletion_obligations AS deletionObligations,
      rate_limit_per_minute AS rateLimitPerMinute,secret_env_name AS secretEnvName,base_url AS baseUrl,
      daily_budget_micros AS dailyBudgetMicros,monthly_budget_micros AS monthlyBudgetMicros,
      circuit_open_until AS circuitOpenUntil,last_health_at AS lastHealthAt,last_health_status AS lastHealthStatus
      FROM contact_enrichment_providers WHERE tenant_id=? ORDER BY priority,provider_name`).all(tid) as any[];
    res.json({ providers: rows.map(providerPublic) });
  });

  app.post("/api/v1/calling/compliance/providers", cap("calling.providers.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(providerSchema, req, res); if (!body) return;
    try {
      const id = crypto.randomUUID();
      rawDb.prepare(`INSERT INTO contact_enrichment_providers
        (id,tenant_id,provider_name,adapter_type,enabled,priority,contract_status,permitted_use_approved,
         permitted_uses_json,contract_reference,contract_evidence_sha256,query_cost_micros,cache_ttl_seconds,
         retention_days,deletion_obligations,rate_limit_per_minute,secret_env_name,base_url,daily_budget_micros,monthly_budget_micros)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tid, body.providerName, body.adapterType,
          body.enabled ? 1 : 0, body.priority, body.contractStatus, body.permittedUseApproved ? 1 : 0,
          JSON.stringify(body.permittedUses), body.contractReference ?? null, body.contractEvidenceSha256 ?? null,
          body.queryCostMicros, body.cacheTtlSeconds, body.retentionDays, body.deletionObligations ?? null,
          body.rateLimitPerMinute, body.secretEnvName ?? null, body.baseUrl ?? null, body.dailyBudgetMicros, body.monthlyBudgetMicros);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "provider.configuration_created",
        entityType: "provider_config", entityId: id, actorUserId: userId(req), metadata: {
          providerName: body.providerName, adapterType: body.adapterType, enabled: body.enabled,
          contractStatus: body.contractStatus, permittedUseApproved: body.permittedUseApproved,
          contractReference: body.contractReference, contractEvidenceSha256: body.contractEvidenceSha256,
        } });
      res.status(201).json({ id });
    } catch (error) { fail(res, error); }
  });

  app.patch("/api/v1/calling/compliance/providers/:providerId", cap("calling.providers.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const providerId = uuidSchema.safeParse(param(req, "providerId"));
    if (!providerId.success) return res.status(400).json({ error: "Invalid provider id" });
    const body = parseBody(providerPatchSchema, req, res); if (!body) return;
    try {
      const existing = rawDb.prepare(`SELECT provider_name AS providerName,adapter_type AS adapterType,enabled,priority,
        contract_status AS contractStatus,permitted_use_approved AS permittedUseApproved,
        permitted_uses_json AS permittedUsesJson,contract_reference AS contractReference,
        contract_evidence_sha256 AS contractEvidenceSha256,query_cost_micros AS queryCostMicros,
        cache_ttl_seconds AS cacheTtlSeconds,retention_days AS retentionDays,deletion_obligations AS deletionObligations,
        rate_limit_per_minute AS rateLimitPerMinute,secret_env_name AS secretEnvName,base_url AS baseUrl,
        daily_budget_micros AS dailyBudgetMicros,monthly_budget_micros AS monthlyBudgetMicros
        FROM contact_enrichment_providers WHERE tenant_id=? AND id=?`).get(tid, providerId.data) as any;
      if (!existing) return res.status(404).json({ error: "Provider configuration not found" });
      let permittedUses: string[] = [];
      try { permittedUses = JSON.parse(existing.permittedUsesJson); } catch { permittedUses = []; }
      const merged = providerSchema.parse({
        providerName: body.providerName ?? existing.providerName,
        adapterType: body.adapterType ?? existing.adapterType,
        enabled: body.enabled ?? Number(existing.enabled) === 1,
        priority: body.priority ?? existing.priority,
        contractStatus: body.contractStatus ?? existing.contractStatus,
        permittedUseApproved: body.permittedUseApproved ?? Number(existing.permittedUseApproved) === 1,
        permittedUses: body.permittedUses ?? permittedUses,
        contractReference: body.contractReference === undefined ? existing.contractReference : body.contractReference,
        contractEvidenceSha256: body.contractEvidenceSha256 === undefined ? existing.contractEvidenceSha256 : body.contractEvidenceSha256,
        queryCostMicros: body.queryCostMicros ?? existing.queryCostMicros,
        cacheTtlSeconds: body.cacheTtlSeconds ?? existing.cacheTtlSeconds,
        retentionDays: body.retentionDays ?? existing.retentionDays,
        deletionObligations: body.deletionObligations === undefined ? existing.deletionObligations : body.deletionObligations,
        rateLimitPerMinute: body.rateLimitPerMinute ?? existing.rateLimitPerMinute,
        secretEnvName: body.secretEnvName === undefined ? existing.secretEnvName : body.secretEnvName,
        baseUrl: body.baseUrl === undefined ? existing.baseUrl : body.baseUrl,
        dailyBudgetMicros: body.dailyBudgetMicros ?? existing.dailyBudgetMicros,
        monthlyBudgetMicros: body.monthlyBudgetMicros ?? existing.monthlyBudgetMicros,
      });
      rawDb.prepare(`UPDATE contact_enrichment_providers SET provider_name=?,adapter_type=?,enabled=?,priority=?,
        contract_status=?,permitted_use_approved=?,permitted_uses_json=?,contract_reference=?,contract_evidence_sha256=?,
        query_cost_micros=?,cache_ttl_seconds=?,retention_days=?,deletion_obligations=?,rate_limit_per_minute=?,
        secret_env_name=?,base_url=?,daily_budget_micros=?,monthly_budget_micros=?,updated_at=datetime('now')
        WHERE tenant_id=? AND id=?`).run(merged.providerName, merged.adapterType, merged.enabled ? 1 : 0, merged.priority,
          merged.contractStatus, merged.permittedUseApproved ? 1 : 0, JSON.stringify(merged.permittedUses),
          merged.contractReference ?? null, merged.contractEvidenceSha256 ?? null, merged.queryCostMicros,
          merged.cacheTtlSeconds, merged.retentionDays, merged.deletionObligations ?? null, merged.rateLimitPerMinute,
          merged.secretEnvName ?? null, merged.baseUrl ?? null, merged.dailyBudgetMicros, merged.monthlyBudgetMicros,
          tid, providerId.data);
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='PROVIDER_CHANGED'
        WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "provider.configuration_updated",
        entityType: "provider_config", entityId: providerId.data, actorUserId: userId(req),
        metadata: { changedFields: Object.keys(body), enabled: merged.enabled, contractStatus: merged.contractStatus,
          permittedUseApproved: merged.permittedUseApproved } });
      res.json({ provider: providerPublic({ id: providerId.data, ...merged, permittedUsesJson: JSON.stringify(merged.permittedUses),
        enabled: merged.enabled ? 1 : 0, permittedUseApproved: merged.permittedUseApproved ? 1 : 0 }) });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/dnc/status", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    try { res.json(dncStatus(tid)); } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/dnc/imports", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const limit = z.coerce.number().int().min(1).max(500).safeParse(req.query.limit ?? 100);
    if (!limit.success) return res.status(400).json({ error: "Invalid limit" });
    try { res.json({ imports: listDncImports(tid, limit.data) }); } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/dnc/imports", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(dncManifestBaseSchema, req, res); if (!body) return;
    try {
      const result = beginDncImport({ tenantId: tid, sourceType: body.sourceType, state: body.state ?? null,
        versionLabel: body.versionLabel, authorizedAccountRef: body.authorizedAccountRef,
        coveredAreaCodes: body.coveredAreaCodes, expectedRecordCount: body.expectedRecordCount,
        expectedChunkCount: body.expectedChunkCount, chunkSize: body.chunkSize,
        sourceManifestSha256: body.sourceManifestSha256,
        sourceAsOf: body.sourceAsOf, sourceRetrievedAt: body.sourceRetrievedAt,
        maxAgeDays: body.maxAgeDays ?? 31, manifestSignature: body.manifestSignature, actorUserId: userId(req) });
      if (!result.replayed) appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "dnc.import_started",
        entityType: "dnc_import", entityId: result.importId, actorUserId: userId(req), metadata: {
          sourceType: body.sourceType, state: body.state ?? null, versionLabel: body.versionLabel,
          expectedRecordCount: body.expectedRecordCount, expectedChunkCount: body.expectedChunkCount,
          chunkSize: body.chunkSize, sourceManifestSha256: body.sourceManifestSha256, sourceAsOf: body.sourceAsOf,
          sourceRetrievedAt: body.sourceRetrievedAt,
        } });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/dnc/imports/:importId/chunks", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const importId = uuidSchema.safeParse(param(req, "importId"));
    if (!importId.success) return res.status(400).json({ error: "Invalid DNC import id" });
    const body = parseBody(dncChunkSchema, req, res); if (!body) return;
    try {
      const result = appendDncImportChunk({ tenantId: tid, importId: importId.data,
        chunkIndex: body.chunkIndex, phones: body.phones });
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "dnc.import_chunk_staged",
        entityType: "dnc_import", entityId: importId.data, actorUserId: userId(req), metadata: {
          chunkIndex: body.chunkIndex, accepted: result.accepted, rejected: result.rejected,
          stagedUnique: result.stagedUnique, sourceChunkSha256: result.sourceChunkSha256, replayed: result.replayed,
        } });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/dnc/imports/:importId/finalize", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const importId = uuidSchema.safeParse(param(req, "importId"));
    if (!importId.success) return res.status(400).json({ error: "Invalid DNC import id" });
    const body = parseBody(z.object({}).strict(), req, res); if (!body) return;
    try {
      const result = finalizeDncImport({ tenantId: tid, importId: importId.data, actorUserId: userId(req) });
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='DNC_DATA_CHANGED'
        WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "dnc.import_finalized",
        entityType: "dnc_dataset", entityId: result.datasetId, actorUserId: userId(req), metadata: {
          importId: importId.data, recordCount: result.recordCount, checksum: result.checksum,
          expiresAt: result.expiresAt,
        } });
      res.status(201).json(result);
    } catch (error) { fail(res, error); }
  });

  app.post("/api/v1/calling/compliance/dnc/import", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const body = parseBody(dncImportSchema, req, res); if (!body) return;
    try {
      if (process.env.NODE_ENV === "production" || process.env.DNC_ALLOW_DIRECT_IMPORT !== "true") {
        return res.status(409).json({ error: "Direct DNC imports are disabled; use the signed resumable import pipeline" });
      }
      const result = importDncDataset({ tenantId: tid, sourceType: body.sourceType, state: body.state,
        versionLabel: body.versionLabel, authorizedAccountRef: body.authorizedAccountRef,
        coveredAreaCodes: body.coveredAreaCodes ?? [], phones: body.phones, maxAgeDays: body.maxAgeDays ?? 31,
        actorUserId: userId(req) });
      rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='DNC_DATA_CHANGED'
        WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
      appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "dnc.dataset_imported",
        entityType: "dnc_dataset", entityId: result.id, actorUserId: userId(req), metadata: {
          sourceType: body.sourceType, state: body.state ?? null, versionLabel: body.versionLabel,
          authorizedAccountRef: body.authorizedAccountRef, imported: result.imported, rejected: result.rejected,
          checksum: result.checksum,
        } });
      res.status(201).json(result);
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/dnc/internal", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const limit = z.coerce.number().int().min(1).max(500).safeParse(req.query.limit ?? 100);
    if (!limit.success) return res.status(400).json({ error: "Invalid limit" });
    const rows = rawDb.prepare(`SELECT d.id,p.masked_display AS maskedPhone,d.reason,d.channel,d.source_ref AS sourceRef,
      d.active,d.created_by AS createdBy,d.created_at AS createdAt,d.corrected_at AS correctedAt,
      d.correction_reason AS correctionReason FROM internal_dnc_entries d
      LEFT JOIN phone_numbers p ON p.tenant_id=d.tenant_id AND p.phone_hash=d.phone_hash
      WHERE d.tenant_id=? ORDER BY d.created_at DESC LIMIT ?`).all(tid, limit.data) as any[];
    res.json({ entries: rows.map((row) => ({ ...row, active: Number(row.active) === 1 })) });
  });

  app.post("/api/v1/calling/compliance/dnc/internal/:dncId/correct", cap("calling.dnc.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const dncId = uuidSchema.safeParse(param(req, "dncId"));
    if (!dncId.success) return res.status(400).json({ error: "Invalid DNC entry id" });
    const body = parseBody(z.object({
      correctionReason: z.string().trim().min(10).max(1_000),
      evidenceRef: z.string().trim().min(3).max(1_000),
    }).strict(), req, res); if (!body) return;
    try {
      rawDb.transaction(() => {
        const entry = rawDb.prepare(`SELECT id,phone_hash AS phoneHash,active FROM internal_dnc_entries
          WHERE tenant_id=? AND id=?`).get(tid, dncId.data) as any;
        if (!entry) throw Object.assign(new Error("Internal DNC entry not found"), { status: 404 });
        const previous = rawDb.prepare(`SELECT event_sha256 AS hash FROM suppression_events
          WHERE tenant_id=? AND internal_dnc_id=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(tid, dncId.data) as any;
        const eventId = crypto.randomUUID();
        const at = new Date().toISOString();
        const eventSha256 = sha256(JSON.stringify({ eventId, dncId: dncId.data, type: "CORRECTION_NOTED",
          correctionReason: body.correctionReason, evidenceRef: body.evidenceRef, actor: userId(req), at,
          previous: previous?.hash ?? null, suppressionRemainsActive: true }));
        // Entity-specific opt-outs are permanent. A correction annotates the
        // append-only record; it never deletes or reactivates the number.
        rawDb.prepare(`UPDATE internal_dnc_entries SET corrected_by=?,corrected_at=?,correction_reason=?
          WHERE tenant_id=? AND id=?`).run(userId(req), at, body.correctionReason, tid, dncId.data);
        rawDb.prepare(`INSERT INTO suppression_events
          (id,tenant_id,internal_dnc_id,event_type,actor_user_id,channel,reason,metadata_json,
           previous_event_sha256,event_sha256,created_at)
          VALUES (?,?,?,'CORRECTION_NOTED',?,'compliance_admin',?,?,?,?,?)`).run(eventId, tid, dncId.data,
            userId(req), body.correctionReason, JSON.stringify({ evidenceRef: body.evidenceRef, suppressionRemainsActive: true }),
            previous?.hash ?? null, eventSha256, at);
        rawDb.prepare(`UPDATE call_authorizations SET invalidated_at=datetime('now'),invalidation_reason='DNC_CORRECTION_NOTED'
          WHERE tenant_id=? AND used_at IS NULL AND invalidated_at IS NULL`).run(tid);
        appendCallingAudit({ tenantId: tid, correlationId: correlationId(req), eventType: "dnc.correction_noted",
          entityType: "internal_dnc", entityId: dncId.data, actorUserId: userId(req), metadata: {
            correctionReason: body.correctionReason, evidenceRef: body.evidenceRef, suppressionRemainsActive: true,
          } });
      }).immediate();
      res.json({ dncId: dncId.data, active: true, suppressionRemainsPermanent: true });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/provider-usage", cap("calling.providers.manage"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    try { res.json({ providers: providerCostMetrics(tid) }); } catch (error) { fail(res, error); }
  });

  app.get("/api/v1/calling/compliance/audit", cap("calling.compliance.read"), (req, res) => {
    const tid = requireTenant(req, res); if (!tid) return;
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      eventType: z.string().trim().min(1).max(120).optional() }).strict().safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid audit query", details: query.error.flatten() });
    const conditions = ["tenant_id=?"];
    const args: unknown[] = [tid];
    if (query.data.eventType) { conditions.push("event_type=?"); args.push(query.data.eventType); }
    args.push(query.data.limit, query.data.offset);
    const rows = rawDb.prepare(`SELECT id,correlation_id AS correlationId,event_type AS eventType,
      entity_type AS entityType,entity_id AS entityId,actor_user_id AS actorUserId,metadata_json AS metadataJson,
      previous_event_sha256 AS previousEventSha256,event_sha256 AS eventSha256,created_at AS createdAt
      FROM calling_audit_events WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .all(...args) as any[];
    res.json({ events: rows.map((row) => ({ ...row, metadata: JSON.parse(row.metadataJson), metadataJson: undefined })) });
  });
}
