import os from "node:os";

// ONE source of truth for the scan-cluster worker count (index.ts boot branch,
// db.ts per-connection cache sizing, scanner.ts token-warm division — three
// parsers had already drifted once).
//   "auto"  → every vCPU detected at boot (availableParallelism respects container
//             CPU limits). Deliberately ALL cores, not cores-1: the cluster primary
//             is a near-idle supervisor, Caddy uses <1% of a core, and every worker
//             serves HTTP, so there is no single event loop to protect — the box is
//             paid for to scan. A resize rescales the cluster with no config change.
//   integer → pinned worker count.
//   0/unset → single-process (the kill-switch; byte-for-byte pre-cluster behavior).
export function resolveScanWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  if (env.SCAN_WORKERS === "auto") {
    return Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  }
  return Math.max(0, Math.floor(Number(env.SCAN_WORKERS ?? 0) || 0));
}
