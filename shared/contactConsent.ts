// ── Contact consent and suppression - the gate before any message ────────────
// PURE and framework-free, so the decision can be unit-tested exhaustively and
// so the client can show a rep exactly why a Send button is disabled without
// re-implementing the rule and getting it wrong.
//
// THE POSTURE. This module is fail-closed and says NO by default. A missing
// consent record is not "probably fine because they bought from us" - it is a
// block with a named reason. The only way a message leaves this system is for
// every gate below to pass, and each one is evaluated independently so the
// answer is always attributable to a specific rule rather than to a boolean
// somebody flipped.
//
// TWO KINDS OF MESSAGE, AND THE DIFFERENCE MATTERS.
//   • A TRANSACTIONAL SERVICE UPDATE is about an order the customer already
//     placed: "your install is Thursday", "we need a document to finish your
//     order". Recovery outreach is overwhelmingly this.
//   • MARKETING is anything that solicits new business.
// They carry different consent requirements, so the purpose is an input to the
// gate, never an assumption. When in doubt the caller passes "marketing", which
// is the stricter path.
//
// WHAT THIS MODULE IS NOT. It is not legal advice and it does not establish
// compliance. Telemarketing and email law is fact- and jurisdiction-specific.
// The same posture docs/CALLING_COMPLIANCE.md records applies here: these are
// engineering controls that reduce risk, and an organization still needs
// counsel sign-off on its consent language, senders, templates and states
// before the messaging flag is turned on for it.

export const CONTACT_CHANNELS = ["sms", "email"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** What the organization has on file for this person on this channel. */
export const CONSENT_STATUSES = ["granted", "revoked", "never_granted", "unknown"] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

/**
 * WHY the organization believes it may contact this person.
 *
 * Recorded rather than inferred, because the basis is what an auditor asks for
 * and it is not reconstructible after the fact. `none` is a real value: it
 * means someone created a record without a basis, and it blocks.
 */
export const CONSENT_BASES = [
  "express_written",              // signed agreement naming the channel and the sender
  "express_oral",                 // captured at the door, with a proof reference
  "transactional_service",        // relates to an order the customer placed with us
  "existing_business_relationship",
  "none",
] as const;
export type ConsentBasis = (typeof CONSENT_BASES)[number];

/** Where the consent record came from. */
export const CONSENT_SOURCES = [
  "door_agreement", "web_form", "order_submission", "inbound_message",
  "phone_call", "admin_entry", "import",
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const SUPPRESSION_REASONS = [
  "opt_out_reply",        // customer texted STOP or clicked unsubscribe
  "complaint",
  "do_not_contact",       // internal, e.g. legal or a rep escalation
  "invalid_destination",  // hard bounce, disconnected number
  "admin_block",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** What a given message is FOR. Drives which consent bases are sufficient. */
export const MESSAGE_PURPOSES = ["transactional_service_update", "marketing"] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];

/**
 * Which bases are sufficient for which purpose.
 *
 * An existing business relationship supports telling a customer about the order
 * they placed. It does not, on its own, support marketing by SMS - that path
 * requires express written consent, which is the strictest thing this table
 * says and the one an organization is most likely to want to soften. It is
 * deliberately not configurable.
 */
const SUFFICIENT_BASES: Readonly<Record<MessagePurpose, Readonly<Record<ContactChannel, readonly ConsentBasis[]>>>> = {
  transactional_service_update: {
    sms: ["express_written", "express_oral", "transactional_service", "existing_business_relationship"],
    email: ["express_written", "express_oral", "transactional_service", "existing_business_relationship"],
  },
  marketing: {
    sms: ["express_written"],
    email: ["express_written", "express_oral", "existing_business_relationship"],
  },
};

// ── Destination normalization ────────────────────────────────────────────────

/**
 * A North American phone number in E.164, or null.
 *
 * Suppression is matched on THIS form, never on the raw text: a customer who
 * replied STOP from (704) 555-0142 must stay blocked when a later import writes
 * their number as 7045550142. Deliberately North-America-only, matching the
 * calling plane's pilot boundary - a number this cannot normalize is refused
 * rather than guessed at, because guessing produces a message to a stranger.
 */
export function normalizePhoneE164(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  // NANP validity: area code and exchange both start 2-9, and N11 area codes
  // (211, 911, ...) are service codes, not subscribers.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  if (/^\d11/.test(ten)) return null;
  // A number of all-identical digits is test data that reached production.
  if (/^(\d)\1{9}$/.test(ten)) return null;
  return `+1${ten}`;
}

/** Lowercased, trimmed address, or null. The form suppression matches on. */
export function normalizeEmail(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  return isPlausibleEmail(text) ? text : null;
}

/**
 * Structural plausibility, not deliverability.
 *
 * Kept deliberately strict-but-simple: one @, no spaces, a dot in the domain,
 * no leading/trailing dots. It exists to catch a mis-mapped column (a name or
 * an address landing in the email field), which is the failure this pipeline
 * actually sees. Deliverability is the provider's answer, recorded as a bounce.
 */
export function isPlausibleEmail(raw: unknown): boolean {
  if (raw == null) return false;
  const text = String(raw).trim();
  if (!text || text.length > 254 || /\s/.test(text)) return false;
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) return false;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!domain || domain.length > 253 || domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return false;
  if (!domain.includes(".")) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) && /^[A-Za-z0-9.-]+$/.test(domain);
}

// ── Masking ──────────────────────────────────────────────────────────────────
//
// Every customer destination that crosses the wire to a browser, lands in a
// log, or is written to the outreach record goes through these. The outreach
// table stores ONLY the masked form: an audit trail needs to prove which
// number was messaged, not to be a second copy of the customer database.

export function maskPhone(raw: unknown): string | null {
  const e164 = normalizePhoneE164(raw);
  if (!e164) {
    const digits = String(raw ?? "").replace(/[^\d]/g, "");
    return digits.length >= 4 ? `***-***-${digits.slice(-4)}` : null;
  }
  return `***-***-${e164.slice(-4)}`;
}

export function maskEmail(raw: unknown): string | null {
  const email = String(raw ?? "").trim().toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${host.slice(0, 1)}${"*".repeat(Math.max(1, host.length - 1))}${tld}`;
}

/** A customer name, reduced for a supervisory list view. Full names are fine on
 *  a case a rep is authorized to work; a roll-up does not need them. */
export function maskName(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const parts = text.split(/\s+/);
  const first = parts[0];
  const lastInitial = parts.length > 1 ? `${parts[parts.length - 1].slice(0, 1)}.` : "";
  return lastInitial ? `${first} ${lastInitial}` : first;
}

// ── Inbound opt-out detection ────────────────────────────────────────────────

/**
 * The keywords that must stop messaging immediately.
 *
 * Matched on the whole trimmed message with punctuation stripped, so "STOP."
 * and "stop!" both count, and matched as a STANDALONE word so a customer
 * writing "please stop by on Thursday" is not silently suppressed - that would
 * lose a recoverable order and read to the customer as being ignored.
 *
 * A carrier handles STOP at the network level for a compliant short code, and
 * this repo still handles it: an organization may run this through a provider
 * where it does not, and honouring it twice is free while honouring it zero
 * times is the failure that ends a sending reputation.
 */
const OPT_OUT_KEYWORDS = [
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt out", "remove",
] as const;

const OPT_IN_KEYWORDS = ["start", "unstop", "yes", "optin", "opt in"] as const;

/** The opt-out keyword an inbound message carries, or null. */
export function detectOptOut(body: unknown): string | null {
  const text = String(body ?? "").trim().toLowerCase().replace(/[.!?,;:]+$/g, "");
  if (!text) return null;
  // Whole-message match only. A keyword buried in a sentence is a conversation,
  // not a command, and treating it as one loses recoverable orders.
  const hit = OPT_OUT_KEYWORDS.find((k) => text === k);
  return hit ?? null;
}

/** A customer explicitly re-subscribing. Never grants consent on its own - it
 *  lifts a reply-driven suppression, and the consent record still has to say
 *  yes. */
export function detectOptIn(body: unknown): string | null {
  const text = String(body ?? "").trim().toLowerCase().replace(/[.!?,;:]+$/g, "");
  if (!text) return null;
  const hit = OPT_IN_KEYWORDS.find((k) => text === k);
  return hit ?? null;
}

// ── The gate ─────────────────────────────────────────────────────────────────

/** Every reason a send can be refused. Named, so a UI can explain itself and a
 *  test can assert the exact cause rather than "it was blocked". */
export const CONTACT_BLOCK_REASONS = [
  "FEATURE_DISABLED",
  "ORG_NOT_APPROVED",
  "IDENTITY_UNRESOLVED",
  "NO_DESTINATION",
  "INVALID_DESTINATION",
  "SUPPRESSED",
  "CONSENT_REVOKED",
  "CONSENT_MISSING",
  "CONSENT_BASIS_INSUFFICIENT",
  "DO_NOT_CONTACT",
  "TEMPLATE_NOT_APPROVED",
  "QUIET_HOURS",
  "RATE_LIMIT_DAILY",
  "RATE_LIMIT_CASE",
  "RATE_LIMIT_COOLDOWN",
  "SENDER_NOT_CONFIGURED",
  "MISSING_OPT_OUT_LANGUAGE",
  "MISSING_POSTAL_ADDRESS",
  "MISSING_UNSUBSCRIBE",
] as const;
export type ContactBlockReason = (typeof CONTACT_BLOCK_REASONS)[number];

export interface ContactGateInput {
  channel: ContactChannel;
  purpose: MessagePurpose;

  /** PERFECTVISION_ORDER_RECOVERY_MESSAGING_ENABLED, or the manual-send
   *  equivalent. False blocks every automated path. */
  featureEnabled: boolean;
  /** An org admin has approved messaging for this organization AND a consent
   *  policy is configured. Both are separate switches from the feature flag. */
  organizationApproved: boolean;

  /** True only when the order matched an internal sale at high confidence.
   *  A message about an order we cannot prove is ours goes to a stranger. */
  identityResolved: boolean;

  /** The destination, already normalized. Null when the report had none. */
  destination: string | null;

  suppressed: boolean;
  /** Internal do-not-contact on the linked lead or customer. */
  doNotContact: boolean;

  consentStatus: ConsentStatus;
  consentBasis: ConsentBasis | null;

  templateApproved: boolean;
  senderConfigured: boolean;

  /** SMS bodies must carry opt-out language; email must carry an unsubscribe
   *  mechanism and the organization's postal address. Computed from the
   *  rendered body by the caller, so the gate checks the ACTUAL message. */
  bodyHasOptOutLanguage: boolean;
  bodyHasUnsubscribe: boolean;
  bodyHasPostalAddress: boolean;

  /** Local hour at the customer's location, 0-23, or null when unknown. Null
   *  is NOT a pass: it blocks, same as the calling plane refuses to dial into
   *  an unresolved timezone. */
  recipientLocalHour: number | null;
  quietHours: { startHour: number; endHour: number };

  /** Counters the caller reads from the outreach table. */
  sentToDestinationToday: number;
  sentForCaseTotal: number;
  hoursSinceLastOutreachToCase: number | null;
  caps: MessagingCaps;
}

export interface MessagingCaps {
  maxPerDestinationPerDay: number;
  maxPerCaseTotal: number;
  minHoursBetweenOutreach: number;
}

export const DEFAULT_MESSAGING_CAPS: MessagingCaps = {
  maxPerDestinationPerDay: 1,
  maxPerCaseTotal: 4,
  minHoursBetweenOutreach: 24,
};

/** Quiet hours in the RECIPIENT's local time. Messaging is allowed from the
 *  start hour up to, but not including, the end hour. */
export const DEFAULT_QUIET_HOURS = { startHour: 9, endHour: 20 };

export interface ContactGateResult {
  allowed: boolean;
  /** Every failing rule, in evaluation order. All of them, not just the first:
   *  an admin fixing consent should not then discover the template was never
   *  approved either. */
  blockedBy: ContactBlockReason[];
  /** Safe to show a rep. Never contains the destination. */
  summary: string;
}

/**
 * The single decision. Everything that sends calls this and nothing sends
 * without it.
 *
 * Note what is NOT a parameter: the rep's opinion, an override flag, a "force"
 * boolean. There is no argument to this function that lets a suppression be
 * bypassed, which is the point - a rep cannot override an opt-out because the
 * code has nowhere to put the override.
 */
export function evaluateContactGate(input: ContactGateInput): ContactGateResult {
  const blocked: ContactBlockReason[] = [];

  if (!input.featureEnabled) blocked.push("FEATURE_DISABLED");
  if (!input.organizationApproved) blocked.push("ORG_NOT_APPROVED");
  if (!input.identityResolved) blocked.push("IDENTITY_UNRESOLVED");

  if (!input.destination) blocked.push("NO_DESTINATION");
  else if (input.channel === "sms" && !normalizePhoneE164(input.destination)) blocked.push("INVALID_DESTINATION");
  else if (input.channel === "email" && !isPlausibleEmail(input.destination)) blocked.push("INVALID_DESTINATION");

  // Suppression and do-not-contact outrank every affirmative signal below.
  if (input.suppressed) blocked.push("SUPPRESSED");
  if (input.doNotContact) blocked.push("DO_NOT_CONTACT");

  if (input.consentStatus === "revoked") blocked.push("CONSENT_REVOKED");
  else if (input.consentStatus !== "granted") blocked.push("CONSENT_MISSING");
  else {
    const sufficient = SUFFICIENT_BASES[input.purpose][input.channel];
    if (!input.consentBasis || !sufficient.includes(input.consentBasis)) blocked.push("CONSENT_BASIS_INSUFFICIENT");
  }

  if (!input.templateApproved) blocked.push("TEMPLATE_NOT_APPROVED");
  if (!input.senderConfigured) blocked.push("SENDER_NOT_CONFIGURED");

  if (input.channel === "sms" && !input.bodyHasOptOutLanguage) blocked.push("MISSING_OPT_OUT_LANGUAGE");
  if (input.channel === "email" && !input.bodyHasUnsubscribe) blocked.push("MISSING_UNSUBSCRIBE");
  if (input.channel === "email" && !input.bodyHasPostalAddress) blocked.push("MISSING_POSTAL_ADDRESS");

  if (!isWithinQuietHours(input.recipientLocalHour, input.quietHours)) blocked.push("QUIET_HOURS");

  if (input.sentToDestinationToday >= input.caps.maxPerDestinationPerDay) blocked.push("RATE_LIMIT_DAILY");
  if (input.sentForCaseTotal >= input.caps.maxPerCaseTotal) blocked.push("RATE_LIMIT_CASE");
  if (
    input.hoursSinceLastOutreachToCase != null &&
    input.hoursSinceLastOutreachToCase < input.caps.minHoursBetweenOutreach
  ) blocked.push("RATE_LIMIT_COOLDOWN");

  return {
    allowed: blocked.length === 0,
    blockedBy: blocked,
    summary: blocked.length === 0
      ? "Allowed"
      : blocked.map((r) => BLOCK_REASON_LABELS[r]).join("; "),
  };
}

/** Null hour blocks. An unknown local time is the same risk as a known bad one,
 *  and the calling plane already settled this argument the same way. */
function isWithinQuietHours(hour: number | null, window: { startHour: number; endHour: number }): boolean {
  if (hour == null || !Number.isInteger(hour) || hour < 0 || hour > 23) return false;
  const { startHour, endHour } = window;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // A window that wraps midnight, which no sane policy sets but which a config
  // screen can produce.
  return hour >= startHour || hour < endHour;
}

export const BLOCK_REASON_LABELS: Readonly<Record<ContactBlockReason, string>> = {
  FEATURE_DISABLED: "Recovery messaging is turned off",
  ORG_NOT_APPROVED: "Messaging is not approved for this organization",
  IDENTITY_UNRESOLVED: "The order is not matched to a customer yet",
  NO_DESTINATION: "No contact details on file",
  INVALID_DESTINATION: "The contact details are not valid",
  SUPPRESSED: "This contact is on the suppression list",
  CONSENT_REVOKED: "The customer opted out",
  CONSENT_MISSING: "No consent record on file",
  CONSENT_BASIS_INSUFFICIENT: "The consent on file does not cover this message",
  DO_NOT_CONTACT: "Marked do not contact",
  TEMPLATE_NOT_APPROVED: "The template is not approved",
  QUIET_HOURS: "Outside allowed contact hours",
  RATE_LIMIT_DAILY: "Daily message limit reached for this contact",
  RATE_LIMIT_CASE: "Message limit reached for this case",
  RATE_LIMIT_COOLDOWN: "Too soon since the last message",
  SENDER_NOT_CONFIGURED: "No approved sender is configured",
  MISSING_OPT_OUT_LANGUAGE: "The text is missing opt-out wording",
  MISSING_POSTAL_ADDRESS: "The email is missing the company mailing address",
  MISSING_UNSUBSCRIBE: "The email is missing an unsubscribe link",
};

// ── Recipient local time ─────────────────────────────────────────────────────
//
// Quiet hours are meaningless without knowing what time it is where the
// customer lives, and the gate blocks on an unknown hour rather than guessing.
// So this has to answer honestly, including when the answer is "I do not know".
//
// A state is the only location signal a provider order reliably carries. States
// that sit wholly in one zone give a confident answer; the ones split across
// two do not, and they return null - which blocks - rather than picking the
// zone that covers more of the population. Same posture as the calling plane's
// NC/SC boundary: a timezone we cannot resolve is a refusal, not a default.

const SINGLE_ZONE_STATES: Readonly<Record<string, string>> = {
  AL: "America/Chicago", AR: "America/Chicago", AZ: "America/Phoenix",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York",
  DC: "America/New_York", DE: "America/New_York", GA: "America/New_York",
  HI: "Pacific/Honolulu", IA: "America/Chicago", IL: "America/Chicago",
  LA: "America/Chicago", MA: "America/New_York", MD: "America/New_York",
  ME: "America/New_York", MN: "America/Chicago", MO: "America/Chicago",
  MS: "America/Chicago", MT: "America/Denver", NC: "America/New_York",
  NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NV: "America/Los_Angeles", NY: "America/New_York", OH: "America/New_York",
  OK: "America/Chicago", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", UT: "America/Denver", VA: "America/New_York",
  VT: "America/New_York", WA: "America/Los_Angeles", WI: "America/Chicago",
  WV: "America/New_York", WY: "America/Denver",
};
// Deliberately absent: AK, FL, ID, IN, KS, KY, MI, ND, NE, OR, SD, TN, TX.
// Each is split across two zones, so a state code alone cannot place a
// customer's evening.

export function timeZoneForState(state: string | null | undefined): string | null {
  const code = String(state ?? "").trim().toUpperCase();
  if (code.length !== 2) return null;
  return SINGLE_ZONE_STATES[code] ?? null;
}

/** The recipient's local hour, 0-23, or null when it cannot be resolved. Null
 *  blocks - see evaluateContactGate. */
export function recipientLocalHour(state: string | null | undefined, at: Date): number | null {
  const zone = timeZoneForState(state);
  if (!zone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", hour12: false }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? NaN);
    return Number.isInteger(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

/** The two-letter state in a free-text address line, or null. Reads the LAST
 *  state-shaped token before an optional ZIP, so "N MAIN ST, CONCORD NC 28025"
 *  resolves to NC and a street called "OK Avenue" does not. */
export function stateFromAddressLine(address: string | null | undefined): string | null {
  const text = String(address ?? "").toUpperCase();
  const m = /\b([A-Z]{2})\b[\s,]*\d{5}(?:-\d{4})?\s*$/.exec(text) ?? /\b([A-Z]{2})\s*$/.exec(text);
  const code = m?.[1] ?? null;
  return code && (code in SINGLE_ZONE_STATES || /^[A-Z]{2}$/.test(code)) ? code : null;
}

/** The opt-out sentence every SMS must carry, and the string the gate looks for.
 *  One constant so the template default and the check can never disagree. */
export const SMS_OPT_OUT_SENTENCE = "Reply STOP to opt out.";

export function bodyCarriesOptOut(body: string): boolean {
  return /\breply\s+stop\b/i.test(body) || /\btext\s+stop\b/i.test(body);
}
