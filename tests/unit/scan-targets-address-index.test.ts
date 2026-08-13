// Address lookups must spell the expression the way the index does.
//
// scan_targets carries a UNIQUE EXPRESSION index:
//   idx_scan_targets_addr_city_state ON scan_targets(
//     lower(trim(address)), lower(trim(city)), upper(trim(state)))
//
// SQLite uses an expression index only when the query writes the expression the
// same way. Three hot lookups were one trim() short - `lower(address)=lower(?)`
// - so each full-SCANned scan_targets (919,688 rows in production) instead of
// seeking. All three sit inside per-candidate loops in the discovery engines.
//
// Measured on the real 108,809-row dev table:
//   lower(address)=lower(?)              -> SCAN scan_targets          0.022s
//   lower(trim(address))=lower(trim(?))  -> SEARCH ... COVERING INDEX  0.000s
//
// A fourth site (addressDiscovery/engine.ts, the tenant+city+state lookup) was
// checked and deliberately NOT changed: it already seeks idx_scan_targets_city_state.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

let db: InstanceType<typeof Database>;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE scan_targets (id INTEGER PRIMARY KEY, tenant_id INT, address TEXT, city TEXT, state TEXT, zip TEXT);
    CREATE UNIQUE INDEX idx_scan_targets_addr_city_state
      ON scan_targets(lower(trim(address)), lower(trim(city)), upper(trim(state)));
  `);
  const ins = db.prepare("INSERT INTO scan_targets(tenant_id,address,city,state,zip) VALUES (1,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) ins.run(`${i} Example St`, `City${i % 50}`, "NC", "28001");
  })();
  db.exec("ANALYZE");
});

afterAll(() => db?.close());

const plan = (sql: string) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map(r => r.detail).join("\n");

describe("the expression index is only reachable when spelled identically", () => {
  it("lower(address) misses the index and scans", () => {
    // Pinned so the reason the trim() matters cannot be forgotten and quietly
    // reverted by someone tidying the SQL.
    expect(plan("SELECT id FROM scan_targets WHERE lower(address)=lower('7 Example St') LIMIT 1"))
      .toContain("SCAN scan_targets");
  });

  it("lower(trim(address)) seeks it", () => {
    expect(plan("SELECT id FROM scan_targets WHERE lower(trim(address))=lower(trim('7 Example St')) LIMIT 1"))
      .toContain("USING COVERING INDEX idx_scan_targets_addr_city_state");
  });

  it("both spellings find the same row", () => {
    const a = db.prepare("SELECT id FROM scan_targets WHERE lower(address)=lower(?) LIMIT 1").get("7 Example St");
    const b = db.prepare("SELECT id FROM scan_targets WHERE lower(trim(address))=lower(trim(?)) LIMIT 1").get("7 Example St");
    expect(b).toEqual(a);
  });

  it("the trimmed form additionally matches a padded address, as the unique index intends", () => {
    // Behaviour change, and the correct one: the index treats "  7 Example St "
    // and "7 Example St" as the same target, so a lookup should too.
    const padded = db.prepare("SELECT id FROM scan_targets WHERE lower(trim(address))=lower(trim(?)) LIMIT 1").get("  7 Example St ");
    expect(padded).toBeTruthy();
  });
});

describe("the shipped call sites use the indexed spelling", () => {
  it.each([
    ["server/addressDiscovery/engine.ts", "collision lookup"],
    ["server/clusterExpansion.ts", "idOf"],
    ["server/newBuildRadar.ts", "idStmt"],
  ])("%s (%s)", (path) => {
    const src = readFileSync(join(ROOT, path), "utf8");
    // No bare lower(address) may survive in a scan_targets predicate.
    expect(src).not.toMatch(/WHERE\s+lower\(address\)=/);
    expect(src).toContain("lower(trim(address))=lower(trim(?))");
  });
});
