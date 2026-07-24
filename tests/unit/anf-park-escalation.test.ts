import { describe, expect, it } from "vitest";
import {
  INCONCLUSIVE_GIVEUP, ANF_PARK_MAX_GENERATIONS,
  anfParkGeneration, anfQuietDaysFor, anfParkedSql,
} from "../../shared/scanPolicy";

// The top measured production waste (2026-07-24): 285,723 parked
// address_not_found addresses re-entered the scan rotation together every 14
// days under a FLAT window — 333,187 parked-skips vs 9,320 real dedup-skips in
// two hours, 170,777 enqueues for 1,836 checks. The window now escalates per
// park generation and goes terminal at the cap.

describe("park generation + escalating quiet window", () => {
  it("generation advances only past the give-up threshold", () => {
    expect(anfParkGeneration(INCONCLUSIVE_GIVEUP)).toBe(0);
    expect(anfParkGeneration(INCONCLUSIVE_GIVEUP + 1)).toBe(1);
    expect(anfParkGeneration(INCONCLUSIVE_GIVEUP + 3)).toBe(3);
    expect(anfParkGeneration(0)).toBe(0); // never negative
  });

  it("quiet window doubles per generation and caps", () => {
    expect(anfQuietDaysFor(INCONCLUSIVE_GIVEUP, 14)).toBe(14);
    expect(anfQuietDaysFor(INCONCLUSIVE_GIVEUP + 1, 14)).toBe(28);
    expect(anfQuietDaysFor(INCONCLUSIVE_GIVEUP + 2, 14)).toBe(56);
    expect(anfQuietDaysFor(INCONCLUSIVE_GIVEUP + 3, 14)).toBe(112);
    // capped — never grows past the generation cap
    expect(anfQuietDaysFor(INCONCLUSIVE_GIVEUP + 9, 14)).toBe(14 * 2 ** ANF_PARK_MAX_GENERATIONS);
  });

  it("the shared SQL predicate is alias-parameterized and terminal past the cap", () => {
    const sql = anfParkedSql("st", 14);
    expect(sql).toContain("st.last_scanned_at IS NULL");
    expect(sql).toContain("st.inconclusive_attempts");
    // terminal branch: attempts beyond GIVEUP+cap never re-enter the rotation
    expect(sql).toContain(`st.inconclusive_attempts >= ${INCONCLUSIVE_GIVEUP + ANF_PARK_MAX_GENERATIONS + 1}`);
    // escalating branch present
    expect(sql).toContain("<<");
  });
});

describe("SQL predicate evaluates correctly in SQLite", () => {
  it("parks by generation: gen-0 ages in at 14d, gen-2 does not until 56d", async () => {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE st (id INTEGER PRIMARY KEY, last_scanned_at TEXT,
      inconclusive_attempts INTEGER, last_inconclusive_at TEXT)`);
    const ins = db.prepare(`INSERT INTO st (id,last_scanned_at,inconclusive_attempts,last_inconclusive_at)
      VALUES (?,NULL,?,datetime('now', ?))`);
    ins.run(1, INCONCLUSIVE_GIVEUP, "-20 days");      // gen 0, 20d old → aged in
    ins.run(2, INCONCLUSIVE_GIVEUP + 2, "-20 days");  // gen 2 (56d) → still parked
    ins.run(3, INCONCLUSIVE_GIVEUP + 2, "-60 days");  // gen 2, 60d old → aged in
    ins.run(4, INCONCLUSIVE_GIVEUP + 9, "-900 days"); // terminal → parked forever
    const parked = db.prepare(`SELECT id FROM st WHERE ${anfParkedSql("st", 14)} ORDER BY id`)
      .all().map((r: any) => r.id);
    expect(parked).toEqual([2, 4]);
    // A conclusively-scanned address is never "parked" regardless of history.
    db.prepare(`UPDATE st SET last_scanned_at=datetime('now') WHERE id=2`).run();
    const after = db.prepare(`SELECT id FROM st WHERE ${anfParkedSql("st", 14)} ORDER BY id`)
      .all().map((r: any) => r.id);
    expect(after).toEqual([4]);
    db.close();
  });
});
