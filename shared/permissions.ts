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
  | "return_leads_to_pool"
  | "archive_territory"
  | "override_territory_sync"
  | "delete_territory";

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
  reclaim_territory: "manager",
  return_leads_to_pool: "manager",
  archive_territory: "manager",
  override_territory_sync: "manager",
  delete_territory: "admin",
};

export function can(role: Role | string | undefined, action: Action): boolean {
  const r = RANK[role as Role];
  if (r == null) return false; // unknown role → fail closed
  return r >= RANK[MIN_ROLE[action]];
}
