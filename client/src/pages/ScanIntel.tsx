import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  scanApi, BAND_TINT, usdCompact, freshnessLabel,
  type MarketCard, type MarketDetail, type ScanRun, type RunPreview,
} from "@/lib/scanApi";
import {
  Radar, TrendingUp, Activity, X, ChevronRight, Loader2, Pause, Play, Square,
  Zap, Search, Gauge, CircleDollarSign, Sparkles, MapPinned,
} from "lucide-react";
import { OpportunityMap } from "@/components/scan/OpportunityMap";

// ── Scan Intelligence — the market-discovery cockpit ──────────────────────────
// One place to answer: where is fresh, unworked fiber opportunity, how confident
// are we, how much would it cost to verify, and how do we get a team on it. Reads
// are free (pure DB); a budgeted scan is the ONLY spend and is admin-gated. The
// product should make an operator feel it sees the market before they do.

type View = "markets" | "opportunity" | "activity";

export default function ScanIntel() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [view, setView] = useState<View>("markets");
  const [selected, setSelected] = useState<{ city: string; state: string } | null>(null);

  // Any run currently spending — shown as a persistent banner across all views,
  // and resumed on load (the "leave and return" guarantee at the UI layer).
  const { data: runsData } = useQuery({ queryKey: ["/api/scan/runs"], queryFn: scanApi.runs, refetchInterval: 4000 });
  const activeRun = runsData?.runs.find(r => r.status === "running" || r.status === "paused") ?? null;

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-background">
      <ScanHeader view={view} setView={setView} isAdmin={isAdmin} />
      {activeRun && <ActiveRunBanner run={activeRun} isAdmin={isAdmin} onOpen={() => setView("opportunity")} />}

      <div className="flex-1 min-h-0 overflow-hidden">
        {view === "markets" && (
          <MarketsView isAdmin={isAdmin} onScan={(c, s) => setSelected({ city: c, state: s })} onOpportunity={(c, s) => { setSelected({ city: c, state: s }); setView("opportunity"); }} />
        )}
        {view === "opportunity" && <OpportunityMap focusCity={selected} onBack={() => setView("markets")} />}
        {view === "activity" && <ActivityView />}
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
function ScanHeader({ view, setView, isAdmin }: { view: View; setView: (v: View) => void; isAdmin: boolean }) {
  const tabs: Array<{ id: View; label: string; Icon: React.ElementType }> = [
    { id: "markets", label: "Markets", Icon: TrendingUp },
    { id: "opportunity", label: "Opportunity Map", Icon: MapPinned },
    { id: "activity", label: "Activity", Icon: Activity },
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
          <span className="text-primary font-semibold tabular-nums">{r.newFiber} new-fiber</span>
          {r.newlyLive > 0 && <span className="text-orange-500 font-semibold tabular-nums">· {r.newlyLive} just live</span>}
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
            <MetricCell label="New fiber" value={totalNewFiber.toLocaleString()} tone="text-emerald-500" />
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
              <Zap className="w-3 h-3" /> {m.verifiedNewFiber.toLocaleString()} new fiber{m.newlyLive > 0 ? ` · ${m.newlyLive} just live` : ""}
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
              <div className="text-[14px] font-semibold text-foreground tabular-nums">{changes.newlyLive.count} addresses just went live</div>
              <div className="text-[12px] text-muted-foreground"><span className="tabular-nums">{changes.newlyLive.readyToAssign}</span> already turned into leads and ready to assign.</div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-secondary/40 p-4 text-[13px] text-muted-foreground text-center">
              No new-fiber flips detected yet. Run a rescan on a verified market to hunt for change — newly-live opportunities first observed by HomeFront show up here.
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
          <span className="tabular-nums text-primary font-semibold">{run.newFiber} new-fiber</span>
          {run.newlyLive > 0 && <span className="tabular-nums text-orange-500">{run.newlyLive} newly live</span>}
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
