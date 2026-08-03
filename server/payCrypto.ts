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

// ── Key-id envelope ──────────────────────────────────────────────────────────
// Pay-plane ciphertext is self-describing: v1.<kid>.iv.ct.tag, where kid names
// the key slot that encrypted it (pay = PAY_CRYPTO_KEY, calling = the legacy
// CALLING_DATA_ENCRYPTION_KEY fallback). Reads resolve the key FROM THE
// ENVELOPE, so rotating PAY_CRYPTO_KEY in (or later rotating it again) never
// strands rows written under a different slot. Rows written before the
// envelope existed keep the legacy v1.iv.ct.tag shape and decrypt via the
// CURRENT resolution — additive/back-compatible, no re-encryption migration.
const KEY_BY_KID = { pay: "PAY_CRYPTO_KEY", calling: "CALLING_DATA_ENCRYPTION_KEY" } as const;
type PayKeyId = keyof typeof KEY_BY_KID;
const KID_BY_KEY: Record<string, PayKeyId> = { PAY_CRYPTO_KEY: "pay", CALLING_DATA_ENCRYPTION_KEY: "calling" };

// The CURRENT write slot: PAY_CRYPTO_KEY when configured, else the calling
// key so a single-secret install still boots.
export function payKeyName(): string {
  return encryptionKeyReady("PAY_CRYPTO_KEY") ? "PAY_CRYPTO_KEY" : "CALLING_DATA_ENCRYPTION_KEY";
}

// The key id stamped on every NEW write (see the envelope above).
export function payKeyId(): PayKeyId {
  return KID_BY_KEY[payKeyName()];
}

export function paySecretsReady(): boolean {
  return encryptionKeyReady("PAY_CRYPTO_KEY") || encryptionKeyReady("CALLING_DATA_ENCRYPTION_KEY");
}

export function encryptPaySecret(plaintext: string): string {
  const keyName = payKeyName();
  const legacy = encryptSensitive(plaintext, keyName); // v1.iv.ct.tag
  const [version, ...rest] = legacy.split(".");
  return [version, KID_BY_KEY[keyName], ...rest].join(".");
}

export function decryptPaySecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length === 5 && parts[0] === "v1") {
    const keyName = KEY_BY_KID[parts[1] as PayKeyId];
    if (!keyName) throw new Error("Unsupported pay envelope key id");
    return decryptSensitive(["v1", ...parts.slice(2)].join("."), keyName);
  }
  // Legacy v1.iv.ct.tag — resolve against the CURRENT write slot.
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
