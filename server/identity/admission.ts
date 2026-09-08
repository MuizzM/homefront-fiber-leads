import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Session } from "../../shared/schema";
import { hashIdentityToken, newIdentityToken } from "./crypto";
import { accountAdmission, readIdentityAccount, sessionAdmission, type IdentityAccount, type IdentityDenialCode,
  type PrimaryMethod, type SessionAssurance } from "./model";
import { identityAudit, readSessionAssurance, requireIdentityTransaction } from "./lifecycle";

const CONTINUATION_MS = 600_000;
const MAX_PENDING_PER_USER = 5;
export type AdmissionResult = { state: "authenticated"; session: Session; account: IdentityAccount }
  | { state: "denied"; code: IdentityDenialCode }
  | { state: "mfa_required"; enroll: boolean }
  | { state: "session_limit"; limit: number };
export interface Continuation {
  token_hash: string; browser_hash: string; user_id: number; tenant_id: number | null; auth_epoch: number;
  primary_method: PrimaryMethod; created_at: number; expires_at: number; attempts: number;
  connection_id: string | null; connection_revision: number | null;
  mfa_method: SessionAssurance["mfaMethod"]; mfa_verified_at: number | null; factor_revision: number | null;
  device_hash: string; device_label: string;
}

export function readCurrentContinuation(db: Database.Database, token: string, browserToken: string, now = Date.now()):
  { proof: Continuation; account: IdentityAccount } | null {
  const proof = db.prepare("SELECT * FROM identity_continuations WHERE token_hash=? AND browser_hash=?")
    .get(hashIdentityToken(token, "continuation"), hashIdentityToken(browserToken, "browser")) as Continuation | undefined;
  if (!proof || proof.created_at > now || proof.expires_at <= now || proof.attempts >= 10) return null;
  const account = readIdentityAccount(db, proof.user_id);
  if (!account || account.tenantId !== proof.tenant_id || account.authEpoch !== proof.auth_epoch
      || !accountAdmission(account, proof.primary_method).allowed) return null;
  return { proof, account };
}

/** The caller must verify and consume the primary proof in this same writer
 * transaction. Never expose this operation as an unauthenticated user-id API. */
export function continueVerifiedIdentity(db: Database.Database, input: {
  userId: number; tenantId: number | null; authEpoch: number; method: PrimaryMethod;
  browserToken: string; deviceToken: string; deviceLabel: string;
}, now = Date.now()): { token: string; expiresAt: number } | { code: IdentityDenialCode; retryAt?: number } {
  requireIdentityTransaction(db);
  const account = readIdentityAccount(db, input.userId);
  const decision = accountAdmission(account, input.method);
  if (!decision.allowed) return { code: decision.code };
  if (!account || account.tenantId !== input.tenantId || account.authEpoch !== input.authEpoch) return { code: "REAUTH_REQUIRED" };
  const browserHash = hashIdentityToken(input.browserToken, "browser"), deviceHash = hashIdentityToken(input.deviceToken, "device");
  const label = input.deviceLabel.trim();
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) throw new Error("Invalid device label");
  db.prepare("DELETE FROM identity_continuations WHERE user_id=? AND expires_at<=?").run(input.userId, now);
  // A deliberately restarted primary login replaces this browser's old flow;
  // other browsers retain their own proof and original deadline.
  db.prepare("DELETE FROM identity_continuations WHERE user_id=? AND browser_hash=?").run(input.userId, browserHash);
  const pending = db.prepare("SELECT expires_at FROM identity_continuations WHERE user_id=? ORDER BY expires_at LIMIT ?")
    .all(input.userId, MAX_PENDING_PER_USER) as Array<{ expires_at: number }>;
  if (pending.length >= MAX_PENDING_PER_USER) return { code: "PENDING_LOGIN_LIMIT", retryAt: pending[0].expires_at };
  const token = newIdentityToken();
  db.prepare(`INSERT INTO identity_continuations(token_hash,browser_hash,user_id,tenant_id,auth_epoch,primary_method,
    created_at,expires_at,device_hash,device_label) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(hashIdentityToken(token, "continuation"),
      browserHash, input.userId, input.tenantId, input.authEpoch, input.method, now, now + CONTINUATION_MS, deviceHash, label);
  return { token, expiresAt: now + CONTINUATION_MS };
}

/** Indexed, bounded capacity probe. If legacy data exceeds the bounded read,
 * refuse a new session conservatively; never evict or authorize overflow. */
function atSessionCapacity(db: Database.Database, account: IdentityAccount, now: number): boolean {
  const limit = account.policy.sessionLimit;
  if (limit == null) return false;
  const rows = db.prepare(`SELECT s.id,s.created_at AS createdAt,s.expires_at AS expiresAt,
    a.user_id AS userId,a.tenant_id AS tenantId,a.auth_epoch AS authEpoch,a.primary_method AS primaryMethod,
    a.mfa_method AS mfaMethod,a.mfa_verified_at AS mfaVerifiedAt,a.factor_revision AS factorRevision,
    a.authenticated_at AS authenticatedAt,a.last_activity_at AS lastActivityAt
    FROM sessions s LEFT JOIN identity_session_assurance a ON a.session_id=s.id
    WHERE s.user_id=? AND julianday(s.expires_at)>julianday(?) ORDER BY julianday(s.expires_at) LIMIT 501`)
    .all(account.userId, new Date(now).toISOString()) as Array<SessionAssurance & { id: string; createdAt: string; expiresAt: string }>;
  if (rows.length > 500) return true;
  let count = 0;
  for (const row of rows) {
    if (sessionAdmission(account, row, row.userId == null ? null : row, now).allowed && ++count >= limit) return true;
  }
  return false;
}

/** Only this final transition creates application authority. Every decision is
 * made after acquiring the writer, so policy/revocation/capacity changes win. */
export function admitIdentityContinuation(db: Database.Database, token: string, browserToken: string, now = Date.now()): AdmissionResult {
  requireIdentityTransaction(db);
  const tokenHash = hashIdentityToken(token, "continuation"), browserHash = hashIdentityToken(browserToken, "browser");
  const proof = db.prepare("SELECT * FROM identity_continuations WHERE token_hash=? AND browser_hash=?")
    .get(tokenHash, browserHash) as Continuation | undefined;
  if (!proof) {
    const completed = db.prepare(`SELECT r.user_id AS userId,r.tenant_id AS tenantId,s.id,s.created_at AS createdAt,s.expires_at AS expiresAt
      FROM identity_completion_receipts r JOIN sessions s ON s.id=r.session_id AND s.user_id=r.user_id
      WHERE r.token_hash=? AND r.browser_hash=? AND r.completed_at<=? AND r.expires_at>?`)
      .get(tokenHash, browserHash, now, now) as (Session & { tenantId: number | null }) | undefined;
    const account = completed ? readIdentityAccount(db, completed.userId) : null;
    if (completed && account && account.tenantId === completed.tenantId
        && sessionAdmission(account, completed, readSessionAssurance(db, completed.id), now).allowed) {
      return { state: "authenticated", account, session: { id: completed.id, userId: completed.userId,
        createdAt: completed.createdAt, expiresAt: completed.expiresAt } };
    }
  }
  if (!proof || proof.created_at > now || proof.expires_at <= now || proof.attempts >= 10) return { state: "denied", code: "REAUTH_REQUIRED" };
  const account = readIdentityAccount(db, proof.user_id);
  const decision = accountAdmission(account, proof.primary_method);
  if (!decision.allowed) return { state: "denied", code: decision.code };
  if (!account || account.tenantId !== proof.tenant_id || account.authEpoch !== proof.auth_epoch) return { state: "denied", code: "REAUTH_REQUIRED" };
  const session: Session = { id: randomUUID(), userId: account.userId, createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.min(account.policy.idleTimeoutMs, account.policy.absoluteTimeoutMs)).toISOString() };
  const assurance: SessionAssurance = { userId: account.userId, tenantId: account.tenantId, authEpoch: account.authEpoch,
    primaryMethod: proof.primary_method, mfaMethod: proof.mfa_method, mfaVerifiedAt: proof.mfa_verified_at,
    factorRevision: proof.factor_revision, authenticatedAt: proof.created_at, lastActivityAt: now };
  const permitted = sessionAdmission(account, session, assurance, now);
  if (!permitted.allowed) return permitted.code === "MFA_REQUIRED"
    ? { state: "mfa_required", enroll: !account.mfaEnabled } : { state: "denied", code: permitted.code };
  if (atSessionCapacity(db, account, now)) return { state: "session_limit", limit: account.policy.sessionLimit! };
  const deleted = db.prepare("DELETE FROM identity_continuations WHERE token_hash=? AND browser_hash=?").run(tokenHash, browserHash);
  if (deleted.changes !== 1) return { state: "denied", code: "REAUTH_REQUIRED" };
  const device = db.prepare(`INSERT INTO identity_devices(id,user_id,tenant_id,binding_hash,label,created_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,binding_hash) DO UPDATE SET label=excluded.label,last_seen_at=excluded.last_seen_at,
      trusted=CASE WHEN identity_devices.tenant_id IS excluded.tenant_id THEN identity_devices.trusted ELSE 0 END,tenant_id=excluded.tenant_id
    RETURNING id`).get(randomUUID(), account.userId, account.tenantId, proof.device_hash, proof.device_label, now, now) as { id: string };
  db.prepare("INSERT INTO sessions(id,user_id,created_at,expires_at) VALUES(?,?,?,?)")
    .run(session.id, account.userId, session.createdAt, session.expiresAt);
  db.prepare(`INSERT INTO identity_session_assurance(session_id,user_id,tenant_id,auth_epoch,primary_method,
    mfa_method,mfa_verified_at,factor_revision,device_id,authenticated_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(session.id, account.userId, account.tenantId, account.authEpoch, proof.primary_method, proof.mfa_method,
      proof.mfa_verified_at, proof.factor_revision, device.id, proof.created_at, now);
  db.prepare(`DELETE FROM identity_completion_receipts WHERE token_hash IN (
    SELECT token_hash FROM identity_completion_receipts WHERE expires_at<=? ORDER BY expires_at LIMIT 100)`).run(now);
  db.prepare(`INSERT INTO identity_completion_receipts(token_hash,browser_hash,user_id,tenant_id,session_id,completed_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`).run(tokenHash, browserHash, account.userId, account.tenantId, session.id, now, Math.min(now + 120_000, proof.expires_at));
  identityAudit(db, account.tenantId, account.userId, account.userId, "identity.session_created", {
    method: proof.primary_method, mfa: proof.mfa_method,
  }, now);
  return { state: "authenticated", session, account };
}
