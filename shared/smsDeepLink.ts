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

// The message body itself lives in ./smsMessage — it has its own concern
// (GSM-7 encoding and segment cost) that has nothing to do with URL building.
export {
  buildAppointmentMessage,
  countSegments,
  toGsm7Safe,
  type AppointmentMessageVars,
  type MessageBuildResult,
  type SegmentInfo,
  type SmsEncoding,
} from "./smsMessage";
