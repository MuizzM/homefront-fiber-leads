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

// ── Header + view switch ──────────────────────────────────────────────────────
function ScanHeader({ view, setView, isAdmin }: { view: View; setView: (v: View) => void; isAdmin: boolean }) {
  const tabs: Array<{ id: View; label: string; Icon: React.ElementType }> = [
    { id: "markets", label: "Markets", Icon: TrendingUp },
    { id: "opportunity", label: "Opportunity Map", Icon: MapPinned },
    { id: "activity", label: "Activity", Icon: Activity },
  ];
  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card flex-shrink-0">
      <div className="flex items-center gap-2 mr-1">
        <div className="w-8 h-8 rounded-xl bg-primary/15 border border-primary/25 flex items-center justify-center">
          <Radar className="w-4.5 h-4.5 text-primary" style={{ width: 18, height: 18 }} />
        </div>
        <div className="leading-tight hidden sm:block">
          <div className="text-sm font-semibold text-foreground">Scan Intelligence</div>
          <div className="text-[11px] text-muted-foreground">Find markets before your competitors</div>
        </div>
      </div>
      <div className="flex items-center gap-1 ml-auto rounded-xl bg-secondary/60 p-1">
        {tabs.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setView(id)} data-testid={`scan-view-${id}`}
            aria-label={label} aria-pressed={view === id} title={label}
            className={`flex items-center gap-1.5 px-3 h-9 rounded-lg text-[13px] font-medium transition-colors ${view === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            <Icon className="w-4 h-4" /> <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>
      {!isAdmin && <span className="hidden md:inline text-[11px] text-muted-foreground/70 ml-1">view-only · scans are admin-run</span>}
    </div>
  );
}

// ── Active-run banner (persistent, resumable) ─────────────────────────────────
function ActiveRunBanner({ run, isAdmin, onOpen }: { run: ScanRun; isAdmin: boolean; onOpen: () => void }) {
  const qc = useQueryClient();
  const { data: live } = useQuery({ queryKey: ["/api/scan/runs", run.id], queryFn: () => scanApi.run(run.id), refetchInterval: 1500 });
  const r = live ?? run;
  const control = async (action: "pause" | "resume" | "cancel") => {
    try { await scanApi.controlRun(r.id, action); qc.invalidateQueries({ queryKey: ["/api/scan/runs"] }); } catch {}
  };
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-primary/10 border-b border-primary/20 flex-shrink-0" data-testid="scan-active-run">
      {r.status === "running" ? <Loader2 className="w-4 h-4 text-primary animate-spin" /> : <Pause className="w-4 h-4 text-amber-500" />}
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-4">
        {/* Summary strip */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <SummaryStat label="Markets" value={markets.length.toLocaleString()} Icon={TrendingUp} />
          <SummaryStat label="Addresses to verify" value={unverified.toLocaleString()} Icon={Search} />
          <SummaryStat label="Est. opportunity" value={totalOpp.toLocaleString()} Icon={Sparkles} accent />
          <div className="relative ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Find a city…" data-testid="scan-market-search"
              className="h-9 w-40 sm:w-52 pl-8 pr-3 rounded-lg bg-secondary/60 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40" />
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
  return (
    <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3 hover:border-primary/30 transition-colors" data-testid={`scan-market-${m.city}`}>
      <div className="flex items-start gap-3">
        {/* Priority dial */}
        <div className="relative w-12 h-12 flex-shrink-0" title={`Priority ${m.priority}/100`}>
          <svg viewBox="0 0 36 36" className="w-12 h-12 -rotate-90">
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="3" className="text-secondary" />
            <circle cx="18" cy="18" r="15.5" fill="none" stroke={tint} strokeWidth="3" strokeLinecap="round"
              strokeDasharray={`${(m.priority / 100) * 97.4} 97.4`} />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center text-[13px] font-bold" style={{ color: tint }}>{m.priority}</div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-foreground truncate">{m.city}</h3>
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-semibold" style={{ background: tint + "22", color: tint }}>{m.priorityBand}</span>
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${m.confidence === "high" ? "bg-emerald-500" : m.confidence === "medium" ? "bg-amber-500" : "bg-slate-400"}`} />
            {m.confidence} confidence · {freshnessLabel(m.freshnessDays)}
          </div>
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
      <div className="flex items-end justify-between rounded-xl bg-secondary/40 border border-border px-3 py-2 mt-auto">
        <div>
          <div className="text-[22px] font-bold leading-none tabular-nums" style={{ color: tint }}>
            {m.estRemainingOpportunity.toLocaleString()}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mt-1">est. opportunity</div>
        </div>
        <div className="text-right text-[11px] text-muted-foreground leading-tight">
          <div>{m.unworkedLeads.toLocaleString()} unworked</div>
          <div className="text-muted-foreground/60">{m.poolSize.toLocaleString()} in pool</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-auto pt-1">
        <button onClick={onOpportunity} data-testid={`scan-market-open-${m.city}`} className="flex-1 h-9 rounded-lg bg-secondary/70 hover:bg-secondary text-[13px] font-medium text-foreground flex items-center justify-center gap-1.5">
          <MapPinned className="w-3.5 h-3.5" /> Opportunity
        </button>
        {isAdmin && (
          <button onClick={onScan} data-testid={`scan-market-scan-${m.city}`} className="flex-1 h-9 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-[13px] font-semibold flex items-center justify-center gap-1.5">
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
        <header className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Zap className="w-4 h-4 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-foreground truncate">{city}, {state}</div>
            {card && <div className="text-[11px] text-muted-foreground">Priority {card.priority} · {card.confidence} confidence</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-secondary flex items-center justify-center text-muted-foreground"><X className="w-4 h-4" /></button>
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
                  <button onClick={() => { onClose(); onViewOpportunity(); }} className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-[13px] font-semibold">Watch on the Opportunity Map</button>
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
                            className={`text-left rounded-xl border p-3 transition-colors ${active ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                            <div className="flex items-center justify-between">
                              <span className="text-[13px] font-semibold text-foreground">{t.label}</span>
                              <span className="text-[11px] text-muted-foreground tabular-nums">{usdCompact(t.cost.estUsd)}</span>
                            </div>
                            <div className="text-[11px] text-muted-foreground mt-0.5">{t.checks.toLocaleString()} checks · {t.blurb}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Cost preview — always shown BEFORE spending (product law) */}
                  {preview && (
                    <div className="rounded-xl border border-border bg-secondary/40 p-3 space-y-1.5" data-testid="scan-cost-preview">
                      <Row Icon={Search} label="Addresses available to verify" value={preview.available.toLocaleString()} />
                      {preview.highValue > 0 && <Row Icon={Sparkles} label="High-value (near known fiber)" value={preview.highValue.toLocaleString()} />}
                      <Row Icon={Gauge} label="Will verify this run" value={preview.willVerify.toLocaleString()} />
                      <Row Icon={CircleDollarSign} label="Estimated proxy cost" value={usdCompact(preview.estimate.estUsd)} accent />
                      <p className="text-[11px] text-muted-foreground pt-1">Real cost is measured as it runs. Failed checks never fabricate a result.</p>
                    </div>
                  )}

                  <button onClick={start} disabled={starting || !chosenBudget || (preview?.willVerify ?? 0) === 0} data-testid="scan-start"
                    className="w-full h-11 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-50 text-primary-foreground text-[14px] font-semibold flex items-center justify-center gap-2">
                    {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                    {preview?.willVerify === 0 ? "Everything here was just verified" : `Verify ${(preview?.willVerify ?? chosenBudget).toLocaleString()} addresses`}
                  </button>
                </>
              ) : (
                <div className="rounded-xl border border-border bg-secondary/40 p-4 text-center text-[13px] text-muted-foreground">
                  Scans spend proxy budget and are run by an admin. You can explore the opportunity map and deploy verified opportunity to your team.
                </div>
              )}

              <button onClick={() => { onClose(); onViewOpportunity(); }} className="w-full h-9 rounded-lg bg-secondary/70 hover:bg-secondary text-[13px] font-medium text-foreground flex items-center justify-center gap-1.5">
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
      <div className="max-w-3xl mx-auto px-4 py-4 space-y-5">
        <section>
          <h2 className="text-[13px] font-semibold text-foreground flex items-center gap-1.5 mb-2"><Sparkles className="w-4 h-4 text-orange-500" /> What changed — last 72h</h2>
          {changes && changes.newlyLive.count > 0 ? (
            <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-3">
              <div className="text-[14px] font-semibold text-foreground">{changes.newlyLive.count} addresses just went live</div>
              <div className="text-[12px] text-muted-foreground">{changes.newlyLive.readyToAssign} already turned into leads and ready to assign.</div>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-secondary/40 p-4 text-[13px] text-muted-foreground text-center">
              No new-fiber flips detected yet. Run a rescan on a verified market to hunt for change — first-to-market opportunity shows up here.
            </div>
          )}
        </section>

        <section>
          <h2 className="text-[13px] font-semibold text-foreground flex items-center gap-1.5 mb-2"><Activity className="w-4 h-4 text-primary" /> Recent scans</h2>
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
  const statusColor = run.status === "done" ? "text-emerald-500" : run.status === "running" ? "text-primary" : run.status === "error" ? "text-red-500" : run.status === "cancelled" ? "text-muted-foreground" : "text-amber-500";
  return (
    <div className="rounded-xl border border-border bg-card p-3 flex items-center gap-3" data-testid={`scan-run-${run.id}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground truncate">{run.label}</div>
        <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
          <span className={`font-semibold capitalize ${statusColor}`}>{run.status}</span>
          <span className="tabular-nums">{run.verified.toLocaleString()} verified</span>
          <span className="tabular-nums text-primary font-semibold">{run.newFiber} new-fiber</span>
          {run.newlyLive > 0 && <span className="tabular-nums text-orange-500">{run.newlyLive} newly live</span>}
          {run.failed > 0 && <span className="tabular-nums text-amber-500">{run.failed} failed</span>}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[13px] font-semibold text-foreground tabular-nums">{usdCompact(run.costUsd)}</div>
        <div className="text-[10px] text-muted-foreground">proxy cost</div>
      </div>
    </div>
  );
}

// ── Small building blocks ─────────────────────────────────────────────────────
function SummaryStat({ label, value, Icon, accent }: { label: string; value: string; Icon: React.ElementType; accent?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${accent ? "border-primary/30 bg-primary/5" : "border-border bg-card"}`}>
      <Icon className={`w-4 h-4 ${accent ? "text-primary" : "text-muted-foreground"}`} />
      <div className="leading-tight">
        <div className="text-[15px] font-bold text-foreground tabular-nums">{value}</div>
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      </div>
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
