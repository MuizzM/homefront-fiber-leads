// ── Mail transport — single source for every outbound email ───────────────────
// OTP codes, the welcome email, territory-request and application alerts, and
// cron alerts all go through here so provider config lives in ONE place.
//
// Works with any SMTP provider. For RESEND (the production default):
//   SMTP_HOST=smtp.resend.com  SMTP_PORT=587  SMTP_USER=resend  SMTP_PASS=<Resend API key>
//   SMTP_PORT is only the FIRST port tried — sendMailResilient fails over
//   between 587 (STARTTLS) and 465 (implicit TLS) on connection-class errors,
//   because either port can be blocked by a host or dropped by the provider.
//   MAIL_FROM="HomeFront Fiber <noreply@homefrontsolutionsllc.com>"   (a Resend-verified sender)
// For Gmail/other, SMTP_USER is the address, so MAIL_FROM is optional.
//
// NOT a duplicate of server/resendMail.ts, and the two must not be merged. That
// module is the Resend HTTP API rail (per-message Idempotency-Key, content_id
// attachments, dev log-delivery), used only by the onboarding-signature flow.
// This one is the SMTP rail, and its 587<->465 failover exists because of the
// 2026-07-16 Resend port outage. Idempotency lives only on HTTP and failover
// only on SMTP: folding either into the other changes delivery behaviour —
// double-send risk on SMTP retries, or loss of failover on HTTP.

import nodemailer from "nodemailer";
import path from "path";
import fs from "fs";

// The brand logo, embedded per-email via CID so it renders even before the app
// is publicly hosted (no external image fetch). Resolved from the built assets
// (dist/public) or the source (client/public).
export const LOGO_CID = "hfs-logo";
export function logoAttachment(): { filename: string; path: string; cid: string } | null {
  // The circular badge icon (navy house mark) — a compact logo for the email
  // header. cwd is the repo root in dev (tsx) and /app in prod (node
  // dist/index.cjs), so these candidates cover both without __dirname (ESM-unsafe).
  const candidates = [
    path.resolve(process.cwd(), "dist", "public", "icon-192.png"),     // prod build
    path.resolve(process.cwd(), "client", "public", "icon-192.png"),   // dev source
  ];
  const found = candidates.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  return found ? { filename: "home-front-solutions-icon.png", path: found, cid: LOGO_CID } : null;
}


function transportFor(port: number): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 10_000,
  });
}


// Connection-class failures only — auth/recipient errors must NOT retry on the
// other port (same creds, same verdict; a blind resend could double-deliver).
const CONNECTION_FAILURE =
  /greeting|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ESOCKET|EHOSTUNREACH|ENETUNREACH|connection.*(closed|timeout)|timed?\s*out/i;

/** Send with automatic SMTP-port failover (587↔465).
 *
 * 2026-07-16 outage: Resend's port-587 STARTTLS endpoint stopped answering
 * (no greeting, from Hetzner AND residential vantage points) while 465
 * implicit-TLS kept working — prod OTP login went down because the transport
 * was pinned to one port. Every send now tries the configured port first and,
 * on a connection-class failure, retries once on the alternate port. */
export async function sendMailResilient(options: nodemailer.SendMailOptions): Promise<void> {
  const primary = Number(process.env.SMTP_PORT ?? 587);
  const fallback = primary === 465 ? 587 : 465;
  try {
    await transportFor(primary).sendMail(options);
  } catch (error: any) {
    const message = String(error?.message ?? error);
    if (!CONNECTION_FAILURE.test(message)) throw error;
    console.warn(`[mail] SMTP port ${primary} unreachable (${message.slice(0, 120)}) - failing over to ${fallback}`);
    await transportFor(fallback).sendMail(options);
  }
}

// The visible sender. With Resend, SMTP_USER is literally "resend", so the from
// MUST be a real verified address — set MAIL_FROM. Falls back to the SMTP_USER
// style for providers (Gmail) where the username IS the address.
export function mailFrom(): string {
  return process.env.MAIL_FROM || `"HomeFront Fiber" <${process.env.SMTP_USER}>`;
}

// Where admin-notification emails go (territory requests, new applications).
// NEVER SMTP_USER when that's "resend" — prefer MAIL_ADMIN, then the first
// configured super-admin address.
export function adminInbox(): string | undefined {
  return (
    process.env.MAIL_ADMIN ||
    process.env.SUPER_ADMIN_EMAILS?.split(",")[0]?.trim() ||
    undefined
  );
}

// Escape untrusted text (names, form fields) before it goes into email HTML.
export function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
// Brand palette (from the logo): deep navy text, teal accent, light surfaces.
const NAVY = "#12314c", SLATE = "#4a5a68", TEAL = "#3EA394", MUTED = "#8a97a4";

// Professional, light-themed, table-based, fully inline-styled email shell -
// renders consistently across Gmail, Apple Mail, and Outlook. The logo is
// embedded via CID (attach logoAttachment() at the send site). `bodyHtml` is
// trusted, pre-inlined HTML; escape any user data with escapeHtml() first.
export function emailShell(opts: { preheader?: string; heading: string; bodyHtml: string }): string {
  const year = new Date().getFullYear();
  const pre = escapeHtml(opts.preheader ?? "");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Home Front Solutions</title>
</head>
<body style="margin:0;padding:0;background:#eef1f4;">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${pre}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e3e8ee;border-radius:16px;overflow:hidden;">
<tr><td align="center" style="padding:34px 32px 10px;">
  <img src="cid:${LOGO_CID}" width="84" height="84" alt="Home Front Solutions" style="display:block;width:84px;height:84px;border-radius:50%;margin:0 auto;border:0;background:#0F2A44;">
</td></tr>
<tr><td align="center" style="padding:6px 32px 0;">
  <div style="font:700 16px/1.2 ${FONT};color:${NAVY};letter-spacing:.01em;">Home Front Solutions</div>
  <div style="height:3px;width:44px;border-radius:3px;background:${TEAL};margin:12px auto 0;"></div>
</td></tr>
<tr><td style="padding:22px 36px 6px;text-align:center;">
  <h1 style="margin:0 0 14px;font:600 21px/1.3 ${FONT};color:${NAVY};">${opts.heading}</h1>
  ${opts.bodyHtml}
</td></tr>
<tr><td style="padding:26px 36px 30px;">
  <div style="height:1px;background:#eaeef2;margin-bottom:16px;"></div>
  <p style="margin:0;font:400 11px/1.6 ${FONT};color:${MUTED};text-align:center;">Automated message from the Home Front Solutions field-sales portal.<br>If you didn’t request this, you can safely ignore it.</p>
  <p style="margin:12px 0 0;font:600 11px/1.5 ${FONT};color:${TEAL};text-align:center;letter-spacing:.10em;text-transform:uppercase;">Direct to your door</p>
  <p style="margin:5px 0 0;font:400 11px/1.5 ${FONT};color:#aab4bf;text-align:center;">© ${year} Home Front Solutions LLC</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Shared body pieces so every email's copy is styled identically.
export function emailParagraph(text: string): string {
  return `<p style="margin:0 0 18px;font:400 15px/1.6 ${FONT};color:${SLATE};">${text}</p>`;
}
export function emailCodeBox(code: string): string {
  return `<div style="margin:6px auto 4px;max-width:300px;padding:20px;background:#f0f8f6;border:1px solid #cfe7e0;border-radius:12px;text-align:center;font:700 36px/1 ${FONT};color:${NAVY};letter-spacing:12px;">${escapeHtml(code)}</div>`;
}
export function emailNote(html: string): string {
  return `<p style="margin:20px 0 0;font:400 12px/1.6 ${FONT};color:${MUTED};">${html}</p>`;
}
