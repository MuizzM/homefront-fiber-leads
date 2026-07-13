interface ResendAttachment {
  filename: string;
  content: Buffer;
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

export function resendConfigured(): boolean {
  return Boolean(apiKey() && (process.env.RESEND_FROM || process.env.MAIL_FROM));
}

function sender(): string {
  return process.env.RESEND_FROM?.trim() || process.env.MAIL_FROM?.trim() || "";
}

export async function sendResendEmail(message: ResendMessage): Promise<{ id: string }> {
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
