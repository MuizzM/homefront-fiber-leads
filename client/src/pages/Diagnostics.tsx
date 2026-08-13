// ── Admin Diagnostics / Observability (Phase 2) ───────────────────────────────
// A calm operations panel — health score, categorized health cards, and the
// permission-denial + failure feeds — read from a server read-model over the
// activity stream. Gated on audit.read.org (manager+).

import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, AlertTriangle, ShieldX } from "lucide-react";

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

// Semantic tokens only — teal stays reserved for the primary action + live signal.
const SEV: Record<Severity, { dot: string; text: string; pill: string; label: string }> = {
  ok:       { dot: "bg-success", text: "text-success", pill: "bg-success/10 text-success", label: "Healthy" },
  info:     { dot: "bg-info",     text: "text-info",     pill: "bg-info/10 text-info",         label: "Stable" },
  warning:  { dot: "bg-warning",   text: "text-warning",   pill: "bg-warning/10 text-warning",     label: "Degraded" },
  critical: { dot: "bg-destructive",    text: "text-destructive",    pill: "bg-destructive/10 text-destructive",       label: "Critical" },
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
    <div className="flex items-start gap-2.5 py-2.5 min-w-0">
      <span className={`w-2 h-2 rounded-full shrink-0 mt-[5px] ${sev.dot}`} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium text-foreground truncate">{e.action}</span>
          <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{timeAgo(e.at)}</span>
        </div>
        <div className="text-[12px] text-muted-foreground truncate">{e.detail}</div>
      </div>
    </div>
  );
}

// A sectioned readout — micro-labelled header + hairline-divided feed body.
function Feed({ title, subtitle, testid, isLoading, isError, items, empty }: {
  icon: typeof Activity; title: string; subtitle?: string; testid: string;
  isLoading: boolean; isError?: boolean; items?: DiagEvent[]; empty: string;
}) {
  return (
    <>
      <div className="flex items-center gap-2 px-4 pt-4">
        
        <div className="min-w-0">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
          {subtitle && <p className="text-[11px] text-muted-foreground/80 leading-tight">{subtitle}</p>}
        </div>
      </div>
      <div data-testid={testid} className="px-4 pb-2 mt-1 divide-y divide-border/60">
        {isLoading ? <Skeleton className="h-8 my-2" /> :
          // The same honesty rule as the health panel: a failed fetch must never
          // read as "no failures — engines healthy" mid-outage.
          isError ? <p className="text-[13px] text-muted-foreground py-4">Unknown - this feed didn't load.</p> :
          items && items.length > 0
            ? items.map((e, i) => <FeedRow key={i} e={e} />)
            : <p className="text-[13px] text-muted-foreground italic py-4">{empty}</p>}
      </div>
    </>
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
      <div className="flex items-center gap-2.5">
        
        <div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Diagnostics</h1>
          <p className="text-[12px] text-muted-foreground tabular-nums">
            Operations health · last {data?.windowHours ?? 24}h · {data?.totalEvents ?? 0} events
          </p>
        </div>
      </div>

      {/* Health score metric strip + categorized health cards */}
      {isLoading ? (
        <div className="space-y-5">
          <Skeleton className="h-20 rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        </div>
      ) : isError ? (
        // NEVER render a healthy panel when the fetch failed - that falsely
        // reassures an admin during an actual outage.
        <div data-testid="diag-error" className="rounded-xl border border-destructive/30 bg-destructive/[0.08] p-6 text-center">
          
          <p className="mt-2 text-sm font-semibold text-destructive">Couldn’t load diagnostics</p>
          <p className="mt-1 text-xs text-muted-foreground">The health API is unreachable - status below is unknown, not healthy.</p>
          <button onClick={() => refetch()} className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background">
             Retry
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Hairline-divided metric strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-xl overflow-hidden border border-border bg-border">
            <div data-testid="diag-health-score" className="bg-card p-4 flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">System health</span>
              <span className={`text-[32px] font-semibold leading-none tabular-nums ${tone.text}`}>{data?.healthScore ?? " - "}</span>
            </div>
            <div className="bg-card p-4 flex flex-col gap-1.5 justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
              <span className={`inline-flex items-center gap-1.5 self-start rounded-full px-2 py-0.5 text-[12px] font-medium ${tone.pill}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${tone.dot}`} />{tone.label}
              </span>
            </div>
            <div className="bg-card p-4 flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Events</span>
              <span className="text-[24px] font-semibold leading-none tabular-nums text-foreground">{data?.totalEvents ?? 0}</span>
              <span className="text-[11px] text-muted-foreground">last {data?.windowHours ?? 24}h</span>
            </div>
            <div className="bg-card p-4 flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Last event</span>
              <span className={`text-[15px] font-semibold leading-tight tabular-nums ${data?.readModelStale ? "text-warning" : "text-foreground"}`}>{ageLabel(data?.readModelAgeMs ?? null)}</span>
              {data?.readModelStale && <span className="text-[11px] text-warning">stream looks quiet</span>}
            </div>
          </div>

          {/* Categorized health cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {data?.cards.map((c, i) => {
              const sev = SEV[c.severity];
              return (
                <div key={i} data-testid={`diag-card-${c.label.toLowerCase().replace(/\s/g, "-")}`}
                  className="rounded-xl bg-card border border-border p-4 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sev.dot}`} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground truncate">{c.label}</span>
                  </div>
                  <span className={`text-[26px] font-semibold leading-none tabular-nums ${c.value ? sev.text : "text-foreground"}`}>{c.value}</span>
                  <span className="text-[11px] text-muted-foreground leading-tight">{c.hint}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Two feeds: failures need action, denials are governance signal */}
      <div className="grid md:grid-cols-2 gap-4">
        <section className="rounded-xl bg-card border border-border">
          <Feed icon={AlertTriangle} title="Recent failures" testid="diag-failures"
            isLoading={isLoading} isError={isError} items={data?.recentFailures}
            empty="No failed operations - engines healthy." />
        </section>
        <section className="rounded-xl bg-card border border-border">
          <Feed icon={ShieldX} title="Permission denials" testid="diag-denials"
            isLoading={isLoading} isError={isError} items={data?.recentDenials}
            empty="No blocked actions - access looks correct." />
        </section>
      </div>

      {/* Sensitive / suspicious actions - the governance review feed */}
      <section className="rounded-xl bg-card border border-border">
        <div className="flex items-center gap-2 px-4 pt-4">
          
          <div className="min-w-0">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Sensitive actions</h2>
            <p className="text-[11px] text-muted-foreground/80 leading-tight">Commission edits, lead assignments, and blocked attempts - for governance review.</p>
          </div>
        </div>
        <div data-testid="diag-sensitive" className="px-4 pb-2 mt-1 divide-y divide-border/60 max-h-72 overflow-y-auto overscroll-contain">
          {isLoading ? <Skeleton className="h-8 my-2" /> :
            isError ? <p className="text-[13px] text-muted-foreground py-4">Unknown - this feed didn't load.</p> :
            data && data.sensitiveActions.length > 0
              ? data.sensitiveActions.map((e, i) => <FeedRow key={i} e={e} />)
              : <p className="text-[13px] text-muted-foreground italic py-4">No sensitive actions in this window.</p>}
        </div>
      </section>

      {/* Version + read-model freshness footer */}
      {data && (
        <div data-testid="diag-footer" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground pt-1 tabular-nums">
          <span>App v{data.appVersion ?? " - "}</span>
          <span className={data.readModelStale ? "text-warning" : ""}>
            Last event {ageLabel(data.readModelAgeMs)}{data.readModelStale ? " · stream looks quiet" : ""}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-primary" />Auto-refreshes every 30s
          </span>
        </div>
      )}
    </div>
  );
}
