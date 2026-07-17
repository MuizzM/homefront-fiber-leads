// ── Coming Soon watchlist — flagged addresses approaching fiber completion ────
// Consumes GET /api/coming-soon/watchlist. The endpoint ships separately, so
// this component codes against its contract and degrades to a friendly empty
// state on 404 — the tab keeps working even before the API lands.
import { useQuery } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Clock } from "lucide-react";

export interface WatchlistItem {
  id: number | string; address: string; city: string; state: string; zip: string | null;
  lat: number | null; lng: number | null;
  firstSeenAt: string | null; lastCheckedAt: string | null; estimatedCompletion: string | null;
  source: string | null; confidence: string | null; status: string | null;
  urgency: "hot" | "soon" | "watch";
}

const URGENCY_ORDER: Record<WatchlistItem["urgency"], number> = { hot: 0, soon: 1, watch: 2 };
const URGENCY_CHIP: Record<WatchlistItem["urgency"], string> = {
  hot: "bg-orange-500/15 text-orange-400",
  soon: "bg-amber-500/15 text-amber-400",
  watch: "bg-muted text-muted-foreground",
};

function fmtDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// The endpoint is being built in parallel — accept a bare array or the common
// wrapper keys, and normalize unknown urgency values to "watch".
function normalize(json: unknown): WatchlistItem[] {
  const raw = Array.isArray(json) ? json : (json as any)?.items ?? (json as any)?.watchlist ?? (json as any)?.addresses ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it: any) => it && it.address)
    .map((it: any): WatchlistItem => ({
      id: it.id ?? `${it.address}|${it.zip ?? ""}`,
      address: String(it.address), city: String(it.city ?? ""), state: String(it.state ?? ""),
      zip: it.zip ?? null, lat: it.lat ?? null, lng: it.lng ?? null,
      firstSeenAt: it.firstSeenAt ?? null, lastCheckedAt: it.lastCheckedAt ?? null,
      estimatedCompletion: it.estimatedCompletion ?? null,
      source: it.source ?? null, confidence: it.confidence ?? null, status: it.status ?? null,
      urgency: it.urgency === "hot" || it.urgency === "soon" ? it.urgency : "watch",
    }));
}

export default function ComingSoonWatchlist() {
  const { data, isLoading } = useQuery<WatchlistItem[] | null>({
    queryKey: ["/api/coming-soon/watchlist"],
    queryFn: async () => {
      try {
        const res = await apiRequest("GET", "/api/coming-soon/watchlist");
        return normalize(await res.json());
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null; // endpoint not shipped yet
        throw e;
      }
    },
    refetchInterval: 30_000,
    retry: (count, err) => !(err instanceof ApiError && (err.status === 404 || err.status === 403)) && count < 2,
  });

  const items = (data ?? []).slice().sort((a, b) =>
    URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency]
    || String(a.estimatedCompletion ?? "9999").localeCompare(String(b.estimatedCompletion ?? "9999")));

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Clock className="h-3.5 w-3.5 text-cyan-400" /> Watchlist
        </div>
        {items.length > 0 && <div className="text-[11px] text-muted-foreground">{items.length} watched</div>}
      </div>

      {isLoading && data === undefined ? (
        <div className="divide-y divide-border">{[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-2 w-2 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-14 rounded-full" /></div>
        ))}</div>
      ) : data === null ? (
        <div className="px-4 py-8 text-center text-[13px] italic text-muted-foreground">
          The watchlist feed is warming up — flagged Coming Soon addresses will appear here as their completion dates approach.
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-8 text-center text-[13px] italic text-muted-foreground">
          Nothing on the watchlist yet — Coming Soon addresses land here and are re-checked as completion approaches.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {items.slice(0, 60).map((it) => (
            <div key={it.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`watchlist-row-${it.id}`}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${it.urgency === "hot" ? "animate-pulse bg-orange-400" : it.urgency === "soon" ? "bg-amber-400" : "bg-muted-foreground/50"}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-foreground">{it.address}{it.city ? `, ${it.city}` : ""}</div>
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span>{[it.state, it.zip].filter(Boolean).join(" ")}</span>
                  {it.estimatedCompletion && <span>· est. {fmtDate(it.estimatedCompletion)}</span>}
                  {it.source && <span>· {it.source}</span>}
                  {it.confidence && <span>· {it.confidence}</span>}
                </div>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${URGENCY_CHIP[it.urgency]}`}>{it.urgency}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
