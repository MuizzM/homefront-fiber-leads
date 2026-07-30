// ── Ready-to-Call: the single pinned vocabulary ──────────────────────────────
// One place defines the call outcomes, how each one moves the lead, and how a
// lead's name/phone are derived — so the queue, the card, the disposition chips,
// the server write, and the tests can never drift into three vocabularies.
//
// This is deliberately SEPARATE from the field knock outcomes (shared/knock.ts):
// a phone disposition must not silently trigger a field/commission side effect.
// "Sold" here records a phone sale on the lead's status; it does NOT mint a
// commission sale (that is the at-the-door knock path).

import { normalizeUsPhone } from "./calling";

export type CallOutcome =
  | "answered" | "no_answer" | "voicemail" | "callback"
  | "interested" | "appointment" | "sold"
  | "already_has_service" | "wrong_number" | "do_not_call";

export interface CallOutcomeMeta {
  code: CallOutcome;
  label: string;
  /** Chip tone bucket — the client maps this to concrete colors in both themes. */
  tone: "neutral" | "positive" | "warn" | "danger" | "info";
  /** lead_status this outcome advances the lead to (null = leave status as-is). */
  leadStatus: string | null;
  /** Terminal outcomes leave the calling queue (handled/closed). */
  terminal: boolean;
  /** Requires a callback date+time before it can be saved. */
  requiresCallback?: true;
  /** Flips the lead's do_not_call flag. */
  setsDoNotCall?: true;
  /** Marks the number unusable (wrong number) so it drops from the queue. */
  invalidatesPhone?: true;
}

// Order here is the display order of the disposition chips.
export const CALL_OUTCOMES: readonly CallOutcomeMeta[] = [
  { code: "answered",           label: "Answered",          tone: "neutral",  leadStatus: "contacted",       terminal: false },
  { code: "no_answer",          label: "No Answer",         tone: "neutral",  leadStatus: "attempted",       terminal: false },
  { code: "voicemail",          label: "Voicemail",         tone: "neutral",  leadStatus: "attempted",       terminal: false },
  { code: "callback",           label: "Callback",          tone: "info",     leadStatus: "callback",        terminal: false, requiresCallback: true },
  { code: "interested",         label: "Interested",        tone: "positive", leadStatus: "interested",      terminal: false },
  { code: "appointment",        label: "Appointment",       tone: "positive", leadStatus: "appointment",     terminal: false },
  { code: "sold",               label: "Sold",              tone: "positive", leadStatus: "sold",            terminal: true },
  { code: "already_has_service",label: "Already Has Service",tone: "warn",    leadStatus: "already_customer",terminal: true },
  { code: "wrong_number",       label: "Wrong Number",      tone: "danger",   leadStatus: "wrong_number",    terminal: true, invalidatesPhone: true },
  { code: "do_not_call",        label: "Do Not Call",       tone: "danger",   leadStatus: "do_not_call",     terminal: true, setsDoNotCall: true },
] as const;

const BY_CODE = new Map(CALL_OUTCOMES.map(o => [o.code, o]));
export function callOutcomeMeta(code: string): CallOutcomeMeta | null {
  return BY_CODE.get(code as CallOutcome) ?? null;
}
export function isCallOutcome(code: unknown): code is CallOutcome {
  return typeof code === "string" && BY_CODE.has(code as CallOutcome);
}

// ── Lead → callable identity ─────────────────────────────────────────────────
// Never invent a name. A lead with no owner/contact name is shown as "Resident";
// the address is the real identity and always anchors the card.
export interface CallableLeadFields {
  ownerName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  ownerPhone?: string | null;
}

const RESIDENT = "Resident";

export function displayName(lead: CallableLeadFields): string {
  const owner = (lead.ownerName ?? "").trim();
  if (owner) return owner;
  const contact = (lead.contactName ?? "").trim();
  if (contact) return contact;
  return RESIDENT;
}
export function isResident(lead: CallableLeadFields): boolean {
  return !((lead.ownerName ?? "").trim() || (lead.contactName ?? "").trim());
}

/** The number to dial: first non-empty of contact_phone then owner_phone,
 *  normalized to E.164. Returns null when there is no usable US number. */
export function dialPhone(lead: CallableLeadFields): string | null {
  for (const raw of [lead.contactPhone, lead.ownerPhone]) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    const normalized = normalizeUsPhone(v);
    if (normalized) return normalized;
  }
  return null;
}

/** Pretty US display of an E.164 number: +15551234567 → (555) 123-4567. */
export function formatDialDisplay(e164: string): string {
  const n = normalizeUsPhone(e164);
  if (!n) return e164;
  const d = n.slice(-10);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}
