// ── kineticScheduler — the one closed-loop scan engine ───────────────────────
// There is a SINGLE refilling token-bucket keyed to the one Kinetic account/proxy
// identity, so there must be a SINGLE congestion window governing every scan. This
// process-global scheduler owns that one rateController window + the session, and is
// the ONLY caller of the probe primitive. Every kind of scan (manual city, nightly
// CNS sweep, watchlist recheck, discovery) becomes a WorkSource that submits tasks;
// they all share the one window, so their COMBINED rate self-settles at the bucket's
// true refill rate — the old bug (each loop guessing its own pacing) is structurally
// impossible. All time/network/DB is injected, so the whole loop is unit-testable.

import {
  initController, observeRound, onSessionRefreshed, metrics,
  DEFAULT_RATE_CFG, type RateCfg, type RateState, type Round,
} from "./rateController";
import { probe as defaultProbe, type ProbeKey, type ProbeOutcome } from "./kineticProbe";

export interface ProbeTask { key: ProbeKey; ctx?: any }

// A source of scan work. It owns its own durable queue/cursor + result handling; the
// scheduler only asks for the next N tasks and reports each outcome back.
export interface WorkSource {
  id: string;
  kind: string;
  next(n: number): Promise<ProbeTask[]>;                       // pull up to n pending tasks (removes them from pending)
  onResult(task: ProbeTask, outcome: ProbeOutcome): Promise<void> | void; // persist / re-enqueue-on-block (source policy)
  remaining(): number;                                        // pending count (for queue-depth + loop termination)
}

export interface SchedulerDeps {
  probe?: (key: ProbeKey) => Promise<ProbeOutcome>;
  refreshSession?: () => Promise<boolean>;   // obtain a fresh token; returns success
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  cfg?: RateCfg;
  onRound?: (snap: RoundSnapshot) => void;   // observability hook (per round)
  maxRounds?: number;                         // safety bound (runaway guard)
  timeBudgetMs?: number;                      // stop pulling new work after this wall-clock (0 = unbounded)
  // Circuit breaker (opt-in; 0 = off = grind until drained/budget). Stop the run
  // after this many CONSECUTIVE hard-backoffs — the Kinetic bucket is genuinely
  // drained and not refilling, so more probes just burn proxy $ on 403s that
  // carry no availability signal. The un-answered targets stay queued (their
  // last_scanned_at is untouched) and a later run sweeps them once the rolling
  // window refills. Any answered round resets the counter.
  stopAfterHardBackoffs?: number;
}

export interface RoundSnapshot {
  round: number; cwnd: number; phase: string; action: string;
  ok: number; blocked: number; neutral: number; meanRttMs: number;
  blockRate: number;
}

export interface RunSummary {
  rounds: number;
  totalOk: number; totalBlocked: number; totalNeutral: number;
  blockRate: number;
  sessionRefreshes: number; hardBackoffs: number;
  finalCwnd: number; maxCwnd: number;
  elapsedMs: number; effChecksPerMin: number;
  cwndTrace: number[];
  // Why the run ended: work exhausted, time budget hit, sustained throttle
  // (circuit breaker), or the runaway maxRounds guard.
  stopReason: "drained" | "budget" | "throttled" | "maxRounds";
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class KineticScheduler {
  private state: RateState;
  private readonly cfg: RateCfg;
  private readonly probe: (key: ProbeKey) => Promise<ProbeOutcome>;
  private readonly refreshSession: () => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onRound?: (snap: RoundSnapshot) => void;
  private readonly maxRounds: number;
  private readonly timeBudgetMs: number;
  private readonly stopAfterHardBackoffs: number;

  private sessionRefreshes = 0;
  private hardBackoffs = 0;
  private okCompletions = 0;
  private startedAt = 0;
  private running = false;
  private cwndTrace: number[] = [];

  constructor(deps: SchedulerDeps = {}) {
    this.cfg = deps.cfg ?? DEFAULT_RATE_CFG;
    this.state = initController(this.cfg);
    this.probe = deps.probe ?? defaultProbe;
    this.refreshSession = deps.refreshSession ?? defaultRefreshSession;
    this.sleep = deps.sleep ?? realSleep;
    this.now = deps.now ?? Date.now;
    this.onRound = deps.onRound;
    this.maxRounds = deps.maxRounds ?? 1_000_000;
    this.timeBudgetMs = deps.timeBudgetMs ?? 0;
    this.stopAfterHardBackoffs = deps.stopAfterHardBackoffs ?? 0;
  }

  get isRunning() { return this.running; }

  // Live snapshot for GET /api/scan/engine-status.
  snapshot() {
    const m = metrics(this.state);
    const elapsedMin = Math.max(1e-6, (this.now() - this.startedAt) / 60000);
    return {
      running: this.running,
      cwnd: m.cwnd, ssthresh: m.ssthresh, phase: m.phase,
      blockRate: m.blockRate, rounds: m.rounds,
      sessionRefreshes: this.sessionRefreshes, hardBackoffs: this.hardBackoffs,
      effChecksPerMin: this.startedAt ? Math.round(this.okCompletions / elapsedMin) : 0,
    };
  }

  // Drain the given sources through the one shared window until all are empty.
  async run(sources: WorkSource[]): Promise<RunSummary> {
    this.running = true;
    this.startedAt = this.now();
    const active = sources.slice();
    let roundNo = 0;
    let consecHardBackoff = 0;
    let stopReason: RunSummary["stopReason"] = "maxRounds";
    try {
      while (roundNo < this.maxRounds) {
        if (this.timeBudgetMs && (this.now() - this.startedAt) > this.timeBudgetMs) { stopReason = "budget"; break; } // budget spent — rest stays queued
        const conc = Math.max(this.cfg.minC, Math.floor(this.state.cwnd));
        const batch = await this.pull(active, conc);
        if (batch.length === 0) { stopReason = "drained"; break; } // nothing left anywhere

        const outcomes = await Promise.all(batch.map(async ({ task, source }) => {
          let outcome: ProbeOutcome;
          try { outcome = await this.probe(task.key); }
          catch (e: any) { outcome = { kind: "inconclusive", reason: e?.message ?? "probe threw", latencyMs: 0 }; }
          await source.onResult(task, outcome);
          return outcome;
        }));

        const round = aggregateRound(outcomes);
        this.okCompletions += round.ok;
        const d = observeRound(this.state, round, this.cfg);
        this.state = d.state;
        roundNo++;
        this.cwndTrace.push(d.concurrency);
        if (this.cwndTrace.length > 500) this.cwndTrace.shift();

        this.onRound?.({
          round: roundNo, cwnd: d.concurrency, phase: this.state.phase, action: d.action,
          ok: round.ok, blocked: round.blocked, neutral: round.neutral, meanRttMs: round.meanRttMs,
          blockRate: metrics(this.state).blockRate,
        });

        // Any answered work means the bucket refilled — reset the throttle streak.
        if (round.ok > 0) consecHardBackoff = 0;

        if (d.action === "refresh_session") {
          const ok = await this.refreshSession();
          this.sessionRefreshes++;
          this.state = onSessionRefreshed(this.state, this.cfg);
          if (!ok) await this.sleep(this.cfg.baseBackoffMs); // refresh failed → brief wait before re-probing
        } else if (d.action === "hard_backoff") {
          this.hardBackoffs++;
          consecHardBackoff++;
          // Circuit breaker: the bucket is drained and not refilling — stop
          // burning proxy bytes on 403s. The rest stays queued for a later run.
          if (this.stopAfterHardBackoffs && consecHardBackoff >= this.stopAfterHardBackoffs) {
            stopReason = "throttled";
            break;
          }
          await this.sleep(d.backoffMs);
        } else if (d.recoveryPauseMs > 0) {
          await this.sleep(d.recoveryPauseMs);
        }
      }
      return this.summary(roundNo, stopReason);
    } finally {
      this.running = false;
    }
  }

  // Round-robin one task at a time across active sources so no single source starves
  // the window; stops when it has `n` tasks or every source is momentarily empty.
  private async pull(sources: WorkSource[], n: number): Promise<{ task: ProbeTask; source: WorkSource }[]> {
    const out: { task: ProbeTask; source: WorkSource }[] = [];
    let progressed = true;
    while (out.length < n && progressed) {
      progressed = false;
      for (const s of sources) {
        if (out.length >= n) break;
        const got = await s.next(1);
        if (got.length) { for (const t of got) out.push({ task: t, source: s }); progressed = true; }
      }
    }
    return out;
  }

  private summary(rounds: number, stopReason: RunSummary["stopReason"] = "drained"): RunSummary {
    const m = metrics(this.state);
    const elapsedMs = this.now() - this.startedAt;
    const elapsedMin = Math.max(1e-6, elapsedMs / 60000);
    return {
      rounds,
      stopReason,
      totalOk: this.state.totalOk, totalBlocked: this.state.totalBlocked, totalNeutral: this.state.totalNeutral,
      blockRate: m.blockRate,
      sessionRefreshes: this.sessionRefreshes, hardBackoffs: this.hardBackoffs,
      finalCwnd: this.state.cwnd, maxCwnd: this.cwndTrace.length ? Math.max(...this.cwndTrace) : this.state.cwnd,
      elapsedMs, effChecksPerMin: Math.round(this.okCompletions / elapsedMin),
      cwndTrace: this.cwndTrace.slice(),
    };
  }
}

function aggregateRound(outcomes: ProbeOutcome[]): Round {
  let ok = 0, blocked = 0, neutral = 0, rttSum = 0;
  for (const o of outcomes) {
    rttSum += o.latencyMs;
    if (o.kind === "answered" || o.kind === "no_service") ok++;
    else if (o.kind === "blocked") blocked++;
    else neutral++;
  }
  return { ok, blocked, neutral, meanRttMs: outcomes.length ? rttSum / outcomes.length : 0 };
}

async function defaultRefreshSession(): Promise<boolean> {
  try {
    const { refreshTokenFromApi } = await import("./scanner");
    await refreshTokenFromApi();
    return true;
  } catch {
    return false;
  }
}

// Process-global singleton — the one window for the one identity. Lazily created.
let _singleton: KineticScheduler | null = null;
export function scheduler(): KineticScheduler {
  if (!_singleton) _singleton = new KineticScheduler();
  return _singleton;
}
