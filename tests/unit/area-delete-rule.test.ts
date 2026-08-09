// ── Deleting an area: which doors lose their rep ─────────────────────────────
//
// THE BUG THIS PINS: an area assigned to a rep, then deleted, used to leave
// every door inside it still assigned to that rep. The area vanished from the
// Area tab while the doors kept behaving as if it existed — on the rep's dialing
// list, in their stats, in their knock sheet — with nothing left on screen to
// explain why.
//
// The rule is stated once, here, as pure functions. server/scanIntelStore's
// set-based UPDATE is the same rule in SQL; tests/integration/
// territory-delete-cleanup.test.ts pins the two together against a real DB.
import { describe, it, expect } from "vitest";
import {
  areaDeleteClearsRep,
  areaGrantedRepIds,
  planAreaDeleteLeads,
  parseAreaDeleteRepPolicy,
  DEFAULT_AREA_DELETE_REP_POLICY,
  type TerritoryLeadRef,
} from "@shared/territory";

const TALAL = 7;
const BO = 8;
const CAM = 9;

describe("areaGrantedRepIds - everyone this area is or was held by (audit, not the delete rule)", () => {
  it("takes the live holder list", () => {
    expect(areaGrantedRepIds({ repId: TALAL, assigneeIds: JSON.stringify([TALAL, BO]) }))
      .toEqual([TALAL, BO]);
  });

  it("INCLUDES past assignees - a keep_leads reclaim empties the live list while the doors still name the rep", () => {
    // reclaimTerritory("keep_leads") → repIds [], leads UNCHANGED, so "who was
    // this area's" is not answerable from assigneeIds alone.
    const ids = areaGrantedRepIds({
      repId: TALAL, assigneeIds: "[]", pastAssigneeIds: JSON.stringify([TALAL]),
    });
    expect(ids).toContain(TALAL);
  });

  it("includes the primary rep_id marker, which outlives the holder list by design", () => {
    expect(areaGrantedRepIds({ repId: TALAL, assigneeIds: "[]" })).toEqual([TALAL]);
  });

  it("dedupes and drops junk rather than trusting the column", () => {
    expect(areaGrantedRepIds({
      repId: TALAL, assigneeIds: JSON.stringify([TALAL, BO, 0, -3]),
      pastAssigneeIds: JSON.stringify([BO, CAM]),
    })).toEqual([TALAL, BO, CAM]);
  });

  it("survives an unparseable or absent column instead of throwing", () => {
    expect(areaGrantedRepIds({ repId: TALAL, assigneeIds: "{not json" })).toEqual([TALAL]);
    expect(areaGrantedRepIds({ repId: null })).toEqual([]);
    expect(areaGrantedRepIds({})).toEqual([]);
  });
});

describe("areaDeleteClearsRep - the per-door rule", () => {
  it("clears a door held by a rep", () => {
    expect(areaDeleteClearsRep({ id: 1, assignedRepId: TALAL })).toBe(true);
  });

  it("clears a door held by a rep who never held the AREA - one rule, no exceptions", () => {
    // An earlier draft spared these. Whether the assignment came through the
    // area or straight from a manager is a distinction the person deleting the
    // area cannot see: deleting is a statement about the ground.
    expect(areaDeleteClearsRep({ id: 2, assignedRepId: CAM })).toBe(true);
  });

  it("leaves an already-unassigned door alone", () => {
    expect(areaDeleteClearsRep({ id: 3, assignedRepId: null })).toBe(false);
  });

  it("policy 'keep' clears nobody - that is the whole point of the escape hatch", () => {
    expect(areaDeleteClearsRep({ id: 1, assignedRepId: TALAL }, "keep")).toBe(false);
  });

  it("defaults to clearing", () => {
    expect(DEFAULT_AREA_DELETE_REP_POLICY).toBe("clear");
    expect(areaDeleteClearsRep({ id: 1, assignedRepId: TALAL })).toBe(true);
  });
});

describe("planAreaDeleteLeads", () => {
  const leads: TerritoryLeadRef[] = [
    { id: 1, assignedRepId: TALAL },
    { id: 2, assignedRepId: TALAL },
    { id: 3, assignedRepId: CAM },
    { id: 4, assignedRepId: null },
  ];

  it("THE REQUIREMENT: every door loses its rep, one rep or several", () => {
    const out = planAreaDeleteLeads(leads);
    expect(out.leads.map(l => l.assignedRepId)).toEqual([null, null, null, null]);
    expect(out.repCleared).toBe(3);
    // Deduped, in the order the doors are listed, so the toast reads the same
    // way twice for the same area.
    expect(out.repIdsCleared).toEqual([TALAL, CAM]);
  });

  it("counts DOORS, not reps", () => {
    // Two of Talal's + one of Cam's = 3 doors, 2 reps named.
    const out = planAreaDeleteLeads(leads);
    expect(out.repCleared).toBe(3);
    expect(out.repIdsCleared).toHaveLength(2);
  });

  it("policy 'keep' is a no-op on the reps", () => {
    const out = planAreaDeleteLeads(leads, "keep");
    expect(out.leads.map(l => l.assignedRepId)).toEqual([TALAL, TALAL, CAM, null]);
    expect(out.repCleared).toBe(0);
    expect(out.repIdsCleared).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input: TerritoryLeadRef[] = [{ id: 1, assignedRepId: TALAL }];
    planAreaDeleteLeads(input);
    expect(input[0].assignedRepId).toBe(TALAL);
  });

  it("an area of unassigned doors clears nothing and names nobody", () => {
    const out = planAreaDeleteLeads([{ id: 1, assignedRepId: null }]);
    expect(out.repCleared).toBe(0);
    expect(out.repIdsCleared).toEqual([]);
  });
});

describe("parseAreaDeleteRepPolicy", () => {
  it("absent → the documented default", () => {
    expect(parseAreaDeleteRepPolicy(undefined)).toBe("clear");
    expect(parseAreaDeleteRepPolicy(null)).toBe("clear");
    expect(parseAreaDeleteRepPolicy("")).toBe("clear");
  });

  it("accepts both explicit values", () => {
    expect(parseAreaDeleteRepPolicy("clear")).toBe("clear");
    expect(parseAreaDeleteRepPolicy("keep")).toBe("keep");
  });

  it("REFUSES anything else rather than falling back - a typo must not mass-unassign", () => {
    for (const bad of ["keeep", "KEEP", "true", 1, {}, ["clear"]]) {
      expect(parseAreaDeleteRepPolicy(bad)).toBeNull();
    }
  });
});
