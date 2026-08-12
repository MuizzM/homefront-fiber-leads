// ── What to say at the door ───────────────────────────────────────────────────
// PURE and framework-free. Turns the two facts the map pin already carries -
// which carrier lit the address, and when it was confirmed fresh - into the
// first line of the conversation.
//
// A rep standing on a porch has about four seconds. shared/doorPriority.ts
// answers "which door", and this answers the other half of the same question:
// "what do I say". The fresh-fiber intelligence is the only thing this product
// knows that the person behind the door does not, so that is the opener.
//
// THE RULE THIS MODULE ENFORCES: NOTHING INVENTED.
//
// `fact` may only restate something the system actually verified - the carrier
// on the lead and the confirmed-fresh timestamp the projector stamped. It never
// claims what neighbours pay, what the competitor charges, how long an offer
// lasts, or that crews are leaving. A rep who repeats a claim the app made up
// gets caught on the porch, and then trusts nothing else on the screen either.
// `ask` is a neutral discovery question, never a close.
//
// When there is no verified fact, this returns null and the card renders no
// opener at all. Silence is the honest output.

/** Carrier ids the scanners persist (server/scanEngine.ts, frontierScanner.ts). */
const CARRIER_LABELS: Record<string, string> = {
  kinetic: "Kinetic",
  frontier: "Frontier",
};

export interface OpenerInput {
  /** leads.carrier - "kinetic" (default) or "frontier". */
  carrier?: string | null;
  /** leads.fresh_confirmed_at - the independent-evidence projector's stamp. */
  freshConfirmedAt?: string | null;
  lastOutcome?: string | null;
  knockCount?: number | null;
}

export interface DoorOpener {
  /** Verified, never invented. Safe to say out loud. */
  fact: string;
  /** One neutral discovery question. */
  ask: string;
  /** Whole days since the address was confirmed fresh, when known. */
  litDays: number | null;
}

/** Accepts both timestamp shapes these tables hold: ISO ("...T...Z") and
 *  SQLite "YYYY-MM-DD HH:MM:SS", both UTC. Same normalisation
 *  server/leadRanking.ts parseDbTime does, kept local so this module stays
 *  dependency-free and usable on the client. */
export function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Beyond this, "lit N days ago" stops being a hook and starts sounding like an
 *  excuse, so the fact drops the age and states only that fibre is live. */
export const FRESH_AGE_MAX_DAYS = 30;

function litPhrase(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/**
 * The opening line for one door, or null when the system has verified nothing
 * worth saying.
 *
 * `nowMs` is injected so this is deterministic under test and cannot drift
 * across a midnight boundary mid-render.
 */
export function doorOpener(input: OpenerInput, nowMs: number = Date.now()): DoorOpener | null {
  const carrierKey = typeof input.carrier === "string" ? input.carrier.toLowerCase() : null;
  const label = (carrierKey && CARRIER_LABELS[carrierKey]) ?? null;
  const litMs = parseStamp(input.freshConfirmedAt);

  // No carrier AND no confirmed-fresh stamp means there is no verified fact -
  // say nothing rather than open with a generality.
  if (label == null && litMs == null) return null;

  // The subject of the sentence, not a brand token: an unknown carrier gives
  // "Fiber went live...", never "Fiber fiber went live...".
  const subject = label != null ? `${label} fiber` : "Fiber";
  // Negative ages are clock skew between the server stamp and the phone, not a
  // door that lights up next week - clamp to today rather than say "-5 days".
  const litDays = litMs != null ? Math.max(0, Math.floor((nowMs - litMs) / 86_400_000)) : null;

  const fact = litDays != null && litDays <= FRESH_AGE_MAX_DAYS
    ? `${subject} went live at this address ${litPhrase(litDays)}.`
    : `${subject} is live at this address.`;

  // A door where nobody answered last time is a timing problem, not an
  // information problem - the rep already has the fact, so the ask changes.
  const revisiting = (input.knockCount ?? 0) > 0 && input.lastOutcome === "not_home";
  const ask = revisiting
    ? "Second time by - is now a better moment?"
    : "Do you know what you're paying for internet right now?";

  return { fact, ask, litDays };
}
