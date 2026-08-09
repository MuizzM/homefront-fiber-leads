// ── PAY-A2: contractor pay profile persistence ───────────────────────────────
// Banking details, W-9 forms, and the originating company (ODFI) profile.
// Secrets are encrypted via server/payCrypto.ts at the boundary of this module:
// callers pass plaintext IN, rows hold ciphertext, and only the explicit
// *Secrets() readers (NACHA / 1099 computation) decrypt. No secret is ever
// logged or returned from here — masked views are separate functions.

import { rawDb } from "./db";
import { decryptPaySecret, encryptPaySecret, last4, maskTin } from "./payCrypto";
import {
  isValidAbaRouting, isValidAccountNumber, isValidTin,
  W9_LLC_TAX_CLASSES, W9_TAX_CLASSIFICATIONS,
  type W9LlcTaxClass, type W9TaxClassification,
} from "./payValidation";
import { renderW9Pdf } from "./w9Pdf";

const nowIso = () => new Date().toISOString();

export class PayError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}

// ── Bank details ─────────────────────────────────────────────────────────────
export interface BankRow {
  rep_id: number; tenant_id: number; routing_enc: string; account_enc: string;
  account_type: "checking" | "savings"; last4: string; status: "active" | "disabled";
  created_at: string; updated_at: string;
}

export function upsertBankDetails(tenantId: number, repId: number, input: {
  routing: string; account: string; accountType: "checking" | "savings";
}): { last4: string; accountType: string; status: string } {
  const routing = String(input.routing ?? "").replace(/\D/g, "");
  const account = String(input.account ?? "").replace(/\D/g, "");
  if (!isValidAbaRouting(routing)) throw new PayError("INVALID_ROUTING", "routing must be a valid 9-digit ABA transit number (checksum failed)");
  if (!isValidAccountNumber(account)) throw new PayError("INVALID_ACCOUNT", "account must be 4-17 digits");
  if (input.accountType !== "checking" && input.accountType !== "savings") {
    throw new PayError("INVALID_ACCOUNT_TYPE", "accountType must be 'checking' or 'savings'");
  }
  const now = nowIso();
  rawDb.prepare(
    `INSERT INTO rep_bank_details (rep_id, tenant_id, routing_enc, account_enc, account_type, last4, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,'active',?,?)
     ON CONFLICT(rep_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       routing_enc = excluded.routing_enc,
       account_enc = excluded.account_enc,
       account_type = excluded.account_type,
       last4 = excluded.last4,
       status = 'active',
       updated_at = excluded.updated_at`
  ).run(repId, tenantId, encryptPaySecret(routing), encryptPaySecret(account), input.accountType, last4(account), now, now);
  return { last4: last4(account), accountType: input.accountType, status: "active" };
}

export function getBankRow(tenantId: number, repId: number): BankRow | undefined {
  return rawDb.prepare(`SELECT * FROM rep_bank_details WHERE tenant_id = ? AND rep_id = ?`).get(tenantId, repId) as BankRow | undefined;
}

export function getBankMasked(tenantId: number, repId: number): { last4: string; accountType: string; status: string; updatedAt: string } | null {
  const row = getBankRow(tenantId, repId);
  if (!row) return null;
  return { last4: row.last4, accountType: row.account_type, status: row.status, updatedAt: row.updated_at };
}

/** INTERNAL ONLY — NACHA entry computation. Never expose through a route. */
export function getBankSecrets(tenantId: number, repId: number): { routing: string; account: string; accountType: "checking" | "savings" } | null {
  const row = getBankRow(tenantId, repId);
  if (!row || row.status !== "active") return null;
  return {
    routing: decryptPaySecret(row.routing_enc),
    account: decryptPaySecret(row.account_enc),
    accountType: row.account_type,
  };
}

// ── W-9 ──────────────────────────────────────────────────────────────────────
export interface W9Row {
  id: number; tenant_id: number; rep_id: number; legal_name: string; business_name: string | null;
  address_line1: string; city: string; state: string; zip: string; tin_enc: string; tin_type: "ssn" | "ein";
  tax_classification: W9TaxClassification; llc_tax_class: W9LlcTaxClass | null;
  other_classification: string | null; foreign_partners: number;
  exempt_payee_code: string | null; fatca_exemption_code: string | null; account_numbers: string | null;
  subject_to_backup_withholding: number;
  signature_name: string; signature_date: string; signature_ip: string | null; signature_ua: string | null;
  consent: number; rendered_names: string | null; pdf_path: string | null; created_at: string;
}

export function saveW9(tenantId: number, repId: number, input: {
  legalName: string; businessName: string | null;
  address: { line1: string; city: string; state: string; zip: string };
  tin: string; tinType: "ssn" | "ein"; signatureName: string;
  taxClassification: W9TaxClassification; llcTaxClass: W9LlcTaxClass | null;
  otherClassification: string | null; foreignPartners: boolean;
  exemptPayeeCode: string | null; fatcaExemptionCode: string | null; accountNumbers: string | null;
  subjectToBackupWithholding: boolean;
  /** ESIGN consent as ASSERTED BY THE SIGNER — never hardcoded. */
  consent: boolean;
  signatureIp: string | null; signatureUa: string | null;
  renderedNames: { legalName: string; businessName: string | null; signatureName: string } | null;
}): W9Row {
  if (!isValidTin(input.tin)) throw new PayError("INVALID_TIN", "tin must be exactly 9 digits");
  if (!W9_TAX_CLASSIFICATIONS.includes(input.taxClassification)) {
    throw new PayError("INVALID_TAX_CLASSIFICATION", `taxClassification must be one of: ${W9_TAX_CLASSIFICATIONS.join(", ")}`);
  }
  if (input.taxClassification === "llc" && !W9_LLC_TAX_CLASSES.includes(input.llcTaxClass as W9LlcTaxClass)) {
    throw new PayError("INVALID_LLC_TAX_CLASS", "an LLC must declare its tax classification letter (C, S, or P)");
  }
  if (input.taxClassification === "other" && !String(input.otherClassification ?? "").trim()) {
    throw new PayError("INVALID_OTHER_CLASSIFICATION", 'tax classification "other" requires a description');
  }
  if (!input.consent) throw new PayError("W9_CONSENT_REQUIRED", "an electronic-signature consent is required (ESIGN)");
  const now = nowIso();
  const info = rawDb.prepare(
    `INSERT INTO w9_forms (tenant_id, rep_id, legal_name, business_name, address_line1, city, state, zip,
       tin_enc, tin_type, tax_classification, llc_tax_class, other_classification, foreign_partners,
       exempt_payee_code, fatca_exemption_code, account_numbers, subject_to_backup_withholding,
       signature_name, signature_date, signature_ip, signature_ua, consent, rendered_names, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(tenantId, repId, input.legalName, input.businessName, input.address.line1, input.address.city,
    input.address.state, input.address.zip, encryptPaySecret(input.tin), input.tinType,
    input.taxClassification, input.llcTaxClass, input.otherClassification, input.foreignPartners ? 1 : 0,
    input.exemptPayeeCode, input.fatcaExemptionCode, input.accountNumbers,
    input.subjectToBackupWithholding ? 1 : 0,
    input.signatureName, now, input.signatureIp, input.signatureUa, input.consent ? 1 : 0,
    input.renderedNames ? JSON.stringify(input.renderedNames) : null, now);
  return getW9ById(tenantId, Number(info.lastInsertRowid))!;
}

export function getW9ById(tenantId: number, id: number): W9Row | undefined {
  return rawDb.prepare(`SELECT * FROM w9_forms WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as W9Row | undefined;
}

export function getLatestW9(tenantId: number, repId: number): W9Row | undefined {
  return rawDb.prepare(`SELECT * FROM w9_forms WHERE tenant_id = ? AND rep_id = ? ORDER BY id DESC LIMIT 1`).get(tenantId, repId) as W9Row | undefined;
}

export interface W9Status {
  submitted: true; w9Id: number; legalName: string; businessName: string | null;
  tinType: string; tinMasked: string;
  taxClassification: W9TaxClassification; llcTaxClass: W9LlcTaxClass | null;
  otherClassification: string | null; foreignPartners: boolean;
  exemptPayeeCode: string | null; fatcaExemptionCode: string | null;
  /** TRUE ⇒ the rep certified the IRS has them subject to backup withholding.
   *  The pay lane MUST flag this rep (24% withholding) before paying them. */
  subjectToBackupWithholding: boolean;
  signatureName: string; signatureDate: string; createdAt: string;
}

export function getW9Status(tenantId: number, repId: number): W9Status | null {
  const row = getLatestW9(tenantId, repId);
  if (!row || !row.consent) return null;
  const tin = decryptPaySecret(row.tin_enc); // decrypted only to derive the mask
  return {
    submitted: true, w9Id: row.id, legalName: row.legal_name, businessName: row.business_name,
    tinType: row.tin_type, tinMasked: maskTin(tin, row.tin_type),
    taxClassification: (row.tax_classification ?? "individual") as W9TaxClassification,
    llcTaxClass: row.llc_tax_class ?? null,
    otherClassification: row.other_classification ?? null,
    foreignPartners: !!row.foreign_partners,
    exemptPayeeCode: row.exempt_payee_code ?? null,
    fatcaExemptionCode: row.fatca_exemption_code ?? null,
    subjectToBackupWithholding: !!row.subject_to_backup_withholding,
    signatureName: row.signature_name, signatureDate: row.signature_date, createdAt: row.created_at,
  };
}

/**
 * Re-render a stored W-9 as a PDF, ON DEMAND, from the encrypted TIN.
 *
 * We deliberately do NOT keep the filled PDF on disk: it contains the complete
 * 9-digit SSN in plaintext, it lived outside Litestream replication, and the
 * old repId-keyed path silently overwrote the append-only history. Every byte
 * of the document is reproducible from this row, so the ciphertext in tin_enc
 * stays the only copy of the number at rest.
 *
 * Callers MUST have authorized the request (self, or an admin-only capability)
 * and MUST audit it — this returns a full, unredacted SSN on paper.
 */
export async function renderStoredW9(tenantId: number, row: W9Row): Promise<Uint8Array> {
  const company = getCompanyProfileRow(tenantId);
  const result = await renderW9Pdf({
    legalName: row.legal_name,
    businessName: row.business_name,
    taxClassification: (row.tax_classification ?? "individual") as W9TaxClassification,
    llcTaxClass: (row.llc_tax_class ?? null) as W9LlcTaxClass | null,
    otherClassification: row.other_classification ?? null,
    foreignPartners: !!row.foreign_partners,
    exemptPayeeCode: row.exempt_payee_code ?? null,
    fatcaExemptionCode: row.fatca_exemption_code ?? null,
    accountNumbers: row.account_numbers ?? null,
    address: { line1: row.address_line1, city: row.city, state: row.state, zip: row.zip },
    tin: decryptPaySecret(row.tin_enc),
    tinType: row.tin_type,
    signatureName: row.signature_name,
    signatureDate: new Date(row.signature_date),
    requesterName: company?.legal_name,
    subjectToBackupWithholding: !!row.subject_to_backup_withholding,
  });
  return result.pdf;
}

// ── Company (originating ODFI) profile ───────────────────────────────────────
export interface CompanyProfileRow {
  tenant_id: number; legal_name: string; ein_enc: string; dfi_account_enc: string;
  dfi_routing: string; company_id: string; updated_at: string;
}

export function upsertCompanyProfile(tenantId: number, input: {
  legalName: string; ein: string; dfiAccount: string; dfiRouting: string; companyId: string;
}): void {
  const legalName = String(input.legalName ?? "").trim();
  if (legalName.length < 2 || legalName.length > 60) throw new PayError("INVALID_LEGAL_NAME", "legalName must be 2-60 characters");
  const ein = String(input.ein ?? "").replace(/\D/g, "");
  if (!isValidTin(ein)) throw new PayError("INVALID_EIN", "ein must be exactly 9 digits");
  const dfiAccount = String(input.dfiAccount ?? "").replace(/\D/g, "");
  if (!isValidAccountNumber(dfiAccount)) throw new PayError("INVALID_DFI_ACCOUNT", "dfiAccount must be 4-17 digits");
  const dfiRouting = String(input.dfiRouting ?? "").replace(/\D/g, "");
  if (!isValidAbaRouting(dfiRouting)) throw new PayError("INVALID_DFI_ROUTING", "dfiRouting must be a valid 9-digit ABA transit number (checksum failed)");
  const companyId = String(input.companyId ?? "").trim();
  if (!/^[\x20-\x7E]{1,10}$/.test(companyId)) throw new PayError("INVALID_COMPANY_ID", "companyId must be 1-10 printable characters (NACHA company identification, often the EIN)");
  const now = nowIso();
  rawDb.prepare(
    `INSERT INTO company_profile (tenant_id, legal_name, ein_enc, dfi_account_enc, dfi_routing, company_id, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       legal_name = excluded.legal_name, ein_enc = excluded.ein_enc,
       dfi_account_enc = excluded.dfi_account_enc, dfi_routing = excluded.dfi_routing,
       company_id = excluded.company_id, updated_at = excluded.updated_at`
  ).run(tenantId, legalName, encryptPaySecret(ein), encryptPaySecret(dfiAccount), dfiRouting, companyId, now);
}

export function getCompanyProfileRow(tenantId: number): CompanyProfileRow | undefined {
  return rawDb.prepare(`SELECT * FROM company_profile WHERE tenant_id = ?`).get(tenantId) as CompanyProfileRow | undefined;
}

export function getCompanyProfileMasked(tenantId: number): {
  legalName: string; einMasked: string; dfiAccountLast4: string; dfiRouting: string; companyId: string; updatedAt: string;
} | null {
  const row = getCompanyProfileRow(tenantId);
  if (!row) return null;
  const ein = decryptPaySecret(row.ein_enc);
  const dfiAccount = decryptPaySecret(row.dfi_account_enc);
  return {
    legalName: row.legal_name, einMasked: maskTin(ein, "ein"),
    dfiAccountLast4: last4(dfiAccount), dfiRouting: row.dfi_routing,
    companyId: row.company_id, updatedAt: row.updated_at,
  };
}

/** INTERNAL ONLY — NACHA file header computation. Never expose through a route. */
export function getCompanyProfileSecrets(tenantId: number): {
  legalName: string; ein: string; dfiAccount: string; dfiRouting: string; companyId: string;
} | null {
  const row = getCompanyProfileRow(tenantId);
  if (!row) return null;
  return {
    legalName: row.legal_name, ein: decryptPaySecret(row.ein_enc),
    dfiAccount: decryptPaySecret(row.dfi_account_enc),
    dfiRouting: row.dfi_routing, companyId: row.company_id,
  };
}
