import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let hrStore: typeof import("../../server/onboardingHrStore");
let gusto: typeof import("../../server/gustoAdapter");
let rawDb: import("better-sqlite3").Database;

const TENANT = 1;
const APP = 4242;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-onboarding-hr-"));
  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  hrStore = await import("../../server/onboardingHrStore");
  gusto = await import("../../server/gustoAdapter");
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM rep_hr_checkpoints").run();
});

describe("onboarding HR checkpoint store", () => {
  it("materialises the full ordered gate set for an untouched application", () => {
    const checkpoints = hrStore.listHrCheckpoints(TENANT, APP);
    expect(checkpoints.map(c => c.kind)).toEqual([
      "background_check", "drug_screen", "badge_photo", "gusto",
    ]);
    expect(checkpoints.every(c => c.status === "not_started")).toBe(true);
    expect(checkpoints.every(c => !c.cleared && !c.failed)).toBe(true);
    // No rows are written just by reading.
    expect(rawDb.prepare("SELECT COUNT(*) n FROM rep_hr_checkpoints").get()).toMatchObject({ n: 0 });
  });

  it("upserts idempotently on (application, kind) and stamps timestamps", () => {
    hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "ordered" });
    hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "pending" });
    const passed = hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "passed" });

    const rows = rawDb.prepare("SELECT * FROM rep_hr_checkpoints WHERE application_id = ? AND kind = 'background_check'").all(APP);
    expect(rows.length).toBe(1); // never duplicated
    expect(passed.status).toBe("passed");
    expect(passed.cleared).toBe(true);
    expect(passed.orderedAt).toBeTruthy();   // set when it first left not_started
    expect(passed.completedAt).toBeTruthy(); // set on reaching a terminal state
  });

  it("clears completedAt when a gate moves back out of a terminal state", () => {
    hrStore.setHrCheckpoint(TENANT, APP, "drug_screen", { status: "passed" });
    const reopened = hrStore.setHrCheckpoint(TENANT, APP, "drug_screen", { status: "pending" });
    expect(reopened.completedAt).toBeNull();
    expect(reopened.cleared).toBe(false);
  });

  it("only overwrites optional columns the caller supplies", () => {
    hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "ordered", externalRef: "CHK-1", provider: "checkr" });
    // A status-only update must not wipe the vendor case id / provider.
    const updated = hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "pending" });
    expect(updated.externalRef).toBe("CHK-1");
    expect(updated.provider).toBe("checkr");
    // An explicit null clears it.
    const cleared = hrStore.setHrCheckpoint(TENANT, APP, "background_check", { externalRef: null });
    expect(cleared.externalRef).toBeNull();
  });

  it("summarises required gates and surfaces failures", () => {
    hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "passed" });
    hrStore.setHrCheckpoint(TENANT, APP, "drug_screen", { status: "passed" });
    hrStore.setHrCheckpoint(TENANT, APP, "badge_photo", { status: "approved", badgePhotoPath: "badges/x.png" });
    let summary = hrStore.hrSummary(TENANT, APP);
    expect(summary).toMatchObject({ cleared: 3, total: 4, allClear: false, anyFailed: false });

    hrStore.setHrCheckpoint(TENANT, APP, "gusto", { status: "confirmed", externalRef: "EMP-9" });
    summary = hrStore.hrSummary(TENANT, APP);
    expect(summary).toMatchObject({ cleared: 4, total: 4, allClear: true });

    hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "failed" });
    summary = hrStore.hrSummary(TENANT, APP);
    expect(summary.anyFailed).toBe(true);
    expect(summary.allClear).toBe(false);
  });

  it("treats N/A as cleared so an org can skip a gate deliberately", () => {
    hrStore.setHrCheckpoint(TENANT, APP, "background_check", { status: "na" });
    const checkpoint = hrStore.getHrCheckpoint(APP, "background_check");
    expect(checkpoint.cleared).toBe(true);
    expect(checkpoint.failed).toBe(false);
  });
});

describe("gusto adapter", () => {
  it("is inert without keys and performs no network call", async () => {
    delete process.env.GUSTO_API_TOKEN;
    delete process.env.GUSTO_COMPANY_ID;
    expect(gusto.gustoConfigured()).toBe(false);
    const result = await gusto.verifyGustoConnection();
    expect(result).toMatchObject({ configured: false, ok: false });
  });
});
