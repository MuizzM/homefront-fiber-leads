// ── Which processes consume scan runs ────────────────────────────────────────
// Run consumption = the boot resume passes, the 60 s reaper, and the run
// workers they dispatch. Atomic claimRunTargets makes it safe in every
// process, which is how the cluster was first wired ("the multi-core lever").
//
// Measured in production on 2026-08-22 with the slow-statement log, fifteen
// minutes after a deploy: every HTTP worker's reaper tick took 10 to 30 s, and
// the run workers' write transactions then queued on the one SQLite write
// lock - BEGIN IMMEDIATE ran 430 times for 571 s in total, up to 15 s each, all
// of it synchronous on request loops. With SCAN_GLOBAL_CONCURRENCY=1 the extra
// processes bought no throughput, only the contention.
//
// So under the cluster the control worker, which serves no HTTP, consumes alone
// unless SCAN_CONSUME_ROLE=all asks for every worker. Single-process and
// one-worker rigs are unchanged: there is nobody else to hand the work to.

import { resolveScanWorkerCount } from "./scanWorkers";

export interface ScanConsumeInput {
  /** resolveScanWorkerCount(): 0 = single process. */
  scanWorkers: number;
  /** HF_ROLE as set by the primary on fork: "control" | "scan" | undefined. */
  role: string | undefined;
  /** SCAN_CONSUME_ROLE: "control" (default) | "all". */
  consumeRole: string | undefined;
}

export function consumesScanRuns({ scanWorkers, role, consumeRole }: ScanConsumeInput): boolean {
  if (scanWorkers <= 1) return true;
  if (role === "control") return true;
  return String(consumeRole ?? "control").trim().toLowerCase() === "all";
}

/** The policy for THIS process, read from the same env the cluster fork sets. */
export function thisProcessConsumesScanRuns(): boolean {
  return consumesScanRuns({
    scanWorkers: resolveScanWorkerCount(),
    role: process.env.HF_ROLE,
    consumeRole: process.env.SCAN_CONSUME_ROLE,
  });
}
