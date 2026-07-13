export const ONBOARDING_DOCUMENT_TYPES = [
  "independent_contractor",
  "commission_agreement",
  "confidentiality",
  "field_safety",
] as const;

export type OnboardingDocumentType = typeof ONBOARDING_DOCUMENT_TYPES[number];

export const ONBOARDING_DOCUMENT_META: Record<OnboardingDocumentType, {
  label: string;
  description: string;
  required: boolean;
}> = {
  independent_contractor: {
    label: "Independent Contractor Agreement",
    description: "Engagement terms, responsibilities, and contractor relationship.",
    required: true,
  },
  commission_agreement: {
    label: "Commission Agreement",
    description: "Compensation plan, qualification rules, adjustments, and payment timing.",
    required: true,
  },
  confidentiality: {
    label: "Confidentiality & Data Security",
    description: "Customer information, credentials, leads, and company-data safeguards.",
    required: true,
  },
  field_safety: {
    label: "Field Safety & Conduct",
    description: "Door-to-door conduct, identification, safety, and escalation standards.",
    required: true,
  },
};

export const ONBOARDING_DOCUMENT_STATUSES = [
  "creating", "sent", "delivered", "completed", "declined", "voided", "failed",
] as const;
export type OnboardingDocumentStatus = typeof ONBOARDING_DOCUMENT_STATUSES[number];

export const ACTIVE_DOCUMENT_STATUSES = new Set<OnboardingDocumentStatus>([
  "creating", "sent", "delivered",
]);

export function normalizeDocusignStatus(value: unknown): OnboardingDocumentStatus | null {
  const status = String(value ?? "").trim().toLowerCase();
  if (status === "created" || status === "sent") return "sent";
  if (status === "delivered") return "delivered";
  if (status === "completed" || status === "signed") return "completed";
  if (status === "declined") return "declined";
  if (status === "voided") return "voided";
  return null;
}

const STATUS_RANK: Record<OnboardingDocumentStatus, number> = {
  creating: 0,
  sent: 1,
  delivered: 2,
  completed: 4,
  declined: 4,
  voided: 4,
  failed: 4,
};

export function shouldApplyDocumentStatus(
  current: OnboardingDocumentStatus,
  incoming: OnboardingDocumentStatus,
): boolean {
  if (current === incoming) return false;
  if (["completed", "declined", "voided"].includes(current)) return false;
  return STATUS_RANK[incoming] >= STATUS_RANK[current];
}

export function canOpenSigning(status: OnboardingDocumentStatus): boolean {
  return status === "sent" || status === "delivered";
}

export interface DocusignConnectIntent {
  envelopeId: string;
  status: OnboardingDocumentStatus;
  eventType: string;
  occurredAt: string | null;
}

export function parseDocusignConnectEvent(payload: any): DocusignConnectIntent | null {
  const summary = payload?.data?.envelopeSummary ?? payload?.envelopeSummary ?? payload?.data ?? payload;
  const envelopeId = String(payload?.data?.envelopeId ?? summary?.envelopeId ?? "").trim();
  const eventType = String(payload?.event ?? summary?.status ?? "").trim();
  const eventStatus = eventType.toLowerCase().startsWith("envelope-")
    ? eventType.slice("envelope-".length)
    : eventType;
  const status = normalizeDocusignStatus(summary?.status ?? eventStatus);
  if (!envelopeId || !status) return null;
  const occurred = payload?.generatedDateTime ?? summary?.statusChangedDateTime ?? null;
  return {
    envelopeId,
    status,
    eventType: eventType || `envelope-${status}`,
    occurredAt: occurred ? String(occurred) : null,
  };
}
