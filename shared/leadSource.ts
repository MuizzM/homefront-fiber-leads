// ── Lead SOURCE lens — the pure predicate, shared by client AND server ───────
// The map's source filter ("where did this lead come from?") started life as a
// client-only pin predicate. That was fine while it only chose which loaded
// pins to PAINT — but the lasso's assign-selection endpoint resolves the ring
// on the server, and a lens the server cannot apply meant the panel counted
// one set while the server assigned another (the manager saw "12 doors" under
// "FCC fresh" and the server moved every door in the ring). The predicate now
// lives here so both sides evaluate the SAME rule on the SAME pin fields;
// client-side persistence helpers stay in client/src/lib/leadSourceFilter.ts.
//
// Two lenses ("latest", "kinetic_2026") ALSO have a server-side SQL view
// (?view=) so the count probe and density grid can narrow; the pin predicate
// here is the row-level truth both agree with.

export type LeadSourceFilter = "latest" | "all" | "kinetic_2026" | "fcc_fresh" | "fcc_fiber" | "field_verified";

/** Tag carried by doors an authorized Kinetic qualification confirmed AND the
 *  FCC baseline proves were unserved before 2026. Mirrors
 *  MAP_KINETIC_2026_TAG server-side so the lens and the promoter agree. */
export const KINETIC_2026_TAG = "kinetic_build_2026";

/** The one tag the "latest" lens hides (mirrors MAP_LATEST_VIEW_EXCLUDED_TAG
 *  server-side — both names pin the same string so the two can't drift). */
export const LATEST_VIEW_EXCLUDED_TAG = "fcc_fiber_d25";

/** Pin fields the source filter reads. Structural — MapPin, GeoJsonLead and
 *  the server's buildMapPins output all satisfy it. Compact pins OMIT falsy
 *  fields, so both may be undefined rather than null. */
export interface SourceFilterableLead {
  leadTag?: string | null;
  freshConfirmedAt?: string | null;
}

export interface LeadSourceOption {
  key: Exclude<LeadSourceFilter, "all">;
  label: string;
  matches: (lead: SourceFilterableLead) => boolean;
}

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
    // The 2026 build layer. Sits directly after the default lens because it is
    // the highest-intent set on the map: every door here was confirmed
    // serviceable by an authorized qualification, not merely filed with the FCC.
    key: "kinetic_2026",
    label: "Kinetic 2026 builds",
    matches: (l) => l.leadTag === KINETIC_2026_TAG,
  },
  {
    key: "fcc_fresh",
    label: "FCC fresh (2025)",
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

export function isLeadSourceFilter(v: unknown): v is LeadSourceFilter {
  return v === "latest" || v === "all" || v === "kinetic_2026" ||
    v === "fcc_fresh" || v === "fcc_fiber" || v === "field_verified";
}

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

/** Any FCC-reported lead (both tags share the `fcc` family prefix) — drives
 *  the verify-at-door chip on the lead card. */
export function isFccReportedLead(lead: SourceFilterableLead): boolean {
  return typeof lead.leadTag === "string" && lead.leadTag.startsWith("fcc");
}
