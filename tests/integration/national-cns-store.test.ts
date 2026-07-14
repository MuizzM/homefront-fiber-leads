import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/nationalCnsStore");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-national-cns-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/nationalCnsStore");
});

describe("national CNS frontier ledger", () => {
  beforeEach(() => {
    rawDb.prepare("DELETE FROM cns_national_frontiers").run();
    store.seedNationalCnsFrontiers();
  });

  it("seeds eight environments covering all 18 states", () => {
    const rows = store.listNationalCnsFrontiers();
    expect(rows).toHaveLength(8);
    expect(new Set(rows.flatMap((row) => row.states.split(", "))).size).toBe(18);
  });

  it("advances only to the highest conclusive checkpoint", () => {
    const before = store.listNationalCnsFrontiers().find((row) => row.environment === "MS")!;
    store.beginNationalEnvironmentRun("MS", before.nextCns - 1_000, before.nextCns + 5_249);
    store.completeNationalEnvironmentRun({ environment: "MS", maxConclusiveCns: before.nextCns + 127, checked: 1_128, hits: 12, confirmed: 2 });
    const after = store.listNationalCnsFrontiers().find((row) => row.environment === "MS")!;
    expect(after.nextCns).toBe(before.nextCns + 128);
    expect(after.totalChecked).toBe(1_128);
    expect(after.totalHits).toBe(12);
    expect(after.totalConfirmed).toBe(2);
    expect(after.lastStatus).toBe("completed");
  });

  it("does not advance the frontier on an inconclusive failed run", () => {
    const before = store.listNationalCnsFrontiers().find((row) => row.environment === "PA")!;
    store.completeNationalEnvironmentRun({ environment: "PA", maxConclusiveCns: null, checked: 20, hits: 0, confirmed: 0, error: "blocked" });
    const after = store.listNationalCnsFrontiers().find((row) => row.environment === "PA")!;
    expect(after.nextCns).toBe(before.nextCns);
    expect(after.lastStatus).toBe("error");
  });
});
