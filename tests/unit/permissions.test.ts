import { describe, it, expect } from "vitest";
import { can, type Role, type Action } from "@shared/permissions";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (LOGIC agent, shared/permissions.ts — shared by server middleware AND
 * client role-aware rendering so there is ONE source of truth).
 *   can(role, action): boolean
 * Role rank: rep < team_lead < manager < admin < super_admin.
 * Mirrors the existing Express middleware:
 *   requireTeamLead -> create/assign territory
 *   requireManager  -> reclaim, return-to-pool, archive, override territory-sync
 *   requireAdmin    -> delete territory
 * Reps are fail-closed: own leads only, no territory ops.
 * ────────────────────────────────────────────────────────────────────────────
 */

const ROLES: Role[] = ["rep", "team_lead", "manager", "admin", "super_admin"];

// Expected minimum role that unlocks each action. Every role at or above it
// must be allowed; every role below must be denied.
const MIN_ROLE: Record<Action, Role> = {
  view_own_leads: "rep",
  view_all_leads: "team_lead",
  create_territory: "team_lead",
  assign_territory: "team_lead",
  reclaim_territory: "team_lead",
  reset_territory_pass: "manager",
  return_leads_to_pool: "manager",
  archive_territory: "manager",
  override_territory_sync: "manager",
  delete_territory: "admin",
  // The org-wide sweep: emptying EVERY area is a reorganization, not everyday
  // assignment work — admin only, while per-area reclaim stays team_lead.
  reclaim_all_territories: "admin",
};

const RANK: Record<Role, number> = {
  rep: 0,
  team_lead: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

describe("can() — full permission matrix", () => {
  for (const action of Object.keys(MIN_ROLE) as Action[]) {
    for (const role of ROLES) {
      const allowed = RANK[role] >= RANK[MIN_ROLE[action]];
      it(`${role} ${allowed ? "CAN" : "CANNOT"} ${action}`, () => {
        expect(can(role, action)).toBe(allowed);
      });
    }
  }
});

describe("can() — rep fail-closed (highest risk)", () => {
  it("a rep can only view their own leads and nothing else", () => {
    expect(can("rep", "view_own_leads")).toBe(true);
    const forbidden: Action[] = [
      "view_all_leads",
      "create_territory",
      "assign_territory",
      "reclaim_territory",
      "reset_territory_pass",
      "return_leads_to_pool",
      "archive_territory",
      "override_territory_sync",
      "delete_territory",
    ];
    for (const action of forbidden) expect(can("rep", action)).toBe(false);
  });

  it("team_lead can carve, assign and pull back areas — but cannot reset a pass", () => {
    expect(can("team_lead", "create_territory")).toBe(true);
    expect(can("team_lead", "assign_territory")).toBe(true);
    // Pulling an area back is assignment work — a team lead's own job. What they
    // still cannot do is reset an area for a new sweep, which wipes the whole
    // team's recorded outcomes.
    expect(can("team_lead", "reclaim_territory")).toBe(true);
    expect(can("team_lead", "reset_territory_pass")).toBe(false);
    expect(can("manager", "reset_territory_pass")).toBe(true);
    expect(can("rep", "reclaim_territory")).toBe(false);
    expect(can("team_lead", "return_leads_to_pool")).toBe(false);
  });

  it("super_admin can do everything a manager and admin can", () => {
    for (const action of Object.keys(MIN_ROLE) as Action[]) {
      expect(can("super_admin", action)).toBe(true);
    }
  });
});
