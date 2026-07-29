// Handing the rep's own Messages app a pre-written text.
//
// The rep taps once, their native SMS composer opens with the customer's number
// and the whole message already typed, and they hit send. It goes from THEIR
// number — the number of the person who was just at the door — which is both
// what a customer expects and what gets a reply.
//
// This needs no SMS provider, no credentials, and no A2P campaign registration,
// because the app never sends anything. It only opens a composer. The rep is
// always the sender and always sees the text before it goes.
//
// ── THE TRAP ────────────────────────────────────────────────────────────────
// The separator between the number and the body is NOT the same on both
// platforms, and getting it wrong fails in the worst possible way — silently,
// on one platform only, with the composer opening to an EMPTY message that the
// rep may well send anyway:
//
//     iOS      sms:+15551234567&body=...     (ampersand)
//     Android  sms:+15551234567?body=...     (question mark)
//
// This is a genuine RFC-vs-practice divergence: RFC 5724 defines `sms:` with
// `?body=`, and iOS did not follow it. Android also accepts `?body=`; iOS does
// not accept it and drops the body. So the separator has to be chosen from the
// platform, and the "just use ?" instinct is wrong exactly half the time.
//
// ── ENCODING ────────────────────────────────────────────────────────────────
// The body is percent-encoded. encodeURIComponent leaves ! ' ( ) * alone, which
// are legal in a query value, so they are fine — but a raw newline or a literal
// & inside the body would truncate the message at that character on iOS. Both
// are encoded.

export type SmsPlatform = "ios" | "android" | "other";

/**
 * Detect the platform from a user-agent string. Explicit parameter rather than
 * reading navigator directly so it is testable and safe to call during SSR.
 *
 * iPadOS reports itself as a Mac, so the touch check is what distinguishes an
 * iPad from a desktop Safari — and an iPad is a device that can text.
 */
export function detectSmsPlatform(userAgent: string, maxTouchPoints = 0): SmsPlatform {
  const ua = userAgent ?? "";
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipod/i.test(ua)) return "ios";
  if (/ipad/i.test(ua)) return "ios";
  // iPadOS 13+ masquerades as Macintosh; touch points give it away.
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return "ios";
  return "other";
}

/** Digits, and a leading + for E.164. Anything else a human typed — spaces,
 *  parentheses, dashes, dots — is stripped rather than rejected, because the
 *  number came from a form a rep filled in on a doorstep. */
export function normalizePhoneForSms(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;   // shorter than any real subscriber number
  if (digits.length > 15) return null;  // E.164 maximum
  return plus ? `+${digits}` : digits;
}

export interface SmsLinkInput {
  phone: string;
  body: string;
  platform: SmsPlatform;
}

export type SmsLinkResult =
  | { ok: true; href: string }
  | { ok: false; reason: "bad-phone" | "empty-body" };

/**
 * Build the `sms:` href.
 *
 * Returns a Result rather than a string-or-empty, because an href of "" renders
 * a button that looks armed and does nothing — the failure mode this codebase
 * has already been bitten by twice today.
 */
export function buildSmsLink({ phone, body, platform }: SmsLinkInput): SmsLinkResult {
  const number = normalizePhoneForSms(phone);
  if (!number) return { ok: false, reason: "bad-phone" };
  if (!body || !body.trim()) return { ok: false, reason: "empty-body" };

  const separator = platform === "ios" ? "&" : "?";
  return { ok: true, href: `sms:${number}${separator}body=${encodeURIComponent(body)}` };
}

// ── The message itself ──────────────────────────────────────────────────────
// Written to be read on a lock screen by someone who spoke to this rep ten
// minutes ago. It leads with WHO, because an unknown number opening with an
// install date reads like spam; the rep's name and the company are the reason
// the customer keeps reading.

export interface AppointmentMessageVars {
  customerFirstName: string;
  repName: string;
  companyName: string;
  /** Already formatted for humans — "Tue, Aug 4" — not an ISO string. */
  dateLabel: string;
  /** "8:00–10:00 AM" including the window, never a bare start time: an
   *  installer arriving inside a window is not late, and a customer told
   *  "8:00 AM" believes otherwise at 8:05. */
  timeWindowLabel: string;
  /** IANA-derived short label — "CT". Omitted when the rep and customer are
   *  certainly in the same zone; included whenever it might matter. */
  timezoneLabel?: string;
}

export type MessageBuildResult =
  | { ok: true; body: string }
  | { ok: false; missing: string[] };

/**
 * Render the appointment text.
 *
 * Refuses on a missing variable rather than emitting "Hi , your install…" — a
 * half-rendered template sent to a real customer is worse than a button that
 * declines to arm, and the rep will not always proofread before hitting send.
 */
export function buildAppointmentMessage(vars: AppointmentMessageVars): MessageBuildResult {
  const required: (keyof AppointmentMessageVars)[] = [
    "customerFirstName", "repName", "companyName", "dateLabel", "timeWindowLabel",
  ];
  const missing = required.filter((k) => {
    const v = vars[k];
    return typeof v !== "string" || !v.trim();
  });
  if (missing.length) return { ok: false, missing };

  const when = vars.timezoneLabel?.trim()
    ? `${vars.dateLabel} between ${vars.timeWindowLabel} ${vars.timezoneLabel.trim()}`
    : `${vars.dateLabel} between ${vars.timeWindowLabel}`;

  return {
    ok: true,
    body:
      `Hi ${vars.customerFirstName.trim()}, it's ${vars.repName.trim()} from ${vars.companyName.trim()} — ` +
      `thanks for signing up today. Your fiber installation is set for ${when}. ` +
      `Someone should be home and able to show the technician where equipment goes. ` +
      `Reply here if anything changes and I'll get it moved.`,
  };
}
