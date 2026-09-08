// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureIdentityCoreSchema } from "../../server/identity/schema";
import { accountAdmission, readIdentityAccount } from "../../server/identity/model";
import { bindIdentityOtp, identityOtpCurrent, provisionManagedAccount, reviewManagedAccount, transitionDirectoryAccount } from "../../server/identity/lifecycle";
import { identityFixture, IDENTITY_NOW as now } from "../helpers/identityFixture";
let db: Database.Database;
beforeEach(() => { db = identityFixture(); });
afterEach(() => { if (db.open) db.close(); });
const provision = (email = "new@example.test") => db.transaction(() => provisionManagedAccount(db, { tenantId: 1, email, name: "New rep" }, now)).immediate();
const review = (userId: number, expectedGeneration = 1, adminSessionId = "admin1") => db.transaction(() => reviewManagedAccount(db,
  { adminSessionId, tenantId: 1, userId, expectedGeneration, decision: "approved" }, now)).immediate();
const directory = (userId: number, expectedGeneration: number, active: boolean, deleted = false) => db.transaction(() => transitionDirectoryAccount(db,
  { tenantId: 1, userId, expectedGeneration, active, deleted }, now)).immediate();

it("provisions only new tenant-bound reps and refuses every form of email adoption", () => {
  expect(() => provisionManagedAccount(db, { tenantId: 1, email: "new@example.test", name: "New" }, now)).toThrow("transaction");
  const account = provision();
  expect(account).toMatchObject({ role: "rep", teamMemberId: null, active: true, isSuperAdmin: false, authEpoch: 1,
    managed: { approval: "pending", generation: 1, directoryActive: true } });
  expect(accountAdmission(account, "email")).toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
  for (const email of ["rep@example.test", "ADMIN2@example.test", " new@example.test "]) expect(() => provision(email)).toThrow("ACCOUNT_LINK_REQUIRED");
  db.exec("UPDATE users SET tenant_id=NULL WHERE id=3");
  expect(() => provision("REP@example.test")).toThrow("ACCOUNT_LINK_REQUIRED");
  const reserved = db.prepare("SELECT email FROM identity_reserved_emails LIMIT 1").get() as { email: string };
  expect(() => provision(reserved.email)).toThrow("RESERVED_IDENTITY");
});

it("requires renewed approval after disable/reactivate, preserves local offboarding, and handles retries idempotently", () => {
  const id = provision().userId;
  expect(accountAdmission(review(id), "oidc")).toEqual({ allowed: true });
  const approved = readIdentityAccount(db, id)!;
  expect(directory(id, 1, true)).toEqual(approved);
  expect(directory(id, 1, false).managed).toMatchObject({ generation: 2, approval: "pending", directoryActive: false });
  db.prepare("UPDATE users SET active=0 WHERE id=?").run(id);
  const enabled = directory(id, 2, true);
  expect(enabled).toMatchObject({ active: false, managed: { generation: 3, approval: "pending", approvedGeneration: null } });
  expect(() => review(id, 1)).toThrow("STALE_IDENTITY");
  review(id, 3);
  expect(readIdentityAccount(db, id)?.active).toBe(false);
  db.prepare("UPDATE users SET active=1 WHERE id=?").run(id);
  expect(accountAdmission(readIdentityAccount(db, id), "email")).toEqual({ allowed: true });
  directory(id, 3, false, true);
  db.prepare("UPDATE users SET active=1 WHERE id=?").run(id);
  expect(accountAdmission(readIdentityAccount(db, id), "email")).toEqual({ allowed: false, code: "DIRECTORY_INACTIVE" });
});

it("SQL constraints prevent approval, directory, deletion, owner and epoch reset bypasses", () => {
  const id = provision().userId; review(id);
  for (const sql of [
    `UPDATE identity_accounts SET directory_active=0 WHERE user_id=${id}`,
    `UPDATE identity_accounts SET approved_generation=NULL WHERE user_id=${id}`,
    `UPDATE identity_accounts SET lifecycle_generation=0 WHERE user_id=${id}`,
    `UPDATE identity_accounts SET tenant_id=2 WHERE user_id=${id}`,
    `DELETE FROM identity_accounts WHERE user_id=${id}`,
    `DELETE FROM users WHERE id=${id}`,
    `UPDATE users SET tenant_id=2 WHERE id=${id}`,
    `UPDATE users SET is_super_admin=1 WHERE id=${id}`,
    `DELETE FROM identity_user_security WHERE user_id=${id}`,
    `UPDATE identity_user_security SET auth_epoch=0 WHERE user_id=${id}`,
  ]) expect(() => db.exec(sql), sql).toThrow();
  directory(id, 1, false);
  expect(() => db.prepare("UPDATE identity_accounts SET directory_active=1 WHERE user_id=?").run(id)).toThrow("fresh_approval");
  db.exec("INSERT INTO identity_user_security VALUES(3,0); INSERT INTO identity_mfa_state(user_id) VALUES(3)");
  expect(() => db.exec("DELETE FROM identity_mfa_state WHERE user_id=3")).toThrow();
  expect(() => db.exec("UPDATE identity_mfa_state SET enabled=1 WHERE user_id=3")).toThrow();
  db.exec("DELETE FROM users WHERE id=3");
  expect(db.prepare("SELECT * FROM identity_user_security WHERE user_id=3").get()).toBeUndefined();
  expect(db.prepare("SELECT * FROM identity_mfa_state WHERE user_id=3").get()).toBeUndefined();
});

it("invalidates bound OTPs, queued delivery, sessions and primary continuations on lifecycle changes", () => {
  const id = provision().userId; review(id);
  db.transaction(() => {
    db.prepare("INSERT INTO otp_codes(id,email) VALUES(1,'new@example.test')").run();
    bindIdentityOtp(db, 1, id);
    db.prepare("INSERT INTO sessions VALUES('rep-session',?,'2026-09-08T11:00:00.000Z','2026-09-15T11:00:00.000Z')").run(id);
    db.prepare("INSERT INTO auth_delivery_outbox(id,user_id,status,payload,lease_token,lease_until) VALUES('mail',?,'processing','encrypted','lease',?)").run(id, now + 1000);
    db.prepare(`INSERT INTO identity_continuations(token_hash,browser_hash,user_id,tenant_id,auth_epoch,primary_method,created_at,expires_at,device_hash,device_label)
      VALUES(?,?,?,1,?,'email',?,?,?,'test')`).run("a".repeat(64), "b".repeat(64), id, readIdentityAccount(db, id)!.authEpoch, now, now + 1000, "c".repeat(64));
  }).immediate();
  expect(identityOtpCurrent(db, 1, id)).toBe(true);
  directory(id, 1, false);
  expect(db.prepare("SELECT used FROM otp_codes WHERE id=1").get()).toEqual({ used: 1 });
  expect(identityOtpCurrent(db, 1, id)).toBe(false);
  expect(db.prepare("SELECT * FROM sessions WHERE user_id=?").all(id)).toEqual([]);
  expect(db.prepare("SELECT * FROM identity_continuations WHERE user_id=?").all(id)).toEqual([]);
  expect(db.prepare("SELECT status,payload,lease_token,lease_until FROM auth_delivery_outbox WHERE id='mail'").get())
    .toEqual({ status: "discarded", payload: null, lease_token: null, lease_until: null });
  directory(id, 2, true); review(id, 3);
  expect(identityOtpCurrent(db, 1, id)).toBe(false);
});

it("rejects foreign, revoked and locally demoted approval actors", () => {
  const id = provision().userId;
  expect(() => review(id, 1, "admin2")).toThrow("ADMIN_AUTHORITY_REQUIRED");
  db.exec("UPDATE users SET role='manager' WHERE id=1");
  expect(() => review(id)).toThrow("ADMIN_AUTHORITY_REQUIRED");
  expect(readIdentityAccount(db, id)?.managed?.approval).toBe("pending");
});

it("preserves legacy defaults but invalidates unbound proofs after local identity changes", () => {
  expect(accountAdmission(readIdentityAccount(db, 3), "email")).toEqual({ allowed: true });
  db.exec("INSERT INTO otp_codes(id,email) VALUES(999,'rep@example.test')");
  expect(identityOtpCurrent(db, 999, 3)).toBe(true);
  db.exec("UPDATE users SET email='changed@example.test' WHERE id=3");
  expect(identityOtpCurrent(db, 999, 3)).toBe(false);
});

it("preserves legacy rows across repeat migration, other writers, restart and backup restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hf-identity-")), file = join(dir, "fixture.db"), backup = join(dir, "backup.db");
  const persisted = identityFixture(file); let writer: Database.Database | undefined;
  try {
    const before = persisted.prepare("SELECT * FROM users").all();
    ensureIdentityCoreSchema(persisted); ensureIdentityCoreSchema(persisted);
    expect(persisted.prepare("SELECT * FROM users").all()).toEqual(before);
    const user = persisted.transaction(() => provisionManagedAccount(persisted, { tenantId: 1, name: "Fixture", email: "backup@example.test" }, now)).immediate();
    writer = new Database(file); writer.pragma("foreign_keys=ON");
    writer.transaction(() => transitionDirectoryAccount(writer!, { tenantId: 1, userId: user.userId, expectedGeneration: 1, active: false }, now)).immediate();
    expect(readIdentityAccount(persisted, user.userId)?.managed?.directoryActive).toBe(false);
    await persisted.backup(backup);
    const restored = new Database(backup);
    try {
      restored.pragma("foreign_keys=ON"); ensureIdentityCoreSchema(restored);
      expect(readIdentityAccount(restored, user.userId)).toEqual(readIdentityAccount(persisted, user.userId));
      expect(() => restored.prepare("DELETE FROM users WHERE id=?").run(user.userId)).toThrow();
    } finally { restored.close(); }
  } finally { writer?.close(); persisted.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("fails atomically on incompatible prerequisites and permits retry after repair", () => {
  db.close(); db = identityFixture(":memory:", false);
  db.exec("ALTER TABLE users RENAME COLUMN email TO broken_email");
  expect(() => ensureIdentityCoreSchema(db)).toThrow();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'identity_%'").all()).toEqual([]);
  db.exec("ALTER TABLE users RENAME COLUMN broken_email TO email");
  ensureIdentityCoreSchema(db);
  expect(readIdentityAccount(db, 3)?.managed).toBeNull();
});

it("rolls back a mid-install DDL failure while preserving the preexisting fixture", () => {
  db.close(); db = identityFixture(":memory:", false);
  db.exec("CREATE TABLE identity_devices(id TEXT PRIMARY KEY); INSERT INTO identity_devices VALUES('preserved')");
  expect(() => ensureIdentityCoreSchema(db)).toThrow();
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'identity_%' ORDER BY name").all()).toEqual([{ name: "identity_devices" }]);
  expect(db.prepare("SELECT * FROM identity_devices").all()).toEqual([{ id: "preserved" }]);
  db.exec("ALTER TABLE identity_devices RENAME TO preserved_fixture");
  ensureIdentityCoreSchema(db);
  expect(readIdentityAccount(db, 3)?.managed).toBeNull();
});

it("rolls lifecycle state, epochs and revocation back when the audit write fails", () => {
  const id = provision().userId; review(id);
  db.prepare("INSERT INTO sessions VALUES('retained',?,'2026-09-08T11:00:00.000Z','2026-09-15T11:00:00.000Z')").run(id);
  const before = readIdentityAccount(db, id);
  db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON identity_audit_events BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
  expect(() => directory(id, 1, false)).toThrow("fixture audit failure");
  expect(readIdentityAccount(db, id)).toEqual(before);
  expect(db.prepare("SELECT id FROM sessions WHERE id='retained'").get()).toEqual({ id: "retained" });
});
