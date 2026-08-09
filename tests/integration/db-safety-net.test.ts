// The safety net under data.db.
//
// This exists because of a real incident: the database FILE was replaced, the
// app recreated it, migrated it, and served a healthy-looking empty portal. The
// properties that matter are the ones that were missing that day:
//
//   1. The tripwire survives the event it detects. A marker stored INSIDE the
//      database would be destroyed by the same thing that destroys the rows, so
//      the high-water mark is a sidecar file — and this suite proves the check
//      still fires after the database is wiped out from under it.
//   2. It stays quiet on a genuinely new install. A guard that cries on every
//      fresh checkout gets ignored, and then it is not a guard.
//   3. The snapshot is CONSISTENT and rotates, and a failure to take one never
//      propagates — a backup is a safety net, not a dependency.
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let safety: typeof import("../../server/dbSafetyNet");
let rawDb: any;
let DATA_DIR: string;

const seed = (leads: number) => {
  rawDb.prepare(`DELETE FROM leads`).run();
  const ins = rawDb.prepare(
    `INSERT INTO leads (address,city,state,zip,lead_status,tenant_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  const now = new Date().toISOString();
  for (let i = 0; i < leads; i++) ins.run(`${i} Net St`, "T", "NC", "27000", "new", 1, now, now);
};

const wipe = () => {
  // Exactly what the incident produced: the business tables empty, everything
  // else (schema, settings) intact.
  for (const t of ["leads", "users", "team_members", "knock_log", "commissions"]) {
    try { rawDb.prepare(`DELETE FROM ${t}`).run(); } catch { /* absent */ }
  }
};

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), "hf-safety-"));
  process.env.DATA_DIR = DATA_DIR;
  // The module must NOT self-disable, which it does under NODE_ENV=test — that
  // guard is what keeps it off the 390-file suite. Here it is the thing under
  // test, so the flag comes off for this file only.
  process.env.NODE_ENV = "development";
  process.env.DB_SNAPSHOT_EVERY_HOURS = "0";   // always due
  process.env.DB_SNAPSHOT_KEEP = "2";

  const storage = await import("../../server/storage");
  storage.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  safety = await import("../../server/dbSafetyNet");
});

afterAll(() => {
  process.env.NODE_ENV = "test";
});

describe("the tripwire", () => {
  it("says nothing on a first-ever boot", () => {
    // No sidecar yet: an empty database here is a new install, not a loss.
    expect(safety.checkForSilentReset().lost).toEqual([]);
  });

  it("records a high-water mark once there is real data", () => {
    seed(120);
    const census = safety.recordWatermark();
    expect(census.leads).toBe(120);

    const mark = JSON.parse(readFileSync(join(DATA_DIR, "backups", "watermark.json"), "utf8"));
    expect(mark.peak.leads).toBe(120);
    expect(typeof mark.at).toBe("string");
  });

  it("keeps the mark at its PEAK, so a legitimate delete cannot lower the bar", () => {
    seed(40);
    safety.recordWatermark();
    const mark = JSON.parse(readFileSync(join(DATA_DIR, "backups", "watermark.json"), "utf8"));
    expect(mark.peak.leads).toBe(120);
  });

  it("fires when the database comes up empty and names what was lost", () => {
    wipe();
    const { lost } = safety.checkForSilentReset();
    expect(lost).toContain("leads");
  });

  it("survives the event it detects - the mark is NOT stored in the database", () => {
    // The whole design point: the database was just emptied, and the evidence
    // that it used to hold 120 leads is still readable.
    const mark = JSON.parse(readFileSync(join(DATA_DIR, "backups", "watermark.json"), "utf8"));
    expect(mark.peak.leads).toBe(120);
    expect(safety.checkForSilentReset().lost).toContain("leads");
  });

  it("goes quiet again once the data is restored", () => {
    seed(120);
    expect(safety.checkForSilentReset().lost).toEqual([]);
  });
});

describe("the snapshot", () => {
  it("writes a consistent copy that opens and holds the same rows", async () => {
    seed(120);
    const path = safety.snapshotIfDue();
    expect(path).toBeTruthy();
    expect(existsSync(path!)).toBe(true);

    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    const copy = new Database(path!, { readonly: true });
    // VACUUM INTO reads inside a transaction, so unlike `cp` it cannot tear.
    expect(copy.pragma("quick_check")[0].quick_check).toBe("ok");
    expect(copy.prepare("SELECT COUNT(*) n FROM leads").get().n).toBe(120);
    copy.close();
  });

  it("rotates, keeping only the configured number", () => {
    // Every one of these must SUCCEED — the point is that rotation trimmed the
    // set, not that the extra writes failed and left it short. Snapshots taken
    // inside the same second used to collide on the filename and error out,
    // which made this assertion pass for entirely the wrong reason.
    const written = [safety.snapshotIfDue(), safety.snapshotIfDue(), safety.snapshotIfDue()];
    expect(written.every(Boolean)).toBe(true);
    expect(new Set(written).size).toBe(3);

    const files = readdirSync(join(DATA_DIR, "backups")).filter(f => f.endsWith(".db"));
    expect(files.length).toBe(2);
    // The survivors are the NEWEST two, not an arbitrary pair.
    expect(files.sort().map(f => join(DATA_DIR, "backups", f))).toEqual(written.slice(1).sort());
  });

  it("refuses to snapshot an empty database, so a blank one cannot rotate out the last good copy", () => {
    const before = readdirSync(join(DATA_DIR, "backups")).filter(f => f.endsWith(".db")).length;
    wipe();
    expect(safety.snapshotIfDue()).toBeNull();
    const after = readdirSync(join(DATA_DIR, "backups")).filter(f => f.endsWith(".db")).length;
    expect(after).toBe(before);
    seed(120);
  });

  it("never throws - a failed backup must not be able to take the app down", () => {
    // A directory where the snapshot file wants to be: VACUUM INTO cannot
    // overwrite, so this is a hard failure inside the module.
    const dir = join(DATA_DIR, "backups");
    for (const f of readdirSync(dir)) if (f.endsWith(".db")) writeFileSync(join(dir, f), "");
    expect(() => safety.snapshotIfDue()).not.toThrow();
  });

  it("stays switched off when the operator says so", () => {
    process.env.DB_SNAPSHOTS = "off";
    expect(safety.snapshotIfDue()).toBeNull();
    expect(safety.installDbSafetyNet(60_000).lost).toEqual([]);
    delete process.env.DB_SNAPSHOTS;
  });
});
