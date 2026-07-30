// "This lead has no rep assigned" — the dead end, closed.
//
// The map routes a manager's direct status tap to the CENTRAL mark exactly
// when the knock path has nobody to credit: resolveCreditedRepId() === null.
// These cases pin that predicate so the routing can't silently widen (a
// field manager with a linked profile must keep self-crediting) or narrow
// (Central Admin must never see the error toast again).
import { describe, expect, it } from "vitest";
import { resolveCreditedRepId } from "../../client/src/features/knocking/savedKnockReconciliation";

describe("who gets credited — the central-routing predicate", () => {
  it("Central Admin (no linked profile) on an UNASSIGNED lead → nobody to credit → central mark", () => {
    expect(resolveCreditedRepId({ id: 1, role: "admin", teamMemberId: null } as any, null)).toBeNull();
    expect(resolveCreditedRepId({ id: 1, role: "super_admin", teamMemberId: null } as any, null)).toBeNull();
  });

  it("a manager on an ASSIGNED lead credits the assigned rep — never central-routed", () => {
    expect(resolveCreditedRepId({ id: 1, role: "manager", teamMemberId: null } as any, 42)).toBe(42);
  });

  it("a field manager WITH a linked profile self-credits on an unassigned door", () => {
    expect(resolveCreditedRepId({ id: 1, role: "manager", teamMemberId: 7 } as any, null)).toBe(7);
  });

  it("a rep always credits themselves, never the assigned rep", () => {
    expect(resolveCreditedRepId({ id: 1, role: "rep", teamMemberId: 9 } as any, 42)).toBe(9);
  });
});
