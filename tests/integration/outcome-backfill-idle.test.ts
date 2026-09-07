import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

const source = readFileSync("server/storage.ts", "utf8");
const backfill = source.match(/`(UPDATE leads SET last_outcome_at = \([\s\S]*?)`/)![1];
const opened: Database.Database[] = [];

function fixture() {
  const db = new Database(":memory:");
  opened.push(db);
  db.exec(`CREATE TABLE leads(id INTEGER PRIMARY KEY,tenant_id INTEGER,last_outcome_at TEXT);
    CREATE TABLE knock_log(lead_id INTEGER,knocked_at TEXT);
    CREATE INDEX idx_knock_log_lead_time ON knock_log(lead_id,knocked_at);
    CREATE TABLE written_leads(id INTEGER);
    CREATE TRIGGER track_writes AFTER UPDATE ON leads BEGIN INSERT INTO written_leads VALUES (NEW.id); END;
    INSERT INTO leads VALUES (1,1,NULL),(2,1,NULL),(3,2,NULL),(4,2,'2024-06-01T00:00:00.000Z'),(5,1,NULL);
    INSERT INTO knock_log VALUES
      (2,'2024-01-01T00:00:00.000Z'),(2,'2024-02-01T00:00:00.000Z'),
      (3,'2999-01-01T00:00:00.000Z'),(4,'2025-01-01T00:00:00.000Z'),(5,NULL)`);
  return db;
}

afterEach(() => { for (const db of opened.splice(0)) db.close(); });

describe("outcome-recency startup backfill", () => {
  it("writes only leads with useful missing recency, preserving latest-history and future clamping", () => {
    const db = fixture();
    const before = (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get() as { now: string }).now;
    db.exec(backfill);
    const after = (db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now").get() as { now: string }).now;
    const rows = db.prepare("SELECT last_outcome_at AS at FROM leads ORDER BY id").all() as { at: string | null }[];
    expect(rows[0].at).toBeNull();
    expect(rows[1].at).toBe("2024-02-01T00:00:00.000Z");
    expect(rows[2].at! >= before && rows[2].at! <= after).toBe(true);
    expect(rows[3].at).toBe("2024-06-01T00:00:00.000Z");
    expect(rows[4].at).toBeNull();
    expect(db.prepare("SELECT id FROM written_leads ORDER BY id").all()).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("does no writes on repeated startup but picks up subsequently added historical knocks", () => {
    const db = fixture();
    db.exec(backfill);
    db.exec("DELETE FROM written_leads");
    db.exec(backfill);
    expect(db.prepare("SELECT * FROM written_leads").all()).toEqual([]);
    db.exec("INSERT INTO knock_log VALUES(1,'2024-03-01T00:00:00.000Z')");
    db.exec(backfill);
    expect(db.prepare("SELECT * FROM written_leads").all()).toEqual([{ id: 1 }]);
  });

  it("can retry after an interrupted transaction without losing recency work", () => {
    const db = fixture();
    expect(() => db.transaction(() => { db.exec(backfill); throw new Error("fixture interruption"); })()).toThrow("fixture interruption");
    expect(db.prepare("SELECT * FROM written_leads").all()).toEqual([]);
    db.exec(backfill);
    expect(db.prepare("SELECT id FROM written_leads ORDER BY id").all()).toEqual([{ id: 2 }, { id: 3 }]);
  });
});
