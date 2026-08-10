// ── Ranked fresh leads — the rep-facing "knock these doors first" list ────────
// Consumes GET /api/leads/ranked (server/leadRanking.ts): confirmed-fresh
// assignable leads ordered by the composite sales-intelligence score, each with
// human-readable reason chips ("lit 43m ago", "cluster yielded 6 leads") and a
// simple cluster count badge. The #1 lead gets a hero card (Letterboxd/Netflix
// top-pick pattern) so a rep instantly knows which door to knock first; the rest
// render as a ranked leaderboard (top-3 tinted). Tapping opens the existing
// LeadCard sheet — same card reps already use on the field map.
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { LeadCard, type CardProperty } from "@/components/LeadCard";
import { ChevronRight } from "lucide-react";

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
// Top-3 leaderboard tint (Digg-style podium, using the app's own palette).
function rankTone(i: number): string {
  if (i === 1) return "bg-primary/15 text-primary";
  if (i === 2) return "bg-sky-500/15 text-sky-300";
  return "bg-secondary text-muted-foreground";
}

// Circular score gauge for the hero — score capped at 100.
function ScoreRing({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const R = 20, C = 2 * Math.PI * R;
  return (
    <div className="relative grid h-14 w-14 shrink-0 place-items-center" aria-label={`score ${Math.round(score)}`}>
      <svg viewBox="0 0 48 48" className="h-14 w-14 -rotate-90">
        <circle cx="24" cy="24" r={R} fill="none" strokeWidth="4" className="stroke-secondary" />
        <circle
          cx="24" cy="24" r={R} fill="none" strokeWidth="4" strokeLinecap="round"
          className="stroke-emerald-600 dark:stroke-emerald-400"
          strokeDasharray={`${C * pct} ${C}`}
        />
      </svg>
      <span className="absolute text-[15px] font-bold tabular-nums text-foreground">{Math.round(score)}</span>
    </div>
  );
}

// The single hottest lead — full-width hero so it reads before anything else.
function HeroLead({ lead, onOpen }: { lead: RankedLead; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="ranked-hero"
      className="relative block w-full overflow-hidden border-b border-border bg-gradient-to-br from-emerald-500/10 via-card to-card px-4 pb-3.5 pt-3 text-left hover:from-emerald-500/15"
    >
      {/* Oversized rank numeral, Netflix-top-10 style — pure background texture. */}
      <span aria-hidden className="pointer-events-none absolute -right-1 -top-6 select-none text-[110px] font-black leading-none text-emerald-400/10">1</span>
      <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-bold uppercase tracking-[0.14em] text-success">
         Knock this door first
      </div>
      <div className="relative flex items-center gap-3">
        <ScoreRing score={lead.score} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-bold leading-tight text-foreground">{lead.address}</div>
          <div className="truncate text-[12px] text-muted-foreground">{lead.city}, {lead.state}{lead.zip ? ` ${lead.zip}` : ""}</div>
          {lead.reasons.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {lead.reasons.slice(0, 3).map((r) => (
                <span key={r} className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-2xs font-medium text-emerald-300">{r}</span>
              ))}
            </div>
          )}
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
      </div>
      {lead.clusterSize > 1 && (
        <div className="relative mt-2 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold text-primary">
           {lead.clusterSize} hot leads in this cluster
        </div>
      )}
    </button>
  );
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
  const [hero, ...rest] = leads;
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
           Top leads - ranked
        </div>
        {data && <div className="text-[11px] text-muted-foreground">{data.count} scored</div>}
      </div>

      {isLoading && !data ? (
        <div className="divide-y divide-border">
          <div className="space-y-2 px-4 py-4"><Skeleton className="h-3 w-28" /><div className="flex items-center gap-3"><Skeleton className="h-14 w-14 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-3 w-1/2" /></div></div></div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-6 w-6 rounded-lg" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-10 rounded-full" /></div>
          ))}
        </div>
      ) : error ? (
        // A distinct quiet failure state — an API error must never wear the
        // happy "no leads yet" empty state.
        <div className="px-4 py-8 text-center text-[13px] text-muted-foreground" data-testid="ranked-error">
          Couldn&rsquo;t load rankings - retrying automatically.
        </div>
      ) : leads.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] italic text-muted-foreground">
          No ranked leads yet - confirmed fresh-fiber leads appear here ordered by how hot they are.
        </div>
      ) : (
        <>
          <HeroLead lead={hero} onOpen={() => setSelected(hero)} />
          <div className="divide-y divide-border">
            {rest.map((l, i) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelected(l)}
                data-testid={`ranked-lead-${l.id}`}
                className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-secondary/40"
              >
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-lg text-[11px] font-bold tabular-nums ${rankTone(i + 1)}`}>{i + 2}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-foreground">{l.address}, {l.city}</span>
                    {l.clusterSize > 1 && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-2xs font-semibold text-primary" title={`${l.clusterSize} ranked leads in this cluster`}>
                         ×{l.clusterSize}
                      </span>
                    )}
                  </div>
                  {l.reasons.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {l.reasons.slice(0, 3).map((r) => (
                        <span key={r} className="rounded-full bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">{r}</span>
                      ))}
                      {l.reasons.length > 3 && <span className="rounded-full px-1 py-0.5 text-2xs text-muted-foreground">+{l.reasons.length - 3}</span>}
                    </div>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums ${scoreTone(l.score)}`}>{Math.round(l.score)}</span>
              </button>
            ))}
          </div>
          {data != null && data.count > leads.length && (
            <div className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground">
              Showing first {leads.length} of {data.count}
            </div>
          )}
        </>
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
