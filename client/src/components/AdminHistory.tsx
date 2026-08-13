// ── Admin history — the operations console's record of who changed what ───────
// Reads the append-only admin_audit stream. Everything here is server state:
// filters live in the query key, so a refresh, a tab switch, or a re-login
// replays exactly the same view instead of resetting to a local default.
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { History, RefreshCw, ChevronLeft, ChevronRight, CheckCircle2, ShieldAlert, XCircle, ChevronDown, ChevronUp } from "lucide-react";

interface AuditRow {
  id: number; at: string; tenantId: number | null;
  actorUserId: number | null; actorName: string | null; actorRole: string | null;
  action: string; targetType: string | null; targetId: string | null; targetLabel: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null;
  requestId: string | null; outcome: string; reason: string | null; ip: string | null;
}
interface Feed { rows: AuditRow[]; total: number; limit: number; offset: number; scope: string }
interface Facets { actions: string[]; actors: Array<{ id: number; name: string }>; outcomes: string[]; canSeeAllTenants: boolean }

const PAGE = 25;

const OUTCOME_META: Record<string, { cls: string; Icon: typeof CheckCircle2; label: string }> = {
  success: { cls: "bg-success/10 text-success", Icon: CheckCircle2, label: "Success" },
  failure: { cls: "bg-destructive/10 text-destructive", Icon: XCircle, label: "Failed" },
  denied: { cls: "bg-warning/10 text-warning", Icon: ShieldAlert, label: "Denied" },
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// A change reads as "field: was → now". Values are already redacted server-side.
function DiffRows({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]));
  if (!keys.length) return <p className="text-[12px] text-muted-foreground">No field-level values recorded.</p>;
  const show = (v: unknown) =>
    v === undefined || v === null || v === "" ? " - " : typeof v === "object" ? JSON.stringify(v) : String(v);
  return (
    <dl className="grid gap-1.5">
      {keys.map((k) => (
        <div key={k} className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-0.5 text-[12px]">
          <dt className="font-medium text-muted-foreground truncate">{k}</dt>
          <dd className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className="rounded bg-destructive/[0.08] px-1.5 py-0.5 text-destructive/90 line-through break-all">{show(before?.[k])}</span>
            <span className="text-muted-foreground">to</span>
            <span className="rounded bg-success/[0.08] px-1.5 py-0.5 text-success/90 break-all">{show(after?.[k])}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Row({ entry }: { entry: AuditRow }) {
  const [open, setOpen] = useState(false);
  const meta = OUTCOME_META[entry.outcome] ?? OUTCOME_META.success;
  const detailId = `audit-detail-${entry.id}`;
  return (
    <li className="border-t border-border first:border-t-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={detailId}
        data-testid={`audit-row-${entry.id}`}
        className="w-full text-left px-3 py-3 sm:px-4 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-colors"
      >
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium ${meta.cls}`}>
            <span className="sr-only">Outcome: </span>{meta.label}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="font-mono text-[13px] font-semibold text-foreground break-all">{entry.action}</span>
              {entry.targetLabel && (
                <span className="text-[12px] text-muted-foreground truncate">· {entry.targetLabel}</span>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {entry.actorName ?? "System"}
              {entry.actorRole ? <span className="text-muted-foreground/70"> ({entry.actorRole})</span> : null}
              <span aria-hidden="true"> · </span>
              <time dateTime={entry.at}>{fmtWhen(entry.at)}</time>
            </div>
          </div>
          <span className="shrink-0 text-muted-foreground">
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
        </div>
      </button>
      {open && (
        <div id={detailId} className="bg-secondary/20 px-3 pb-3 pt-1 sm:px-4">
          <div className="space-y-2.5 sm:pl-[4.5rem]">
            <DiffRows before={entry.before} after={entry.after} />
            {entry.reason && (
              <p className="flex items-start gap-1.5 text-[12px] text-warning/90">
                {entry.reason}
              </p>
            )}
            <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {entry.targetType && (
                <div className="flex gap-1"><dt>Target</dt><dd className="font-mono text-foreground/80">{entry.targetType}#{entry.targetId ?? " - "}</dd></div>
              )}
              <div className="flex gap-1"><dt>Tenant</dt><dd className="font-mono text-foreground/80">{entry.tenantId ?? "platform"}</dd></div>
              {entry.requestId && (
                <div className="flex gap-1"><dt>Request</dt><dd className="font-mono text-foreground/80 break-all">{entry.requestId}</dd></div>
              )}
              {entry.ip && <div className="flex gap-1"><dt>IP</dt><dd className="font-mono text-foreground/80">{entry.ip}</dd></div>}
              <div className="flex gap-1"><dt>Exact time</dt><dd className="text-foreground/80">{new Date(entry.at).toLocaleString()}</dd></div>
            </dl>
          </div>
        </div>
      )}
    </li>
  );
}

export function AdminHistory() {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState(0);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setDebouncedQ(q.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(page * PAGE) });
    if (debouncedQ) p.set("q", debouncedQ);
    if (action) p.set("action", action);
    if (outcome) p.set("outcome", outcome);
    return p.toString();
  }, [debouncedQ, action, outcome, page]);

  const feed = useQuery<Feed>({
    queryKey: ["/api/admin/history", params],
    queryFn: () => apiRequest("GET", `/api/admin/history?${params}`).then((r) => r.json()),
    // Keep the previous page visible while the next loads — paging without a flash.
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const facets = useQuery<Facets>({
    queryKey: ["/api/admin/history/facets"],
    queryFn: () => apiRequest("GET", "/api/admin/history/facets").then((r) => r.json()),
    staleTime: 60_000,
  });

  const total = feed.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const filtered = Boolean(debouncedQ || action || outcome);

  return (
    <section className="rounded-xl border border-border bg-card" aria-labelledby="admin-history-heading">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            
            <h2 id="admin-history-heading" className="text-[15px] font-semibold tracking-tight text-foreground">History</h2>
          </div>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Every privileged change, append-only{feed.data?.scope === "platform" ? " · all tenants" : ""}
          </p>
        </div>
        <button
          onClick={() => feed.refetch()}
          disabled={feed.isFetching}
          data-testid="audit-refresh"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-secondary px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${feed.isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
          Refresh
        </button>
      </header>

      {/* Filters */}
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 min-w-0">
          
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search action, person, target…"
            aria-label="Search history"
            data-testid="audit-search"
            className="h-9 w-full rounded-lg border border-border bg-secondary pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:outline-none"
          />
        </div>
        <select
          value={action} onChange={(e) => { setAction(e.target.value); setPage(0); }}
          aria-label="Filter by action" data-testid="audit-filter-action"
          className="h-9 rounded-lg border border-border bg-secondary px-2.5 text-[13px] text-foreground focus:border-primary/60 focus:outline-none"
        >
          <option value="">All actions</option>
          {(facets.data?.actions ?? []).map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <select
          value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(0); }}
          aria-label="Filter by outcome" data-testid="audit-filter-outcome"
          className="h-9 rounded-lg border border-border bg-secondary px-2.5 text-[13px] text-foreground focus:border-primary/60 focus:outline-none"
        >
          <option value="">Any outcome</option>
          {(facets.data?.outcomes ?? ["success", "failure", "denied"]).map((o) => (
            <option key={o} value={o}>{OUTCOME_META[o]?.label ?? o}</option>
          ))}
        </select>
      </div>

      {/* Feed */}
      {feed.isLoading ? (
        <div className="divide-y divide-border" aria-busy="true" aria-label="Loading history">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex gap-3 px-4 py-3.5">
              <Skeleton className="h-5 w-16 rounded-full" />
              <div className="flex-1"><Skeleton className="h-4 w-2/3" /><Skeleton className="mt-2 h-3 w-1/3" /></div>
            </div>
          ))}
        </div>
      ) : feed.isError ? (
        <div className="px-4 py-8 text-center" data-testid="audit-error">
          <div className="text-[14px] font-semibold text-foreground">Couldn't load history</div>
          <p className="mt-1 text-[13px] text-muted-foreground">The record is safe - this is a read problem. Try again.</p>
          <button
            onClick={() => feed.refetch()}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-secondary px-4 text-[14px] font-semibold text-foreground"
          >
            Retry
          </button>
        </div>
      ) : (feed.data?.rows.length ?? 0) === 0 ? (
        <EmptyState
          testId="audit-empty"
          icon={History}
          title={filtered ? "No matching changes" : "No changes recorded yet"}
          description={filtered
            ? "Nothing matches these filters. Clear them to see the full record."
            : "Privileged changes - tenants, settings, access - appear here the moment they happen."}
          action={filtered ? (
            <button
              onClick={() => { setQ(""); setAction(""); setOutcome(""); setPage(0); }}
              data-testid="audit-clear-filters"
              className="inline-flex h-9 items-center rounded-lg border border-border bg-secondary px-3 text-[13px] font-medium text-foreground"
            >
              Clear filters
            </button>
          ) : undefined}
        />
      ) : (
        <ul className="list-none" data-testid="audit-list">
          {feed.data!.rows.map((entry) => <Row key={entry.id} entry={entry} />)}
        </ul>
      )}

      {/* Pagination */}
      {total > PAGE && (
        <nav className="flex items-center justify-between gap-3 border-t border-border px-4 py-3" aria-label="History pages">
          <p className="text-[12px] text-muted-foreground tabular-nums">
            {page * PAGE + 1}-{Math.min(total, (page + 1) * PAGE)} of {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page" data-testid="audit-prev"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary text-foreground disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-[12px] text-muted-foreground tabular-nums" aria-current="page">{page + 1} / {pages}</span>
            <button
              onClick={() => setPage((p) => (p + 1 < pages ? p + 1 : p))}
              disabled={page + 1 >= pages}
              aria-label="Next page" data-testid="audit-next"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-secondary text-foreground disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </nav>
      )}
    </section>
  );
}
