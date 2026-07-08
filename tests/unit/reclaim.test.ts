import { describe, it, expect } from "vitest";
import {
  reclaimTerritory,
  type TerritoryState,
  type ReclaimMode,
} from "@shared/territory";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (implemented by the LOGIC agent in shared/territory.ts).
 * These tests ARE the spec. reclaimTerritory MUST be a pure function:
 *   reclaimTerritory(state, mode, opts) -> new TerritoryState
 *   - never mutates `state` (input.history/leads/repIds untouched)
 *   - appends exactly ONE history event capturing the prior status/repIds
 *   - the three modes:
 *       "keep_leads"     status -> "reclaimed",  repIds -> [],       leads UNCHANGED
 *       "return_to_pool" status -> "unassigned", repIds -> [],       every enclosed lead.assignedRepId -> null
 *       "reassign"       status -> "shared",     repIds -> [newRepId], every enclosed lead.assignedRepId -> newRepId
 *   - "reassign" REQUIRES opts.newRepId; throws if missing.
 *   - opts.at is an injectable clock (ISO string) for deterministic history.
 * ────────────────────────────────────────────────────────────────────────────
 */

const AT = "2026-07-08T12:00:00.000Z";

function baseState(): TerritoryState {
  return {
    id: 42,
    status: "active",
    repIds: [7, 9], // multi-rep
    color: "#F97316",
    leads: [
      { id: 100, assignedRepId: 7 },
      { id: 101, assignedRepId: 9 },
      { id: 102, assignedRepId: 7 },
    ],
    history: [{ at: "2026-07-01T00:00:00.000Z", action: "created", actorId: 1 }],
  };
}

describe("reclaimTerritory — mode 1: keep_leads", () => {
  it("reclaims the boundary but leaves every lead assigned to its rep", () => {
    const next = reclaimTerritory(baseState(), "keep_leads", { actorId: 1, at: AT });

    expect(next.status).toBe("reclaimed");
    expect(next.repIds).toEqual([]);
    // Leads keep their original rep — pipeline is preserved.
    expect(next.leads.map((l) => l.assignedRepId)).toEqual([7, 9, 7]);
  });

  it("appends exactly one history event recording the prior owners", () => {
    const state = baseState();
    const next = reclaimTerritory(state, "keep_leads", { actorId: 3, at: AT });

    expect(next.history).toHaveLength(state.history.length + 1);
    const event = next.history[next.history.length - 1];
    expect(event.action).toBe("reclaim:keep_leads");
    expect(event.actorId).toBe(3);
    expect(event.at).toBe(AT);
    // Prior state is preserved for the audit trail.
    expect(event.from?.status).toBe("active");
    expect(event.from?.repIds).toEqual([7, 9]);
  });
});

describe("reclaimTerritory — mode 2: return_to_pool (highest risk)", () => {
  it("unassigns every enclosed lead back to the overall pool", () => {
    const next = reclaimTerritory(baseState(), "return_to_pool", { actorId: 1, at: AT });

    expect(next.status).toBe("unassigned");
    expect(next.repIds).toEqual([]);
    // The load-bearing guarantee: all leads returned to pool (assignedRepId null).
    expect(next.leads.every((l) => l.assignedRepId === null)).toBe(true);
  });

  it("returns a territory with NO enclosed leads without error", () => {
    const empty = { ...baseState(), leads: [] };
    const next = reclaimTerritory(empty, "return_to_pool", { actorId: 1, at: AT });
    expect(next.status).toBe("unassigned");
    expect(next.leads).toEqual([]);
  });
});

describe("reclaimTerritory — mode 3: reassign", () => {
  it("transfers the territory and all leads to the new rep", () => {
    const next = reclaimTerritory(baseState(), "reassign", { actorId: 1, newRepId: 12, at: AT });

    expect(next.status).toBe("shared");
    expect(next.repIds).toEqual([12]);
    expect(next.leads.every((l) => l.assignedRepId === 12)).toBe(true);
  });

  it("throws when newRepId is missing (cannot reassign to nobody)", () => {
    expect(() => reclaimTerritory(baseState(), "reassign", { actorId: 1, at: AT })).toThrow();
  });
});

describe("reclaimTerritory — purity guarantees (all modes)", () => {
  const modes: ReclaimMode[] = ["keep_leads", "return_to_pool", "reassign"];

  it.each(modes)("does not mutate the input state (%s)", (mode) => {
    const state = baseState();
    const snapshot = structuredClone(state);
    reclaimTerritory(state, mode, { actorId: 1, newRepId: 12, at: AT });
    expect(state).toEqual(snapshot);
  });
});
