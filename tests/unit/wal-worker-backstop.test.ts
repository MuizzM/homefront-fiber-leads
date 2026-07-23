import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dedicated-checkpointer architecture: a CLUSTER WORKER connection (HF_ROLE is
// set only by the cluster fork) must NOT auto-checkpoint at the busy 4000-page
// cadence — constant worker autocheckpoints hold the checkpoint lock and
// starve the primary guard's TRUNCATE (observed live 2026-07-23: guard
// returned busy:1 while the WAL grew past 800MB). Workers keep only a large
// backstop so the WAL stays bounded even if the primary dies.

beforeAll(() => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-wal-backstop-"));
  process.env.HF_ROLE = "scan"; // simulate a cluster worker BEFORE importing db
});

afterAll(() => {
  // process.env is per worker PROCESS while module registries are per FILE —
  // a leaked HF_ROLE would silently flip role-gated behavior in later files.
  delete process.env.HF_ROLE;
});

describe("cluster-worker WAL autocheckpoint backstop", () => {
  it("worker connections use the large backstop, not the 4000-page cadence", async () => {
    const db = await import("../../server/db");
    const pages = db.rawDb.pragma("wal_autocheckpoint", { simple: true });
    expect(pages).toBe(250_000);
  });
});
