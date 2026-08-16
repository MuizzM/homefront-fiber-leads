// The off-host backup must survive the R-tree.
//
// The county E911 import added address_points_rtree (an rtree virtual table),
// and the first scheduled backup after it refused to dump: run 31935060179
// failed with "virtual tables present" and prod went a week with no verified
// off-host copy. The dumper now handles rtree by emitting the CREATE VIRTUAL
// TABLE plus INSERTs of the virtual table's own rows and OMITTING the
// module-managed shadow tables (<name>_node/_rowid/_parent) — on restore the
// module recreates and repopulates them from those INSERTs. What this suite
// pins down:
//
//   1. A dump containing an rtree restores, and the restored rtree answers
//      the app's real viewport JOIN identically — including a degenerate box
//      sitting exactly on a stored float32 coordinate, the case that would
//      catch any precision loss in quote()'s text round-trip.
//   2. Shadow tables stay out of the dump entirely (DDL, rows, rowcount
//      manifest). Dumping them raw would double-create on restore, which is
//      exactly why the dumper used to refuse.
//   3. The workflow verifier's cut restore (stream cut at the post-data-ddl
//      marker + appended COMMIT, per db-backup.yml) still count-verifies —
//      the rtree rows live in the data section, before the cut.
//   4. Only rtree is trusted: FTS and friends still fail loudly, and a table
//      that merely LOOKS like a shadow (foo_node with no virtual table foo)
//      is still backed up.
import Database from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DUMPER = join(__dirname, "..", "..", "scripts", "db-dump-stream.cjs");
const BBOX_JOIN = `
  SELECT p.id FROM address_points_rtree r
  JOIN address_points p ON p.id = r.id
  WHERE r.max_lat >= ? AND r.min_lat <= ? AND r.max_lng >= ? AND r.min_lng <= ?
  ORDER BY p.id`;
const N = 4000;

let dir: string;
let dump: string;
let source: Database.Database;

const bboxIds = (db: Database.Database, s: number, n: number, w: number, e: number) =>
  db.prepare(BBOX_JOIN).raw().all(s, n, w, e).flat();

const rtreeRows = (db: Database.Database) =>
  db.prepare(`SELECT id, min_lat, max_lat, min_lng, max_lng FROM address_points_rtree ORDER BY id`).raw().all();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "dump-rtree-"));
  const src = new Database(join(dir, "source.db"));
  src.exec(`
    CREATE TABLE address_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      street TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL
    );
    CREATE VIRTUAL TABLE address_points_rtree USING rtree(
      id, min_lat, max_lat, min_lng, max_lng
    );
    CREATE INDEX address_points_street ON address_points(street);
    CREATE TABLE foo_node (nodeno INTEGER PRIMARY KEY, data TEXT);
  `);
  const insP = src.prepare(`INSERT INTO address_points (street, lat, lng) VALUES (?,?,?)`);
  const insR = src.prepare(`INSERT INTO address_points_rtree VALUES (?,?,?,?,?)`);
  src.transaction(() => {
    // deterministic spread over an NC-ish extent; enough rows for a multi-level tree
    for (let i = 0; i < N; i++) {
      const lat = 33.8 + ((i * 2654435761) % 100000) / 100000 * 2.8;
      const lng = -84.3 + ((i * 40503) % 100000) / 100000 * 8.9;
      const info = insP.run(`${i} O'Neal St`, lat, lng);
      insR.run(info.lastInsertRowid, lat, lat, lng, lng);
    }
    src.prepare(`INSERT INTO foo_node VALUES (1, 'not a shadow')`).run();
  })();
  source = src;
  dump = execFileSync(process.execPath, [DUMPER, join(dir, "source.db")], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
});

afterAll(() => {
  source?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("db-dump-stream with an rtree virtual table", () => {
  it("dumps instead of refusing, and finishes with the sentinel", () => {
    expect(dump).toContain("CREATE VIRTUAL TABLE address_points_rtree USING rtree");
    expect(dump.trimEnd().endsWith("-- dump-complete")).toBe(true);
  });

  it("keeps every shadow table out of the dump but keeps shadow-named decoys in", () => {
    for (const sfx of ["node", "rowid", "parent"]) {
      expect(dump).not.toContain(`address_points_rtree_${sfx}`);
    }
    expect(dump).toContain("CREATE TABLE foo_node");
    expect(dump).toMatch(/^-- rowcount "foo_node" 1$/m);
  });

  it("manifests the rtree itself, not its shadows", () => {
    expect(dump).toMatch(new RegExp(`^-- rowcount "address_points_rtree" ${N}$`, "m"));
    expect(dump).not.toMatch(/^-- rowcount "address_points_rtree_/m);
  });

  it("restores, and the restored rtree answers the viewport JOIN identically", () => {
    const restored = new Database(join(dir, "restored.db"));
    restored.exec(dump);
    expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(rtreeRows(restored)).toEqual(rtreeRows(source));

    const boxes: Array<[number, number, number, number]> = [
      [34.0, 36.6, -84.3, -75.4], // whole extent
      [35.0, 35.4, -79.5, -78.5], // a viewport
      [10, 11, 10, 11], // empty
    ];
    const p = source.prepare(`SELECT min_lat, min_lng FROM address_points_rtree WHERE id = 123`).get() as any;
    boxes.push([p.min_lat, p.min_lat, p.min_lng, p.min_lng]); // exact float32 boundary
    for (const [s, n, w, e] of boxes) {
      expect(bboxIds(restored, s, n, w, e)).toEqual(bboxIds(source, s, n, w, e));
    }
    expect(bboxIds(restored, p.min_lat, p.min_lat, p.min_lng, p.min_lng)).toContain(123);
    restored.close();
  });

  it("count-verifies through the workflow's cut restore (data only + COMMIT)", () => {
    const cut = dump.slice(0, dump.indexOf("-- section:post-data-ddl")) + "COMMIT;\n";
    const restored = new Database(join(dir, "restored-cut.db"));
    restored.exec(cut);
    for (const m of dump.matchAll(/^-- rowcount "((?:[^"]|"")*)" (\d+)$/gm)) {
      const table = m[1].replace(/""/g, '"');
      const got = restored.prepare(`SELECT count(*) n FROM "${table.replace(/"/g, '""')}"`).get() as any;
      expect(got.n, table).toBe(Number(m[2]));
    }
    expect(rtreeRows(restored)).toEqual(rtreeRows(source));
    restored.close();
  });

  it("still refuses non-rtree virtual tables loudly", () => {
    const ftsPath = join(dir, "fts.db");
    const fts = new Database(ftsPath);
    fts.exec(`CREATE VIRTUAL TABLE notes USING fts5(body)`);
    fts.prepare(`INSERT INTO notes(body) VALUES ('x')`).run();
    fts.close();
    const res = spawnSync(process.execPath, [DUMPER, ftsPath], { encoding: "utf8" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("virtual tables present (notes)");
  });
});
