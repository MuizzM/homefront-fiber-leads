// ── MP Box scan panel ────────────────────────────────────────────────────────
//
// The compact status area for an area/box scan, plus the two filters the
// operator asked for. Every number here is READ FROM SQLITE
// (mpbox_scan_results), never from an in-memory job and never derived in the
// client - which is the point of the whole change: what a filter chip claims is
// exactly what the filter can return.
//
// Design contract lives in .agent/plans/mpbox-scan-filters.md. The parts that
// constrain this file:
//   - the scan action stays primary; filters are secondary and never outrank it
//   - both filters selected means AND (documented decision, not an accident)
//   - filters live in the URL so a filtered view can be linked and restored
//   - a cached row is visually distinct from one this run classified, because
//     trusting a stale answer is the operator's call to make knowingly
//   - no card grid, no gradients, no decorative chart, no fabricated number
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStoredSessionId } from "@/lib/queryClient";

export interface MpboxStats {
  discovered: number; eligible: number; processed: number; matched: number;
  tenured: number; freshFiber: number; both: number;
  new: number; changed: number; unchanged: number;
  skippedFromCache: number; staleRescanned: number; duplicatesRemoved: number;
  succeeded: number; failed: number; cancelled: number;
  cacheHitPct: number; elapsedMs: number;
}
export interface MpboxCounts { total: number; tenured: number; freshFiber: number; both: number; neither: number }
export interface MpboxRow {
  targetId: number; address: string; city: string;
  tenured: boolean | null; freshFiber: boolean | null; outcome: string; error: string | null;
}

/** The states this surface must be able to reach, named rather than implied. */
export type PanelState =
  | "initial"            // nothing drawn or scanned yet
  | "no_history"         // first ever use: no completed scan exists
  | "scanning"
  | "resumed"            // picked an interrupted scan back up
  | "success"
  | "partial_failure"    // some records failed, the rest are trustworthy
  | "complete_failure"
  | "cancelled"
  | "insufficient_data"; // the scan ran but nothing could be classified

const authHeaders = (): Record<string, string> => {
  const sid = getStoredSessionId();
  return sid ? { "x-session-id": sid } : {};
};

const fmtDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
const fmtWhen = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const t = Date.parse(String(iso).replace(" ", "T") + (String(iso).endsWith("Z") ? "" : "Z"));
  if (!Number.isFinite(t)) return "unknown";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** Derive the panel state from persisted facts, never from a spinner flag. */
export function derivePanelState(o: {
  scanning: boolean; resumed?: boolean; hasHistory: boolean;
  stats: MpboxStats | null; status?: string | null;
}): PanelState {
  if (o.scanning) return o.resumed ? "resumed" : "scanning";
  if (!o.stats) return o.hasHistory ? "initial" : "no_history";
  if (o.status === "cancelled" || o.stats.cancelled > 0) return "cancelled";
  if (o.stats.succeeded === 0 && o.stats.failed > 0) return "complete_failure";
  if (o.stats.failed > 0) return "partial_failure";
  if (o.stats.processed > 0 && o.stats.matched === 0 && o.stats.tenured === 0 && o.stats.freshFiber === 0
      && o.stats.succeeded === 0) return "insufficient_data";
  return "success";
}

export interface MpBoxScanPanelProps {
  scanId: string | null;
  scanning: boolean;
  resumed?: boolean;
  /** The scan action is owned by the map, not by this panel. */
  onStop?: () => void;
  onRescan?: () => void;
  onSelectDoor?: (targetId: number) => void;
}

export default function MpBoxScanPanel({
  scanId, scanning, resumed, onStop, onRescan, onSelectDoor,
}: MpBoxScanPanelProps) {
  // Filters in the URL: a filtered view is linkable and survives a reload.
  const readFilters = () => {
    if (typeof window === "undefined") return { tenured: false, freshFiber: false };
    const p = new URLSearchParams(window.location.search);
    return { tenured: p.get("tenured") === "1", freshFiber: p.get("fresh") === "1" };
  };
  const [filters, setFilters] = useState(readFilters);
  const [stats, setStats] = useState<MpboxStats | null>(null);
  const [counts, setCounts] = useState<MpboxCounts | null>(null);
  const [meta, setMeta] = useState<{ status?: string; completedAt?: string | null } | null>(null);
  const [rows, setRows] = useState<MpboxRow[]>([]);
  const [nextAfter, setNextAfter] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasHistory, setHasHistory] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const setFilter = useCallback((key: "tenured" | "freshFiber", on: boolean) => {
    setFilters((f) => {
      const next = { ...f, [key]: on };
      if (typeof window !== "undefined") {
        const p = new URLSearchParams(window.location.search);
        if (next.tenured) p.set("tenured", "1"); else p.delete("tenured");
        if (next.freshFiber) p.set("fresh", "1"); else p.delete("fresh");
        window.history.replaceState(null, "", `${window.location.pathname}${p.toString() ? `?${p}` : ""}`);
      }
      return next;
    });
  }, []);
  const clearAll = useCallback(() => {
    setFilters({ tenured: false, freshFiber: false });
    if (typeof window !== "undefined") {
      const p = new URLSearchParams(window.location.search);
      p.delete("tenured"); p.delete("fresh");
      window.history.replaceState(null, "", `${window.location.pathname}${p.toString() ? `?${p}` : ""}`);
    }
  }, []);

  // Stats + counts for the active (or latest) scan.
  useEffect(() => {
    let cancelled = false;
    const url = scanId ? `/api/scan/mpbox/${encodeURIComponent(scanId)}/stats` : `/api/scan/mpbox/latest`;
    (async () => {
      try {
        const r = await fetch(url, { headers: authHeaders() });
        if (!r.ok) throw new Error(`stats ${r.status}`);
        const b = await r.json();
        if (cancelled) return;
        if (b.reason === "no_history") { setHasHistory(false); setStats(null); setCounts(null); return; }
        setHasHistory(true);
        setStats(b.stats ?? null);
        setCounts(b.counts ?? null);
        setMeta({ status: b.status, completedAt: b.completedAt });
        setLoadError(null);
      } catch (e: any) {
        if (!cancelled) setLoadError(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [scanId, scanning]);

  // Result rows for the current filter.
  const loadRows = useCallback(async (after?: number) => {
    if (!scanId) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const p = new URLSearchParams();
    if (filters.tenured) p.set("tenured", "1");
    if (filters.freshFiber) p.set("fresh", "1");
    if (after != null) p.set("after", String(after));
    try {
      const r = await fetch(`/api/scan/mpbox/${encodeURIComponent(scanId)}/results?${p}`,
        { headers: authHeaders(), signal: ac.signal });
      if (!r.ok) throw new Error(`results ${r.status}`);
      const b = await r.json();
      setRows((prev) => (after == null ? b.results : [...prev, ...b.results]));
      setNextAfter(b.nextAfter ?? null);
      setLoadError(null);
    } catch (e: any) {
      if (e?.name !== "AbortError") setLoadError(String(e?.message ?? e));
    }
  }, [scanId, filters.tenured, filters.freshFiber]);

  useEffect(() => { void loadRows(); }, [loadRows]);

  const state = derivePanelState({ scanning, resumed, hasHistory, stats, status: meta?.status });
  const anyFilter = filters.tenured || filters.freshFiber;
  // The count the chips show comes from the persisted rows, so it always equals
  // what the list can return. Both on = AND, which is the documented decision.
  const shownCount = useMemo(() => {
    if (!counts) return null;
    if (filters.tenured && filters.freshFiber) return counts.both;
    if (filters.tenured) return counts.tenured;
    if (filters.freshFiber) return counts.freshFiber;
    return counts.total;
  }, [counts, filters.tenured, filters.freshFiber]);

  // One atomic, contextual status for assistive tech - never a bare number, and
  // it never moves focus.
  const liveMessage = scanning && stats
    ? `Scanning. ${stats.processed} of ${stats.eligible} processed, ${stats.tenured} tenured, ${stats.freshFiber} fresh fiber.`
    : stats
      ? `Scan ${state === "cancelled" ? "cancelled" : "complete"}. ${stats.processed} processed, ${stats.tenured} tenured, ${stats.freshFiber} fresh fiber, ${stats.failed} failed.`
      : "";

  return (
    <section
      className="text-white"
      aria-label="Area scan results"
      aria-busy={scanning || undefined}
      data-testid="mpbox-panel"
      data-state={state}
    >
      <p className="sr-only" role="status" aria-live="polite" data-testid="mpbox-live">{liveMessage}</p>

      {/* ── status strip. Two columns on small screens, six from sm up: a
          shrunken six-across is unreadable on a phone. ───────────────────── */}
      {stats && (
        <dl
          className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-6"
          data-testid="mpbox-stats"
        >
          <Stat label="Processed" value={`${stats.processed}/${stats.eligible}`} testId="stat-processed" />
          <Stat label="Tenured" value={stats.tenured} testId="stat-tenured" />
          <Stat label="Fresh fiber" value={stats.freshFiber} testId="stat-fresh" />
          <Stat label="From cache" value={stats.skippedFromCache} testId="stat-cached" />
          <Stat label="Failed" value={stats.failed} testId="stat-failed"
            tone={stats.failed > 0 ? "warn" : undefined} />
          <Stat label="Elapsed" value={fmtDuration(stats.elapsedMs)} testId="stat-elapsed" />
        </dl>
      )}

      <p className="mt-1.5 text-2xs leading-tight text-white/45" data-testid="mpbox-last-scan">
        {state === "no_history"
          ? "No area scan has been run yet."
          : `Last completed scan ${fmtWhen(meta?.completedAt)}`}
      </p>

      {/* ── filters. Real checkboxes with visible labels, wrapping rather than
          clipping, 44px targets. ──────────────────────────────────────────── */}
      {stats && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="mpbox-filters">
          <FilterToggle
            id="mpbox-filter-tenured" label="Tenured" count={counts?.tenured}
            checked={filters.tenured} onChange={(v) => setFilter("tenured", v)}
          />
          <FilterToggle
            id="mpbox-filter-fresh" label="Fresh fiber" count={counts?.freshFiber}
            checked={filters.freshFiber} onChange={(v) => setFilter("freshFiber", v)}
          />
          {anyFilter && (
            <button
              type="button" onClick={clearAll}
              className="h-11 rounded-full px-3 text-[12px] font-semibold text-white/60 underline-offset-2 transition hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              data-testid="mpbox-clear-filters"
            >
              Clear filters
            </button>
          )}
          {filters.tenured && filters.freshFiber && (
            <span className="text-2xs text-white/45" data-testid="mpbox-and-note">
              showing doors that are both
            </span>
          )}
        </div>
      )}

      {/* ── the states ─────────────────────────────────────────────────────── */}
      {loadError && (
        <Notice tone="error" testId="mpbox-error">
          Could not load scan results ({loadError}).{" "}
          <button type="button" onClick={() => void loadRows()} className="h-11 underline focus-visible:outline focus-visible:outline-2" data-testid="mpbox-retry">
            Try again
          </button>
        </Notice>
      )}
      {state === "no_history" && !loadError && (
        <Notice tone="info" testId="mpbox-no-history">
          Draw a box on the map to scan the addresses inside it.
        </Notice>
      )}
      {state === "cancelled" && (
        <Notice tone="warn" testId="mpbox-cancelled">
          Scan cancelled. {stats?.processed ?? 0} records were saved and will be reused.{" "}
          {onRescan && <button type="button" onClick={onRescan} className="h-11 underline" data-testid="mpbox-resume">Run it again</button>}
        </Notice>
      )}
      {state === "partial_failure" && (
        <Notice tone="warn" testId="mpbox-partial">
          {stats?.failed} of {stats?.processed} records did not answer. The rest are saved.{" "}
          {onRescan && <button type="button" onClick={onRescan} className="h-11 underline" data-testid="mpbox-retry-failed">Retry them</button>}
        </Notice>
      )}
      {state === "complete_failure" && (
        <Notice tone="error" testId="mpbox-failed">
          No record could be checked. This is usually the provider, not the box.{" "}
          {onRescan && <button type="button" onClick={onRescan} className="h-11 underline" data-testid="mpbox-retry-all">Try again</button>}
        </Notice>
      )}
      {state === "insufficient_data" && (
        <Notice tone="info" testId="mpbox-insufficient">
          The scan ran, but no record carried enough information to classify. Nothing is being guessed.
        </Notice>
      )}
      {state === "resumed" && (
        <Notice tone="info" testId="mpbox-resumed">
          Resuming the previous scan. Records already saved are not being re-checked.
        </Notice>
      )}

      {/* ── results ────────────────────────────────────────────────────────── */}
      {stats && rows.length === 0 && anyFilter && !loadError && (
        <Notice tone="info" testId="mpbox-zero-matches">
          No doors match {filters.tenured && filters.freshFiber ? "both filters" : filters.tenured ? "Tenured" : "Fresh fiber"}.{" "}
          <button type="button" onClick={clearAll} className="h-11 underline" data-testid="mpbox-zero-clear">Clear filters</button>
        </Notice>
      )}

      {rows.length > 0 && (
        <>
          <p className="mt-3 text-2xs text-white/55" data-testid="mpbox-shown">
            {shownCount != null ? `${shownCount} door${shownCount === 1 ? "" : "s"}` : `${rows.length} doors`}
            {anyFilter ? " matching" : " scanned"}
          </p>
          {/* Tables overflow on mobile: scroll the table, never the page. */}
          <div className="mt-1.5 max-h-64 overflow-x-auto overflow-y-auto rounded-lg border border-white/10">
            <table className="w-full text-left text-[12px]" data-testid="mpbox-table">
              <thead className="sticky top-0 bg-overlay text-2xs uppercase tracking-wide text-white/50">
                <tr>
                  <th scope="col" className="px-2.5 py-1.5 font-semibold">Address</th>
                  <th scope="col" className="px-2.5 py-1.5 font-semibold">Result</th>
                  <th scope="col" className="px-2.5 py-1.5 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.targetId} className="border-t border-white/5">
                    <td className="px-2.5 py-1.5">
                      {onSelectDoor ? (
                        <button
                          type="button" onClick={() => onSelectDoor(r.targetId)}
                          className="text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
                        >
                          {r.address}
                        </button>
                      ) : r.address}
                      <span className="block text-2xs text-white/40">{r.city}</span>
                    </td>
                    <td className="px-2.5 py-1.5">
                      {r.tenured && <Tag testId="tag-tenured">Tenured</Tag>}
                      {r.freshFiber && <Tag testId="tag-fresh" tone="fresh">Fresh fiber</Tag>}
                      {!r.tenured && !r.freshFiber && (
                        <span className="text-white/45">{r.outcome === "failed" ? "Did not answer" : "Neither"}</span>
                      )}
                    </td>
                    <td className="px-2.5 py-1.5 text-white/45">
                      {/* Cached vs freshly classified, stated plainly - the
                          operator decides whether a stale answer is good enough. */}
                      {r.outcome === "cache_hit" ? "Cached" : r.outcome === "classified" ? "This scan" : r.outcome}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {nextAfter != null && (
            <button
              type="button" onClick={() => void loadRows(nextAfter)}
              className="mt-2 h-11 w-full rounded-lg border border-white/10 text-[12px] font-semibold text-white/70 transition hover:bg-white/5 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70"
              data-testid="mpbox-load-more"
            >
              Load more
            </button>
          )}
        </>
      )}

      {scanning && onStop && (
        <button
          type="button" onClick={onStop}
          className="mt-3 h-11 rounded-full px-4 text-[12px] font-semibold text-red-300 transition hover:bg-red-500/10 hover:text-red-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-300"
          data-testid="mpbox-stop"
        >
          Stop scan
        </button>
      )}
    </section>
  );
}

function Stat({ label, value, testId, tone }: { label: string; value: string | number; testId: string; tone?: "warn" }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-2xs uppercase tracking-wide text-white/45">{label}</dt>
      <dd className={`text-[13px] font-semibold tabular-nums ${tone === "warn" ? "text-amber-300" : "text-white"}`} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function FilterToggle({ id, label, count, checked, onChange }: {
  id: string; label: string; count?: number; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className={`inline-flex h-11 cursor-pointer items-center gap-2 rounded-full px-3 text-[12px] font-semibold transition focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-white/70 ${
        checked ? "bg-white/15 text-white" : "text-white/65 hover:bg-white/10 hover:text-white"
      }`}
    >
      <input
        id={id} type="checkbox" checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-emerald-400"
        data-testid={id}
      />
      <span>{label}</span>
      {typeof count === "number" && <span className="tabular-nums text-white/50">{count}</span>}
    </label>
  );
}

function Tag({ children, tone, testId }: { children: React.ReactNode; tone?: "fresh"; testId: string }) {
  return (
    <span
      className={`mr-1 inline-block rounded px-1.5 py-0.5 text-2xs font-semibold ${
        tone === "fresh" ? "bg-emerald-400/15 text-emerald-200" : "bg-sky-400/15 text-sky-200"
      }`}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function Notice({ children, tone, testId }: { children: React.ReactNode; tone: "info" | "warn" | "error"; testId: string }) {
  const cls = tone === "error" ? "text-red-200" : tone === "warn" ? "text-amber-200" : "text-white/60";
  return <p className={`mt-3 text-[12px] leading-snug ${cls}`} data-testid={testId}>{children}</p>;
}
