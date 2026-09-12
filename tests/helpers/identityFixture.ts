import Database from "better-sqlite3";
import { ensureIdentityCoreSchema } from "../../server/identity/schema";
export const IDENTITY_NOW = Date.parse("2026-09-08T12:00:00.000Z");

/** Synthetic legacy tables use the columns/types read by the additive core. */
export function identityFixture(file = ":memory:", install = true): Database.Database {
  const db = new Database(file);
  db.pragma("foreign_keys=ON");
  db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE tenants(id INTEGER PRIMARY KEY,status TEXT NOT NULL);
    CREATE TABLE users(id INTEGER PRIMARY KEY,tenant_id INTEGER,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,team_member_id INTEGER,is_super_admin INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE otp_codes(id INTEGER PRIMARY KEY,email TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE auth_delivery_outbox(id TEXT PRIMARY KEY,user_id INTEGER,status TEXT,payload TEXT,lease_token TEXT,lease_until INTEGER,completed_at INTEGER);
    INSERT INTO tenants VALUES(1,'active'),(2,'active');
    INSERT INTO users(id,tenant_id,name,email,role,created_at) VALUES
      (1,1,'Admin One','admin1@example.test','admin','2026-09-08T00:00:00.000Z'),
      (2,2,'Admin Two','admin2@example.test','admin','2026-09-08T00:00:00.000Z'),
      (3,1,'Rep','rep@example.test','rep','2026-09-08T00:00:00.000Z');
    INSERT INTO sessions VALUES('admin1',1,'2026-09-08T11:00:00.000Z','2026-09-15T11:00:00.000Z'),
      ('admin2',2,'2026-09-08T11:00:00.000Z','2026-09-15T11:00:00.000Z');`);
  if (install) ensureIdentityCoreSchema(db);
  return db;
}
