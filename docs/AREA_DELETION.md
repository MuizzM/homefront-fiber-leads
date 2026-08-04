# Deleting an Area

What happens to the doors inside an Area when the Area is deleted, and why the
default is what it is.

> **The bug this documents the fix for.** Draw a polygon on the Field Map, assign
> it to a rep, then delete the polygon. The Area disappeared from the Area tab —
> and every door inside it stayed assigned to that rep. Still on their dialing
> list, still in their stats, still opening in their knock sheet, with the Area
> that explained all of it gone from every screen. The old delete cleared
> `leads.assigned_territory_id` and deliberately **kept** `assigned_rep_id`, so
> the grant outlived the thing that granted it.

## The default

`DELETE /api/territories/:id?repAssignments=clear` — and `clear` is what you get
when the parameter is absent.

| | `clear` (default) | `keep` |
|---|---|---|
| `assigned_territory_id` | cleared | cleared |
| `assigned_rep_id` | **cleared on every door** | kept |
| `assignment_source` / `assigned_by` / `assigned_at` | cleared with the rep | kept |
| `unassigned_at` | stamped | untouched |

An unrecognised value is a **400** (`BAD_REP_POLICY`), not a fallback to the
default: a typo must never silently mass-unassign a market.

The Area Console's delete dialog
([`AreaDeleteDialog`](../client/src/components/AreaDeleteDialog.tsx)) puts both
options on screen, so `keep` is a visible decision rather than an invisible
default. The Field Map's two-tap delete has no room for the choice and sends
`clear` explicitly, so the two surfaces cannot drift apart on the strength of a
default.

## Which doors lose their rep

**Every door in the Area, from whoever holds it — one rep or five.** Stated once,
as pure functions, in [`shared/territory.ts`](../shared/territory.ts) —
`areaDeleteClearsRep` / `planAreaDeleteLeads`. The set-based `UPDATE` in
[`server/scanIntelStore.ts`](../server/scanIntelStore.ts) (`releaseTerritoryLeads`)
is the same rule in SQL, and
[`tests/integration/territory-delete-cleanup.test.ts`](../tests/integration/territory-delete-cleanup.test.ts)
runs both over one fixture and compares, so a change to one that isn't made to
the other fails.

An earlier draft narrowed this to "reps the Area granted" — current holders, past
holders, the `rep_id` marker — so a door handed to somebody directly would
survive the delete. That is a distinction the person deleting the Area cannot see
and did not ask for. Deleting an Area is a statement about the **ground**, and
the doors on that ground stop being anybody's. One rule, no exceptions to
explain.

`areaGrantedRepIds` still exists and still unions
`assignee_ids ∪ past_assignee_ids ∪ {rep_id}` — but only to record who the Area
*belonged to* in the audit row. It is not an input to the release.

## What else the delete cleans up

All in one transaction with the row itself — a door that lost its Area but kept a
rep nobody can see is the half-state this whole path exists to remove, so it must
not be reachable by a crash between two writes.

| Residue | Cleanup |
|---|---|
| `leads.assigned_territory_id` | NULLed for every door (`releaseTerritoryLeads`) |
| `leads.assigned_rep_id` + its paperwork | cleared per the policy above |
| `territory_assignments` open rows | **closed** with reason `area deleted` (`closeAllAssignments`). The ledger is append-only, so deleting the Area used to leave the assignment open forever — the record said a rep still held ground that did not exist |
| `area_skip_trace_runs` in `queued`/`running` | closed as `failed` / `AREA_DELETED` (`cancelAreaSkipTraceRuns`). Otherwise the row stays live until the stale-run reaper's window, and the partial unique index still counts it |
| Map pin cache / lead stream | busted server-side, then one `assignment` event per affected door |

**Preserved on purpose:** knock history (attributed to whoever knocked, forever),
recorded sales, `territory_events`, closed `territory_assignments` rows, and the
market-learning outcome — `recordTerritoryOutcome` runs *before* the release,
because `computeTerritoryOutcome` reads `assigned_territory_id` and the lesson is
unrecoverable once the link is gone.

## Audit

Two rows per delete, so "why is Talal not on these doors any more" is answerable
after the fact:

- `admin_audit` action `territory.deleted` — before/after including
  `repAssignments`, `detached`, `repCleared`, `repIdsCleared`,
  `assignmentsClosed`, `skipTraceRunsCancelled`.
- `activity_log` action `territory.deleted` — the same numbers with the cleared
  reps resolved to **names**, which is what the UI toast prints
  ("84 doors left the area. 84 doors were unassigned from Talal.").

## Permission

`requireAdmin`, matching `delete_territory: "admin"` in
[`shared/permissions.ts`](../shared/permissions.ts). Team leads keep `assign` and
`reclaim`, which are reversible; deleting an Area is not.

---

# Areas hold a crew, not a rep

An Area is many-to-many everywhere it matters — `assignee_ids`, `/share`,
`/unassign`, and rule 2 of [`shared/leadVisibility.ts`](../shared/leadVisibility.ts)
("it sits in a territory they hold"). Two places could not express that, and both
now can.

## Creating one

`POST /api/territories/assign-area { polygon, repIds: number[], name?, color? }`

`repIds` is the **complete crew**; the singular `repId` is still accepted and
means a one-element crew. The **first id is the primary**: it drives the Area's
colour, its auto-name, and the `assigned_rep_id` stamped on the enclosed doors.
The rest see the same doors *through* the Area — `assigned_rep_id` names only one
of possibly several assignees, which is the model the whole codebase already
uses. Auto-names follow the crew: `Ann's area` for one, `Ann +2` for three.

Every rep is validated (tenant, visibility scope, `MAX_ACTIVE_AREAS_PER_REP`)
**before** anything is written, so a crew whose third member is out of scope
leaves no half-created Area behind. `MAX_AREA_ASSIGNEES` (12) caps the roster on
both the create and `/share` paths.

On the Field Map the lasso panel's rep `<select>` is now a toggle list — tap to
add, tap again to drop, first pick marked `1st`.

## Taking one rep off, from the Area tab

`POST /api/territories/:id/unassign { repId }` — already existed; the Area
Console had no UI for it and could only ever print one name. The detail page now
lists **every** holder with a two-step Remove per rep (dropping a rep hands their
doors back, so a mis-tap costs somebody their working queue) and an **Add a rep**
picker that calls `/share` with the complete new roster.

`GET /api/territories/progress` and `…/:id/progress` carry `repIds` + `repNames`
alongside the unchanged `repId`/`repName`, and the client reads them through the
single `areaHolders()` helper in
[`client/src/lib/areaProgress.ts`](../client/src/lib/areaProgress.ts) — which is
also where "a pool Area has **no** holders" lives, because `rep_id` deliberately
still names the last rep after a reclaim.

### The released doors stay in the Area

`/unassign` used to NULL `assigned_territory_id` along with the rep. On a shared
Area that threw the removed rep's doors out of the patch entirely: no rep **and**
no territory is *open field*, invisible to every co-assignee still walking that
ground and absent from the Area's own door count. Taking one person off a crew
now leaves the work with the crew. The link is cleared only when the Area itself
goes away (delete) or is explicitly emptied (reclaim to pool).
