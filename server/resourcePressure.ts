import fs from "fs";
import path from "path";
import { rawDb, forceWalTruncate } from "./db";
import { requestWalCheckpoint } from "./walMaintenance";
import { structuredLog } from "./structuredLog";

// ── Resource-pressure sentinel ───────────────────────────────────────────────
// The 38GB box has filled its disk twice (12GB WAL runaway 2026-07-23; image/
// backup accumulation before that). Past ~95% disk the WAL death-spiral locks
// in: a checkpoint must grow data.db, there is no disk, so every checkpoint
// fails and the WAL only grows. This sentinel measures GROUND TRUTH — free
// disk via fs.statfs plus the -wal/db file sizes — on a cadence, derives a
// pressure level with hysteresis, and publishes it to a single-row table that
// the admission coordinator reads on every poll:
//
//   warn      → loud log only
//   throttle  → scan concurrency/rate ceilings halved
//   pause     → only CRITICAL-priority checks admitted (field/manual/new-build)
//   emergency → nothing admitted, producers stop enqueueing, forced WAL
//               truncate each tick — recover BEFORE SQLite cannot checkpoint
//
// ANTI-WEDGE INVARIANT (learned from the persisted-403-halt incident that froze
// scanning at "0 checked" across restarts): the published level is NEVER a
// sticky flag. It is re-derived from live measurements every tick, and readers
// treat a row older than PRESSURE_TTL_MS as "normal" — a dead sampler or a
// restart can only ever FAIL OPEN.

export type PressureLevel = "normal" | "warn" | "throttle" | "pause" | "emergency";
export const PRESSURE_ORDER: Record<PressureLevel, number> = {
  normal: 0, warn: 1, throttle: 2, pause: 3, emergency: 4,
};

export interface PressureThresholds {
  // A level triggers when freeMb drops BELOW its floor OR walMb rises ABOVE its cap.
  warnFreeMb: number; throttleFreeMb: number; pauseFreeMb: number; emergencyFreeMb: number;
  warnWalMb: number; throttleWalMb: number; pauseWalMb: number; emergencyWalMb: number;
  // To DEMOTE a level, measurements must clear the trigger by these margins
  // (hysteresis — no flapping at a threshold edge).
  hysteresisFreeMb: number; hysteresisWalMb: number;
}

const num = (env: string | undefined, fallback: number) => {
  const v = Number(env);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function thresholdsFromEnv(env: NodeJS.ProcessEnv = process.env): PressureThresholds {
  return {
    warnFreeMb: num(env.PRESSURE_WARN_FREE_MB, 8192),
    throttleFreeMb: num(env.PRESSURE_THROTTLE_FREE_MB, 6144),
    pauseFreeMb: num(env.PRESSURE_PAUSE_FREE_MB, 4096),
    emergencyFreeMb: num(env.PRESSURE_EMERGENCY_FREE_MB, 2560),
    warnWalMb: num(env.PRESSURE_WARN_WAL_MB, 1536),
    throttleWalMb: num(env.PRESSURE_THROTTLE_WAL_MB, 2048),
    pauseWalMb: num(env.PRESSURE_PAUSE_WAL_MB, 3072),
    emergencyWalMb: num(env.PRESSURE_EMERGENCY_WAL_MB, 4096),
    hysteresisFreeMb: num(env.PRESSURE_HYSTERESIS_FREE_MB, 1024),
    hysteresisWalMb: num(env.PRESSURE_HYSTERESIS_WAL_MB, 256),
  };
}

// Raw level from measurements. Margins tighten the triggers: with positive
// margins a level fires EARLIER, which is exactly the "must be comfortably
// clear before demoting" test.
export function rawPressureLevel(
  freeMb: number, walMb: number, t: PressureThresholds, marginFreeMb = 0, marginWalMb = 0,
): PressureLevel {
  if (freeMb < t.emergencyFreeMb + marginFreeMb || walMb > t.emergencyWalMb - marginWalMb) return "emergency";
  if (freeMb < t.pauseFreeMb + marginFreeMb || walMb > t.pauseWalMb - marginWalMb) return "pause";
  if (freeMb < t.throttleFreeMb + marginFreeMb || walMb > t.throttleWalMb - marginWalMb) return "throttle";
  if (freeMb < t.warnFreeMb + marginFreeMb || walMb > t.warnWalMb - marginWalMb) return "warn";
  return "normal";
}

// Escalate immediately; demote only when clear of the CURRENT level by the
// hysteresis margins.
export function decidePressureLevel(
  freeMb: number, walMb: number, prev: PressureLevel, t: PressureThresholds,
): PressureLevel {
  const raw = rawPressureLevel(freeMb, walMb, t);
  if (PRESSURE_ORDER[raw] >= PRESSURE_ORDER[prev]) return raw;
  const clear = rawPressureLevel(freeMb, walMb, t, t.hysteresisFreeMb, t.hysteresisWalMb);
  return PRESSURE_ORDER[clear] < PRESSURE_ORDER[prev] ? clear : prev;
}

export const PRESSURE_TTL_MS = Math.max(60_000, num(process.env.PRESSURE_TTL_MS, 300_000));

export function ensurePressureTable(): void {
  rawDb.exec(`CREATE TABLE IF NOT EXISTS resource_pressure (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    level TEXT NOT NULL,
    free_mb INTEGER NOT NULL,
    wal_mb INTEGER NOT NULL,
    db_mb INTEGER NOT NULL,
    reason TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

export function publishPressure(
  level: PressureLevel, freeMb: number, walMb: number, dbMb: number, reason: string, nowMs = Date.now(),
): void {
  rawDb.prepare(`INSERT INTO resource_pressure (id, level, free_mb, wal_mb, db_mb, reason, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET level=excluded.level, free_mb=excluded.free_mb,
      wal_mb=excluded.wal_mb, db_mb=excluded.db_mb, reason=excluded.reason, updated_at=excluded.updated_at`)
    .run(level, Math.round(freeMb), Math.round(walMb), Math.round(dbMb), reason, nowMs);
}

// FAIL-OPEN read: missing table/row or a stale row (dead sampler, fresh boot)
// reads as "normal". Never let a stale artifact suppress scanning. The
// statement is prepared lazily and cached — this runs inside the admission
// poll transaction on every scan admission.
let readStmt: import("better-sqlite3").Statement | null = null;
export function readPressure(nowMs = Date.now()): { level: PressureLevel; stale: boolean } {
  try {
    readStmt ??= rawDb.prepare(`SELECT level, updated_at FROM resource_pressure WHERE id = 1`);
    const row = readStmt.get() as any;
    if (!row) return { level: "normal", stale: true };
    if (nowMs - Number(row.updated_at) > PRESSURE_TTL_MS) return { level: "normal", stale: true };
    const level = row.level as PressureLevel;
    return PRESSURE_ORDER[level] === undefined
      ? { level: "normal", stale: true }
      : { level, stale: false };
  } catch {
    return { level: "normal", stale: true };
  }
}

function severityFor(level: PressureLevel): "info" | "warn" | "error" {
  if (level === "normal") return "info";
  if (level === "warn" || level === "throttle") return "warn";
  return "error";
}

// One sampler per box — start it where the WAL guard runs (cluster primary /
// single process). Interval-driven, unref'd, kill-switch RESOURCE_SENTINEL=off.
export function startResourceSentinel(): NodeJS.Timeout | null {
  if (process.env.RESOURCE_SENTINEL === "off") return null;
  ensurePressureTable();
  const dataDir = process.env.DATA_DIR || process.cwd();
  const dbPath = path.join(dataDir, "data.db");
  const intervalMs = Math.max(10_000, num(process.env.RESOURCE_SENTINEL_MS, 30_000));
  const t = thresholdsFromEnv();
  let prev: PressureLevel = "normal";

  const tick = () => {
    try {
      const stat = fs.statfsSync(dataDir);
      const freeMb = (stat.bavail * stat.bsize) / 1_048_576;
      const sizeMb = (p: string) => { try { return fs.statSync(p).size / 1_048_576; } catch { return 0; } };
      const walMb = sizeMb(`${dbPath}-wal`);
      const dbMb = sizeMb(dbPath);
      const level = decidePressureLevel(freeMb, walMb, prev, t);
      const reason = level === "normal" ? "ok"
        : `freeMb=${Math.round(freeMb)} walMb=${Math.round(walMb)} thresholds(free<${t.pauseFreeMb}→pause) prev=${prev}`;
      publishPressure(level, freeMb, walMb, dbMb, reason);
      if (level !== prev || level !== "normal") {
        structuredLog("resource.pressure", {
          level, prev, freeMb: Math.round(freeMb), walMb: Math.round(walMb), dbMb: Math.round(dbMb), reason,
        }, severityFor(level));
      }
      // Emergency recovery: reclaim the WAL NOW — the whole point is to act
      // while SQLite still has the disk to complete a checkpoint.
      //
      // DELEGATED first. `emergency` latches while walMb > emergencyWalMb, so
      // this fires on EVERY tick (30s by default), and the checkpoint is
      // synchronous: run inline in a single-process deployment it blocks the web
      // server for as long as the reclaim takes, exactly the way the 120s guard
      // did before it was moved out. Measured on production 2026-08-10 after the
      // guard moved: /api/health still stalling 5-9s on a ~60s cadence, which
      // was this. Inline stays as the fallback, because on a box actually about
      // to run out of disk a blocking checkpoint beats no checkpoint.
      if (level === "emergency" && !requestWalCheckpoint("emergency")) {
        forceWalTruncate("emergency");
      }
      prev = level;
    } catch (e: any) {
      // A silent sampler is how the last guard failure hid — log every error.
      structuredLog("resource.sentinel_error", { error: e?.message ?? String(e) }, "error");
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof (timer as any).unref === "function") (timer as any).unref();
  return timer;
}
