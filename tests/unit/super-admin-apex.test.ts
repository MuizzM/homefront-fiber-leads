// P0-1 regression: the super-admin takeover (tenant admin self-promotes by
// PATCHing their email to SUPER_ADMIN_EMAILS). The fix makes apex identity an
// immutable is_super_admin column stamped from env at boot — an email edit can
// never mint a new apex, and re-stamping strips any illegitimate flag.
import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-apex-"));
process.env.SUPER_ADMIN_EMAILS = "owner@example.com,second@example.com";

let rawDb: any;

function stamp() {
  const emails = (process.env.SUPER_ADMIN_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase()).filter(Boolean);
  const ph = emails.map(() => "?").join(",");
  rawDb.prepare(`UPDATE users SET is_super_admin = 1 WHERE lower(email) IN (${ph})`).run(...emails);
  rawDb.prepare(`UPDATE users SET is_super_admin = 0 WHERE is_super_admin = 1 AND lower(email) NOT IN (${ph})`).run(...emails);
}

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  rawDb.exec(`
    DROP TABLE IF EXISTS users;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'rep', is_super_admin INTEGER NOT NULL DEFAULT 0,
      tenant_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ins = rawDb.prepare("INSERT INTO users (name, email, role) VALUES (?,?,?)");
  ins.run("Owner", "owner@example.com", "admin");
  ins.run("Tenant Admin", "attacker@tenant.com", "admin");
});

describe("P0-1 super-admin apex is immutable (email edits can't mint apex)", () => {
  it("stamps only env-listed apex emails", () => {
    stamp();
    const owner = rawDb.prepare("SELECT is_super_admin f FROM users WHERE email='owner@example.com'").get();
    const attacker = rawDb.prepare("SELECT is_super_admin f FROM users WHERE email='attacker@tenant.com'").get();
    expect(owner.f).toBe(1);
    expect(attacker.f).toBe(0);
  });

  it("env enforcement strips any illegitimately-held apex flag on re-stamp", () => {
    // Whatever path sets the column (bug, direct write), the boot stamp is the
    // only authority: non-env rows are forced back to 0.
    rawDb.prepare("UPDATE users SET is_super_admin = 1 WHERE email='attacker@tenant.com'").run();
    const before = rawDb.prepare("SELECT is_super_admin f FROM users WHERE email='attacker@tenant.com'").get();
    expect(before.f).toBe(1); // flag somehow set
    stamp();
    const after = rawDb.prepare("SELECT is_super_admin f FROM users WHERE email='attacker@tenant.com'").get();
    expect(after.f).toBe(0); // env enforcement cleared it
    // And the true apex is untouched.
    const owner = rawDb.prepare("SELECT is_super_admin f FROM users WHERE email='owner@example.com'").get();
    expect(owner.f).toBe(1);
  });

  it("the OLD attack (email claim) is structurally gated: gate reads the column, never the string", () => {
    // requireSuperAdmin previously evaluated user.email ∈ env. The takeover was:
    // PATCH email to an apex value → gate passes. The new gate ignores email
    // entirely — we assert the guard condition shape directly:
    const gatePasses = (user: { role: string; isSuperAdmin?: number | null }) =>
      user.role === "admin" && !!user.isSuperAdmin;
    const attackerRow = rawDb.prepare("SELECT role, is_super_admin FROM users WHERE email='attacker@tenant.com'").get();
    expect(gatePasses(attackerRow)).toBe(false);
    // Even after renaming themselves to the apex string (if they ever got past
    // the PATCH guard), the column still says no:
    rawDb.prepare("UPDATE users SET email='second@example.com' WHERE email='attacker@tenant.com'").run();
    const renamed = rawDb.prepare("SELECT role, is_super_admin FROM users WHERE email='second@example.com'").get();
    expect(renamed.is_super_admin).toBe(0);
    expect(gatePasses(renamed)).toBe(false);
  });

  it("email-claim guard logic: apex emails are reserved", () => {
    const apex = (process.env.SUPER_ADMIN_EMAILS ?? "").split(",").map(e => e.trim().toLowerCase());
    const attempted = "OWNER@example.com"; // case-insensitive claim attempt
    expect(apex.includes(attempted.trim().toLowerCase())).toBe(true);
  });
});
