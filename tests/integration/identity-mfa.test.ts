// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { generateSync } from "otplib";
import { admitIdentityContinuation, continueVerifiedIdentity } from "../../server/identity/admission";
import { newIdentityToken } from "../../server/identity/crypto";
import { readIdentityAccount } from "../../server/identity/model";
import { beginTotpEnrollment, confirmTotpEnrollment, regenerateRecoveryCodes, verifyRecoveryChallenge, verifyTotpChallenge } from "../../server/identity/mfa";
import { identityFixture, IDENTITY_NOW as now } from "../helpers/identityFixture";
let db: Database.Database;
beforeEach(() => {
  db = identityFixture();
  vi.stubEnv("IDENTITY_ENCRYPTION_ACTIVE_KEY_ID", "fixture");
  vi.stubEnv("IDENTITY_ENCRYPTION_KEYS", JSON.stringify({ fixture: "33".repeat(32) }));
});
afterEach(() => { db.close(); vi.unstubAllEnvs(); });
const tx = <T>(work: () => T) => db.transaction(work).immediate();
function proof(when = now, userId = 3) {
  const account = readIdentityAccount(db, userId)!;
  const browser = newIdentityToken();
  const result = tx(() => continueVerifiedIdentity(db, { userId, tenantId: account.tenantId, authEpoch: account.authEpoch,
    method: "email", browserToken: browser, deviceToken: newIdentityToken(), deviceLabel: "Test browser" }, when));
  if (!("token" in result)) throw new Error(result.code);
  return { ...result, browser };
}
const code = (secret: string, at = now) => generateSync({ secret, epoch: Math.floor(at / 1000) });
function enroll(userId = 3) {
  const p = proof(now, userId);
  const setup = tx(() => beginTotpEnrollment(db, p.token, p.browser, now));
  const result = tx(() => confirmTotpEnrollment(db, p.token, p.browser, code(setup.secret), now));
  if (!result.verified) throw new Error("Fixture MFA enrollment failed");
  return { p, setup, codes: result.recoveryCodes };
}

it("enrolls only after proving a browser-bound secret, stores ciphertext and yields hashed one-use recovery codes", () => {
  const other = proof();
  const { p, setup, codes } = enroll();
  expect(setup.uri).toMatch(/^otpauth:\/\/totp\//);
  const factor = db.prepare("SELECT secret FROM identity_totp_factors WHERE user_id=3").get() as { secret: string };
  expect(factor.secret).toMatch(/^identity1\./); expect(factor.secret).not.toContain(setup.secret);
  expect(codes).toHaveLength(8); expect(new Set(codes).size).toBe(8);
  expect(JSON.stringify(db.prepare("SELECT * FROM identity_recovery_codes").all())).not.toContain(codes[0]);
  expect(db.prepare("SELECT * FROM identity_totp_enrollments").all()).toEqual([]);
  expect(tx(() => admitIdentityContinuation(db, other.token, other.browser, now))).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  expect(tx(() => admitIdentityContinuation(db, p.token, p.browser, now + 1)).state).toBe("authenticated");
});

it("does not enable MFA for an incorrect enrollment code or a different browser", () => {
  const p = proof();
  tx(() => beginTotpEnrollment(db, p.token, p.browser, now));
  expect(() => tx(() => beginTotpEnrollment(db, p.token, newIdentityToken(), now))).toThrow("REAUTH_REQUIRED");
  expect(tx(() => confirmTotpEnrollment(db, p.token, p.browser, "bad", now))).toEqual({ verified: false });
  expect(readIdentityAccount(db, 3)?.mfaEnabled).toBe(false);
  expect(db.prepare("SELECT * FROM identity_totp_factors").all()).toEqual([]);
  expect(db.prepare("SELECT failures FROM identity_mfa_attempts WHERE user_id=3").get()).toEqual({ failures: 1 });
});

it("enforces replay counters across different primary proofs and permits the next authenticator time step", () => {
  const { setup } = enroll();
  const p = proof(now + 1), other = proof(now + 1);
  expect(tx(() => verifyTotpChallenge(db, p.token, p.browser, code(setup.secret), now + 1))).toBe(false);
  const next = now + 30_000;
  expect(tx(() => verifyTotpChallenge(db, p.token, p.browser, code(setup.secret, next), next))).toBe(true);
  expect(tx(() => verifyTotpChallenge(db, other.token, other.browser, code(setup.secret, next), next))).toBe(false);
  expect(tx(() => admitIdentityContinuation(db, p.token, p.browser, next + 1)).state).toBe("authenticated");
});

it("prohibits resetting an enrolled factor or regenerating recovery codes with primary email proof alone", () => {
  const { setup } = enroll(), p = proof(now + 1);
  expect(() => tx(() => beginTotpEnrollment(db, p.token, p.browser, now + 1))).toThrow("MFA_REQUIRED");
  expect(() => tx(() => regenerateRecoveryCodes(db, p.token, p.browser, now + 1))).toThrow("MFA_REQUIRED");
  const next = now + 30_000;
  expect(tx(() => verifyTotpChallenge(db, p.token, p.browser, code(setup.secret, next), next))).toBe(true);
  expect(tx(() => beginTotpEnrollment(db, p.token, p.browser, next + 1)).secret).not.toBe(setup.secret);
});

it("consumes recovery codes once, binds them to the owner and rolls consumption back if final admission fails", () => {
  const { codes } = enroll();
  const foreignCodes = enroll(2).codes;
  const foreign = proof(now + 1, 2);
  expect(tx(() => verifyRecoveryChallenge(db, foreign.token, foreign.browser, codes[0], now + 1))).toBe(false);
  expect(tx(() => verifyRecoveryChallenge(db, foreign.token, foreign.browser, foreignCodes[0], now + 1))).toBe(true);
  const p = proof(now + 1), replay = proof(now + 1);
  db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions WHEN NEW.user_id=3 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  expect(() => tx(() => {
    expect(verifyRecoveryChallenge(db, p.token, p.browser, codes[0], now + 1)).toBe(true);
    return admitIdentityContinuation(db, p.token, p.browser, now + 1);
  })).toThrow("fixture failure");
  expect(db.prepare("SELECT count(*) AS n FROM identity_recovery_codes WHERE user_id=3 AND used_at IS NOT NULL").get()).toEqual({ n: 0 });
  db.exec("DROP TRIGGER fail_session");
  expect(tx(() => verifyRecoveryChallenge(db, p.token, p.browser, codes[0], now + 1))).toBe(true);
  expect(tx(() => verifyRecoveryChallenge(db, replay.token, replay.browser, codes[0], now + 1))).toBe(false);
});

it("persists a per-user failed-attempt budget across new challenges", () => {
  const { setup } = enroll();
  const p = proof(now + 1), other = proof(now + 1);
  for (let n = 0; n < 10; n++) expect(tx(() => verifyTotpChallenge(db, p.token, p.browser, "invalid", now + 1))).toBe(false);
  expect(() => tx(() => verifyTotpChallenge(db, other.token, other.browser, code(setup.secret, now + 30_000), now + 30_000))).toThrow("MFA_RATE_LIMIT");
  const later = proof(now + 900_002);
  expect(tx(() => verifyTotpChallenge(db, later.token, later.browser, code(setup.secret, now + 900_002), now + 900_002))).toBe(true);
});

it("rolls factor changes and revocations back if the new secret cannot be persisted", () => {
  const p = proof(), other = proof();
  const setup = tx(() => beginTotpEnrollment(db, p.token, p.browser, now));
  db.exec("INSERT INTO sessions VALUES('prior',3,'2026-09-08T11:00:00.000Z','2026-09-15T11:00:00.000Z'); CREATE TRIGGER fail_factor BEFORE INSERT ON identity_totp_factors BEGIN SELECT RAISE(ABORT,'fixture factor failure'); END");
  expect(() => tx(() => confirmTotpEnrollment(db, p.token, p.browser, code(setup.secret), now))).toThrow("fixture factor failure");
  expect(readIdentityAccount(db, 3)).toMatchObject({ mfaEnabled: false, authEpoch: 0 });
  expect(db.prepare("SELECT id FROM sessions WHERE id='prior'").get()).toEqual({ id: "prior" });
  expect(db.prepare("SELECT count(*) AS n FROM identity_continuations WHERE user_id=3").get()).toEqual({ n: 2 });
  db.exec("DROP TRIGGER fail_factor");
  expect(tx(() => confirmTotpEnrollment(db, p.token, p.browser, code(setup.secret), now)).verified).toBe(true);
  expect(tx(() => admitIdentityContinuation(db, other.token, other.browser, now))).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
});

it("fails closed on missing or wrong encryption keys without changing factors or revocation state", () => {
  const p = proof();
  vi.stubEnv("IDENTITY_ENCRYPTION_KEYS", "{}");
  expect(() => tx(() => beginTotpEnrollment(db, p.token, p.browser, now))).toThrow();
  expect(db.prepare("SELECT * FROM identity_totp_enrollments").all()).toEqual([]);
  expect(readIdentityAccount(db, 3)?.authEpoch).toBe(0);
});

it("regenerating recovery codes revokes earlier verified recovery proofs and preserves only the rotating browser", () => {
  const { codes } = enroll(); const current = proof(now + 1), old = proof(now + 1);
  expect(tx(() => verifyRecoveryChallenge(db, current.token, current.browser, codes[0], now + 1))).toBe(true);
  expect(tx(() => verifyRecoveryChallenge(db, old.token, old.browser, codes[1], now + 1))).toBe(true);
  const replacement = tx(() => regenerateRecoveryCodes(db, current.token, current.browser, now + 2));
  expect(replacement).toHaveLength(8); expect(replacement).not.toContain(codes[0]);
  expect(tx(() => admitIdentityContinuation(db, old.token, old.browser, now + 2))).toEqual({ state: "denied", code: "REAUTH_REQUIRED" });
  expect(tx(() => admitIdentityContinuation(db, current.token, current.browser, now + 2)).state).toBe("authenticated");
});
