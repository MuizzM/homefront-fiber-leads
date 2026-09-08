import type Database from "better-sqlite3";
import { can } from "../shared/capabilities";

/** Call after acquiring the writer, so revocation during lock wait wins. */
export function recoveryActorAllowed(db: Database.Database, owner: { tenantId: number; userId: number | null; sessionId?: string }): boolean {
  if (!Number.isSafeInteger(owner.tenantId) || owner.tenantId <= 0 || !owner.userId) return false;
  const actor = db.prepare(`SELECT active,tenant_id,role FROM users WHERE id=?`).get(owner.userId) as
    { active: number; tenant_id: number | null; role: string } | undefined;
  return requestSessionCurrent(db, owner) && actor?.active === 1 && actor.tenant_id === owner.tenantId && can(actor.role, "settings.manage.org");
}

/** HTTP actions bind the current session as well as the current actor. Internal
 * workers/tests without a request session still enforce their own authority. */
export function requestSessionCurrent(db: Database.Database, owner: { tenantId: number; userId: number | null; sessionId?: string }): boolean {
  if (owner.sessionId === undefined) return true;
  return !!db.prepare(`SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
    LEFT JOIN tenants t ON t.id=u.tenant_id
    WHERE s.id=? AND s.user_id=? AND julianday(s.expires_at)>julianday('now')
      AND u.tenant_id=? AND (u.is_super_admin=1 OR lower(COALESCE(t.status,'active')) NOT IN ('suspended','cancelled'))`)
    .get(owner.sessionId, owner.userId, owner.tenantId);
}
