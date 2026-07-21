import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-neardup-"));
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "r", queued: 0, budget: 0 })) }));

let rawDb: any, findNearDuplicateLeads: any, houseNumberOf: any;
const TENANT = 1;

beforeAll(async () => {
  ({ rawDb } = await import("../../server/db"));
  ({ findNearDuplicateLeads, houseNumberOf } = await import("../../server/leadDedupAudit"));
  rawDb.exec(`DROP TABLE IF EXISTS leads;
    CREATE TABLE leads (id INTEGER PRIMARY KEY, tenant_id INTEGER, address TEXT, lat REAL, lng REAL, canonical_key TEXT);`);
  const L = (id: number, addr: string, lat: number, lng: number, key: string | null) =>
    rawDb.prepare("INSERT INTO leads (id,tenant_id,address,lat,lng,canonical_key) VALUES (?,?,?,?,?,?)")
      .run(id, TENANT, addr, lat, lng, key);
  // 1 & 2: SAME premise, geocoder drift (~8 m apart), same house number, DIFFERENT keys → flag.
  L(1, "123 Oak Cir", 35.500000, -80.500000, "123 OAK CIR|X|NC|28110");
  L(2, "123 Oak Circle Lot 4", 35.500050, -80.500040, "123 OAK CIRCLE LOT 4|X|NC|28110");
  // 3: neighbouring DIFFERENT house ~8 m from #1 → must NOT flag (different house number).
  L(3, "125 Oak Cir", 35.500050, -80.499960, "125 OAK CIR|X|NC|28110");
  // 4: same house number as #1 but far away (~150 m) → not flagged (beyond threshold).
  L(4, "123 Oak Cir", 35.501400, -80.500000, "123 OAK CIR|Y|NC|28111");
  // 5 & 6: identical canonical key (already one identity) → never flagged.
  L(5, "9 Elm St", 35.400000, -80.400000, "9 ELM ST|X|NC|28110");
  L(6, "9 Elm St", 35.400030, -80.400000, "9 ELM ST|X|NC|28110");
  // 7: missing coordinates → skipped gracefully.
  L(7, "123 Oak Cir", null as any, null as any, "123 OAK CIR NW|X|NC|28110");
});

describe("geospatial near-duplicate DETECTION (never deletes)", () => {
  it("flags a same-premise pair: tight proximity + shared house number + different keys", () => {
    const pairs = findNearDuplicateLeads(TENANT, { maxMeters: 12 });
    const hit = pairs.find((p: any) => p.aId === 1 && p.bId === 2);
    expect(hit).toBeTruthy();
    expect(hit.houseNumber).toBe("123");
    expect(hit.meters).toBeLessThanOrEqual(12);
  });

  it("does NOT flag a distinct neighbouring house (different house number)", () => {
    const pairs = findNearDuplicateLeads(TENANT, { maxMeters: 12 });
    expect(pairs.some((p: any) => p.aId === 3 || p.bId === 3)).toBe(false);
  });

  it("does NOT flag same house number beyond the distance threshold", () => {
    const pairs = findNearDuplicateLeads(TENANT, { maxMeters: 12 });
    expect(pairs.some((p: any) => p.aId === 4 || p.bId === 4)).toBe(false);
  });

  it("does NOT flag rows that already share a canonical key", () => {
    const pairs = findNearDuplicateLeads(TENANT, { maxMeters: 50 });
    expect(pairs.some((p: any) => (p.aId === 5 && p.bId === 6))).toBe(false);
  });

  it("skips rows without coordinates or a house number, and never mutates leads", () => {
    const before = rawDb.prepare("SELECT COUNT(*) c FROM leads").get().c;
    const pairs = findNearDuplicateLeads(TENANT, { maxMeters: 12 });
    expect(pairs.some((p: any) => p.aId === 7 || p.bId === 7)).toBe(false); // no coords
    expect(rawDb.prepare("SELECT COUNT(*) c FROM leads").get().c).toBe(before); // detection only
  });

  it("houseNumberOf extracts the leading house number", () => {
    expect(houseNumberOf("123 N Main St")).toBe("123");
    expect(houseNumberOf("  742 Evergreen Rd")).toBe("742");
    expect(houseNumberOf("Main St")).toBe("");
    expect(houseNumberOf(null)).toBe("");
  });
});
