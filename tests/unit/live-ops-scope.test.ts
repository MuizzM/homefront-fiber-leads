import { describe, expect, it } from "vitest";
import { liveOpsScope, repInLiveOpsScope, SCOPE_NONE, type ScopeMember } from "../../server/liveOpsScope";

/**
 * A two-branch org with a second-level team lead, one orphan, and an inactive
 * manager - the four shapes that decide this resolver.
 *
 *   Manager A (1)                      Manager B (2)
 *     └ TL A1 (3)                        └ TL B1 (4)
 *         ├ Rep A1a (5)                      └ Rep B1a (7)
 *         ├ Rep A1b (6)
 *         └ TL A2 (8)          ← a lead under a lead
 *             └ Rep A2a (9)
 *   Rep Orphan (10)            ← reports to nobody
 *   Manager C (11, INACTIVE)
 *     └ Rep C1 (12)            ← branch owned by nobody active
 */
const MEMBERS: ScopeMember[] = [
  { id: 1, role: "manager", reportsToId: null, active: true },
  { id: 2, role: "manager", reportsToId: null, active: true },
  { id: 3, role: "team_lead", reportsToId: 1, active: true },
  { id: 4, role: "team_lead", reportsToId: 2, active: true },
  { id: 5, role: "rep", reportsToId: 3, active: true },
  { id: 6, role: "rep", reportsToId: 3, active: true },
  { id: 7, role: "rep", reportsToId: 4, active: true },
  { id: 8, role: "team_lead", reportsToId: 3, active: true },
  { id: 9, role: "rep", reportsToId: 8, active: true },
  { id: 10, role: "rep", reportsToId: null, active: true },
  { id: 11, role: "manager", reportsToId: null, active: false },
  { id: 12, role: "rep", reportsToId: 11, active: true },
];

const sorted = (xs: number[] | null) => (xs === null ? null : [...xs].sort((a, b) => a - b));

describe("admins", () => {
  it("an admin is unrestricted", () => {
    expect(liveOpsScope({ role: "admin", teamMemberId: null }, MEMBERS)).toBeNull();
  });

  it("a super admin is unrestricted even without a roster seat", () => {
    expect(liveOpsScope({ role: "rep", teamMemberId: null, isSuperAdmin: true }, MEMBERS)).toBeNull();
  });
});

describe("a manager sees their branch, and only their branch", () => {
  it("includes every level beneath them, plus themselves", () => {
    expect(sorted(liveOpsScope({ role: "manager", teamMemberId: 1 }, MEMBERS)))
      .toEqual([1, 3, 5, 6, 8, 9]);
  });

  it("EXCLUDES the other manager's people - the gap this resolver exists to close", () => {
    const scope = liveOpsScope({ role: "manager", teamMemberId: 1 }, MEMBERS) as number[];
    for (const otherBranch of [2, 4, 7]) {
      expect(scope).not.toContain(otherBranch);
    }
  });

  it("the second manager sees the mirror image", () => {
    expect(sorted(liveOpsScope({ role: "manager", teamMemberId: 2 }, MEMBERS))).toEqual([2, 4, 7]);
  });

  it("peer managers do not inherit each other, even side by side at the top", () => {
    const a = liveOpsScope({ role: "manager", teamMemberId: 1 }, MEMBERS) as number[];
    const b = liveOpsScope({ role: "manager", teamMemberId: 2 }, MEMBERS) as number[];
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });

  it("an unowned rep belongs to no manager - location fails CLOSED", () => {
    // branchOwnerOf deliberately fails OPEN for roster edits, so an orphan stays
    // adoptable. Watching someone is not editing them: an orphan is visible to
    // admins only until somebody actually owns them.
    for (const id of [1, 2]) {
      expect(liveOpsScope({ role: "manager", teamMemberId: id }, MEMBERS)).not.toContain(10);
    }
  });

  it("an INACTIVE manager's branch is nobody's, not everybody's", () => {
    expect(liveOpsScope({ role: "manager", teamMemberId: 11 }, MEMBERS)).toEqual(SCOPE_NONE);
    expect(liveOpsScope({ role: "manager", teamMemberId: 1 }, MEMBERS)).not.toContain(12);
  });
});

describe("a team lead sees their full subtree", () => {
  it("reaches the second level, not just direct reports", () => {
    // The gap in leadVisibilityScope: rep 9 sits under TL A2, who sits under
    // TL A1. Direct-reports-only would lose them.
    expect(sorted(liveOpsScope({ role: "team_lead", teamMemberId: 3 }, MEMBERS)))
      .toEqual([3, 5, 6, 8, 9]);
  });

  it("a lead under a lead sees only their own slice", () => {
    expect(sorted(liveOpsScope({ role: "team_lead", teamMemberId: 8 }, MEMBERS))).toEqual([8, 9]);
  });

  it("never reaches sideways or upward", () => {
    const scope = liveOpsScope({ role: "team_lead", teamMemberId: 8 }, MEMBERS) as number[];
    expect(scope).not.toContain(3);   // their own lead
    expect(scope).not.toContain(5);   // a sibling's rep
    expect(scope).not.toContain(1);   // the manager
  });
});

describe("everyone else sees themselves", () => {
  it("a rep gets exactly one id", () => {
    expect(liveOpsScope({ role: "rep", teamMemberId: 5 }, MEMBERS)).toEqual([5]);
  });

  it("non-field roles get no widening from this resolver", () => {
    for (const role of ["calling_rep", "calling_manager", "compliance_admin", "auditor"]) {
      expect(liveOpsScope({ role, teamMemberId: 5 }, MEMBERS)).toEqual([5]);
    }
  });

  it("an unknown role is not a free pass", () => {
    expect(liveOpsScope({ role: "wizard", teamMemberId: 5 }, MEMBERS)).toEqual([5]);
  });
});

describe("fails closed", () => {
  it("no roster seat means no scope, for any supervisor role", () => {
    for (const role of ["manager", "team_lead", "rep"]) {
      expect(liveOpsScope({ role, teamMemberId: null }, MEMBERS)).toEqual(SCOPE_NONE);
    }
  });

  it("a null or undefined actor sees nothing", () => {
    expect(liveOpsScope(null, MEMBERS)).toEqual(SCOPE_NONE);
    expect(liveOpsScope(undefined, MEMBERS)).toEqual(SCOPE_NONE);
  });

  it("a seat that no longer exists on the roster resolves to nothing", () => {
    const lone: ScopeMember[] = [{ id: 99, role: "manager", reportsToId: null, active: true }];
    const scope = liveOpsScope({ role: "manager", teamMemberId: 42 }, lone);
    expect(scope).toEqual(SCOPE_NONE);
    // An empty [] would read as "no restriction" to a careless SQL builder.
    expect(scope).not.toEqual([]);
  });

  it("a deactivated member sees nothing, whatever their role says", () => {
    const roster: ScopeMember[] = [
      { id: 20, role: "team_lead", reportsToId: null, active: false },
      { id: 21, role: "rep", reportsToId: 20, active: true },
    ];
    expect(liveOpsScope({ role: "team_lead", teamMemberId: 20 }, roster)).toEqual(SCOPE_NONE);
  });

  it("but an ACTIVE manager with no reports still sees themselves - they work doors too", () => {
    const roster: ScopeMember[] = [{ id: 30, role: "manager", reportsToId: null, active: true }];
    expect(liveOpsScope({ role: "manager", teamMemberId: 30 }, roster)).toEqual([30]);
  });

  it("a reports-to cycle terminates instead of hanging", () => {
    const cyclic: ScopeMember[] = [
      { id: 1, role: "manager", reportsToId: 2, active: true },
      { id: 2, role: "team_lead", reportsToId: 1, active: true },
    ];
    const scope = liveOpsScope({ role: "manager", teamMemberId: 1 }, cyclic);
    expect(Array.isArray(scope) || scope === null).toBe(true);
  });
});

describe("repInLiveOpsScope", () => {
  it("admits anyone for an admin", () => {
    expect(repInLiveOpsScope({ role: "admin", teamMemberId: null }, MEMBERS, 7)).toBe(true);
  });

  it("admits a rep inside the branch and refuses one outside it", () => {
    const mgrA = { role: "manager", teamMemberId: 1 };
    expect(repInLiveOpsScope(mgrA, MEMBERS, 9)).toBe(true);
    expect(repInLiveOpsScope(mgrA, MEMBERS, 7)).toBe(false);
  });

  it("refuses a rep who does not exist", () => {
    expect(repInLiveOpsScope({ role: "manager", teamMemberId: 1 }, MEMBERS, 4242)).toBe(false);
  });

  it("lets a rep read themselves and nobody else", () => {
    expect(repInLiveOpsScope({ role: "rep", teamMemberId: 5 }, MEMBERS, 5)).toBe(true);
    expect(repInLiveOpsScope({ role: "rep", teamMemberId: 5 }, MEMBERS, 6)).toBe(false);
  });
});
