import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { encryptIdentitySecret, decryptIdentitySecret, hashIdentityToken, newIdentityToken, identityEncryptionReady } from "../../server/identity/crypto";
const context = { tenantId: 1, owner: "user:1", purpose: "totp" as const, revision: 1 };
beforeEach(() => {
  vi.stubEnv("IDENTITY_ENCRYPTION_ACTIVE_KEY_ID", "first");
  vi.stubEnv("IDENTITY_ENCRYPTION_KEYS", JSON.stringify({ first: "11".repeat(32) }));
});
afterEach(() => vi.unstubAllEnvs());
it("round-trips secrets without plaintext and authenticates tenant, owner, purpose and revision", () => {
  const encrypted = encryptIdentitySecret("fixture authenticator secret", context);
  expect(encrypted).not.toContain("authenticator");
  expect(decryptIdentitySecret(encrypted, context)).toBe("fixture authenticator secret");
  for (const changed of [{ tenantId: 2 }, { owner: "user:2" }, { purpose: "oidc-client" as const }, { revision: 2 }]) {
    expect(() => decryptIdentitySecret(encrypted, { ...context, ...changed })).toThrow();
  }
  const parts = encrypted.split("."); parts[4] = Buffer.from("tampered").toString("base64url");
  expect(() => decryptIdentitySecret(parts.join("."), context)).toThrow();
});
it("rotates writes while retaining explicitly configured old-key reads", () => {
  const old = encryptIdentitySecret("fixture", context);
  vi.stubEnv("IDENTITY_ENCRYPTION_KEYS", JSON.stringify({ first: "11".repeat(32), second: "22".repeat(32) }));
  vi.stubEnv("IDENTITY_ENCRYPTION_ACTIVE_KEY_ID", "second");
  expect(decryptIdentitySecret(old, context)).toBe("fixture");
  expect(encryptIdentitySecret("fixture", context)).toMatch(/^identity1\.second\./);
  vi.stubEnv("IDENTITY_ENCRYPTION_KEYS", JSON.stringify({ second: "22".repeat(32) }));
  expect(() => decryptIdentitySecret(old, context)).toThrow();
});
it("fails closed on missing/malformed keys and oversized input", () => {
  expect(identityEncryptionReady()).toBe(true);
  expect(() => encryptIdentitySecret("x".repeat(65537), context)).toThrow();
  vi.stubEnv("IDENTITY_ENCRYPTION_KEYS", "{}");
  expect(identityEncryptionReady()).toBe(false);
  expect(() => encryptIdentitySecret("fixture", context)).toThrow();
});
it("uses high-entropy opaque tokens with separate lookup namespaces", () => {
  const a = newIdentityToken(), b = newIdentityToken();
  expect(a).toHaveLength(43); expect(b).not.toBe(a);
  expect(hashIdentityToken(a, "continuation")).toMatch(/^[0-9a-f]{64}$/);
  expect(hashIdentityToken(a, "browser")).not.toBe(hashIdentityToken(a, "continuation"));
  expect(() => hashIdentityToken("short", "scim")).toThrow();
});
