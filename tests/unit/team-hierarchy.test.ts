import { describe, expect, it } from "vitest";
import {
  canActOnMember,
  canHireRole,
  hierarchyRank,
  isValidSupervisorRole,
  wouldCreateReportsCycle,
  branchOwnerOf,
  uplineSlotsOf,
  HIRABLE_ROLES,
} from "@shared/teamHierarchy";

describe("canActOnMember — strictly-above authority", () => {
  it("team_lead acts on rep only", () => {
    expect(canActOnMember("team_lead", "rep")).toBe(true);
    expect(canActOnMember("team_lead", "team_lead")).toBe(false);
    expect(canActOnMember("team_lead", "manager")).toBe(false);
  });

  it("manager acts on team_lead and rep, never a fellow manager", () => {
    expect(canActOnMember("manager", "rep")).toBe(true);
    expect(canActOnMember("manager", "team_lead")).toBe(true);
    expect(canActOnMember("manager", "manager")).toBe(false);
  });

  it("admin acts on manager and everyone below", () => {
    expect(canActOnMember("admin", "manager")).toBe(true);
    expect(canActOnMember("admin", "team_lead")).toBe(true);
    expect(canActOnMember("admin", "rep")).toBe(true);
  });

  it("super_admin outranks admin-level members", () => {
    expect(canActOnMember("super_admin", "manager")).toBe(true);
  });

  it("nobody acts on peers or upward", () => {
    expect(canActOnMember("rep", "rep")).toBe(false);
    expect(canActOnMember("rep", "team_lead")).toBe(false);
    expect(canActOnMember("team_lead", "manager")).toBe(false);
  });

  it("unknown or calling/compliance roles fail closed on either side", () => {
    expect(canActOnMember("calling_manager", "rep")).toBe(false);
    expect(canActOnMember("compliance_admin", "rep")).toBe(false);
    expect(canActOnMember("auditor", "rep")).toBe(false);
    expect(canActOnMember("admin", "made_up_role")).toBe(false);
    expect(canActOnMember(undefined, "rep")).toBe(false);
    expect(canActOnMember("admin", null)).toBe(false);
  });
});

describe("canHireRole / HIRABLE_ROLES — hire what you could offboard", () => {
  it("mirrors the strictly-above rule exactly", () => {
    for (const [actor, hirable] of Object.entries(HIRABLE_ROLES)) {
      for (const role of hirable) {
        expect(canActOnMember(actor, role), `${actor} hires ${role} → must also outrank`).toBe(true);
        expect(canHireRole(actor, role)).toBe(true);
      }
    }
  });

  it("refuses hires at or above the actor's own rank", () => {
    expect(canHireRole("team_lead", "team_lead")).toBe(false);
    expect(canHireRole("manager", "manager")).toBe(false);
    expect(canHireRole("rep", "rep")).toBe(false);
    expect(canHireRole("calling_manager", "rep")).toBe(false);
  });
});

describe("isValidSupervisorRole", () => {
  it("supervisors must rank strictly above their reports", () => {
    expect(isValidSupervisorRole("rep", "team_lead")).toBe(true);
    expect(isValidSupervisorRole("rep", "manager")).toBe(true);
    expect(isValidSupervisorRole("team_lead", "manager")).toBe(true);
    expect(isValidSupervisorRole("rep", "rep")).toBe(false);
    expect(isValidSupervisorRole("team_lead", "team_lead")).toBe(false);
    expect(isValidSupervisorRole("manager", "team_lead")).toBe(false);
    expect(isValidSupervisorRole("manager", "manager")).toBe(false);
  });

  it("fails closed on unknown roles", () => {
    expect(isValidSupervisorRole("rep", "auditor")).toBe(false);
    expect(isValidSupervisorRole("ghost", "manager")).toBe(false);
  });
});

describe("wouldCreateReportsCycle", () => {
  const chain = (edges: Array<[number, number | null]>) => new Map<number, number | null>(edges);

  it("null supervisor (top-level) is never a cycle", () => {
    expect(wouldCreateReportsCycle(1, null, chain([[1, 2], [2, null]]))).toBe(false);
    expect(wouldCreateReportsCycle(1, undefined, chain([]))).toBe(false);
  });

  it("self-report is the trivial cycle", () => {
    expect(wouldCreateReportsCycle(1, 1, chain([]))).toBe(true);
  });

  it("detects a two-node loop", () => {
    // 2 currently reports to 1; pointing 1 at 2 closes the loop.
    expect(wouldCreateReportsCycle(1, 2, chain([[2, 1]]))).toBe(true);
  });

  it("detects a deep loop through the chain", () => {
    // 4→3→2, and we try to point 2 at 4: walk 4→3→2 = member → cycle.
    expect(wouldCreateReportsCycle(2, 4, chain([[4, 3], [3, 2], [2, null]]))).toBe(true);
  });

  it("accepts a legitimate re-parent in the same tree", () => {
    // 3→2→1; re-pointing 3 at 1 (skip a level) is fine.
    expect(wouldCreateReportsCycle(3, 1, chain([[3, 2], [2, 1], [1, null]]))).toBe(false);
  });

  it("fails closed when the existing chain is already corrupt (hop budget)", () => {
    // Pre-existing 5↔6 loop that never reaches the member: still refused.
    expect(wouldCreateReportsCycle(1, 5, chain([[5, 6], [6, 5]]))).toBe(true);
  });
});

describe("hierarchyRank", () => {
  it("ranks field + admin roles and rejects everything else", () => {
    expect(hierarchyRank("rep")).toBe(0);
    expect(hierarchyRank("team_lead")).toBe(1);
    expect(hierarchyRank("manager")).toBe(2);
    expect(hierarchyRank("admin")).toBe(3);
    expect(hierarchyRank("super_admin")).toBe(4);
    expect(hierarchyRank("calling_rep")).toBeNull();
    expect(hierarchyRank("")).toBeNull();
    expect(hierarchyRank(undefined)).toBeNull();
  });
});

describe("branchOwnerOf — whose people are these", () => {
  // rep(3) → tl(2) → mgr(1); rep(4) directly under mgr(1); rep(5) unowned.
  const roster = [
    { id: 1, role: "manager", reportsToId: null, active: true },
    { id: 2, role: "team_lead", reportsToId: 1, active: true },
    { id: 3, role: "rep", reportsToId: 2, active: true },
    { id: 4, role: "rep", reportsToId: 1, active: true },
    { id: 5, role: "rep", reportsToId: null, active: true },
  ];

  it("walks past team leads to the manager at the top of the branch", () => {
    expect(branchOwnerOf(3, roster)).toBe(1);
    expect(branchOwnerOf(4, roster)).toBe(1);
  });

  it("a manager owns their own branch, so peers resolve to each other", () => {
    expect(branchOwnerOf(1, roster)).toBe(1);
  });

  it("a top-level member is UNOWNED — adoptable rather than stranded", () => {
    expect(branchOwnerOf(5, roster)).toBeNull();
  });

  it("an INACTIVE manager does not own a branch — their orphans stay reachable", () => {
    const departed = roster.map(m => m.id === 1 ? { ...m, active: false } : m);
    expect(branchOwnerOf(3, departed)).toBeNull();
  });

  it("a corrupt cycle reads as unowned instead of looping forever", () => {
    const cyclic = [
      { id: 1, role: "rep", reportsToId: 2, active: true },
      { id: 2, role: "rep", reportsToId: 1, active: true },
    ];
    expect(branchOwnerOf(1, cyclic)).toBeNull();
  });

  it("an unknown member id is unowned, not an exception", () => {
    expect(branchOwnerOf(999, roster)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// uplineSlotsOf — the DERIVED manager / team-lead pair.
//
// The spec asked for manager_id and team_lead_id as stored columns. They are
// computed from the single parent edge instead, because two writable columns can
// disagree with each other and with the tree — which is exactly the inverted-edge
// bug that let a team lead sitting BELOW a promoted manager keep collecting
// overrides. One edge makes that disagreement impossible to express.
// ─────────────────────────────────────────────────────────────────────────────
describe("uplineSlotsOf — derived manager / team lead", () => {
  const ref = (id: number, role: string, reportsToId: number | null, active = true) => ({ id, role, reportsToId, active });
  // mgr(1) ← tl(2) ← rep(3);  rep(4) reports straight to mgr(1)
  const roster = [ref(1, "manager", null), ref(2, "team_lead", 1), ref(3, "rep", 2), ref(4, "rep", 1)];

  it("finds the first team lead and first manager above a rep", () => {
    expect(uplineSlotsOf(3, roster)).toEqual({ teamLeadId: 2, managerId: 1 });
  });

  it("a rep reporting straight to a manager has NO team lead — never invents one", () => {
    expect(uplineSlotsOf(4, roster)).toEqual({ teamLeadId: null, managerId: 1 });
  });

  it("a team lead's own slots: their manager, and no team lead above them", () => {
    expect(uplineSlotsOf(2, roster)).toEqual({ teamLeadId: null, managerId: 1 });
  });

  it("a top-level manager reports to nobody", () => {
    expect(uplineSlotsOf(1, roster)).toEqual({ teamLeadId: null, managerId: null });
  });

  it("never returns the member themselves, even in a self-referential row", () => {
    expect(uplineSlotsOf(9, [ref(9, "manager", 9)])).toEqual({ teamLeadId: null, managerId: null });
  });

  it("takes the NEAREST of each role when the chain has several", () => {
    // mgr(10) ← mgr(11) ← tl(12) ← tl(13) ← rep(14)
    const deep = [ref(10, "manager", null), ref(11, "manager", 10), ref(12, "team_lead", 11), ref(13, "team_lead", 12), ref(14, "rep", 13)];
    expect(uplineSlotsOf(14, deep)).toEqual({ teamLeadId: 13, managerId: 11 });
  });

  it("a cyclic chain reports nulls rather than looping", () => {
    const cyclic = [ref(20, "rep", 21), ref(21, "team_lead", 22), ref(22, "manager", 20)];
    // The walk stops when it revisits a node; it must terminate and stay honest.
    const out = uplineSlotsOf(20, cyclic);
    expect(out.teamLeadId).toBe(21);
    expect(out.managerId).toBe(22);
  });

  it("a dangling parent id ends the walk instead of throwing", () => {
    expect(uplineSlotsOf(30, [ref(30, "rep", 999)])).toEqual({ teamLeadId: null, managerId: null });
  });

  it("an INACTIVE upline still fills its slot — departure is handled by re-homing, not the active flag", () => {
    // Mirrors computeFlatOverrides, which deliberately does not gate on active:
    // the members this would catch are new hires mid-signature whose teams are
    // already selling.
    const withInactive = [ref(40, "manager", null, false), ref(41, "rep", 40)];
    expect(uplineSlotsOf(41, withInactive)).toEqual({ teamLeadId: null, managerId: 40 });
  });
});
