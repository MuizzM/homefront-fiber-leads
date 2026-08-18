export interface ScanYieldCounters {
  found: number;
  checked: number;
  queued: number;
  checking: number;
  retrying: number;
  unresolved: number;
}

export type ScanYieldTone = "idle" | "processing" | "healthy" | "attention" | "degraded";

export interface ScanYieldSummary {
  tone: ScanYieldTone;
  title: string;
  completedPercent: number;
  unresolvedPercent: number;
}

const percent = (part: number, total: number) => total > 0
  ? Math.round((Math.max(0, part) / total) * 1_000) / 10
  : 0;

/** Pure, shared presentation policy for the live Decodo pipeline. */
export function summarizeScanYield(counters: ScanYieldCounters): ScanYieldSummary {
  const found = Math.max(0, Number(counters.found) || 0);
  const completedPercent = percent(counters.checked, found);
  const unresolvedPercent = percent(counters.unresolved, found);

  if (found === 0) return { tone: "idle", title: "Waiting for addresses", completedPercent, unresolvedPercent };
  if (unresolvedPercent >= 20) return { tone: "degraded", title: "Pipeline degraded", completedPercent, unresolvedPercent };
  if (unresolvedPercent >= 5) return { tone: "attention", title: "Pipeline needs attention", completedPercent, unresolvedPercent };
  if (counters.checked <= 0) return { tone: "processing", title: "Batch processing", completedPercent, unresolvedPercent };
  return { tone: "healthy", title: "Pipeline processing normally", completedPercent, unresolvedPercent };
}

export function summarizeEvidenceWorker(worker: {
  checked?: number | null;
  errors?: number | null;
} | null | undefined): { successful: number; errorPercent: number } {
  const checked = Math.max(0, Number(worker?.checked) || 0);
  const errors = Math.min(checked, Math.max(0, Number(worker?.errors) || 0));
  return {
    successful: checked - errors,
    errorPercent: percent(errors, checked),
  };
}
