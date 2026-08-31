// ── Territory activity History (location-verified) ────────────────────────────
// Opened from a territory card's "View Activity". Lists every lead-marking with
// the distance the rep was from the lead AT MARK TIME (never recomputed live),
// GPS accuracy, verdict, an expandable audit record + distance diagram, and —
// for admins — a reason-gated override. Filter by verdict/rep, sort by time or
// distance, and export what you can see.

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ChevronDown, ChevronRight, Download } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { FOCUS } from "@/lib/a11y";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { VerificationBadge, DistanceDiagram, formatDistance, type VStatus } from "@/components/verification";
import { ErrorState } from "@/components/ErrorState";

interface Activity {
  knockId: number; leadId: number; leadName: string; address: string;
  rep: string | null; outcome: string; knockedAt: string; deviceTs: string | null; serverTs: string | null;
  verification: VStatus; distanceM: number | null; gpsAccuracyM: number | null;
  reviewReason: string | null; netState: string | null;
  repLat: number | null; repLng: number | null; leadLat: number | null; leadLng: number | null;
}
interface ActivityResponse { territoryId: number; name: string; maxAllowedDistanceM: number; activities: Activity[]; }

type StatusFilter = "all" | "verified" | "needs_review" | "invalid";
type SortKey = "newest" | "oldest" | "closest" | "farthest" | "status";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? " - " : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function TerritoryActivityDrawer({ territoryId, onClose }: { territoryId: number; onClose: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = user?.role === "admin" || user?.role === "super_admin";

  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("newest");
  const [repFilter, setRepFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  // Two-step admin override (audit finding: was a window.prompt): tapping the
  // override action expands an inline confirm row with a required reason input.
  const [overrideFor, setOverrideFor] = useState<number | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  const key = `/api/territories/${territoryId}/activity`;
  const { data, isLoading, isError, refetch } = useQuery<ActivityResponse>({
    queryKey: [key],
    queryFn: async () => (await apiRequest("GET", key)).json(),
  });

  const override = useMutation({
    mutationFn: async ({ knockId, newStatus, reason }: { knockId: number; newStatus: string; reason: string }) =>
      (await apiRequest("POST", `/api/knocks/${knockId}/override`, { status: newStatus, reason })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [key] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      setOverrideFor(null);
      setOverrideReason("");
      toast({ title: "Verification overridden - logged to the audit trail" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  // Full modal contract (Escape, focus in, contained Tab, focus restore) —
  // replaces the drawer's old Escape-only listener.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, { active: true, onClose, initialFocus: '[data-testid="close-activity"]' });

  const reps = useMemo(() => {
    const s = new Set<string>();
    data?.activities.forEach(a => { if (a.rep) s.add(a.rep); });
    return [...s].sort();
  }, [data]);

  const rows = useMemo(() => {
    let list = data?.activities ?? [];
    if (status !== "all") list = list.filter(a => a.verification === status);
    if (repFilter !== "all") list = list.filter(a => a.rep === repFilter);
    const dist = (a: Activity) => (a.distanceM == null ? Infinity : a.distanceM);
    const rank = (a: Activity) => (a.verification === "invalid" ? 0 : a.verification === "needs_review" ? 1 : 2);
    return [...list].sort((a, b) => {
      switch (sort) {
        case "oldest": return a.knockedAt < b.knockedAt ? -1 : 1;
        case "closest": return dist(a) - dist(b);
        case "farthest": return dist(b) - dist(a);
        case "status": return rank(a) - rank(b);
        default: return a.knockedAt > b.knockedAt ? -1 : 1;
      }
    });
  }, [data, status, repFilter, sort]);

  function exportCsv() {
    const header = ["lead", "address", "rep", "outcome", "markedAt", "serverReceivedAt", "verification", "distanceM", "gpsAccuracyM", "reason"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map(a => [a.leadName, a.address, a.rep, a.outcome, a.knockedAt, a.serverTs, a.verification, a.distanceM, a.gpsAccuracyM, a.reviewReason].map(esc).join(","));
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${data?.name ?? "territory"}-activity.csv`; link.click();
    URL.revokeObjectURL(url);
  }

  return (
    // Scrim is blur-FREE: a full-viewport backdrop-filter over the WebGL map
    // is the single most expensive composite a phone GPU can be asked for.
    <div className="fixed inset-0 z-overlay flex justify-end bg-overlay" onClick={onClose} data-testid="activity-drawer">
      <div
        ref={panelRef}
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-200 motion-reduce:animate-none"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Territory activity history"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-foreground">{data?.name ?? "Activity"}</h2>
            <p className="text-[11px] text-muted-foreground">Location-verified activity · distance when marked</p>
          </div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={exportCsv} title="Export what you can see" aria-label="Export visible activity as CSV" className={`flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground ${FOCUS}`} data-testid="export-activity"><Download className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" onClick={onClose} title="Close" aria-label="Close activity history" className={`flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground ${FOCUS}`} data-testid="close-activity"><X className="h-4 w-4" aria-hidden="true" /></button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
          {(["all", "verified", "needs_review", "invalid"] as StatusFilter[]).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setStatus(s)}
              aria-pressed={status === s}
              className={`min-h-11 rounded-full px-3 text-[11px] font-semibold transition-colors ${status === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"} ${FOCUS}`}
              data-testid={`filter-${s}`}
            >
              {s === "all" ? "All" : s === "needs_review" ? "Needs Review" : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            {reps.length > 1 && (
              <select value={repFilter} onChange={e => setRepFilter(e.target.value)} className={`h-11 rounded-md border border-border bg-secondary px-1.5 text-[11px] text-foreground ${FOCUS}`} aria-label="Filter by rep">
                <option value="all">All reps</option>
                {reps.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
            <select value={sort} onChange={e => setSort(e.target.value as SortKey)} className={`h-11 rounded-md border border-border bg-secondary px-1.5 text-[11px] text-foreground ${FOCUS}`} aria-label="Sort activities">
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="closest">Closest</option>
              <option value="farthest">Farthest</option>
              <option value="status">By status</option>
            </select>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="p-6 text-center text-sm text-muted-foreground">Loading activity…</div>}
          {/* Was a bare line of `text-red-400` text with the words "Try again"
              and nothing to press. The shared primitive carries the alert role
              and a real retry control. */}
          {isError && (
            <ErrorState
              testId="territory-activity-error"
              title="Couldn't load activity"
              onRetry={() => refetch()}
              bordered={false}
              className="p-6"
            />
          )}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">No activity{status !== "all" ? ` matching “${status.replace("_", " ")}”` : " recorded yet"}.</div>
          )}
          <ul className="divide-y divide-border">
            {rows.map(a => {
              const isOpen = expanded === a.knockId;
              return (
                <li key={a.knockId} className="px-4 py-2.5" data-testid="activity-row">
                  <button type="button" className={`flex min-h-11 w-full items-start gap-2 rounded-md text-left ${FOCUS}`} onClick={() => { setExpanded(isOpen ? null : a.knockId); setOverrideFor(null); setOverrideReason(""); }} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-foreground">{a.leadName}</span>
                        <span className="ml-auto flex-shrink-0"><VerificationBadge status={a.verification} /></span>
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{a.address}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground/80">{a.outcome.replace(/_/g, " ")}</span>
                        <span>·</span>
                        <span data-testid="distance-when-marked">{formatDistance(a.distanceM)}</span>
                        {a.gpsAccuracyM != null && <><span>·</span><span>GPS ±{Math.round(a.gpsAccuracyM)} m</span></>}
                      </div>
                      <div className="text-2xs text-muted-foreground/70">{a.rep ?? " - "} · {fmtTime(a.knockedAt)}</div>
                    </div>
                  </button>

                  {isOpen && (
                    <div className="mt-2 space-y-2 pl-6">
                      <DistanceDiagram distanceM={a.distanceM} accuracyM={a.gpsAccuracyM} maxAllowedM={data?.maxAllowedDistanceM} status={a.verification} />
                      {a.reviewReason && (
                        <p className="rounded-md bg-secondary/60 px-2 py-1.5 text-[11px] text-muted-foreground">
                          <span className="font-semibold text-foreground/80">Reason: </span>{a.reviewReason.replace(/_/g, " ").replace(/;/g, ", ")}
                        </p>
                      )}
                      {/* Immutable audit fields */}
                      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
                        <div><dt className="text-muted-foreground">Marked (device)</dt><dd className="text-foreground/90">{a.deviceTs ? fmtTime(a.deviceTs) : " - "}</dd></div>
                        <div><dt className="text-muted-foreground">Received (server)</dt><dd className="text-foreground/90">{a.serverTs ? fmtTime(a.serverTs) : " - "}</dd></div>
                        <div><dt className="text-muted-foreground">Network</dt><dd className="text-foreground/90">{a.netState ?? " - "}</dd></div>
                        <div><dt className="text-muted-foreground">Activity ID</dt><dd className="text-foreground/90 tabular-nums">#{a.knockId}</dd></div>
                      </dl>
                      {isAdmin && (() => {
                        const target = a.verification === "verified" ? "invalid" : "verified";
                        if (overrideFor !== a.knockId) {
                          return (
                            <button
                              type="button"
                              onClick={() => { setOverrideFor(a.knockId); setOverrideReason(""); }}
                              disabled={override.isPending}
                              data-testid="override-btn"
                              className={`min-h-11 w-full rounded-lg border border-border bg-secondary/60 px-2 text-[11px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}
                            >
                              Override verification…
                            </button>
                          );
                        }
                        return (
                          <div className="space-y-1.5 rounded-lg border border-border bg-secondary/40 p-2" data-testid="override-confirm-row">
                            <p className="text-[11px] text-muted-foreground">
                              Override this activity to <span className="font-semibold text-foreground">{target}</span>. The reason is logged to the audit trail.
                            </p>
                            <input
                              type="text"
                              value={overrideReason}
                              onChange={e => setOverrideReason(e.target.value)}
                              placeholder="Reason for override"
                              aria-label={`Reason for overriding activity ${a.knockId} to ${target}`}
                              data-testid="override-reason-input"
                              className={`h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
                            />
                            <div className="flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => override.mutate({ knockId: a.knockId, newStatus: target, reason: overrideReason.trim() })}
                                disabled={!overrideReason.trim() || override.isPending}
                                data-testid="override-confirm"
                                className={`h-11 flex-1 rounded-lg bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 ${FOCUS}`}
                              >
                                {override.isPending ? "Overriding…" : "Confirm override"}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setOverrideFor(null); setOverrideReason(""); }}
                                disabled={override.isPending}
                                data-testid="override-cancel"
                                className={`h-11 rounded-lg border border-border px-3 text-[12px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default TerritoryActivityDrawer;
