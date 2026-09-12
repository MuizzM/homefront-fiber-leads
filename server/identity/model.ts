import type Database from "better-sqlite3";
import { SESSION_ABSOLUTE_MAX_MS, SESSION_TTL_MS, sessionTimestamp } from "../sessionLifetime";

export type PrimaryMethod = "email" | "saml" | "oidc";
export type HomefrontFactor = "totp" | "webauthn" | "recovery" | "sms";
export type IdentityDenialCode = "ACCOUNT_INACTIVE" | "ORGANIZATION_INACTIVE" | "APPROVAL_REQUIRED" | "DIRECTORY_INACTIVE"
  | "SSO_REQUIRED" | "MFA_REQUIRED" | "SESSION_EXPIRED" | "REAUTH_REQUIRED" | "SESSION_LIMIT" | "PENDING_LOGIN_LIMIT";
export interface IdentityPolicy {
  revision: number; requireMfa: boolean; requireSso: boolean;
  sessionLimit: number | null; idleTimeoutMs: number; absoluteTimeoutMs: number;
}
export interface IdentityAccount {
  userId: number; tenantId: number | null; name: string; email: string; role: string;
  teamMemberId: number | null; active: boolean; isSuperAdmin: boolean;
  organizationStatus: string | null; authEpoch: number;
  mfaEnabled: boolean; factorRevision: number;
  managed: null | { tenantId: number; approval: string; generation: number; approvedGeneration: number | null; directoryActive: boolean; directoryDeleted: boolean };
  policy: IdentityPolicy;
}
export interface SessionAssurance {
  userId: number; tenantId: number | null; authEpoch: number;
  primaryMethod: PrimaryMethod; mfaMethod: HomefrontFactor | null;
  mfaVerifiedAt: number | null; factorRevision: number | null;
  authenticatedAt: number; lastActivityAt: number;
}
export type IdentityDecision = { allowed: true } | { allowed: false; code: IdentityDenialCode };
const snapshots = new WeakMap<Database.Database, Database.Statement>();

/** Missing schema throws. Only an absent policy/account row means legacy
 * defaults; a failed query must never downgrade a managed identity to legacy. */
export function readIdentityAccount(db: Database.Database, userId: number): IdentityAccount | null {
  let statement = snapshots.get(db);
  if (!statement) {
    statement = db.prepare(`SELECT u.id,u.tenant_id,u.name,u.email,u.role,u.team_member_id,u.active,u.is_super_admin,
      t.status AS organization_status, k.auth_epoch,
      COALESCE(f.enabled,0) AS mfa_enabled, COALESCE(f.revision,0) AS factor_revision,
      a.tenant_id AS managed_tenant,a.approval_state,a.lifecycle_generation,a.approved_generation,a.directory_active,a.directory_deleted,
      p.revision,p.require_mfa,p.require_sso,p.session_limit,p.idle_timeout_ms,p.absolute_timeout_ms
      FROM users u LEFT JOIN tenants t ON t.id=u.tenant_id
      LEFT JOIN identity_accounts a ON a.user_id=u.id
      LEFT JOIN identity_user_security k ON k.user_id=u.id
      LEFT JOIN identity_mfa_state f ON f.user_id=u.id
      LEFT JOIN identity_policies p ON p.tenant_id=u.tenant_id WHERE u.id=?`);
    snapshots.set(db, statement);
  }
  const row = statement.get(userId) as Record<string, any> | undefined;
  if (!row) return null;
  if (row.managed_tenant != null && row.auth_epoch == null) throw new Error("Managed identity security state unavailable");
  const apex = row.is_super_admin === 1;
  const idle = !apex && row.idle_timeout_ms != null ? row.idle_timeout_ms : SESSION_TTL_MS;
  const absolute = !apex && row.absolute_timeout_ms != null ? row.absolute_timeout_ms : SESSION_ABSOLUTE_MAX_MS;
  return {
    userId: row.id, tenantId: row.tenant_id, name: row.name, email: row.email, role: row.role,
    teamMemberId: row.team_member_id, active: row.active === 1, isSuperAdmin: apex,
    organizationStatus: row.organization_status, authEpoch: row.auth_epoch ?? 0,
    mfaEnabled: row.mfa_enabled === 1, factorRevision: row.factor_revision,
    managed: row.managed_tenant == null ? null : { tenantId: row.managed_tenant, approval: row.approval_state,
      generation: row.lifecycle_generation, approvedGeneration: row.approved_generation,
      directoryActive: row.directory_active === 1, directoryDeleted: row.directory_deleted === 1 },
    policy: { revision: row.revision ?? 0, requireMfa: !apex && row.require_mfa === 1, requireSso: !apex && row.require_sso === 1,
      sessionLimit: apex ? null : row.session_limit ?? null, idleTimeoutMs: Math.min(idle, absolute), absoluteTimeoutMs: absolute },
  };
}
export function accountAdmission(account: IdentityAccount | null, method: PrimaryMethod): IdentityDecision {
  if (!account || !account.active) return { allowed: false, code: "ACCOUNT_INACTIVE" };
  if (!account.isSuperAdmin && ["suspended", "cancelled"].includes(String(account.organizationStatus ?? "active").toLowerCase())) {
    return { allowed: false, code: "ORGANIZATION_INACTIVE" };
  }
  const managed = account.managed;
  if (managed) {
    if (managed.tenantId !== account.tenantId || !managed.directoryActive || managed.directoryDeleted) return { allowed: false, code: "DIRECTORY_INACTIVE" };
    if (managed.approval !== "approved" || managed.approvedGeneration !== managed.generation) return { allowed: false, code: "APPROVAL_REQUIRED" };
  }
  if (account.policy.requireSso && method === "email") return { allowed: false, code: "SSO_REQUIRED" };
  return { allowed: true };
}
export function sessionAdmission(account: IdentityAccount | null, session: { createdAt: string; expiresAt: string },
  assurance: SessionAssurance | null, now = Date.now()): IdentityDecision {
  const admitted = accountAdmission(account, assurance?.primaryMethod ?? "email");
  if (!admitted.allowed || !account) return admitted;
  if ((assurance && (assurance.userId !== account.userId || assurance.tenantId !== account.tenantId))
      || (assurance?.authEpoch ?? 0) !== account.authEpoch) return { allowed: false, code: "REAUTH_REQUIRED" };
  const created = sessionTimestamp(session.createdAt), expires = sessionTimestamp(session.expiresAt);
  // Legacy rows lack activity metadata. Their last coalesced renewal is the
  // expiry minus the original idle window; never infer activity in the future.
  const activity = assurance?.lastActivityAt ?? Math.max(created, expires - SESSION_TTL_MS);
  if (![created, expires, activity, now].every(Number.isFinite) || created > now || activity > now || activity < created
      || expires <= now || created + account.policy.absoluteTimeoutMs <= now || activity + account.policy.idleTimeoutMs <= now) {
    return { allowed: false, code: "SESSION_EXPIRED" };
  }
  if (assurance && (!Number.isFinite(assurance.authenticatedAt) || assurance.authenticatedAt > created
      || assurance.authenticatedAt < created - 600_000)) return { allowed: false, code: "REAUTH_REQUIRED" };
  if ((account.policy.requireMfa || account.mfaEnabled) && (!assurance
      || !["totp", "webauthn", "recovery"].includes(assurance.mfaMethod ?? "")
      || assurance.mfaVerifiedAt == null || !Number.isFinite(assurance.mfaVerifiedAt)
      || assurance.mfaVerifiedAt > created || assurance.mfaVerifiedAt < assurance.authenticatedAt
      || assurance.factorRevision !== account.factorRevision || !account.mfaEnabled)) {
    return { allowed: false, code: "MFA_REQUIRED" };
  }
  return { allowed: true };
}
