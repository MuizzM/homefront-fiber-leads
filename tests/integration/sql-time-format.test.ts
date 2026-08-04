// ── ISO columns must not be compared against datetime() ─────────────────────
//
// SQLite compares TEXT lexicographically. 'T' (0x54) sorts after ' ' (0x20),
// so an ISO timestamp is ALWAYS "greater" than a SQLite-format timestamp that
// shares its date — regardless of the actual time of day.
//
// `leads.created_at` is written by JS as ISO. Every freshness window that
// compared it to `datetime('now','-N days')` therefore ran up to 24 hours wide
// at its boundary, silently treating day-old-plus leads as fresh.
//
// These tests run against real SQLite rather than asserting on strings, because
// the bug lives in the comparison semantics, not in our formatting.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { isoDaysAgo, isoHoursAgo } from "../../server/sqlTime";

let rawDb: any;
let storage: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-sqltime-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
});

const q = (sql: string, ...args: any[]) => rawDb.prepare(sql).get(...args);

describe("the mixed-format comparison bug", () => {
  it("reproduces it: datetime() wrongly admits an ISO row from earlier on the boundary day", () => {
    const threshold = q("SELECT datetime('now','-7 days') AS t").t as string;
    // 00:30 on the boundary date is ~7.5 days old — outside a 7-day window.
    const tooOld = `${threshold.slice(0, 10)}T00:30:00.000Z`;
    expect(q("SELECT (? >= ?) AS r", tooOld, threshold).r).toBe(1);      // the bug
    expect(q("SELECT (julianday(?) >= julianday(?)) AS r", tooOld, threshold).r).toBe(0);  // the truth
  });

  it("isoDaysAgo agrees with chronological order on both sides of the boundary", () => {
    const iso = q(`SELECT ${isoDaysAgo(7)} AS t`).t as string;
    const day = iso.slice(0, 10);
    expect(q("SELECT (? >= ?) AS r", `${day}T00:30:00.000Z`, iso).r).toBe(0);   // earlier that day → out
    expect(q("SELECT (? >= ?) AS r", `${day}T23:30:00.000Z`, iso).r).toBe(1);   // later that day  → in
  });

  it("emits the same shape JS toISOString() does — the two must sort together", () => {
    const iso = q(`SELECT ${isoDaysAgo(0)} AS t`).t as string;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(iso).toHaveLength(new Date().toISOString().length);
  });

  it("orders a real leads row against the threshold the way the clock does", () => {
    const lead = storage.createLead({
      address: "1 Freshness Way", city: "Rockwell", state: "NC", zip: "28138",
      lat: 35.5, lng: -80.4, fiberStatus: "fiber", leadStatus: "prospect", tenantId: 1,
    });
    const row = q("SELECT created_at AS c FROM leads WHERE id = ?", lead.id);
    // Pins the premise the whole fix rests on: this column really is ISO.
    expect(row.c).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    // A brand-new lead is inside every window, and outside a negative-width one.
    expect(q(`SELECT (? >= ${isoDaysAgo(7)}) AS r`, row.c).r).toBe(1);
    expect(q(`SELECT (? >= ${isoHoursAgo(0)}) AS r`, row.c).r).toBe(0);
  });

  it("refuses a non-integer offset rather than interpolating it into SQL", () => {
    expect(() => isoDaysAgo(1.5)).toThrow(/integer/);
    expect(() => isoDaysAgo(-1)).toThrow(/integer/);
    expect(() => isoDaysAgo("7 days'); DROP TABLE leads;--" as any)).toThrow(/integer/);
  });
});
