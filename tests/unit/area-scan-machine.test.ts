import { describe, it, expect } from "vitest";
import {
  areaScanReducer, IDLE, toPersisted, persistedRunningIsStale, STALE_RUNNING_MS,
  type AreaScanState, type PersistedScan,
} from "../../client/src/lib/areaScanMachine";

const at = 1_000_000_000_000;
const run = (over: Partial<AreaScanState> = {}): AreaScanState =>
  ({ status: "running", jobId: "job1", boxKey: "b1", startedAt: at, found: 0, checked: 0, error: null, ...over });

describe("area scan machine — only an explicit election starts a scan", () => {
  it("COLD LAUNCH: hydrate with no persisted scan → idle (never auto-starts)", () => {
    expect(areaScanReducer(IDLE, { type: "HYDRATE", persisted: null, now: at })).toEqual(IDLE);
  });

  it("navigation/remount/foreground = another mount → still idle with no persisted scan", () => {
    // A remount just replays HYDRATE; without a persisted running scan it is idle.
    const s = areaScanReducer(run(), { type: "HYDRATE", persisted: null, now: at });
    expect(s.status).toBe("idle");
  });

  it("START (box election) is the ONLY path into running", () => {
    const s = areaScanReducer(IDLE, { type: "START", boxKey: "b1", at });
    expect(s).toMatchObject({ status: "running", boxKey: "b1", startedAt: at, jobId: null });
  });

  it("ATTACH records the owned jobId once the server accepts", () => {
    let s = areaScanReducer(IDLE, { type: "START", boxKey: "b1", at });
    s = areaScanReducer(s, { type: "ATTACH", jobId: "job1" });
    expect(s.jobId).toBe("job1");
  });

  it("REPEATED TAPS: a second START while running is ignored (one scan at a time)", () => {
    let s = areaScanReducer(IDLE, { type: "START", boxKey: "b1", at });
    s = areaScanReducer(s, { type: "ATTACH", jobId: "job1" });
    const again = areaScanReducer(s, { type: "START", boxKey: "b2", at: at + 5 });
    expect(again).toBe(s); // unchanged — no duplicate concurrent scan
  });
});

describe("area scan machine — only the OWNED job drives the indicator", () => {
  it("ignores JOB_UPDATE for a different (background/stale) job", () => {
    const s = run();
    expect(areaScanReducer(s, { type: "JOB_UPDATE", jobId: "OTHER", active: true })).toBe(s);
  });

  it("an active update for the owned job keeps it running and updates counts", () => {
    const s = areaScanReducer(run(), { type: "JOB_UPDATE", jobId: "job1", active: true, found: 3, checked: 40 });
    expect(s).toMatchObject({ status: "running", found: 3, checked: 40 });
  });

  it("a terminal update completes/fails/cancels the owned job", () => {
    expect(areaScanReducer(run(), { type: "JOB_UPDATE", jobId: "job1", active: false, terminal: "completed", found: 2 }).status).toBe("completed");
    expect(areaScanReducer(run(), { type: "JOB_UPDATE", jobId: "job1", active: false, terminal: "failed" }).status).toBe("failed");
  });

  it("an inactive-without-terminal update finishes the scan (completed)", () => {
    expect(areaScanReducer(run(), { type: "JOB_UPDATE", jobId: "job1", active: false }).status).toBe("completed");
  });
});

describe("area scan machine — refresh mid-scan vs crash/zombie", () => {
  it("REFRESH mid-scan: a RECENT persisted running scan resumes DISPLAY", () => {
    const persisted: PersistedScan = { status: "running", jobId: "job1", boxKey: "b1", startedAt: at };
    const s = areaScanReducer(IDLE, { type: "HYDRATE", persisted, now: at + 60_000 }); // 1 min later
    expect(s).toMatchObject({ status: "running", jobId: "job1", boxKey: "b1" });
  });

  it("CRASH/zombie: a STALE persisted running scan resolves to idle (never shown, never restarted)", () => {
    const persisted: PersistedScan = { status: "running", jobId: "job1", boxKey: "b1", startedAt: at };
    const s = areaScanReducer(IDLE, { type: "HYDRATE", persisted, now: at + STALE_RUNNING_MS + 1 });
    expect(s).toEqual(IDLE);
    expect(persistedRunningIsStale(persisted, at + STALE_RUNNING_MS + 1)).toBe(true); // caller cancels the server job
  });

  it("a persisted TERMINAL scan is not resurrected on open", () => {
    const persisted: PersistedScan = { status: "completed", jobId: "job1", boxKey: "b1", startedAt: at };
    expect(areaScanReducer(IDLE, { type: "HYDRATE", persisted, now: at + 1000 })).toEqual(IDLE);
  });

  it("a running scan with no startedAt is treated as stale → idle", () => {
    const persisted: PersistedScan = { status: "running", jobId: "job1", boxKey: "b1", startedAt: null };
    expect(areaScanReducer(IDLE, { type: "HYDRATE", persisted, now: at })).toEqual(IDLE);
  });
});

describe("area scan machine — stop, dismiss, persistence", () => {
  it("STOP cancels a running scan", () => {
    expect(areaScanReducer(run(), { type: "STOP" }).status).toBe("cancelled");
  });
  it("STOP on an idle/terminal state is a no-op", () => {
    expect(areaScanReducer(IDLE, { type: "STOP" })).toBe(IDLE);
    const done = run({ status: "completed" });
    expect(areaScanReducer(done, { type: "STOP" })).toBe(done);
  });
  it("DISMISS clears a terminal summary back to idle; no-op while running", () => {
    expect(areaScanReducer(run({ status: "completed" }), { type: "DISMISS" })).toEqual(IDLE);
    const r = run();
    expect(areaScanReducer(r, { type: "DISMISS" })).toBe(r);
  });
  it("SUBMIT_FAILED surfaces an error instead of hanging in running", () => {
    let s = areaScanReducer(IDLE, { type: "START", boxKey: "b1", at });
    s = areaScanReducer(s, { type: "SUBMIT_FAILED", error: "network" });
    expect(s).toMatchObject({ status: "failed", error: "network" });
  });
  it("toPersisted stores identity/lifecycle only (never counts), and nulls on idle", () => {
    expect(toPersisted(IDLE)).toBeNull();
    expect(toPersisted(run({ found: 9, checked: 99 }))).toEqual({ status: "running", jobId: "job1", boxKey: "b1", startedAt: at });
  });
});
