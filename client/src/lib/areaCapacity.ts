// Active areas per rep — the load number RepPicker renders and the max-areas
// cap is enforced against. Counted ONCE over the territory list instead of
// re-scanning it per rep (the picker previously did territories.filter inside
// team.map AND JSON.parsed assigneeIds per pair: O(reps × areas) parses on the
// phone, mid-tap). Shared by the Field Map and the Area Console so the two
// assignment surfaces can never disagree about who is loaded — AreaDetail used
// to pass no capacity data at all, so the picker's whole reason to exist
// ("never hand a sixth area to someone at the cap") silently didn't apply on
// one of the two primary surfaces, and the mistake surfaced as a server 409
// after the tap instead of a disabled row before it.
import { MAX_ACTIVE_AREAS_PER_REP } from "@shared/territory";

export interface CapacityTerritory {
  status?: string | null;
  repId?: number | null;
  assigneeIds?: string | null;
}

/** Areas each rep currently holds (active/shared only). Pass
 *  `excludeTerritoryId` when the question is "can they take THIS area" — the
 *  server's cap check excludes it too, so re-assigning ground a rep already
 *  holds is never refused as a sixth area. */
export function activeAreaCountsByRep(
  territories: readonly CapacityTerritory[],
  excludeTerritoryId?: number,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of territories as any[]) {
    if (t.status !== "active" && t.status !== "shared") continue;
    if (excludeTerritoryId != null && t.id === excludeTerritoryId) continue;
    const seen = new Set<number>();
    if (t.repId != null) seen.add(t.repId);
    try {
      for (const id of JSON.parse(t.assigneeIds || "[]") as number[]) seen.add(id);
    } catch { /* legacy row */ }
    // A rep on an area as both primary and assignee still holds ONE area.
    for (const id of seen) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** The same tallies as a plain record — RepPicker's areaCounts prop shape. */
export function areaCountsRecord(counts: Map<number, number>): Record<number, number> {
  const rec: Record<number, number> = {};
  for (const [id, n] of counts) rec[id] = n;
  return rec;
}

export function repAtCap(counts: Map<number, number>, repId: number): boolean {
  return (counts.get(repId) ?? 0) >= MAX_ACTIVE_AREAS_PER_REP;
}
