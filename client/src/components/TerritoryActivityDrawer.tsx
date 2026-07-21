// ── Territory activity History (location-verified) ────────────────────────────
// Opened from a territory card's "View Activity". Lists every lead-marking with
// the distance the rep was from the lead AT MARK TIME (never recomputed live),
// GPS accuracy, verdict, an expandable audit record + distance diagram, and —
// for admins — a reason-gated override. Filter by verdict/rep, sort by time or
// distance, and export what you can see.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ChevronDown, ChevronRight, Download } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { VerificationBadge, DistanceDiagram, formatDistance, type VStatus } from "@/components/verification";

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
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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

  const key = `/api/territories/${territoryId}/activity`;
  const { data, isLoading, isError } = useQuery<ActivityResponse>({
    queryKey: [key],
    queryFn: async () => (await apiRequest("GET", key)).json(),
  });

  const override = useMutation({
    mutationFn: async ({ knockId, newStatus, reason }: { knockId: number; newStatus: string; reason: string }) =>
      (await apiRequest("POST", `/api/knocks/${knockId}/override`, { status: newStatus, reason })).json(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [key] });
      qc.invalidateQueries({ queryKey: ["/api/territories/progress"] });
      toast({ title: "Verification overridden — logged to the audit trail" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

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

  function doOverride(a: Activity) {
    const target = a.verification === "verified" ? "invalid" : "verified";
    const reason = window.prompt(`Override this activity to "${target}". Enter a reason (required):`, "");
    if (reason && reason.trim().length >= 3) override.mutate({ knockId: a.knockId, newStatus: target, reason: reason.trim() });
    else if (reason != null) toast({ title: "A reason of at least 3 characters is required", variant: "destructive" });
  }

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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} data-testid="activity-drawer">
      <div
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-200"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-label="Territory activity history"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-foreground">{data?.name ?? "Activity"}</h2>
            <p className="text-[11px] text-muted-foreground">Location-verified activity · distance when marked</p>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={exportCsv} title="Export what you can see" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground" data-testid="export-activity"><Download className="h-4 w-4" /></button>
            <button onClick={onClose} title="Close" className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
          {(["all", "verified", "needs_review", "invalid"] as StatusFilter[]).map(s => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${status === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
              data-testid={`filter-${s}`}
            >
              {s === "all" ? "All" : s === "needs_review" ? "Needs Review" : s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            {reps.length > 1 && (
              <select value={repFilter} onChange={e => setRepFilter(e.target.value)} className="h-7 rounded-md border border-border bg-secondary px-1.5 text-[11px] text-foreground" aria-label="Filter by rep">
                <option value="all">All reps</option>
                {reps.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            )}
            <select value={sort} onChange={e => setSort(e.target.value as SortKey)} className="h-7 rounded-md border border-border bg-secondary px-1.5 text-[11px] text-foreground" aria-label="Sort activities">
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
          {isError && <div className="p-6 text-center text-sm text-red-400">Couldn’t load activity. Try again.</div>}
          {!isLoading && !isError && rows.length === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">No activity{status !== "all" ? ` matching “${status.replace("_", " ")}”` : " recorded yet"}.</div>
          )}
          <ul className="divide-y divide-border">
            {rows.map(a => {
              const isOpen = expanded === a.knockId;
              return (
                <li key={a.knockId} className="px-4 py-2.5" data-testid="activity-row">
                  <button className="flex w-full items-start gap-2 text-left" onClick={() => setExpanded(isOpen ? null : a.knockId)} aria-expanded={isOpen}>
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
                      <div className="text-2xs text-muted-foreground/70">{a.rep ?? "—"} · {fmtTime(a.knockedAt)}</div>
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
                        <div><dt className="text-muted-foreground">Marked (device)</dt><dd className="text-foreground/90">{a.deviceTs ? fmtTime(a.deviceTs) : "—"}</dd></div>
                        <div><dt className="text-muted-foreground">Received (server)</dt><dd className="text-foreground/90">{a.serverTs ? fmtTime(a.serverTs) : "—"}</dd></div>
                        <div><dt className="text-muted-foreground">Network</dt><dd className="text-foreground/90">{a.netState ?? "—"}</dd></div>
                        <div><dt className="text-muted-foreground">Activity ID</dt><dd className="text-foreground/90 tabular-nums">#{a.knockId}</dd></div>
                      </dl>
                      {isAdmin && (
                        <button
                          onClick={() => doOverride(a)}
                          disabled={override.isPending}
                          data-testid="override-btn"
                          className="w-full rounded-lg border border-border bg-secondary/60 px-2 py-1.5 text-[11px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50"
                        >
                          Override verification…
                        </button>
                      )}
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
