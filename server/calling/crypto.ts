import crypto from "node:crypto";
import type { CallAuthorizationClaims } from "@shared/calling";

function keyFromEnv(name: string): Buffer {
  const raw = process.env[name]?.trim();
  if (!raw) throw new Error(`${name} is not configured`);
  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return key;
}

export function callingSecretsReady(): boolean {
  try {
    keyFromEnv("CALLING_DATA_ENCRYPTION_KEY");
    keyFromEnv("PHONE_HASH_KEY");
    keyFromEnv("CALL_AUTHORIZATION_SIGNING_KEY");
    return true;
  } catch {
    return false;
  }
}

export type DncImportManifest = {
  tenantId: number;
  sourceType: "national" | "state";
  state: string | null;
  versionLabel: string;
  authorizedAccountRef: string;
  coveredAreaCodes: string[];
  expectedRecordCount: number;
  expectedChunkCount: number;
  chunkSize: number;
  sourceManifestSha256: string;
  sourceAsOf: string;
  sourceRetrievedAt: string;
  maxAgeDays: number;
};

export function canonicalDncImportManifest(input: DncImportManifest): string {
  return JSON.stringify({
    tenantId: input.tenantId,
    sourceType: input.sourceType,
    state: input.state,
    versionLabel: input.versionLabel,
    authorizedAccountRef: input.authorizedAccountRef,
    coveredAreaCodes: [...new Set(input.coveredAreaCodes)].sort(),
    expectedRecordCount: input.expectedRecordCount,
    expectedChunkCount: input.expectedChunkCount,
    chunkSize: input.chunkSize,
    sourceManifestSha256: input.sourceManifestSha256.toLowerCase(),
    sourceAsOf: input.sourceAsOf,
    sourceRetrievedAt: input.sourceRetrievedAt,
    maxAgeDays: input.maxAgeDays,
  });
}

export function verifyDncImportManifest(input: DncImportManifest, signature: string): boolean {
  let key: Buffer;
  try { key = keyFromEnv("DNC_IMPORT_MANIFEST_SIGNING_KEY"); } catch { return false; }
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha256", key).update(canonicalDncImportManifest(input)).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export type ConsentArtifactManifest = {
  tenantId: number;
  leadId: number;
  phoneId: number;
  callAttemptId: string | null;
  artifactType: "voice_recording" | "signed_form" | "written_record";
  storageProvider: string;
  storageRef: string;
  artifactSha256: string;
  capturedAt: string;
  retentionUntil: string;
  verificationEvidenceRef: string;
};

export function canonicalConsentArtifactManifest(input: ConsentArtifactManifest): string {
  return JSON.stringify({
    tenantId: input.tenantId,
    leadId: input.leadId,
    phoneId: input.phoneId,
    callAttemptId: input.callAttemptId,
    artifactType: input.artifactType,
    storageProvider: input.storageProvider,
    storageRef: input.storageRef,
    artifactSha256: input.artifactSha256.toLowerCase(),
    capturedAt: input.capturedAt,
    retentionUntil: input.retentionUntil,
    verificationEvidenceRef: input.verificationEvidenceRef,
  });
}

export function verifyConsentArtifactManifest(input: ConsentArtifactManifest, signature: string): boolean {
  let key: Buffer;
  try { key = keyFromEnv("CONSENT_ARTIFACT_MANIFEST_SIGNING_KEY"); } catch { return false; }
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac("sha256", key).update(canonicalConsentArtifactManifest(input)).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// AES-256-GCM at rest. The optional `keyName` lets a sibling data plane (e.g.
// the pay plane's PAY_CRYPTO_KEY) reuse THIS ONE established crypto path with a
// different env key — never a second cipher/format. Default preserves the
// original calling-plane behavior bit-for-bit.
export function encryptSensitive(value: string, keyName = "CALLING_DATA_ENCRYPTION_KEY"): string {
  const key = keyFromEnv(keyName);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), encrypted.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSensitive(value: string, keyName = "CALLING_DATA_ENCRYPTION_KEY"): string {
  const [version, ivText, payloadText, tagText] = value.split(".");
  if (version !== "v1" || !ivText || !payloadText || !tagText) throw new Error("Unsupported encrypted payload");
  const key = keyFromEnv(keyName);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(payloadText, "base64url")), decipher.final()]).toString("utf8");
}

// Readiness probe for an arbitrary AES-256-GCM key slot (e.g. PAY_CRYPTO_KEY).
export function encryptionKeyReady(name: string): boolean {
  try { keyFromEnv(name); return true; } catch { return false; }
}

export function hashPhone(tenantId: number, e164: string): string {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) throw new Error("A valid tenant is required to hash a phone number");
  // Namespace the deterministic lookup token by tenant. This prevents the
  // database from becoming a cross-organization phone-number correlation set
  // while preserving exact-match DNC checks inside one organization.
  return crypto.createHmac("sha256", keyFromEnv("PHONE_HASH_KEY"))
    .update(`${tenantId}:${e164}`)
    .digest("hex");
}

export function hashPlatformPhone(e164: string): string {
  // A separate namespace is used only for an explicitly approved, platform-
  // wide opt-out policy. It is never returned to tenants or representatives.
  return crypto.createHmac("sha256", keyFromEnv("PHONE_HASH_KEY"))
    .update(`platform-dnc:${e164}`)
    .digest("hex");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function authorizationSignature(body: string): string {
  return crypto.createHmac("sha256", keyFromEnv("CALL_AUTHORIZATION_SIGNING_KEY")).update(body).digest("base64url");
}

export function signCallAuthorization(claims: CallAuthorizationClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${authorizationSignature(body)}`;
}

export function verifyCallAuthorization(token: string): CallAuthorizationClaims {
  const [body, signature] = token.split(".");
  if (!body || !signature) throw new Error("Malformed call authorization");
  const expected = authorizationSignature(body);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new Error("Invalid call authorization signature");
  }
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CallAuthorizationClaims;
  if (claims.version !== 1 || !claims.nonce || !claims.decisionId) throw new Error("Invalid call authorization claims");
  return claims;
}

export function callingEnvironment(tenantId: number): {
  moduleEnabled: boolean;
  enrichmentEnabled: boolean;
  nationalDncEnabled: boolean;
  stateDncEnabled: boolean;
  manualClickToCallEnabled: boolean;
  emergencyDisabled: boolean;
  pilotAllowed: boolean;
  secretsReady: boolean;
} {
  const pilot = new Set((process.env.CALLING_PILOT_ORG_IDS ?? "").split(",").map((value) => Number(value.trim())).filter(Number.isSafeInteger));
  return {
    moduleEnabled: process.env.CALLING_MODULE_ENABLED === "true",
    enrichmentEnabled: process.env.CONTACT_ENRICHMENT_ENABLED === "true",
    nationalDncEnabled: process.env.NATIONAL_DNC_ENABLED === "true" || process.env.FEDERAL_DNC_ENABLED === "true",
    stateDncEnabled: process.env.STATE_RULES_ENABLED === "true" || process.env.STATE_DNC_ENABLED === "true",
    manualClickToCallEnabled: process.env.MANUAL_CLICK_TO_CALL_ENABLED === "true",
    // The emergency stop is ON unless explicitly switched off.
    emergencyDisabled: process.env.CALLING_EMERGENCY_DISABLED !== "false",
    pilotAllowed: pilot.has(tenantId),
    secretsReady: callingSecretsReady(),
  };
}
