// Map performance and the honest-window contract at realistic scale.
//
// The brief's hard requirement is that the browser never downloads all of
// North Carolina. Two mechanisms enforce that, and both are tested here:
//
//   1. Every read is bbox-bounded and index-backed. A statewide query must not
//      degrade into a table scan, so the plans are asserted directly - a
//      dropped index shows up as a failing test rather than as a slow map in
//      the field six weeks later.
//
//   2. An over-cap window returns NO pins plus the true count, never a thinned
//      sample. The field map already learned this the hard way on the lead
//      layer (a city window silently shipped 13,945 of 27,898 pins and the
//      cluster counts summed the sample), so this layer refuses to ship a
//      sample at all.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let store: typeof import("../../server/kineticBuildStore");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
/** Enough rows that an accidental table scan is measurably slower than an
 *  index range scan, while keeping the suite fast. */
const ROWS = 40_000;
/** Roughly the seven-county bounding box. */
const STATE_WINDOW = { minLat: 35.0, maxLat: 36.2, minLng: -81.2, maxLng: -79.8 };
/** About a neighbourhood. */
const STREET_WINDOW = { minLat: 35.400, maxLat: 35.404, minLng: -80.600, maxLng: -80.596 };

const CLASSES = ["confirmed_2026", "likely_2026", "existing_fiber", "reported_2026", "unverified"] as const;
const COUNTIES = ["37025", "37159", "37119", "37057", "37097", "37167", "37179"];

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-k2026perf-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  store = await import("../../server/kineticBuildStore");

  const insert = rawDb.prepare(`
    INSERT INTO kinetic_build_state (
      tenant_id, canonical_key, address, city, state, zip, county_fips, block_geoid,
      lat, lng, classification, confidence, quarter_when_proven, last_verified_at, residential
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
  `);
  rawDb.transaction(() => {
    for (let i = 0; i < ROWS; i++) {
      const classification = CLASSES[i % CLASSES.length];
      // A dense core around the street window plus a wide statewide spread, so
      // the two windows exercise genuinely different selectivities.
      const dense = i % 20 === 0;
      const lat = dense ? 35.400 + (i % 40) * 0.0001 : 35.0 + (i % 1200) * 0.001;
      const lng = dense ? -80.600 + (i % 40) * 0.0001 : -81.2 + (i % 1400) * 0.001;
      insert.run(
        TENANT, `perf-key-${i}`, `${i} Perf St`, "Concord", "NC", "28025",
        COUNTIES[i % COUNTIES.length], `37025040100${String(i % 1000).padStart(4, "0")}`,
        lat, lng, classification,
        classification === "confirmed_2026" ? "high" : "low",
        classification === "confirmed_2026" && i % 3 === 0 ? "2026Q2" : null,
        i % 4 === 0 ? new Date(Date.now() - 5 * 86_400_000).toISOString() : null,
      );
    }
  })();
});

/** The query planner's opinion, which is the thing that actually decides
 *  whether the field map is fast. */
function planFor(sql: string, params: unknown[]): string {
  return (rawDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((r) => r.detail).join(" | ");
}

/** SQLite says "USING INDEX x" or "USING COVERING INDEX x" depending on
 *  whether the index alone can answer the query. Covering is the better
 *  outcome, so both count - the thing being asserted is that the named index
 *  was chosen at all, not which flavour of use it got. */
const usesIndex = (name: string) => new RegExp(`USING (?:COVERING )?INDEX ${name}`);

describe("index usage", () => {
  it("answers a bbox window from an index, never a full scan", () => {
    const plan = planFor(
      `SELECT s.id FROM kinetic_build_state s LEFT JOIN leads l ON l.id = s.lead_id
        WHERE s.tenant_id = ? AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?`,
      [TENANT, STREET_WINDOW.minLat, STREET_WINDOW.maxLat, STREET_WINDOW.minLng, STREET_WINDOW.maxLng],
    );
    expect(plan).toMatch(usesIndex("idx_kbs"));
    expect(plan).not.toMatch(/SCAN kinetic_build_state(?! USING)/);
  });

  it("answers a classification-filtered window from the composite index", () => {
    const plan = planFor(
      `SELECT s.id FROM kinetic_build_state s
        WHERE s.tenant_id = ? AND s.classification = ? AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?`,
      [TENANT, "confirmed_2026", STREET_WINDOW.minLat, STREET_WINDOW.maxLat, STREET_WINDOW.minLng, STREET_WINDOW.maxLng],
    );
    expect(plan).toMatch(usesIndex("idx_kbs_class_bbox"));
  });

  it("keeps the canonical-key lookup unique", () => {
    const plan = planFor(
      `SELECT id FROM kinetic_build_state WHERE tenant_id = ? AND canonical_key = ?`, [TENANT, "perf-key-1"],
    );
    expect(plan).toMatch(/uq_kbs_canonical/);
  });
});

describe("street-level windows stay small and fast", () => {
  it("returns a neighbourhood's worth of pins, not the state", () => {
    const pins = store.buildWindowPins(TENANT, STREET_WINDOW);
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.length).toBeLessThan(ROWS / 10);
    for (const pin of pins) {
      expect(pin.lat).toBeGreaterThanOrEqual(STREET_WINDOW.minLat);
      expect(pin.lat).toBeLessThanOrEqual(STREET_WINDOW.maxLat);
    }
  });

  it("serves a street window far faster than the same query unindexed", () => {
    // RELATIVE, not absolute. An absolute millisecond bound fails whenever the
    // suite runs this file alongside others on a loaded machine - it measures
    // the CI box, not the code. Timing the identical query with the index
    // suppressed makes both halves absorb the same load, so what is left is
    // the thing actually under test: the index is present and being used.
    const bbox = [STREET_WINDOW.minLat, STREET_WINDOW.maxLat, STREET_WINDOW.minLng, STREET_WINDOW.maxLng];
    const indexed = rawDb.prepare(
      `SELECT COUNT(*) n FROM kinetic_build_state s
        WHERE s.tenant_id = ? AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?`,
    );
    const scanned = rawDb.prepare(
      `SELECT COUNT(*) n FROM kinetic_build_state s NOT INDEXED
        WHERE s.tenant_id = ? AND s.lat BETWEEN ? AND ? AND s.lng BETWEEN ? AND ?`,
    );
    // Same answer either way - otherwise the comparison is meaningless.
    expect((indexed.get(TENANT, ...bbox) as any).n).toBe((scanned.get(TENANT, ...bbox) as any).n);

    const time = (stmt: typeof indexed) => {
      stmt.get(TENANT, ...bbox);                       // warm
      const started = process.hrtime.bigint();
      for (let i = 0; i < 10; i++) stmt.get(TENANT, ...bbox);
      return Number(process.hrtime.bigint() - started) / 1e6 / 10;
    };
    const indexedMs = time(indexed);
    const scannedMs = time(scanned);
    // A neighbourhood is a tiny slice of 40k rows, so the index should win by
    // a wide margin. 3x is loose enough to survive a noisy box and tight
    // enough that a dropped index fails it.
    expect(scannedMs / Math.max(indexedMs, 0.001)).toBeGreaterThan(3);
  });
});

describe("the honest-window contract", () => {
  it("never thins an over-cap window into a sample", () => {
    const total = store.buildWindowCount(TENANT, STATE_WINDOW);
    expect(total).toBeGreaterThan(store.BUILD_WINDOW_ROW_CAP);

    // The store caps rows; the ROUTE is what refuses to ship them. Assert the
    // store cannot exceed the cap, and that the count is the TRUE total rather
    // than the capped one - shipping a capped count is how a sampled map ends
    // up reporting confident, wrong totals.
    const pins = store.buildWindowPins(TENANT, STATE_WINDOW);
    expect(pins.length).toBeLessThanOrEqual(store.BUILD_WINDOW_ROW_CAP);
    expect(total).toBeGreaterThan(pins.length);
  });

  it("the grid tier reports EXACT counts over the same predicate", () => {
    const total = store.buildWindowCount(TENANT, STATE_WINDOW);
    const cells = store.buildGrid(TENANT, { ...STATE_WINDOW, cell: 0.05 }, 20_000);
    expect(cells.reduce((n, c) => n + c.count, 0)).toBe(total);
  });

  it("keeps grid and pin filters in agreement, so zooming never changes the truth", () => {
    const filters = { classifications: ["confirmed_2026"] as const, counties: ["37025"] };
    const count = store.buildWindowCount(TENANT, { ...STATE_WINDOW, ...filters });
    const cells = store.buildGrid(TENANT, { ...STATE_WINDOW, ...filters, cell: 0.05 }, 20_000);
    expect(cells.reduce((n, c) => n + c.count, 0)).toBe(count);
    // And the confirmed tally within the grid matches the classification count.
    expect(cells.reduce((n, c) => n + c.confirmed, 0)).toBe(count);
  });

  it("aggregates the whole state quickly", () => {
    const started = process.hrtime.bigint();
    store.buildGrid(TENANT, { ...STATE_WINDOW, cell: 0.05 }, 20_000);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(400);
  });
});

describe("filters narrow the SQL, not the response", () => {
  it("a county filter reduces the true count, not just the shipped rows", () => {
    const all = store.buildWindowCount(TENANT, STATE_WINDOW);
    const one = store.buildWindowCount(TENANT, { ...STATE_WINDOW, counties: ["37025"] });
    expect(one).toBeLessThan(all);
    expect(one).toBeGreaterThan(0);
  });

  it("stacks classification, county and quarter", () => {
    const stacked = store.buildWindowCount(TENANT, {
      ...STATE_WINDOW, classifications: ["confirmed_2026"], counties: ["37025"], quarters: ["2026Q2"],
    });
    const looser = store.buildWindowCount(TENANT, { ...STATE_WINDOW, classifications: ["confirmed_2026"] });
    expect(stacked).toBeLessThan(looser);
    const pins = store.buildWindowPins(TENANT, {
      ...STATE_WINDOW, classifications: ["confirmed_2026"], counties: ["37025"], quarters: ["2026Q2"], limit: 500,
    });
    expect(pins.every((p) => p.quarter === "2026Q2" && p.classification === "confirmed_2026")).toBe(true);
  });

  it("bounds a hostile filter list rather than expanding the IN clause without limit", () => {
    // 40 values max per list (routes cap it); the store must handle the cap
    // without building a pathological query.
    const many = Array.from({ length: 40 }, (_, i) => `3712${String(i).padStart(1, "0")}`);
    expect(() => store.buildWindowCount(TENANT, { ...STATE_WINDOW, counties: many })).not.toThrow();
  });
});
