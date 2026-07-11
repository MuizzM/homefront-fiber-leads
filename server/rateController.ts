// ── Kinetic rate controller — closed-loop AIMD congestion window ──────────────
// The Kinetic scan 403 is NOT a daily cap and NOT a fixed velocity ceiling: it is
// a REFILLING token-bucket keyed to the one account/proxy identity (measured live).
// So instead of hand-tuned BURST/COOLDOWN constants (which block ~50% one run and
// 0% the next), this controls a CONCURRENCY WINDOW (cwnd) exactly like TCP: because
// the scheduler is self-clocking (a finished probe frees a slot, the next dispatches),
// average send-rate = cwnd / meanRTT — so shrinking cwnd shrinks the rate with no
// explicit cooldown number. The FIRST block auto-discovers capacity (slow-start →
// ssthresh); thereafter additive-increase / multiplicative-decrease settle the window
// at the bucket's true refill rate. alpha=1, beta=0.5 are the universal AIMD stability
// constants, NOT app-tuned pacing — there is deliberately zero Kinetic-specific number.
//
// PURE module: no imports, no clock, no DB, no network. Everything is a deterministic
// function of (State, Round) → new State, so it is exhaustively unit-testable. The
// scheduler measures each round {ok, blocked, neutral, meanRttMs}, calls observeRound,
// and performs the returned sleeps / session refresh.

export interface RateCfg {
  minC: number;                // floor concurrency (1)
  maxC: number;                // ceiling concurrency
  initC: number;               // initial window (slow-start start)
  alpha: number;               // additive increase per clean round (1)
  beta: number;                // multiplicative decrease on a block (0.5)
  ssthresh0: number;           // initial slow-start threshold
  refreshAtFloorRounds: number;// consecutive floor-blocks before we act on the session
  baseBackoffMs: number;       // floor for wall-clock hard-backoff
  maxBackoffMs: number;        // cap for wall-clock hard-backoff
}

// Tuned from the first live Broadway run: the original ssthresh0=64/maxC=64 let
// slow-start DOUBLE all the way to 64, which deep-drained Kinetic's bucket (22% blocks,
// a stuck tail). Discovering capacity destructively is the whole failure mode. So exit
// slow-start early (ssthresh0=8: double 2→4→8, then probe by +1) and cap the ceiling
// (maxC=20) so the window creeps up to the real refill rate instead of overshooting it.
export const DEFAULT_RATE_CFG: RateCfg = {
  minC: 1, maxC: 20, initC: 2, alpha: 1, beta: 0.5,
  ssthresh0: 8, refreshAtFloorRounds: 2, baseBackoffMs: 2000, maxBackoffMs: 60000,
};

export type Phase = "slow_start" | "congestion_avoidance";
// What the scheduler must DO after this round (besides setting concurrency):
//  continue        — dispatch the next round at `concurrency` after recoveryPauseMs
//  refresh_session — window is at the floor and STILL blocking ⇒ stale session, not a
//                    drained bucket; get a fresh token (the proven fix) before backing off
//  hard_backoff    — floor-blocking even AFTER a refresh ⇒ bucket genuinely drained;
//                    only wall-clock refills it, so sleep backoffMs (grows, capped)
export type Action = "continue" | "refresh_session" | "hard_backoff";

export interface RateState {
  cwnd: number;
  ssthresh: number;
  phase: Phase;
  floorBlockedRounds: number;    // consecutive rounds blocked while already at minC
  refreshedThisEpisode: boolean; // have we forced a session refresh in this congestion episode?
  hardBackoffN: number;          // wall-clock backoff step (for exponential growth)
  rounds: number;
  totalOk: number;
  totalBlocked: number;
  totalNeutral: number;
}

// One dispatched-and-awaited batch's measured outcome.
//  ok      — probe consumed a bucket token (answered OR conclusive no-service)
//  blocked — HTTP 403, the ONLY back-pressure signal
//  neutral — 401 / timeout / 5xx / network / malformed: NOT a bucket signal; the
//            window ignores it (session manager & requeue handle it)
export interface Round { ok: number; blocked: number; neutral: number; meanRttMs: number }

export interface Decision {
  state: RateState;
  concurrency: number;     // window to dispatch the next round at
  action: Action;
  recoveryPauseMs: number; // let the bucket refill ~one RTT after a block (0 when clean)
  backoffMs: number;       // wall-clock sleep for hard_backoff (0 otherwise)
}

export function initController(cfg: RateCfg = DEFAULT_RATE_CFG): RateState {
  const initC = clamp(cfg.initC, cfg.minC, cfg.maxC);
  return {
    cwnd: initC,
    ssthresh: clamp(cfg.ssthresh0, cfg.minC, cfg.maxC),
    phase: initC < cfg.ssthresh0 ? "slow_start" : "congestion_avoidance",
    floorBlockedRounds: 0,
    refreshedThisEpisode: false,
    hardBackoffN: 0,
    rounds: 0,
    totalOk: 0,
    totalBlocked: 0,
    totalNeutral: 0,
  };
}

// The whole control law. Called once per dispatched round.
export function observeRound(prev: RateState, r: Round, cfg: RateCfg = DEFAULT_RATE_CFG): Decision {
  const s: RateState = {
    ...prev,
    rounds: prev.rounds + 1,
    totalOk: prev.totalOk + r.ok,
    totalBlocked: prev.totalBlocked + r.blocked,
    totalNeutral: prev.totalNeutral + r.neutral,
  };
  const rtt = Number.isFinite(r.meanRttMs) && r.meanRttMs > 0 ? r.meanRttMs : cfg.baseBackoffMs;

  // ── Congestion: at least one 403 this round. ONE reduction per round (the whole
  // in-flight batch counts as a single signal, no matter how many 403s it held). ──
  if (r.blocked > 0) {
    const wasAtFloor = s.cwnd <= cfg.minC;
    s.ssthresh = Math.max(cfg.minC, Math.floor(s.cwnd * cfg.beta));
    s.cwnd = s.ssthresh;
    s.phase = "congestion_avoidance";
    if (wasAtFloor) s.floorBlockedRounds += 1; else s.floorBlockedRounds = 0;

    if (s.floorBlockedRounds >= cfg.refreshAtFloorRounds) {
      if (!s.refreshedThisEpisode) {
        // First floor-block escalation of this episode → try a fresh session.
        s.refreshedThisEpisode = true;
        return { state: s, concurrency: s.cwnd, action: "refresh_session", recoveryPauseMs: 0, backoffMs: 0 };
      }
      // Already refreshed and STILL floor-blocking → the bucket is truly drained.
      s.hardBackoffN += 1;
      const base = Math.max(cfg.baseBackoffMs, Math.round(rtt * 4));
      const backoffMs = Math.min(cfg.maxBackoffMs, base * Math.pow(2, s.hardBackoffN - 1));
      return { state: s, concurrency: s.cwnd, action: "hard_backoff", recoveryPauseMs: 0, backoffMs };
    }
    // Ordinary halving: shrink and let the bucket refill ~one RTT before the next round.
    return { state: s, concurrency: s.cwnd, action: "continue", recoveryPauseMs: rtt, backoffMs: 0 };
  }

  // ── All-neutral round (no ok, no block): no bucket signal → hold the window. ──
  if (r.ok === 0) {
    return { state: s, concurrency: s.cwnd, action: "continue", recoveryPauseMs: rtt, backoffMs: 0 };
  }

  // ── Clean & productive round: the congestion episode is over; grow the window. ──
  s.floorBlockedRounds = 0;
  s.refreshedThisEpisode = false;
  s.hardBackoffN = 0;
  if (s.phase === "slow_start") {
    s.cwnd = Math.min(cfg.maxC, s.cwnd * 2);
    if (s.cwnd >= s.ssthresh) s.phase = "congestion_avoidance";
  } else {
    s.cwnd = Math.min(cfg.maxC, s.cwnd + cfg.alpha);
  }
  return { state: s, concurrency: s.cwnd, action: "continue", recoveryPauseMs: 0, backoffMs: 0 };
}

// Called by the scheduler after it has obtained a fresh session in response to a
// 'refresh_session' action. The refresh guard (refreshedThisEpisode) STAYS set — so a
// fresh session that ALSO floor-blocks escalates to hard_backoff — but we reset the
// window to slow-start to re-discover capacity on the new session.
export function onSessionRefreshed(prev: RateState, cfg: RateCfg = DEFAULT_RATE_CFG): RateState {
  const initC = clamp(cfg.initC, cfg.minC, cfg.maxC);
  return {
    ...prev,
    cwnd: initC,
    ssthresh: clamp(cfg.ssthresh0, cfg.minC, cfg.maxC),
    phase: initC < cfg.ssthresh0 ? "slow_start" : "congestion_avoidance",
    floorBlockedRounds: 0,
    hardBackoffN: 0,
    // refreshedThisEpisode intentionally left as-is (true) — see comment above.
  };
}

export function metrics(s: RateState): { cwnd: number; ssthresh: number; phase: Phase; blockRate: number; rounds: number } {
  const bucketSignals = s.totalOk + s.totalBlocked;
  return {
    cwnd: s.cwnd,
    ssthresh: s.ssthresh,
    phase: s.phase,
    blockRate: bucketSignals > 0 ? s.totalBlocked / bucketSignals : 0,
    rounds: s.rounds,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
