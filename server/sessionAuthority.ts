import type Database from "better-sqlite3";
import type { Session, User } from "../shared/schema";
import { sessionWithinLifetime } from "./sessionLifetime";

type AuthorityRow = Omit<User, "active"> & { active: number; sessionId: string;
  sessionCreatedAt: string; sessionExpiresAt: string; organizationStatus: string | null };
const statements = new WeakMap<Database.Database, Database.Statement>();

/** One indexed read, no renewal/write and no cached authorization decision.
 * A stream or delayed mutation must observe another worker's revocation. */
export function readSessionAuthority(db: Database.Database, token: string, now = Date.now()): {
  user: User; session: Session; organizationStatus: string | null;
} | null {
  if (typeof token !== "string" || token.length > 200 || !token) return null;
  let statement = statements.get(db);
  if (!statement) {
    statement = db.prepare(`SELECT s.id AS sessionId, s.created_at AS sessionCreatedAt,
      s.expires_at AS sessionExpiresAt, u.id, u.name, u.email, u.password_hash AS passwordHash,
      u.tenant_id AS tenantId, u.role, u.is_super_admin AS isSuperAdmin,
      u.team_member_id AS teamMemberId, u.active, u.created_at AS createdAt,
      t.status AS organizationStatus
      FROM sessions s JOIN users u ON u.id=s.user_id
      LEFT JOIN tenants t ON t.id=u.tenant_id WHERE s.id=?`);
    statements.set(db, statement);
  }
  const row = statement.get(token) as AuthorityRow | undefined;
  if (!row) return null;
  const { sessionId, sessionCreatedAt, sessionExpiresAt, organizationStatus, ...account } = row;
  const session: Session = { id: sessionId, userId: row.id, createdAt: sessionCreatedAt, expiresAt: sessionExpiresAt };
  if (!sessionWithinLifetime(session, now)) return null;
  return { user: { ...account, active: row.active === 1 }, session, organizationStatus };
}

/** A captured stream's role/scope must never outlive the identity that opened it.
 * Reconnect re-runs route-specific owner and scope checks with the fresh user. */
export function sameSessionIdentity(before: User, after: User): boolean {
  return after.active && before.id === after.id && before.tenantId === after.tenantId
    && before.role === after.role && before.teamMemberId === after.teamMemberId
    && before.isSuperAdmin === after.isSuperAdmin;
}
