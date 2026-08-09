// ── Pay-plane input validation ───────────────────────────────────────────────
// Pure functions — no I/O, no logging (secrets must never touch logs).

// ABA routing transit number checksum (NACHA/Fed algorithm):
// 3(d1+d4+d7) + 7(d2+d5+d8) + 1(d3+d6+d9) ≡ 0 (mod 10).
export function isValidAbaRouting(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split("").map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

// ACH DFI account numbers: 4–17 digits (we accept the digits-only subset of
// the NACHA alphanumeric space — banks in this flow issue numeric accounts).
export function isValidAccountNumber(account: string): boolean {
  return /^\d{4,17}$/.test(account);
}

// SSN/EIN: 9 digits, not an obviously-invalid all-zero/9 pattern.
export function isValidTin(tin: string): boolean {
  if (!/^\d{9}$/.test(tin)) return false;
  if (/^0{9}$/.test(tin) || /^9{9}$/.test(tin)) return false;
  return true;
}

export function isValidState(state: string): boolean {
  return /^[A-Z]{2}$/.test(state);
}

export function isValidZip(zip: string): boolean {
  return /^\d{5}(-\d{4})?$/.test(zip);
}

export type W9AddressInput = { line1: string; city: string; state: string; zip: string };

// Form W-9 Line 3a. The signer picks their ACTUAL federal tax classification —
// assuming "individual" makes a single-member LLC or an S-corp certify
// something false under penalties of perjury and drives the wrong 1099.
export const W9_TAX_CLASSIFICATIONS = [
  "individual", "c_corp", "s_corp", "partnership", "trust_estate", "llc", "other",
] as const;
export type W9TaxClassification = (typeof W9_TAX_CLASSIFICATIONS)[number];

export const W9_LLC_TAX_CLASSES = ["C", "S", "P"] as const;
export type W9LlcTaxClass = (typeof W9_LLC_TAX_CLASSES)[number];

export interface W9ValidatedInput {
  legalName: string; businessName: string | null; address: W9AddressInput;
  tin: string; tinType: "ssn" | "ein"; signatureName: string;
  taxClassification: W9TaxClassification;
  llcTaxClass: W9LlcTaxClass | null;
  otherClassification: string | null;
  foreignPartners: boolean;
  exemptPayeeCode: string | null;
  fatcaExemptionCode: string | null;
  accountNumbers: string | null;
  subjectToBackupWithholding: boolean;
}

export function validateW9Input(body: any): { ok: true; value: W9ValidatedInput } | { ok: false; error: string } {
  const legalName = String(body?.legalName ?? "").trim();
  if (legalName.length < 2 || legalName.length > 120) return { ok: false, error: "legalName must be 2-120 characters" };
  const businessNameRaw = String(body?.businessName ?? "").trim();
  const businessName = businessNameRaw ? businessNameRaw : null;
  if (businessName && businessName.length > 120) return { ok: false, error: "businessName must be ≤ 120 characters" };
  const address = body?.address ?? {};
  const line1 = String(address.line1 ?? "").trim();
  const city = String(address.city ?? "").trim();
  const state = String(address.state ?? "").trim().toUpperCase();
  const zip = String(address.zip ?? "").trim();
  if (line1.length < 3 || line1.length > 120) return { ok: false, error: "address.line1 must be 3-120 characters" };
  if (city.length < 2 || city.length > 60) return { ok: false, error: "address.city must be 2-60 characters" };
  if (!isValidState(state)) return { ok: false, error: "address.state must be a 2-letter US state code" };
  if (!isValidZip(zip)) return { ok: false, error: "address.zip must be 5 digits (optionally ZIP+4)" };
  const tin = String(body?.tin ?? "").replace(/\D/g, "");
  const tinType = body?.tinType;
  if (tinType !== "ssn" && tinType !== "ein") return { ok: false, error: "tinType must be 'ssn' or 'ein'" };
  if (!isValidTin(tin)) return { ok: false, error: "tin must be exactly 9 digits" };

  // ── Line 3a: federal tax classification ────────────────────────────────────
  const taxClassification = body?.taxClassification;
  if (!W9_TAX_CLASSIFICATIONS.includes(taxClassification)) {
    return { ok: false, error: `taxClassification must be one of: ${W9_TAX_CLASSIFICATIONS.join(", ")} (Form W-9 Line 3a)` };
  }
  let llcTaxClass: W9LlcTaxClass | null = null;
  let otherClassification: string | null = null;
  if (taxClassification === "llc") {
    const raw = String(body?.llcTaxClass ?? "").trim().toUpperCase();
    if (!W9_LLC_TAX_CLASSES.includes(raw as W9LlcTaxClass)) {
      return { ok: false, error: "llcTaxClass is required for an LLC and must be exactly 'C' (C corporation), 'S' (S corporation), or 'P' (partnership) - Form W-9 Line 3a" };
    }
    llcTaxClass = raw as W9LlcTaxClass;
  } else if (body?.llcTaxClass != null && String(body.llcTaxClass).trim() !== "") {
    return { ok: false, error: "llcTaxClass may only be supplied when taxClassification is 'llc'" };
  }
  if (taxClassification === "other") {
    const desc = String(body?.otherClassification ?? "").trim();
    if (desc.length < 2 || desc.length > 60) {
      return { ok: false, error: "otherClassification is required (2-60 characters) when taxClassification is 'other' - Form W-9 Line 3a" };
    }
    otherClassification = desc;
  } else if (body?.otherClassification != null && String(body.otherClassification).trim() !== "") {
    return { ok: false, error: "otherClassification may only be supplied when taxClassification is 'other'" };
  }
  // Line 3b — flow-through entity with foreign partners/owners (Rev. 3-2024).
  if (body?.foreignPartners != null && typeof body.foreignPartners !== "boolean") {
    return { ok: false, error: "foreignPartners must be a boolean when supplied (Form W-9 Line 3b)" };
  }
  const foreignPartners = body?.foreignPartners === true;

  // ── Line 4 exemption codes / Line 7 account numbers — optional free text ───
  const optional = (raw: any, field: string, max: number): { ok: true; value: string | null } | { ok: false; error: string } => {
    if (raw == null) return { ok: true, value: null };
    const s = String(raw).trim();
    if (!s) return { ok: true, value: null };
    if (s.length > max) return { ok: false, error: `${field} must be ≤ ${max} characters` };
    return { ok: true, value: s };
  };
  const exempt = optional(body?.exemptPayeeCode, "exemptPayeeCode", 8);
  if (!exempt.ok) return exempt;
  const fatca = optional(body?.fatcaExemptionCode, "fatcaExemptionCode", 12);
  if (!fatca.ok) return fatca;
  const accounts = optional(body?.accountNumbers, "accountNumbers", 80);
  if (!accounts.ok) return accounts;

  // ── Part II certification ──────────────────────────────────────────────────
  // The form: "You must cross out item 2 above if you have been notified by the
  // IRS that you are currently subject to backup withholding." The answer is
  // REQUIRED — silence used to mean "not subject", which every signer certified
  // whether it was true or not, and left the PAYER liable for the 24% it never
  // withheld.
  if (typeof body?.subjectToBackupWithholding !== "boolean") {
    return { ok: false, error: "subjectToBackupWithholding must be true or false - the IRS certification (Part II, item 2) requires an explicit answer" };
  }
  const subjectToBackupWithholding = body.subjectToBackupWithholding === true;

  if (body?.consent !== true) return { ok: false, error: "consent must be true - an electronic-signature consent is required (ESIGN)" };
  const signatureName = String(body?.signatureName ?? "").trim();
  // ESIGN: the typed signature must match the legal name (case-insensitive) so
  // the signer affirms the certification under penalties of perjury.
  if (signatureName.toLowerCase() !== legalName.toLowerCase()) {
    return { ok: false, error: "signatureName must exactly match the legal name (case-insensitive)" };
  }
  return { ok: true, value: {
    legalName, businessName, address: { line1, city, state, zip }, tin, tinType, signatureName,
    taxClassification, llcTaxClass, otherClassification, foreignPartners,
    exemptPayeeCode: exempt.value, fatcaExemptionCode: fatca.value, accountNumbers: accounts.value,
    subjectToBackupWithholding,
  } };
}
