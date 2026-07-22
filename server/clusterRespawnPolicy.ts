// Pure crash-loop / respawn policy for the scan-cluster supervisor. Extracted
// from index.ts so the escalation logic is unit-testable without a live cluster.
//
// Rule: a worker that stayed up past `minHealthyMs` before dying is a normal
// one-off crash — respawn fast and reset its counter. A worker that dies almost
// immediately is crash-looping (bad boot state, unrunnable migration); back off
// exponentially and, after `maxRapid` rapid crashes in a row, PARK it so it
// cannot peg the box — except the control worker (index 0), which the app needs,
// so it keeps retrying at the capped delay instead of parking.

export interface RespawnConfig {
  minHealthyMs: number;   // uptime at/above which a crash is "one-off" → reset
  maxRapid: number;       // rapid crashes before a non-control index is parked
  backoffCapMs: number;   // ceiling for the exponential delay
}

export interface CrashState {
  rapid: number;          // consecutive rapid (unhealthy) crashes for this index
}

export interface RespawnDecision {
  action: "respawn" | "park";
  delayMs: number;        // 0 for park
  rapid: number;          // updated rapid count to persist back
}

export function decideRespawn(
  index: number,
  uptimeMs: number,
  prev: CrashState,
  cfg: RespawnConfig,
): RespawnDecision {
  const rapid = uptimeMs >= cfg.minHealthyMs ? 0 : prev.rapid + 1;
  // The control worker is essential — never permanently park it; it retries at
  // the capped delay. Any other index that keeps looping is parked.
  if (rapid >= cfg.maxRapid && index !== 0) {
    return { action: "park", delayMs: 0, rapid };
  }
  // 1s → 2 → 4 … capped. A healthy reset (rapid 0) respawns in the base 1s.
  const delayMs = Math.min(cfg.backoffCapMs, 1_000 * 2 ** Math.max(0, rapid - 1));
  return { action: "respawn", delayMs, rapid };
}
