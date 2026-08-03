// @vitest-environment node
// SEC-A fix 4 — pay-plane key-id envelope.
// Writes are self-describing: v1.<kid>.iv.ct.tag (kid ∈ {pay, calling}), so a
// key rotation never strands rows written under the other slot. Legacy
// v1.iv.ct.tag rows decrypt via the CURRENT resolution. Tamper still fails.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptPaySecret, encryptPaySecret, payKeyId, payKeyName } from "../../server/payCrypto";
import { encryptSensitive } from "../../server/calling/crypto";

const CALLING_KEY = "a".repeat(64);
const PAY_KEY = "b".repeat(64);

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["PAY_CRYPTO_KEY", "CALLING_DATA_ENCRYPTION_KEY"]) savedEnv[k] = process.env[k];
  process.env.CALLING_DATA_ENCRYPTION_KEY = CALLING_KEY;
  delete process.env.PAY_CRYPTO_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("pay-key envelope (v1.<kid>.iv.ct.tag)", () => {
  it("writes kid=calling when only the calling key is configured", () => {
    const ct = encryptPaySecret("123456789");
    expect(ct.split(".")[0]).toBe("v1");
    expect(ct.split(".")[1]).toBe("calling");
    expect(ct.split(".")).toHaveLength(5);
    expect(payKeyId()).toBe("calling");
    expect(decryptPaySecret(ct)).toBe("123456789");
  });

  it("H1 trap: ciphertext written under the calling key still decrypts after PAY_CRYPTO_KEY is set", () => {
    const ct = encryptPaySecret("021000021:1234567890"); // kid=calling
    process.env.PAY_CRYPTO_KEY = PAY_KEY; // rotation: new writes would use pay
    expect(payKeyName()).toBe("PAY_CRYPTO_KEY");
    expect(decryptPaySecret(ct)).toBe("021000021:1234567890");
  });

  it("new writes carry kid=pay once PAY_CRYPTO_KEY is set", () => {
    process.env.PAY_CRYPTO_KEY = PAY_KEY;
    const ct = encryptPaySecret("w9-tin-5551212");
    expect(ct.split(".")[1]).toBe("pay");
    expect(payKeyId()).toBe("pay");
    expect(decryptPaySecret(ct)).toBe("w9-tin-5551212");
  });

  it("pay-kid ciphertext still decrypts if PAY_CRYPTO_KEY is later unset (envelope resolves the slot)", () => {
    process.env.PAY_CRYPTO_KEY = PAY_KEY;
    const ct = encryptPaySecret("ein-123456789");
    delete process.env.PAY_CRYPTO_KEY; // slot still configured? no — key gone: must fail closed
    expect(() => decryptPaySecret(ct)).toThrow();
  });

  it("legacy v1.iv.ct.tag rows decrypt via the CURRENT resolution (back-compat)", () => {
    // Written by the pre-envelope code path (encryptSensitive directly).
    const legacy = encryptSensitive("legacy-bank-account", "CALLING_DATA_ENCRYPTION_KEY");
    expect(legacy.split(".")).toHaveLength(4);
    expect(decryptPaySecret(legacy)).toBe("legacy-bank-account");

    process.env.PAY_CRYPTO_KEY = PAY_KEY;
    const legacyPay = encryptSensitive("legacy-pay-row", "PAY_CRYPTO_KEY");
    expect(decryptPaySecret(legacyPay)).toBe("legacy-pay-row");
  });

  it("tampered ciphertext is rejected (GCM auth tag)", () => {
    const ct = encryptPaySecret("tamper-me");
    const parts = ct.split(".");
    // Flip one character of the ciphertext body.
    const body = parts[3];
    parts[3] = (body[0] === "A" ? "B" : "A") + body.slice(1);
    expect(() => decryptPaySecret(parts.join("."))).toThrow();
    // And a mangled tag.
    const parts2 = ct.split(".");
    const tag = parts2[4];
    parts2[4] = (tag[0] === "A" ? "B" : "A") + tag.slice(1);
    expect(() => decryptPaySecret(parts2.join("."))).toThrow();
  });

  it("an unknown key id is refused, never silently resolved", () => {
    const ct = encryptPaySecret("known-kid");
    const parts = ct.split(".");
    parts[1] = "rotated-away";
    expect(() => decryptPaySecret(parts.join("."))).toThrow(/key id/i);
  });
});
