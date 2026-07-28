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

// Company rule: recommended 3–5 active areas per rep. Callers pass the count of
// the rep's territories already in an active-like status (active/shared).
export const MAX_ACTIVE_AREAS_PER_REP = 5;

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
