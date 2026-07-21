/**
 * HARVEST SCHEDULER — the always-on cadence for the yield engine.
 *
 * The harvest runs on a periodic timer AND on demand. The timer guarantees
 * baseline coverage; the on-demand wake is what makes us FIRST: when a fresh
 * drop is confirmed, its cell/street neighbours become immediately due (the
 * flip-proximity override in the yield engine), but that only helps if a cycle
 * actually runs soon — otherwise the neighbour waits up to a full timer
 * interval (default 15 min). wakeHarvest() collapses that wait to seconds.
 *
 * The wake is debounced and rate-limited so a burst of drops (a whole street
 * lighting at once) coalesces into ONE extra cycle, and a wake can never stack
 * on top of a running cycle — the bandwidth governor and circuit breaker still
 * bound every scan, so waking freely is safe.
 */
import { structuredLog } from "./structuredLog";

type Tick = () => void | Promise<void>;

// Coalesce a burst of wakes fired within this window into one cycle.
const DEBOUNCE_MS = Math.max(250, Number(process.env.HARVEST_WAKE_DEBOUNCE_MS) || 3_000);
// Never start an off-cycle wake closer than this to the previous cycle start —
// keeps the fleet from spinning when drops arrive continuously.
const MIN_INTERVAL_MS = Math.max(5_000, Number(process.env.HARVEST_WAKE_MIN_MS) || 60_000);

let tickFn: Tick | null = null;
let periodic: ReturnType<typeof setInterval> | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRunAt = 0;

/** How long to wait before an off-cycle wake may fire: at least the debounce
 *  window, and never inside the min-interval cooldown after the last cycle. */
export function nextWakeDelay(now: number, last: number, minInterval = MIN_INTERVAL_MS, debounce = DEBOUNCE_MS): number {
  return Math.max(debounce, minInterval - (now - last));
}

async function fire(reason: string): Promise<void> {
  pending = null;
  if (running || !tickFn) return;
  running = true;
  lastRunAt = Date.now();
  try {
    await tickFn();
    structuredLog("harvest.cycle_ran", { reason });
  } catch (e: any) {
    structuredLog("harvest.cycle_failed", { reason, error: String(e?.message ?? e).slice(0, 160) }, "warn");
  } finally {
    running = false;
  }
}

/**
 * Request an off-cycle harvest. Coalesces concurrent callers, respects the
 * min-interval cooldown, and no-ops while a cycle is already running or
 * scheduled. Safe to call from any hot path (fresh-lead projection, discovery
 * completion, coming-soon promotion).
 */
export function wakeHarvest(reason: string): void {
  if (!tickFn || pending || running) return;
  const delay = nextWakeDelay(Date.now(), lastRunAt);
  pending = setTimeout(() => { void fire(reason); }, delay);
  if (typeof (pending as any).unref === "function") (pending as any).unref();
}

/** Start the periodic harvest and enable on-demand wakes. Idempotent. */
export function startHarvestScheduler(tick: Tick, opts: { intervalMs: number; firstDelayMs?: number } = { intervalMs: 15 * 60_000 }): void {
  tickFn = tick;
  if (periodic) return;
  const first = opts.firstDelayMs ?? 4 * 60_000;
  // Store + unref the boot timer too, so it can never keep the process (or a
  // CI test worker) alive and is cleared by the reset hook.
  bootTimer = setTimeout(() => { bootTimer = null; void fire("boot"); }, first);
  if (typeof (bootTimer as any).unref === "function") (bootTimer as any).unref();
  periodic = setInterval(() => { void fire("timer"); }, opts.intervalMs);
  if (typeof (periodic as any).unref === "function") (periodic as any).unref();
}

/** Test/shutdown hook. */
export function _resetHarvestSchedulerForTests(): void {
  if (periodic) clearInterval(periodic);
  if (pending) clearTimeout(pending);
  if (bootTimer) clearTimeout(bootTimer);
  tickFn = null; periodic = null; pending = null; bootTimer = null; running = false; lastRunAt = 0;
}

// ── Budget shaping (timezone-correct) ────────────────────────────────────────
// Proxy spend follows idle capacity. The container has no TZ set, so a naive
// getHours() runs in UTC and lands the "quiet overnight" boost and "busy
// daytime" window ~5h off actual Eastern rep hours. Compute in America/New_York
// so the boost is genuinely overnight and the day factor genuinely covers knock
// hours. Budget is not proxy-constrained, so the day factor defaults to 1.0
// (no cut — we want maximum fresh-lead flow exactly when reps are knocking);
// adaptivePace remains the website-safety valve.
const NIGHT_FACTOR = Number(process.env.HARVEST_NIGHT_FACTOR ?? 1.5);
const DAY_FACTOR = Number(process.env.HARVEST_DAY_FACTOR ?? 1.0);

export function easternHour(d: Date = new Date()): number {
  const h = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(d));
  return h % 24; // some ICU builds render midnight as "24"
}

/** Time-of-day budget multiplier in Eastern time: overnight boost (00–06),
 *  neutral daytime, ×1 otherwise. */
export function budgetShapeFactor(d: Date = new Date()): number {
  const h = easternHour(d);
  if (h >= 0 && h < 6) return NIGHT_FACTOR;
  if (h >= 9 && h < 17) return DAY_FACTOR;
  return 1;
}
