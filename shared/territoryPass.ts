// ── Territory passes ──────────────────────────────────────────────────────────
// A "pass" is one sweep of an area. Reps knock it, outcomes accumulate, and then
// a manager closes the pass and opens the next one: every door that was worked
// goes back to knockable so the area can be swept again a week or a month later.
//
// The whole point of this module is the line between "working state" and
// "history". Working state (lead_status, last_outcome) is what the rep sees on
// the pin today, and a reset clears it. History (knock_log rows, commission
// rows, notes, the territory_passes ledger) is what actually happened, and a
// reset NEVER touches it. knock_log is append-only; resetting a lead does not
// delete, update, or hide a single knock. Pass N's doors stay queryable forever,
// stamped with the pass they belonged to.
//
// This file is deliberately DB-free so the freeze rules — the part that can cost
// real money if it's wrong — can be tested exhaustively without a database.

export type PassLeadAction = "reset" | "freeze";

/** Why a door was left alone. Ordered by precedence — first match wins, and the
 *  order matters: a sold door that is ALSO do-not-knock should report "sold",
 *  because that's the reason a manager needs to see first. */
export type FreezeReason =
  | "sold"              // lead_status is sold — a closed deal, not a door to re-knock
  | "commission_linked" // an active commission_sales row points at this lead
  | "do_not_knock"      // occupant asked us never to return; permanent, compliance
  | "pending_callback"; // a scheduled return visit the rep already promised

export const FREEZE_REASON_LABELS: Record<FreezeReason, string> = {
  sold: "Sold",
  commission_linked: "Has a commission on file",
  do_not_knock: "Do not knock",
  pending_callback: "Callback scheduled",
};

/** Plain-language explanation shown in the confirm dialog. Written for a sales
 *  manager standing in a parking lot, not for an engineer reading a stack trace. */
export const FREEZE_REASON_HELP: Record<FreezeReason, string> = {
  sold: "Already sold — the next pass skips it so nobody knocks a customer.",
  commission_linked: "A commission is recorded against this door. Re-opening it could pay twice.",
  do_not_knock: "The occupant asked us not to come back. This never resets.",
  pending_callback: "A rep promised to return. Resetting would drop that commitment.",
};

/** The minimum a lead has to look like for us to decide its fate. Keeping this
 *  narrow (rather than the full Lead row) is what lets the rules be unit-tested. */
export interface PassLeadInput {
  id: number;
  leadStatus?: string | null;
  doNotKnock?: boolean | null;
  /** True when an active (not cancelled/reversed/disqualified) sale points here. */
  hasActiveSale?: boolean | null;
  /** ISO timestamp of a scheduled callback, if one is outstanding. */
  pendingCallbackAt?: string | null;
}

export interface PassResetOptions {
  /** Freeze doors with a callback still in the future. Defaults to false: a pass
   *  reset is meant to re-open the area, and the manager is told in the preview
   *  exactly how many commitments that clears so it's a seen decision, not a
   *  silent one. */
  keepPendingCallbacks?: boolean;
  /** "Now" for callback comparison; injected so tests aren't clock-dependent. */
  now?: string;
}

export interface PassLeadDecision {
  leadId: number;
  action: PassLeadAction;
  reason?: FreezeReason;
}

/** Lead statuses that mean "this door is closed business". */
const SOLD_STATUSES = new Set(["sold"]);

/**
 * Decide whether one door gets re-opened for the next pass.
 *
 * Fails CLOSED: anything we can't confidently classify as safe to re-knock is
 * frozen. The asymmetry is deliberate — wrongly resetting a sold door can double
 * a commission and send a rep to an existing customer's porch, while wrongly
 * freezing one only means a manager clears it by hand.
 */
export function classifyLeadForPass(
  lead: PassLeadInput,
  opts: PassResetOptions = {},
): PassLeadDecision {
  const status = (lead.leadStatus ?? "").trim().toLowerCase();

  // Money first. Both the status flag and the ledger link are checked, because
  // they can disagree: a sale recorded through the commission import may not have
  // flipped lead_status, and a lead hand-edited to "sold" may have no ledger row
  // yet. Either one alone is enough to keep the door shut.
  if (SOLD_STATUSES.has(status)) return { leadId: lead.id, action: "freeze", reason: "sold" };
  if (lead.hasActiveSale) return { leadId: lead.id, action: "freeze", reason: "commission_linked" };

  // Compliance. Never resettable by any option — there is no flag to override it.
  if (lead.doNotKnock) return { leadId: lead.id, action: "freeze", reason: "do_not_knock" };

  if (opts.keepPendingCallbacks && lead.pendingCallbackAt) {
    const now = opts.now ?? new Date().toISOString();
    if (lead.pendingCallbackAt > now) {
      return { leadId: lead.id, action: "freeze", reason: "pending_callback" };
    }
  }

  return { leadId: lead.id, action: "reset" };
}

export interface PassPlan {
  reset: number[];
  frozen: PassLeadDecision[];
  /** Frozen counts by reason, for the preview summary. */
  frozenByReason: Record<FreezeReason, number>;
  totals: { total: number; reset: number; frozen: number };
  /** Doors with a future callback that WOULD be cleared under the current
   *  options. Surfaced even when the option is off so the preview can warn. */
  callbacksAtRisk: number;
}

/** Plan a whole area's reset. Pure: hands back ids, writes nothing. */
export function planPass(leads: PassLeadInput[], opts: PassResetOptions = {}): PassPlan {
  const now = opts.now ?? new Date().toISOString();
  const reset: number[] = [];
  const frozen: PassLeadDecision[] = [];
  const frozenByReason: Record<FreezeReason, number> = {
    sold: 0, commission_linked: 0, do_not_knock: 0, pending_callback: 0,
  };
  let callbacksAtRisk = 0;

  for (const lead of leads) {
    const d = classifyLeadForPass(lead, { ...opts, now });
    if (d.action === "reset") {
      reset.push(lead.id);
      // It's being reset AND it had a live callback → the manager is dropping a
      // promise. Counted so the dialog can say so out loud.
      if (lead.pendingCallbackAt && lead.pendingCallbackAt > now) callbacksAtRisk++;
    } else {
      frozen.push(d);
      if (d.reason) frozenByReason[d.reason]++;
    }
  }

  return {
    reset,
    frozen,
    frozenByReason,
    totals: { total: leads.length, reset: reset.length, frozen: frozen.length },
    callbacksAtRisk,
  };
}

// ── What a reset actually clears ──────────────────────────────────────────────
// Everything NOT listed here survives: notes, contact details, enrichment, lead
// score, tags, canonical key, scan provenance. A pass reset re-opens the door for
// knocking; it is not a data wipe, and it must never look like one.
export const PASS_RESET_FIELDS = {
  leadStatus: "prospect",
  lastOutcome: null,
  lastOutcomeAt: null,
  // Per-assignment triage (priority/hold) belongs to the pass that set it.
  assignMark: null,
} as const;

export type TerritoryPassAction = "return_to_pool" | "keep" | "reassign";

export const TERRITORY_PASS_ACTIONS: TerritoryPassAction[] = ["return_to_pool", "keep", "reassign"];

export function isTerritoryPassAction(v: unknown): v is TerritoryPassAction {
  return typeof v === "string" && (TERRITORY_PASS_ACTIONS as string[]).includes(v);
}

// ── Per-pass outcome rollup ───────────────────────────────────────────────────
// Computed from the knock rows belonging to one pass. This is what makes the
// history useful rather than merely retained: "pass 1 got 8 sales out of 210
// doors, pass 2 got 3 out of the 190 that were still open".

export interface PassKnockRow {
  outcome?: string | null;
  wasHome?: boolean | number | null;
  repId?: number | null;
  /** Knocks that lost the outcome CAS are field history but changed nothing. */
  superseded?: boolean | number | null;
}

export interface PassStats {
  knocks: number;
  doorsAnswered: number;
  sold: number;
  interested: number;
  notInterested: number;
  notHome: number;
  callbacks: number;
  reps: number[];
}

export function rollUpPass(rows: PassKnockRow[]): PassStats {
  const reps = new Set<number>();
  const s: PassStats = {
    knocks: 0, doorsAnswered: 0, sold: 0, interested: 0,
    notInterested: 0, notHome: 0, callbacks: 0, reps: [],
  };

  for (const r of rows) {
    // Superseded knocks are real visits and count as effort, but their outcome
    // never stood, so folding it into the tallies would double-count the door.
    const counted = !(r.superseded === true || r.superseded === 1);
    s.knocks++;
    if (r.wasHome === true || r.wasHome === 1) s.doorsAnswered++;
    if (r.repId != null) reps.add(r.repId);
    if (!counted) continue;

    switch ((r.outcome ?? "").trim().toLowerCase()) {
      case "sold": s.sold++; break;
      case "interested": s.interested++; break;
      case "not_interested": s.notInterested++; break;
      case "not_home": s.notHome++; break;
      case "callback": s.callbacks++; break;
    }
  }

  s.reps = Array.from(reps).sort((a, b) => a - b);
  return s;
}
