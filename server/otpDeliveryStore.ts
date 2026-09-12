import type Database from "better-sqlite3";
import { randomInt, randomUUID } from "node:crypto";
import { protectOtpSecret, revealOtpSecret } from "./otpSecrets";

export const OTP_DELIVERY_ATTEMPTS = 5;
export const OTP_DELIVERY_LEASE_MS = 60_000;
export interface FrozenOtpMail { from: string; to: string; subject: string; text: string; html: string; attachments?: Array<{ filename: string; content: string; contentId?: string }> }
interface OtpOwner { id: number; email: string; name: string; tenantId?: number | null }
export interface OtpDeliveryRow {
  id: string; tenant_id: number | null; user_id: number; otp_id: number;
  payload: string | null; status: string; attempts: number; expires_at: number;
  next_attempt_at: number; lease_token: string | null; lease_until: number | null;
}
interface FrozenDelivery { purpose: "delivery"; id: string; userId: number; tenantId: number | null; otpId: number; mail: FrozenOtpMail }

export function ensureOtpDeliverySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_delivery_outbox (
    id TEXT PRIMARY KEY, tenant_id INTEGER, user_id INTEGER NOT NULL, otp_id INTEGER NOT NULL UNIQUE,
    payload TEXT, status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','processing','accepted','failed','expired','superseded','discarded')),
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER,
    provider_id TEXT, error_code TEXT, completed_at INTEGER,
    CHECK(tenant_id IS NULL OR tenant_id>0), CHECK(attempts>=0))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_delivery_due ON auth_delivery_outbox(next_attempt_at,id)
    WHERE status='pending'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_delivery_lease ON auth_delivery_outbox(lease_until,id)
    WHERE status='processing'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_delivery_user ON auth_delivery_outbox(user_id,status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_delivery_tenant_status ON auth_delivery_outbox(tenant_id,status,created_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_auth_delivery_retention ON auth_delivery_outbox(completed_at)
    WHERE completed_at IS NOT NULL`);
}

/** Must share the caller's request/account/rate-limit transaction. A failed
 * enqueue never burns the previous code or returns a misleading acceptance. */
export function issueDurableOtp(db: Database.Database, user: OtpOwner,
  buildMail: (code: string) => FrozenOtpMail, now = Date.now()): { code: string; operationId: string } {
  if (!db.inTransaction) throw new Error("OTP issuance requires a transaction");
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("OTP owner required");
  const email = user.email.trim().toLowerCase();
  const id = randomUUID();
  const code = String(randomInt(100000, 1000000));
  const expires = now + 600_000;
  const protectedCode = protectOtpSecret({ purpose: "verify", email, code, operationId: id });
  db.prepare(`UPDATE otp_codes SET used=1 WHERE email=? AND used=0`).run(email);
  db.prepare(`UPDATE auth_delivery_outbox SET status='superseded',payload=NULL,completed_at=?,lease_token=NULL,lease_until=NULL
    WHERE user_id=? AND status IN ('pending','processing')`).run(now, user.id);
  const otpId = Number(db.prepare(`INSERT INTO otp_codes(email,code,used,expires_at,created_at)
    VALUES (?,?,0,?,?)`).run(email, protectedCode, new Date(expires).toISOString(), new Date(now).toISOString()).lastInsertRowid);
  const mail = buildMail(code);
  if (mail.to.trim().toLowerCase() !== email || !mail.from) throw new Error("OTP delivery identity mismatch");
  const payload = protectOtpSecret({ purpose: "delivery", id, userId: user.id, tenantId: user.tenantId ?? null, otpId, mail } satisfies FrozenDelivery);
  db.prepare(`INSERT INTO auth_delivery_outbox(id,tenant_id,user_id,otp_id,payload,created_at,expires_at,next_attempt_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(id, user.tenantId ?? null, user.id, otpId, payload, now, expires, now);
  return { code, operationId: id };
}

export function claimOtpDelivery(db: Database.Database, now = Date.now()): OtpDeliveryRow | null {
  if (!db.inTransaction) throw new Error("OTP claim requires a transaction");
  const candidate = db.prepare(`SELECT * FROM auth_delivery_outbox WHERE id=(
    SELECT id FROM (
      SELECT id,next_attempt_at AS due FROM auth_delivery_outbox WHERE status='pending' AND next_attempt_at<=@now AND expires_at>@now AND attempts<5
      UNION ALL SELECT id,lease_until AS due FROM auth_delivery_outbox WHERE status='processing' AND lease_until<=@now AND expires_at>@now AND attempts<5
    ) ORDER BY due,id LIMIT 1)`).get({ now }) as OtpDeliveryRow | undefined;
  if (!candidate) return null;
  const token = randomUUID();
  return db.prepare(`UPDATE auth_delivery_outbox SET status='processing',lease_token=?,lease_until=?,attempts=attempts+1
    WHERE id=? RETURNING *`).get(token, now + OTP_DELIVERY_LEASE_MS, candidate.id) as OtpDeliveryRow;
}

export function eligibleOtpMail(db: Database.Database, job: OtpDeliveryRow, now = Date.now()): FrozenOtpMail | null {
  if (!job.payload || job.expires_at <= now || job.attempts > OTP_DELIVERY_ATTEMPTS) return null;
  const envelope = revealOtpSecret<FrozenDelivery>(job.payload);
  if (envelope.purpose !== "delivery" || envelope.id !== job.id || envelope.userId !== job.user_id
      || envelope.tenantId !== job.tenant_id || envelope.otpId !== job.otp_id) throw new Error("OTP delivery identity mismatch");
  const eligible = db.prepare(`SELECT 1 FROM auth_delivery_outbox d
    JOIN otp_codes o ON o.id=d.otp_id JOIN users u ON u.id=d.user_id
    WHERE d.id=? AND d.status='processing' AND d.lease_token=? AND d.lease_until>?
      AND o.used=0 AND o.expires_at>? AND o.email=? AND lower(u.email)=o.email
      AND u.active=1 AND u.tenant_id IS d.tenant_id`).get(job.id, job.lease_token, now,
        new Date(now).toISOString(), envelope.mail.to.trim().toLowerCase());
  return eligible ? envelope.mail : null;
}

export function settleOtpDelivery(db: Database.Database, job: OtpDeliveryRow,
  result: { status: "accepted" | "failed" | "expired" | "superseded" | "pending"; providerId?: string; errorCode?: string }, now = Date.now()): boolean {
  const terminal = result.status !== "pending";
  const retryDelay = Math.min(120_000, 5_000 * 2 ** Math.min(job.attempts - 1, 5));
  return db.prepare(`UPDATE auth_delivery_outbox SET status=?,provider_id=COALESCE(?,provider_id),error_code=?,
    next_attempt_at=?,completed_at=?,payload=CASE WHEN ? THEN NULL ELSE payload END,lease_token=NULL,lease_until=NULL
    WHERE id=? AND status='processing' AND lease_token=? AND lease_until>?`)
    .run(result.status, result.providerId ?? null, result.errorCode ?? null, now + retryDelay, terminal ? now : null,
      terminal ? 1 : 0, job.id, job.lease_token, now).changes === 1;
}

/** Bound retention; never delete unfinished work or valid authentication data. */
export function purgeOtpDeliveryReceipts(db: Database.Database, now = Date.now()): number {
  if (!db.prepare("SELECT 1 FROM auth_delivery_outbox WHERE completed_at IS NOT NULL AND completed_at<? LIMIT 1").get(now - 30 * 86400_000)) return 0;
  return db.prepare(`DELETE FROM auth_delivery_outbox WHERE id IN (
    SELECT id FROM auth_delivery_outbox WHERE completed_at IS NOT NULL AND completed_at<? ORDER BY completed_at LIMIT 500
  )`).run(now - 30 * 86400_000).changes;
}

/** Read-only idle probe: a quiet worker must not acquire SQLite's writer. */
export function otpDeliveryDue(db: Database.Database, now = Date.now()): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM auth_delivery_outbox WHERE status='pending' AND next_attempt_at<=?
    UNION ALL SELECT 1 FROM auth_delivery_outbox WHERE status='processing' AND lease_until<=? LIMIT 1`).get(now, now));
}
export function retireExpiredOtpDeliveries(db: Database.Database, now = Date.now()): number {
  return db.prepare(`UPDATE auth_delivery_outbox SET status=CASE WHEN expires_at<=@now THEN 'expired' ELSE 'failed' END,
    payload=NULL,completed_at=@now,lease_token=NULL,lease_until=NULL,error_code='delivery_deadline_or_attempt_limit'
    WHERE id IN (SELECT id FROM auth_delivery_outbox
      WHERE (status='pending' OR (status='processing' AND lease_until<=@now)) AND (expires_at<=@now OR attempts>=5)
      LIMIT 500)`).run({ now }).changes;
}
