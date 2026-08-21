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

// County-GIS imports arrive as shout-case ("1032 CORNELL STREET, UNIT B") and
// all-caps plus end-truncation costs the two things a rep scans a list for:
// street name and street type. Display-layer only — stored data, search, and
// dedupe keys stay exactly as imported.
const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "US"]);
const ORDINAL_SUFFIX = /^(\d+)(ST|ND|RD|TH)$/;

function caseAddressWord(word: string): string {
  // Only lower a word that is fully shouted; hand-entered mixed case is
  // someone's deliberate spelling ("McDonald") and passes through untouched.
  if (!/[A-Z]/.test(word) || word !== word.toUpperCase()) return word;
  if (DIRECTIONALS.has(word) || word.length === 1) return word; // "E OAK", "UNIT B"
  const ordinal = word.match(ORDINAL_SUFFIX);
  if (ordinal) return ordinal[1] + ordinal[2].toLowerCase(); // "5TH" -> "5th"
  if (/^\d/.test(word)) return word; // house numbers, ZIPs, "123B"
  return word[0] + word.slice(1).toLowerCase();
}

export function titleCaseAddress(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .split(/(\s+)/)
    .map(chunk => /\s/.test(chunk)
      ? chunk
      : chunk
          .split(/([-/])/)
          .map(part => part === "-" || part === "/"
            ? part
            : part.replace(
                /^([^A-Za-z0-9]*)([A-Za-z0-9]+)([^A-Za-z0-9]*)$/,
                (_, pre: string, core: string, post: string) => pre + caseAddressWord(core) + post,
              ))
          .join(""))
    .join("");
}
