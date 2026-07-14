import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";

const DB_PATH = process.env.E2E_DB_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data.db");
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "muizzm21@gmail.com";

/**
 * Mint a real session without email. Insert a known plaintext OTP straight into
 * otp_codes (codes are stored plaintext — see storage.verifyOtp), then verify it
 * over HTTP to get a sessionId. Returns { sessionId, user }.
 */
export async function mintSession(
  request: APIRequestContext,
  email = ADMIN_EMAIL
): Promise<{ sessionId: string; user: any }> {
  const code = "424242";
  const db = new Database(DB_PATH);
  try {
    // Keep every E2E spec runnable against a genuinely fresh migrated database.
    // Production never auto-provisions users; this fixture writes directly to
    // the isolated test DB before exercising the real OTP verification route.
    db.prepare(
      `INSERT INTO users (name, email, role, active, tenant_id, created_at)
       VALUES (?, ?, 'admin', 1, 1, ?)
       ON CONFLICT(email) DO UPDATE SET role='admin', active=1, tenant_id=1`
    ).run("E2E Admin", email.toLowerCase(), new Date().toISOString());
    db.prepare(
      `INSERT INTO otp_codes (email, code, expires_at, used, created_at)
       VALUES (?, ?, ?, 0, ?)`
    ).run(
      email.toLowerCase(),
      code,
      new Date(Date.now() + 10 * 60_000).toISOString(),
      new Date().toISOString()
    );
  } finally {
    db.close();
  }

  const res = await request.post("/api/auth/otp/verify", { data: { email, code } });
  if (!res.ok()) throw new Error(`OTP verify failed: ${res.status()} ${await res.text()}`);
  return res.json();
}

/**
 * The app reads its session from window.name (not localStorage), so we set it
 * via an init script that runs before every navigation.
 */
export async function loginAs(page: Page, sessionId: string) {
  await page.addInitScript((sid) => {
    // eslint-disable-next-line no-restricted-globals
    window.name = JSON.stringify({ sid });
  }, sessionId);
}
