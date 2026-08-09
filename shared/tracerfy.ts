// ── Tracerfy skip-trace + DNC scrub: the pure decision layer ────────────────
//
// Everything here is a PURE function over data a provider already returned. No
// I/O, no clock reads except the `nowMs` you pass in. The HTTP adapter lives in
// server/tracerfyProvider.ts; the autonomous run lives in server/skipTraceRun.ts.
//
// ── THIS IS A PROJECTION, NOT A GATE ───────────────────────────────────────
//
// The `dnc` boolean this module produces is for DISPLAY and for the lead-card
// JSON contract. It is NOT what decides whether a call may be placed.
//
// This codebase already has a real compliance engine in shared/calling.ts — a
// gate stack covering internal/tenant/national/state DNC, dataset freshness,
// verified consent, consent overrides, and reassignment risk, returning typed
// block reasons (BLOCKED_NATIONAL_DNC, BLOCKED_STALE_DNC_DATA, …). That engine
// stays the sole authority for placing calls.
//
// A second, simpler boolean deciding dialability would be a compliance
// REGRESSION dressed up as a feature: two answers to "may I call this number"
// means the looser one eventually wins an argument. So `dnc` here is derived
// downward from provider flags, and the routing helper below refuses to emit
// `call_allowed` on its own — it requires the caller to pass the calling
// engine's verdict in. Ownership stays in one place.
//
// ── WHY A STALE SCRUB IS TREATED AS "DNC" ──────────────────────────────────
//
// The brief did not mention scrub age. It has to: the federal Do-Not-Call
// safe harbour requires scrubbing against a registry version no older than 31
// days, and a number added to the registry yesterday is legally protected
// today regardless of what a 60-day-old scrub said. "We checked once in
// March" is not a defence.
//
// So an expired scrub resolves to dnc=true, not dnc=false. It fails CLOSED.
// The card says why — "scrub expired" reads differently from "on the registry"
// and the rep should be able to tell them apart.

/** Raw DNC flags as returned per-phone by a scrub. All optional: a provider
 *  that omits a field tells us nothing, which is not the same as "clear". */
export interface DncFlags {
  /** National Do-Not-Call Registry (FTC/FCC). */
  federalDnc?: boolean;
  /** State registry. Several states maintain their own, with stricter rules. */
  stateDnc?: boolean;
  /** DMAchoice suppression. See DMA_BLOCKS_CALLING below — surfaced, not blocking. */
  dma?: boolean;
  /** Known TCPA serial litigator. */
  tcpaLitigator?: boolean;
}

export type LineType = "wireless" | "landline" | "voip" | "unknown";

export interface TracedPhone {
  /** E.164 where we could normalize it; otherwise the provider's string. */
  number: string;
  lineType: LineType;
  /** 0–1. Provider's confidence that this phone belongs to this address. */
  confidence: number;
  dncFlags: DncFlags;
  /** When this phone was last scrubbed, epoch ms. Null = never scrubbed. */
  scrubbedAtMs: number | null;
}

export interface TracedEmail {
  email: string;
  confidence: number;
}

/** Why a number cannot be dialled. Ordered by how it should be explained to a
 *  rep, most legally serious first. */
export type DncReason =
  | "federal_dnc"
  | "state_dnc"
  | "tcpa_litigator"
  | "never_scrubbed"
  | "scrub_expired";

export interface PhoneVerdict {
  number: string;
  lineType: LineType;
  confidence: number;
  /** True when this number must not be dialled or texted. */
  dnc: boolean;
  dncFlags: Required<DncFlags>;
  /** Empty when dnc is false. */
  reasons: DncReason[];
}

// ── Policy constants ────────────────────────────────────────────────────────

/** Federal safe harbour: a scrub older than this cannot be relied on. 31 days
 *  is the statutory ceiling, so the operational limit sits under it — a job
 *  that runs "monthly" drifts, and drifting past 31 days is the failure. */
export const SCRUB_TTL_DAYS = 25;

/** DMAchoice is a MAIL preference service, not a telephone registry. Blocking
 *  calls on it is not required by the TCPA or the FTC rule, and doing so would
 *  suppress a large slice of legitimately callable leads. So it is surfaced on
 *  the card and recorded, but does not by itself set dnc.
 *
 *  One constant rather than a scattered condition: an org whose counsel wants
 *  DMA treated as blocking flips this and every surface follows. */
export const DMA_BLOCKS_CALLING = false;

/** How many phones/emails the card shows before "show all". The rest are
 *  retained and returned by the API — this is a display cap, not a data cap. */
export const DISPLAY_LIMIT = 3;

const DAY_MS = 86_400_000;

function normalizeFlags(f: DncFlags | undefined): Required<DncFlags> {
  return {
    federalDnc: f?.federalDnc === true,
    stateDnc: f?.stateDnc === true,
    dma: f?.dma === true,
    tcpaLitigator: f?.tcpaLitigator === true,
  };
}

/**
 * Decide one phone's dialability from its flags and scrub age.
 *
 * Fails CLOSED in both directions that matter: an unscrubbed number is not
 * "clear", and an expired scrub is not "still clear". Both are far more common
 * than an actual registry hit — a provider timeout or a job that stopped
 * running produces thousands of them silently.
 */
export function verdictForPhone(phone: TracedPhone, nowMs: number): PhoneVerdict {
  const flags = normalizeFlags(phone.dncFlags);
  const reasons: DncReason[] = [];

  if (flags.federalDnc) reasons.push("federal_dnc");
  if (flags.stateDnc) reasons.push("state_dnc");
  if (flags.tcpaLitigator) reasons.push("tcpa_litigator");
  if (DMA_BLOCKS_CALLING && flags.dma) reasons.push("federal_dnc");

  if (phone.scrubbedAtMs == null) {
    reasons.push("never_scrubbed");
  } else if (nowMs - phone.scrubbedAtMs > SCRUB_TTL_DAYS * DAY_MS) {
    reasons.push("scrub_expired");
  }

  return {
    number: phone.number,
    lineType: phone.lineType,
    confidence: phone.confidence,
    dnc: reasons.length > 0,
    dncFlags: flags,
    reasons,
  };
}

/** Rep-facing sentence for a blocked number. The distinction matters: "on the
 *  registry" is permanent and about the person; "not scrubbed yet" is our
 *  problem and will clear on its own. A rep who cannot tell them apart learns
 *  to treat every badge as noise. */
export function dncExplanation(reasons: DncReason[]): string {
  if (reasons.length === 0) return "OK to call";
  if (reasons.includes("tcpa_litigator")) return "Known TCPA litigator - do not dial";
  if (reasons.includes("federal_dnc")) return "On the federal Do Not Call registry";
  if (reasons.includes("state_dnc")) return "On the state Do Not Call registry";
  if (reasons.includes("scrub_expired")) return "DNC check expired - re-scrubbing";
  return "Not DNC-checked yet";
}

/** Highest confidence first, ties broken by number so the order is stable
 *  across runs — a card whose phones reshuffle on every refresh reads as
 *  broken even when the data is identical. */
export function rankPhones(phones: TracedPhone[]): TracedPhone[] {
  return [...phones].sort((a, b) =>
    (b.confidence - a.confidence) || a.number.localeCompare(b.number));
}

export function rankEmails(emails: TracedEmail[]): TracedEmail[] {
  return [...emails].sort((a, b) =>
    (b.confidence - a.confidence) || a.email.localeCompare(b.email));
}

export type LeadAction = "door_knock" | "call_allowed" | "door_knock_only";

/**
 * Recommended actions for a lead.
 *
 * `door_knock` is unconditional. The Do-Not-Call rules govern telephone
 * solicitation; they do not govern walking up to a door. A DNC hit removes the
 * phone, never the door — which is the whole reason the number stays visible on
 * the card rather than being deleted.
 *
 * `call_allowed` requires BOTH a clear number here AND `callingEngineAllows`,
 * the verdict from shared/calling.ts. This function cannot authorise a call by
 * itself, on purpose: see the header. Callers that have not consulted the
 * calling engine pass false and get door_knock_only, which is the safe answer.
 */
export function actionsForLead(
  verdicts: PhoneVerdict[],
  callingEngineAllows: boolean,
): LeadAction[] {
  const anyCallable = verdicts.some(v => !v.dnc);
  return anyCallable && callingEngineAllows
    ? ["door_knock", "call_allowed"]
    : ["door_knock_only"];
}

/** Numbers that may enter a dialer, call queue, or phone task.
 *
 *  The ONLY function anything routing-related should call. Returning verdicts
 *  rather than raw strings keeps the reason attached, so a queue that drops a
 *  number can say which rule dropped it. */
export function dialableNumbers(verdicts: PhoneVerdict[]): PhoneVerdict[] {
  return verdicts.filter(v => !v.dnc);
}

export type DwellingType = "SFH" | "MDU" | "MOBILE" | "COMMERCIAL" | "UNKNOWN";

export interface LeadCard {
  leadId: number;
  areaId: number | null;
  name: string;
  address: string;
  dwellingType: DwellingType;
  fiberStatus: string;
  phones: Array<{
    number: string;
    lineType: LineType;
    confidence: number;
    dnc: boolean;
    dncFlags: Required<DncFlags>;
    reasons: DncReason[];
    /** Ready-to-render badge text. */
    badge: string;
  }>;
  emails: TracedEmail[];
  actions: LeadAction[];
  /** True when more contacts exist than the display cap shows. */
  truncated: { phones: boolean; emails: boolean };
}

/**
 * The lead-card contract, exactly as the field app and the API return it.
 *
 * `displayOnly` caps what is RENDERED at DISPLAY_LIMIT. Everything stays in the
 * backend and is reachable — the cap exists because a card with eleven phone
 * numbers on a phone screen at arm's length is unreadable, not because the
 * other eight are unwanted.
 */
export function buildLeadCard(input: {
  leadId: number;
  areaId: number | null;
  name: string;
  address: string;
  dwellingType: DwellingType;
  fiberStatus: string;
  phones: TracedPhone[];
  emails: TracedEmail[];
  callingEngineAllows: boolean;
  nowMs: number;
  displayOnly?: boolean;
}): LeadCard {
  const rankedPhones = rankPhones(input.phones);
  const rankedEmails = rankEmails(input.emails);
  // Verdicts over the FULL set — actions must reflect every number we hold, not
  // just the three we happen to show. A callable 4th phone still means the lead
  // is callable.
  const allVerdicts = rankedPhones.map(p => verdictForPhone(p, input.nowMs));

  const shown = input.displayOnly ? allVerdicts.slice(0, DISPLAY_LIMIT) : allVerdicts;
  const shownEmails = input.displayOnly ? rankedEmails.slice(0, DISPLAY_LIMIT) : rankedEmails;

  return {
    leadId: input.leadId,
    areaId: input.areaId,
    name: input.name,
    address: input.address,
    dwellingType: input.dwellingType,
    fiberStatus: input.fiberStatus,
    phones: shown.map(v => ({
      number: v.number,
      lineType: v.lineType,
      confidence: v.confidence,
      dnc: v.dnc,
      dncFlags: v.dncFlags,
      reasons: v.reasons,
      badge: v.dnc ? "DNC - do not dial" : "OK to call",
    })),
    emails: shownEmails,
    actions: actionsForLead(allVerdicts, input.callingEngineAllows),
    truncated: {
      phones: allVerdicts.length > shown.length,
      emails: rankedEmails.length > shownEmails.length,
    },
  };
}

/** "Resident at 123 Main St" unless the trace returned a real owner name.
 *
 *  Never invents a person. A knocker who opens with a wrong name is worse off
 *  than one who opens with none — the door closes on "no, that's not me"
 *  before the pitch starts. */
export function leadDisplayName(ownerName: string | null | undefined, address: string): string {
  const owner = (ownerName ?? "").trim();
  if (owner.length >= 2 && /[a-z]/i.test(owner)) return owner;
  const street = address.split(",")[0]?.trim() || address.trim();
  return street ? `Resident at ${street}` : "Resident";
}

/** Phones whose scrub has aged out and need re-running. Drives the recurring
 *  re-scrub, which is what keeps SCRUB_TTL_DAYS from being decorative. */
export function needsRescrub(phones: TracedPhone[], nowMs: number): TracedPhone[] {
  return phones.filter(p =>
    p.scrubbedAtMs == null || nowMs - p.scrubbedAtMs > SCRUB_TTL_DAYS * DAY_MS);
}
