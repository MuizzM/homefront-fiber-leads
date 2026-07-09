// ── Admin Diagnostics / Observability (Phase 2) ───────────────────────────────
// A calm operations panel — health score, categorized health cards, and the
// permission-denial + failure feeds — read from a server read-model over the
// activity stream. Gated on audit.read.org (manager+).

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

type Severity = "ok" | "info" | "warning" | "critical";
interface HealthCard { module: string; label: string; severity: Severity; value: number; hint: string }
interface DiagEvent { action: string; module: string; severity: Severity; at: string; userId: number | null; detail: string }
interface DiagnosticsModel {
  healthScore: number; windowHours: number; cards: HealthCard[];
  recentFailures: DiagEvent[]; recentDenials: DiagEvent[]; sensitiveActions: DiagEvent[];
  readModelAgeMs: number | null; readModelStale: boolean; totalEvents: number;
  appVersion?: string;
}

function ageLabel(ms: number | null): string {
  if (ms == null) return "no events yet";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SEV: Record<Severity, { dot: string; text: string; ring: string }> = {
  ok:       { dot: "#34d399", text: "text-emerald-400", ring: "border-emerald-500/25" },
  info:     { dot: "#60a5fa", text: "text-blue-400",    ring: "border-blue-500/20" },
  warning:  { dot: "#fbbf24", text: "text-amber-400",   ring: "border-amber-500/30" },
  critical: { dot: "#f87171", text: "text-red-400",     ring: "border-red-500/30" },
};

function scoreTone(n: number): Severity {
  return n >= 95 ? "ok" : n >= 80 ? "info" : n >= 60 ? "warning" : "critical";
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function FeedRow({ e }: { e: DiagEvent }) {
  const sev = SEV[e.severity];
  return (
    <div className="flex items-start gap-2.5 py-2 min-w-0">
      <span className="w-2 h-2 rounded-full shrink-0 mt-[5px]" style={{ background: sev.dot }} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium text-foreground truncate">{e.action}</span>
          <span className="text-[11px] text-muted-foreground shrink-0">{timeAgo(e.at)}</span>
        </div>
        <div className="text-[12px] text-muted-foreground truncate">{e.detail}</div>
      </div>
    </div>
  );
}

export default function Diagnostics() {
  const { data, isLoading, isError, refetch } = useQuery<DiagnosticsModel>({
    queryKey: ["/api/diagnostics"],
    queryFn: () => apiRequest("GET", "/api/diagnostics").then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const tone = data ? SEV[scoreTone(data.healthScore)] : SEV.ok;

  return (
    <div className="p-4 md:p-6 pb-24 md:pb-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-lg font-bold text-foreground">Diagnostics</h1>
        <p className="text-[13px] text-muted-foreground">
          Operations health · last {data?.windowHours ?? 24}h · {data?.totalEvents ?? 0} events
        </p>
      </div>

      {/* Health score + cards */}
      {isLoading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24 rounded-2xl" />)}
        </div>
      ) : isError ? (
        // NEVER render a healthy panel when the fetch failed — that falsely
        // reassures an admin during an actual outage.
        <div data-testid="diag-error" className="rounded-2xl border border-red-500/40 bg-red-500/10 p-5 text-center">
          <p className="text-sm font-semibold text-red-400">Couldn’t load diagnostics</p>
          <p className="mt-1 text-xs text-muted-foreground">The health API is unreachable — status below is unknown, not healthy.</p>
          <button onClick={() => refetch()} className="mt-3 inline-flex items-center rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/70">Retry</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div data-testid="diag-health-score" className={`rounded-2xl bg-card border ${tone.ring} p-4 flex flex-col justify-between`}>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">System health</span>
            <span className={`text-[32px] font-bold leading-none tabular-nums ${tone.text}`}>{data?.healthScore ?? "—"}</span>
          </div>
          {data?.cards.map((c, i) => {
            const sev = SEV[c.severity];
            return (
              <div key={i} data-testid={`diag-card-${c.label.toLowerCase().replace(/\s/g, "-")}`}
                className={`rounded-2xl bg-card border ${sev.ring} p-4 flex flex-col justify-between`}>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: sev.dot }} />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate">{c.label}</span>
                </div>
                <span className={`text-[26px] font-bold leading-none tabular-nums ${c.value ? sev.text : "text-foreground"}`}>{c.value}</span>
                <span className="text-[11px] text-muted-foreground leading-tight">{c.hint}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Two feeds: failures need action, denials are governance signal */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="rounded-2xl bg-card border border-border p-4">
          <h2 className="text-[13px] font-semibold text-foreground mb-1">Recent failures</h2>
          <div data-testid="diag-failures" className="divide-y divide-border/60">
            {isLoading ? <Skeleton className="h-8" /> :
              data && data.recentFailures.length > 0
                ? data.recentFailures.map((e, i) => <FeedRow key={i} e={e} />)
                : <p className="text-[13px] text-muted-foreground italic py-4">No failed operations — engines healthy.</p>}
          </div>
        </section>
        <section className="rounded-2xl bg-card border border-border p-4">
          <h2 className="text-[13px] font-semibold text-foreground mb-1">Permission denials</h2>
          <div data-testid="diag-denials" className="divide-y divide-border/60">
            {isLoading ? <Skeleton className="h-8" /> :
              data && data.recentDenials.length > 0
                ? data.recentDenials.map((e, i) => <FeedRow key={i} e={e} />)
                : <p className="text-[13px] text-muted-foreground italic py-4">No blocked actions — access looks correct.</p>}
          </div>
        </section>
      </div>

      {/* Sensitive / suspicious actions — the governance review feed */}
      <section className="rounded-2xl bg-card border border-border p-4">
        <h2 className="text-[13px] font-semibold text-foreground mb-1">Sensitive actions</h2>
        <p className="text-[11px] text-muted-foreground mb-1">Commission edits, lead assignments, and blocked attempts — for governance review.</p>
        <div data-testid="diag-sensitive" className="divide-y divide-border/60 max-h-72 overflow-y-auto overscroll-contain">
          {isLoading ? <Skeleton className="h-8" /> :
            data && data.sensitiveActions.length > 0
              ? data.sensitiveActions.map((e, i) => <FeedRow key={i} e={e} />)
              : <p className="text-[13px] text-muted-foreground italic py-4">No sensitive actions in this window.</p>}
        </div>
      </section>

      {/* Version + read-model freshness footer */}
      {data && (
        <div data-testid="diag-footer" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground pt-1">
          <span>App v{data.appVersion ?? "—"}</span>
          <span className={data.readModelStale ? "text-amber-400" : ""}>
            Last event {ageLabel(data.readModelAgeMs)}{data.readModelStale ? " · stream looks quiet" : ""}
          </span>
          <span>Auto-refreshes every 30s</span>
        </div>
      )}
    </div>
  );
}
