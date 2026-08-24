import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * STREET OPPORTUNITY.
 *
 * Each test here corresponds to a numbered rule in the module, and each rule
 * exists because the naive version was measured and found wrong. The most
 * important is rule 6: the first ranking recommended eleven streets that were
 * every one of them already assigned to a rep and un-knocked.
 */
let rawDb: import("better-sqlite3").Database;
let rank: typeof import("../../server/streetOpportunity").rankStreetOpportunities;
let normalizeAddress: typeof import("../../server/streetOpportunity").normalizeAddress;
const TENANT = 1;
const NOW = Date.parse("2026-08-24T00:00:00.000Z");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-streetopp-"));
  ({ rawDb } = await import("../../server/db"));
  (await import("../../server/storage")).runMigrations();
  // Dynamic: a static import pulls in server/db before DATA_DIR is set,
  // which opens the real multi-GB database instead of the temp one.
  ({ rankStreetOpportunities: rank, normalizeAddress } = await import("../../server/streetOpportunity"));
});
beforeEach(() => {
  rawDb.prepare("DELETE FROM knock_log").run();
  rawDb.prepare("DELETE FROM leads").run();
  rawDb.prepare("DELETE FROM scan_targets").run();
});

let seq = 0;
function door(o: {
  street?: string; city?: string; house?: number; lat?: number; lng?: number;
  status?: string | null; billing?: string | null; confidence?: string;
  scanned?: boolean; lead?: boolean; assigned?: boolean; knocks?: number;
}): number {
  const id = ++seq + 800_000;
  const street = o.street ?? "Test Rd";
  const city = o.city ?? "Rockwell";
  const address = `${o.house ?? seq * 10} ${street}`;
  rawDb.prepare(
    `INSERT INTO scan_targets (id,tenant_id,address,city,state,zip,lat,lng,source,street_key,
       last_customer_segment,last_customer_confidence,last_billing_status,last_scanned_at,
       last_fiber_status,last_is_new_fiber,last_fiber_available)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, TENANT, address, city, "NC", "28138", o.lat ?? 35.55, o.lng ?? -80.42, "test",
    street.toUpperCase(), "unknown", o.confidence ?? "low", o.billing ?? null,
    o.scanned === false ? null : "2026-08-20T00:00:00.000Z",
    o.status === undefined ? "new_fiber" : o.status,
    o.status === "new_fiber" || o.status === undefined ? 1 : 0,
    o.status === null ? 0 : 1);
  if (o.lead) {
    rawDb.prepare(
      `INSERT INTO leads (address,city,state,zip,lat,lng,lead_status,tenant_id,assigned_rep_id,
         created_at,updated_at)
       VALUES (?,?,?,?,?,?, 'prospect', ?, ?, datetime('now'), datetime('now'))`,
    ).run(address, city, "NC", "28138", o.lat ?? 35.55, o.lng ?? -80.42, TENANT,
      o.assigned ? 1 : null);
    if (o.knocks) {
      const lid = (rawDb.prepare("SELECT id FROM leads ORDER BY id DESC LIMIT 1").get() as any).id;
      for (let i = 0; i < o.knocks; i++) {
        rawDb.prepare(
          `INSERT INTO knock_log (lead_id, rep_id, knocked_at, was_home, outcome, tenant_id)
           VALUES (?,1,?,1,'not_home',?)`).run(lid, "2026-08-21T00:00:00.000Z", TENANT);
      }
    }
  }
  return id;
}
const only = (street: string) =>
  rank(TENANT, { city: "Rockwell", minFreshOpen: 1, nowMs: NOW }).find((r) => r.street === street.toUpperCase());

describe("street opportunity", () => {
  it("runs at all, against the real schema", () => {
    door({});
    expect(() => rank(TENANT, { city: "Rockwell", nowMs: NOW })).not.toThrow();
  });

  it("rule 6: does not count a door that already has an assigned lead as fresh", () => {
    for (let i = 0; i < 4; i++) door({ street: "Mixed Rd", house: 100 + i, lat: 35.55 + i * 0.0005 });
    for (let i = 0; i < 6; i++) door({ street: "Mixed Rd", house: 200 + i, lat: 35.56 + i * 0.0005, lead: true, assigned: true });
    const r = only("Mixed Rd")!;
    expect(r.freshOpen).toBe(4);
    expect(r.dispatched).toBe(6);
  });

  it("rule 2: billing A is taken, billing N at medium confidence is CONFIRMED open", () => {
    door({ street: "Bill Rd", house: 1, billing: "A" });
    door({ street: "Bill Rd", house: 2, billing: "N", confidence: "medium", lat: 35.5501 });
    door({ street: "Bill Rd", house: 3, billing: "N", confidence: "low", lat: 35.5502 });
    const r = only("Bill Rd")!;
    expect(r.open).toBe(2);            // the A door is excluded
    expect(r.freshConfirmed).toBe(1);  // only the medium-confidence one is trusted
  });

  it("rule 3: a TENURED door with no active billing is open, not a customer", () => {
    door({ street: "Ten Rd", house: 1, status: "tenured_fiber", billing: "N" });
    const r = only("Ten Rd")!;
    expect(r.freshOpen).toBe(1);
    expect(r.tenured).toBe(1);
  });

  it("rule 4: the same physical door under two spellings counts once", () => {
    door({ street: "Dup Road", house: 5 });
    door({ street: "Dup Rd", house: 5 });          // same house, spelled out vs abbreviated
    const rows = rank(TENANT, { city: "Rockwell", minFreshOpen: 1, nowMs: NOW });
    const total = rows.reduce((a, r) => a + r.freshOpen, 0);
    expect(total).toBe(1);
  });

  it("rule 8: flags a street whose doors are metres apart as a possible MDU", () => {
    for (let i = 0; i < 6; i++) door({ street: "Tower Ln", house: i, lat: 35.55 + i * 0.00002 });
    expect(only("Tower Ln")!.flags).toContain("possible-MDU");
  });

  it("rule 7: ranks the walkable street above the sprawling one with equal doors", () => {
    for (let i = 0; i < 8; i++) door({ street: "Tight St", house: i, lat: 35.55 + i * 0.0003 });
    for (let i = 0; i < 8; i++) door({ street: "Sprawl Rd", house: i, lat: 35.70 + i * 0.02 });
    const rows = rank(TENANT, { city: "Rockwell", minFreshOpen: 1, nowMs: NOW });
    const tight = rows.findIndex((r) => r.street === "TIGHT ST");
    const sprawl = rows.findIndex((r) => r.street === "SPRAWL RD");
    expect(tight).toBeLessThan(sprawl);
    expect(only("Tight St")!.walkMinutes).toBeLessThan(only("Sprawl Rd")!.walkMinutes);
  });

  it("rule 9: reports coverage and age, and flags a partial street", () => {
    for (let i = 0; i < 3; i++) door({ street: "Half Rd", house: i, lat: 35.55 + i * 0.0003 });
    for (let i = 0; i < 7; i++) door({ street: "Half Rd", house: 50 + i, scanned: false });
    const r = only("Half Rd")!;
    expect(r.scanned).toBe(3);
    expect(r.unscanned).toBe(7);
    expect(r.coveragePct).toBeCloseTo(30, 0);
    expect(r.flags.some((f) => f.startsWith("partial-"))).toBe(true);
  });

  it("counts knocks so an already-worked street is visible", () => {
    for (let i = 0; i < 3; i++) door({ street: "Worked Rd", house: i, lat: 35.55 + i * 0.0003 });
    door({ street: "Worked Rd", house: 99, lat: 35.5510, lead: true, assigned: true, knocks: 4 });
    const r = only("Worked Rd")!;
    expect(r.knocks).toBe(4);
    expect(r.flags.some((f) => f.startsWith("worked-"))).toBe(true);
  });

  it("a door with no fiber is not opportunity", () => {
    for (let i = 0; i < 5; i++) door({ street: "Dead Rd", house: i, status: null, lat: 35.55 + i * 0.0003 });
    expect(only("Dead Rd")).toBeUndefined();
  });

  it("normalizeAddress folds the spellings that caused the duplicates", () => {
    expect(normalizeAddress("123 Organ Church Road")).toBe(normalizeAddress("123 ORGAN CHURCH RD"));
    expect(normalizeAddress("5 Fox St Southwest")).toBe(normalizeAddress("5 FOX ST SW"));
    expect(normalizeAddress("9 Mount Moriah Trail")).toBe(normalizeAddress("9 MT MORIAH TRL"));
  });

  it("rule 5: merging across cities joins a road that spans a city line", () => {
    door({ street: "Shared Rd", city: "Rockwell", house: 1, lat: 35.55 });
    door({ street: "Shared Rd", city: "Concord", house: 2, lat: 35.56 });
    const split = rank(TENANT, { minFreshOpen: 1, nowMs: NOW }).filter((r) => r.street === "SHARED RD");
    const merged = rank(TENANT, { minFreshOpen: 1, mergeAcrossCities: true, nowMs: NOW })
      .filter((r) => r.street === "SHARED RD");
    expect(split.length).toBe(2);
    expect(merged.length).toBe(1);
    expect(merged[0].freshOpen).toBe(2);
  });
});
