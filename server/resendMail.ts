// ── The Resend HTTP API rail ────────────────────────────────────────────────
//
// NOT a duplicate of server/mail.ts, and the two must not be merged. That
// module is the nodemailer/SMTP rail with 587<->465 port failover (built after
// the 2026-07-16 Resend port outage) and carries the branded HTML shell for
// OTP and alert mail. This one is the Resend HTTP API, used only by the
// onboarding-signature flow, and the per-message Idempotency-Key below plus the
// content_id attachment mapping exist ONLY on this path. Merging the transports
// changes delivery behaviour: double-send risk on SMTP retries, or loss of
// failover on HTTP. The shared knowledge is the credential convention only —
// apiKey() falls back to SMTP_PASS when SMTP_HOST=smtp.resend.com, the same
// convention mail.ts documents in its header.

interface ResendAttachment {
  filename: string;
  content: Buffer;
  /** Set to render inline via <img src="cid:..."> instead of as a download. */
  contentId?: string;
}

interface ResendMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  attachments?: ResendAttachment[];
  tags?: Array<{ name: string; value: string }>;
}

function apiKey(): string {
  const direct = process.env.RESEND_API_KEY?.trim();
  if (direct) return direct;
  const smtpHost = process.env.SMTP_HOST?.trim().toLowerCase();
  if (smtpHost === "smtp.resend.com") return process.env.SMTP_PASS?.trim() || "";
  return "";
}

function localDeliveryMode(): boolean {
  return process.env.RESEND_DELIVERY_MODE === "log" && process.env.NODE_ENV !== "production";
}

export function resendConfigured(): boolean {
  return localDeliveryMode() || Boolean(apiKey() && (process.env.RESEND_FROM || process.env.MAIL_FROM));
}

function sender(): string {
  return process.env.RESEND_FROM?.trim() || process.env.MAIL_FROM?.trim() || "";
}

export async function sendResendEmail(message: ResendMessage): Promise<{ id: string }> {
  if (localDeliveryMode()) {
    const id = `local-${message.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120)}`;
    console.info(JSON.stringify({ event: "email.delivery.logged", provider: "local", id, to: message.to.toLowerCase(), subject: message.subject }));
    return { id };
  }
  const key = apiKey();
  const from = sender();
  if (!key || !from) throw new Error("Resend email is not configured");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey.slice(0, 256),
      "User-Agent": "HomeFront-Fiber/1.0 onboarding-signatures",
    },
    body: JSON.stringify({
      from,
      to: [message.to.toLowerCase()],
      subject: message.subject,
      html: message.html,
      text: message.text,
      attachments: message.attachments?.map(attachment => ({
        filename: attachment.filename,
        content: attachment.content.toString("base64"),
        ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
      })),
      tags: message.tags,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  const payload = await response.json().catch(() => ({})) as { id?: string; message?: string; error?: string };
  if (!response.ok || !payload.id) {
    const reason = payload.message || payload.error || response.statusText;
    throw new Error(`Resend delivery failed (${response.status}): ${String(reason).slice(0, 240)}`);
  }
  return { id: payload.id };
}
