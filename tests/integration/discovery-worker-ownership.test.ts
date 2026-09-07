// @vitest-environment node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
const mocks = vi.hoisted(()=>({boundary:vi.fn(),tile:vi.fn(),orphans:vi.fn()}));
vi.mock("../../server/addressDiscovery/store",async original => ({
  ...await original<typeof import("../../server/addressDiscovery/store")>(),
  claimBoundaryJob:mocks.boundary,claimNextTile:mocks.tile,terminalizeOrphanedElectedJobs:mocks.orphans,
}));
let engine: typeof import("../../server/addressDiscovery/engine");
let db: import("better-sqlite3").Database;
beforeAll(async()=>{
  process.env.DATA_DIR=mkdtempSync(join(tmpdir(),"hf-discovery-ownership-"));
  (await import("../../server/storage")).runMigrations();
  db=(await import("../../server/db")).rawDb;
  engine=await import("../../server/addressDiscovery/engine");
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllTimers();vi.useRealTimers();});
it("HTTP wake, resume and startup never claim provider work or acquire the writer",async()=>{
  vi.useFakeTimers();vi.stubEnv("SCAN_WORKERS","4");vi.stubEnv("HF_ROLE","scan");vi.stubEnv("SCAN_CONSUME_ROLE","control");
  db.pragma("query_only = 1");
  try {
    engine.wakeDiscoveryWorkers();engine.startDiscoveryWorkers();engine.resumeDiscoveryJobs();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.boundary).not.toHaveBeenCalled();expect(mocks.tile).not.toHaveBeenCalled();expect(mocks.orphans).not.toHaveBeenCalled();
  } finally {db.pragma("query_only = 0");}
});
it.each([
  ["control","4","control"], ["scan","4","all"], ["scan","1","control"], ["","0","control"],
])("%s with %s workers and %s consumption still wakes eligible work",async(role,workers,consume)=>{
  vi.stubEnv("SCAN_WORKERS",workers);vi.stubEnv("HF_ROLE",role);vi.stubEnv("SCAN_CONSUME_ROLE",consume);
  engine.wakeDiscoveryWorkers();await new Promise(resolve=>setImmediate(resolve));
  expect(mocks.boundary).toHaveBeenCalledTimes(1);expect(mocks.tile).toHaveBeenCalledTimes(1);
});
