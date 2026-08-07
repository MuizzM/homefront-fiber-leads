// Team-hierarchy authority model — the single source of truth for WHO may act
// on WHOM in the field org, shared by the server routes and the client UI so
// the page never offers a kick/edit the API will reject.
//
// The rule is strictly-above: an actor may offboard/reactivate/edit/delete a
// member only when the actor's login role ranks strictly higher than the
// member's field role. Team leads act on reps; managers act on team leads and
// reps; admins act on managers and below. Peers can never remove each other,
// and nobody can act upward. Unknown roles fail closed on both sides.

/** Field-org member roles, lowest to highest. team_members.role only ever
 * holds these three (HIRABLE_ROLES caps creation at manager). */
export const MEMBER_ROLES = ["rep", "team_lead", "manager"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Rank shared by login roles and member roles. Calling/compliance roles are
 * deliberately absent — they have no field-org authority and fail closed. */
const HIERARCHY_RANK: Record<string, number> = {
  rep: 0,
  team_lead: 1,
  manager: 2,
  admin: 3,
  super_admin: 4,
};

export function hierarchyRank(role: string | undefined | null): number | null {
  if (!role) return null;
  const rank = HIERARCHY_RANK[role];
  return rank == null ? null : rank;
}

/**
 * May `actorRole` perform a lifecycle action (offboard, reactivate, delete,
 * edit) on a member whose field role is `targetRole`? Strictly-above only:
 * equal rank (peers) is refused, as is anything upward. Unknown roles on
 * either side refuse.
 */
export function canActOnMember(actorRole: string | undefined | null, targetRole: string | undefined | null): boolean {
  const actor = hierarchyRank(actorRole);
  const target = hierarchyRank(targetRole);
  if (actor == null || target == null) return false;
  return actor > target;
}

/** Which member roles each login role may create or promote to. Mirrors the
 * strictly-above rule: you can only hire people you could also offboard. */
export const HIRABLE_ROLES: Record<string, MemberRole[]> = {
  admin: ["rep", "team_lead", "manager"],
  manager: ["rep", "team_lead"],
  team_lead: ["rep"],
};

export function canHireRole(actorRole: string | undefined | null, memberRole: string | undefined | null): boolean {
  if (!actorRole || !memberRole) return false;
  return (HIRABLE_ROLES[actorRole] ?? []).includes(memberRole as MemberRole);
}

/**
 * Would setting `memberId`'s supervisor to `supervisorId` create a reporting
 * cycle? Pure over an id → reportsToId map so it is unit-testable and cannot
 * touch the DB. Walks upward from the proposed supervisor; if the walk reaches
 * `memberId` the edge closes a loop. A hop budget guards against pre-existing
 * corrupt cycles in the chain (treated as a cycle — fail closed).
 */
export function wouldCreateReportsCycle(
  memberId: number,
  supervisorId: number | null | undefined,
  reportsTo: ReadonlyMap<number, number | null>,
  maxHops = 100,
): boolean {
  if (supervisorId == null) return false;      // top-level — never a cycle
  if (supervisorId === memberId) return true;  // self-report is the trivial cycle
  let cursor: number | null | undefined = supervisorId;
  for (let hop = 0; hop < maxHops; hop++) {
    cursor = reportsTo.get(cursor as number);
    if (cursor == null) return false;          // reached a top-level member
    if (cursor === memberId) return true;      // walked back to the member
  }
  return true; // hop budget exhausted → chain already corrupt → fail closed
}

/** Minimal member shape for downline traversal — id plus the adjacency edge. */
export interface DownlineMemberRef {
  id: number;
  reportsToId: number | null;
}

/**
 * Every member strictly BELOW `rootId` in the reports-to tree (root excluded),
 * in BFS order. The downward mirror of wouldCreateReportsCycle's upward walk:
 * pure over plain member refs, cycle-safe via a visited set, and node-budgeted
 * so corrupt data degrades to a partial result instead of an infinite walk.
 *
 * Contract note for money callers: overrides are computed from this chain as
 * it stands at sale time and frozen onto the ledger row; a promotion or
 * re-home affects only future sales. The recruited_by sponsor edge never
 * drives pay and is not part of this walk.
 */
export function downlineOf(
  rootId: number,
  members: readonly DownlineMemberRef[],
  maxNodes = 5000,
): number[] {
  const children = new Map<number, number[]>();
  for (const m of members) {
    if (m.reportsToId == null) continue;
    const siblings = children.get(m.reportsToId);
    if (siblings) siblings.push(m.id);
    else children.set(m.reportsToId, [m.id]);
  }
  const out: number[] = [];
  const visited = new Set<number>([rootId]);
  const queue: number[] = [rootId];
  while (queue.length > 0 && out.length < maxNodes) {
    const parent = queue.shift() as number;
    for (const child of children.get(parent) ?? []) {
      if (visited.has(child)) continue; // cycle in corrupt data — skip, never loop
      visited.add(child);
      out.push(child);
      queue.push(child);
      if (out.length >= maxNodes) break;
    }
  }
  return out;
}

/** Minimal member shape for the branch-owner walk. */
export interface BranchMemberRef {
  id: number;
  role: string;
  reportsToId: number | null;
  active: boolean;
}

/**
 * The ACTIVE manager at the top of a member's branch, or null when the branch
 * is unowned — a top-level member, an orphan left behind by an offboard, or a
 * member whose only managers above them are inactive.
 *
 * This is what "whose people are these?" means in a single-parent tree, and it
 * is deliberately NOT the same question as `downlineOf`. A subtree test asks
 * "is this member beneath me", which strands every top-level member in nobody's
 * territory; this asks "does this member already belong to a DIFFERENT manager",
 * which leaves unowned members adoptable by anyone senior enough.
 *
 * A member who is themselves an active manager owns their own branch, so peer
 * managers resolve to each other rather than to a shared parent.
 *
 * Hop-budgeted like every walk here: a corrupt chain reads as unowned rather
 * than looping. Unowned fails OPEN (anyone senior may act), which is the whole
 * point — the rule exists to stop poaching between branches, not to make
 * ownerless people unmanageable.
 */
export function branchOwnerOf(
  memberId: number,
  members: readonly BranchMemberRef[],
  maxHops = 100,
): number | null {
  const byId = new Map(members.map(m => [m.id, m]));
  let cursor = byId.get(memberId);
  const seen = new Set<number>();
  for (let hop = 0; hop < maxHops && cursor; hop++) {
    if (seen.has(cursor.id)) return null;   // cycle — unowned, never loop
    seen.add(cursor.id);
    if (cursor.role === "manager" && cursor.active) return cursor.id;
    if (cursor.reportsToId == null) return null;
    cursor = byId.get(cursor.reportsToId);
  }
  return null;
}

/**
 * The first team lead and the first manager strictly ABOVE a member, walking the
 * reports-to chain upward.
 *
 * This is the read-model answer to "who is this person's manager / team lead?" —
 * the pair the spec wants as columns. They are DERIVED, never stored: two
 * writable columns can disagree with each other and with the tree, which is the
 * exact bug an inverted edge caused before (a team lead below a promoted manager
 * still collecting overrides). One parent edge makes disagreement structurally
 * impossible, so the pair is computed from it wherever it is displayed.
 *
 * The one place a derived pair IS frozen is the money row: commission_overrides
 * stores chain_snapshot at earn time, because what a settled week PAID must not
 * move when the tree does. Read models call this; ledgers read their snapshot.
 *
 * Hop-budgeted and cycle-safe like every other walk here — a corrupt chain
 * reports nulls rather than looping. Deliberately NOT gated on `active`, for the
 * same reason computeFlatOverrides is not: a departed leader is already out of
 * the chain (offboard re-homes their reports), while an inactive one is usually
 * a new hire mid-signature whose team is already selling.
 */
export function uplineSlotsOf(
  memberId: number,
  members: readonly BranchMemberRef[],
  maxHops = 100,
): { teamLeadId: number | null; managerId: number | null } {
  const byId = new Map(members.map(m => [m.id, m]));
  const seen = new Set<number>([memberId]);
  let teamLeadId: number | null = null;
  let managerId: number | null = null;
  let cursor = byId.get(memberId)?.reportsToId ?? null;
  for (let hop = 0; hop < maxHops; hop++) {
    if (cursor == null || seen.has(cursor)) break;
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) break;
    if (node.role === "team_lead" && teamLeadId == null) teamLeadId = node.id;
    if (node.role === "manager" && managerId == null) managerId = node.id;
    if (teamLeadId != null && managerId != null) break;
    cursor = node.reportsToId ?? null;
  }
  return { teamLeadId, managerId };
}

/**
 * Is `supervisorRole` a valid supervisor for a member holding `memberRole`?
 * A supervisor must rank strictly above the member (reps report to team
 * leads or managers; team leads report to managers; managers report to
 * nobody but the org itself, i.e. reportsToId null).
 */
export function isValidSupervisorRole(memberRole: string | undefined | null, supervisorRole: string | undefined | null): boolean {
  const member = hierarchyRank(memberRole);
  const supervisor = hierarchyRank(supervisorRole);
  if (member == null || supervisor == null) return false;
  return supervisor > member;
}
