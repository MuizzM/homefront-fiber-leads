import { lazy, Suspense, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Zap, Map as MapIcon, Clock, Layers, Activity, ArrowRight, MapPin, ExternalLink,
} from "lucide-react";

// The Scan Inspector is heavy (SSE stream + live table) and admin-only, so it is
// code-split and only mounted when the Operations tab is opened.
const ScanInspector = lazy(() => import("@/components/fiber/ScanInspector"));

type TabKey = "fresh" | "map" | "coming" | "coverage" | "ops";
interface FirstSeenLive {
  windowHours: number; count: number; confirmed: number; provisional: number; readyToAssign: number;
  addresses: Array<{ id: number; address: string; city: string; firstSeenLiveAt: string; confidence: string; leadId?: number | null }>;
}
interface StateSweep {
  id: string; state: "NC" | "SC"; status: string; currentCity: string | null;
  citiesTotal: number; citiesCompleted: number; discovered?: number; checked: number;
  freshLeads: number; comingSoon: number; pending?: number; unresolved: number;
}

function fmtTime(iso: string): string {
  const s = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const d = new Date(s);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TABS: Array<{ key: TabKey; label: string; icon: any }> = [
  { key: "fresh", label: "Fresh Now", icon: Zap },
  { key: "map", label: "Map", icon: MapIcon },
  { key: "coming", label: "Coming Soon", icon: Clock },
  { key: "coverage", label: "Coverage", icon: Layers },
  { key: "ops", label: "Operations", icon: Activity },
];

export default function FiberIntelligence() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin" || user?.role === "manager";
  const [tab, setTab] = useState<TabKey>("fresh");

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 pb-6 pt-4 sm:px-6">
      <header className="mb-3">
        <h1 className="text-[22px] font-bold tracking-tight text-foreground">Fiber Intelligence</h1>
        <p className="text-[13px] text-muted-foreground">Real-time fresh-fiber detection across NC &amp; SC — one workspace.</p>
      </header>

      {/* Tab rail */}
      <div className="sticky top-0 z-10 -mx-4 mb-4 overflow-x-auto border-b border-border bg-background/80 px-4 backdrop-blur-xl sm:-mx-6 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-1">
          {TABS.filter((t) => t.key !== "ops" || isAdmin).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              data-testid={`fi-tab-${key}`}
              className={`relative flex items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-[13px] font-semibold transition-colors ${tab === key ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Icon className="h-4 w-4" /> {label}
              {tab === key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {tab === "fresh" && <FreshNow />}
        {tab === "map" && <MapTab />}
        {tab === "coming" && <ComingSoon />}
        {tab === "coverage" && <Coverage />}
        {tab === "ops" && isAdmin && (
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
            <ScanInspector />
          </Suspense>
        )}
      </div>
    </div>
  );
}

// ── Fresh Now — verified fresh leads as they are detected ─────────────────────
function FreshNow() {
  const { data, isLoading } = useQuery<FirstSeenLive>({
    queryKey: ["/api/scan/first-seen-live"],
    queryFn: () => apiRequest("GET", "/api/scan/first-seen-live?hours=24").then((r) => r.json()),
    refetchInterval: 8000, // near-real-time without an SSE dependency
    staleTime: 5000,
  });
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[["New now", data?.count ?? 0, "text-primary"], ["Cross-verified", data?.confirmed ?? 0, "text-emerald-400"], ["Ready to assign", data?.readyToAssign ?? 0, "text-sky-400"]].map(([l, v, t]) => (
          <div key={l as string} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className={`text-[22px] font-bold leading-none tabular-nums ${t}`}>{v as number}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{l as string}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live · last 24h · refreshes automatically</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {isLoading && !data ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-2 w-2 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-20 rounded-full" /></div>
          ))}</div>
        ) : (data?.addresses?.length ?? 0) === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] italic text-muted-foreground">No fresh fiber in the last 24h — the pipeline is watching. New detections stream in here.</div>
        ) : (
          <div className="divide-y divide-border">
            {data!.addresses.slice(0, 40).map((a) => (
              <div key={a.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`fresh-row-${a.id}`}>
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-orange-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{a.address}, {a.city}</div>
                  <div className="text-[11px] text-muted-foreground">Detected {fmtTime(a.firstSeenLiveAt)}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${a.confidence === "cross_verified" ? "bg-emerald-500/15 text-emerald-400" : "bg-orange-500/15 text-orange-400"}`}>{a.confidence === "cross_verified" ? "Verified" : "Provisional"}</span>
                <Link href="/map" className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-secondary"><MapPin className="mr-0.5 inline h-3 w-3" />Map</Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MapTab() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-12 text-center">
      <MapIcon className="h-8 w-8 text-primary" />
      <div className="text-[15px] font-semibold">Field Map</div>
      <p className="max-w-sm text-[13px] text-muted-foreground">The full-bleed field map — green pins for verified fresh leads, lasso to assign, tap a house to check on the spot.</p>
      <Link href="/map" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground hover:opacity-90" data-testid="fi-open-map">
        Open Field Map <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function ComingSoon() {
  const { data } = useQuery<{ sweeps: StateSweep[] }>({
    queryKey: ["/api/sweeps/state"],
    queryFn: () => apiRequest("GET", "/api/sweeps/state").then((r) => r.json()),
    refetchInterval: 15000,
  });
  const total = (data?.sweeps ?? []).reduce((n, s) => n + (s.comingSoon ?? 0), 0);
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-card px-4 py-4">
        <div className="text-[28px] font-bold tabular-nums text-cyan-400">{total}</div>
        <div className="text-[12px] text-muted-foreground">Addresses flagged <span className="font-medium text-foreground">Coming Soon</span> (future/pending construction) across the active NC &amp; SC sweeps.</div>
      </div>
      <p className="px-1 text-[12px] text-muted-foreground">Coming Soon addresses are stored separately from active fresh leads and automatically re-checked as their completion date approaches — they promote into <span className="font-medium text-foreground">Fresh Now</span> the moment fiber goes live.</p>
    </div>
  );
}

function Coverage() {
  const { data } = useQuery<{ sweeps: StateSweep[] }>({
    queryKey: ["/api/sweeps/state"],
    queryFn: () => apiRequest("GET", "/api/sweeps/state").then((r) => r.json()),
    refetchInterval: 15000,
  });
  const sweeps = data?.sweeps ?? [];
  const sum = (k: keyof StateSweep) => sweeps.reduce((n, s) => n + (Number(s[k]) || 0), 0);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["Discovered", sum("discovered")], ["Checked", sum("checked")], ["Fresh leads", sum("freshLeads")], ["Unresolved", sum("unresolved")]].map(([l, v]) => (
          <div key={l as string} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className="text-[20px] font-bold leading-none tabular-nums text-foreground">{v as number}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{l as string}</div>
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">NC &amp; SC statewide sweeps</div>
        {sweeps.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">No active sweep. The statewide sweep resumes on each deploy and continues in the background.</div>
        ) : sweeps.map((s) => (
          <div key={s.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-[12px] font-bold text-primary">{s.state}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">{s.currentCity ? `Scanning ${s.currentCity}` : s.status}</div>
              <div className="text-[11px] text-muted-foreground">{s.citiesCompleted}/{s.citiesTotal} cities · {s.checked} checked · {s.freshLeads} fresh</div>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${s.status === "running" ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}>{s.status}</span>
          </div>
        ))}
      </div>
      <Link href="/map" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary hover:underline">Open the coverage map <ExternalLink className="h-3.5 w-3.5" /></Link>
    </div>
  );
}
