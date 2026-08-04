// ── Area skip trace: selecting the doors, and reporting the run ─────────────
//
// The Area-level wrapper around the skip trace. It owns TWO things only:
//   1. which doors a run may spend money on, and
//   2. the shape of a run's progress/summary and the dialing worklist.
//
// It deliberately owns NO DNC logic. `shared/tracerfy.ts` already decides
// whether a number may be dialled (verdictForPhone / dialableNumbers), and
// `shared/calling.ts` remains the authority for actually placing a call. A
// second opinion here would be a compliance regression dressed up as a
// feature — see the header of shared/tracerfy.ts, which says so first.

import type { TracedPhone } from "./tracerfy";

// ── Lead selection ──────────────────────────────────────────────────────────

/**
 * The doors an Area run may spend money on.
 *
 * WHY THIS IS NOT A ONE-LINE STATUS FILTER: "AlreadyCustomer" is not a
 * lead_status. It persists as lead_status='not_interested' WITH
 * last_outcome='already_customer' (shared/knock.ts), and the phone path writes
 * the same disambiguator from the 'already_has_service' outcome
 * (shared/readyToCall.ts). A literal `lead_status <> 'already_customer'`
 * matches zero rows and bills a skip trace for every already-customer door in
 * the area. Both columns have to be read.
 *
 * A plain `not_interested` door IS included. A skip trace buys the owner's
 * NAME, and the door is still knockable — the DNC rules govern the telephone,
 * not the doorstep, which is exactly why shared/tracerfy.ts keeps `door_knock`
 * unconditional. Whether any resulting number may be dialled is decided later,
 * per number, by machinery this file does not duplicate.
 */
export const AREA_SKIP_TRACE_LEAD_FILTER_SQL = `
  lower(coalesce(l.lead_status,'prospect')) <> 'sold'
  AND lower(coalesce(l.last_outcome,'')) <> 'already_customer'
  AND lower(coalesce(l.last_call_outcome,'')) NOT IN ('already_has_service','already_customer')
  AND coalesce(l.do_not_knock,0) = 0
`;

export interface AreaLeadSelectionFields {
  leadStatus?: string | null;
  lastOutcome?: string | null;
  lastCallOutcome?: string | null;
  doNotKnock?: boolean | number | null;
}

/** TypeScript mirror of the SQL above. Kept beside it so a test can prove the
 *  two agree — a drift here is a drift in what we pay a vendor for. */
export function isEligibleForAreaSkipTrace(lead: AreaLeadSelectionFields): boolean {
  const status = (lead.leadStatus ?? "prospect").trim().toLowerCase();
  const lastOutcome = (lead.lastOutcome ?? "").trim().toLowerCase();
  const lastCall = (lead.lastCallOutcome ?? "").trim().toLowerCase();
  if (status === "sold") return false;
  if (lastOutcome === "already_customer") return false;
  if (["already_has_service", "already_customer"].includes(lastCall)) return false;
  if (Number(lead.doNotKnock ?? 0) === 1) return false;
  return true;
}

// ── Run lifecycle ───────────────────────────────────────────────────────────

export type AreaSkipTraceStatus =
  | "queued" | "running" | "completed" | "failed" | "cancelled";

/** The summary the Area console renders. */
export interface AreaSkipTraceSummary {
  areaId: number;
  runId: string;
  status: AreaSkipTraceStatus;
  /** Doors selected for this run. */
  eligibleLeads: number;
  processedLeads: number;
  failedLeads: number;
  totalPhones: number;
  /** Numbers that currently pass verdictForPhone — i.e. scrubbed, current,
   *  and on no list. Recomputed on read, never a stored boolean. */
  dialablePhones: number;
  errorCode?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

// ── Dialing worklist ────────────────────────────────────────────────────────

export interface DialingListEntry {
  leadId: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  /** Traced owner name where one came back, else null. Never invented — the
   *  client renders "Resident at …" via leadDisplayName. */
  ownerName: string | null;
  /** Every traced number, blocked ones included. A DNC number stays visible:
   *  the rule is "don't dial", not "don't know".
   *
   *  TracedPhone, not PhoneVerdict, so the client renders these through the
   *  existing <LeadContacts>, which derives the verdict itself and already
   *  guarantees a blocked number is never a tel: link. Shipping a second
   *  renderer here would mean two places that have to keep getting that right. */
  phones: TracedPhone[];
}

export interface DialingListResponse {
  areaId: number;
  entries: DialingListEntry[];
  totalPhones: number;
  dialablePhones: number;
  truncated: boolean;
  /** A worklist, NOT a call authorization: these verdicts are the tracerfy
   *  projection. shared/calling.ts still gates every actual dial. */
  advisory: true;
  authorizationRequired: true;
}

/** Rows as the server holds them, before verdicts are computed. */
export interface StoredTracedLead {
  leadId: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  ownerName: string | null;
  phones: TracedPhone[];
}
