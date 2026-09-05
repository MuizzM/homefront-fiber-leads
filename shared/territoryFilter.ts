// TODO: verify usage: Areas currently uses different substring filters; adopting or retiring this tested word-prefix behavior needs a product decision.
// ── Narrowing the area list ───────────────────────────────────────────────────
// The area-management screen shows every territory a manager can see, which on a
// real tenant is hundreds of rows. Finding one is search-and-filter work, and it
// is the kind of work that goes subtly wrong in a UI file: a `.includes()` here,
// a `t.repId === repId` there, and the list quietly starts answering a different
// question than the one on the screen.
//
// So the rules live here, pure and framework-free, and two of them are borrowed
// rather than rewritten:
//
//   WHO HOLDS AN AREA is answered ONLY by territoryHeldByAny (shared/territory).
//   `repId` is the primary-owner marker and it deliberately still names the last
//   holder after a reclaim — filtering the list on it hands a manager (and, on a
//   scoped screen, the rep) back an area that was taken away. That rule cost two
//   access leaks before it was consolidated; this file imports it and never
//   inspects assigneeIds or repId itself.
//
//   WHAT COUNTS AS A SEARCH HIT is word-start matching, the same shape the rep
//   picker uses, because "riv" finding "Ann Rivera" on one screen and not on the
//   next is indistinguishable from a broken index to the person typing.

import { territoryHeldByAny } from "./territory";
import { knockedPct } from "./territoryLabel";

/** One row of the area list. Fields beyond `id` are optional because the screen
 *  composes this from a territory row plus counts that live elsewhere; a row
 *  missing a field is a real state (a freshly drawn area has no doors yet), not
 *  a caller error. `assigneeIds` stays `unknown` on purpose — it is TEXT on the
 *  server and a real array on the client, and only parseAssigneeIds may read it. */
export interface TerritoryListItem {
  id: number;
  name?: string | null;
  status?: string | null;
  /** PRIMARY-owner marker only. Never compare against it directly — see header. */
  repId?: number | null;
  assigneeIds?: unknown;
  /** ISO timestamp of the last knock/edit in this area. Absent = never worked. */
  lastActivityAt?: string | null;
  doorCount?: number | null;
  knockedCount?: number | null;
}

/** The statuses this screen offers as filter chips. Deliberately narrower than
 *  TerritoryStatus: "draft" and "archived" rows are not chip-able, but they are
 *  still returned when no status filter is set — an empty filter means "all",
 *  never "all of the five I happen to list". */
export type TerritoryFilterStatus = "active" | "shared" | "completed" | "unassigned" | "reclaimed";

export interface TerritoryFilter {
  /** Free text, matched against the area name and its holders' names. */
  query?: string;
  /** Empty or omitted → every status passes. */
  status?: readonly TerritoryFilterStatus[];
  /** Show only areas HELD BY one of these reps. Empty or omitted → no rep filter
   *  (this is not the same as `[]` meaning "nobody" — an empty chip set is an
   *  unused filter, and territoryHeldByAny is never called with it). */
  repIds?: readonly number[];
  /** Inclusive lower bound on lastActivityAt (ISO). */
  activeSince?: string;
  /** EXCLUSIVE upper bound on lastActivityAt (ISO) — "before" means strictly
   *  before, so [since, before) tiles cleanly when a caller pages through weeks. */
  activeBefore?: string;
}

export interface TerritoryFilterContext {
  /** Rep display names, so the query can match "Rivera" as well as "Maple Ridge".
   *  Only reps present here are searchable by name; an area held by an unknown id
   *  simply isn't findable that way, which is better than inventing a label. */
  repNameById: Readonly<Record<number, string>>;
}

/**
 * Word-start matching, case-insensitive: every term in the query must begin some
 * word of the text. "riv" matches "Ann Rivera"; "iver" does NOT.
 *
 * This mirrors the documented intent of the rep picker's `matches` helper ("match
 * on any word start"). It does NOT carry that helper's extra substring fallback:
 * with the fallback, "iver" matches "Rivera" and every short query drags in
 * accidental hits from the middle of long area names, which is precisely the
 * behaviour that makes a list feel broken. Word-start is the semantic both
 * surfaces are documented to have, so it is the one implemented here.
 *
 * An empty/whitespace query matches everything — a blank search box is not a
 * filter.
 */
export function matchesQuery(text: string | null | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const words = String(text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return needle.split(/\s+/).every((term) => words.some((word) => word.startsWith(term)));
}

/** ISO → epoch ms, or null when there is nothing usable to compare. Anything
 *  unparseable is treated as absent rather than as 1970: a bad string must not
 *  sort to the beginning of time or silently satisfy a lower bound. */
function timeOf(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Percent of doors worked, or null when the area has no doors to work. Reuses
 *  the label's rule so a card and a sorted list never disagree about "40%". */
function progressOf(t: TerritoryListItem): number | null {
  return knockedPct(t.knockedCount, t.doorCount);
}

/**
 * Which reps' names the query matches. Resolved from the context rather than
 * from the row, so the row's holders are still decided by territoryHeldByAny.
 */
function repIdsMatchingQuery(query: string, ctx: TerritoryFilterContext): number[] {
  const out: number[] = [];
  for (const key of Object.keys(ctx.repNameById)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    if (matchesQuery(ctx.repNameById[id], query)) out.push(id);
  }
  return out;
}

/**
 * Filter the area list. PURE — returns a NEW array and never touches the input.
 *
 * Every clause INTERSECTS: a row must satisfy the query AND the status set AND
 * the rep set AND the date window. A union would make adding a filter widen the
 * list, which is the opposite of what pressing a filter chip promises.
 *
 * Date window and missing activity: a row with no `lastActivityAt` has never been
 * worked. When either bound is set it is EXCLUDED — "areas active since Monday"
 * must not list areas nobody has ever touched, and the alternative (treat absent
 * as passing) makes the busiest-looking filter the emptiest one. With no bound
 * set, those rows are included like any other. A bound that is itself unparseable
 * is ignored rather than throwing: this runs on every keystroke behind a date
 * input, and a half-typed date must not blank the screen or crash the page.
 */
export function filterTerritories(
  territories: readonly TerritoryListItem[],
  filter: TerritoryFilter,
  ctx: TerritoryFilterContext,
): TerritoryListItem[] {
  const query = (filter.query ?? "").trim();
  const wantedStatus: readonly string[] = filter.status ?? [];
  const wantedReps = filter.repIds ?? [];
  const since = timeOf(filter.activeSince);
  const before = timeOf(filter.activeBefore);
  const windowed = since != null || before != null;

  // Computed once for the whole pass, not per row.
  const queryRepIds = query ? repIdsMatchingQuery(query, ctx) : [];

  return territories.filter((t) => {
    if (wantedStatus.length) {
      const status = typeof t.status === "string" ? t.status : "";
      if (!wantedStatus.includes(status)) return false;
    }

    // The one clause that must never be re-derived locally.
    if (wantedReps.length && !territoryHeldByAny(t, wantedReps)) return false;

    if (windowed) {
      const at = timeOf(t.lastActivityAt);
      if (at == null) return false;
      if (since != null && at < since) return false;
      if (before != null && at >= before) return false;
    }

    if (query) {
      // Name hit, or a hit on ANY rep who actually holds the area. Holding is
      // decided by territoryHeldByAny, so a reclaimed area is not findable by
      // the name of the rep it was taken from even though repId still says so.
      const nameHit = matchesQuery(t.name, query);
      const repHit = queryRepIds.length > 0 && territoryHeldByAny(t, queryRepIds);
      if (!nameHit && !repHit) return false;
    }

    return true;
  });
}

/**
 * Sort keys, each with the one direction that is useful on this screen:
 *
 *   name      A→Z by area name
 *   recent    most recently active first
 *   doors     biggest area first
 *   progress  furthest along first
 *
 * There is no ascending/descending flag because there is no reading of this
 * screen that wants the least-recently-active area at the top; a flag would be
 * two more states to test for no behaviour anyone asked for.
 */
export type TerritorySort = "name" | "recent" | "doors" | "progress";

/** Rows with nothing to compare on the primary key sort LAST, whichever key is
 *  chosen: an area with no doors, no progress or no activity is not "the best"
 *  or "the newest", it is a row with no answer, and it belongs at the bottom. */
const NO_ANSWER = -Infinity;

function primaryOf(t: TerritoryListItem, sort: TerritorySort): number {
  switch (sort) {
    case "recent":
      return timeOf(t.lastActivityAt) ?? NO_ANSWER;
    case "doors": {
      const n = Number(t.doorCount);
      return Number.isFinite(n) ? n : NO_ANSWER;
    }
    case "progress":
      return progressOf(t) ?? NO_ANSWER;
    case "name":
      return 0; // handled by the string comparator below
  }
}

/**
 * Sort the area list. PURE — returns a NEW array and never touches the input.
 *
 * The comparator is TOTAL: after the primary key it falls through to `id`, which
 * is unique per row. This is deliberate and not defensive clutter — Array.sort's
 * stability is only guaranteed for the *engine's* notion of equal elements, and
 * relying on "equal keys keep their input order" means the list silently
 * reshuffles when the same data arrives from a different endpoint in a different
 * order. Ties are broken by id, so the same rows always render in the same order.
 */
export function sortTerritories(
  territories: readonly TerritoryListItem[],
  sort: TerritorySort,
): TerritoryListItem[] {
  return [...territories].sort((a, b) => {
    if (sort === "name") {
      const an = String(a.name ?? "").trim();
      const bn = String(b.name ?? "").trim();
      // Unnamed rows sort last rather than to the top under an empty string.
      if (!an !== !bn) return an ? -1 : 1;
      const byName = an.localeCompare(bn, "en", { sensitivity: "base", numeric: true });
      if (byName !== 0) return byName;
    } else {
      const av = primaryOf(a, sort);
      const bv = primaryOf(b, sort);
      if (av !== bv) return bv - av; // descending: most recent / most doors / furthest along
    }
    return a.id - b.id;
  });
}
