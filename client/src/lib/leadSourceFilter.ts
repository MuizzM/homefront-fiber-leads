// ── Lead SOURCE filter (FCC) — composes with the status filter (AND) ────────
// The status filter answers "what disposition is this door?"; the source
// filter answers "where did this lead come from?". Both apply at once: a rep
// can work "FCC fiber doors I haven't knocked yet" without the two filters
// ever fighting.
//
// The PREDICATE (types, options, leadMatchesSource) lives in
// shared/leadSource.ts because the server applies the same lens when it
// resolves a lasso ring (/api/leads/assign-selection[/preview]) — one rule,
// two evaluators, no drift. This module re-exports it for the client and owns
// the browser-only persistence helpers.
//
// DEFAULT: "latest" — the map WITHOUT the established-footprint import
// (fcc_fiber_d25), so a newly-lit-heavy org renders ~51k pins instead of
// ~174k. It is a speed/relevance LENS, never a deletion: the footprint is one
// tap away ("FCC fiber" chip, or "All"). Server-side it maps to ?view=latest
// (count probe, full feed, bbox windows, density grid); the pin predicate
// keeps the already-loaded set honest between refetches.

export {
  KINETIC_2026_TAG,
  LATEST_VIEW_EXCLUDED_TAG,
  LEAD_SOURCE_OPTIONS,
  applySourceFilter,
  countLeadsBySource,
  isFccReportedLead,
  isLeadSourceFilter,
  leadMatchesSource,
} from "@shared/leadSource";
export type {
  LeadSourceFilter,
  LeadSourceOption,
  SourceFilterableLead,
} from "@shared/leadSource";

import { isLeadSourceFilter, type LeadSourceFilter } from "@shared/leadSource";

// v2: the key bump is what makes "latest" the default ONCE for everyone —
// a persisted v1 choice is left behind (and cleaned up on the next write),
// while every v2 choice the user makes afterwards still wins.
export const FILTER_SOURCE_LS_KEY = "hf.mapFilterSource.v2";
const FILTER_SOURCE_LS_KEY_V1 = "hf.mapFilterSource.v1";

export function readPersistedFilterSource(): LeadSourceFilter {
  try {
    const v = localStorage.getItem(FILTER_SOURCE_LS_KEY);
    if (isLeadSourceFilter(v)) return v;
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
