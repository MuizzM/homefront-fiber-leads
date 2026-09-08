import type Database from "better-sqlite3";

/** Permission metadata changes rarely; scanner/lead writes must not invalidate
 * scope caches. Triggers run in the writer's transaction, including other
 * workers and raw SQL paths. No TTL or process-local notification is authority. */
export function ensureScopeAuthoritySchema(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS scope_authority_version (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0)
    ); INSERT OR IGNORE INTO scope_authority_version(id,version) VALUES(1,0);`);
    for (const table of ["team_members", "territories", "tenants"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS scope_authority_${table}_${operation.toLowerCase()}
          AFTER ${operation} ON ${table} BEGIN
          UPDATE scope_authority_version SET version=version+1 WHERE id=1;
          END;`);
      }
    }
  })();
}

const statements = new WeakMap<Database.Database, Database.Statement>();
/** A constant-size PK read. Missing/corrupt schema fails closed. */
export function scopeAuthorityVersion(db: Database.Database): number {
  let statement = statements.get(db);
  if (!statement) {
    statement = db.prepare("SELECT version FROM scope_authority_version WHERE id=1");
    statements.set(db, statement);
  }
  const row = statement.get() as { version: number } | undefined;
  if (!row || !Number.isSafeInteger(row.version) || row.version < 0) throw new Error("Scope authority unavailable");
  return row.version;
}
