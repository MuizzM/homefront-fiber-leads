import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useCan } from "@/lib/capabilities";
import { useToast } from "@/hooks/use-toast";
import {
  scanApi, BAND_TINT, usdCompact, freshnessLabel,
  type MarketCard, type MarketDetail, type ScanRun, type RunPreview,
} from "@/lib/scanApi";
import {
  Radar, TrendingUp, Activity, X, ChevronRight, Loader2, Pause, Play, Square,
  Zap, Search, Gauge, CircleDollarSign, Sparkles, MapPinned, Database, RefreshCw,
  AlertTriangle, CheckCircle2, Upload, SlidersHorizontal, FileSearch, ShieldCheck,
  Eye, Map as MapIcon, RotateCcw,
  ServerCog,
} from "lucide-react";
import { OpportunityMap } from "@/components/scan/OpportunityMap";
import { useDiscoveryJobs } from "@/hooks/use-discovery-jobs";
import {
  discoveryApi,
  discoveryIdempotencyKey,
  discoveryStageLabel,
  isActiveDiscoveryJob,
  type DiscoveryAddressExplanation,
  type DiscoveryCoverage,
  type DiscoveryJob,
  type DiscoverySource,
  type DiscoveryUpload,
} from "@/lib/discoveryApi";

// ── Scan Intelligence — the market-discovery cockpit ──────────────────────────
// One place to answer: where is fresh, unworked fiber opportunity, how confident
// are we, how much would it cost to verify, and how do we get a team on it. Reads
// are free (pure DB); a budgeted scan is the ONLY spend and is admin-gated. The
// product should make an operator feel it sees the market before they do.

type View = "markets" | "opportunity" | "activity" | "discovery" | "system";

export default function ScanIntel() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const canManageDiscovery = useCan("scan.manage");
  const [view, setView] = useState<View>("markets");
  const [selected, setSelected] = useState<{ city: string; state: string } | null>(null);

  // Any run currently spending — shown as a persistent banner across all views,
  // and resumed on load (the "leave and return" guarantee at the UI layer).
  const { data: runsData } = useQuery({ queryKey: ["/api/scan/runs"], queryFn: scanApi.runs, refetchInterval: 4000 });
  const activeRun = runsData?.runs.find(r => r.status === "running" || r.status === "paused") ?? null;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-background">
      <ScanHeader view={view} setView={setView} isAdmin={isAdmin} canManageDiscovery={canManageDiscovery} />
      {activeRun && <ActiveRunBanner run={activeRun} isAdmin={isAdmin} onOpen={() => setView("opportunity")} />}

      <div className="flex-1 min-h-0 overflow-hidden">
        {view === "markets" && (
          <MarketsView isAdmin={isAdmin} onScan={(c, s) => setSelected({ city: c, state: s })} onOpportunity={(c, s) => { setSelected({ city: c, state: s }); setView("opportunity"); }} />
        )}
        {view === "opportunity" && <OpportunityMap focusCity={selected} onBack={() => setView("markets")} />}
        {view === "activity" && <ActivityView />}
        {view === "discovery" && canManageDiscovery && <DiscoveryOperations />}
        {view === "system" && canManageDiscovery && <FiberSystemView />}
      </div>

      {/* Run panel — opens over any view when a market is chosen to scan. */}
      {selected && view !== "opportunity" && (
        <MarketRunPanel
          city={selected.city} state={selected.state} isAdmin={isAdmin}
          onClose={() => setSelected(null)}
          onViewOpportunity={() => setView("opportunity")}
        />
      )}
    </div>
  );
}

// ── Header + saved-view tabs ──────────────────────────────────────────────────
function ScanHeader({ view, setView, isAdmin, canManageDiscovery }: { view: View; setView: (v: View) => void; isAdmin: boolean; canManageDiscovery: boolean }) {
  const tabs: Array<{ id: View; label: string; Icon: React.ElementType }> = [
    { id: "markets", label: "Markets", Icon: TrendingUp },
    { id: "opportunity", label: "Opportunity Map", Icon: MapPinned },
    { id: "activity", label: "Activity", Icon: Activity },
    ...(canManageDiscovery ? [{ id: "discovery" as View, label: "Discovery Ops", Icon: Database }] : []),
    ...(canManageDiscovery ? [{ id: "system" as View, label: "System", Icon: ServerCog }] : []),
  ];
  return (
    <header className="flex-shrink-0 border-b border-border bg-card">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <div className="w-8 h-8 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
          <Radar className="text-primary" style={{ width: 18, height: 18 }} />
        </div>
        <div className="leading-tight min-w-0">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">Scan Intelligence</h1>
          <p className="text-[11px] text-muted-foreground">Find markets before your competitors</p>
        </div>
        {!isAdmin && <span className="ml-auto hidden md:inline text-[11px] text-muted-foreground/70">view-only · scans are admin-run</span>}
      </div>
      <nav role="tablist" aria-label="Scan views" className="flex items-center gap-1 px-2 -mb-px">
        {tabs.map(({ id, label, Icon }) => {
          const active = view === id;
          return (
            <button key={id} role="tab" onClick={() => setView(id)} data-testid={`scan-view-${id}`}
              aria-label={label} aria-selected={active} title={label}
              className={`relative flex items-center gap-1.5 px-3 h-10 text-[13px] font-medium border-b-2 transition-colors rounded-t focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              <Icon className="w-4 h-4" /> <span className="hidden sm:inline">{label}</span>
            </button>
          );
        })}
      </nav>
    </header>
  );
}

// ── Active-run banner (persistent, resumable, live) ───────────────────────────
function ActiveRunBanner({ run, isAdmin, onOpen }: { run: ScanRun; isAdmin: boolean; onOpen: () => void }) {
  const qc = useQueryClient();
  // Fast poll only while the run is actually RUNNING; a paused run just needs a
  // slow heartbeat to notice an external resume — not 40 requests/minute.
  const { data: live } = useQuery({
    queryKey: ["/api/scan/runs", run.id],
    queryFn: () => scanApi.run(run.id),
    refetchInterval: (q) => (((q.state.data as ScanRun | undefined) ?? run).status === "running" ? 1500 : 10_000),
  });
  const r = live ?? run;
  const control = async (action: "pause" | "resume" | "cancel") => {
    try { await scanApi.controlRun(r.id, action); qc.invalidateQueries({ queryKey: ["/api/scan/runs"] }); } catch {}
  };
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-primary/[0.08] border-b border-primary/20 flex-shrink-0" data-testid="scan-active-run">
      {r.status === "running" ? (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> Live
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Paused
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold text-foreground truncate">{r.label}</span>
          <span className="text-muted-foreground tabular-nums">{r.verified + r.failed}/{r.budget}</span>
          <span className="text-primary font-semibold tabular-nums">{r.newFiber} primary matches</span>
          {r.newlyLive > 0 && <span className="text-orange-500 font-semibold tabular-nums">· {r.newlyLive} provisional flips</span>}
          <span className="text-muted-foreground tabular-nums ml-auto sm:ml-0">{usdCompact(r.costUsd)}</span>
        </div>
        <div className="h-1.5 rounded-full bg-primary/15 mt-1 overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${r.pct}%` }} />
        </div>
      </div>
      <button onClick={onOpen} className="text-[12px] text-primary hover:underline font-medium hidden sm:block">Watch on map</button>
      {isAdmin && r.status === "running" && <button onClick={() => control("pause")} aria-label="Pause scan" className="w-8 h-8 rounded-lg hover:bg-black/10 flex items-center justify-center text-muted-foreground"><Pause className="w-4 h-4" /></button>}
      {isAdmin && r.status === "paused" && <button onClick={() => control("resume")} aria-label="Resume scan" className="w-8 h-8 rounded-lg hover:bg-black/10 flex items-center justify-center text-primary"><Play className="w-4 h-4" /></button>}
      {isAdmin && <button onClick={() => control("cancel")} aria-label="Cancel scan" className="w-8 h-8 rounded-lg hover:bg-black/10 flex items-center justify-center text-muted-foreground"><Square className="w-4 h-4" /></button>}
    </div>
  );
}

// ── Markets view ──────────────────────────────────────────────────────────────
function MarketsView({ isAdmin, onScan, onOpportunity }: { isAdmin: boolean; onScan: (c: string, s: string) => void; onOpportunity: (c: string, s: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ["/api/scan/markets"], queryFn: scanApi.markets, refetchInterval: 15000 });
  const [q, setQ] = useState("");
  const markets = useMemo(() => {
    const list = data?.markets ?? [];
    const s = q.trim().toLowerCase();
    return s ? list.filter(m => m.city.toLowerCase().includes(s)) : list;
  }, [data, q]);

  if (isLoading) return <CenterNote><Loader2 className="w-5 h-5 animate-spin" /> Reading the market…</CenterNote>;
  if (!data?.markets.length) return <CenterNote><Radar className="w-6 h-6 opacity-40" /> No harvested markets yet. Import or harvest addresses to begin.</CenterNote>;

  const totalOpp = markets.reduce((s, m) => s + m.estRemainingOpportunity, 0);
  const unverified = markets.reduce((s, m) => s + (m.poolSize - m.verified), 0);
  const totalNewFiber = markets.reduce((s, m) => s + (m.verifiedNewFiber || 0), 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* Metric strip + city filter */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
          <div className="flex items-stretch rounded-xl border border-border bg-card divide-x divide-border overflow-hidden">
            <MetricCell label="Markets" value={markets.length.toLocaleString()} />
            <MetricCell label="Confirmed fresh" value={totalNewFiber.toLocaleString()} tone="text-emerald-500" />
            <MetricCell label="To verify" value={unverified.toLocaleString()} />
            <MetricCell label="Est. opportunity" value={totalOpp.toLocaleString()} />
          </div>
          <div className="relative sm:ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a city…" data-testid="scan-market-search"
              className="h-9 w-full sm:w-52 pl-8 pr-3 rounded-lg bg-secondary/60 border border-border text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40" />
          </div>
        </div>

        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {markets.map(m => (
            <MarketTile key={`${m.city}|${m.state}`} m={m} isAdmin={isAdmin} onScan={() => onScan(m.city, m.state)} onOpportunity={() => onOpportunity(m.city, m.state)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MarketTile({ m, isAdmin, onScan, onOpportunity }: { m: MarketCard; isAdmin: boolean; onScan: () => void; onOpportunity: () => void }) {
  const tint = BAND_TINT[m.priorityBand];
  const verifyPct = m.poolSize > 0 ? Math.min(100, (m.verified / m.poolSize) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4 flex flex-col gap-3 hover:border-primary/30 transition-colors" data-testid={`scan-market-${m.city}`}>
      <div className="flex items-start gap-3">
        {/* Priority dial */}
        <div className="relative w-12 h-12 flex-shrink-0" title={`Priority ${m.priority}/100`}>
          <svg viewBox="0 0 36 36" className="w-12 h-12 -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" className="text-secondary" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke={tint} strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(m.priority / 100) * 97.4} 97.4`} />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[13px] font-bold tabular-nums" style={{ color: tint }}>{m.priority}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground truncate">{m.city}</h3>
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full font-semibold" style={{ background: tint + "1f", color: tint }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: tint }} /> {m.priorityBand}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${m.confidence === "high" ? "bg-emerald-500" : m.confidence === "medium" ? "bg-amber-500" : "bg-slate-400"}`} />
            {m.confidence} confidence · {freshnessLabel(m.freshnessDays)}
          </div>
          {/* New-fiber highlight — the whole point of the hunt. */}
          {(m.verifiedNewFiber > 0 || m.newlyLive > 0) && (
            <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-500" data-testid={`scan-market-newfiber-${m.city}`}>
              <Zap className="w-3 h-3" /> {m.verifiedNewFiber.toLocaleString()} confirmed fresh{m.newlyLive > 0 ? ` · ${m.newlyLive} this week` : ""}
            </div>
          )}
        </div>
      </div>

      {/* Reasons — the "why" */}
      <ul className="space-y-1">
        {m.reasons.map((r, i) => (
          <li key={i} className="text-[12px] text-foreground/80 flex items-start gap-1.5">
            <ChevronRight className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: tint }} /> {r}
          </li>
        ))}
      </ul>

      {/* THE DECISION: unworked opportunity is the headline, not vanity counts. */}
      <div className="flex items-end justify-between rounded-xl bg-secondary/40 border border-border px-3 py-2">
        <div>
          <div className="text-[22px] font-bold leading-none tabular-nums" style={{ color: tint }}>
            {m.estRemainingOpportunity.toLocaleString()}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">est. opportunity</div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground leading-tight">
          <div className="tabular-nums">{m.unworkedLeads.toLocaleString()} unworked</div>
          <div className="text-muted-foreground/60 tabular-nums">{m.poolSize.toLocaleString()} in pool</div>
        </div>
      </div>

      {/* Verification coverage — subtle "among" progress row */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
          <span className="tabular-nums">{m.verified.toLocaleString()} of {m.poolSize.toLocaleString()} verified</span>
          <span className="tabular-nums">{Math.round(verifyPct)}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div className="h-full rounded-full bg-muted-foreground/40" style={{ width: `${verifyPct}%` }} />
        </div>
      </div>

      <div className="flex items-center gap-2 mt-auto pt-1">
        <button onClick={onOpportunity} data-testid={`scan-market-open-${m.city}`} className="flex-1 h-9 rounded-lg bg-secondary/70 hover:bg-secondary text-[13px] font-medium text-foreground flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          <MapPinned className="w-3.5 h-3.5" /> Opportunity
        </button>
        {isAdmin && (
          <button onClick={onScan} data-testid={`scan-market-scan-${m.city}`} className="flex-1 h-9 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-[13px] font-semibold flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <Zap className="w-3.5 h-3.5" /> Scan
          </button>
        )}
      </div>
    </div>
  );
}

// ── Market run panel (budgeted scan with up-front cost) ───────────────────────
function MarketRunPanel({ city, state, isAdmin, onClose, onViewOpportunity }: { city: string; state: string; isAdmin: boolean; onClose: () => void; onViewOpportunity: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: detail } = useQuery<MarketDetail>({ queryKey: ["/api/scan/markets", city, state], queryFn: () => scanApi.marketDetail(city, state) });
  const [budget, setBudget] = useState<number | null>(null);
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [starting, setStarting] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);

  const chosenBudget = budget ?? detail?.tiers?.[1]?.checks ?? detail?.tiers?.[0]?.checks ?? 0;

  useEffect(() => {
    if (!chosenBudget || !isAdmin) return;
    let cancelled = false;
    scanApi.previewRun(city, state, chosenBudget).then(p => { if (!cancelled) setPreview(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [city, state, chosenBudget, isAdmin]);

  const start = async () => {
    setStarting(true);
    try {
      const out = await scanApi.startRun(city, state, chosenBudget);
      setStartedRunId(out.runId);
      qc.invalidateQueries({ queryKey: ["/api/scan/runs"] });
      toast({ title: "Scan started", description: `Verifying ${out.queued.toLocaleString()} addresses in ${city}.` });
    } catch (e: any) {
      const msg = await extractError(e);
      toast({ title: "Could not start scan", description: msg, variant: "destructive" });
    } finally { setStarting(false); }
  };

  const card = detail?.card;

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <aside role="dialog" aria-label={`Scan ${city}`} onClick={e => e.stopPropagation()}
        className="relative w-full max-w-md h-full bg-card border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        data-testid="scan-run-panel">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
          <div className="w-8 h-8 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center flex-shrink-0">
            <Zap className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold tracking-tight text-foreground truncate">{city}, {state}</div>
            {card && <div className="text-[11px] text-muted-foreground">Priority {card.priority} · {card.confidence} confidence</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-secondary flex items-center justify-center text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"><X className="w-4 h-4" /></button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!detail && <CenterNote><Loader2 className="w-4 h-4 animate-spin" /> Loading…</CenterNote>}
          {detail && (
            <>
              {/* Reasons */}
              {card && (
                <div className="rounded-xl bg-secondary/50 border border-border p-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Why here</div>
                  <ul className="space-y-1">{card.reasons.map((r, i) => <li key={i} className="text-[12.5px] text-foreground/85 flex gap-1.5"><ChevronRight className="w-3 h-3 mt-0.5 text-primary flex-shrink-0" />{r}</li>)}</ul>
                </div>
              )}

              {startedRunId ? (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-center space-y-3">
                  <Loader2 className="w-6 h-6 text-primary animate-spin mx-auto" />
                  <p className="text-[13px] text-foreground">Scan running. Results appear on the map as fiber is verified — you can leave and come back.</p>
                  <button onClick={() => { onClose(); onViewOpportunity(); }} className="h-9 px-4 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-[13px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">Watch on the Opportunity Map</button>
                </div>
              ) : isAdmin ? (
                <>
                  <div>
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">Budget — how much to verify</div>
                    <div className="grid grid-cols-2 gap-2">
                      {detail.tiers.map(t => {
                        const active = chosenBudget === t.checks;
                        return (
                          <button key={t.key} onClick={() => setBudget(t.checks)} data-testid={`scan-budget-${t.key}`}
                            className={`text-left rounded-xl border p-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${active ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                            <div className="flex items-center justify-between">
                              <span className="text-[13px] font-semibold text-foreground">{t.label}</span>
                              <span className="text-[11px] text-muted-foreground tabular-nums">{usdCompact(t.cost.estUsd)}</span>
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-0.5"><span className="tabular-nums">{t.checks.toLocaleString()}</span> checks · {t.blurb}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Cost preview — always shown BEFORE spending (product law) */}
                  {preview && (
                    <div className="rounded-xl border border-border bg-secondary/40 p-3 space-y-1.5" data-testid="scan-cost-preview">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">Before you spend</div>
                      <Row Icon={Search} label="Addresses available to verify" value={preview.available.toLocaleString()} />
                      {preview.highValue > 0 && <Row Icon={Sparkles} label="High-value (near known fiber)" value={preview.highValue.toLocaleString()} />}
                      <Row Icon={Gauge} label="Will verify this run" value={preview.willVerify.toLocaleString()} />
                      <Row Icon={CircleDollarSign} label="Estimated proxy cost" value={usdCompact(preview.estimate.estUsd)} accent />
                      <p className="text-[11px] text-muted-foreground pt-1">Real cost is measured as it runs. Failed checks never fabricate a result.</p>
                    </div>
                  )}

                  <button onClick={start} disabled={starting || !chosenBudget || (preview?.willVerify ?? 0) === 0} data-testid="scan-start"
                    className="w-full h-11 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground text-[14px] font-semibold flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                    {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {preview?.willVerify === 0 ? "Everything here was just verified" : `Verify ${(preview?.willVerify ?? chosenBudget).toLocaleString()} addresses`}
                  </button>
                </>
              ) : (
                <div className="rounded-xl border border-border bg-secondary/40 p-4 text-center text-[13px] text-muted-foreground">
                  Scans spend proxy budget and are run by an admin. You can explore the opportunity map and deploy verified opportunity to your team.
                </div>
              )}

              <button onClick={() => { onClose(); onViewOpportunity(); }} className="w-full h-9 rounded-lg bg-secondary/70 hover:bg-secondary text-[13px] font-medium text-foreground flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
                <MapPinned className="w-3.5 h-3.5" /> Open the Opportunity Map
              </button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ── Discovery operations — durable area-job control plane ───────────────────
function DiscoveryOperations() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const live = useDiscoveryJobs(true);
  const [section, setSection] = useState<"jobs" | "sources" | "upload">("jobs");
  const [status, setStatus] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inspectJobId, setInspectJobId] = useState<string | null>(null);
  const { data: stored = [], isLoading, refetch } = useQuery({
    queryKey: ["/api/discovery/jobs"],
    queryFn: () => discoveryApi.list(),
    refetchInterval: live.connected ? 15_000 : 5_000,
    staleTime: 2_000,
  });
  const jobs = useMemo(() => {
    const merged = new Map(stored.map(job => [job.id, job] as const));
    for (const job of live.jobs) merged.set(job.id, { ...(merged.get(job.id) ?? {}), ...job });
    return Array.from(merged.values()).sort((a, b) =>
      Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
  }, [stored, live.jobs]);
  const visible = status === "all" ? jobs : jobs.filter(job => job.status === status);
  const active = jobs.filter(isActiveDiscoveryJob);
  const partial = jobs.filter(job => job.status === "partial").length;
  const failed = jobs.filter(job => job.status === "failed").length;
  const qualified = jobs.reduce((sum, job) => sum + job.qualifiedCount, 0);
  const inspectJob = inspectJobId ? jobs.find(job => job.id === inspectJobId) ?? null : null;

  const sourceHealth = useMemo(() => {
    const sources = new Map<string, { name: string; healthy: number; warning: number; records: number; error?: string | null }>();
    for (const job of jobs) {
      for (const source of job.sources ?? []) {
        const row = sources.get(source.name) ?? { name: source.name, healthy: 0, warning: 0, records: 0 };
        const healthy = ["healthy", "complete", "running", "ok"].includes(String(source.status).toLowerCase());
        if (healthy) row.healthy += 1; else row.warning += 1;
        row.records += Number(source.records) || 0;
        if (source.errorCode) row.error = source.errorCode;
        sources.set(source.name, row);
      }
    }
    return Array.from(sources.values()).sort((a, b) => b.records - a.records || a.name.localeCompare(b.name));
  }, [jobs]);

  const cancel = async (job: DiscoveryJob) => {
    setBusyId(job.id);
    try {
      await live.cancel(job.id);
      await refetch();
      toast({ title: "Discovery job cancelled", description: "Completed tiles and leads were preserved." });
    } catch (error: any) {
      toast({ title: "Cancel failed", description: String(error?.message ?? error), variant: "destructive" });
    } finally { setBusyId(null); }
  };

  const retry = async (job: DiscoveryJob) => {
    if (!job.geometry) {
      toast({ title: "This job has no reusable geometry", variant: "destructive" });
      return;
    }
    setBusyId(job.id);
    try {
      await live.submit({
        geometry: job.geometry,
        city: job.city ?? undefined,
        state: job.state ?? undefined,
        // A retry is a new intentional submission, while retries of this POST
        // remain protected by the one generated request key.
        idempotencyKey: discoveryIdempotencyKey(job.geometry, user?.tenantId),
      });
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ["/api/discovery/jobs"] })]);
      toast({ title: "Retry queued", description: "The same authorized boundary is running as a new job." });
    } catch (error: any) {
      toast({ title: "Retry failed", description: String(error?.message ?? error), variant: "destructive" });
    } finally { setBusyId(null); }
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="discovery-operations">
      <div className="mx-auto max-w-7xl space-y-4 px-3 py-4 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold tracking-tight">Address discovery operations</h2>
            <p className="text-xs text-muted-foreground">Durable jobs, coverage confidence, source health, and safe recovery.</p>
          </div>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${live.connected ? "bg-emerald-500/10 text-emerald-500" : "bg-amber-500/10 text-amber-500"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${live.connected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`} />
            {live.connected ? "Live stream" : "Polling fallback"}
          </span>
          <button onClick={() => void Promise.all([live.hydrate(), refetch()])} aria-label="Refresh discovery jobs"
            className="grid h-11 w-11 place-items-center rounded-xl border border-border hover:bg-secondary">
            <RefreshCw className={`h-4 w-4 ${live.hydrating || isLoading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <DiscoveryMetric label="Active / queued" value={active.length} tone="text-primary" />
          <DiscoveryMetric label="Qualified leads" value={qualified} tone="text-emerald-500" />
          <DiscoveryMetric label="Partial" value={partial} tone={partial ? "text-amber-500" : undefined} />
          <DiscoveryMetric label="Failed" value={failed} tone={failed ? "text-rose-500" : undefined} />
        </div>

        <div className="grid grid-cols-3 rounded-xl bg-secondary/60 p-1" role="tablist" aria-label="Discovery administration">
          {([
            ["jobs", "Jobs", Database],
            ["sources", "Sources", SlidersHorizontal],
            ["upload", "Import", Upload],
          ] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={section === id} onClick={() => setSection(id)}
              className={`flex h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition ${section === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        {section === "jobs" ? (
          <>
            {sourceHealth.length > 0 && (
              <section className="rounded-xl border border-border bg-card p-3">
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recent job source health</div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {sourceHealth.map(source => (
                    <div key={source.name} className="min-w-[170px] rounded-xl bg-secondary/50 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-semibold">
                        {source.warning ? <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
                        <span className="truncate">{source.name}</span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground tabular-nums">{source.records.toLocaleString()} records · {source.warning ? `${source.warning} warning` : "healthy"}</div>
                      {source.error && <div className="mt-1 truncate text-[10px] text-amber-500">{source.error}</div>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div className="flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Filter discovery jobs">
              {["all", "queued", "discovering", "qualifying", "partial", "completed", "failed", "cancelled"].map(value => (
                <button key={value} onClick={() => setStatus(value)} role="tab" aria-selected={status === value}
                  className={`h-9 shrink-0 rounded-full px-3 text-xs font-medium capitalize ${status === value ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}>
                  {value}
                </button>
              ))}
            </div>

            {visible.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No discovery jobs in this view.</div>
            ) : (
              <div className="space-y-2">
                {visible.map(job => <DiscoveryJobCard key={job.id} job={job} busy={busyId === job.id}
                  onInspect={() => setInspectJobId(job.id)} onCancel={() => void cancel(job)} onRetry={() => void retry(job)} />)}
              </div>
            )}
          </>
        ) : section === "sources" ? (
          <DiscoverySourcesPanel />
        ) : (
          <DiscoveryUploadPanel isAdmin={user?.role === "admin" || user?.role === "super_admin"} />
        )}

        {inspectJob && (
          <DiscoveryJobInspector job={inspectJob} onClose={() => setInspectJobId(null)} onChanged={() => void Promise.all([live.hydrate(), refetch()])} />
        )}
      </div>
    </div>
  );
}

function DiscoveryMetric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return <div className="rounded-xl border border-border bg-card p-3"><div className={`text-2xl font-bold tabular-nums ${tone ?? "text-foreground"}`}>{value.toLocaleString()}</div><div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div></div>;
}

function DiscoveryJobCard({ job, busy, onCancel, onRetry, onInspect }: { job: DiscoveryJob; busy: boolean; onCancel: () => void; onRetry: () => void; onInspect: () => void }) {
  const active = isActiveDiscoveryJob(job);
  const resolved = job.checkedCount + job.failedCount;
  const denominator = Math.max(job.uniqueCandidateCount, resolved);
  const pct = denominator > 0 ? Math.min(100, Math.round((resolved / denominator) * 100)) : 0;
  const duplicates = Math.max(0, job.discoveredCount - job.uniqueCandidateCount);
  const statusTone = job.status === "completed" ? "bg-emerald-500/10 text-emerald-500"
    : job.status === "partial" ? "bg-amber-500/10 text-amber-500"
    : job.status === "failed" ? "bg-rose-500/10 text-rose-500"
    : job.status === "cancelled" ? "bg-secondary text-muted-foreground"
    : "bg-primary/10 text-primary";
  return (
    <article className="rounded-xl border border-border bg-card p-3" data-testid={`discovery-ops-job-${job.id}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${statusTone}`}>{discoveryStageLabel(job.status)}</span>
            <span className="truncate text-sm font-semibold">{job.city ? `${job.city}${job.state ? `, ${job.state}` : ""}` : `Drawn area · ${job.id.slice(0, 8)}`}</span>
            <span className="text-[10px] text-muted-foreground">{job.coverageStatus || "processing"}</span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1.5 sm:grid-cols-8">
            {[
              ["Raw", job.discoveredCount], ["Unique", job.uniqueCandidateCount], ["Validated", job.validatedCount],
              ["Checked", job.checkedCount], ["Qualified", job.qualifiedCount], ["Cached", job.cachedCount],
              ["Duplicates", duplicates], ["Failed", job.failedCount],
            ].map(([label, value]) => <div key={String(label)} className="rounded-lg bg-secondary/50 px-2 py-1.5"><div className="text-xs font-semibold tabular-nums">{Number(value).toLocaleString()}</div><div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div></div>)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1.5">
          <button onClick={onInspect} className="grid h-11 w-11 place-items-center rounded-lg border border-border hover:bg-secondary" aria-label={`Inspect discovery job ${job.id.slice(0, 8)}`}>
            <Eye className="h-4 w-4" />
          </button>
          {active ? (
            <button onClick={onCancel} disabled={busy} className="h-9 rounded-lg border border-rose-500/25 px-2 text-[10px] font-semibold text-rose-500 disabled:opacity-50">Cancel</button>
          ) : (job.status === "partial" || job.status === "failed") && (
            <button onClick={onRetry} disabled={busy || !job.geometry} className="h-9 rounded-lg border border-border px-2 text-[10px] font-semibold disabled:opacity-50">Retry</button>
          )}
        </div>
      </div>
      {active && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary"><div className={`h-full rounded-full bg-primary transition-[width] ${job.status === "discovering" || !denominator ? "w-1/3 animate-pulse" : ""}`} style={job.status === "discovering" || !denominator ? undefined : { width: `${Math.max(3, pct)}%` }} /></div>}
      {(job.sourceWarnings?.length ?? 0) > 0 && <div className="mt-2 rounded-lg bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-500">{job.sourceWarnings!.slice(0, 3).join(" · ")}</div>}
      {job.error && <div className="mt-2 rounded-lg bg-rose-500/5 px-2.5 py-2 text-[11px] text-rose-500">{job.error}</div>}
    </article>
  );
}

function DiscoverySourcesPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<Record<string, { enabled: boolean; priority: number }>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const { data: sources = [], isLoading, error, refetch } = useQuery({
    queryKey: ["/api/discovery/sources"],
    queryFn: discoveryApi.sources,
    staleTime: 10_000,
    retry: false,
  });
  useEffect(() => {
    setDrafts(Object.fromEntries(sources.map(source => [source.id, { enabled: source.enabled, priority: source.priority }])));
  }, [sources]);

  const save = async (source: DiscoverySource) => {
    const draft = drafts[source.id];
    if (!draft) return;
    setSaving(source.id);
    try {
      await discoveryApi.configureSource(source.id, draft);
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ["/api/discovery/jobs"] })]);
      toast({ title: `${source.label} updated`, description: draft.enabled ? `Priority ${draft.priority}` : "Disabled for future jobs" });
    } catch (saveError: any) {
      toast({ title: "Source update failed", description: String(saveError?.message ?? saveError), variant: "destructive" });
    } finally { setSaving(null); }
  };

  if (isLoading) return <div className="grid min-h-40 place-items-center rounded-xl border border-border bg-card"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
  if (error) return <UnavailablePanel title="Source controls unavailable" error={error} />;
  if (!sources.length) return <UnavailablePanel title="No address sources are configured" />;

  return (
    <section className="space-y-2" data-testid="discovery-sources">
      <div className="rounded-xl border border-border bg-card p-3 text-xs text-muted-foreground">
        Lower priority numbers run first. Disabling a source affects new jobs only; existing evidence and attribution remain intact.
      </div>
      {sources.map(source => {
        const draft = drafts[source.id] ?? { enabled: source.enabled, priority: source.priority };
        const changed = draft.enabled !== source.enabled || draft.priority !== source.priority;
        const degraded = !source.available || source.healthStatus === "degraded" || Boolean(source.circuitOpenUntil);
        return (
          <article key={source.id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{source.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${source.authoritative ? "bg-sky-500/10 text-sky-500" : source.evidenceOnly ? "bg-violet-500/10 text-violet-500" : "bg-secondary text-muted-foreground"}`}>{source.coverageClass.replaceAll("_", " ")}</span>
                  <span className={`inline-flex items-center gap-1 text-[10px] ${degraded ? "text-amber-500" : "text-emerald-500"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${degraded ? "bg-amber-500" : "bg-emerald-500"}`} />
                    {!source.available ? "not configured" : source.healthStatus}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  <span className="tabular-nums">{source.records.toLocaleString()} records · {source.requests.toLocaleString()} requests</span>
                  {source.licenseUrl ? <> · <a href={source.licenseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{source.licenseName}</a></> : <> · {source.licenseName}</>}
                </div>
                {source.lastError && <div className="mt-1 text-[10px] text-amber-500">{source.lastError}</div>}
              </div>
              <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 text-xs font-medium">
                <span>{draft.enabled ? "On" : "Off"}</span>
                <input type="checkbox" checked={draft.enabled} onChange={event => setDrafts(current => ({ ...current, [source.id]: { ...draft, enabled: event.target.checked } }))}
                  className="h-5 w-5 accent-primary" aria-label={`Enable ${source.label}`} />
              </label>
            </div>
            <div className="mt-3 flex items-end gap-2">
              <label className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Priority
                <input type="number" min={1} max={999} value={draft.priority}
                  onChange={event => setDrafts(current => ({ ...current, [source.id]: { ...draft, priority: Math.max(1, Math.min(999, Number(event.target.value) || 1)) } }))}
                  className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/30" />
              </label>
              <button type="button" disabled={!changed || saving === source.id} onClick={() => void save(source)}
                className="h-11 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-40">
                {saving === source.id ? "Saving…" : "Save"}
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

function DiscoveryUploadPanel({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [licenseName, setLicenseName] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [authoritative, setAuthoritative] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<DiscoveryUpload | null>(null);
  const [endpointUnavailable, setEndpointUnavailable] = useState(false);

  const selectFile = (next: File | null) => {
    setResult(null);
    if (!next) { setFile(null); return; }
    if (!/\.(csv|json|geojson)$/i.test(next.name)) {
      toast({ title: "Unsupported file", description: "Choose an authorized CSV, JSON, or GeoJSON address dataset.", variant: "destructive" });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    if (next.size > 10 * 1024 * 1024) {
      toast({ title: "File is larger than 10 MB", description: "Split it into smaller jurisdiction or county files before importing.", variant: "destructive" });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(next);
  };

  const uploadFile = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const upload = await discoveryApi.upload({ file, licenseName: licenseName.trim() || undefined, licenseUrl: licenseUrl.trim() || undefined, authoritative: isAdmin && authoritative });
      setResult(upload);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      toast({ title: "Address dataset imported", description: `${upload.recordCount.toLocaleString()} records accepted; ${upload.rejectedCount.toLocaleString()} rejected.` });
    } catch (uploadError: any) {
      if (uploadError?.status === 404) setEndpointUnavailable(true);
      toast({ title: "Import failed", description: String(uploadError?.message ?? uploadError), variant: "destructive" });
    } finally { setUploading(false); }
  };

  if (endpointUnavailable) return <UnavailablePanel title="Address imports are unavailable in this deployment" />;

  return (
    <section className="space-y-3" data-testid="discovery-upload">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-4 w-4" /></div>
          <div><h3 className="text-sm font-semibold">Import authorized address data</h3><p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">CSV rows and GeoJSON points become source evidence. Importing candidates never creates leads until the normal validation and fiber qualification gates pass.</p></div>
        </div>
        <input ref={inputRef} type="file" accept=".csv,.json,.geojson,application/json,text/csv,application/geo+json" onChange={event => selectFile(event.target.files?.[0] ?? null)} className="sr-only" />
        <button type="button" onClick={() => inputRef.current?.click()} className="mt-4 flex min-h-14 w-full items-center gap-3 rounded-xl border border-dashed border-border px-3 text-left hover:bg-secondary/50">
          <FileSearch className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{file?.name ?? "Choose CSV or GeoJSON"}</span><span className="block text-[10px] text-muted-foreground">UTF-8 · 10 MB maximum · stored per organization</span></span>
          {file && <span className="text-[10px] tabular-nums text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</span>}
        </button>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">License / permission name
            <input value={licenseName} onChange={event => setLicenseName(event.target.value)} maxLength={120} placeholder="County open-data license"
              className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm normal-case tracking-normal text-foreground outline-none focus:ring-2 focus:ring-primary/30" />
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">License URL
            <input value={licenseUrl} onChange={event => setLicenseUrl(event.target.value)} maxLength={500} inputMode="url" placeholder="https://data.example.gov/license"
              className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm normal-case tracking-normal text-foreground outline-none focus:ring-2 focus:ring-primary/30" />
          </label>
        </div>

        {isAdmin && (
          <label className="mt-3 flex min-h-11 items-start gap-2 rounded-lg bg-secondary/50 p-3 text-xs">
            <input type="checkbox" checked={authoritative} onChange={event => setAuthoritative(event.target.checked)} className="mt-0.5 h-4 w-4 accent-primary" />
            <span><b className="font-semibold">Mark as authoritative</b><span className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground">Use only for a licensed government address-point, parcel, or E911 source whose coverage and terms you verified.</span></span>
          </label>
        )}

        <button type="button" disabled={!file || uploading} onClick={() => void uploadFile()}
          className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-40">
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} {uploading ? "Validating import…" : "Validate and import"}
        </button>
      </div>

      {result && (
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs" role="status">
          <div className="flex items-center gap-2 font-semibold text-emerald-500"><CheckCircle2 className="h-4 w-4" /> Import complete</div>
          <div className="mt-1 text-muted-foreground"><b className="text-foreground">{result.recordCount.toLocaleString()}</b> accepted · <b className="text-foreground">{result.rejectedCount.toLocaleString()}</b> rejected · {result.filename}</div>
        </div>
      )}
    </section>
  );
}

function DiscoveryJobInspector({ job, onClose, onChanged }: { job: DiscoveryJob; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [retrying, setRetrying] = useState(false);
  const [evidenceId, setEvidenceId] = useState("");
  const [evidence, setEvidence] = useState<DiscoveryAddressExplanation | null>(null);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const { data: coverage, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/discovery/jobs", job.id, "coverage"],
    queryFn: () => discoveryApi.coverage(job.id),
    staleTime: isActiveDiscoveryJob(job) ? 2_000 : 60_000,
    refetchInterval: isActiveDiscoveryJob(job) ? 5_000 : false,
    retry: false,
  });
  useEffect(() => {
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  const lowCoverage = (coverage?.features ?? []).filter(feature => {
    const props = feature.properties ?? {};
    const ratio = props.coverageRatio;
    return props.status === "failed" || props.status === "partial" || ratio != null && ratio < 0.8
      || ["partial", "partial_coverage", "sparse", "sparse_source_data", "none", "source_unavailable", "verification_required"].includes(String(props.coverageClass));
  });
  const retryIds = lowCoverage.map(feature => String(feature.properties?.tileId ?? feature.id ?? "")).filter(Boolean);

  const retryLowCoverage = async () => {
    if (!retryIds.length) return;
    setRetrying(true);
    try {
      await discoveryApi.retryTiles(job.id, retryIds);
      await refetch();
      onChanged();
      toast({ title: "Low-coverage tiles queued", description: `${retryIds.length} tile${retryIds.length === 1 ? "" : "s"} will resume without redoing completed tiles.` });
    } catch (retryError: any) {
      toast({ title: "Tile retry failed", description: String(retryError?.message ?? retryError), variant: "destructive" });
    } finally { setRetrying(false); }
  };

  const loadEvidence = async () => {
    const id = evidenceId.trim();
    if (!/^\d+$/.test(id)) { setEvidenceError("Enter a numeric canonical address ID from a discovery or lead event."); return; }
    setEvidenceLoading(true); setEvidenceError(null); setEvidence(null);
    try { setEvidence(await discoveryApi.explainAddress(id)); }
    catch (loadError: any) { setEvidenceError(String(loadError?.message ?? loadError)); }
    finally { setEvidenceLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/55 sm:flex sm:items-center sm:justify-center sm:p-4" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label={`Discovery job ${job.id}`} className="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-background shadow-2xl sm:relative sm:inset-auto sm:max-h-[85vh] sm:w-full sm:max-w-3xl sm:rounded-2xl">
        <header className="flex items-start gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">Coverage & evidence</span><span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">{discoveryStageLabel(job.status)}</span></div><div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{job.id}</div></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close job inspector" className="grid h-11 w-11 place-items-center rounded-xl hover:bg-secondary"><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-4 overflow-y-auto p-3 sm:p-4">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            <DiscoveryMetric label="Raw" value={job.discoveredCount} />
            <DiscoveryMetric label="Unique" value={job.uniqueCandidateCount} />
            <DiscoveryMetric label="Validated" value={job.validatedCount} />
            <DiscoveryMetric label="Checked" value={job.checkedCount} />
            <DiscoveryMetric label="Qualified" value={job.qualifiedCount} tone="text-emerald-500" />
            <DiscoveryMetric label="Failed" value={job.failedCount} tone={job.failedCount ? "text-amber-500" : undefined} />
          </div>

          <section className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 flex items-center gap-2"><MapIcon className="h-4 w-4 text-primary" /><h3 className="flex-1 text-xs font-semibold uppercase tracking-wide">Coverage by tile</h3>{coverage && <span className="text-[10px] text-muted-foreground">{lowCoverage.length}/{coverage.features.length} need attention</span>}</div>
            {isLoading ? <div className="grid h-36 place-items-center"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
              : error ? <UnavailablePanel title="Coverage detail unavailable" error={error} />
              : coverage && coverage.features.length ? (
                <>
                  <CoverageMiniMap coverage={coverage} />
                  <div className="mt-3 max-h-48 space-y-1.5 overflow-y-auto">
                    {coverage.features.map(feature => {
                      const props = feature.properties ?? {};
                      const ratio = props.coverageRatio;
                      const attention = lowCoverage.includes(feature);
                      return <div key={String(feature.id ?? props.tileId)} className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-[11px] ${attention ? "bg-amber-500/7" : "bg-secondary/50"}`}>
                        <span className={`h-2 w-2 rounded-full ${attention ? "bg-amber-500" : "bg-emerald-500"}`} />
                        <span className="min-w-0 flex-1 truncate font-mono">{String(props.tileId ?? feature.id ?? "tile")}</span>
                        <span className="text-muted-foreground">{props.coverageClass ?? "unknown"}</span>
                        <span className="w-10 text-right tabular-nums">{ratio == null ? "—" : `${Math.round(ratio * 100)}%`}</span>
                      </div>;
                    })}
                  </div>
                  {retryIds.length > 0 && !isActiveDiscoveryJob(job) && (
                    <button type="button" disabled={retrying} onClick={() => void retryLowCoverage()} className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-500/25 text-xs font-semibold text-amber-500 disabled:opacity-40">
                      {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Retry {retryIds.length} low-coverage tile{retryIds.length === 1 ? "" : "s"}
                    </button>
                  )}
                </>
              ) : <div className="rounded-lg bg-secondary/50 p-4 text-center text-xs text-muted-foreground">No tile geometry has been recorded yet.</div>}
          </section>

          <section className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2"><FileSearch className="h-4 w-4 text-primary" /><h3 className="text-xs font-semibold uppercase tracking-wide">Address provenance</h3></div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Use the canonical address ID shown in a discovery event or lead audit record to inspect every source, coordinate, qualification membership, and license.</p>
            <div className="mt-2 flex gap-2"><input value={evidenceId} onChange={event => setEvidenceId(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void loadEvidence(); }} inputMode="numeric" placeholder="Canonical address ID" className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30" /><button type="button" disabled={evidenceLoading} onClick={() => void loadEvidence()} className="h-11 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground disabled:opacity-50">{evidenceLoading ? "Loading…" : "Inspect"}</button></div>
            {evidenceError && <div className="mt-2 rounded-lg bg-rose-500/5 px-3 py-2 text-[11px] text-rose-500">{evidenceError}</div>}
            {evidence && <AddressEvidence evidence={evidence} />}
          </section>
        </div>
      </aside>
    </div>
  );
}

function CoverageMiniMap({ coverage }: { coverage: DiscoveryCoverage }) {
  const polygons = coverage.features.flatMap(feature => {
    const geometry = feature.geometry;
    if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return [];
    const rings = geometry.type === "Polygon" ? [geometry.coordinates[0]] : geometry.coordinates.map(polygon => polygon[0]);
    return rings.map(ring => ({ ring, properties: feature.properties }));
  }).filter(item => item.ring.length > 2);
  const points = polygons.flatMap(item => item.ring);
  if (!points.length) return null;
  const lngs = points.map(point => point[0]);
  const lats = points.map(point => point[1]);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs), minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const width = Math.max(0.000001, maxLng - minLng), height = Math.max(0.000001, maxLat - minLat);
  const path = (ring: number[][]) => ring.map((point, index) => {
    const x = 8 + ((point[0] - minLng) / width) * 304;
    const y = 8 + ((maxLat - point[1]) / height) * 144;
    return `${index ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ") + " Z";
  const color = (properties: Record<string, any>) => {
    if (properties.status === "failed" || properties.coverageRatio != null && properties.coverageRatio < 0.5) return "#ef4444";
    if (properties.status === "partial" || properties.coverageRatio != null && properties.coverageRatio < 0.8) return "#f59e0b";
    if (properties.coverageRatio == null) return "#64748b";
    return "#22c55e";
  };
  return (
    <svg viewBox="0 0 320 160" role="img" aria-label="Coverage tile map; green is high coverage, amber is partial, red is sparse or failed" className="h-40 w-full rounded-xl bg-slate-950/95">
      {polygons.map((item, index) => <path key={index} d={path(item.ring)} fill={color(item.properties)} fillOpacity={0.45} stroke={color(item.properties)} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

function AddressEvidence({ evidence }: { evidence: DiscoveryAddressExplanation }) {
  const address = evidence.address ?? {};
  const label = address.full_address ?? address.fullAddress ?? address.canonical_address ?? address.canonicalAddress ?? `Address ${address.id ?? ""}`;
  return (
    <div className="mt-3 space-y-2" data-testid="address-evidence">
      <div className="rounded-lg bg-secondary/50 p-3"><div className="text-sm font-semibold">{String(label)}</div><div className="mt-0.5 text-[10px] text-muted-foreground">Coordinate quality: {String(address.coordinate_quality ?? address.coordinateQuality ?? "unknown")} · Confidence: {Number(address.confidence ?? 0).toFixed(2)}</div></div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{evidence.evidence.length} source record{evidence.evidence.length === 1 ? "" : "s"}</div>
      {evidence.evidence.map((item, index) => (
        <div key={String(item.id ?? index)} className="rounded-lg border border-border px-3 py-2 text-[11px]">
          <div className="flex items-center gap-2"><b className="min-w-0 flex-1 truncate">{String(item.sourceId ?? item.source ?? "source")}</b>{item.authoritative ? <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[9px] font-semibold text-sky-500">authoritative</span> : null}<span className="tabular-nums text-muted-foreground">{Number(item.confidence ?? 0).toFixed(2)}</span></div>
          <div className="mt-1 text-[10px] text-muted-foreground">{String(item.evidenceKind ?? item.method ?? (item.inferred ? "inferred" : "observed"))}{item.licenseName ? ` · ${item.licenseName}` : ""}</div>
        </div>
      ))}
      {!evidence.evidence.length && <div className="rounded-lg bg-amber-500/5 p-3 text-[11px] text-amber-500">No retained source evidence was returned for this address.</div>}
      <div className="grid grid-cols-2 gap-2 text-[10px] text-muted-foreground"><div className="rounded-lg bg-secondary/50 p-2"><b className="block text-xs text-foreground">{evidence.coordinates.length}</b>coordinate observations</div><div className="rounded-lg bg-secondary/50 p-2"><b className="block text-xs text-foreground">{evidence.memberships.length}</b>job / qualification records</div></div>
    </div>
  );
}

function UnavailablePanel({ title, error }: { title: string; error?: unknown }) {
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  return <div className="rounded-xl border border-dashed border-border bg-card p-6 text-center"><AlertTriangle className="mx-auto h-5 w-5 text-amber-500" /><div className="mt-2 text-sm font-semibold">{title}</div>{message && <div className="mt-1 break-words text-[11px] text-muted-foreground">{message}</div>}</div>;
}

// ── Fiber system — durable worker/provider/failure observability ─────────────
function FiberSystemView() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const dashboard = useQuery({ queryKey: ["/api/v1/fiber/dashboard"], queryFn: scanApi.operationsDashboard, refetchInterval: 5_000 });
  const failures = useQuery({ queryKey: ["/api/v1/fiber/failures"], queryFn: scanApi.failures, refetchInterval: 10_000 });
  const providers = useQuery({ queryKey: ["/api/v1/fiber/providers"], queryFn: scanApi.providers, refetchInterval: 30_000 });
  const [retrying, setRetrying] = useState<number | null>(null);
  const retry = async (id: number) => {
    setRetrying(id);
    try {
      await scanApi.retryDeadLetter(id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/v1/fiber/failures"] }),
        qc.invalidateQueries({ queryKey: ["/api/v1/fiber/dashboard"] }),
        qc.invalidateQueries({ queryKey: ["/api/scan/runs"] }),
      ]);
      toast({ title: "Address requeued", description: "The durable worker will retry it without restarting the whole scan." });
    } catch (error: any) {
      toast({ title: "Retry failed", description: await extractError(error), variant: "destructive" });
    } finally { setRetrying(null); }
  };
  if (dashboard.isLoading) return <CenterNote><Loader2 className="h-5 w-5 animate-spin" /> Loading scanner health…</CenterNote>;
  if (dashboard.error) return <CenterNote><AlertTriangle className="h-5 w-5 text-amber-500" /> Scanner health is temporarily unavailable.</CenterNote>;
  const data = dashboard.data!;
  return (
    <div className="h-full overflow-y-auto" data-testid="fiber-system-view">
      <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:px-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Fiber system health</h2>
          <p className="text-xs text-muted-foreground">Persisted worker state, provider readiness, retries, and dead letters.</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <DiscoveryMetric label="Running" value={Number(data.runs.running) || 0} tone="text-primary" />
          <DiscoveryMetric label="Verified" value={Number(data.runs.verified) || 0} tone="text-emerald-500" />
          <DiscoveryMetric label="Failed checks" value={Number(data.runs.failed) || 0} tone={Number(data.runs.failed) ? "text-amber-500" : undefined} />
          <DiscoveryMetric label="Needs retry" value={Number(data.openDeadLetters) || 0} tone={Number(data.openDeadLetters) ? "text-rose-500" : undefined} />
        </div>

        <section className="rounded-xl border border-border bg-card p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Provider readiness</h3>
          <div className="space-y-2">
            {(providers.data?.providers ?? []).map(provider => (
              <div key={provider.provider} className="flex min-h-12 items-center gap-3 rounded-xl bg-secondary/50 px-3 py-2">
                <span className={`h-2.5 w-2.5 rounded-full ${provider.enabled && provider.healthStatus !== "down" ? "bg-emerald-500" : "bg-slate-400"}`} />
                <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{provider.displayName}</div><div className="text-[10px] text-muted-foreground">{provider.mode} · {provider.rateLimitPerMinute}/min</div></div>
                <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${provider.enabled ? "bg-emerald-500/10 text-emerald-500" : "bg-secondary text-muted-foreground"}`}>{provider.enabled ? provider.healthStatus : "disabled"}</span>
              </div>
            ))}
            {!providers.isLoading && !(providers.data?.providers.length) && <div className="py-5 text-center text-xs text-muted-foreground">No provider is configured for this organization.</div>}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Durable workers</h3>
          <div className="space-y-2">
            {data.workers.map(worker => (
              <div key={worker.workerId} className="flex min-h-12 items-center gap-3 rounded-xl bg-secondary/50 px-3 py-2">
                <span className={`h-2.5 w-2.5 rounded-full ${worker.healthy ? "bg-emerald-500" : "bg-rose-500"}`} />
                <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">{worker.runId ?? worker.workerId}</div><div className="text-[10px] text-muted-foreground">{worker.status} · concurrency {worker.concurrency}</div></div>
                <span className="text-[10px] text-muted-foreground">{worker.healthy ? "healthy" : "stale"}</span>
              </div>
            ))}
            {!data.workers.length && <div className="py-5 text-center text-xs text-muted-foreground">No worker heartbeat yet. Start a scan to initialize the worker ledger.</div>}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-3">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Addresses requiring intervention</h3>
          <div className="space-y-2">
            {(failures.data?.deadLetters ?? []).map(item => (
              <div key={item.id} className="flex items-center gap-3 rounded-xl border border-rose-500/15 bg-rose-500/5 p-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" />
                <div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold">{item.category.replaceAll("_", " ")}</div><div className="truncate text-[10px] text-muted-foreground">Target {item.target_id ?? "unknown"} · {item.message}</div></div>
                <button onClick={() => void retry(item.id)} disabled={retrying === item.id} className="h-11 rounded-xl border border-border px-3 text-xs font-semibold hover:bg-secondary disabled:opacity-50">
                  {retrying === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Retry"}
                </button>
              </div>
            ))}
            {!failures.isLoading && !(failures.data?.deadLetters.length) && <div className="py-5 text-center text-xs text-muted-foreground"><CheckCircle2 className="mx-auto mb-1 h-5 w-5 text-emerald-500" />No open dead letters.</div>}
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Activity view (change feed + run history) ─────────────────────────────────
function ActivityView() {
  const { data: changes } = useQuery({ queryKey: ["/api/scan/changes"], queryFn: () => scanApi.changes(72), refetchInterval: 20000 });
  const { data: runsData } = useQuery({ queryKey: ["/api/scan/runs"], queryFn: scanApi.runs, refetchInterval: 8000 });
  const runs = runsData?.runs ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-4 space-y-6">
        <section>
          <h2 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground flex items-center gap-1.5 mb-2"><Sparkles className="w-3.5 h-3.5 text-orange-500" /> What changed — last 72h</h2>
          {changes && changes.newlyLive.count > 0 ? (
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3">
              <div className="text-[14px] font-semibold text-foreground tabular-nums">{changes.newlyLive.count} current address-level fiber flips</div>
              <div className="text-[12px] text-muted-foreground"><span className="tabular-nums">{changes.newlyLive.confirmed ?? changes.newlyLive.readyToAssign}</span> cross-verified · <span className="tabular-nums">{changes.newlyLive.provisional ?? 0}</span> provisional.</div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-secondary/40 p-4 text-[13px] text-muted-foreground text-center">
              No address-level fiber changes detected yet. Rescan a verified market to collect changes; only independently confirmed transitions become operational leads.
            </div>
          )}
        </section>

        <section>
          <h2 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground flex items-center gap-1.5 mb-2"><Activity className="w-3.5 h-3.5 text-primary" /> Recent scans</h2>
          {runs.length === 0 ? (
            <div className="rounded-xl border border-border bg-secondary/40 p-4 text-[13px] text-muted-foreground text-center">No scans yet.</div>
          ) : (
            <div className="space-y-2">
              {runs.map(r => <RunRow key={r.id} run={r} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: ScanRun }) {
  const pill = run.status === "done" ? "bg-emerald-500/15 text-emerald-400"
    : run.status === "running" ? "bg-primary/15 text-primary"
    : run.status === "error" ? "bg-rose-500/15 text-rose-400"
    : run.status === "cancelled" ? "bg-muted text-muted-foreground"
    : "bg-amber-500/15 text-amber-400";
  const dot = run.status === "done" ? "bg-emerald-500"
    : run.status === "running" ? "bg-primary animate-pulse"
    : run.status === "error" ? "bg-rose-500"
    : run.status === "cancelled" ? "bg-muted-foreground"
    : "bg-amber-500";
  return (
    <div className="rounded-xl border border-border bg-card p-3 flex items-center gap-3" data-testid={`scan-run-${run.id}`}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold capitalize flex-shrink-0 ${pill}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} /> {run.status}
          </span>
          <span className="text-[13px] font-medium text-foreground truncate">{run.label}</span>
        </div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap mt-1">
          <span className="tabular-nums">{run.verified.toLocaleString()} verified</span>
          <span className="tabular-nums text-primary font-semibold">{run.newFiber} primary matches</span>
          {run.newlyLive > 0 && <span className="tabular-nums text-orange-500">{run.newlyLive} provisional flips</span>}
          {run.failed > 0 && <span className="tabular-nums text-amber-500">{run.failed} failed</span>}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-[13px] font-semibold text-foreground tabular-nums">{usdCompact(run.costUsd)}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">proxy cost</div>
      </div>
    </div>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────────
function MetricCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-4 py-2 first:pl-4">
      <div className={`text-[17px] font-bold tabular-nums leading-none ${tone ?? "text-foreground"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1 whitespace-nowrap">{label}</div>
    </div>
  );
}
function Row({ Icon, label, value, accent }: { Icon: React.ElementType; label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px]">
      <Icon className={`w-3.5 h-3.5 ${accent ? "text-primary" : "text-muted-foreground"}`} />
      <span className="text-muted-foreground flex-1">{label}</span>
      <span className={`font-semibold tabular-nums ${accent ? "text-primary" : "text-foreground"}`}>{value}</span>
    </div>
  );
}
function CenterNote({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center gap-2 text-[13px] text-muted-foreground p-6 text-center">{children}</div>;
}
async function extractError(e: any): Promise<string> {
  try { if (e?.message) return String(e.message).replace(/^\d+:\s*/, ""); } catch {}
  return "Something went wrong.";
}
