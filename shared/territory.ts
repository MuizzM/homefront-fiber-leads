// Territory lifecycle logic — PURE, framework-free, shared by server + client.
// `reclaimTerritory` is a pure state transition operating on a self-contained
// TerritoryState (the area + its enclosed leads + history), so it's trivially
// testable and identical everywhere. The server maps DB rows ↔ TerritoryState.

export type TerritoryStatus =
  | "draft" | "active" | "shared" | "completed" | "reclaimed" | "archived" | "unassigned";

export type ReclaimMode = "keep_leads" | "return_to_pool" | "reassign";

export interface TerritoryLeadRef {
  id: number;
  assignedRepId: number | null;
}

export interface TerritoryHistoryEvent {
  at: string;
  action: string;                 // e.g. "created", "reclaim:return_to_pool"
  actorId: number | null;
  from?: { status: TerritoryStatus; repIds: number[] };
}

export interface TerritoryState {
  id: number;
  status: TerritoryStatus;
  repIds: number[];               // multi-rep; [] when unassigned/reclaimed
  color?: string;
  leads: TerritoryLeadRef[];      // the leads enclosed by / linked to this area
  history: TerritoryHistoryEvent[];
}

// ── The area's colour ────────────────────────────────────────────────────────
// The colour is chosen by whoever draws the area and it describes the GROUND,
// not the person — so it has to survive the round trip byte-for-byte and mean
// the same thing to the server validating it and the map painting it. One
// pattern, shared, rather than a regex on each side that can drift apart.
//
// Shorthand is expanded (#0F0 → #00FF00) because the renderer parses fixed
// offsets, but case is otherwise preserved: the stored value is the admin's
// exact choice, and re-casing it would make "did the colour change?" answer yes
// on a value nobody edited.
export const TERRITORY_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeTerritoryColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!TERRITORY_COLOR_PATTERN.test(trimmed)) return null;
  const body = trimmed.slice(1);
  return body.length === 3 ? `#${body.split("").map((c) => c + c).join("")}` : trimmed;
}

// ── Who holds an area ────────────────────────────────────────────────────────
// The single answer to "does this rep work this area", used by every surface
// that scopes something to a territory: the doors on the map, a single lead
// read, the progress cards.
//
// Two columns can answer it and only one is authoritative. `assignee_ids` is the
// many-to-many holder list that reclaim and unassign rewrite. `repId` is the
// PRIMARY-owner marker kept for colour and history, and it deliberately still
// names the last holder after everyone has been removed — so consulting it
// first, or at all when a list exists, hands a reclaimed area straight back to
// the person it was taken from. An EMPTY list is a real answer meaning "nobody",
// not a missing one.
//
// repId is the fallback ONLY for legacy rows written before assignee_ids
// existed, where the column is genuinely absent rather than empty.
//
// This lived in three places with three subtly different orderings, two of which
// checked repId first and leaked; it lives here now so there is one rule to get
// right.
export function parseAssigneeIds(value: unknown): number[] | null {
  if (Array.isArray(value)) return value.filter((n): n is number => typeof n === "number");
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === "number") : null;
  } catch {
    return null; // unparseable → treat as legacy, fall back to repId
  }
}

export function territoryHeldByAny(
  territory: { repId?: number | null; assigneeIds?: unknown },
  repIds: readonly number[],
): boolean {
  if (!repIds.length) return false;
  const assignees = parseAssigneeIds(territory.assigneeIds);
  if (assignees) return assignees.some((id) => repIds.includes(id));
  return territory.repId != null && repIds.includes(territory.repId);
}

// Nobody holds this area — it sits in the pool. The team_lead territory list
// includes these: a lead who can ASSIGN areas must be able to SEE the pool,
// and a reclaimed area must read as "returned to pool", never as deleted.
export function territoryUnassigned(
  territory: { repId?: number | null; assigneeIds?: unknown },
): boolean {
  const assignees = parseAssigneeIds(territory.assigneeIds);
  if (assignees) return assignees.length === 0;
  return territory.repId == null;
}

// Company rule: recommended 3–5 active areas per rep. Callers pass the count of
// the rep's territories already in an active-like status (active/shared).
export const MAX_ACTIVE_AREAS_PER_REP = 5;

// Upper bound on the crew for ONE area. Not a product rule so much as a sanity
// wall: assignee_ids is a JSON array read on every visibility check, and an area
// with fifty reps on it is a mis-click or a script, not a patch anyone walks.
export const MAX_AREA_ASSIGNEES = 12;

export function canRepTakeAnotherArea(currentActiveCount: number, max = MAX_ACTIVE_AREAS_PER_REP): boolean {
  return currentActiveCount < max;
}

export interface ReclaimOpts {
  actorId: number | null;
  at: string;          // injectable ISO clock for deterministic history
  newRepId?: number;   // required for "reassign"
}

/**
 * Reclaim/pull-back a territory. PURE — never mutates `state`; returns a new one.
 *
 * keep_leads     → status "reclaimed",  repIds [],          leads UNCHANGED
 * return_to_pool → status "unassigned", repIds [],          every lead.assignedRepId → null
 * reassign       → status "shared",     repIds [newRepId],  every lead.assignedRepId → newRepId
 *
 * Appends exactly one history event recording the prior status + owners.
 */
export function reclaimTerritory(state: TerritoryState, mode: ReclaimMode, opts: ReclaimOpts): TerritoryState {
  const from = { status: state.status, repIds: [...state.repIds] };

  let status: TerritoryStatus;
  let repIds: number[];
  let leads: TerritoryLeadRef[];

  switch (mode) {
    case "keep_leads":
      status = "reclaimed";
      repIds = [];
      leads = state.leads.map(l => ({ ...l }));                     // untouched
      break;
    case "return_to_pool":
      status = "unassigned";
      repIds = [];
      leads = state.leads.map(l => ({ ...l, assignedRepId: null })); // back to pool
      break;
    case "reassign":
      if (opts.newRepId == null) throw new Error("reassign mode requires opts.newRepId");
      status = "shared";
      repIds = [opts.newRepId];
      leads = state.leads.map(l => ({ ...l, assignedRepId: opts.newRepId! }));
      break;
    default:
      throw new Error(`unknown reclaim mode: ${mode}`);
  }

  return {
    ...state,
    status,
    repIds,
    leads,
    history: [...state.history, { at: opts.at, action: `reclaim:${mode}`, actorId: opts.actorId, from }],
  };
}

export interface UnassignRepOpts {
  actorId: number | null;
  at: string;            // injectable ISO clock for deterministic history
  /** Leads in this area currently held by the removed rep return to the pool.
   *  false leaves them where they are (handover already done out-of-band). */
  releaseLeads?: boolean;
}

/**
 * Remove ONE rep from an area, leaving any co-assignees in place. PURE.
 *
 * reclaim() is all-or-nothing — it empties the area or hands it to a single new
 * owner — so there was no way to revoke one person from a shared area. That is
 * the operation a manager actually reaches for when a rep leaves a patch,
 * changes teams, or is taken off an account, and the point of it is that the
 * rep STOPS SEEING the work: their leads inside the polygon go back to the pool
 * (releaseLeads, the default) so nothing stays visible through lead assignment
 * after the area itself is gone.
 *
 * Removing the last rep leaves the area "unassigned" (in the pool), which is the
 * same terminal state return_to_pool produces — deliberately, so downstream
 * consumers only ever reason about one "nobody owns this" state.
 *
 * Removing a rep who is not assigned is a NO-OP: same state, no history entry.
 * Callers can detect it by comparing repIds length.
 */
export function unassignRep(state: TerritoryState, repId: number, opts: UnassignRepOpts): TerritoryState {
  if (!state.repIds.includes(repId)) return state;
  const from = { status: state.status, repIds: [...state.repIds] };
  const repIds = state.repIds.filter(id => id !== repId);
  const releaseLeads = opts.releaseLeads !== false;

  // Only the departing rep's leads move; a co-assignee's doors are never touched.
  const leads = releaseLeads
    ? state.leads.map(l => (l.assignedRepId === repId ? { ...l, assignedRepId: null } : { ...l }))
    : state.leads.map(l => ({ ...l }));

  // Last one out → the area is in the pool. Otherwise it stays a live area:
  // "shared" while more than one rep holds it, "active" once a single rep does.
  const status: TerritoryStatus = repIds.length === 0 ? "unassigned"
    : repIds.length === 1 ? "active"
    : "shared";

  return {
    ...state,
    status,
    repIds,
    leads,
    history: [...state.history, { at: opts.at, action: `unassign:${repId}`, actorId: opts.actorId, from }],
  };
}

// ── Deleting an area — what happens to the doors inside it ───────────────────
//
// THE RULE: deleting an area unassigns EVERY door in it — from whoever holds
// it, one rep or five, however that rep came to hold it. The area link goes and
// the rep goes with it, and the doors land in the pool ready to be handed out
// again.
//
// Deleting used to keep the rep unconditionally, which is the bug this fixes: an
// area handed to a rep and then deleted left every door inside it still assigned
// to them, still on their dialing list, still counting toward their stats, with
// nothing left on screen to explain why.
//
// An earlier draft narrowed this to "reps the area granted" — holders, past
// holders, the primary marker — so a door handed to somebody directly would
// survive. That is a distinction the person deleting the area cannot see and did
// not ask for. Deleting an area is a statement about the GROUND, and the doors
// on that ground stop being anybody's. One rule, no exceptions to explain.
//
// `keep` is the documented escape hatch for "we deleted the outline but the crew
// keeps the work" — see AreaDeleteDialog, which asks.

export type AreaDeleteRepPolicy = "clear" | "keep";

/** Clearing is the default: an area's grant should not outlive the area. */
export const DEFAULT_AREA_DELETE_REP_POLICY: AreaDeleteRepPolicy = "clear";

/**
 * Read the caller's choice. Absent → the default; anything unrecognised → null,
 * so a typo ("keeep") is a 400 rather than a silent mass unassign.
 */
export function parseAreaDeleteRepPolicy(value: unknown): AreaDeleteRepPolicy | null {
  if (value === undefined || value === null || value === "") return DEFAULT_AREA_DELETE_REP_POLICY;
  return value === "clear" || value === "keep" ? value : null;
}

/**
 * Everyone this area is, or ever was, held by — current holders, the
 * primary-owner marker, and the reassignment history. Deduped, order-stable.
 *
 * NOT the delete rule (that clears every rep, holder or not). This is who the
 * AREA belonged to, for the audit trail and for "who loses access" copy.
 */
export function areaGrantedRepIds(
  territory: { repId?: number | null; assigneeIds?: unknown; pastAssigneeIds?: unknown },
): number[] {
  const ids = [
    ...(parseAssigneeIds(territory.assigneeIds) ?? []),
    ...(parseAssigneeIds(territory.pastAssigneeIds) ?? []),
    ...(typeof territory.repId === "number" ? [territory.repId] : []),
  ].filter((id) => Number.isInteger(id) && id > 0);
  return Array.from(new Set(ids));
}

/**
 * Predicate form of the rule, for ONE door. The set-based UPDATE in
 * scanIntelStore.releaseTerritoryLeads is the same rule in SQL
 * (`assigned_rep_id IS NOT NULL`); a test pins the two together so a change to
 * one that isn't made to the other fails.
 */
export function areaDeleteClearsRep(
  lead: TerritoryLeadRef,
  policy: AreaDeleteRepPolicy = DEFAULT_AREA_DELETE_REP_POLICY,
): boolean {
  if (policy === "keep") return false;
  return lead.assignedRepId != null;
}

/**
 * The whole area's doors after the delete. PURE — never mutates `leads`.
 * `repIdsCleared` is the list a manager reads in the toast and the audit row:
 * "84 doors disassociated from Talal and Bo".
 */
export function planAreaDeleteLeads(
  leads: readonly TerritoryLeadRef[],
  policy: AreaDeleteRepPolicy = DEFAULT_AREA_DELETE_REP_POLICY,
): { leads: TerritoryLeadRef[]; repCleared: number; repIdsCleared: number[] } {
  const cleared: number[] = [];
  let repCleared = 0;
  const next = leads.map((l) => {
    if (!areaDeleteClearsRep(l, policy)) return { ...l };
    const rep = l.assignedRepId as number;
    if (!cleared.includes(rep)) cleared.push(rep);
    repCleared++;
    return { ...l, assignedRepId: null };
  });
  return { leads: next, repCleared, repIdsCleared: cleared };
}
