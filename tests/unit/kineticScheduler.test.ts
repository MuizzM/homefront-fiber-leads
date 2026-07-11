import { describe, it, expect } from "vitest";
import { KineticScheduler, type WorkSource, type ProbeTask } from "../../server/kineticScheduler";
import type { ProbeOutcome, AddrKey } from "../../server/kineticProbe";

// The scheduler is the one closed-loop engine. These tests drive it with an INJECTED
// probe (zero proxy, zero network) and a no-op sleep, so the whole control loop —
// AIMD sawtooth, floor→refresh→backoff escalation, fair dispatch, and no-task-loss —
// is verified deterministically.

const key = (id: string): AddrKey => ({ kind: "addr", address: id, city: "Broadway", state: "NC", zip: "27505" });
const answered = (ms = 10): ProbeOutcome => ({ kind: "answered", result: {} as any, latencyMs: ms });
const blocked = (ms = 5): ProbeOutcome => ({ kind: "blocked", latencyMs: ms });
const noop = async () => {};

// In-memory source: hands out tasks, re-enqueues blocked/inconclusive ones (bounded),
// records terminal outcomes. Mirrors the real "a 403'd task is retried, never lost".
class MemSource implements WorkSource {
  kind = "test";
  private pending: ProbeTask[];
  private attempts = new Map<string, number>();
  delivered: string[] = [];
  answeredIds: string[] = [];
  constructor(public id: string, ids: string[], private retryCap = 100, private order?: string[]) {
    this.pending = ids.map((i) => ({ key: key(i) }));
  }
  async next(n: number): Promise<ProbeTask[]> { return this.pending.splice(0, n); }
  onResult(task: ProbeTask, o: ProbeOutcome): void {
    const id = task.key.address;
    this.delivered.push(id);
    this.order?.push(id);
    if (o.kind === "answered" || o.kind === "no_service") { this.answeredIds.push(id); return; }
    const a = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, a);
    if (a < this.retryCap) this.pending.push(task); // retry — the task is never dropped silently
  }
  remaining(): number { return this.pending.length; }
}

// A probe simulating a token-bucket of capacity CAP: within one concurrently-dispatched
// round, the first CAP tasks get a token (answered), the rest 403 (blocked).
function capacityProbe(CAP: number): (k: AddrKey) => Promise<ProbeOutcome> {
  let inFlight = 0;
  return async (_k) => {
    inFlight++;
    const over = inFlight > CAP;
    try { await new Promise((r) => setTimeout(r, 0)); return over ? blocked() : answered(); }
    finally { inFlight--; }
  };
}

describe("KineticScheduler — closed-loop dispatch", () => {
  it("self-settles around bucket capacity (AIMD sawtooth) and loses NO task", async () => {
    const CAP = 10;
    const src = new MemSource("s", Array.from({ length: 300 }, (_, i) => `t${i}`));
    const sch = new KineticScheduler({ probe: capacityProbe(CAP), sleep: noop, maxRounds: 5000 });
    const sum = await sch.run([src]);

    expect(src.answeredIds.length).toBe(300);          // every task delivered — none lost to a 403
    expect(sum.totalOk).toBe(300);
    expect(sum.maxCwnd).toBeGreaterThan(CAP);           // it PROBED past capacity (discovered the ceiling)
    expect(sum.totalBlocked).toBeGreaterThan(0);        // and felt the push-back
    expect(sum.blockRate).toBeLessThan(0.5);            // but the window kept blocks a minority
    // The trace both rises and falls — the sawtooth, not a flat guess.
    const peak = Math.max(...sum.cwndTrace);
    const afterPeak = sum.cwndTrace.slice(sum.cwndTrace.indexOf(peak));
    expect(Math.min(...afterPeak)).toBeLessThan(peak);
  });

  it("at the floor and still blocking → refreshes the session ONCE, then escalates to growing hard-backoff", async () => {
    let refreshes = 0;
    const backoffs: number[] = [];
    const src = new MemSource("s", ["a", "b", "c", "d"], 1000);
    const sch = new KineticScheduler({
      probe: async () => blocked(),                     // always throttled
      refreshSession: async () => { refreshes++; return true; },
      sleep: async (ms) => { if (ms > 0) backoffs.push(ms); },
      maxRounds: 12,
    });
    const sum = await sch.run([src]);

    expect(refreshes).toBe(1);                          // exactly one session refresh in the episode
    expect(sum.hardBackoffs).toBeGreaterThanOrEqual(1); // then wall-clock backoff kicks in
    expect(sum.totalOk).toBe(0);                        // nothing answered — pure block storm
    // The hard-backoff sleeps grow (exponential), proving escalation not a flat retry.
    const hb = backoffs.filter((b) => b >= 1000);
    expect(hb.length).toBeGreaterThanOrEqual(2);
    expect(hb[hb.length - 1]).toBeGreaterThan(hb[0]);
  });

  it("dispatches fairly across sources (round-robin, no starvation)", async () => {
    const order: string[] = [];
    const a = new MemSource("A", Array.from({ length: 10 }, (_, i) => `a${i}`), 100, order);
    const b = new MemSource("B", Array.from({ length: 10 }, (_, i) => `b${i}`), 100, order);
    const sch = new KineticScheduler({ probe: async () => answered(), sleep: noop });
    await sch.run([a, b]);

    expect(a.answeredIds.length).toBe(10);
    expect(b.answeredIds.length).toBe(10);
    // B is not starved behind all of A: a 'b*' appears within the first few delivered.
    const firstB = order.findIndex((id) => id.startsWith("b"));
    expect(firstB).toBeGreaterThanOrEqual(0);
    expect(firstB).toBeLessThan(4);
  });

  it("live snapshot reports running state, block rate and effective throughput", async () => {
    const src = new MemSource("s", Array.from({ length: 40 }, (_, i) => `t${i}`));
    const sch = new KineticScheduler({ probe: capacityProbe(8), sleep: noop });
    const sum = await sch.run([src]);
    const snap = sch.snapshot();
    expect(snap.running).toBe(false);        // finished
    expect(sum.totalOk).toBe(40);
    expect(snap.blockRate).toBeGreaterThanOrEqual(0);
    expect(snap.blockRate).toBeLessThanOrEqual(1);
  });
});
