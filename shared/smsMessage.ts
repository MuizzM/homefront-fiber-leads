// What the customer actually reads on their lock screen.
//
// This is the rep texting from their own phone, ten minutes after standing on
// the doorstep. It should sound like that rep — not like a billing system. So:
// contractions, short sentences, a plain hyphen instead of a dash, no "please
// be advised". The rep can edit it before sending; most won't, so it has to be
// right as written.
//
// ── THE ENCODING BUG THIS FILE EXISTS TO PREVENT ────────────────────────────
// SMS has two encodings, and ONE character decides which you get:
//
//     GSM-7   160 chars in one segment, 153 each when concatenated
//     UCS-2    70 chars in one segment,  67 each when concatenated
//
// A single character outside the GSM-7 alphabet forces the WHOLE message to
// UCS-2, less than half the capacity. The characters that do this are exactly
// the ones a writer reaches for without thinking:
//
//     –  en dash        —  em dash       '  '  curly quotes
//     "  "  smart quotes    …  ellipsis     any emoji
//
// "8:00–10:00 AM" with an en dash is the trap: it looks identical to
// "8:00-10:00 AM" at a glance, and it silently triples the segment count of
// every appointment text the company sends. Segments are cheap on the rep's own
// plan, but a 5-segment text reassembles badly on older handsets and some
// carriers split it visibly. We transliterate instead of hoping.
//
// Emoji are the one case we do NOT silently strip — a rep may want one, and
// mangling it would be worse. We report the cost instead and let the UI say so.

/** GSM 03.38 basic alphabet. Anything outside it forces UCS-2. */
const GSM7_BASIC = new Set(
  ("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
   "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà").split(""),
);

/** Chars that are legal but cost TWO septets each (escape + char). */
const GSM7_EXTENDED = new Set(["^", "{", "}", "\\", "[", "~", "]", "|", "€"]);

/**
 * Typographic characters → their GSM-7 equivalents.
 *
 * Every entry here is a character that would silently halve the message
 * capacity while looking correct in the source and in code review.
 */
const TRANSLITERATE: Record<string, string> = {
  "–": "-",   // en dash  – the "8:00–10:00" trap
  "—": "-",   // em dash  —
  "‒": "-",   // figure dash
  "−": "-",   // minus sign
  "‘": "'",   // left single curly quote
  "’": "'",   // right single curly quote / apostrophe
  "‚": "'",
  "“": '"',   // left double curly quote
  "”": '"',   // right double curly quote
  "„": '"',
  "…": "...", // ellipsis
  " ": " ",   // non-breaking space — invisible, and not GSM-7
  " ": " ",   // narrow no-break space
  " ": " ",   // thin space
  "•": "*",   // bullet
  "′": "'",
  "­": "",    // soft hyphen — invisible, pure cost
};

/**
 * Replace typographic characters with GSM-7-safe equivalents.
 *
 * Deliberately NOT a strip: an unknown non-GSM char (a customer named Zoë, an
 * emoji the rep wants) is left alone. Mangling a person's name to save a
 * segment is the wrong trade. countSegments reports the real cost.
 */
export function toGsm7Safe(text: string): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text) out += ch in TRANSLITERATE ? TRANSLITERATE[ch] : ch;
  return out;
}

export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SegmentInfo {
  encoding: SmsEncoding;
  segments: number;
  /** Billable units: septets for GSM-7 (extended chars count 2), UTF-16 code
   *  units for UCS-2 (an emoji outside the BMP counts 2 — a surrogate pair). */
  units: number;
  /** Characters that forced UCS-2, deduped, for showing the rep what to remove. */
  offenders: string[];
}

export function countSegments(text: string): SegmentInfo {
  const body = typeof text === "string" ? text : "";
  const offenders: string[] = [];

  let septets = 0;
  let gsmSafe = true;
  for (const ch of body) {
    if (GSM7_BASIC.has(ch)) septets += 1;
    else if (GSM7_EXTENDED.has(ch)) septets += 2;
    else {
      gsmSafe = false;
      if (!offenders.includes(ch)) offenders.push(ch);
    }
  }

  if (gsmSafe) {
    const segments = septets <= 160 ? Math.max(1, Math.ceil(septets / 160)) : Math.ceil(septets / 153);
    return { encoding: "GSM-7", segments, units: septets, offenders: [] };
  }

  // UCS-2 counts UTF-16 code units, so an astral emoji costs 2.
  const units = [...body].reduce((n, ch) => n + (ch.codePointAt(0)! > 0xffff ? 2 : 1), 0);
  const segments = units <= 70 ? Math.max(1, Math.ceil(units / 70)) : Math.ceil(units / 67);
  return { encoding: "UCS-2", segments, units, offenders };
}

// ── The message ─────────────────────────────────────────────────────────────

export interface AppointmentMessageVars {
  customerFirstName: string;
  repName: string;
  companyName: string;
  /** Human-formatted — "Tue, Aug 4". Never an ISO string. */
  dateLabel: string;
  /** The WINDOW — "8:00-10:00 AM". An installer inside a window is not late. */
  timeWindowLabel: string;
  timezoneLabel?: string;
  /**
   * The referral reward, exactly as the customer should read it — "$100 gift
   * card". Omit it and the referral ask is left out entirely: a tenant not
   * running the offer must never send a text promising one.
   */
  referralRewardLabel?: string;
}

export type MessageBuildResult =
  | { ok: true; body: string; segments: SegmentInfo }
  | { ok: false; missing: string[] };

/**
 * Build the text.
 *
 * Refuses on a missing variable rather than emitting "Hey , you're all set" — a
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

  const t = (s?: string) => toGsm7Safe((s ?? "").trim());
  const when = t(vars.timezoneLabel)
    ? `${t(vars.dateLabel)} between ${t(vars.timeWindowLabel)} ${t(vars.timezoneLabel)}`
    : `${t(vars.dateLabel)} between ${t(vars.timeWindowLabel)}`;

  // Casual, in the rep's voice, in the order the customer cares about:
  // who is this -> when is my install -> what do I need to do -> the offer.
  const parts = [
    `Hey ${t(vars.customerFirstName)}, it's ${t(vars.repName)} from ${t(vars.companyName)} - great meeting you today!`,
    `You're all set: your fiber install is ${when}.`,
    `Just need someone home to show the tech where the equipment goes.`,
  ];

  const reward = t(vars.referralRewardLabel);
  if (reward) {
    // The condition ("once they're installed") is stated, not buried. An offer
    // the customer misreads as instant is a complaint aimed at the rep who
    // sent it, and this text is the only thing they'll have in writing.
    parts.push(
      `And if you know anyone who wants fiber, send them my way - ` +
      `you get a ${reward} once they're installed.`,
    );
  }

  parts.push(`Any questions, just reply here.`);

  const body = parts.join(" ");
  return { ok: true, body, segments: countSegments(body) };
}
