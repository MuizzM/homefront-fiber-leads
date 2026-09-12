import type Database from "better-sqlite3";
import { interactiveTransaction } from "./interactiveDb";
import { otpEncryptionReady } from "./otpSecrets";
import { resendConfigured, resendSender, ResendDeliveryError, sendResendEmail } from "./resendMail";
import { claimOtpDelivery, eligibleOtpMail, otpDeliveryDue, retireExpiredOtpDeliveries, OTP_DELIVERY_ATTEMPTS, settleOtpDelivery, type FrozenOtpMail } from "./otpDeliveryStore";
import { structuredLog } from "./structuredLog";

export function assertReliableOtpReady(): void {
  if (!otpEncryptionReady() || (process.env.NODE_ENV === "production" && !resendConfigured())) {
    throw new Error("Reliable sign-in delivery is not configured");
  }
}
export function otpSender(): string {
  return resendSender() || (process.env.NODE_ENV !== "production" ? "Home Front <no-reply@example.invalid>" : "");
}
type Sender = (mail: FrozenOtpMail, idempotencyKey: string, signal?: AbortSignal) => Promise<{ id: string }>;
const sendOtp: Sender = async (mail, idempotencyKey, signal) => {
  // Tests/development cannot send real mail even if the host has credentials.
  if (process.env.NODE_ENV !== "production") return { id: `local-${idempotencyKey}` };
  return sendResendEmail({ ...mail, idempotencyKey, signal,
    attachments: mail.attachments?.map(a => ({ ...a, content: Buffer.from(a.content, "base64") })) });
};

/** Claims commit before I/O; acknowledgements require the same lease token.
 * Always drain already-issued jobs, even when new issuance is switched off.
 * Retry the frozen message/key only within the ten-minute OTP lifetime (well
 * inside Resend's documented 24h idempotency window). No SMTP fallback. */
export async function drainOtpDeliveries(db: Database.Database,
  options: { send?: Sender; now?: () => number; limit?: number; signal?: AbortSignal } = {}): Promise<number> {
  const now = options.now ?? Date.now;
  if (!otpDeliveryDue(db, now())) return 0;
  await interactiveTransaction(db, () => retireExpiredOtpDeliveries(db, now()));
  let processed = 0;
  for (let i = 0; i < Math.min(8, Math.max(1, options.limit ?? 8)) && !options.signal?.aborted; i++) {
    const job = await interactiveTransaction(db, () => claimOtpDelivery(db, now()));
    if (!job) break;
    let result: Parameters<typeof settleOtpDelivery>[2];
    try {
      const mail = eligibleOtpMail(db, job, now());
      if (!mail) {
        result = { status: job.expires_at <= now() ? "expired" : "superseded" };
      } else {
        const receipt = await (options.send ?? sendOtp)(mail, `otp-v1/${job.id}`, options.signal);
        if (!receipt?.id) throw new Error("Missing provider acknowledgement");
        result = { status: "accepted", providerId: receipt.id };
      }
    } catch (error) {
      const retryable = !(error instanceof ResendDeliveryError) || error.retryable;
      result = { status: job.expires_at <= now() ? "expired" : !retryable || job.attempts >= OTP_DELIVERY_ATTEMPTS ? "failed" : "pending",
        errorCode: error instanceof ResendDeliveryError ? `provider_http_${error.status}` : "delivery_unconfirmed" };
    }
    const settled = await interactiveTransaction(db, () => settleOtpDelivery(db, job, result, now()));
    if (settled) {
      processed++;
      structuredLog("auth.delivery_result", { operationId: job.id, tenantId: job.tenant_id,
        status: result.status, attempt: job.attempts, providerReplay: job.attempts > 1 });
    }
  }
  return processed;
}
