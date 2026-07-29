// Who held this area, who put them there, and who took them off.
//
// territories.assignee_ids answers "who holds it now" and stays authoritative
// for visibility. It cannot answer anything else: a JSON array of ids has no
// room for who assigned the rep, when, or at whose instruction — which are
// exactly the questions asked when an area goes wrong.
//
// These specs pin the durability rules, and they are DATABASE triggers rather
// than code conventions specifically so they hold against a writer that does not
// know about them — including a hand-run UPDATE in a console.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let store: typeof import("../../server/territoryAssignments");
let rawDb: import("better-sqlite3").Database;

const T = 900;          // a territory id; nothing else in this file uses it
const ACTOR = 11;       // the manager doing the assigning

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-terr-assign-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/territoryAssignments");
  store.ensureTerritoryAssignmentSchema();
});

afterAll(() => { /* temp DATA_DIR is disposable */ });

let seq = 0;
const area = () => T + ++seq;   // one fresh area per test — no cross-talk

describe("recording who holds an area", () => {
  it("records the rep, the actor, and when", () => {
    const t = area();
    const { created } = store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    expect(created).toBe(true);

    const [row] = store.activeAssignments(t);
    expect(row).toMatchObject({ territoryId: t, repId: 5, assignedByUserId: ACTOR, unassignedAt: null });
    expect(row.assignedAt).toBeTruthy();
  });

  it("marks the primary distinctly from a supporting rep", () => {
    // The map label follows the primary; the others share the same ground.
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 6], actorUserId: ACTOR, primaryRepId: 5 });
    const roles = Object.fromEntries(store.activeAssignments(t).map((a) => [a.repId, a.roleInTerritory]));
    expect(roles).toEqual({ 5: "primary", 6: "assignee" });
  });

  it("is idempotent — a double-submitted assign does not create two live claims", () => {
    // This is the partial unique index doing the work, not a check-then-insert,
    // so two concurrent requests cannot both pass the check.
    const t = area();
    expect(store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR }).created).toBe(true);
    expect(store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR }).created).toBe(false);
    expect(store.activeAssignments(t)).toHaveLength(1);
  });
});

describe("removal closes the record, it does not erase it", () => {
  it("closes only the named rep and leaves the others holding the area", () => {
    // Acceptance: three reps share an area, one is removed, two keep working.
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 6, 7], actorUserId: ACTOR });
    expect(store.closeAssignment({ territoryId: t, repId: 6, actorUserId: ACTOR, reason: "Area rotation" })).toBe(true);

    expect(store.activeAssignments(t).map((a) => a.repId)).toEqual([5, 7]);
  });

  it("keeps the closed row, with who removed them and why", () => {
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    store.closeAssignment({ territoryId: t, repId: 5, actorUserId: 99, reason: "Left the team" });

    const [row] = store.assignmentHistory(t);
    expect(row).toMatchObject({ repId: 5, unassignedByUserId: 99, reason: "Left the team" });
    expect(row.unassignedAt).toBeTruthy();
    expect(row.assignedByUserId).toBe(ACTOR); // the original fact survives removal
  });

  it("reports false when the rep was already removed, rather than throwing", () => {
    // Removing twice is an ordinary double-tap, not an error.
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    expect(store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR })).toBe(true);
    expect(store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR })).toBe(false);
  });

  it("reports false for a rep who never held the area", () => {
    expect(store.closeAssignment({ territoryId: area(), repId: 404, actorUserId: ACTOR })).toBe(false);
  });

  it("counts only the reps actually removed on a full pull-back", () => {
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 6], actorUserId: ACTOR });
    store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR });

    // 5 is already gone — "removed 2 reps" would be a lie.
    expect(store.closeAllAssignments(t, ACTOR, "Area completed")).toEqual([6]);
    expect(store.activeAssignments(t)).toEqual([]);
  });

  it("lets a rep hold the same area again later, as a separate tenure", () => {
    // Re-assignment inserts a NEW row rather than re-opening the old one, so
    // "held it twice" stays visible instead of looking like one long stretch.
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR });
    expect(store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR }).created).toBe(true);

    expect(store.activeAssignments(t)).toHaveLength(1);
    expect(store.assignmentHistory(t)).toHaveLength(2);
  });
});

describe("the database refuses to let history be rewritten", () => {
  it("refuses to DELETE an assignment", () => {
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    expect(() => rawDb.prepare("DELETE FROM territory_assignments WHERE territory_id = ?").run(t))
      .toThrow(/append-only/i);
    expect(store.activeAssignments(t)).toHaveLength(1);
  });

  it("refuses to edit a CLOSED assignment", () => {
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR });
    const id = store.assignmentHistory(t)[0].id;

    expect(() => rawDb.prepare("UPDATE territory_assignments SET reason='rewritten' WHERE id=?").run(id))
      .toThrow(/immutable/i);
  });

  it("refuses to re-open a closed assignment by clearing unassigned_at", () => {
    // The tempting shortcut, and the one that would erase a tenure boundary.
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR });
    const id = store.assignmentHistory(t)[0].id;

    expect(() => rawDb.prepare("UPDATE territory_assignments SET unassigned_at=NULL WHERE id=?").run(id))
      .toThrow(/immutable/i);
  });

  it("refuses to rewrite who was assigned, or by whom, on an OPEN row", () => {
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    const id = store.activeAssignments(t)[0].id;

    expect(() => rawDb.prepare("UPDATE territory_assignments SET rep_id=6 WHERE id=?").run(id))
      .toThrow(/immutabl/i);
    expect(() => rawDb.prepare("UPDATE territory_assignments SET assigned_by_user_id=999 WHERE id=?").run(id))
      .toThrow(/immutabl/i);
  });

  it("still allows the one legitimate update — closing an open row", () => {
    // The rules must not be so tight that removal itself is impossible.
    const t = area();
    store.openAssignment({ tenantId: 1, territoryId: t, repId: 5, actorUserId: ACTOR });
    expect(() => store.closeAssignment({ territoryId: t, repId: 5, actorUserId: ACTOR })).not.toThrow();
  });
});

describe("reconciling with the holder list", () => {
  it("opens the newly added and closes the newly removed", () => {
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 6], actorUserId: ACTOR });
    const delta = store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [6, 7], actorUserId: ACTOR });

    expect(delta.opened).toEqual([7]);
    expect(delta.closed).toEqual([5]);
    expect(store.activeAssignments(t).map((a) => a.repId).sort()).toEqual([6, 7]);
  });

  it("does nothing when the list is unchanged", () => {
    // Called on every write, so a no-op has to be genuinely free of side effects
    // — otherwise ordinary saves would churn the history.
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 6], actorUserId: ACTOR });
    const before = store.assignmentHistory(t).length;

    const delta = store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [6, 5], actorUserId: ACTOR });
    expect(delta).toEqual({ opened: [], closed: [] });
    expect(store.assignmentHistory(t)).toHaveLength(before);
  });

  it("empties the record when the area is pulled back entirely", () => {
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 6], actorUserId: ACTOR });
    const delta = store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [], actorUserId: ACTOR });

    expect(delta.closed.sort()).toEqual([5, 6]);
    expect(store.activeAssignments(t)).toEqual([]);
    expect(store.assignmentHistory(t)).toHaveLength(2); // the tenures survive
  });

  it("ignores ids that cannot be a rep instead of recording them", () => {
    const t = area();
    store.syncAssignments({ tenantId: 1, territoryId: t, repIds: [5, 0, -1, NaN as any], actorUserId: ACTOR });
    expect(store.activeAssignments(t).map((a) => a.repId)).toEqual([5]);
  });
});

// ── The record follows the holder list through the real routes ───────────────
// The two stores must never disagree. assignee_ids is authoritative for
// visibility; this record carries the facts around it. They are kept in step at
// the storage choke point rather than at each of the seven routes that write the
// array, because hooking seven places eventually misses one — and a missed path
// is exactly how they would silently drift apart.
describe("assignee_ids and the record stay in step", () => {
  it("records the holders when an area is created with a list", async () => {
    const mod = await import("../../server/storage");
    const t = mod.storage.createTerritory({
      tenantId: 1, name: "Choke point A", repId: 5,
      polygon: JSON.stringify([[0, 0], [1, 0], [1, 1]]),
      color: "#14C985", status: "active", assigneeIds: JSON.stringify([5, 6]),
    } as any);

    expect(store.activeAssignments(t.id).map((a) => a.repId).sort()).toEqual([5, 6]);
  });

  it("follows a holder-list change made through updateTerritory", async () => {
    const mod = await import("../../server/storage");
    const t = mod.storage.createTerritory({
      tenantId: 1, name: "Choke point B", repId: 5,
      polygon: JSON.stringify([[0, 0], [1, 0], [1, 1]]),
      color: "#14C985", status: "active", assigneeIds: JSON.stringify([5, 6]),
    } as any);

    mod.storage.updateTerritory(t.id, { assigneeIds: JSON.stringify([6, 7]) } as any);

    expect(store.activeAssignments(t.id).map((a) => a.repId).sort()).toEqual([6, 7]);
    // 5's tenure is closed, not erased.
    const closed = store.assignmentHistory(t.id).filter((a) => a.unassignedAt != null);
    expect(closed.map((a) => a.repId)).toEqual([5]);
  });

  it("empties the record when the area is pulled back through storage", async () => {
    const mod = await import("../../server/storage");
    const t = mod.storage.createTerritory({
      tenantId: 1, name: "Choke point C", repId: 5,
      polygon: JSON.stringify([[0, 0], [1, 0], [1, 1]]),
      color: "#14C985", status: "active", assigneeIds: JSON.stringify([5, 6]),
    } as any);

    mod.storage.updateTerritory(t.id, { assigneeIds: JSON.stringify([]), status: "unassigned" } as any);

    expect(store.activeAssignments(t.id)).toEqual([]);
    expect(store.assignmentHistory(t.id)).toHaveLength(2); // both tenures survive
  });

  it("leaves the record alone when the write did not touch the holder list", async () => {
    // A rename or recolour must not churn assignment history.
    const mod = await import("../../server/storage");
    const t = mod.storage.createTerritory({
      tenantId: 1, name: "Choke point D", repId: 5,
      polygon: JSON.stringify([[0, 0], [1, 0], [1, 1]]),
      color: "#14C985", status: "active", assigneeIds: JSON.stringify([5]),
    } as any);
    const before = store.assignmentHistory(t.id).length;

    mod.storage.updateTerritory(t.id, { name: "Renamed", color: "#F97316" } as any);

    expect(store.assignmentHistory(t.id)).toHaveLength(before);
    expect(store.activeAssignments(t.id).map((a) => a.repId)).toEqual([5]);
  });
});
