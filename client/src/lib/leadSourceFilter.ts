// ── Lead SOURCE filter (FCC) — composes with the status filter (AND) ────────
// The status filter answers "what disposition is this door?"; the source
// filter answers "where did this lead come from?". Both apply at once: a rep
// can work "FCC fiber doors I haven't knocked yet" without the two filters
// ever fighting. Pure predicates + persistence helpers, shared by MapView and
// the filter sheet, unit-tested without a map.
//
// DEFAULT: "latest" — the map WITHOUT the established-footprint import
// (fcc_fiber_d25), so a newly-lit-heavy org renders ~51k pins instead of
// ~174k. It is a speed/relevance LENS, never a deletion: the footprint is one
// tap away ("FCC fiber" chip, or "All"). Server-side it maps to ?view=latest
// (count probe, full feed, bbox windows, density grid); the pin predicate
// below keeps the already-loaded set honest between refetches.

export type LeadSourceFilter = "latest" | "all" | "fcc_fresh" | "fcc_fiber" | "field_verified";

// v2: the key bump is what makes "latest" the default ONCE for everyone —
// a persisted v1 choice is left behind (and cleaned up on the next write),
// while every v2 choice the user makes afterwards still wins.
export const FILTER_SOURCE_LS_KEY = "hf.mapFilterSource.v2";
const FILTER_SOURCE_LS_KEY_V1 = "hf.mapFilterSource.v1";

/** Pin fields the source filter reads. Structural — MapPin and GeoJsonLead
 *  both satisfy it. */
export interface SourceFilterableLead {
  leadTag?: string | null;
  freshConfirmedAt?: string | null;
}

export interface LeadSourceOption {
  key: Exclude<LeadSourceFilter, "all">;
  label: string;
  matches: (lead: SourceFilterableLead) => boolean;
}

/** The one tag the "latest" lens hides (mirrors MAP_LATEST_VIEW_EXCLUDED_TAG
 *  server-side — both names pin the same string so the two can't drift). */
export const LATEST_VIEW_EXCLUDED_TAG = "fcc_fiber_d25";

export const LEAD_SOURCE_OPTIONS: readonly LeadSourceOption[] = [
  {
    // FIRST position: the default view. Matches everything except the
    // footprint import — NULL tags (organic/manual adds), fcc_fresh_block,
    // field-verified, and any other tag all stay.
    key: "latest",
    label: "Latest fiber",
    matches: (l) => l.leadTag !== LATEST_VIEW_EXCLUDED_TAG,
  },
  {
    key: "fcc_fresh",
    label: "FCC fresh (H2-25)",
    matches: (l) => l.leadTag === "fcc_fresh_block",
  },
  {
    key: "fcc_fiber",
    label: "FCC fiber",
    matches: (l) => l.leadTag === "fcc_fiber_d25",
  },
  {
    key: "field_verified",
    label: "Field-verified",
    matches: (l) => l.freshConfirmedAt != null && l.freshConfirmedAt !== "",
  },
];

export function leadMatchesSource(lead: SourceFilterableLead, source: LeadSourceFilter): boolean {
  if (source === "all") return true;
  const opt = LEAD_SOURCE_OPTIONS.find((o) => o.key === source);
  return opt ? opt.matches(lead) : true;
}

export function applySourceFilter<T extends SourceFilterableLead>(
  leads: readonly T[],
  source: LeadSourceFilter,
): T[] {
  if (source === "all") return leads.slice();
  return leads.filter((l) => leadMatchesSource(l, source));
}

/** Per-option counts over the CURRENT lens (post territory/rep filter, pre
 *  status filter — same set the status counts read). Options with a zero
 *  count are dead UI: the sheet renders counts only for options present in
 *  this record, and hides a zero-count option entirely. */
export function countLeadsBySource(
  leads: readonly SourceFilterableLead[],
): Partial<Record<Exclude<LeadSourceFilter, "all">, number>> {
  const counts: Partial<Record<Exclude<LeadSourceFilter, "all">, number>> = {};
  for (const opt of LEAD_SOURCE_OPTIONS) {
    const n = leads.reduce((acc, l) => acc + (opt.matches(l) ? 1 : 0), 0);
    if (n > 0) counts[opt.key] = n;
  }
  return counts;
}

export function readPersistedFilterSource(): LeadSourceFilter {
  try {
    const v = localStorage.getItem(FILTER_SOURCE_LS_KEY);
    if (v === "latest" || v === "all" || v === "fcc_fresh" || v === "fcc_fiber" || v === "field_verified") return v;
    return "latest"; // no v2 choice yet (a v1 choice is deliberately left behind)
  } catch {
    return "latest"; // storage blocked (private mode) — session-only filter
  }
}

export function persistFilterSource(source: LeadSourceFilter): void {
  try {
    localStorage.setItem(FILTER_SOURCE_LS_KEY, source);
    localStorage.removeItem(FILTER_SOURCE_LS_KEY_V1); // superseded — one key owns the lens
  } catch {
    /* storage blocked — filter just won't survive a reload */
  }
}

/** Any FCC-reported lead (both tags share the `fcc` family prefix) — drives
 *  the verify-at-door chip on the lead card. */
export function isFccReportedLead(lead: SourceFilterableLead): boolean {
  return typeof lead.leadTag === "string" && lead.leadTag.startsWith("fcc");
}
