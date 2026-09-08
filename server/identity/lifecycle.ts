import type Database from "better-sqlite3";
import { z } from "zod";
import { isApexEmail } from "../platformApex";
import { readIdentityAccount, sessionAdmission, type IdentityAccount, type SessionAssurance } from "./model";

export class IdentityConflict extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function requireIdentityTransaction(db: Database.Database): void {
  if (!db.inTransaction) throw new Error("Identity mutation requires a writer transaction");
}
export function identityAudit(db: Database.Database, tenantId: number | null, actorId: number | null,
  subjectId: number | null, action: string, detail: Record<string, number | string | boolean | null>, now: number): void {
  requireIdentityTransaction(db);
  const serialized = JSON.stringify(detail);
  if (serialized.length > 2048) throw new Error("Identity audit detail exceeds limit");
  db.prepare(`INSERT INTO identity_audit_events(tenant_id,actor_id,subject_user_id,action,detail,created_at)
    VALUES(?,?,?,?,?,?)`).run(tenantId, actorId, subjectId, action, serialized, now);
}

/** A connection adapter must first authenticate and bind its tenant. This never
 * adopts an existing account: email claims are attributes, not link authority. */
export function provisionManagedAccount(db: Database.Database, input: {
  tenantId: number; email: string; name: string; directoryActive?: boolean;
}, now = Date.now()): IdentityAccount {
  requireIdentityTransaction(db);
  const parsed = z.object({ tenantId: z.number().int().positive(), email: z.string().trim().email().max(254),
    name: z.string().trim().min(1).max(100), directoryActive: z.boolean().default(true) }).parse(input);
  const email = parsed.email.toLowerCase();
  if (isApexEmail(email) || db.prepare("SELECT 1 FROM identity_reserved_emails WHERE email=?").get(email)) {
    throw new IdentityConflict("RESERVED_IDENTITY");
  }
  const tenant = db.prepare("SELECT status FROM tenants WHERE id=?").get(parsed.tenantId) as { status: string } | undefined;
  if (!tenant || ["suspended", "cancelled"].includes(tenant.status.toLowerCase())) throw new IdentityConflict("ORGANIZATION_INACTIVE");
  if (db.prepare("SELECT 1 FROM users WHERE lower(trim(email))=? LIMIT 1").get(email)) throw new IdentityConflict("ACCOUNT_LINK_REQUIRED");
  const id = Number(db.prepare(`INSERT INTO users(tenant_id,name,email,role,is_super_admin,active,created_at)
    VALUES(?,?,?,'rep',0,1,?)`).run(parsed.tenantId, parsed.name, email, new Date(now).toISOString()).lastInsertRowid);
  db.prepare(`INSERT INTO identity_accounts(user_id,tenant_id,directory_active,created_at,updated_at)
    VALUES(?,?,?,?,?)`).run(id, parsed.tenantId, Number(parsed.directoryActive), now, now);
  identityAudit(db, parsed.tenantId, null, id, "identity.provisioned", { directoryActive: parsed.directoryActive }, now);
  return readIdentityAccount(db, id)!;
}

/** Bind all changes to the directory resource's persisted tenant/user and CAS
 * generation. Repeated identical directory updates preserve current approval. */
export function transitionDirectoryAccount(db: Database.Database, input: {
  tenantId: number; userId: number; expectedGeneration: number; active: boolean; deleted?: boolean;
}, now = Date.now()): IdentityAccount {
  requireIdentityTransaction(db);
  const account = readIdentityAccount(db, input.userId);
  if (!account?.managed || account.tenantId !== input.tenantId || account.managed.tenantId !== input.tenantId) {
    throw new IdentityConflict("IDENTITY_NOT_FOUND");
  }
  if (account.managed.generation !== input.expectedGeneration) throw new IdentityConflict("STALE_IDENTITY");
  const deleted = input.deleted ?? false;
  if (deleted && input.active) throw new IdentityConflict("INVALID_DIRECTORY_STATE");
  if (account.managed.directoryActive === input.active && account.managed.directoryDeleted === deleted) return account;
  const changed = db.prepare(`UPDATE identity_accounts SET directory_active=?,directory_deleted=?,
    lifecycle_generation=lifecycle_generation+1,approval_state='pending',approved_generation=NULL,approved_by=NULL,updated_at=?
    WHERE user_id=? AND tenant_id=? AND lifecycle_generation=?`).run(Number(input.active), Number(deleted), now,
      input.userId, input.tenantId, input.expectedGeneration);
  if (changed.changes !== 1) throw new IdentityConflict("STALE_IDENTITY");
  identityAudit(db, input.tenantId, null, input.userId, "identity.directory_changed", {
    active: input.active, deleted, generation: input.expectedGeneration + 1,
  }, now);
  return readIdentityAccount(db, input.userId)!;
}

export function readSessionAssurance(db: Database.Database, sessionId: string): SessionAssurance | null {
  return db.prepare(`SELECT user_id AS userId,tenant_id AS tenantId,auth_epoch AS authEpoch,primary_method AS primaryMethod,
    mfa_method AS mfaMethod,mfa_verified_at AS mfaVerifiedAt,factor_revision AS factorRevision,
    authenticated_at AS authenticatedAt,last_activity_at AS lastActivityAt
    FROM identity_session_assurance WHERE session_id=?`).get(sessionId) as SessionAssurance | undefined ?? null;
}

/** Re-read after acquiring BEGIN IMMEDIATE; middleware's earlier snapshot is
 * insufficient if the administrator was revoked while waiting for the writer. */
export function requireIdentityAdmin(db: Database.Database, sessionId: string, tenantId: number, now = Date.now()): IdentityAccount {
  requireIdentityTransaction(db);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0 || typeof sessionId !== "string" || sessionId.length > 200) {
    throw new IdentityConflict("ADMIN_AUTHORITY_REQUIRED");
  }
  const session = db.prepare("SELECT user_id AS userId,created_at AS createdAt,expires_at AS expiresAt FROM sessions WHERE id=?")
    .get(sessionId) as { userId: number; createdAt: string; expiresAt: string } | undefined;
  const account = session ? readIdentityAccount(db, session.userId) : null;
  if (!session || !account || !sessionAdmission(account, session, readSessionAssurance(db, sessionId), now).allowed
      || (!account.isSuperAdmin && (account.tenantId !== tenantId || !["admin", "super_admin"].includes(account.role)))) {
    throw new IdentityConflict("ADMIN_AUTHORITY_REQUIRED");
  }
  return account;
}

export function reviewManagedAccount(db: Database.Database, input: {
  adminSessionId: string; tenantId: number; userId: number; expectedGeneration: number; decision: "approved" | "rejected";
}, now = Date.now()): IdentityAccount {
  requireIdentityTransaction(db);
  const actor = requireIdentityAdmin(db, input.adminSessionId, input.tenantId, now);
  const account = readIdentityAccount(db, input.userId);
  if (!account?.managed || account.tenantId !== input.tenantId) throw new IdentityConflict("IDENTITY_NOT_FOUND");
  if (account.managed.generation !== input.expectedGeneration) throw new IdentityConflict("STALE_IDENTITY");
  if (!account.managed.directoryActive || account.managed.directoryDeleted) throw new IdentityConflict("DIRECTORY_INACTIVE");
  if (actor.userId === input.userId) throw new IdentityConflict("SELF_APPROVAL_FORBIDDEN");
  if (account.managed.approval === input.decision) return account;
  const changed = db.prepare(`UPDATE identity_accounts SET approval_state=?,approved_generation=?,approved_by=?,updated_at=?
    WHERE user_id=? AND tenant_id=? AND lifecycle_generation=?`).run(input.decision,
      input.decision === "approved" ? input.expectedGeneration : null, actor.userId, now,
      input.userId, input.tenantId, input.expectedGeneration);
  if (changed.changes !== 1) throw new IdentityConflict("STALE_IDENTITY");
  identityAudit(db, input.tenantId, actor.userId, input.userId, `identity.${input.decision}`, { generation: input.expectedGeneration }, now);
  return readIdentityAccount(db, input.userId)!;
}

/** Bind codes on issuance, never after verification. Managed accounts reject
 * older unbound codes so a pre-approval proof cannot gain later authority. */
export function bindIdentityOtp(db: Database.Database, otpId: number, userId: number): void {
  requireIdentityTransaction(db);
  const account = readIdentityAccount(db, userId);
  if (!account) throw new IdentityConflict("ACCOUNT_INACTIVE");
  const otp = db.prepare("SELECT email,used FROM otp_codes WHERE id=?").get(otpId) as { email: string; used: number } | undefined;
  if (!otp || otp.used !== 0 || otp.email.trim().toLowerCase() !== account.email.trim().toLowerCase()) throw new IdentityConflict("INVALID_OTP_OWNER");
  db.prepare("INSERT INTO identity_otp_bindings(otp_id,user_id,tenant_id,auth_epoch) VALUES(?,?,?,?)")
    .run(otpId, userId, account.tenantId, account.authEpoch);
}
export function identityOtpCurrent(db: Database.Database, otpId: number, userId: number): boolean {
  const account = readIdentityAccount(db, userId);
  if (!account) return false;
  const otp = db.prepare("SELECT email,used FROM otp_codes WHERE id=?").get(otpId) as { email: string; used: number } | undefined;
  if (!otp || otp.used !== 0 || otp.email.trim().toLowerCase() !== account.email.trim().toLowerCase()) return false;
  const binding = db.prepare("SELECT user_id,tenant_id,auth_epoch FROM identity_otp_bindings WHERE otp_id=?").get(otpId) as
    { user_id: number; tenant_id: number | null; auth_epoch: number } | undefined;
  return binding ? binding.user_id === userId && binding.tenant_id === account.tenantId && binding.auth_epoch === account.authEpoch
    : !account.managed && account.authEpoch === 0 && !account.mfaEnabled && !account.policy.requireMfa && !account.policy.requireSso;
}
