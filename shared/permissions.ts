// Single source of truth for role-gated actions — used by BOTH the server
// middleware and the client's role-aware rendering, so the UI never offers an
// action the API will reject. Reps are fail-closed.
export type Role = "rep" | "team_lead" | "manager" | "admin" | "super_admin";

export type Action =
  | "view_own_leads"
  | "view_all_leads"
  | "create_territory"
  | "assign_territory"
  | "reclaim_territory"
  | "reset_territory_pass"
  | "return_leads_to_pool"
  | "archive_territory"
  | "override_territory_sync"
  | "delete_territory"
  | "reclaim_all_territories";

const RANK: Record<Role, number> = {
  rep: 0,
  team_lead: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

// Minimum role that unlocks each action. Mirrors the Express middleware:
// requireTeamLead → create/assign, requireManager → reclaim/return/archive/
// override, requireAdmin → delete.
const MIN_ROLE: Record<Action, Role> = {
  view_own_leads: "rep",
  view_all_leads: "team_lead",
  create_territory: "team_lead",
  assign_territory: "team_lead",
  // Pulling an area back from a rep is everyday assignment work — the same shift
  // that hands an area out reassigns it — so it sits with assign_territory at
  // team_lead. A team lead is still scoped to their OWN team's areas by
  // canManageTerritory; the rank only says the action is theirs to take.
  reclaim_territory: "team_lead",
  // Resetting an area for another sweep is NOT the same act: it clears the
  // outcomes an entire team recorded, across every door, with no undo. It kept
  // manager+ when reclaim dropped to team_lead, which is the whole reason it
  // needs its own name rather than riding on reclaim_territory.
  reset_territory_pass: "manager",
  return_leads_to_pool: "manager",
  archive_territory: "manager",
  override_territory_sync: "manager",
  delete_territory: "admin",
  // Emptying EVERY area in the org in one stroke is not everyday assignment
  // work — it is a reorganization. Same precedent that split
  // reset_territory_pass from reclaim_territory: the org-wide sweep gets its
  // own name and sits at admin, while per-area reclaim stays team-lead.
  reclaim_all_territories: "admin",
};

export function can(role: Role | string | undefined, action: Action): boolean {
  const r = RANK[role as Role];
  if (r == null) return false; // unknown role → fail closed
  return r >= RANK[MIN_ROLE[action]];
}
