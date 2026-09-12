import type Database from "better-sqlite3";
import { generateSecret, generateURI, verifySync } from "otplib";
import { encryptIdentitySecret, decryptIdentitySecret, hashIdentityToken, newIdentityToken } from "./crypto";
import { readCurrentContinuation, type Continuation } from "./admission";
import { readIdentityAccount, type IdentityAccount } from "./model";
import { IdentityConflict, identityAudit, requireIdentityTransaction } from "./lifecycle";

const MFA_WINDOW_MS = 900_000;
export function requireMfaContinuation(db: Database.Database, token: string, browserToken: string, now: number) {
  requireIdentityTransaction(db);
  const current = readCurrentContinuation(db, token, browserToken, now);
  if (!current) throw new IdentityConflict("REAUTH_REQUIRED");
  const budget = db.prepare("SELECT window_start,failures FROM identity_mfa_attempts WHERE user_id=?")
    .get(current.account.userId) as { window_start: number; failures: number } | undefined;
  if (budget && budget.window_start + MFA_WINDOW_MS > now && budget.failures >= 10) throw new IdentityConflict("MFA_RATE_LIMIT");
  return current;
}
export function recordMfaFailure(db: Database.Database, proof: Continuation, now: number): void {
  requireIdentityTransaction(db);
  db.prepare("UPDATE identity_continuations SET attempts=attempts+1 WHERE token_hash=? AND attempts<10").run(proof.token_hash);
  db.prepare(`INSERT INTO identity_mfa_attempts(user_id,window_start,failures) VALUES(?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET window_start=CASE WHEN window_start+?<=excluded.window_start THEN excluded.window_start ELSE window_start END,
      failures=CASE WHEN window_start+?<=excluded.window_start THEN 1 ELSE min(10,failures+1) END`)
    .run(proof.user_id, now, MFA_WINDOW_MS, MFA_WINDOW_MS);
}
export function hasCurrentHomefrontMfa(proof: Continuation, account: IdentityAccount, now: number): boolean {
  return account.mfaEnabled && proof.factor_revision === account.factorRevision
    && ["totp", "webauthn", "recovery"].includes(proof.mfa_method ?? "")
    && proof.mfa_verified_at != null && proof.mfa_verified_at >= proof.created_at && proof.mfa_verified_at <= now;
}

function enrollmentContext(proof: Continuation, revision: number) {
  return { tenantId: proof.tenant_id, owner: `enrollment:${proof.token_hash}`, purpose: "totp" as const, revision };
}
function factorContext(account: IdentityAccount, revision: number) {
  return { tenantId: account.tenantId, owner: `user:${account.userId}`, purpose: "totp" as const, revision };
}

export function beginTotpEnrollment(db: Database.Database, token: string, browserToken: string, now = Date.now()): { secret: string; uri: string } {
  const { proof, account } = requireMfaContinuation(db, token, browserToken, now);
  if (account.mfaEnabled && !hasCurrentHomefrontMfa(proof, account, now)) throw new IdentityConflict("MFA_REQUIRED");
  let enrollment = db.prepare("SELECT secret,secret_revision FROM identity_totp_enrollments WHERE continuation_hash=?")
    .get(proof.token_hash) as { secret: string; secret_revision: number } | undefined;
  if (!enrollment) {
    const revision = account.factorRevision + 1;
    enrollment = { secret: encryptIdentitySecret(generateSecret(), enrollmentContext(proof, revision)), secret_revision: revision };
    db.prepare("INSERT INTO identity_totp_enrollments(continuation_hash,secret,secret_revision) VALUES(?,?,?)")
      .run(proof.token_hash, enrollment.secret, enrollment.secret_revision);
  }
  const secret = decryptIdentitySecret(enrollment.secret, enrollmentContext(proof, enrollment.secret_revision));
  return { secret, uri: generateURI({ secret, issuer: "Homefront", label: account.email, algorithm: "sha1", digits: 6, period: 30 }) };
}

/** Factor changes revoke all older sessions/proofs. Only the current, freshly
 * verified browser continuation is rebound to the new epoch in the same commit. */
export function advanceMfaAuthority(db: Database.Database, proof: Continuation, method: "totp" | "webauthn" | "recovery", now: number): IdentityAccount {
  requireIdentityTransaction(db);
  db.prepare("INSERT OR IGNORE INTO identity_mfa_state(user_id) VALUES(?)").run(proof.user_id);
  db.prepare("UPDATE identity_mfa_state SET enabled=1,revision=revision+1 WHERE user_id=?").run(proof.user_id);
  const account = readIdentityAccount(db, proof.user_id)!;
  db.prepare(`INSERT INTO identity_continuations(token_hash,browser_hash,user_id,tenant_id,auth_epoch,primary_method,
    connection_id,connection_revision,created_at,expires_at,attempts,mfa_method,mfa_verified_at,factor_revision,device_hash,device_label)
    VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`).run(proof.token_hash, proof.browser_hash, proof.user_id, proof.tenant_id, account.authEpoch,
      proof.primary_method, proof.connection_id, proof.connection_revision, proof.created_at, proof.expires_at,
      method, now, account.factorRevision, proof.device_hash, proof.device_label);
  return account;
}
export function replaceRecoveryCodes(db: Database.Database, userId: number, now: number): string[] {
  requireIdentityTransaction(db);
  db.prepare("DELETE FROM identity_recovery_codes WHERE user_id=?").run(userId);
  const codes = Array.from({ length: 8 }, () => newIdentityToken());
  const insert = db.prepare("INSERT INTO identity_recovery_codes(token_hash,user_id,created_at) VALUES(?,?,?)");
  for (const code of codes) insert.run(hashIdentityToken(code, "recovery"), userId, now);
  return codes;
}

export function confirmTotpEnrollment(db: Database.Database, token: string, browserToken: string, code: string, now = Date.now()):
  { verified: false } | { verified: true; recoveryCodes: string[] } {
  const { proof, account } = requireMfaContinuation(db, token, browserToken, now);
  if (account.mfaEnabled && !hasCurrentHomefrontMfa(proof, account, now)) throw new IdentityConflict("MFA_REQUIRED");
  const enrollment = db.prepare("SELECT secret,secret_revision FROM identity_totp_enrollments WHERE continuation_hash=?")
    .get(proof.token_hash) as { secret: string; secret_revision: number } | undefined;
  if (!enrollment || enrollment.secret_revision !== account.factorRevision + 1) throw new IdentityConflict("MFA_ENROLLMENT_REQUIRED");
  const secret = decryptIdentitySecret(enrollment.secret, enrollmentContext(proof, enrollment.secret_revision));
  const verification = /^\d{6}$/.test(code) ? verifySync({ secret, token: code, epoch: Math.floor(now / 1000), epochTolerance: 30 }) : { valid: false as const };
  if (!verification.valid || !("timeStep" in verification)) { recordMfaFailure(db, proof, now); return { verified: false }; }
  const updated = advanceMfaAuthority(db, proof, "totp", now);
  const encrypted = encryptIdentitySecret(secret, factorContext(updated, enrollment.secret_revision));
  db.prepare(`INSERT INTO identity_totp_factors(user_id,secret,secret_revision,last_time_step,created_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,secret_revision=excluded.secret_revision,
      last_time_step=excluded.last_time_step,created_at=excluded.created_at`)
    .run(account.userId, encrypted, enrollment.secret_revision, verification.timeStep, now);
  const recoveryCodes = replaceRecoveryCodes(db, account.userId, now);
  identityAudit(db, account.tenantId, account.userId, account.userId, "identity.totp_enrolled", { revision: updated.factorRevision }, now);
  return { verified: true, recoveryCodes };
}

export function verifyTotpChallenge(db: Database.Database, token: string, browserToken: string, code: string, now = Date.now()): boolean {
  const { proof, account } = requireMfaContinuation(db, token, browserToken, now);
  const factor = db.prepare("SELECT secret,secret_revision,last_time_step FROM identity_totp_factors WHERE user_id=?")
    .get(account.userId) as { secret: string; secret_revision: number; last_time_step: number } | undefined;
  if (!account.mfaEnabled || !factor) throw new IdentityConflict("MFA_ENROLLMENT_REQUIRED");
  const secret = decryptIdentitySecret(factor.secret, factorContext(account, factor.secret_revision));
  const result = /^\d{6}$/.test(code) ? verifySync({ secret, token: code, epoch: Math.floor(now / 1000), epochTolerance: 30,
    afterTimeStep: factor.last_time_step }) : { valid: false as const };
  if (!result.valid || !("timeStep" in result)) { recordMfaFailure(db, proof, now); return false; }
  db.prepare("UPDATE identity_totp_factors SET last_time_step=? WHERE user_id=?").run(result.timeStep, account.userId);
  db.prepare("UPDATE identity_continuations SET mfa_method='totp',mfa_verified_at=?,factor_revision=? WHERE token_hash=?")
    .run(now, account.factorRevision, proof.token_hash);
  identityAudit(db, account.tenantId, account.userId, account.userId, "identity.mfa_verified", { method: "totp" }, now);
  return true;
}

export function verifyRecoveryChallenge(db: Database.Database, token: string, browserToken: string, code: string, now = Date.now()): boolean {
  const { proof, account } = requireMfaContinuation(db, token, browserToken, now);
  if (!account.mfaEnabled) throw new IdentityConflict("MFA_ENROLLMENT_REQUIRED");
  const validShape = /^[A-Za-z0-9_-]{43}$/.test(code);
  const consumed = validShape && db.prepare("UPDATE identity_recovery_codes SET used_at=? WHERE token_hash=? AND user_id=? AND used_at IS NULL")
    .run(now, hashIdentityToken(code, "recovery"), account.userId).changes === 1;
  if (!consumed) { recordMfaFailure(db, proof, now); return false; }
  db.prepare("UPDATE identity_continuations SET mfa_method='recovery',mfa_verified_at=?,factor_revision=? WHERE token_hash=?")
    .run(now, account.factorRevision, proof.token_hash);
  identityAudit(db, account.tenantId, account.userId, account.userId, "identity.mfa_verified", { method: "recovery" }, now);
  return true;
}

export function regenerateRecoveryCodes(db: Database.Database, token: string, browserToken: string, now = Date.now()): string[] {
  const { proof, account } = requireMfaContinuation(db, token, browserToken, now);
  if (!hasCurrentHomefrontMfa(proof, account, now)) throw new IdentityConflict("MFA_REQUIRED");
  advanceMfaAuthority(db, proof, proof.mfa_method as "totp" | "webauthn" | "recovery", now);
  const codes = replaceRecoveryCodes(db, account.userId, now);
  identityAudit(db, account.tenantId, account.userId, account.userId, "identity.recovery_regenerated", {}, now);
  return codes;
}
