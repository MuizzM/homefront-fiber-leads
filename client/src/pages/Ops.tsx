// ── Operations command center ─────────────────────────────────────────────────
// The manager triage surface: eight deterministic queues, each carrying the
// EXACT rule the server ran (rendered verbatim under the title - nothing here
// is a score or an insight, every row is a record with a reason). Actions
// reuse the existing gated seams: bulk-assign (which now returns the same
// 10-minute put-back token the lasso has), dismiss-with-reason (audited,
// auto-lapsing), and opening the lead record. The workload tab is a
// distribution to balance by eye - the server says outright it is not a
// capacity score, and so does this page.
import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { PageHeader } from "@/components/ui/page-scaffold";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ErrorState";
import { RejectReasonDialog } from "@/components/RejectReasonDialog";
import { RepDialogSelect } from "@/components/people/RepDialogSelect";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { FOCUS } from "@/lib/a11y";

interface QueueSummary {
  key: string; label: string; rule: string; count: number;
  managerOnly: boolean; dismissible: boolean;
}
interface LeadRow {
  id: number; address: string; city: string | null; state: string | null;
  leadStatus: string; assignedRepId: number | null; repName: string | null;
  assignedAt: string | null; lastOutcomeAt: string | null;
  leadScore: number | null; buyerScore: number | null;
  callbackDate?: string | null; reason: string;
}
interface ActivityRow { id: number; action: string; at: string; updated: number | null; skipped: number | null; reason: string }
interface QueuePayload {
  key: string; label: string; rule: string; total: number; limit: number;
  entityKind: "lead" | "activity"; dismissible: boolean; rows: Array<LeadRow | ActivityRow>;
}
interface WorkloadRow {
  repId: number; name: string; onShift: boolean; activeLeads: number;
  unworked: number; overdueFollowUps: number; areasHeld: number; areaCap: number;
  lastActivityAt: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect", contacted: "Contacted", interested: "Interested",
  sold: "Sold", not_interested: "Not interested", follow_up: "Follow-up",
};

const daysAgo = (v: string | null | undefined) => {
  if (!v) return null;
  const ms = Date.now() - Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 86_400_000));
};

// Per-device triage windows. Server clamps too - these are conveniences.
function readSetting(key: string, fallback: number): number {
  try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : fallback; } catch { return fallback; }
}

export default function Ops() {
  const { toast } = useToast();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [windowHours, setWindowHours] = useState(() => readSetting("hfs-ops-window", 48));
  const [staleDays, setStaleDays] = useState(() => readSetting("hfs-ops-stale", 14));
  const [selected, setSelected] = useState<string>("assigned_unworked");
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [assignRepId, setAssignRepId] = useState("");
  const [dismissTarget, setDismissTarget] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<{
    text: string; undoToken?: string; undoExpiresAt?: number; undone?: boolean;
  } | null>(null);

  const params = `?window=${windowHours}&stale=${staleDays}`;

  const overview = useQuery<{ queues: QueueSummary[] }>({
    queryKey: ["/api/ops/overview", windowHours, staleDays],
    queryFn: () => apiRequest("GET", `/api/ops/overview${params}`).then(r => r.json()),
    refetchInterval: 60_000,
  });

  const workload = useQuery<{ rule: string; rows: WorkloadRow[] }>({
    queryKey: ["/api/ops/workload", windowHours, staleDays],
    queryFn: () => apiRequest("GET", `/api/ops/workload${params}`).then(r => r.json()),
    refetchInterval: 60_000,
  });

  const queueQuery = useQuery<QueuePayload>({
    queryKey: ["/api/ops/queue", selected, windowHours, staleDays],
    queryFn: () => apiRequest("GET", `/api/ops/queue/${selected}${params}`).then(r => r.json()),
    enabled: selected !== "workload",
  });

  const invalidateOps = () => {
    void qc.invalidateQueries({ queryKey: ["/api/ops/overview"] });
    void qc.invalidateQueries({ queryKey: ["/api/ops/queue"] });
    void qc.invalidateQueries({ queryKey: ["/api/ops/workload"] });
  };

  const assignMutation = useMutation({
    mutationFn: async ({ leadIds, repId }: { leadIds: number[]; repId: number }) => {
      const res = await apiRequest("POST", "/api/leads/bulk-assign", { leadIds, repId });
      return res.json() as Promise<{ updated: number; skipped: number; undoToken?: string; undoExpiresAt?: string }>;
    },
    onSuccess: (data, vars) => {
      const repName = workload.data?.rows.find(r => r.repId === vars.repId)?.name ?? "rep";
      setLastResult({
        text: `${data.updated} assigned to ${repName}${data.skipped ? ` · ${data.skipped} skipped (out of scope or protected)` : ""}`,
        undoToken: data.undoToken,
        undoExpiresAt: data.undoExpiresAt ? Date.parse(data.undoExpiresAt) : undefined,
      });
      setChecked(new Set());
      invalidateOps();
    },
    onError: (e: any) => toast({ title: "Assignment failed", description: String(e?.message ?? "Try again."), variant: "destructive" }),
  });

  const undoMutation = useMutation({
    mutationFn: async (token: string) =>
      (await apiRequest("POST", "/api/leads/assign-selection/undo", { token })).json() as Promise<{ restored: number; skipped: number }>,
    onSuccess: (data) => {
      setLastResult(r => (r ? { ...r, undone: true, text: `${data.restored} put back${data.skipped ? ` · ${data.skipped} left as someone else moved them` : ""}` } : r));
      invalidateOps();
    },
    onError: (e: any) => toast({ title: "Undo failed", description: String(e?.message ?? "The put-back window may have ended."), variant: "destructive" }),
  });

  const dismissMutation = useMutation({
    mutationFn: async ({ entityId, reason }: { entityId: number; reason: string }) =>
      (await apiRequest("POST", "/api/ops/dismiss", { queue: selected, entityId, reason })).json(),
    onSuccess: () => {
      toast({ title: "Dismissed for 30 days", description: "It returns automatically after that, and shows in the audit trail now." });
      setDismissTarget(null);
      invalidateOps();
    },
    onError: (e: any) => toast({ title: "Couldn't dismiss", description: String(e?.message ?? "Try again."), variant: "destructive" }),
  });

  const setWindow = (v: number) => { setWindowHours(v); try { localStorage.setItem("hfs-ops-window", String(v)); } catch { /* fine */ } };
  const setStale = (v: number) => { setStaleDays(v); try { localStorage.setItem("hfs-ops-stale", String(v)); } catch { /* fine */ } };

  const queues = overview.data?.queues ?? [];
  const payload = queueQuery.data;
  const isLeadQueue = payload?.entityKind === "lead";
  const canAssignFrom = isLeadQueue && selected !== "territory_link_conflicts";
  const rows = (payload?.rows ?? []) as LeadRow[];

  const toggle = (id: number) =>
    setChecked(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const allChecked = rows.length > 0 && rows.every(r => checked.has(r.id));
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(rows.map(r => r.id)));

  const exportCsv = () => {
    const header = ["id", "address", "city", "state", "status", "rep", "assignedAt", "lastActivityAt", "reason"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map(r => [r.id, r.address, r.city, r.state, r.leadStatus, r.repName, r.assignedAt, r.lastOutcomeAt, r.reason].map(esc).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `ops-${selected}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const undoLive = lastResult?.undoToken && !lastResult.undone &&
    (lastResult.undoExpiresAt == null || lastResult.undoExpiresAt > Date.now());

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 pb-24 md:p-6">
      <PageHeader
        title="Operations"
        subtitle="What needs attention, with the exact rule behind every queue."
      />

      {/* Triage windows - the knobs the rules read, in plain words. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm-minus text-muted-foreground">
        <label className="flex items-center gap-2">
          Unworked after
          <Select value={String(windowHours)} onValueChange={v => setWindow(Number(v))}>
            <SelectTrigger className="h-9 w-24 md:h-8" data-testid="ops-window"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[24, 48, 72, 168].map(h => <SelectItem key={h} value={String(h)}>{h < 48 ? `${h} h` : `${h / 24} days`}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label className="flex items-center gap-2">
          Quiet after
          <Select value={String(staleDays)} onValueChange={v => setStale(Number(v))}>
            <SelectTrigger className="h-9 w-24 md:h-8" data-testid="ops-stale"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[7, 14, 21, 30].map(d => <SelectItem key={d} value={String(d)}>{d} days</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </div>

      {overview.isError ? (
        <ErrorState title="Couldn't load the operations overview" onRetry={() => void overview.refetch()} testId="ops-overview-error" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          {/* Queue rail */}
          <nav aria-label="Operations queues" className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {overview.isLoading && [0, 1, 2, 3].map(i => <Skeleton key={i} className="h-14 w-44 shrink-0 rounded-xl lg:w-full" />)}
            {queues.map(q => (
              <button
                key={q.key}
                type="button"
                onClick={() => { setSelected(q.key); setChecked(new Set()); }}
                aria-current={selected === q.key ? "true" : undefined}
                data-testid={`ops-tab-${q.key}`}
                className={`min-h-tap shrink-0 rounded-xl border px-3 py-2 text-left transition-colors ${FOCUS} ${
                  selected === q.key ? "border-primary/40 bg-primary/[0.08]" : "border-border bg-card hover:bg-secondary/50"
                }`}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm-minus font-semibold text-foreground">{q.label}</span>
                  <span className={`text-sm font-bold tabular-nums ${q.count > 0 ? "text-foreground" : "text-muted-foreground"}`} data-testid={`ops-count-${q.key}`}>
                    {q.count.toLocaleString()}
                  </span>
                </span>
              </button>
            ))}
            {!overview.isLoading && (
              <button
                type="button"
                onClick={() => { setSelected("workload"); setChecked(new Set()); }}
                aria-current={selected === "workload" ? "true" : undefined}
                data-testid="ops-tab-workload"
                className={`min-h-tap shrink-0 rounded-xl border px-3 py-2 text-left transition-colors ${FOCUS} ${
                  selected === "workload" ? "border-primary/40 bg-primary/[0.08]" : "border-border bg-card hover:bg-secondary/50"
                }`}
              >
                <span className="text-sm-minus font-semibold text-foreground">Workload by rep</span>
              </button>
            )}
          </nav>

          {/* Detail pane */}
          <section className="min-w-0 rounded-2xl border border-border bg-card">
            {selected === "workload" ? (
              <WorkloadPane workload={workload} />
            ) : queueQuery.isLoading ? (
              <div className="space-y-2 p-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>
            ) : queueQuery.isError ? (
              <ErrorState title="Couldn't load this queue" onRetry={() => void queueQuery.refetch()} bordered={false} testId="ops-queue-error" />
            ) : payload ? (
              <>
                <header className="border-b border-border px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-base font-semibold text-foreground">{payload.label}</h2>
                    <span className="text-sm-minus tabular-nums text-muted-foreground">
                      {payload.total.toLocaleString()} match{payload.total === 1 ? "" : "es"}
                      {payload.total > payload.limit ? ` · first ${payload.limit} shown` : ""}
                    </span>
                  </div>
                  {/* The rule, verbatim from the server - what you read is what ran. */}
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground" data-testid="ops-rule">{payload.rule}</p>
                </header>

                {lastResult && (
                  <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-secondary/40 px-4 py-2.5" data-testid="ops-result">
                    <span className="text-sm-minus font-medium text-foreground">{lastResult.text}</span>
                    <span className="flex items-center gap-2">
                      {undoLive && (
                        <Button size="sm" variant="outline" loading={undoMutation.isPending} data-testid="ops-undo"
                          onClick={() => lastResult.undoToken && undoMutation.mutate(lastResult.undoToken)}>
                          Undo
                        </Button>
                      )}
                      <button type="button" onClick={() => setLastResult(null)} aria-label="Dismiss result"
                        className={`min-h-tap rounded-lg px-2 text-xs font-semibold text-muted-foreground hover:text-foreground ${FOCUS}`}>
                        Done
                      </button>
                    </span>
                  </div>
                )}

                {payload.entityKind === "activity" ? (
                  <ActivityRows rows={payload.rows as ActivityRow[]} onDismiss={id => setDismissTarget(id)} />
                ) : rows.length === 0 ? (
                  <p className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="ops-empty">
                    Nothing matches this rule right now.
                  </p>
                ) : (
                  <>
                    {/* Bulk bar */}
                    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
                      <label className="flex min-h-tap items-center gap-2 text-sm-minus text-muted-foreground">
                        <Checkbox checked={allChecked} onCheckedChange={toggleAll} aria-label="Select all listed" data-testid="ops-select-all" />
                        {checked.size > 0 ? `${checked.size} selected` : "Select"}
                      </label>
                      {canAssignFrom && checked.size > 0 && (
                        <span className="flex items-center gap-2">
                          {/* Searchable, NAME-ordered picker. The old Select
                              mounted 300 items in workload order, which
                              reshuffles every 60s poll - a name never stayed
                              where you learned it. Load stays visible per row;
                              order stays learnable. */}
                          <RepDialogSelect
                            testId="ops-assign-rep"
                            title="Assign to"
                            triggerClassName="inline-flex h-9 w-52 md:h-8 items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm"
                            triggerLabel={
                              assignRepId
                                ? (workload.data?.rows.find(r => String(r.repId) === assignRepId)?.name ?? "Assign to...")
                                : "Assign to..."
                            }
                            value={assignRepId ? Number(assignRepId) : null}
                            reps={(workload.data?.rows ?? []).map(r => ({
                              id: r.repId,
                              name: r.name,
                              detail: `${r.activeLeads} active${r.unworked ? ` · ${r.unworked} unworked` : ""}`,
                            }))}
                            onPick={(id) => setAssignRepId(String(id))}
                          />
                          <Button size="sm" loading={assignMutation.isPending} disabled={!assignRepId} data-testid="ops-assign"
                            onClick={() => assignMutation.mutate({ leadIds: [...checked], repId: Number(assignRepId) })}>
                            Assign {checked.size}
                          </Button>
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-1.5">
                        <Button size="sm" variant="ghost" onClick={exportCsv} data-testid="ops-export">Export CSV</Button>
                      </span>
                    </div>

                    {/* Rows: table from md up, cards below */}
                    <ul className="divide-y divide-border/60">
                      {rows.map(r => (
                        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" data-testid={`ops-row-${r.id}`}>
                          <Checkbox checked={checked.has(r.id)} onCheckedChange={() => toggle(r.id)} aria-label={`Select ${r.address}`} />
                          <div className="min-w-0 flex-1 basis-52">
                            <Link href={`/lead/${r.id}`} className={`text-sm-minus font-semibold text-foreground underline-offset-2 hover:underline ${FOCUS} rounded-sm`}>
                              {r.address}
                            </Link>
                            <div className="text-2xs text-muted-foreground">
                              {r.city ?? ""} · {STATUS_LABEL[r.leadStatus] ?? r.leadStatus}
                              {r.repName ? ` · ${r.repName}` : " · Unassigned"}
                              {r.assignedAt && daysAgo(r.assignedAt) != null ? ` · assigned ${daysAgo(r.assignedAt)}d ago` : ""}
                            </div>
                          </div>
                          <span className="basis-full text-2xs text-muted-foreground md:basis-auto md:max-w-[38%] md:text-right">{r.reason}</span>
                          {payload.dismissible && (
                            <button type="button" onClick={() => setDismissTarget(r.id)} data-testid={`ops-dismiss-${r.id}`}
                              className={`tap-expand rounded-md px-1.5 text-2xs font-semibold text-muted-foreground hover:text-foreground ${FOCUS}`}>
                              Dismiss
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : null}
          </section>
        </div>
      )}

      <RejectReasonDialog
        open={dismissTarget != null}
        onOpenChange={open => { if (!open) setDismissTarget(null); }}
        title="Dismiss from this queue?"
        description="It leaves this queue for 30 days and returns on its own. The reason is recorded in the audit trail."
        label="Reason (required, audited)"
        placeholder="Why this row is not actionable"
        confirmLabel="Dismiss for 30 days"
        busy={dismissMutation.isPending}
        onConfirm={reason => { if (dismissTarget != null) dismissMutation.mutate({ entityId: dismissTarget, reason }); }}
      />

      {user?.role === "team_lead" && (
        <p className="text-2xs text-muted-foreground">
          You see your own team's work here. Pool-lead and audit queues are manager surfaces.
        </p>
      )}
    </div>
  );
}

function ActivityRows({ rows, onDismiss }: { rows: ActivityRow[]; onDismiss: (id: number) => void }) {
  if (rows.length === 0) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">No partial writes in the last 7 days.</p>;
  }
  return (
    <ul className="divide-y divide-border/60">
      {rows.map(r => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-sm-minus font-semibold text-foreground">{r.action}</div>
            <div className="text-2xs text-muted-foreground">{new Date(r.at).toLocaleString()} · {r.reason}</div>
          </div>
          <button type="button" onClick={() => onDismiss(r.id)}
            className={`tap-expand rounded-md px-1.5 text-2xs font-semibold text-muted-foreground hover:text-foreground ${FOCUS}`}>
            Dismiss
          </button>
        </li>
      ))}
    </ul>
  );
}

function WorkloadPane({ workload }: { workload: ReturnType<typeof useQuery<{ rule: string; rows: WorkloadRow[] }>> }) {
  const rows = workload.data?.rows ?? [];
  return (
    <>
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-base font-semibold text-foreground">Workload by rep</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{workload.data?.rule ?? ""}</p>
      </header>
      {workload.isLoading ? (
        <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10 w-full rounded-lg" />)}</div>
      ) : workload.isError ? (
        <ErrorState title="Couldn't load workload" onRetry={() => void workload.refetch()} bordered={false} />
      ) : rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">No active reps in your scope.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm-minus" data-testid="ops-workload-table">
            <thead>
              <tr className="border-b border-border text-left text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                <th className="px-4 py-2">Rep</th>
                <th className="px-3 py-2 text-right">Active leads</th>
                <th className="px-3 py-2 text-right">Unworked</th>
                <th className="px-3 py-2 text-right">Overdue follow-ups</th>
                <th className="px-3 py-2 text-right">Areas</th>
                <th className="px-3 py-2">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map(r => (
                <tr key={r.repId}>
                  <td className="px-4 py-2.5 font-medium text-foreground">
                    {r.name}
                    {r.onShift && <span className="ml-2 rounded-full bg-success/10 px-1.5 py-0.5 text-2xs font-semibold text-success">On shift</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.activeLeads.toLocaleString()}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${r.unworked > 0 ? "font-semibold text-warning" : ""}`}>{r.unworked.toLocaleString()}</td>
                  <td className={`px-3 py-2.5 text-right tabular-nums ${r.overdueFollowUps > 0 ? "font-semibold text-warning" : ""}`}>{r.overdueFollowUps.toLocaleString()}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{r.areasHeld}/{r.areaCap}</td>
                  <td className="px-3 py-2.5 text-muted-foreground">{r.lastActivityAt ? `${daysAgo(r.lastActivityAt)}d ago` : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
