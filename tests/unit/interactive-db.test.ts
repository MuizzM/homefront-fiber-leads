// @vitest-environment node
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { interactiveTransaction, withoutSqliteBusyWait } from "../../server/interactiveDb";

describe("interactive SQLite transactions", () => {
  it("retries contention after rolling back partial work and commits only once", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE records (id INTEGER)");
    let attempts = 0;
    try {
      await interactiveTransaction(db, () => {
        db.exec("INSERT INTO records VALUES (1)");
        if (++attempts === 1) throw Object.assign(new Error("fixture lock conflict"), { code: "SQLITE_BUSY" });
      });
      expect(attempts).toBe(2);
      expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 1 }]);
    } finally { db.close(); }
  });
  it("restores the connection timeout after success and failure and rolls back partial work", async () => {
    const db = new Database(":memory:");
    db.pragma("busy_timeout = 120000");
    db.exec("CREATE TABLE records (id INTEGER)");
    try {
      expect(withoutSqliteBusyWait(db, () => db.pragma("busy_timeout", { simple: true }))).toBe(0);
      let attempts = 0;
      await expect(interactiveTransaction(db, () => {
        attempts++;
        db.exec("INSERT INTO records VALUES (1)");
        throw new Error("fixture constraint failure");
      })).rejects.toThrow("fixture constraint failure");
      expect(attempts).toBe(1);
      expect(db.prepare("SELECT * FROM records").all()).toEqual([]);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(120000);
      await interactiveTransaction(db, () => db.exec("INSERT INTO records VALUES (2)"));
      expect(db.prepare("SELECT * FROM records").all()).toEqual([{ id: 2 }]);
    } finally { db.close(); }
  });
});
