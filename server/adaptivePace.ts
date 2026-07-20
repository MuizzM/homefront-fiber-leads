/**
 * ADAPTIVE PACE — website-safety feedback controller for the scan fleet.
 *
 * The old safety model was blunt: producers ON (risk wedging the site) or OFF
 * (starve the lead pipeline). This controller replaces that with a closed loop:
 * the scan fleet self-throttles against LIVE website health, so producers can
 * stay on permanently and the site stays fast.
 *
 * Signals (zero DB coupling, sampled on the control process):
 *   1. Event-loop lag p95 (perf_hooks.monitorEventLoopDelay) — the earliest
 *      symptom of CPU/IO saturation; rises BEFORE users notice.
 *   2. Self health probe latency (GET 127.0.0.1:$PORT/api/health every 15s) —
 *      the true end-user experience.
 *
 * Controller: AIMD on a shared `paceMs` injected between target batches in
 * every scan worker loop.
 *   - Healthy  (lag p95 < 50ms AND health < 800ms)  → pace ×= 0.8 (toward 0)
 *   - Stressed (lag p95 > 200ms OR health > 2500ms) → pace = pace*1.5 + 25 (cap 2000ms)
 * Because all workers read the same value, aggregate fleet load contracts and
 * expands smoothly — no thundering, no hard stop.
 *
 * ADAPTIVE_PACE=off disables (pace always 0). PACE_MAX_MS overrides the cap.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";

const ENABLED = process.env.ADAPTIVE_PACE !== "off";
const MAX_PACE = Math.max(100, Number(process.env.PACE_MAX_MS) || 2000);
const PORT = Number(process.env.PORT) || 5000;

let paceMs = 0;
let loopLagP95 = 0;
let healthMs = 0;
let lastHealthAt = 0;

// ── Signal 1: event-loop lag histogram (10s rolling window) ─────────────────
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
setInterval(() => {
  loopLagP95 = lag.percentile(95) / 1e6; // ns → ms
  lag.reset();
}, 10_000).unref();

// ── Signal 2: self health probe ─────────────────────────────────────────────
async function probeHealth() {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(4_000),
    });
    healthMs = Date.now() - started;
    if (!res.ok) healthMs = Math.max(healthMs, 3_000);
  } catch {
    healthMs = 4_000; // unreachable = maximally stressed
  }
  lastHealthAt = Date.now();
}
setInterval(() => { void probeHealth(); }, 15_000).unref();
void probeHealth();

// ── AIMD controller tick (5s) ────────────────────────────────────────────────
setInterval(() => {
  if (!ENABLED) { paceMs = 0; return; }
  // If the probe is stale (>45s), distrust it — treat as stressed only when the
  // loop lag agrees (avoids punishing the fleet for a hung probe socket).
  const probeStale = Date.now() - lastHealthAt > 45_000;
  const stressed = loopLagP95 > 200 || healthMs > 2_500 || (probeStale && loopLagP95 > 100);
  const healthy = loopLagP95 < 50 && healthMs < 800 && !probeStale;
  if (stressed) paceMs = Math.min(MAX_PACE, paceMs * 1.5 + 25);
  else if (healthy) paceMs = Math.max(0, paceMs * 0.8);
  // Between bands: hold (hysteresis prevents oscillation).
}, 5_000).unref();

/** Current injected delay between target batches (ms). 0 = full speed. */
export function currentPaceMs(): number {
  return ENABLED ? paceMs : 0;
}

/** Sleep the current pace. Called by scan workers between batches. */
export async function adaptivePace(): Promise<void> {
  const ms = currentPaceMs();
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

export function adaptivePaceStats() {
  return { paceMs: currentPaceMs(), loopLagP95: Math.round(loopLagP95), healthMs: Math.round(healthMs), enabled: ENABLED };
}
