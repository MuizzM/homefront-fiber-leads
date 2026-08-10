// ── Who may see whose location ───────────────────────────────────────────────
//
// The app already has two different answers to "which reps may this supervisor
// see", and they disagree:
//
//   leadVisibilityScope (routes.ts:569)  team_lead → DIRECT REPORTS ONLY,
//                                        manager   → the entire tenant
//   readScope (commissionRoutes.ts:29)   team_lead → full subtree,
//                                        manager   → org-wide by capability
//
// Neither is right for a live map. The first hands any manager the real-time
// position of every rep in the org, including branches they have nothing to do
// with; the second strands a team lead's second-level reports.
//
// This resolver takes the third option, which is what "authorized teams"
// actually means in a single-parent tree: a manager sees THEIR BRANCH. That is
// `branchOwnerOf` - the same primitive the roster already uses to stop managers
// poaching each other's people (actorMayReachBranch, routes.ts:5592). Applying
// it to location reads says the same thing about watching that the app already
// says about editing: other managers' people are not yours.
//
// Return contract matches the house convention exactly, so call sites read the
// same as every other scoped query:
//     null      no restriction (admin, super_admin)
//     number[]  exactly these team_members.id
//     [-1]      nothing - the fail-closed sentinel

import { branchOwnerOf, downlineOf } from "@shared/teamHierarchy";

export interface ScopeMember {
  id: number;
  role: string;
  reportsToId: number | null;
  active: boolean;
}

export interface ScopeActor {
  role?: string | null;
  teamMemberId?: number | null;
  isSuperAdmin?: boolean | null;
}

/** The sentinel the rest of the codebase uses for "matches nothing". */
export const SCOPE_NONE: number[] = [-1];

/**
 * The set of team member ids whose live location `user` may read.
 *
 * Fails closed everywhere it is uncertain: an unknown role, a supervisor with
 * no roster seat, a corrupt reports-to chain. A supervisor who sees nothing
 * files a support ticket; a supervisor who sees another branch's movements is a
 * privacy incident nobody notices.
 */
export function liveOpsScope(
  user: ScopeActor | null | undefined,
  members: readonly ScopeMember[],
): number[] | null {
  const role = user?.role ?? "";
  if (user?.isSuperAdmin || role === "admin" || role === "super_admin") return null;

  const self = user?.teamMemberId ?? null;
  // A supervisor with no seat on the roster has no branch and no reports. There
  // is no safe way to guess what they should see.
  if (self == null) return SCOPE_NONE;

  // The seat must actually exist and be active. A deactivated member is not in
  // the field, and a teamMemberId pointing at a deleted row is corrupt state -
  // neither should resolve to "at least yourself". This also matters for
  // managers specifically: branchOwnerOf only ever returns an ACTIVE manager,
  // so a deactivated one owns nothing and would otherwise fall through to a
  // self-only scope that quietly looks like a working account.
  const seat = members.find((m) => m.id === self);
  if (!seat || !seat.active) return SCOPE_NONE;

  if (role === "manager") {
    // Everyone whose branch this manager owns, plus the manager themselves.
    // branchOwnerOf walks UP to the first active manager, so peer managers
    // resolve to each other rather than to a shared parent - two managers under
    // one director do not inherit each other's reps.
    const owned = members
      .filter((m) => branchOwnerOf(m.id, members) === self)
      .map((m) => m.id);
    return dedupe([self, ...owned]);
  }

  if (role === "team_lead") {
    // The full subtree, not just direct reports: a team lead with a lead under
    // them is still accountable for that second level, and the money surfaces
    // already take this reading.
    return dedupe([self, ...downlineOf(self, members)]);
  }

  // Reps, and every non-field role (calling, compliance, auditor): themselves
  // only. Non-field roles are additionally blocked by capability before they
  // reach here; this is the second lock.
  return [self];
}

/** True when `repId` is inside the caller's scope. */
export function repInLiveOpsScope(
  user: ScopeActor | null | undefined,
  members: readonly ScopeMember[],
  repId: number,
): boolean {
  const scope = liveOpsScope(user, members);
  return scope === null || scope.includes(repId);
}

function dedupe(ids: number[]): number[] {
  const out = [...new Set(ids)];
  return out.length > 0 ? out : SCOPE_NONE;
}
