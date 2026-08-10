// ── Where the WAL guard runs ─────────────────────────────────────────────────
// One decision, in one place: the checkpoint blocks, so it must not block a
// process that answers requests.
//
//   SCAN_WORKERS > 0   -> the cluster PRIMARY already runs it in-process, and
//                         that is correct: the primary serves no HTTP. This
//                         module is not involved.
//   SCAN_WORKERS === 0 -> no primary exists and this process IS the web server.
//                         Fork a dedicated maintenance child (below).
//   no child available -> dev/test only. Fall back in-process, and say so.
//
// See docs/architecture/BULK_ASSIGNMENT.md for the incident this came from.
import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { walLog } from "./walGuard";

export type WalMaintenanceMode = "child" | "in-process" | "off";

/** Rapid-exit backoff, same shape as the cluster's worker supervisor: a child
 *  that dies immediately is misconfigured, and respawning it every second pegs
 *  the box and floods the log ring the perf report reads from. */
const MIN_HEALTHY_MS = 60_000;
const MAX_RAPID_EXITS = 8;
const BACKOFF_CAP_MS = 60_000;

let child: ChildProcess | null = null;
let stopping = false;

/**
 * Resolve the bundled maintenance entry.
 *
 * Production runs `node dist/index.cjs` from WORKDIR /app, so the sibling is
 * dist/wal-maintenance.cjs. `__dirname` exists in the CJS bundle but NOT under
 * `npm run dev` (ESM via tsx), where referencing it throws - the same trap
 * cspHashes.ts documents, so it is guarded the same way.
 */
function resolveChildEntry(): string | null {
  const override = process.env.WAL_MAINTENANCE_ENTRY;
  const candidates = [
    ...(override ? [override] : []),
    ...(typeof __dirname === "string" ? [path.join(__dirname, "wal-maintenance.cjs")] : []),
    path.join(process.cwd(), "dist", "wal-maintenance.cjs"),
  ];
  for (const candidate of candidates) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

function spawnChild(entry: string, rapidExits: number): void {
  if (stopping) return;
  const startedAt = Date.now();
  // execArgv: [] so the child never inherits an --inspect port from the parent
  // (two processes cannot bind the same one, and the child would die at boot).
  // stdio inherited so its structured logs land in the same docker json-file
  // ring perf-report.yml reads.
  // stdio spelled out rather than "inherit" so the IPC channel is explicit:
  // requestWalCheckpoint() below depends on it, and a silently missing channel
  // would degrade the emergency reclaim back to blocking the web server.
  child = fork(entry, [], { execArgv: [], stdio: ["inherit", "inherit", "inherit", "ipc"] });

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    // A clean exit is intentional: the child stands down by design when
    // WAL_GUARD=off or Litestream owns checkpointing. Do not respawn it.
    if (code === 0 && !signal) {
      walLog("db.wal_maintenance_stood_down", { code, signal: signal ?? null });
      return;
    }
    const livedMs = Date.now() - startedAt;
    const rapid = livedMs < MIN_HEALTHY_MS ? rapidExits + 1 : 0;
    if (rapid > MAX_RAPID_EXITS) {
      // PARKED, and loudly. An unattended WAL is the 2026-07-23 disk-full
      // incident, and a silent catch is exactly how that one hid.
      walLog("db.wal_maintenance_parked", {
        code, signal: signal ?? null, rapidExits: rapid,
        impact: "WAL is no longer being checkpointed - watch disk",
      });
      return;
    }
    const delay = rapid === 0 ? 1_000 : Math.min(BACKOFF_CAP_MS, 1_000 * 2 ** (rapid - 1));
    walLog("db.wal_maintenance_restarting", { code, signal: signal ?? null, livedMs, rapidExits: rapid, delayMs: delay });
    const t = setTimeout(() => spawnChild(entry, rapid), delay);
    if (typeof t.unref === "function") t.unref();
  });

  child.on("error", (e: any) => {
    walLog("db.wal_maintenance_error", { error: e?.message ?? String(e) });
  });
}

/**
 * Start WAL maintenance for a SINGLE-PROCESS deployment. Safe to call once at
 * boot; returns the mode actually used so the caller can log it.
 *
 * The in-process fallback is a dev convenience, not a production path: a dev
 * database never approaches the 512MB threshold, so the guard there never
 * actually fires. If it ever does fire in production because the bundle is
 * missing, the log line says so in as many words.
 */
export function startWalMaintenance(): WalMaintenanceMode {
  if (process.env.WAL_GUARD === "off") {
    walLog("db.wal_maintenance_disabled", { reason: "WAL_GUARD=off" });
    return "off";
  }

  const entry = resolveChildEntry();
  if (entry) {
    spawnChild(entry, 0);
    walLog("db.wal_maintenance_mode", { mode: "child", entry });
    return "child";
  }

  walLog("db.wal_maintenance_mode", {
    mode: "in-process",
    reason: "dist/wal-maintenance.cjs not found",
    warning: "checkpoints will block this process; expected in dev only",
  });
  return "in-process";
}

/**
 * Ask the maintenance process to reclaim the WAL RIGHT NOW.
 *
 * The resource sentinel's emergency path used to call forceWalTruncate()
 * directly. In a single-process deployment that is the identical defect this
 * module exists to fix, just on a 30s timer instead of a 120s one: emergency
 * fires while walMb > PRESSURE_EMERGENCY_WAL_MB (4096 by default), so it can
 * block the web server on EVERY tick for as long as the checkpoint takes.
 *
 * Delegating keeps the urgency and drops the blocking. Returns false when there
 * is no child to delegate to, and only then should the caller reclaim inline -
 * on a box genuinely about to run out of disk, a blocking checkpoint is still
 * better than no checkpoint.
 */
export function requestWalCheckpoint(reason: string): boolean {
  if (!child || child.killed || !child.connected) return false;
  try {
    child.send({ type: "checkpoint", reason });
    return true;
  } catch {
    return false; // channel closed between the check and the send
  }
}

/** Forward shutdown to the child so a deploy cutover does not leave it orphaned
 *  holding a connection to the database the new container is about to open. */
export function stopWalMaintenance(): void {
  stopping = true;
  if (child && !child.killed) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  child = null;
}
