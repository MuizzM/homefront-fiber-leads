import { lazy, Suspense, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useRovingTabs } from "@/hooks/use-roving-tabs";
import { useAuth } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";
import { Zap, Clock, Layers, Hammer } from "lucide-react";
import { openLeadOnFieldMap } from "@/lib/leadMapNavigation";

// The Scan Inspector is heavy (SSE stream + live table) and admin-only, so it is
// code-split and only mounted when the Coverage tab is opened by an admin.
const ScanInspector = lazy(() => import("@/components/fiber/ScanInspector"));
// Ranked fresh leads — the "knock these doors first" list on the Fresh Now tab.
const RankedLeads = lazy(() => import("@/components/fiber/RankedLeads"));
// Run a city from the UI: OSM harvest, probe each street, park the streets with
// no fiber. Admin-only, because starting one spends provider budget.
const CitySweepRunner = lazy(() => import("@/components/fiber/CitySweepRunner"));
// What the transport is doing right now: which residential IP and token are in
// use, and how much of the 20-check pair budget is left.
const EgressLive = lazy(() => import("@/components/fiber/EgressLive"));
// Statically imported (it's tiny) so the Coming Soon tab header can share the
// exact watchlist query — the big "Watching" count and the list count can
// never disagree.
import ComingSoonWatchlist, { WATCHLIST_QUERY, type WatchlistResult } from "@/components/fiber/ComingSoonWatchlist";

// ONE workspace, FOUR jobs: what's hot right now (Fresh Now), what's about to
// be (Coming Soon), what's being built (New Builds), and how far the machine
// has swept (Coverage). The old Newly Lit tab was the same first-seen data on
// a longer window — now a 24h/7d toggle here — and the old Map tab was just a
// link (the sidebar already has the Field Map).
type TabKey = "fresh" | "neighborhoods" | "coming" | "newbuilds" | "coverage";
interface FirstSeenLive {
  windowHours: number; count: number; confirmed: number; provisional: number; readyToAssign: number;
  addresses: Array<{ id: number; address: string; city: string; state: string; zip?: string | null; lat: number; lng: number; firstSeenLiveAt: string; confidence: string; leadId?: number | null; carrier?: string }>;
}
interface StateSweep {
  id: string; state: "FL" | "GA" | "IA" | "KY" | "NC" | "SC"; status: string; currentCity: string | null;
  citiesTotal: number; citiesCompleted: number; discovered?: number; checked: number;
  freshLeads: number; comingSoon: number; pending?: number; unresolved: number;
}
interface MarketCoverageCard {
  city: string; state: string; poolSize: number; verified: number; leads: number;
  verifiedNewFiber: number; unworkedLeads: number; newlyLive: number;
}
interface MarketCoverageResponse { markets: MarketCoverageCard[] }
interface MarketRunSummary {
  id: string; label: string; city: string | null; state: string | null; budget: number;
  verified: number; newFiber: number; newlyLive: number; failed: number; status: string;
  costUsd: number; active: boolean; startedAt: string; completedAt: string | null;
}

function fmtTime(iso: string): string {
  const s = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const d = new Date(s);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Math.abs(mins) < 1) return "just now";
  if (mins < 0) {
    // Future timestamps (Coming Soon ETAs, next-check times) — mirror of the
    // past branch, so "expected in 3d" instead of "expected just now".
    const m = -mins;
    if (m < 60) return `in ${m}m`;
    if (m < 1440) return `in ${Math.floor(m / 60)}h`;
    return `in ${Math.ceil(m / 1440)}d`;
  }
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TABS: Array<{ key: TabKey; label: string; icon: any }> = [
  { key: "fresh", label: "Fresh Now", icon: Zap },
  { key: "neighborhoods", label: "Neighborhoods", icon: Layers },
  { key: "coming", label: "Coming Soon", icon: Clock },
  { key: "newbuilds", label: "New Builds", icon: Hammer },
  { key: "coverage", label: "Coverage", icon: Layers },
];

export default function FiberIntelligence() {
  const { user } = useAuth();
  // Mirror the server's middleware exactly (server/routes.ts): requireManager
  // (all Fiber Intelligence data endpoints) allows admin + manager;
  // requireAdmin (the Scan Inspector endpoints) allows admin only. Showing a
  // surface the server will 403 just renders a permanently dead panel.
  const isManager = user?.role === "admin" || user?.role === "manager";
  const isAdmin = user?.role === "admin";
  const [tab, setTab] = useState<TabKey>("fresh");
  // Arrow-key movement for the tablist the role below promises.
  const fiRoving = useRovingTabs(TABS.length, Math.max(0, TABS.findIndex(t => t.key === tab)), (i) => setTab(TABS[i].key));

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-4 pb-6 pt-4 sm:px-6">
      <header className="mb-3">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Fiber Intelligence</h1>
        <p className="text-[13px] text-muted-foreground">Real-time fresh-fiber detection across FL, GA, IA, KY, NC &amp; SC - one workspace.</p>
      </header>

      <div className="relative sticky top-0 z-10 -mx-4 mb-4 sm:-mx-6">
      <div role="tablist" aria-label="Fiber Intelligence sections" onKeyDown={fiRoving.onKeyDown} className="overflow-x-auto border-b border-border bg-background/80 px-4 backdrop-blur-xl sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="flex gap-1">
          {TABS.map(({ key, label, }, tabIdx) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              tabIndex={tab === key ? 0 : -1}
              ref={fiRoving.itemRef(tabIdx)}
              onClick={(e) => { setTab(key); (e.currentTarget as HTMLElement).scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" }); }}
              data-testid={`fi-tab-${key}`}
              className={`relative flex min-h-11 md:min-h-10 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-[13px] font-semibold transition-colors ${tab === key ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
               {label}
              {tab === key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
      </div>
      {/* Overflow hint on the narrowest phones: fades the clipped edge. */}
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent sm:hidden" />
      </div>

      <div className="min-h-0 flex-1">
        {tab === "fresh" && <FreshNow />}
        {tab === "neighborhoods" && <Neighborhoods isManager={isManager} isAdmin={isAdmin} />}
        {tab === "newbuilds" && <NewBuilds isManager={isManager} />}
        {tab === "coming" && <ComingSoon />}
        {tab === "coverage" && <Coverage isAdmin={isAdmin} />}
      </div>
    </div>
  );
}

/** "2026-07-18" -> "Jul 18" - the day a scan found the promise. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Kinetic states a MONTH ("NOV-2026"), which we store as the 1st; Frontier
 * states an exact day. Rendering both as "Mon YYYY" put two different promises
 * on two chips reading "Dec 2026", so a day that is not the 1st keeps its day.
 */
function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const exactDay = d.getUTCDate() !== 1;
  return d.toLocaleDateString("en-US", exactDay
    ? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }
    : { month: "short", year: "numeric", timeZone: "UTC" });
}

// ── Neighborhoods — whole-neighborhood sweep: which clusters are fresh and
// unknocked, which are still being flooded, and whether the sweep is running. ──
interface NeighborhoodRow {
  cellLat: number; cellLng: number; city: string; state: string; phase: string; reasons: string[];
  scanned: number; hits: number; live: number; unscanned: number; staleNegatives: number;
  lastHitAt: string | null; run: { status: string; verified: number; budget: number; newFiber: number } | null;
  leads: number; unworkedLeads: number; knockedLeads: number; assignedLeads: number; sampleLeadId: number | null;
}
interface SweepState {
  enabled: boolean; state: string; intervalMin: number; cells: Record<string, number>;
  neighborhoodsWithUnworked: number; unworkedFreshDoors: number;
  unscannedInHotCells: number; unlinkedGreens: number; pending: number;
  coming?: {
    active: number; dated: number; overdue: number; dueNow: number;
    byBand: Record<string, number>; byStatus: Record<string, number>;
    nextDates: Array<{ date: string; doors: number }>;
    foundOn: Array<{ day: string; doors: number; dated: number }>;
    oldestFoundAt: number | null; newestFoundAt: number | null;
  };
  lastCycle: { started_at: string; budget: number; confirm: number; flood: number; probe: number; flood_cells: number; probe_cells: number; skipped: string | null; superseded_runs: number; drain_per_min: number } | null;
  last24h: { checks: number; hits: number; leads: number };
}
const REASON_LABEL: Record<string, string> = {
  hit_in_cell: "fiber found here", recent_hit: "hit this month", neighbor_hits: "fiber next door",
  unlinked_greens: "known doors to confirm", announced_build: "announced build", fcc_build_evidence: "FCC build block",
  coming_soon: "coming soon", tenured_fiber_present: "older fiber nearby", cold: "not yet probed", probed_no_hit: "probed, no hit yet",
};
function Neighborhoods({ isManager, isAdmin }: { isManager: boolean; isAdmin: boolean }) {
  const [, navigate] = useLocation();
  const { data: state } = useQuery<SweepState>({
    queryKey: ["/api/sweep/state"],
    queryFn: () => apiRequest("GET", "/api/sweep/state").then((r) => r.json()),
    refetchInterval: 20_000, staleTime: 10_000, enabled: isManager,
  });
  const { data, isLoading } = useQuery<{ neighborhoods: NeighborhoodRow[] }>({
    queryKey: ["/api/sweep/neighborhoods"],
    queryFn: () => apiRequest("GET", "/api/sweep/neighborhoods?limit=60").then((r) => r.json()),
    refetchInterval: 20_000, staleTime: 10_000, enabled: isManager,
  });
  const [nudging, setNudging] = useState(false);
  const [nudgeNote, setNudgeNote] = useState<string | null>(null);
  const nudge = async () => {
    setNudging(true); setNudgeNote(null);
    try {
      const r = await apiRequest("POST", "/api/sweep/cycle");
      const body = await r.json().catch(() => ({}));
      setNudgeNote(r.ok
        ? `Cycle done: ${body.confirm ?? 0} confirm, ${body.flood ?? 0} flood across ${body.floodCells ?? 0} cells, ${body.probe ?? 0} probe${body.skipped ? ` (skipped: ${body.skipped})` : ""}`
        : body.error ?? `Cycle refused (${r.status})`);
    } catch (e: any) { setNudgeNote(e?.message ?? "Cycle failed"); }
    finally { setNudging(false); }
  };
  if (!isManager) {
    return <div className="rounded-2xl border border-border bg-card px-4 py-10 text-center text-[13px] text-muted-foreground">Neighborhood sweeps are a manager view. Your fresh doors appear on Fresh Now and the Field Map.</div>;
  }
  const rows = data?.neighborhoods ?? [];
  const cells = state?.cells ?? {};
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Neighborhoods with unknocked fresh doors" value={state?.neighborhoodsWithUnworked ?? 0} tone="text-success" />
        <StatTile label="Unknocked fresh doors" value={state?.unworkedFreshDoors ?? 0} tone="text-success" />
        <StatTile label="Doors left in hot neighborhoods" value={state?.unscannedInHotCells ?? 0} tone="text-primary" />
        <StatTile label="Fresh leads last 24h" value={state?.last24h.leads ?? 0} tone="text-foreground" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card px-4 py-3" data-testid="sweep-status">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${state?.enabled ? "bg-success animate-pulse" : "bg-muted-foreground/40"}`} aria-hidden />
            Neighborhood sweep {state ? (state.enabled ? "running" : "off") : "..."}{state?.state ? ` · ${state.state}` : ""}
          </div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">
            {state?.lastCycle
              ? `Last cycle ${fmtTime(state.lastCycle.started_at)}: ${state.lastCycle.confirm} confirm, ${state.lastCycle.flood} flood across ${state.lastCycle.flood_cells} neighborhoods, ${state.lastCycle.probe} probe across ${state.lastCycle.probe_cells}${state.lastCycle.skipped ? ` (skipped: ${state.lastCycle.skipped.replace(/_/g, " ")})` : ""}. ${state.pending.toLocaleString()} queued.`
              : state?.enabled ? "No cycle recorded yet." : "Turn on NEIGHBORHOOD_SWEEP to keep the scanner on whole neighborhoods."}
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {(cells.flood ?? 0).toLocaleString()} hot · {(cells.probe ?? 0).toLocaleString()} to probe · {(cells.parked ?? 0).toLocaleString()} parked · {(cells.complete ?? 0).toLocaleString()} complete · {(state?.unlinkedGreens ?? 0).toLocaleString()} known doors still to confirm · {(state?.last24h.checks ?? 0).toLocaleString()} checks in 24h
          </div>
        </div>
        {isAdmin && (
          <div className="flex flex-col items-end gap-1">
            <button type="button" onClick={nudge} disabled={nudging || !state?.enabled} data-testid="sweep-cycle-now"
              className="min-h-10 rounded-lg border border-border px-3 text-[12px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {nudging ? "Running cycle" : "Run a cycle now"}
            </button>
            {nudgeNote && <div className="max-w-xs text-right text-[11px] text-muted-foreground">{nudgeNote}</div>}
          </div>
        )}
      </div>
      {(state?.coming?.active ?? 0) > 0 && (
        <div className="rounded-2xl border border-info/20 bg-card px-4 py-3" data-testid="coming-board">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-info">Fiber the provider says is coming</div>
            <div className="text-[11px] text-muted-foreground">
              {state!.coming!.active.toLocaleString()} doors · {state!.coming!.dated.toLocaleString()} with a stated month
              {state!.coming!.overdue > 0 ? ` · ${state!.coming!.overdue} past due` : ""}
            </div>
          </div>
          {state!.coming!.nextDates.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-medium text-muted-foreground">Turns on</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {state!.coming!.nextDates.map((d) => (
                  <span key={d.date} className="rounded-lg border border-border bg-background px-2 py-1 text-[11px] text-foreground">
                    <b className="tabular-nums">{d.doors}</b> doors <span className="text-muted-foreground">{monthLabel(d.date)}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          {(state!.coming!.foundOn?.length ?? 0) > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-medium text-muted-foreground">Found on</div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {state!.coming!.foundOn.slice(0, 8).map((f) => (
                  <span key={f.day} className="rounded-lg border border-border/60 bg-background px-2 py-1 text-[11px] text-muted-foreground">
                    <b className="tabular-nums text-foreground">{f.doors}</b> {dayLabel(f.day)}
                    {f.dated > 0 ? <span className="text-muted-foreground/70"> · {f.dated} dated</span> : null}
                  </span>
                ))}
              </div>
            </div>
          )}
          <p className="mt-2 text-[12px] text-muted-foreground">Two different dates: when the scan found the promise, and the month the provider says it turns on. Recorded from the provider's own answer. These doors are re-checked once, on their date - nothing else answered is ever re-checked.</p>
        </div>
      )}
      <p className="px-1 text-[12px] text-muted-foreground">Ranked by fresh doors nobody has knocked. A neighborhood is a 1 km cell; the sweep checks every door in a cell once any door there comes back NEW FIBER, street by street, then moves to the cells around it. Open one on the map and lasso it to a crew.</p>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {isLoading && !data ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-20 rounded-full" /></div>
          ))}</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            {state?.enabled ? "No neighborhoods ranked yet. The first cycle builds the list from every NC door the scanner knows." : "The sweep is off, so there is no neighborhood list. Fresh Now still shows every confirmed door."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => {
              const done = r.run ? Math.min(100, Math.round((r.run.verified / Math.max(1, r.run.budget)) * 100)) : null;
              const label = r.city ? r.city.replace(/\b\w/g, (c) => c.toUpperCase()) : "Unnamed";
              return (
                <div key={`${r.cellLat}_${r.cellLng}`} className="flex min-w-0 items-center gap-3 px-4 py-3" data-testid={`neighborhood-${r.cellLat}-${r.cellLng}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-[14px] font-semibold text-foreground">{label}</span>
                      <span className="text-[11px] tabular-nums text-muted-foreground">{r.cellLat.toFixed(2)}, {r.cellLng.toFixed(2)}</span>
                      {r.unworkedLeads > 0 && <span className="rounded-full bg-success/10 px-2 py-0.5 text-2xs font-bold uppercase text-success">{r.unworkedLeads} unknocked</span>}
                      {r.phase === "flood" && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-semibold uppercase text-primary">{r.run?.status === "running" ? "sweeping" : "hot"}</span>}
                      {r.phase === "probe" && <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-semibold uppercase text-muted-foreground">probing</span>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span><b className="text-foreground">{r.hits}</b> NEW FIBER of {r.scanned} checked</span>
                      <span><b className="text-foreground">{r.unscanned}</b> doors left</span>
                      <span><b className="text-foreground">{r.leads}</b> leads · {r.knockedLeads} knocked · {r.assignedLeads} assigned</span>
                      {done != null && r.run && <span>run {done}% ({r.run.newFiber} fresh so far)</span>}
                      {r.lastHitAt && <span>last hit {fmtTime(r.lastHitAt)}</span>}
                    </div>
                    {r.reasons.length > 0 && (
                      <div className="mt-0.5 text-[11px] text-muted-foreground/80">{r.reasons.map((x) => REASON_LABEL[x] ?? x.replace(/_/g, " ")).join(" · ")}</div>
                    )}
                  </div>
                  {r.sampleLeadId ? (
                    <button type="button" onClick={() => openLeadOnFieldMap({ leadId: r.sampleLeadId!, lat: r.cellLat, lng: r.cellLng }, navigate)}
                      className="min-h-10 shrink-0 rounded-lg border border-border px-3 text-[12px] font-semibold text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid={`neighborhood-map-${r.cellLat}-${r.cellLng}`}>
                      Map
                    </button>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground">no leads yet</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Shared stat tile — one treatment for every counter in the workspace ──────
function StatTile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className={`text-[22px] font-bold leading-none tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

// Item counts on the stat tiles can exceed what a capped list renders — say so
// instead of silently truncating, so the numbers never look wrong.
function TruncationNote({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <div className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground">
      Showing first {shown} of {total}
    </div>
  );
}

// ── Fresh Now — every lead worth knocking, hottest first. Merges the old
// "Newly Lit" tab: the 24h/7d toggle switches the first-seen window, and the
// transition feed (went live · copper→fiber · coming soon · lost) rides below
// so one tab answers "what changed and what do I knock". ─────────────────────
interface FiberChanges {
  count: number; wentLive: number; copperUpgrades: number; comingSoon: number;
  rows: Array<{
    id: number; scanTargetId: number; kind: "went_live" | "copper_upgrade" | "coming_soon" | "lost_fiber";
    address: string; city: string; state: string; lat: number | null; lng: number | null; leadId: number | null; at: string;
  }>;
}

const KIND_STYLE: Record<string, { label: string; cls: string }> = {
  copper_upgrade: { label: "Copper to Fiber", cls: "bg-warning/10 text-warning" },
  went_live: { label: "Went live", cls: "bg-warning/10 text-warning" },
  coming_soon: { label: "Coming soon", cls: "bg-info/10 text-info" },
  lost_fiber: { label: "Lost", cls: "bg-destructive/10 text-destructive" },
};

function FreshNow() {
  const [, navigate] = useLocation();
  const [hours, setHours] = useState<24 | 168>(24);
  const { data, isLoading, isError } = useQuery<FirstSeenLive>({
    queryKey: ["/api/scan/first-seen-live", hours],
    queryFn: () => apiRequest("GET", `/api/scan/first-seen-live?hours=${hours}`).then((r) => r.json()),
    refetchInterval: 8000, // near-real-time without an SSE dependency
    staleTime: 5000,
  });
  const { data: changes } = useQuery<FiberChanges>({
    queryKey: ["/api/fiber/changes", "7d"],
    queryFn: () => apiRequest("GET", "/api/fiber/changes?hours=168").then((r) => r.json()),
    refetchInterval: 15000,
    staleTime: 10000,
  });
  const { data: copperPool } = useQuery<{ total: number; byState: Array<{ state: string; n: number }> }>({
    queryKey: ["/api/fiber/copper-pool"],
    queryFn: () => apiRequest("GET", "/api/fiber/copper-pool").then((r) => r.json()),
    refetchInterval: 60000,
  });
  return (
    <div className="space-y-3">
      {/* Window-aware counters + the 24h/7d switch (this toggle IS the old
          Newly Lit tab — same data, wider lens). */}
      <div className="flex items-center gap-2">
        <div className="grid flex-1 grid-cols-3 gap-2">
          <StatTile label="New now" value={data?.count ?? 0} tone="text-primary" />
          <StatTile label="Cross-verified" value={data?.confirmed ?? 0} tone="text-success" />
          <StatTile label="Ready to assign" value={data?.readyToAssign ?? 0} tone="text-info" />
        </div>
        <div className="flex shrink-0 flex-col gap-1" role="group" aria-label="Detection window">
          {([24, 168] as const).map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              aria-pressed={hours === h}
              data-testid={`fi-window-${h}`}
              className={`inline-flex min-h-11 md:min-h-8 items-center rounded-lg px-2.5 py-1 text-[11px] font-bold ${hours === h ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-secondary"}`}
            >{h === 24 ? "24h" : "7d"}</button>
          ))}
        </div>
      </div>
      {/* Sales-intelligence ordering: green assignable leads ranked hottest-first. */}
      <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
        <RankedLeads />
      </Suspense>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        {isError
          ? <span className="inline-flex items-center gap-1 text-warning"><span className="h-1.5 w-1.5 rounded-full bg-warning" /> Connection lost - showing last loaded data</span>
          : <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live · last {hours === 24 ? "24h" : "7 days"}</span>}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {isLoading && !data ? (
          <div className="divide-y divide-border">{[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3"><Skeleton className="h-2 w-2 rounded-full" /><div className="flex-1 space-y-1.5"><Skeleton className="h-3.5 w-2/3" /><Skeleton className="h-2.5 w-2/5" /></div><Skeleton className="h-5 w-20 rounded-full" /></div>
          ))}</div>
        ) : (data?.addresses?.length ?? 0) === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] italic text-muted-foreground">No fresh fiber in this window - the pipeline is watching. New detections stream in here.</div>
        ) : (
          <>
            <div className="divide-y divide-border">
              {data!.addresses.slice(0, 40).map((a) => (
                <div key={a.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`fresh-row-${a.id}`}>
                  <span className={`h-2 w-2 shrink-0 animate-pulse rounded-full ${a.carrier === "frontier" ? "bg-destructive" : "bg-warning"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-foreground">{a.address}, {a.city}</div>
                    <div className="text-[11px] text-muted-foreground">Detected {fmtTime(a.firstSeenLiveAt)}</div>
                  </div>
                  {a.carrier === "frontier" && <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-destructive">Frontier</span>}
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-bold uppercase tracking-wide ${a.confidence === "cross_verified" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>{a.confidence === "cross_verified" ? "Verified" : "Provisional"}</span>
                  {a.leadId != null
                    ? <button type="button" onClick={() => openLeadOnFieldMap({ leadId: a.leadId!, lat: a.lat, lng: a.lng }, navigate)} aria-label={`Open ${a.address}, ${a.city} on the Field Map`} className="inline-flex min-h-11 md:min-h-8 shrink-0 items-center rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90">Open in field</button>
                    : <span className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground">Not assignable</span>}
                </div>
              ))}
            </div>
            <TruncationNote shown={40} total={data!.addresses.length} />
          </>
        )}
      </div>

      {/* Transition feed — every address that changed state in the last 7 days.
          Copper→fiber upgrades lead the list (the competitor-parity lead type). */}
      {(changes?.rows?.length ?? 0) > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Latest transitions - 7 days</div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">{changes!.copperUpgrades} copper upgrades</span>
              <span>· pool {copperPool?.total ?? 0}</span>
            </div>
          </div>
          <div className="divide-y divide-border">
            {changes!.rows.slice(0, 30).map((c) => (
              <div key={c.id} className="flex min-w-0 items-center gap-3 px-4 py-2.5 hover:bg-secondary/40" data-testid={`change-row-${c.id}`}>
                <span className={`h-2 w-2 shrink-0 rounded-full ${c.kind === "copper_upgrade" ? "bg-warning" : c.kind === "went_live" ? "bg-warning" : "bg-info"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{c.address}, {c.city}, {c.state}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtTime(c.at)}</div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-bold uppercase tracking-wide ${KIND_STYLE[c.kind]?.cls ?? ""}`}>{KIND_STYLE[c.kind]?.label ?? c.kind}</span>
                {c.leadId != null && <button type="button" onClick={() => openLeadOnFieldMap({ leadId: c.leadId!, lat: c.lat ?? undefined, lng: c.lng ?? undefined }, navigate)} aria-label={`Open ${c.address}, ${c.city} on the Field Map`} className="inline-flex min-h-11 md:min-h-8 shrink-0 items-center rounded-lg bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90">Open in field</button>}
              </div>
            ))}
          </div>
          <TruncationNote shown={30} total={changes!.rows.length} />
        </div>
      )}
    </div>
  );
}

// Program-level counters for the Coming Soon tiles (promotions + due-now).
interface ComingSoonProgram { watching: number; promoted: number; dueNow: number }

// ── Coming Soon — the durable watchlist. Every address the Kinetic search flags
// as fiber-built-but-not-yet-orderable, re-checked on an opportunity-weighted
// cadence by the built-in worker, and promoted to a green Fresh Lead the moment
// billing goes inactive. ONE list renders it (ComingSoonWatchlist); the
// "Watching" tile reads the same query, so the counts always agree. ───────────
function ComingSoon() {
  const { data: program } = useQuery<ComingSoonProgram>({
    queryKey: ["/api/coming-soon/program"],
    queryFn: () => apiRequest("GET", "/api/coming-soon/program").then((r) => r.json()),
    refetchInterval: 15000,
    staleTime: 10000,
  });
  const { data: watchlist } = useQuery<WatchlistResult | null>(WATCHLIST_QUERY);
  const watching = watchlist?.total ?? 0;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Watching" value={watching} tone="text-info" />
        <StatTile label="Promoted" value={program?.promoted ?? 0} tone="text-success" />
        <StatTile label="Due now" value={program?.dueNow ?? 0} tone="text-warning" />
      </div>
      <p className="px-1 text-[12px] text-muted-foreground">The built-in Coming Soon worker re-checks every watched address on an opportunity-weighted cadence (hottest first) and promotes it into <span className="font-medium text-foreground">Fresh Now</span> with a green assignable pin the moment fiber becomes orderable.</p>
      <ComingSoonWatchlist />
    </div>
  );
}

// ── Coverage — how far the machine has swept, plus (admin only) the live Scan
// Inspector folded in at the bottom: one tab for "is the pipeline healthy". ──
function Coverage({ isAdmin }: { isAdmin: boolean }) {
  // Concord is the current operating focus. The selector keeps this reusable
  // for the next market without falling back to the misleading global stream.
  const [marketKey, setMarketKey] = useState("Concord|NC");
  const { data } = useQuery<{ sweeps: StateSweep[] }>({
    queryKey: ["/api/sweeps/state"],
    queryFn: () => apiRequest("GET", "/api/sweeps/state").then((r) => r.json()),
    refetchInterval: 15000,
  });
  const { data: marketData, isLoading: marketsLoading } = useQuery<MarketCoverageResponse>({
    queryKey: ["/api/scan/markets"],
    queryFn: () => apiRequest("GET", "/api/scan/markets").then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const sweeps = data?.sweeps ?? [];
  const sum = (k: keyof StateSweep) => sweeps.reduce((n, s) => n + (Number(s[k]) || 0), 0);
  const [scopeCity, scopeState] = marketKey === "all" ? [null, null] : marketKey.split("|");
  const marketOptions = useMemo(() => {
    const byKey = new Map<string, { city: string; state: string }>();
    byKey.set("Concord|NC", { city: "Concord", state: "NC" });
    for (const market of marketData?.markets ?? []) byKey.set(`${market.city}|${market.state}`, market);
    return [...byKey.values()].sort((a, b) => {
      if (a.city === "Concord" && a.state === "NC") return -1;
      if (b.city === "Concord" && b.state === "NC") return 1;
      return a.state.localeCompare(b.state) || a.city.localeCompare(b.city);
    });
  }, [marketData]);
  const selectedMarket = scopeCity && scopeState
    ? marketData?.markets.find((m) => m.city.toLowerCase() === scopeCity.toLowerCase() && m.state.toUpperCase() === scopeState.toUpperCase()) ?? null
    : null;
  const scopeLabel = scopeCity && scopeState ? `${scopeCity}, ${scopeState}` : null;
  const runsPath = scopeCity && scopeState
    ? `/api/scan/runs?city=${encodeURIComponent(scopeCity)}&state=${encodeURIComponent(scopeState)}&limit=10`
    : "/api/scan/runs?limit=10";
  const { data: runData } = useQuery<{ runs: MarketRunSummary[] }>({
    queryKey: ["/api/scan/runs", scopeCity, scopeState],
    queryFn: () => apiRequest("GET", runsPath).then((r) => r.json()),
    refetchInterval: 10_000,
    staleTime: 5_000,
    enabled: !!scopeLabel,
  });
  const latestRun = runData?.runs?.[0] ?? null;
  const scopedStats: Array<[string, number | string]> = selectedMarket
    ? [
        ["Discovered", selectedMarket.poolSize],
        ["Checked", selectedMarket.verified],
        ["Fresh leads", selectedMarket.leads],
        ["Unchecked", Math.max(0, selectedMarket.poolSize - selectedMarket.verified)],
      ]
    : marketsLoading
      ? [["Discovered", "—"], ["Checked", "—"], ["Fresh leads", "—"], ["Unchecked", "—"]]
      : [["Discovered", 0], ["Checked", 0], ["Fresh leads", 0], ["Unchecked", 0]];
  const stats: Array<[string, number | string]> = scopeLabel
    ? scopedStats
    : [["Discovered", sum("discovered")], ["Checked", sum("checked")], ["Fresh leads", sum("freshLeads")], ["Unresolved", sum("unresolved")]];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border bg-card px-4 py-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Market focus</div>
          <div className="mt-0.5 text-[13px] text-foreground">Coverage, run progress, and live rows use the same market.</div>
        </div>
        <select
          value={marketKey}
          onChange={(e) => setMarketKey(e.target.value)}
          aria-label="Coverage market"
          data-testid="coverage-market"
          className="h-10 min-w-48 rounded-lg border border-border bg-background px-3 text-[13px] font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All statewide activity</option>
          {marketOptions.map((m) => <option key={`${m.city}|${m.state}`} value={`${m.city}|${m.state}`}>{m.city}, {m.state}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stats.map(([l, v]) => (
          <div key={l as string} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className="text-[20px] font-bold leading-none tabular-nums text-foreground">{typeof v === "number" ? v.toLocaleString() : v}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{l as string}</div>
          </div>
        ))}
      </div>
      <p className="px-1 text-[12px] text-muted-foreground">
        {scopeLabel
          ? `${scopeLabel} totals come from that market's durable address inventory. Fresh leads are confirmed; provisional detections are not counted.`
          : "Fresh leads here are completed sweep classifications. Provisional detections on Fresh Now are not assignable until corroborated."}
      </p>
      {scopeLabel && (
        <div className="rounded-2xl border border-border bg-card px-4 py-3" data-testid="coverage-market-run">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Latest {scopeLabel} scan</div>
              <div className="mt-1 text-[13px] font-medium text-foreground">{latestRun?.label ?? "No scan run recorded for this market"}</div>
            </div>
            {latestRun && <span className={`rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${latestRun.status === "running" || latestRun.active ? "bg-info/10 text-info" : latestRun.status === "error" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{latestRun.active ? "running" : latestRun.status}</span>}
          </div>
          {latestRun && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <span><b className="text-foreground">{latestRun.verified.toLocaleString()}</b> checked of {latestRun.budget.toLocaleString()}</span>
              <span><b className="text-success">{latestRun.newFiber.toLocaleString()}</b> fresh</span>
              <span><b className="text-warning">{latestRun.failed.toLocaleString()}</b> failed</span>
              <span><b className="text-foreground">${Number(latestRun.costUsd ?? 0).toFixed(2)}</b> measured proxy cost</span>
            </div>
          )}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {scopeLabel ? "Background statewide sweeps — excluded from market totals" : "FL, GA, IA, KY, NC & SC statewide sweeps"}
        </div>
        {sweeps.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">No active sweep. The statewide sweep resumes on each deploy and continues in the background.</div>
        ) : sweeps.map((s) => (
          <div key={s.id} className="flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/15 text-[12px] font-bold text-primary">{s.state}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">
                {s.status === "running"
                  ? (s.currentCity ? `Scanning ${s.currentCity}` : "Scanning")
                  : (s.status === "done" ? `Completed ${s.state}` : s.status)}
              </div>
              <div className="text-[11px] text-muted-foreground">{s.citiesCompleted}/{s.citiesTotal} cities · {s.checked} checked · {s.freshLeads} fresh</div>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${s.status === "running" ? "bg-info/10 text-info" : "bg-muted text-muted-foreground"}`}>{s.status}</span>
          </div>
        ))}
      </div>
      <Link href="/map" className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary hover:underline">Open the coverage map </Link>

      {isAdmin && (
        <div className="space-y-2 pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Operations - run a city</div>
          <Suspense fallback={<Skeleton className="h-44 w-full rounded-2xl" />}>
            <EgressLive />
          </Suspense>
          <Suspense fallback={<Skeleton className="h-40 w-full rounded-2xl" />}>
            <CitySweepRunner />
          </Suspense>
        </div>
      )}
      {isAdmin && (
        <div className="space-y-2 pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Operations - live {scopeLabel ?? "all-market"} scan inspector</div>
          <Suspense fallback={<Skeleton className="h-64 w-full rounded-2xl" />}>
            <ScanInspector city={scopeCity ?? undefined} state={scopeState ?? undefined} scopeLabel={scopeLabel ?? undefined} />
          </Suspense>
        </div>
      )}
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

function NewBuilds({ isManager }: { isManager: boolean }) {
  const [state, setState] = useState<"all" | "NC" | "SC">("all");
  const [stage, setStage] = useState<"all" | "addressed" | "monitored" | "actionable">(isManager ? "all" : "actionable");
  const { data, isLoading, isError } = useQuery<NewBuildFeed>({
    queryKey: ["/api/newbuilds/live"],
    queryFn: () => apiRequest("GET", "/api/newbuilds/live?hours=168").then((r) => r.json()),
    refetchInterval: 8000, staleTime: 5000,
  });
  const cov = useQuery<Coverage>({
    queryKey: ["/api/newbuilds/coverage"],
    queryFn: () => apiRequest("GET", "/api/newbuilds/coverage").then((r) => r.json()),
    refetchInterval: 30000, enabled: isManager,
  });
  const exp = useQuery<ExpansionFeed>({
    queryKey: ["/api/expansions/live"],
    queryFn: () => apiRequest("GET", "/api/expansions/live").then((r) => r.json()),
    refetchInterval: 8000, enabled: isManager,
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
          ["Addressed", data?.counts.addressed ?? 0, "text-info"],
          ["Monitored", data?.counts.monitored ?? 0, "text-warning"],
          ["Checked", data?.counts.checked ?? 0, "text-foreground"],
          ["Leads", data?.counts.leads ?? 0, "text-success"],
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
        {isError
          ? <span className="inline-flex items-center gap-1 text-[11px] text-warning"><span className="h-1.5 w-1.5 rounded-full bg-warning" /> Connection lost - showing last loaded data</span>
          : <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> Live</span>}
        <div className="ml-auto flex gap-1">
          {(["all", "NC", "SC"] as const).map((s) => (
            <button key={s} aria-pressed={state === s} onClick={() => setState(s)} className={`rounded-lg px-2.5 py-1 font-semibold ${state === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-secondary"}`}>{s === "all" ? "All" : s}</button>
          ))}
        </div>
        {/* Stage chips are only a real choice for managers — non-managers are
            pinned to "actionable", so a single dead chip would just be noise. */}
        {isManager && (
          <div className="flex gap-1">
            {(["all", "addressed", "monitored", "actionable"] as const).map((s) => (
              <button key={s} onClick={() => setStage(s)} className={`rounded-lg px-2.5 py-1 font-semibold capitalize ${stage === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-secondary"}`}>{s}</button>
            ))}
          </div>
        )}
      </div>

      {/* Manager: live lead-triggered cluster expansions */}
      {isManager && (exp.data?.expansions?.length ?? 0) > 0 && (
        <div className="rounded-2xl border border-success/15 bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-success">Lead cluster expansions</div>
            <div className="text-[11px] text-muted-foreground">{exp.data!.summary.active} active · {exp.data!.summary.freshFound} new leads · {exp.data!.summary.addressesChecked} checked</div>
          </div>
          {exp.data!.expansions.slice(0, 6).map((e) => (
            <div key={e.id} className="border-b border-border/60 px-4 py-2.5 last:border-0" data-testid={`expansion-${e.id}`}>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-success" />
                <span className="truncate text-[13px] font-medium text-foreground">{String(e.origin.address).split(",")[0]}, {e.origin.city}</span>
                <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold uppercase ${e.status === "active" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}>{e.status}</span>
              </div>
              <div className="pl-4 text-[11px] text-muted-foreground">
                radius {(e.radiusM / 1000).toFixed(1)}km · ring {e.ring} · {e.addressesChecked} checked · <span className="font-medium text-success">{e.newLeads.length} new green leads</span>{e.emptyStreak > 0 ? ` · ${e.emptyStreak} empty ring${e.emptyStreak > 1 ? "s" : ""}` : ""}
              </div>
            </div>
          ))}
          <TruncationNote shown={6} total={exp.data!.expansions.length} />
        </div>
      )}

      {/* Manager: coverage gaps banner */}
      {isManager && gaps.length > 0 && (
        <div className="rounded-xl border border-warning/25 bg-warning/[0.08] px-3 py-2.5 text-[12px] text-warning">
          <div className="mb-1 flex items-center gap-1.5 font-semibold"> {gaps.length} source coverage gap{gaps.length > 1 ? "s" : ""}</div>
          {gaps.map((g) => <div key={g.source} className="text-[11px] text-warning/80">· <span className="font-medium">{g.scope}</span>: {g.note}</div>)}
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
            {isManager ? "No new builds detected yet in this window. The radar polls NC OneMap + OSM continuously; new addresses appear here and are checked immediately." : "No actionable new-build leads yet. Verified fresh-fiber new builds appear here ready to knock."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-secondary/40" data-testid={`newbuild-row-${r.id}`}>
                
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-foreground">{r.address ?? `Addressless building${r.county ? ` · ${r.county} Co.` : ""}`}{r.city ? `, ${r.city}` : ""}</div>
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                    <span>{r.state}{r.zip ? ` ${r.zip}` : ""}</span>
                    <span>· {r.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")}</span>
                    <span>· {relMs(r.detectedAt)}</span>
                    {r.clusterId && isManager && <span className="rounded bg-primary/10 px-1 text-2xs text-primary">cluster</span>}
                  </div>
                </div>
                {/* status */}
                <div className="flex shrink-0 items-center gap-2">
                  {r.leadId ? <span className="rounded-full bg-success/10 px-2 py-0.5 text-2xs font-bold uppercase text-success">Lead</span>
                    : r.actionable ? <span className="rounded-full bg-success/10 px-2 py-0.5 text-2xs font-bold uppercase text-success">Fresh fiber</span>
                    : r.monitored ? <span className="rounded-full bg-warning/10 px-2 py-0.5 text-2xs font-semibold uppercase text-warning">Monitoring</span>
                    : r.checkedAt ? <span className="rounded-full bg-muted px-2 py-0.5 text-2xs font-semibold uppercase text-muted-foreground">{(r.fiberStatus ?? "checked").replace(/_/g, " ")}</span>
                    : <span className="rounded-full bg-info/[0.08] px-2 py-0.5 text-2xs font-semibold uppercase text-info">Checking</span>}
                  {r.address && <Link href="/map" className="rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-secondary">Map</Link>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manager: source coverage summary */}
      {isManager && cov.data && (
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
