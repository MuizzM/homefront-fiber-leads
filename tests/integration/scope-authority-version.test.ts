// @vitest-environment node
import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureScopeAuthoritySchema, scopeAuthorityVersion } from "../../server/scopeAuthorityVersion";

it("preserves existing data, observes other writers, survives restart and backup restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-scope-version-"));
  const file = join(dir, "fixture.db"), backup = join(dir, "backup.db");
  const db = new Database(file); let writer: Database.Database | undefined;
  try {
    db.pragma("journal_mode=WAL");
    db.exec("CREATE TABLE team_members(id INTEGER PRIMARY KEY,reports_to_id INTEGER); CREATE TABLE territories(id INTEGER PRIMARY KEY,assignee_ids TEXT); CREATE TABLE tenants(id INTEGER PRIMARY KEY,open_field_enabled INTEGER); CREATE TABLE leads(id INTEGER PRIMARY KEY); INSERT INTO team_members VALUES(1,2); INSERT INTO territories VALUES(1,'[1]'); INSERT INTO tenants VALUES(1,1);");
    ensureScopeAuthoritySchema(db);
    const initial = scopeAuthorityVersion(db);
    writer = new Database(file);
    writer.exec("UPDATE team_members SET reports_to_id=3 WHERE id=1; UPDATE territories SET assignee_ids='[]'; UPDATE tenants SET open_field_enabled=0;");
    expect(scopeAuthorityVersion(db)).toBe(initial + 3);
    writer.exec("INSERT INTO leads VALUES(1); UPDATE leads SET id=2; DELETE FROM leads;");
    expect(scopeAuthorityVersion(db)).toBe(initial + 3);
    writer.exec("BEGIN IMMEDIATE; DELETE FROM territories;");
    expect(scopeAuthorityVersion(db)).toBe(initial + 3);
    writer.exec("ROLLBACK");
    ensureScopeAuthoritySchema(db);
    expect(scopeAuthorityVersion(db)).toBe(initial + 3);
    expect(db.prepare("SELECT * FROM team_members").all()).toEqual([{ id: 1, reports_to_id: 3 }]);
    await db.backup(backup);
    const restored = new Database(backup);
    try {
      ensureScopeAuthoritySchema(restored);
      expect(scopeAuthorityVersion(restored)).toBe(initial + 3);
      restored.exec("DELETE FROM territories; INSERT INTO territories VALUES(1,'[2]');");
      expect(scopeAuthorityVersion(restored)).toBe(initial + 5);
    } finally { restored.close(); }
  } finally { writer?.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rolls back an incomplete install, retries, and rejects missing authority", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE team_members(id INTEGER PRIMARY KEY)");
    expect(() => ensureScopeAuthoritySchema(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='scope_authority_version'").get()).toBeUndefined();
    db.exec("CREATE TABLE territories(id INTEGER PRIMARY KEY); CREATE TABLE tenants(id INTEGER PRIMARY KEY)");
    ensureScopeAuthoritySchema(db);
    expect(scopeAuthorityVersion(db)).toBe(0);
    db.exec("DELETE FROM scope_authority_version");
    expect(() => scopeAuthorityVersion(db)).toThrow("Scope authority unavailable");
  } finally { db.close(); }
});
