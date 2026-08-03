// ── Rep lead visibility — ONE rule, two encodings ────────────────────────────
// "Which doors may this rep work?" was answered in two places that did not
// agree, and the gap was visible in the field: server/routes.ts let a rep KNOCK
// an open-field door (no rep, no territory), while the map's SQL predicate
// never selected one — so those doors were legal to work and impossible to see.
// A rep cannot knock a pin that was never drawn.
//
// The rule now lives here once, expressed twice because the two callers need
// different shapes: a predicate over a hydrated lead (the per-request access
// check) and a SQL fragment (the set queries that paint the map). The two are
// pinned against each other by tests, so a change to one that isn't made to the
// other fails rather than silently re-opening the gap.
//
// THE RULE — a scoped rep may work a door when ANY of these holds:
//   1. it is assigned to them (or to someone in their scope, for a team lead);
//   2. it sits in a territory they hold — an area is many-to-many, and
//      leads.assigned_rep_id names only ONE of possibly several assignees;
//   3. it is OPEN FIELD — no rep AND no territory — AND the tenant has opted
//      into self-serve open field. DEFAULT OFF. Turning it on shows every rep
//      every unowned door in the tenant, which for an org that imported a whole
//      market's FCC footprint means a rep opens the app to tens of thousands of
//      doors nobody handed them. Assignment is how work gets distributed; a rep
//      helping themselves to unassigned ground is a management problem, not a
//      feature. It stays available because the opposite org exists — a small
//      team told to "go work the town" — but it is a deliberate choice.
// A door assigned to another rep, or sitting in another team's area, stays
// denied. Tenant isolation is enforced BEFORE this rule and is not its job.
//
// Unscoped callers (admin/manager/super_admin) bypass this entirely — they see
// the whole tenant.

export interface LeadOwnership {
  assignedRepId: number | null | undefined;
  assignedTerritoryId: number | null | undefined;
}

/**
 * Predicate form — for a single hydrated lead.
 *
 * `scopeRepIds` is the caller's rep scope (self, or self + reports).
 * `territoryIdsInScope` is the set of territory ids the scope holds, supplied
 * by the caller because resolving it needs a DB read this module must not do.
 */
export function repCanWorkLead(
  lead: LeadOwnership | null | undefined,
  scopeRepIds: readonly number[],
  territoryIdsInScope: ReadonlySet<number>,
  openFieldEnabled = false,
): boolean {
  if (!lead) return false;
  const repId = lead.assignedRepId ?? null;
  const territoryId = lead.assignedTerritoryId ?? null;
  if (repId != null && scopeRepIds.includes(repId)) return true;          // (1) theirs
  if (repId == null && territoryId == null) return openFieldEnabled;      // (3) open field, opt-in
  if (territoryId == null) return false;                                  // someone else's
  return territoryIdsInScope.has(territoryId);                            // (2) their area
}

/**
 * SQL form — the same rule as a WHERE fragment, for the set queries.
 *
 * Returns `null` for an UNSCOPED caller (no predicate: the whole tenant), and
 * the impossible predicate for an empty scope so a rep with no linked member
 * fails closed at zero rows rather than open at all of them.
 *
 * Ids are inlined rather than parameterized because this fragment is composed
 * into several different query builders (raw better-sqlite3 and Drizzle) whose
 * parameter ordering cannot be made to agree. They are coerced to integers
 * here, at the boundary, so nothing but a number can reach the string.
 */
export function repVisibilitySql(
  scopeRepIds: readonly number[] | undefined,
  alias = "leads",
  openFieldEnabled = false,
): string | null {
  if (scopeRepIds === undefined) return null;
  const ids = scopeRepIds
    .map((n) => Math.trunc(Number(n)))
    .filter((n) => Number.isSafeInteger(n));
  if (!ids.length) return "1 = 0";
  const list = ids.join(",");
  const a = alias;
  // EXISTS against the area rather than a join: one indexed lookup per row, no
  // fan-out, and no duplicate rows when several reps share an area — which a
  // join would produce and which the map must never render.
  const openField = openFieldEnabled
    ? `\n        OR (${a}.assigned_rep_id IS NULL AND ${a}.assigned_territory_id IS NULL)`
    : "";
  return `(
        ${a}.assigned_rep_id IN (${list})${openField}
        OR EXISTS (
          SELECT 1 FROM territories t
           WHERE t.id = ${a}.assigned_territory_id
             AND (t.rep_id IN (${list}) OR EXISTS (
               SELECT 1 FROM json_each(COALESCE(t.assignee_ids, '[]')) je
                WHERE je.value IN (${list})
             ))
        )
      )`;
}
