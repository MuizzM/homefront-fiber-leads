import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface IdentitySecretContext {
  tenantId: number | null;
  owner: string;
  purpose: "totp" | "oidc-client" | "saml-key" | "sms-code";
  revision: number;
}
const MAX_SECRET_BYTES = 64 * 1024;
function identityKeys(): { active: string; keys: Record<string, Buffer> } {
  const active = process.env.IDENTITY_ENCRYPTION_ACTIVE_KEY_ID ?? "";
  const parsed: unknown = JSON.parse(process.env.IDENTITY_ENCRYPTION_KEYS ?? "null");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Identity encryption is not configured");
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > 5 || !/^[a-zA-Z0-9_-]{1,32}$/.test(active)) throw new Error("Invalid identity key configuration");
  const keys: Record<string, Buffer> = Object.create(null);
  for (const [id, value] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || typeof value !== "string" || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error("Invalid identity key configuration");
    keys[id] = Buffer.from(value, "hex");
  }
  if (!keys[active]) throw new Error("Active identity key is unavailable");
  return { active, keys };
}
function aad(keyId: string, context: IdentitySecretContext): Buffer {
  if ((context.tenantId !== null && (!Number.isSafeInteger(context.tenantId) || context.tenantId <= 0))
      || !context.owner || context.owner.length > 160 || !Number.isSafeInteger(context.revision) || context.revision < 1) throw new Error("Invalid identity secret context");
  return Buffer.from(JSON.stringify(["homefront-identity", 1, keyId, context.tenantId, context.owner, context.purpose, context.revision]));
}
export function identityEncryptionReady(): boolean {
  try { identityKeys(); return true; } catch { return false; }
}
/** Versioned key ids permit rotation while retaining explicitly configured old
 * keys. Context is authenticated, so a valid ciphertext cannot change owners. */
export function encryptIdentitySecret(value: string, context: IdentitySecretContext): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error("Identity secret exceeds limit");
  const { active, keys } = identityKeys();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys[active], iv);
  cipher.setAAD(aad(active, context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["identity1", active, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}
export function decryptIdentitySecret(envelope: string, context: IdentitySecretContext): string {
  if (typeof envelope !== "string" || envelope.length > MAX_SECRET_BYTES * 2) throw new Error("Invalid identity envelope");
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts[0] !== "identity1") throw new Error("Invalid identity envelope");
  const [, keyId, nonce, tag, data] = parts;
  const key = identityKeys().keys[keyId];
  const decode = (value: string) => {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Invalid identity envelope");
    return bytes;
  };
  const iv = decode(nonce), authTag = decode(tag), ciphertext = decode(data);
  if (!key || iv.length !== 12 || authTag.length !== 16 || ciphertext.length > MAX_SECRET_BYTES) throw new Error("Invalid identity envelope");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad(keyId, context));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
export function newIdentityToken(): string { return randomBytes(32).toString("base64url"); }
export function hashIdentityToken(token: string, purpose: "continuation" | "browser" | "device" | "scim" | "recovery" | "protocol"): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Invalid identity token");
  return createHash("sha256").update(`homefront-identity:${purpose}:`).update(token).digest("hex");
}
