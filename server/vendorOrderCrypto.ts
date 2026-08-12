// ── Crypto for the order-status plane ────────────────────────────────────────
//
// Deliberately thin. It reuses the AES-256-GCM path server/calling/crypto.ts
// already established rather than introducing a second cipher or a second
// on-disk format, and adds only the two things this plane needs that the
// calling plane's helpers do not cover: an encryption slot of its own, and a
// destination hash that works for email as well as phone.
//
// TWO FAILURE POSTURES, AND THEY ARE OPPOSITE ON PURPOSE.
//
//   ENCRYPTION FAILS CLOSED. With no key configured, the raw source payload is
//   simply not stored. A provider report is dense customer PII - names,
//   addresses, phone numbers, email addresses, all of it - and writing that to
//   a SQLite file in the clear because an env var was missing is not a
//   degraded mode, it is a breach waiting for a backup to leave the box. The
//   import still runs; it just cannot answer "show me the original row" later,
//   and the import record says so.
//
//   HASHING FAILS OPEN. With no hash key configured, destinations are hashed
//   with plain SHA-256 and the row records which scheme was used. An unkeyed
//   hash of a ten-digit phone number is brute-forceable and that is a real
//   weakness - but the alternative is refusing to record a suppression, which
//   means failing to honour an opt-out. Between "the block list is
//   brute-forceable by someone who already has the database" and "we text
//   somebody who told us to stop", the first is the smaller harm every time.
//   `hash_scheme` on every row is what makes a later rekey possible.

import crypto from "node:crypto";
import { encryptSensitive, decryptSensitive, encryptionKeyReady } from "./calling/crypto";
import type { ContactChannel } from "@shared/contactConsent";

/** This plane's own key slot, falling back to the calling plane's. Its own
 *  first, so an operator can rotate one without touching the other. */
const ENCRYPTION_KEY_SLOTS = ["VENDOR_ORDER_ENCRYPTION_KEY", "CALLING_DATA_ENCRYPTION_KEY"] as const;
const HASH_KEY_SLOTS = ["VENDOR_CONTACT_HASH_KEY", "PHONE_HASH_KEY"] as const;

function activeEncryptionSlot(): string | null {
  return ENCRYPTION_KEY_SLOTS.find((name) => encryptionKeyReady(name)) ?? null;
}

function activeHashSlot(): string | null {
  return HASH_KEY_SLOTS.find((name) => encryptionKeyReady(name)) ?? null;
}

/** True when a raw source payload can be stored at all. Read at CALL time, not
 *  captured at module load, so adding the key takes effect on the next import
 *  rather than the next restart. */
export function orderPayloadEncryptionReady(): boolean {
  return activeEncryptionSlot() != null;
}

/**
 * Encrypt a source row for storage. Returns null when no key is configured -
 * the caller writes null and records `encryption_unavailable` on the import.
 */
export function encryptOrderPayload(payload: unknown): string | null {
  const slot = activeEncryptionSlot();
  if (!slot) return null;
  try {
    return encryptSensitive(JSON.stringify(payload ?? {}), slot);
  } catch (e: any) {
    // Never let a crypto failure take an import down, and never let the error
    // text carry the plaintext it failed on.
    console.warn("[vendor-order-crypto] payload encryption failed:", e?.message);
    return null;
  }
}

/** Decrypt a stored source row. Returns null for a missing, corrupt, or
 *  unreadable payload rather than throwing into a request handler. */
export function decryptOrderPayload(stored: string | null | undefined): Record<string, unknown> | null {
  if (!stored) return null;
  for (const slot of ENCRYPTION_KEY_SLOTS) {
    if (!encryptionKeyReady(slot)) continue;
    try {
      const parsed = JSON.parse(decryptSensitive(stored, slot));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      // Wrong slot, or a payload written under a key that has since rotated.
      // Try the next slot before giving up.
    }
  }
  return null;
}

export type HashScheme = "hmac-sha256" | "sha256-unkeyed";

export interface DestinationHash {
  hash: string;
  scheme: HashScheme;
}

/**
 * The lookup token for a normalized phone or email.
 *
 * Namespaced by tenant AND channel, for the same reason hashPhone namespaces by
 * tenant: without it the database becomes a cross-organization correlation set,
 * and a number suppressed for one org would silently match another org's row.
 */
export function hashDestination(tenantId: number, channel: ContactChannel, normalized: string): DestinationHash {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error("A valid organization is required to hash a contact destination");
  }
  const material = `${tenantId}:${channel}:${normalized.trim().toLowerCase()}`;
  const slot = activeHashSlot();
  if (slot) {
    const key = keyBytes(slot);
    if (key) {
      return { hash: crypto.createHmac("sha256", key).update(material).digest("hex"), scheme: "hmac-sha256" };
    }
  }
  return { hash: crypto.createHash("sha256").update(material).digest("hex"), scheme: "sha256-unkeyed" };
}

/**
 * Both hash forms for a destination, newest scheme first.
 *
 * A lookup has to check BOTH: rows written before a hash key was configured
 * carry the unkeyed scheme, and a suppression written then must keep blocking
 * after the key is added. Ignoring the old scheme would silently un-suppress
 * every opt-out recorded before the rekey, which is the exact failure this
 * plane exists to prevent.
 */
export function destinationHashCandidates(
  tenantId: number, channel: ContactChannel, normalized: string,
): string[] {
  const material = `${tenantId}:${channel}:${normalized.trim().toLowerCase()}`;
  const out: string[] = [];
  const slot = activeHashSlot();
  const key = slot ? keyBytes(slot) : null;
  if (key) out.push(crypto.createHmac("sha256", key).update(material).digest("hex"));
  out.push(crypto.createHash("sha256").update(material).digest("hex"));
  return [...new Set(out)];
}

function keyBytes(name: string): Buffer | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** SHA-256 hex. The row-content hash and the file checksum both come from here,
 *  so "the hash" means one thing across the whole plane. */
export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
