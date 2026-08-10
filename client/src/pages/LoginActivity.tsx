// ── Login Activity — admin/manager view of the tenant's auth trail ──────────
// Server scopes everything to the caller's org (super_admin sees all). Shows a
// per-email rollup (attempts/successes/failures/last seen) plus the raw feed
// with IP + user-agent + outcome reason.
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

type Attempt = {
  id: number; email: string; kind: "request" | "verify"; success: number;
  reason: string | null; ip: string | null; user_agent: string | null; created_at: string;
};
type SummaryRow = { email: string; attempts: number; successes: number; failures: number; last_at: string };

const REASON_LABEL: Record<string, { label: string; tone: string }> = {
  success: { label: "Logged in", tone: "text-success" },
  code_sent: { label: "Code sent", tone: "text-info" },
  code_created_mail_failed: { label: "Code created (email delayed)", tone: "text-warning" },
  bad_code: { label: "Wrong code", tone: "text-destructive" },
  unknown_email: { label: "Unknown email", tone: "text-destructive" },
  account_inactive: { label: "Inactive account", tone: "text-destructive" },
  rate_limited: { label: "Rate limited", tone: "text-warning" },
};

function reasonLabel(reason: string | null) {
  return REASON_LABEL[reason ?? ""] ?? { label: reason ?? " - ", tone: "text-muted-foreground" };
}

function timeLabel(iso: string): string {
  const t = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  const diff = Date.now() - t.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function LoginActivity() {
  const summaryQuery = useQuery<{ summary: SummaryRow[] }>({
    queryKey: ["/api/auth/login-attempts", "summary"],
    queryFn: async () => (await apiRequest("GET", "/api/auth/login-attempts?summary=1")).json(),
    staleTime: 30_000, retry: 1,
  });
  const feedQuery = useQuery<{ attempts: Attempt[] }>({
    queryKey: ["/api/auth/login-attempts"],
    queryFn: async () => (await apiRequest("GET", "/api/auth/login-attempts?limit=150")).json(),
    staleTime: 30_000, retry: 1,
  });

  const loading = summaryQuery.isLoading || feedQuery.isLoading;
  const failed = summaryQuery.isError || feedQuery.isError;

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Login activity</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Who tried to sign in, from where, and how it went - your organization only.</p>
        </div>
        <button
          type="button"
          onClick={() => { void summaryQuery.refetch(); void feedQuery.refetch(); }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-semibold hover:bg-secondary"
        >
           Refresh
        </button>
      </div>

      {failed ? (
        <div className="rounded-2xl border border-destructive/15 bg-destructive/[0.06] p-4 text-sm text-destructive">
          Couldn't load the audit trail. <button type="button" className="underline" onClick={() => { void summaryQuery.refetch(); void feedQuery.refetch(); }}>Retry</button>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          By email {summaryQuery.data ? `(${summaryQuery.data.summary.length})` : ""}
        </div>
        {loading ? (
          <div className="space-y-2 p-4">{[0,1,2].map(i => <div key={i} className="app-skeleton h-10 rounded-lg" />)}</div>
        ) : (summaryQuery.data?.summary.length ?? 0) === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No login activity recorded yet - rows appear as people request codes and sign in.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {summaryQuery.data!.summary.map(row => (
              <li key={row.email} className="flex items-center gap-3 px-4 py-3">
                {row.successes > 0
                  ? null
                  : null}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground">{row.email}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {row.attempts} attempt{row.attempts === 1 ? "" : "s"} · {row.successes} success · {row.failures} failed · last {timeLabel(row.last_at)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Recent attempts {feedQuery.data ? `(${feedQuery.data.attempts.length})` : ""}
        </div>
        {loading ? (
          <div className="space-y-2 p-4">{[0,1,2,3].map(i => <div key={i} className="app-skeleton h-8 rounded-lg" />)}</div>
        ) : (feedQuery.data?.attempts.length ?? 0) === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {feedQuery.data!.attempts.map(a => {
              const r = reasonLabel(a.reason);
              return (
                <li key={a.id} className="px-4 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-[13px] font-medium text-foreground">{a.email}</span>
                    <span className={`shrink-0 text-[11px] font-semibold ${r.tone}`}>{r.label}</span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {a.kind} · {timeLabel(a.created_at)}{a.ip ? ` · ${a.ip}` : ""}{a.user_agent ? ` · ${a.user_agent.slice(0, 60)}` : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
