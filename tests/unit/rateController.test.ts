import { describe, it, expect } from "vitest";
import {
  initController, observeRound, onSessionRefreshed, metrics,
  DEFAULT_RATE_CFG, type RateCfg, type RateState, type Round,
} from "../../server/rateController";

// The rate controller is the whole thesis of the scan-engine rewrite: it must SETTLE
// the send rate at Kinetic's true refilling-bucket capacity from measured 403 signals
// alone — no hand-tuned pacing constant. Pure + deterministic, so fully unit-testable.

const cfg: RateCfg = { ...DEFAULT_RATE_CFG };
const clean = (ok: number, rtt = 100): Round => ({ ok, blocked: 0, neutral: 0, meanRttMs: rtt });
const blocked = (ok: number, blk: number, rtt = 100): Round => ({ ok, blocked: blk, neutral: 0, meanRttMs: rtt });

// Drive a sequence of rounds through the controller, threading state + concurrency.
function run(seq: Round[], c = cfg) {
  let s = initController(c);
  const trace: { cwnd: number; action: string; conc: number }[] = [];
  for (const r of seq) {
    const d = observeRound(s, r, c);
    s = d.state;
    trace.push({ cwnd: s.cwnd, action: d.action, conc: d.concurrency });
  }
  return { s, trace };
}

describe("initController", () => {
  it("starts at initC in slow-start with sane bounds", () => {
    const s = initController(cfg);
    expect(s.cwnd).toBe(cfg.initC);
    expect(s.phase).toBe("slow_start");
    expect(s.ssthresh).toBe(cfg.ssthresh0);
    expect(s.floorBlockedRounds).toBe(0);
    expect(s.refreshedThisEpisode).toBe(false);
  });
});

describe("slow-start → congestion-avoidance", () => {
  it("doubles the window each clean round until it reaches ssthresh, then adds alpha", () => {
    // ssthresh 8 so we see the regime change quickly: 2 → 4 → 8 (switch) → 9 → 10.
    const c: RateCfg = { ...cfg, ssthresh0: 8, initC: 2, maxC: 64 };
    const { trace } = run([clean(2), clean(4), clean(8), clean(9), clean(10)], c);
    expect(trace.map(t => t.cwnd)).toEqual([4, 8, 9, 10, 11]);
  });

  it("never exceeds maxC", () => {
    const c: RateCfg = { ...cfg, maxC: 6, ssthresh0: 6, initC: 2 };
    const { s } = run(Array.from({ length: 20 }, () => clean(6)), c);
    expect(s.cwnd).toBe(6);
  });
});

describe("multiplicative decrease on a block", () => {
  it("first block sets ssthresh = floor(cwnd*beta) and drops cwnd to it (capacity discovery)", () => {
    // Grow to 16 (2→4→8→16), then a block → ssthresh=8, cwnd=8, congestion_avoidance.
    let s = initController({ ...cfg, ssthresh0: 64 });
    for (const r of [clean(2), clean(4), clean(8)]) s = observeRound(s, r, cfg).state; // cwnd now 16
    expect(s.cwnd).toBe(16);
    const d = observeRound(s, blocked(10, 6), cfg);
    expect(d.state.ssthresh).toBe(8);
    expect(d.state.cwnd).toBe(8);
    expect(d.state.phase).toBe("congestion_avoidance");
    expect(d.action).toBe("continue");
    expect(d.recoveryPauseMs).toBe(100); // one measured RTT to let the bucket refill
  });

  it("halves ONCE per round no matter how many 403s the round held", () => {
    let s = initController(cfg);
    for (const r of [clean(2), clean(4)]) s = observeRound(s, r, cfg).state; // cwnd 8
    const one = observeRound(s, blocked(1, 1), cfg).state.cwnd;   // 8 → 4
    const many = observeRound(s, blocked(1, 7), cfg).state.cwnd;  // still 8 → 4 (one reduction)
    expect(one).toBe(4);
    expect(many).toBe(4);
  });

  it("additive-increase (+alpha) per clean round in congestion-avoidance", () => {
    let s = initController(cfg);
    for (const r of [clean(2), clean(4)]) s = observeRound(s, r, cfg).state; // cwnd 8, slow-start
    s = observeRound(s, blocked(4, 2), cfg).state;                            // → CA, cwnd 4
    const a = observeRound(s, clean(4), cfg).state.cwnd;                      // 5
    const b = observeRound(observeRound(s, clean(4), cfg).state, clean(5), cfg).state.cwnd; // 6
    expect(a).toBe(5);
    expect(b).toBe(6);
  });
});

describe("floor-block escalation: refresh session, then hard backoff", () => {
  it("blocking at the floor asks for a session refresh first, then escalates to growing hard-backoff", () => {
    const c: RateCfg = { ...cfg, minC: 1, initC: 1, ssthresh0: 1, refreshAtFloorRounds: 2, baseBackoffMs: 1000, maxBackoffMs: 60000 };
    let s = initController(c); // cwnd 1, at floor
    // Round 1 blocked at floor → floorBlockedRounds=1, still just 'continue'.
    let d = observeRound(s, blocked(0, 1), c); s = d.state;
    expect(d.action).toBe("continue");
    expect(s.floorBlockedRounds).toBe(1);
    // Round 2 blocked at floor → hits refreshAtFloorRounds → refresh_session.
    d = observeRound(s, blocked(0, 1), c); s = d.state;
    expect(d.action).toBe("refresh_session");
    expect(s.refreshedThisEpisode).toBe(true);

    // Scheduler refreshes; window re-probes from initC, guard stays set.
    s = onSessionRefreshed(s, c);
    expect(s.cwnd).toBe(1);
    expect(s.refreshedThisEpisode).toBe(true);

    // Fresh session ALSO floor-blocks twice → now hard_backoff, and it must GROW.
    d = observeRound(s, blocked(0, 1), c); s = d.state; expect(d.action).toBe("continue");
    d = observeRound(s, blocked(0, 1), c); s = d.state;
    expect(d.action).toBe("hard_backoff");
    const first = d.backoffMs;
    d = observeRound(s, blocked(0, 1), c); s = d.state;
    expect(d.action).toBe("hard_backoff");
    expect(d.backoffMs).toBeGreaterThan(first); // strictly increasing
  });

  it("a clean round ends the episode: resets floor counter, refresh guard and backoff", () => {
    const c: RateCfg = { ...cfg, minC: 1, initC: 1, ssthresh0: 1, refreshAtFloorRounds: 2 };
    let s = initController(c);
    s = observeRound(s, blocked(0, 1), c).state;
    s = observeRound(s, blocked(0, 1), c).state; // refresh_session, refreshedThisEpisode=true
    s = onSessionRefreshed(s, c);
    expect(s.refreshedThisEpisode).toBe(true);
    s = observeRound(s, clean(1), c).state;      // a good round clears the episode
    expect(s.floorBlockedRounds).toBe(0);
    expect(s.refreshedThisEpisode).toBe(false);
    expect(s.hardBackoffN).toBe(0);
  });

  it("hard_backoff is capped at maxBackoffMs", () => {
    const c: RateCfg = { ...cfg, minC: 1, initC: 1, ssthresh0: 1, refreshAtFloorRounds: 1, baseBackoffMs: 1000, maxBackoffMs: 4000 };
    let s = initController(c);
    s = observeRound(s, blocked(0, 1), c).state;   // floor block → refreshAtFloorRounds=1 → refresh_session
    s = onSessionRefreshed(s, c);
    let last = 0;
    for (let i = 0; i < 10; i++) { const d = observeRound(s, blocked(0, 1), c); s = d.state; if (d.action === "hard_backoff") last = d.backoffMs; }
    expect(last).toBeLessThanOrEqual(4000);
    expect(last).toBeGreaterThan(0);
  });
});

describe("neutral rounds are not a bucket signal", () => {
  it("an all-neutral round (timeouts/401s) holds the window, neither grows nor shrinks", () => {
    let s = initController(cfg);
    for (const r of [clean(2), clean(4)]) s = observeRound(s, r, cfg).state; // cwnd 8
    const held = observeRound(s, { ok: 0, blocked: 0, neutral: 5, meanRttMs: 100 }, cfg);
    expect(held.state.cwnd).toBe(8);
    expect(held.action).toBe("continue");
    expect(held.state.totalNeutral).toBe(5);
  });
});

describe("convergence to a refilling bucket (the whole point)", () => {
  it("settles average throughput near the bucket's refill rate with a low block rate", () => {
    // Simulate a token-bucket: capacity CAP, refills REFILL tokens per round. Each round
    // the scheduler dispatches `conc` probes; those that find a token answer (ok), the
    // rest 403 (blocked). AIMD should discover ~REFILL and hold there (sawtooth).
    const CAP = 20, REFILL = 8;
    const c: RateCfg = { ...cfg, maxC: 64, initC: 2, ssthresh0: 64 };
    let s = initController(c);
    let conc = c.initC;
    let tokens = CAP;
    let okLast100 = 0, roundsLast100 = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const avail = Math.min(conc, tokens);
      const ok = avail, blk = conc - avail;
      tokens = Math.min(CAP, tokens - avail + REFILL);
      const d = observeRound(s, { ok, blocked: blk, neutral: 0, meanRttMs: 100 }, c);
      s = d.state;
      conc = d.concurrency;
      if (i >= N - 100) { okLast100 += ok; roundsLast100++; }
    }
    const avgOk = okLast100 / roundsLast100;
    // Throughput lands in the neighborhood of the refill rate — not collapsed to the
    // floor, not running away — which is what "self-calibrated to the true rate" means.
    expect(avgOk).toBeGreaterThan(REFILL * 0.6);
    expect(avgOk).toBeLessThan(REFILL * 1.4);
    // Window stays bounded and never pins to the ceiling.
    expect(s.cwnd).toBeLessThan(c.maxC);
    expect(metrics(s).blockRate).toBeLessThan(0.5);
  });
});
