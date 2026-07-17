import { lazy, Suspense, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Zap, Map as MapIcon, Clock, Layers, Activity, ArrowRight, MapPin, ExternalLink,
  Hammer, Building2, AlertTriangle, Flame,
} from "lucide-react";

// The Scan Inspector is heavy (SSE stream + live table) and admin-only, so it is
// code-split and only mounted when the Operations tab is opened.
const ScanInspector = lazy(() => import("@/components/fiber/ScanInspector"));
// Rep-facing sales intelligence: ranked fresh leads + the Coming Soon watchlist.
const RankedLeads = lazy(() => import("@/components/fiber/RankedLeads"));
const ComingSoonWatchlist = lazy(() => import("@/components/fiber/ComingSoonWatchlist"));

type TabKey = "fresh" | "newlylit" | "map" | "newbuilds" | "coming" | "coverage" | "ops";
interface FirstSeenLive {
  windowHours: number; count: number; confirmed: number; provisional: number; readyToAssign: number;
  addresses: Array<{ id: number; address: string; city: string; firstSeenLiveAt: string; confidence: string; leadId?: number | null }>;
}
interface StateSweep {
  id: string; state: "NC" | "SC" | "GA"; status: string; currentCity: string | null;
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
  { key: "newlylit", label: "Newly Lit", icon: Flame },
  { key: "map", label: "Map", icon: MapIcon },
  { key: "newbuilds", label: "New Builds", icon: Hammer },
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
        <p className="text-[13px] text-muted-foreground">Real-time fresh-fiber detection across GA, NC &amp; SC — one workspace.</p>
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
        {tab === "newlylit" && <NewlyLit />}
        {tab === "map" && <MapTab />}
        {tab === "newbuilds" && <NewBuilds isAdmin={isAdmin} />}
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
      {/* Sales-intelligence ordering: green assignable leads ranked hottest-first. */}
      <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
        <RankedLeads />
      </Suspense>
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

// ── Newly Lit — COMING_SOON / dark addresses that transitioned to live fiber ──
// A 7-day window (vs Fresh Now's 24h) so a rep sees every recent lighting they
// can still be first to knock. Cross-verified, assign-ready transitions lead.
function NewlyLit() {
  const { data, isLoading } = useQuery<FirstSeenLive>({
    queryKey: ["/api/scan/first-seen-live", "7d"],
    queryFn: () => apiRequest("GET", "/api/scan/first-seen-live?hours=168").then((r) => r.json()),
    refetchInterval: 15000,
    staleTime: 10000,
  });
  const lit = (data?.addresses ?? []).slice().sort((a, b) =>
    (b.confidence === "cross_verified" ? 1 : 0) - (a.confidence === "cross_verified" ? 1 : 0)
    || +new Date(b.firstSeenLiveAt) - +new Date(a.firstSeenLiveAt));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[["Lit (7d)", data?.count ?? 0, "text-amber-400"], ["Verified", data?.confirmed ?? 0, "text-emerald-400"], ["Assignable", data?.readyToAssign ?? 0, "text-sky-400"]].map(([l, v, t]) => (
          <div key={l as string} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className={`text-[22px] font-bold leading-none tabular-nums ${t}`}>{v as number}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{l as string}</div>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Flame className="h-3 w-3 text-amber-400" /> Addresses that went from dark / Coming Soon to live fiber in the last 7 days</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {isLoading && !data ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-2 w-2 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-20 rounded-full" /></div>
          ))}</div>
        ) : lit.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] italic text-muted-foreground">No newly lit addresses in the last 7 days — Coming Soon watchlists promote here automatically the moment fiber activates.</div>
        ) : (
          <div className="divide-y divide-border">
            {lit.slice(0, 60).map((a) => (
              <div key={a.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`newlylit-row-${a.id}`}>
                <Flame className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{a.address}, {a.city}</div>
                  <div className="text-[11px] text-muted-foreground">Lit {fmtTime(a.firstSeenLiveAt)}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${a.confidence === "cross_verified" ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>{a.confidence === "cross_verified" ? "Verified" : "Provisional"}</span>
                {a.leadId != null
                  ? <Link href={`/lead/${a.leadId}`} className="shrink-0 rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90">Open lead</Link>
                  : <Link href="/map" className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-secondary"><MapPin className="mr-0.5 inline h-3 w-3" />Map</Link>}
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

interface ComingSoonWatchlist {
  watching: number; promoted: number; dueNow: number;
  rows: Array<{
    id: number; address: string; city: string; state: string; zip: string;
    firstSeenAt: string; lastSeenAt: string; expectedCompletionAt: string | null;
    confidence: string; opportunityScore: number; nextCheckAt: string;
    status: "watching" | "promoted" | "retired"; promotedLeadId: number | null; checks: number;
  }>;
}

// ── Coming Soon — the durable watchlist. Every address the Kinetic search flags
// as fiber-built-but-not-yet-orderable, re-checked on an opportunity-weighted
// cadence by the built-in worker, and promoted to a green Fresh Lead the moment
// billing goes inactive. ───────────────────────────────────────────────────────
function ComingSoon() {
  const { data, isLoading } = useQuery<ComingSoonWatchlist>({
    queryKey: ["/api/coming-soon/program"],
    queryFn: () => apiRequest("GET", "/api/coming-soon/program").then((r) => r.json()),
    refetchInterval: 15000,
    staleTime: 10000,
  });
  const rows = data?.rows ?? [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[["Watching", data?.watching ?? 0, "text-cyan-400"], ["Promoted", data?.promoted ?? 0, "text-emerald-400"], ["Due now", data?.dueNow ?? 0, "text-amber-400"]].map(([l, v, t]) => (
          <div key={l as string} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className={`text-[22px] font-bold leading-none tabular-nums ${t}`}>{v as number}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{l as string}</div>
          </div>
        ))}
      </div>
      <p className="px-1 text-[12px] text-muted-foreground">The built-in Coming Soon worker re-checks every watched address on an opportunity-weighted cadence (hottest first) and promotes it into <span className="font-medium text-foreground">Fresh Now</span> with a green assignable pin the moment fiber becomes orderable.</p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {isLoading && !data ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-2 w-2 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-20 rounded-full" /></div>
          ))}</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] italic text-muted-foreground">No Coming Soon addresses yet — every Kinetic search that returns one lands here automatically and stays under watch.</div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`coming-row-${r.id}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${r.status === "promoted" ? "bg-emerald-400" : "animate-pulse bg-cyan-400"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{r.address}, {r.city}, {r.state}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Watched since {fmtTime(r.firstSeenAt)} · {r.checks} checks
                    {r.expectedCompletionAt ? ` · expected ${fmtTime(r.expectedCompletionAt)}` : ""}
                    {r.status === "watching" ? ` · next check ${fmtTime(r.nextCheckAt)}` : ""}
                  </div>
                </div>
                {r.status === "watching" && (
                  <span className="shrink-0 rounded-full bg-cyan-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-cyan-400" title="Opportunity score">#{r.opportunityScore}</span>
                )}
                {r.status === "promoted" && r.promotedLeadId != null ? (
                  <Link href={`/lead/${r.promotedLeadId}`} className="shrink-0 rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90">Open lead</Link>
                ) : r.status === "promoted" ? (
                  <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-400">Promoted</span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="px-1 text-[12px] text-muted-foreground">Coming Soon addresses are stored separately from active fresh leads and automatically re-checked as their completion date approaches — they promote into <span className="font-medium text-foreground">Fresh Now</span> the moment fiber goes live.</p>
      <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
        <ComingSoonWatchlist />
      </Suspense>
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
        <div className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">GA, NC &amp; SC statewide sweeps</div>
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

// ── New Builds — newly-appearing NC/SC addresses flowing into Fiber Intelligence ─
interface NewBuildRow {
  id: number; address: string | null; city: string | null; state: string; zip: string | null; county: string | null;
  source: string; sources: string[]; buildStage: string; confidence: string; monitored: boolean;
  clusterId: string | null; detectedAt: number; fiberStatus: string | null; billingStatus: string | null;
  leadId: number | null; checkedAt: string | null; actionable: boolean;
}
interface NewBuildFeed {
  rows: NewBuildRow[];
  counts: { total: number; addressed: number; monitored: number; checked: number; leads: number; clusters: number };
}
interface Coverage {
  sources: Array<{ state: string; county: string | null; source: string; scope: string; status: string; recordsSeen: number; newFound: number; lastPollAt: number | null; note: string | null }>;
  summary: { ncCountiesTracked: number; ncCountiesSeeded: number; scCountiesTracked: number; scCountiesSeeded: number; scTilesTracked: number; gaps: number; staleOverMin: number };
}
interface ExpansionFeed {
  expansions: Array<{
    id: string; origin: { address: string; city: string; state: string };
    status: string; ring: number; radiusM: number; emptyStreak: number;
    addressesChecked: number; freshFound: number;
    newLeads: Array<{ address: string; distanceM: number; leadId: number | null }>;
  }>;
  summary: { active: number; exhausted: number; freshFound: number; addressesChecked: number };
}
const SOURCE_LABEL: Record<string, string> = { nc_onemap: "NC OneMap", osm_overpass: "OSM", new_build: "New Build", lead_expansion: "Expansion" };
function relMs(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function NewBuilds({ isAdmin }: { isAdmin: boolean }) {
  const [state, setState] = useState<"all" | "NC" | "SC">("all");
  const [stage, setStage] = useState<"all" | "addressed" | "monitored" | "actionable">(isAdmin ? "all" : "actionable");
  const { data, isLoading } = useQuery<NewBuildFeed>({
    queryKey: ["/api/newbuilds/live"],
    queryFn: () => apiRequest("GET", "/api/newbuilds/live?hours=168").then((r) => r.json()),
    refetchInterval: 8000, staleTime: 5000,
  });
  const cov = useQuery<Coverage>({
    queryKey: ["/api/newbuilds/coverage"],
    queryFn: () => apiRequest("GET", "/api/newbuilds/coverage").then((r) => r.json()),
    refetchInterval: 30000, enabled: isAdmin,
  });
  const exp = useQuery<ExpansionFeed>({
    queryKey: ["/api/expansions/live"],
    queryFn: () => apiRequest("GET", "/api/expansions/live").then((r) => r.json()),
    refetchInterval: 8000, enabled: isAdmin,
  });

  const rows = (data?.rows ?? []).filter((r) =>
    (state === "all" || r.state === state) &&
    (stage === "all" || (stage === "addressed" && r.buildStage === "addressed" && !r.monitored) || (stage === "monitored" && r.monitored) || (stage === "actionable" && r.actionable)),
  );
  const gaps = (cov.data?.sources ?? []).filter((s) => s.status === "missing");

  return (
    <div className="space-y-3">
      {/* Counts */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {[
          ["New builds", data?.counts.total ?? 0, "text-foreground"],
          ["Addressed", data?.counts.addressed ?? 0, "text-sky-400"],
          ["Monitored", data?.counts.monitored ?? 0, "text-amber-400"],
          ["Checked", data?.counts.checked ?? 0, "text-violet-300"],
          ["Leads", data?.counts.leads ?? 0, "text-emerald-400"],
          ["Clusters", data?.counts.clusters ?? 0, "text-primary"],
        ].map(([l, v, t]) => (
          <div key={l as string} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className={`text-[20px] font-bold leading-none tabular-nums ${t}`}>{v as number}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{l as string}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" /> Live · streaming into Fiber Intelligence</span>
        <div className="ml-auto flex gap-1">
          {(["all", "NC", "SC"] as const).map((s) => (
            <button key={s} onClick={() => setState(s)} className={`rounded-lg px-2.5 py-1 font-semibold ${state === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-secondary"}`}>{s === "all" ? "All" : s}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {(isAdmin ? (["all", "addressed", "monitored", "actionable"] as const) : (["actionable"] as const)).map((s) => (
            <button key={s} onClick={() => setStage(s)} className={`rounded-lg px-2.5 py-1 font-semibold capitalize ${stage === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-secondary"}`}>{s}</button>
          ))}
        </div>
      </div>

      {/* Admin: live lead-triggered cluster expansions */}
      {isAdmin && (exp.data?.expansions?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-emerald-500/25 bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Lead cluster expansions</div>
            <div className="text-[11px] text-muted-foreground">{exp.data!.summary.active} active · {exp.data!.summary.freshFound} new leads · {exp.data!.summary.addressesChecked} checked</div>
          </div>
          {exp.data!.expansions.slice(0, 6).map((e) => (
            <div key={e.id} className="border-b border-border/60 px-4 py-2.5 last:border-0" data-testid={`expansion-${e.id}`}>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                <span className="truncate text-[13px] font-medium text-foreground">{String(e.origin.address).split(",")[0]}, {e.origin.city}</span>
                <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${e.status === "active" ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}>{e.status}</span>
              </div>
              <div className="pl-4 text-[11px] text-muted-foreground">
                radius {(e.radiusM / 1000).toFixed(1)}km · ring {e.ring} · {e.addressesChecked} checked · <span className="font-medium text-emerald-400">{e.newLeads.length} new green leads</span>{e.emptyStreak > 0 ? ` · ${e.emptyStreak} empty ring${e.emptyStreak > 1 ? "s" : ""}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Admin: coverage gaps banner */}
      {isAdmin && gaps.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] text-amber-300">
          <div className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" /> {gaps.length} source coverage gap{gaps.length > 1 ? "s" : ""}</div>
          {gaps.map((g) => <div key={g.source} className="text-[11px] text-amber-300/80">· <span className="font-medium">{g.scope}</span>: {g.note}</div>)}
        </div>
      )}

      {/* Feed */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {isLoading && !data ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-8 w-8 rounded-lg" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-20 rounded-full" /></div>
          ))}</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] italic text-muted-foreground">
            {isAdmin ? "No new builds detected yet in this window. The radar polls NC OneMap + OSM continuously; new addresses appear here and are checked immediately." : "No actionable new-build leads yet. Verified fresh-fiber new builds appear here ready to knock."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`newbuild-row-${r.id}`}>
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${r.actionable ? "bg-emerald-500/15 text-emerald-400" : r.monitored ? "bg-amber-500/15 text-amber-400" : "bg-primary/12 text-primary"}`}>
                  {r.monitored ? <Building2 className="h-4 w-4" /> : <Hammer className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{r.address ?? `Addressless building${r.county ? ` · ${r.county} Co.` : ""}`}{r.city ? `, ${r.city}` : ""}</div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>{r.state}{r.zip ? ` ${r.zip}` : ""}</span>
                    <span>· {r.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")}</span>
                    <span>· {relMs(r.detectedAt)}</span>
                    {r.clusterId && isAdmin && <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">cluster</span>}
                  </div>
                </div>
                {/* status */}
                <div className="flex shrink-0 items-center gap-2">
                  {r.leadId ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400">Lead</span>
                    : r.actionable ? <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400">Fresh fiber</span>
                    : r.monitored ? <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-400">Monitoring</span>
                    : r.checkedAt ? <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">{(r.fiberStatus ?? "checked").replace(/_/g, " ")}</span>
                    : <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-sky-300">Checking</span>}
                  {r.address && <Link href="/map" className="rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-secondary"><MapPin className="mr-0.5 inline h-3 w-3" />Map</Link>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Admin: source coverage summary */}
      {isAdmin && cov.data && (
        <div className="rounded-2xl border border-border bg-card px-4 py-3 text-[12px]">
          <div className="mb-1 font-semibold text-foreground">Source coverage</div>
          <div className="text-[11px] text-muted-foreground">
            NC OneMap: {cov.data.summary.ncCountiesTracked}/100 counties tracked · SC county GIS: {cov.data.summary.scCountiesTracked} · SC OSM tiles: {cov.data.summary.scTilesTracked} · gaps: {cov.data.summary.gaps} · stale: {cov.data.summary.staleOverMin}
          </div>
        </div>
      )}
    </div>
  );
}
