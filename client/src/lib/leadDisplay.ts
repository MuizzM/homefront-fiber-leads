import { pinDisplayState, STATE_LABELS } from "@shared/knock";

const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  interested: "Interested",
  sold: "Sold",
  not_interested: "Not Interested",
  follow_up: "Follow Up",
};

/**
 * Label a list row using only evidence the list endpoint actually returns.
 *
 * The old list UI hard-coded `visited: true`, which turned every untouched
 * prospect into "Contacted" even when the server's Contacted filter count was
 * zero. A persisted outcome is evidence that the door was worked; no outcome
 * means the raw prospect remains an unworked Prospect.
 */
export function leadStateLabel(lead: {
  leadStatus: string;
  lastOutcome?: string | null;
}): string {
  try {
    const state = pinDisplayState({
      leadStatus: lead.leadStatus,
      visited: Boolean(lead.lastOutcome),
      lastOutcome: lead.lastOutcome ?? null,
    });
    return STATE_LABELS[state];
  } catch {
    return STATUS_LABEL[lead.leadStatus] ?? lead.leadStatus;
  }
}
