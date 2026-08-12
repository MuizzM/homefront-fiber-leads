// Pre-assignment triage marks — a manager / team lead flags a lead (usually
// while it is still in the unassigned pool) so it is triaged before a rep ever
// gets it. Orthogonal to lead_status and assignment: a mark rides straight
// through a later assign. Shared by the server (validation, wire) and the
// client (lasso "Mark" action, badges) so the two never diverge.

export const LEAD_MARKS = ["priority", "hold"] as const;
export type LeadMark = (typeof LEAD_MARKS)[number];

/** Accepts a valid mark, or null/"" to CLEAR the mark. Anything else is invalid. */
export function isLeadMarkOrClear(v: unknown): v is LeadMark | null | "" {
  return v == null || v === "" || (typeof v === "string" && (LEAD_MARKS as readonly string[]).includes(v));
}

export function isLeadMark(v: unknown): v is LeadMark {
  return typeof v === "string" && (LEAD_MARKS as readonly string[]).includes(v);
}

/** Normalize an incoming mark value to a stored value: a valid mark, or null. */
export function normalizeLeadMark(v: unknown): LeadMark | null {
  return isLeadMark(v) ? v : null;
}

export interface LeadMarkMeta {
  value: LeadMark;
  label: string;
  short: string;
  /** One-line intent, shown in pickers/tooltips. */
  description: string;
  /** Tailwind chip classes (badge bg + text). */
  chip: string;
  /** Hex used for the map pin ring so a marked pin reads at a glance. */
  ring: string;
}

export const LEAD_MARK_META: Record<LeadMark, LeadMarkMeta> = {
  priority: {
    value: "priority",
    label: "Priority",
    short: "Priority",
    description: "Assign this lead first - high intent or time-sensitive.",
    chip: "bg-warning/10 text-warning",
    ring: "#f59e0b",
  },
  hold: {
    value: "hold",
    label: "Hold",
    short: "Hold",
    description: "Don't assign yet - needs review or is on pause.",
    chip: "bg-muted text-muted-foreground",
    ring: "#64748b",
  },
};

export function leadMarkMeta(v: unknown): LeadMarkMeta | null {
  return isLeadMark(v) ? LEAD_MARK_META[v] : null;
}
