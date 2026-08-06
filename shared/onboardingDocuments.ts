import type { CommissionTerms } from "./commissionTerms";

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

export function canOpenSigning(status: OnboardingDocumentStatus): boolean {
  return status === "sent" || status === "delivered";
}

export interface AgreementSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  /** A rate table to print inside the section — the tier ladder, today. The
   *  prose beside it states the same numbers (both are built from tierRows),
   *  because the retroactive rule and the worked example are the legally
   *  meaningful part; the table is so a signer can read the bands as bands
   *  rather than out of a semicolon-joined sentence. Absent on every other
   *  section and on agreements issued before the table existed, so all three
   *  renderers — PDF body, packet cover, signing ceremony — tolerate undefined. */
  rows?: Array<{ band: string; rate: string }>;
}

export interface AgreementSnapshot {
  schemaVersion: 1;
  documentType: OnboardingDocumentType;
  documentVersion: string;
  title: string;
  companyName: string;
  signerName: string;
  signerEmail: string;
  issuedAt: string;
  /** Commission agreements only: the structured terms the prose was rendered
   *  from, frozen with it. Absent on other document types and on agreements
   *  issued before terms were stated in the document at all. */
  compTerms?: CommissionTerms;
  sections: AgreementSection[];
}

export const ELECTRONIC_CONSENT_VERSION = "esign-disclosure-2026-07-v1";

export const ELECTRONIC_CONSENT_DISCLOSURE = {
  title: "Consent to electronic records and signatures",
  paragraphs: [
    "You may receive, review, sign, and keep these onboarding records electronically. Your electronic signature has the same intended effect as signing a paper copy.",
    "You may decline electronic signing or withdraw consent before signing by contacting your manager. You may request a paper copy at no charge. Withdrawing consent before signature does not create a signature and does not change any record you already signed.",
    "To use electronic records you need an internet-connected device, a current web browser, an email account, and software capable of opening PDF files. You can download the completed PDF from My Documents.",
    "This consent applies only to Home Front Solutions onboarding agreements presented in this signing session. Opening the agreement and completing the ceremony demonstrates that you can access the electronic record.",
  ],
} as const;

export function normalizedSignerName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function signerNameMatches(expected: string, supplied: string): boolean {
  return normalizedSignerName(expected) === normalizedSignerName(supplied);
}
