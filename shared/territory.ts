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
