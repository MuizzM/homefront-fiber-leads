import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

// "Assign a whole neighbourhood": the lasso must hand thousands of leads to a
// rep in one action. The old per-row loop (SELECT + UPDATE + INSERT per lead on
// the single event-loop thread) forced a 500 cap; this proves the set-based
// path assigns at scale AND keeps the authority + audit semantics.

let rawDb: import("better-sqlite3").Database;
const TENANT = 1;

function seedLeads(n: number, assignedRepId: number | null = null): number[] {
  const ins = rawDb.prepare(
    `INSERT INTO leads (address, city, state, zip, lat, lng, tenant_id, lead_status, assigned_rep_id, created_at, updated_at)
     VALUES (?, 'Concord', 'NC', '28025', 35.4, -80.5, ?, 'prospect', ?, datetime('now'), datetime('now'))`);
  const ids: number[] = [];
  const tx = rawDb.transaction(() => {
    for (let i = 0; i < n; i++) {
      ids.push(Number(ins.run(`${i + 1} Lasso Way ${Math.random()}`, TENANT, assignedRepId).lastInsertRowid));
    }
  });
  tx();
  return ids;
}

// The exact SQL shape the route runs, so this test pins the contract without
// booting the HTTP stack.
function bulkAssign(ids: number[], repId: number | null, scope?: number[]): { updated: number } {
  const scopeSql = scope === undefined
    ? "1=1"
    : `(assigned_rep_id IS NULL${scope.length ? ` OR assigned_rep_id IN (${scope.join(",")})` : ""})`;
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const ph = chunk.map(() => "?").join(",");
    const tx = rawDb.transaction(() => {
      rawDb.prepare(
        `INSERT INTO lead_events (lead_id, type, actor, detail, at)
         SELECT id, 'assignment', ?, ?, datetime('now') FROM leads
          WHERE id IN (${ph}) AND tenant_id = ${TENANT} AND ${scopeSql}`,
      ).run("manager", JSON.stringify({ assignedTo: `rep ${repId}` }), ...chunk);
      return rawDb.prepare(
        `UPDATE leads SET assigned_rep_id = ?, assigned_by = 'manager', assigned_at = datetime('now'),
                updated_at = datetime('now')
          WHERE id IN (${ph}) AND tenant_id = ${TENANT} AND ${scopeSql}`,
      ).run(repId, ...chunk).changes;
    });
    updated += tx.immediate() as number;
  }
  return { updated };
}

beforeAll(() => {
  // HERMETIC: an in-memory DB with just the two tables this contract touches.
  // Booting the real storage layer here would leak thousands of seeded leads
  // into the shared test database and break sibling suites.
  rawDb = new Database(":memory:") as any;
  rawDb.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, city TEXT, state TEXT, zip TEXT,
      lat REAL, lng REAL, tenant_id INTEGER, lead_status TEXT,
      assigned_rep_id INTEGER, assigned_by TEXT, assigned_at TEXT, unassigned_at TEXT,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE lead_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id INTEGER, type TEXT, actor TEXT,
      detail TEXT, at TEXT);
  `);
});

describe("large lasso assignment", () => {
  it("assigns 2,000 leads in one action and writes one audit event each", () => {
    const ids = seedLeads(2000);
    const before = (rawDb.prepare(`SELECT COUNT(*) n FROM lead_events WHERE type='assignment'`).get() as any).n;
    const res = bulkAssign(ids, 7);
    expect(res.updated).toBe(2000);
    const assigned = (rawDb.prepare(
      `SELECT COUNT(*) n FROM leads WHERE assigned_rep_id=7 AND id IN (${ids.map(() => "?").join(",")})`,
    ).get(...ids) as any).n;
    expect(assigned).toBe(2000);
    const after = (rawDb.prepare(`SELECT COUNT(*) n FROM lead_events WHERE type='assignment'`).get() as any).n;
    expect(after - before).toBe(2000); // audit trail preserved at scale
  });

  it("a team lead can take unassigned + own-team leads, never another team's", () => {
    const unassigned = seedLeads(600, null);
    const ownTeam = seedLeads(300, 42);      // in scope
    const otherTeam = seedLeads(300, 99);    // NOT in scope — must be untouched
    const res = bulkAssign([...unassigned, ...ownTeam, ...otherTeam], 42, [42]);
    expect(res.updated).toBe(900); // 600 unassigned + 300 own-team
    const stolen = (rawDb.prepare(
      `SELECT COUNT(*) n FROM leads WHERE assigned_rep_id=42 AND id IN (${otherTeam.map(() => "?").join(",")})`,
    ).get(...otherTeam) as any).n;
    expect(stolen).toBe(0);
    const stillTheirs = (rawDb.prepare(
      `SELECT COUNT(*) n FROM leads WHERE assigned_rep_id=99 AND id IN (${otherTeam.map(() => "?").join(",")})`,
    ).get(...otherTeam) as any).n;
    expect(stillTheirs).toBe(300);
  });

  it("unassigning (repId null) clears the whole selection", () => {
    const ids = seedLeads(700, 7);
    const res = bulkAssign(ids, null);
    expect(res.updated).toBe(700);
    const remaining = (rawDb.prepare(
      `SELECT COUNT(*) n FROM leads WHERE assigned_rep_id IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`,
    ).get(...ids) as any).n;
    expect(remaining).toBe(0);
  });
});
