/**
 * SSE scan-stream connection caps (SEC-B).
 *
 * GET /api/scan/stream/:jobId holds one socket + one 1s interval per watcher
 * for the life of a scan. Without a bound, one account (or a script replaying
 * a stolen session token) could open thousands of streams and pin the event
 * loop / socket table. Policy:
 *   • per-user cap  — one manager never needs more than a few live streams
 *     (default 5; phone + laptop + a spare).
 *   • global cap    — the process never serves more than N concurrent streams
 *     (default 100).
 *   • max duration  — a stream auto-closes after MAX_DURATION with an explicit
 *     `reconnect` event so well-behaved clients re-subscribe instead of a
 *     zombie connection living forever (default 30 minutes).
 *
 * Pure bookkeeping, no Express types — unit-testable without a live socket.
 */

export interface SseCapsOptions {
  perUser: number;
  global: number;
  maxDurationMs: number;
}

export interface SseGrant {
  release: () => void;
}

export type SseAcquireResult =
  | { ok: true; grant: SseGrant }
  | { ok: false; reason: "user_cap" | "global_cap" };

export function sseCapsFromEnv(): SseCapsOptions {
  const num = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    perUser: num(process.env.SCAN_SSE_PER_USER_CAP, 5),
    global: num(process.env.SCAN_SSE_GLOBAL_CAP, 100),
    maxDurationMs: num(process.env.SCAN_SSE_MAX_DURATION_MS, 30 * 60 * 1000),
  };
}

export class SseConnectionCaps {
  private byUser = new Map<string, number>();
  private total = 0;

  constructor(public readonly options: SseCapsOptions = sseCapsFromEnv()) {}

  get activeConnections(): number {
    return this.total;
  }

  activeFor(userKey: string): number {
    return this.byUser.get(userKey) ?? 0;
  }

  tryAcquire(userKey: string): SseAcquireResult {
    if (this.total >= this.options.global) return { ok: false, reason: "global_cap" };
    const current = this.byUser.get(userKey) ?? 0;
    if (current >= this.options.perUser) return { ok: false, reason: "user_cap" };
    this.byUser.set(userKey, current + 1);
    this.total++;
    let released = false;
    return {
      ok: true,
      grant: {
        release: () => {
          if (released) return; // close + timeout can both fire — count once
          released = true;
          const left = (this.byUser.get(userKey) ?? 1) - 1;
          if (left <= 0) this.byUser.delete(userKey);
          else this.byUser.set(userKey, left);
          this.total = Math.max(0, this.total - 1);
        },
      },
    };
  }
}

/** Process-wide singleton used by the scan-stream route. */
export const scanSseCaps = new SseConnectionCaps();
