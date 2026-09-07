import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let rawDb: import("better-sqlite3").Database;
let runMigrations: typeof import("../../server/storage").runMigrations;
const COUNT_INDEX = "idx_leads_fresh_confirmed_counts";
const LEGACY_INDEX = "idx_leads_fresh_confirmed";
const countPredicate = "lead_tag='fresh_fiber_confirmed' AND fresh_confidence='cross_verified'";

function countSql(tenantId: number | undefined, scope?: number[]) {
  const wall = tenantId == null ? "1=1" : "tenant_id=?";
  const scoped = scope ? (scope.length ? ` AND assigned_rep_id IN (${scope.map(() => "?").join(",")})` : " AND assigned_rep_id=-1") : "";
  return `SELECT COUNT(*) AS n FROM leads WHERE ${wall}${scoped} AND ${countPredicate}`;
}

function params(tenantId: number | undefined, scope?: number[]) {
  return [...(tenantId == null ? [] : [tenantId]), ...(scope ?? [])];
}

function counts() {
  const cases: [number | undefined, number[] | undefined][] = [
    [1, undefined], [2, undefined], [undefined, undefined],
    [1, [101]], [1, [101, 102]], [1, []], [2, [101]],
  ];
  return cases.map(([tenantId, scope]) => {
    return (rawDb.prepare(countSql(tenantId, scope)).get(...params(tenantId, scope)) as { n: number }).n;
  });
}

function plan(scope?: number[]) {
  return rawDb.prepare(`EXPLAIN QUERY PLAN ${countSql(1, scope)}`).all(...params(1, scope))
    .map((row: any) => String(row.detail)).join("\n");
}

function indexSql(name: string) {
  return (rawDb.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?").get(name) as { sql: string } | undefined)?.sql;
}

function rows() {
  return rawDb.prepare(`SELECT id,tenant_id,assigned_rep_id,lead_tag,fresh_confidence,fresh_confirmed_at
    FROM leads ORDER BY id`).all();
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-dashboard-index-"));
  ({ runMigrations } = await import("../../server/storage"));
  runMigrations();
  ({ rawDb } = await import("../../server/db"));
  const insert = rawDb.prepare(`INSERT INTO leads
    (tenant_id,address,city,state,zip,lat,lng,assigned_rep_id,lead_tag,fresh_confidence,fresh_confirmed_at,created_at,updated_at)
    VALUES (?,?,'Salisbury','NC','28146',35.67,-80.47,?,?,?,?,datetime('now'),datetime('now'))`);
  for (const [i, [tenant, rep, tag, confidence, at]] of [
    [1, 101, "fresh_fiber_confirmed", "cross_verified", null],
    [1, 102, "fresh_fiber_confirmed", "cross_verified", "2026-09-07 10:00:00"],
    [1, null, "fresh_fiber_confirmed", "cross_verified", "2026-09-07 10:00:00"],
    [1, 101, "fresh_fiber_confirmed", "kinetic_new_fiber", "2026-09-07 10:00:00"],
    [1, 101, "other", "cross_verified", "2026-09-07 10:00:00"],
    [2, 201, "fresh_fiber_confirmed", "cross_verified", "2026-09-07 10:00:00"],
    [2, null, "fresh_fiber_confirmed", "cross_verified", null],
  ].entries()) insert.run(tenant, `${100 + i} Sample Drive`, rep, tag, confidence, at);
});

describe("dashboard count index survives historical name ownership", () => {
  it("creates the count index on a fresh database and preserves all scope variants", () => {
    expect(indexSql(COUNT_INDEX)).toContain("ON leads(tenant_id, assigned_rep_id)");
    expect(plan()).toContain(COUNT_INDEX);
    expect(plan([101])).toContain(`COVERING INDEX ${COUNT_INDEX}`);
    expect(plan([101])).toContain("(tenant_id=? AND assigned_rep_id=?)");
    expect(plan([101, 102])).toContain(`COVERING INDEX ${COUNT_INDEX}`);
    expect(counts()).toEqual([3, 2, 5, 1, 2, 0, 0]);
  });

  it("upgrades a database where ranking already owns the legacy index name", async () => {
    rawDb.exec(`DROP INDEX IF EXISTS ${COUNT_INDEX}; DROP INDEX IF EXISTS ${LEGACY_INDEX}`);
    const { rankLeads } = await import("../../server/leadRanking");
    rankLeads(9999, 1); // Actual lazy initializer; no matching rows or provider work.
    const legacy = indexSql(LEGACY_INDEX);
    expect(legacy).toMatch(/fresh_confirmed_at DESC/);
    expect(plan()).not.toContain(COUNT_INDEX);
    const beforeRows = rows();
    const beforeCounts = counts();

    runMigrations();
    runMigrations();

    expect(indexSql(LEGACY_INDEX)).toBe(legacy);
    expect(plan()).toContain(COUNT_INDEX);
    expect(counts()).toEqual(beforeCounts);
    expect(rows()).toEqual(beforeRows);
  });

  it("also upgrades the legacy count definition without dropping either old index", () => {
    rawDb.exec(`DROP INDEX ${COUNT_INDEX}; DROP INDEX ${LEGACY_INDEX};
      CREATE INDEX ${LEGACY_INDEX} ON leads(tenant_id) WHERE ${countPredicate}`);
    const legacy = indexSql(LEGACY_INDEX);
    const before = rows();
    runMigrations();
    expect(indexSql(COUNT_INDEX)).toContain("ON leads(tenant_id, assigned_rep_id)");
    expect(indexSql(LEGACY_INDEX)).toBe(legacy);
    expect(rows()).toEqual(before);
    expect(counts()).toEqual([3, 2, 5, 1, 2, 0, 0]);
    expect(plan([101])).toContain(`COVERING INDEX ${COUNT_INDEX}`);
  });

  it("keeps the dashboard index when ranking initializes after migration, and recovers missing creation on retry", () => {
    rawDb.exec(`DROP INDEX ${LEGACY_INDEX}`);
    const source = readFileSync("server/leadRanking.ts", "utf8");
    const rankingDdl = source.match(/rawDb\.exec\(`(CREATE INDEX IF NOT EXISTS idx_leads_fresh_confirmed\s[\s\S]*?)`\)/)?.[1];
    expect(rankingDdl).toBeTruthy();
    const before = rows();
    rawDb.exec(rankingDdl!);
    expect(indexSql(LEGACY_INDEX)).toMatch(/fresh_confirmed_at DESC/);
    expect(plan()).toContain(COUNT_INDEX);
    // Interrupted migration before this CREATE: the next normal startup must
    // recreate the count index despite the unrelated legacy name existing.
    rawDb.exec(`DROP INDEX ${COUNT_INDEX}`);
    runMigrations();
    expect(plan()).toContain(COUNT_INDEX);
    expect(rows()).toEqual(before);
    expect(counts()).toEqual([3, 2, 5, 1, 2, 0, 0]);
  });
});
