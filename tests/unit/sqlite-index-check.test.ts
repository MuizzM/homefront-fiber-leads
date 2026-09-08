// @vitest-environment node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { indexesInSource, indexConflicts, inspectRepository } from "../../scripts/check-sqlite-indexes";

const ddl = (sql: string) => `db.exec(${JSON.stringify(sql)});`;
const inspect = (sql: string, file = "server/example.ts") => indexesInSource(file, ddl(sql));
const collision = (a: string, b: string) => indexConflicts([...inspect(a).definitions, ...inspect(b, "server/other.ts").definitions]);
const old = "CREATE INDEX IF NOT EXISTS idx_scan_targets_canonical ON scan_targets(tenant_id, canonical_key)";
const promoted = "CREATE UNIQUE INDEX idx_scan_targets_canonical ON scan_targets(tenant_id, canonical_key) WHERE canonical_key IS NOT NULL";

describe("SQLite literal index collision gate", () => {
  it("rejects the historical dashboard/ranking name collision", () => {
    expect(collision(
      "CREATE INDEX IF NOT EXISTS idx_leads_fresh_confirmed ON leads(tenant_id) WHERE lead_tag='fresh_fiber_confirmed'",
      "CREATE INDEX IF NOT EXISTS idx_leads_fresh_confirmed ON leads(fresh_confirmed_at DESC) WHERE fresh_confidence='cross_verified'",
    )[0]).toContain("conflicting SQLite index idx_leads_fresh_confirmed");
  });

  it("accepts equivalent repeated DDL, identifier quoting, comments and main schema", () => {
    expect(collision("CREATE INDEX i ON t(a,b)", 'CREATE INDEX IF NOT EXISTS main."I" ON [T] (`a`, /* why */ b)')).toEqual([]);
  });

  it.each([
    ["(a,b)", "(b,a)"], ["(a)", "(a DESC)"], ["(a COLLATE NOCASE)", "(a)"],
    ["(a) WHERE status='queued'", "(a) WHERE status='QUEUED'"],
    ["(replace(a,'T',' '))", "(replace(a,'t',' '))"],
    ['("a + b")', "(a+b)"], ['("a b")', "(a b)"],
  ])("preserves different keys/expressions/predicates: %s vs %s", (a, b) => {
    expect(collision(`CREATE INDEX i ON t${a}`, `CREATE INDEX i ON t${b}`)).toHaveLength(1);
  });

  it("preserves uniqueness and table ownership", () => {
    expect(collision("CREATE INDEX i ON t(a)", "CREATE UNIQUE INDEX i ON t(a)")).toHaveLength(1);
    expect(collision("CREATE INDEX i ON t(a)", "CREATE INDEX i ON u(a)")).toHaveLength(1);
  });

  it("ignores TS/SQL comments and quoted semicolons while visiting every DDL statement", () => {
    const source = `// CREATE INDEX fake ON t(x)\n${ddl("-- CREATE INDEX also_fake ON t(x);\nCREATE TABLE t(a); CREATE INDEX one ON t(a) WHERE a='x;--''y'; /* ignored; */ CREATE INDEX two ON t(\";\");")}`;
    expect(indexesInSource("server/example.ts", source).definitions.map(d => d.name)).toEqual(["one", "two"]);
  });

  it.each([
    "db.exec(`CREATE INDEX ${name} ON t(a)`)",
    "db.exec(`CREATE INDEX i ON t(a) WHERE status='${status}'`)",
    'db.exec(`CREATE INDEX "idx_${suffix}" ON t(a)`)',
    "db.exec(`CREATE ${unique} INDEX i ON t(a)`)",
    "db.exec(`/* ${text} */ CREATE INDEX i ON t(a)`)",
    'db.exec("CREATE INDEX i ON t(" + columns + ")")',
  ])("rejects dynamic index DDL: %s", source => {
    expect(indexesInSource("server/example.ts", source).errors.length).toBeGreaterThan(0);
  });

  it("checks literal indexes alongside unrelated dynamic table defaults", () => {
    const source = "db.exec(`CREATE TABLE t(a TEXT DEFAULT '${value}'); CREATE INDEX i ON t(a)`);";
    const found = indexesInSource("server/example.ts", source);
    expect(found.errors).toEqual([]);
    expect(found.definitions.map(d => d.name)).toEqual(["i"]);
  });

  it("accepts only the exact owned promotion with parsed DROP before CREATE", () => {
    const base = inspect(old, "server/storage.ts").definitions;
    const valid = inspect(`DROP INDEX IF EXISTS idx_scan_targets_canonical; ${promoted}`, "server/scanTargetCanonicalMerge.ts").definitions;
    expect(indexConflicts([...base, ...valid], true)).toEqual([]);
    for (const sql of [promoted, `${promoted}; DROP INDEX idx_scan_targets_canonical`, `/* DROP INDEX IF EXISTS idx_scan_targets_canonical; ${promoted} */ ${promoted}`]) {
      expect(indexConflicts([...base, ...inspect(sql, "server/scanTargetCanonicalMerge.ts").definitions], true).length).toBeGreaterThan(0);
    }
    expect(indexConflicts([...base, ...valid.map(d => ({ ...d, file: "server/imposter.ts" }))], true).length).toBeGreaterThan(0);
    expect(indexConflicts(base, true)).toContain("canonical-index promotion exception is stale; review and remove/update its exact signatures");
  });

  it("fails the actual CLI when a historical collision is introduced into a clean fixture", () => {
    const root = mkdtempSync(join(tmpdir(), "hf-index-check-"));
    try {
      mkdirSync(join(root, "server"));
      writeFileSync(join(root, "server/storage.ts"), ddl(old));
      writeFileSync(join(root, "server/scanTargetCanonicalMerge.ts"), ddl(`DROP INDEX idx_scan_targets_canonical; ${promoted}`));
      expect(inspectRepository(root).errors).toEqual([]);
      writeFileSync(join(root, "server/dashboard.ts"), ddl("CREATE INDEX idx_leads_fresh_confirmed ON leads(tenant_id)"));
      writeFileSync(join(root, "server/ranking.ts"), ddl("CREATE INDEX idx_leads_fresh_confirmed ON leads(fresh_confirmed_at DESC)"));
      const child = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/check-sqlite-indexes.ts"), root], { encoding: "utf8", timeout: 10_000 });
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("conflicting SQLite index idx_leads_fresh_confirmed");
      expect(child.stderr).toContain("server/dashboard.ts:1");
      expect(child.stderr).toContain("server/ranking.ts:1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
