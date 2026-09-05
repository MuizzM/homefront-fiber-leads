import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const { mailConfiguration, accountStatus, mailFailureCategory } = createRequire(import.meta.url)("../../script/auth-diagnostics.cjs") as {
  mailConfiguration(env: Record<string, string>): Record<string, unknown>;
  accountStatus(db: Database.Database, email: string, now?: number): Record<string, unknown>;
  mailFailureCategory(line: string): string | null;
};

describe("read-only authentication diagnostics", () => {
  it("reports credential presence and sender domains without exposing values", () => {
    const result = mailConfiguration({
      NODE_ENV: "production", RESEND_API_KEY: "re_PRIVATE", SMTP_PASS: "PRIVATE_PASSWORD",
      SMTP_HOST: "smtp.resend.com", SMTP_USER: "private-user", SMTP_PORT: "465",
      RESEND_FROM: "Private Name <private@sender.example>", MAIL_FROM: "other@portal.example",
    });
    expect(result).toEqual({ production: true, resendKeyPresent: true, smtpHostIsResend: true,
      smtpUserPresent: true, smtpPasswordPresent: true, smtpPort: 465,
      resendFromDomain: "sender.example", mailFromDomain: "portal.example" });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-user|Private Name|private@|other@/);
  });

  it("reduces raw mail failures to fixed categories, ignoring unrelated sensitive logs", () => {
    expect(mailFailureCategory("[otp] Resend API send failed (Resend delivery failed (429): daily quota exceeded) user@private.test 123456 re_PRIVATE")).toBe("provider_quota");
    expect(mailFailureCategory("[otp] Resend API send failed (403): domain is not verified")).toBe("sender_domain");
    expect(mailFailureCategory("[mail] SMTP port 465 unreachable (ETIMEDOUT)")).toBe("provider_connection");
    expect(mailFailureCategory("[otp] Resend API send failed (Resend delivery failed (422): private content)")).toBe("resend_http_422");
    expect(mailFailureCategory("[otp] mail delivery failed: email_send_failed")).toBe("delivery_failed");
    expect(mailFailureCategory("customer 123456 user@private.test re_PRIVATE")).toBeNull();
    expect(mailFailureCategory('{"event":"auth.otp_unavailable","code":"SQLITE_BUSY","error":"PRIVATE"}')).toBe("otp_database_busy");
    expect(mailFailureCategory('{"event":"otp_rate_buckets.degraded","error":"PRIVATE"}')).toBe("otp_rate_store_degraded");
  });

  it("isolates one account, emits only safe audit metadata and preserves database state", () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE users (email TEXT PRIMARY KEY, active INTEGER); CREATE TABLE login_attempts (id INTEGER PRIMARY KEY, email TEXT, kind TEXT, success INTEGER, reason TEXT, created_at TEXT); CREATE TABLE otp_rate_buckets (bucket TEXT, key TEXT, count INTEGER, locked_until INTEGER, PRIMARY KEY(bucket, key));");
      db.prepare("INSERT INTO users VALUES (?, ?)").run("wanted@test.example", 1);
      const insert = db.prepare("INSERT INTO login_attempts VALUES (?, ?, ?, ?, ?, ?)");
      insert.run(1, "wanted@test.example", "request", 1, "code_created_mail_failed", "2026-09-05 15:00:00");
      insert.run(2, "other@test.example", "request", 1, "code_sent", "2026-09-05 15:01:00");
      insert.run(3, "wanted@test.example", "PRIVATE", 0, "PRIVATE 123456", "PRIVATE");
      db.prepare("INSERT INTO otp_rate_buckets VALUES (?, ?, ?, ?)").run("request", "email:wanted@test.example", 6, 120000);
      db.pragma("query_only = ON");
      const result = accountStatus(db, "wanted@test.example", 60000);
      expect(result).toMatchObject({ accountExists: true, active: true, storedRequestCount: 6, requestLockSeconds: 60,
        recentAttempts: [
          { kind: "unknown", success: false, reason: "unknown", createdAt: null },
          { kind: "request", success: true, reason: "code_created_mail_failed", createdAt: "2026-09-05 15:00:00" },
        ] });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|123456|test\.example|code_sent/);
      expect(accountStatus(db, "absent@test.example", 60000)).toMatchObject({ accountExists: false, active: null, recentAttempts: [], storedRequestCount: 0, requestLockSeconds: 0 });
      expect(db.prepare("SELECT count(*) AS n FROM login_attempts").get()).toEqual({ n: 3 });
    } finally { db.close(); }
  });
});
