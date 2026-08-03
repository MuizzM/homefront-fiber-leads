// ── Pay-plane encryption ─────────────────────────────────────────────────────
// Contractor banking details, W-9 TINs, and the company EIN/DFI account are
// encrypted at rest with AES-256-GCM via the ONE established crypto path
// (server/calling/crypto.ts encryptSensitive/decryptSensitive) — never a
// second cipher. The pay plane uses its own env key slot (PAY_CRYPTO_KEY);
// legacy deployments that only configured the calling key keep working via the
// fallback. Key format: 64 hex chars OR base64 decoding to exactly 32 bytes.
//
// Ops: set PAY_CRYPTO_KEY (preferred). If unset, CALLING_DATA_ENCRYPTION_KEY is
// used so a single-secret install still boots.

import { decryptSensitive, encryptSensitive, encryptionKeyReady } from "./calling/crypto";

export function payKeyName(): string {
  return encryptionKeyReady("PAY_CRYPTO_KEY") ? "PAY_CRYPTO_KEY" : "CALLING_DATA_ENCRYPTION_KEY";
}

export function paySecretsReady(): boolean {
  return encryptionKeyReady("PAY_CRYPTO_KEY") || encryptionKeyReady("CALLING_DATA_ENCRYPTION_KEY");
}

export function encryptPaySecret(plaintext: string): string {
  return encryptSensitive(plaintext, payKeyName());
}

export function decryptPaySecret(payload: string): string {
  return decryptSensitive(payload, payKeyName());
}

// Masking helpers — the ONLY secret-derived strings allowed to leave the
// process (API responses, audit details). Everything else stays ciphertext.
export function last4(digits: string): string {
  const d = digits.replace(/\D/g, "");
  return d.slice(-4);
}

export function maskTin(digits: string, tinType: "ssn" | "ein"): string {
  const tail = last4(digits);
  return tinType === "ssn" ? `***-**-${tail}` : `**-***${tail}`;
}
