// ── Ranked fresh leads — the rep-facing "knock these doors first" list ────────
// Consumes GET /api/leads/ranked (server/leadRanking.ts): confirmed-fresh
// assignable leads ordered by the composite sales-intelligence score, each with
// human-readable reason chips ("lit 43m ago", "cluster yielded 6 leads") and a
// simple cluster count badge. Tapping a row opens the existing LeadCard sheet —
// same card reps already use on the field map.
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { LeadCard, type CardProperty } from "@/components/LeadCard";
import { Flame, Layers } from "lucide-react";

interface RankedLead {
  id: number; address: string; city: string; state: string; zip: string | null;
  lat: number | null; lng: number | null;
  score: number; reasons: string[];
  assignedRepId: number | null; assignedTerritoryId: number | null;
  createdAt: string | null; freshConfirmedAt: string | null; freshConfidence: string | null;
  clusterId: string | null; clusterSize: number;
}
interface RankedResponse { count: number; limit: number; generatedAt: string; leads: RankedLead[] }

function scoreTone(score: number): string {
  if (score >= 50) return "bg-emerald-500/15 text-emerald-400";
  if (score >= 25) return "bg-sky-500/15 text-sky-300";
  return "bg-muted text-muted-foreground";
}

export default function RankedLeads() {
  const [, navigate] = useLocation();
  const [selected, setSelected] = useState<RankedLead | null>(null);
  const { data, isLoading, error } = useQuery<RankedResponse>({
    queryKey: ["/api/leads/ranked"],
    queryFn: () => apiRequest("GET", "/api/leads/ranked?limit=50").then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 403)) && count < 2,
  });

  const leads = data?.leads ?? [];
  const property: CardProperty | null = selected ? {
    id: selected.id, address: selected.address, city: selected.city, state: selected.state,
    zip: selected.zip, lat: selected.lat, lng: selected.lng,
    leadTag: "fresh_fiber_confirmed", freshConfidence: selected.freshConfidence,
    leadScore: Math.round(selected.score), source: "lead",
  } : null;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Flame className="h-3.5 w-3.5 text-orange-400" /> Top leads — ranked
        </div>
        {data && <div className="text-[11px] text-muted-foreground">{data.count} scored</div>}
      </div>

      {isLoading && !data ? (
        <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-6 w-6 rounded-lg" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-10 rounded-full" /></div>
        ))}</div>
      ) : error || leads.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] italic text-muted-foreground">
          No ranked leads yet — confirmed fresh-fiber leads appear here ordered by how hot they are.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {leads.map((l, i) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setSelected(l)}
              data-testid={`ranked-lead-${l.id}`}
              className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40"
            >
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-secondary text-[11px] font-bold tabular-nums text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[14px] font-medium text-foreground">{l.address}, {l.city}</span>
                  {l.clusterSize > 1 && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary" title={`${l.clusterSize} ranked leads in this cluster`}>
                      <Layers className="h-2.5 w-2.5" /> ×{l.clusterSize}
                    </span>
                  )}
                </div>
                {l.reasons.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {l.reasons.slice(0, 3).map((r) => (
                      <span key={r} className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{r}</span>
                    ))}
                    {l.reasons.length > 3 && <span className="rounded-full px-1 py-0.5 text-[10px] text-muted-foreground">+{l.reasons.length - 3}</span>}
                  </div>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${scoreTone(l.score)}`}>{Math.round(l.score)}</span>
            </button>
          ))}
        </div>
      )}

      <LeadCard
        property={property}
        onClose={() => setSelected(null)}
        onAddLead={() => {}}
        canAdd={false}
        onOpen={(id) => navigate(`/lead/${id}`)}
      />
    </div>
  );
}
