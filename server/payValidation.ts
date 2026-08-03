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

export function validateW9Input(body: any): { ok: true; value: {
  legalName: string; businessName: string | null; address: W9AddressInput;
  tin: string; tinType: "ssn" | "ein"; signatureName: string;
} } | { ok: false; error: string } {
  const legalName = String(body?.legalName ?? "").trim();
  if (legalName.length < 2 || legalName.length > 120) return { ok: false, error: "legalName must be 2–120 characters" };
  const businessNameRaw = String(body?.businessName ?? "").trim();
  const businessName = businessNameRaw ? businessNameRaw : null;
  if (businessName && businessName.length > 120) return { ok: false, error: "businessName must be ≤ 120 characters" };
  const address = body?.address ?? {};
  const line1 = String(address.line1 ?? "").trim();
  const city = String(address.city ?? "").trim();
  const state = String(address.state ?? "").trim().toUpperCase();
  const zip = String(address.zip ?? "").trim();
  if (line1.length < 3 || line1.length > 120) return { ok: false, error: "address.line1 must be 3–120 characters" };
  if (city.length < 2 || city.length > 60) return { ok: false, error: "address.city must be 2–60 characters" };
  if (!isValidState(state)) return { ok: false, error: "address.state must be a 2-letter US state code" };
  if (!isValidZip(zip)) return { ok: false, error: "address.zip must be 5 digits (optionally ZIP+4)" };
  const tin = String(body?.tin ?? "").replace(/\D/g, "");
  const tinType = body?.tinType;
  if (tinType !== "ssn" && tinType !== "ein") return { ok: false, error: "tinType must be 'ssn' or 'ein'" };
  if (!isValidTin(tin)) return { ok: false, error: "tin must be exactly 9 digits" };
  if (body?.consent !== true) return { ok: false, error: "consent must be true — an electronic-signature consent is required (ESIGN)" };
  const signatureName = String(body?.signatureName ?? "").trim();
  // ESIGN: the typed signature must match the legal name (case-insensitive) so
  // the signer affirms the certification under penalties of perjury.
  if (signatureName.toLowerCase() !== legalName.toLowerCase()) {
    return { ok: false, error: "signatureName must exactly match the legal name (case-insensitive)" };
  }
  return { ok: true, value: { legalName, businessName, address: { line1, city, state, zip }, tin, tinType, signatureName } };
}
