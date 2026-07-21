import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Boot/crash reconciler: a crash-orphaned operator-ELECTED area scan must be
// terminalized (never auto-resumed), while background market/town harvests and
// still-live elected scans are left untouched. This is the server half of the
// "Scanning fiber never starts on its own on launch" fix.

let rawDb: import("better-sqlite3").Database;
let store: typeof import("../../server/addressDiscovery/store");
const TENANT = 1;

const AREA = {
  type: "Polygon" as const,
  coordinates: [[[-82.081, 35.019], [-82.077, 35.019], [-82.077, 35.023], [-82.081, 35.023], [-82.081, 35.019]]],
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-orphan-terminalize-"));
  ({ rawDb } = await import("../../server/db"));
  const storage = await import("../../server/storage");
  storage.runMigrations();
  store = await import("../../server/addressDiscovery/store");
  rawDb.prepare(`INSERT OR IGNORE INTO users (id,name,email,role,active,tenant_id)
    VALUES (1,'Owner','owner@example.com','admin',1,1)`).run();
});

/** Force a job's heartbeat/status so we can simulate a crash-orphaned scan. */
function setJob(id: string, status: string, heartbeat: string | null) {
  rawDb
    .prepare(`UPDATE discovery_jobs SET status=?, heartbeat_at=${heartbeat === null ? "NULL" : "datetime('now', ?)"} WHERE id=?`)
    .run(...(heartbeat === null ? [status, id] : [status, heartbeat, id]));
}

function make(input: { key: string; geometry?: any; townName?: string }) {
  const { job } = store.createDiscoveryJob({
    tenantId: TENANT,
    idempotencyKey: input.key,
    requestHash: `${input.key}-hash`,
    geometry: input.geometry ?? null,
    townName: input.townName ?? null,
    state: "SC",
    createdBy: 1,
  });
  return job;
}

describe("terminalizeOrphanedElectedJobs — a stale elected box is a zombie, not permission to restart", () => {
  it("terminalizes ONLY the crash-orphaned elected scan; leaves background/town/live jobs alone", () => {
    const electedStale = make({ key: "elected-stale", geometry: AREA });
    const electedFresh = make({ key: "elected-fresh", geometry: AREA });
    const townBackground = make({ key: "town-bg", townName: "Concord" }); // no geometry, town-keyed
    const hotBurst = make({ key: "hot:inman:sc:2026-07-21T14", geometry: AREA, townName: "Inman" });

    // All four "running", but only electedStale + townBackground + hotBurst are stale.
    setJob(electedStale.id, "running", "-30 minutes");
    setJob(electedFresh.id, "running", "-30 seconds"); // a live worker is on it
    setJob(townBackground.id, "running", "-30 minutes");
    setJob(hotBurst.id, "running", "-30 minutes");

    const n = store.terminalizeOrphanedElectedJobs({ staleMinutes: 5 });
    expect(n).toBe(1); // exactly the orphaned elected scan

    const status = (id: string) =>
      (rawDb.prepare(`SELECT status FROM discovery_jobs WHERE id=?`).get(id) as any).status;

    expect(status(electedStale.id)).toBe("failed"); // terminalized
    expect(status(electedFresh.id)).toBe("running"); // live worker untouched
    expect(status(townBackground.id)).toBe("running"); // background harvest resumes normally
    expect(status(hotBurst.id)).toBe("running"); // market burst resumes normally

    // The terminalized elected scan no longer appears in the active feed, so it
    // can never light up "Scanning fiber" on the next launch.
    const active = store.listDiscoveryJobs(TENANT, { activeOnly: true }).map((j) => j.id);
    expect(active).not.toContain(electedStale.id);
    expect(active).toContain(electedFresh.id);

    // A record of WHY it stopped is left for the audit trail.
    const events = store
      .readDiscoveryEvents({ tenantId: TENANT, after: 0, jobId: electedStale.id })
      .filter((e) => e.eventType === "job.interrupted");
    expect(events.length).toBe(1);
    expect(events[0].payload?.reason).toBe("server_restart");
  });

  it("is a no-op when nothing is orphaned (idempotent across repeated boots)", () => {
    expect(store.terminalizeOrphanedElectedJobs({ staleMinutes: 5 })).toBe(0);
  });
});
