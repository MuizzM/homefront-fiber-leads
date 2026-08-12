// ── Messaging providers - the seam, deliberately empty ───────────────────────
//
// This repo has an email transport (server/mail.ts, nodemailer) and NO SMS
// transport. Rather than picking one and hard-coding it, the send path talks to
// these interfaces and resolves an implementation at call time.
//
// WHY THE SMS DEFAULT REFUSES RATHER THAN NO-OPS.
// A stub that returns success and drops the message is the worst possible
// default: the outreach record says "sent", the case shows contact made, the
// rate limiter counts it, the rep stops chasing, and the customer never heard
// from anybody. The default here fails loudly with a message an admin can act
// on, so an unconfigured organization discovers that on the first attempt
// instead of a fortnight later.
//
// WHAT AN IMPLEMENTATION OWES. Two things beyond sending: a stable provider
// message id (the outreach row's link to delivery receipts) and a SAFE error
// string. Provider errors routinely echo the destination number back in the
// message, so the adapter is responsible for not handing that to a caller that
// will store and display it.

import { mailFrom, sendMailResilient } from "./mail";

export interface SendResult {
  ok: boolean;
  /** The provider's own id, when it gives one. Used to reconcile delivery
   *  receipts and to make a retry idempotent. */
  providerMessageId: string | null;
  /** Safe to store and to show. Never the destination, never a raw provider
   *  body, never a credential. */
  safeError: string | null;
}

export interface MessagingProvider {
  readonly name: string;
  /** False when the organization has not configured this channel. The gate
   *  reads it as SENDER_NOT_CONFIGURED rather than attempting a send. */
  isConfigured(): boolean;
}

export interface SmsProvider extends MessagingProvider {
  sendSms(input: {
    to: string;              // E.164
    body: string;
    senderIdentity: string;  // the approved from-number or short code
    /** Idempotency key, so a retried send is not a second text. */
    clientReference: string;
  }): Promise<SendResult>;
}

export interface EmailProvider extends MessagingProvider {
  sendEmail(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    from: string;
    replyTo: string | null;
    /** RFC 8058 one-click unsubscribe. Real headers, not decoration: a
     *  bulk-ish message without them lands in spam and stays there. */
    listUnsubscribeUrl: string | null;
    clientReference: string;
  }): Promise<SendResult>;
}

// ── The default SMS provider: none ───────────────────────────────────────────

class UnconfiguredSmsProvider implements SmsProvider {
  readonly name = "none";
  isConfigured(): boolean { return false; }
  async sendSms(): Promise<SendResult> {
    return {
      ok: false,
      providerMessageId: null,
      safeError: "No SMS provider is configured for this system. Recovery texts cannot be sent until one is set up and approved.",
    };
  }
}

// ── The default email provider: the transport this repo already has ──────────

class NodemailerEmailProvider implements EmailProvider {
  readonly name = "nodemailer";

  isConfigured(): boolean {
    // mail.ts falls back to a log transport when SMTP is unset, which is right
    // for a one-time password in development and wrong for customer outreach.
    // Customer messaging requires real SMTP, explicitly.
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
  }

  async sendEmail(input: {
    to: string; subject: string; text: string; html: string;
    from: string; replyTo: string | null; listUnsubscribeUrl: string | null; clientReference: string;
  }): Promise<SendResult> {
    try {
      const headers: Record<string, string> = {};
      if (input.listUnsubscribeUrl) {
        headers["List-Unsubscribe"] = `<${input.listUnsubscribeUrl}>`;
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
      await sendMailResilient({
        from: input.from || mailFrom(),
        to: input.to,
        replyTo: input.replyTo ?? undefined,
        subject: input.subject,
        text: input.text,
        html: input.html,
        headers,
      });
      // Nodemailer's own message id is not reliably surfaced through the
      // resilient sender, so the client reference is the id we reconcile on.
      return { ok: true, providerMessageId: input.clientReference, safeError: null };
    } catch (e: any) {
      // Deliberately not e.message: SMTP rejections quote the recipient address
      // back, and this string gets stored on the outreach row and shown.
      console.warn("[recovery-email] send failed:", e?.message);
      return { ok: false, providerMessageId: null, safeError: "The email could not be delivered to the mail server." };
    }
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────

let smsProvider: SmsProvider = new UnconfiguredSmsProvider();
let emailProvider: EmailProvider = new NodemailerEmailProvider();

export function getSmsProvider(): SmsProvider { return smsProvider; }
export function getEmailProvider(): EmailProvider { return emailProvider; }

/** Swap an implementation in. The only way a vendor gets wired, and the hook a
 *  test uses to assert that nothing was sent. */
export function setSmsProvider(provider: SmsProvider): void { smsProvider = provider; }
export function setEmailProvider(provider: EmailProvider): void { emailProvider = provider; }

/** Restore the shipped defaults. Used by tests between cases so one test's
 *  stub cannot leak into the next. */
export function resetMessagingProviders(): void {
  smsProvider = new UnconfiguredSmsProvider();
  emailProvider = new NodemailerEmailProvider();
}
