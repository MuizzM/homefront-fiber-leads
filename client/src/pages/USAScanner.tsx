/**
 * USA Market Scanner — Beat FiberFocus
 * Uses carrier-owned NC/SC directory evidence to show WHERE Kinetic is served
 * or expanding. Address-level checks remain the only availability truth.
 * Click any market to scan it immediately. Leads auto-saved to map.
 */
import { useState, useCallback, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Globe, Play, Square, CheckCircle, Zap,
  Search, X, Loader2, AlertCircle,
  Building, ChevronDown, ChevronUp
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";

const _API_BASE: string = ("__PORT_5000__" as string).startsWith("__") ? "" : ("__PORT_5000__" as string);

interface KineticMarket {
  state: string; city: string; zip: string;
  newPassings: number;
  addressCount: number;
  freshWeek: number;
  priority: "critical" | "high" | "medium";
  buildStatus: "active" | "planned" | "complete";
  buildDate: string;
}

interface MarketsData {
  lastUpdated: string;
  totalNewPassings: number | null;
  markets: KineticMarket[];
}

interface ScannerState {
  isRunning: boolean;
  checksPerSec: number;
  concurrency: number;
  maxInFlight: number;
  lastHeartbeat: number;
  totalChecked: number;
  diagHttpError: number;
  diagNewFiber: number;
  isStuck: boolean;
  secondsSinceHeartbeat: number;
  activeJob: { id: string; city: string; total: number; done: number; pct: number; newFiber: number } | null;
}

interface ActiveScan {
  jobId: string; city: string; state: string;
  status: "pulling" | "scanning" | "done" | "error";
  total: number; done: number; newFiber: number; error?: string;
}

const PRIORITY_BADGE = {
  critical: "bg-rose-500/15 text-rose-400 border-rose-500/20",
  high:     "bg-amber-500/15 text-amber-400 border-amber-500/20",
  medium:   "bg-sky-500/15 text-sky-400 border-sky-500/20",
};
const STATUS_DOT = {
  active:  "bg-emerald-400 animate-pulse",
  planned: "bg-amber-400",
  complete: "bg-muted-foreground",
};

const STATE_NAMES: Record<string, string> = {
  AL:"Alabama", AR:"Arkansas", FL:"Florida", GA:"Georgia", IA:"Iowa",
  KY:"Kentucky", MN:"Minnesota", MS:"Mississippi", MO:"Missouri", NE:"Nebraska",
  NM:"New Mexico", NY:"New York", NC:"North Carolina", OH:"Ohio", OK:"Oklahoma",
  PA:"Pennsylvania", SC:"South Carolina", TX:"Texas",
};

export default function USAScanner() {
  const [search, setSearch] = useState("");
  const [filterPriority, setFilterPriority] = useState<"all"|"critical"|"high"|"medium">("all");
  const [filterState, setFilterState] = useState<string>("all");
  const [expandedState, setExpandedState] = useState<string | null>("NC");
  const [activeScan, setActiveScan] = useState<ActiveScan | null>(null);
  const [completedScans, setCompletedScans] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  // Evidence-backed carrier market catalog
  const { data: marketsData, isLoading: marketsLoading } = useQuery<MarketsData>({
    queryKey: ["/api/markets/kinetic"],
    queryFn: async () => (await apiRequest("GET", "/api/markets/kinetic")).json(),
    staleTime: Infinity,
  });

  // Live scanner state — polled every 3s while scanning (FiberFocus pattern)
  const { data: scannerState } = useQuery<ScannerState>({
    queryKey: ["/api/scanner/state"],
    queryFn: async () => (await apiRequest("GET", "/api/scanner/state")).json(),
    refetchInterval: activeScan?.status === "scanning" ? 3000 : false,
    enabled: activeScan?.status === "scanning",
  });

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const connectSse = useCallback((jobId: string, city: string, state: string) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const sid = getStoredSessionId() ?? (window as any).__sessionId ?? "";

    (async () => {
      try {
        const resp = await fetch(`${_API_BASE}/api/scan/stream/${jobId}`, {
          headers: { "x-session-id": sid, "x-csrf-token": sid },
          signal: ctrl.signal,
        });

        if (!resp.ok || !resp.body) {
          // Polling fallback
          const pollId = setInterval(async () => {
            try {
              const s = await (await apiRequest("GET", `/api/scan/${jobId}`)).json();
              setActiveScan(prev => prev ? {
                ...prev,
                status: s.status === "done" ? "done" : s.status === "error" ? "error" : "scanning",
                done: s.done, total: s.total,
                newFiber: s.summary?.fresh ?? s.summary?.new_fiber ?? 0,
              } : null);
              if (s.status === "done" || s.status === "error") {
                clearInterval(pollId);
                qc.invalidateQueries({ queryKey: ["/api/leads"] });
                qc.invalidateQueries({ queryKey: ["/api/stats"] });
                setCompletedScans(prev => new Set([...prev, `${city},${state}`]));
                toast({ title: `Done — ${city}, ${state}`, description: `${s.summary?.fresh ?? s.summary?.new_fiber ?? 0} fresh-fiber leads saved` });
              }
            } catch {}
          }, 2000);
          return;
        }

        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = "", evType = "";

        while (true) {
          const { done: d, value } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("event:")) { evType = line.slice(6).trim(); }
            else if (line.startsWith("data:")) {
              try {
                const p = JSON.parse(line.slice(5).trim());
                if (evType === "progress") {
                  setActiveScan(prev => prev ? {
                    ...prev, status: "scanning",
                    done: p.done, total: p.total,
                    newFiber: p.summary?.fresh ?? p.summary?.new_fiber ?? prev.newFiber,
                  } : null);
                } else if (evType === "done") {
                  setActiveScan(prev => prev ? { ...prev, status: "done" } : null);
                  setCompletedScans(prev => new Set([...prev, `${city},${state}`]));
                  qc.invalidateQueries({ queryKey: ["/api/leads"] });
                  qc.invalidateQueries({ queryKey: ["/api/stats"] });
                  toast({ title: `Done — ${city}, ${state}`, description: "New fiber leads saved to map" });
                }
              } catch {}
              evType = "";
            }
          }
        }
      } catch (e: any) {
        if (e.name !== "AbortError") {
          setActiveScan(prev => prev ? { ...prev, status: "error", error: e.message } : null);
        }
      }
    })();
  }, [qc, toast]);

  const startScan = useCallback(async (market: KineticMarket) => {
    if (activeScan?.status === "scanning" || activeScan?.status === "pulling") {
      toast({ title: "Scan in progress", description: "Stop current scan first" });
      return;
    }
    stopAll();
    setActiveScan({ jobId: "", city: market.city, state: market.state, status: "pulling", total: 0, done: 0, newFiber: 0 });

    try {
      const { jobId, total } = await (await apiRequest("POST", "/api/scan/start-city", {
        city: market.city, state: market.state, zip: market.zip,
      })).json();
      setActiveScan(prev => prev ? { ...prev, jobId, status: "scanning", total } : null);
      toast({
        title: `Scanning ${market.city}, ${market.state}`,
        description: `${total.toLocaleString()} addresses · 4 parallel workers · 200 concurrent`,
      });
      connectSse(jobId, market.city, market.state);
    } catch (e: any) {
      setActiveScan(prev => prev ? { ...prev, status: "error", error: e.message } : null);
      toast({ title: "Scan failed", description: e.message, variant: "destructive" });
    }
  }, [activeScan, stopAll, connectSse, toast]);

  const stopScan = useCallback(async () => {
    stopAll();
    if (activeScan?.jobId) {
      try { await apiRequest("DELETE", `/api/scan/${activeScan.jobId}`); } catch {}
    }
    setActiveScan(prev => prev ? { ...prev, status: "done" } : null);
  }, [stopAll, activeScan]);

  const markets = marketsData?.markets ?? [];
  const isScanning = activeScan?.status === "scanning" || activeScan?.status === "pulling";
  const pct = activeScan?.total ? Math.round(activeScan.done / activeScan.total * 100) : 0;

  // Group by state, apply filters
  const filtered = markets.filter(m => {
    if (filterPriority !== "all" && m.priority !== filterPriority) return false;
    if (filterState !== "all" && m.state !== filterState) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      return m.city.toLowerCase().includes(q) || m.state.toLowerCase().includes(q) ||
             STATE_NAMES[m.state]?.toLowerCase().includes(q) || m.zip.includes(q);
    }
    return true;
  });

  const byState = filtered.reduce<Record<string, KineticMarket[]>>((acc, m) => {
    (acc[m.state] = acc[m.state] ?? []).push(m);
    return acc;
  }, {});

  const states = Object.keys(byState).sort();
  const allStates = [...new Set(markets.map(m => m.state))].sort();
  const criticalCount = markets.filter(m => m.priority === "critical").length;

  return (
    <div className="p-5 space-y-6 max-w-5xl">

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Globe className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              USA Fiber Intelligence
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {marketsData
                ? `FCC BDC coverage · updated ${marketsData.lastUpdated}`
                : "Loading FCC broadband data…"}
            </p>
          </div>
        </div>
        {marketsData && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live feed
          </span>
        )}
      </div>

      {/* Metric strip */}
      {marketsData && (
        <div className="grid grid-cols-2 sm:grid-cols-4 rounded-xl border border-border bg-card overflow-hidden divide-x divide-y sm:divide-y-0 divide-border">
          <div className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Active Markets</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{markets.length.toLocaleString()}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Critical</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-rose-400">{criticalCount.toLocaleString()}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Active Builds</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{markets.filter(m=>m.buildStatus==="active").length.toLocaleString()}</div>
          </div>
          <div className="px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Addresses inventoried</div>
            <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{markets.reduce((sum,m)=>sum+m.addressCount,0).toLocaleString()}</div>
          </div>
        </div>
      )}

      {/* Active scan panel */}
      {activeScan && (
        <Card className="border-border bg-card overflow-hidden">
          <div className={`h-0.5 w-full ${
            activeScan.status === "error" ? "bg-rose-500" :
            activeScan.status === "done"  ? "bg-emerald-500" :
            "bg-primary"
          }`} />
          <CardContent className="pt-4 pb-4 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                {isScanning ? <Loader2 className="w-5 h-5 text-primary animate-spin" /> :
                 activeScan.status === "done" ? <CheckCircle className="w-5 h-5 text-emerald-400" /> :
                 <AlertCircle className="w-5 h-5 text-rose-400" />}
                <div>
                  <div className="font-semibold tracking-tight text-sm text-foreground">
                    {activeScan.city}, {activeScan.state}
                    {activeScan.status === "pulling" && <span className="text-muted-foreground ml-2 font-normal">— harvesting addresses…</span>}
                    {activeScan.status === "scanning" && activeScan.total > 0 &&
                      <span className="text-muted-foreground ml-2 font-normal tabular-nums">— {activeScan.done.toLocaleString()} / {activeScan.total.toLocaleString()}</span>}
                    {activeScan.status === "done" && <span className="text-emerald-400 ml-2 font-normal">— complete</span>}
                  </div>
                  {activeScan.newFiber > 0 && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-400">
                        <Zap className="w-3 h-3" />{activeScan.newFiber} confirmed fresh leads
                      </span>
                      <span className="text-xs text-muted-foreground">saved to map</span>
                    </div>
                  )}
                  {activeScan.error && <p className="text-xs text-rose-400 mt-1">{activeScan.error}</p>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isScanning && (
                  <Button size="sm" variant="destructive" onClick={stopScan} className="gap-1.5">
                    <Square className="w-3.5 h-3.5" /> Stop
                  </Button>
                )}
                {(activeScan.status === "done" || activeScan.status === "error") && (
                  <Button size="sm" variant="outline" onClick={() => setActiveScan(null)} className="gap-1.5">
                    <X className="w-3.5 h-3.5" /> Dismiss
                  </Button>
                )}
              </div>
            </div>

            {isScanning && activeScan.total > 0 && (
              <div className="space-y-1.5">
                <Progress value={pct} className="h-1.5" />
                <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
                  <span>{activeScan.done.toLocaleString()} checked</span>
                  <span className="font-semibold text-foreground">{pct}%</span>
                </div>
              </div>
            )}

            {/* Live worker metrics (FiberFocus-style) */}
            {isScanning && scannerState && scannerState.isRunning && (
              <div className="grid grid-cols-4 rounded-lg border border-border divide-x divide-border overflow-hidden">
                <div className="px-3 py-2">
                  <div className="text-lg font-semibold tracking-tight font-mono tabular-nums text-primary">{scannerState.checksPerSec.toFixed(1)}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">checks/sec</div>
                </div>
                <div className="px-3 py-2">
                  <div className="text-lg font-semibold tracking-tight font-mono tabular-nums text-foreground">{scannerState.concurrency}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">in-flight</div>
                </div>
                <div className="px-3 py-2">
                  <div className="text-lg font-semibold tracking-tight font-mono tabular-nums text-emerald-400">{scannerState.diagNewFiber}</div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">primary matches</div>
                </div>
                <div className="px-3 py-2">
                  <div className={`text-lg font-semibold tracking-tight font-mono tabular-nums ${scannerState.diagHttpError > 5 ? "text-rose-400" : "text-muted-foreground"}`}>
                    {scannerState.diagHttpError}
                  </div>
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground">errors</div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            data-testid="input-usa-search"
            placeholder="Search city, state, ZIP…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 bg-background border-border h-9 text-sm"
          />
          {search && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => setSearch("")}>
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* Priority filter */}
        {(["all","critical","high","medium"] as const).map(p => (
          <button
            key={p}
            onClick={() => setFilterPriority(p)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              filterPriority === p
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-card border-border text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            {p === "all" ? "All Priority" : p.charAt(0).toUpperCase() + p.slice(1)}
          </button>
        ))}

        {/* State filter */}
        <select
          value={filterState}
          onChange={e => setFilterState(e.target.value)}
          className="h-9 px-2 bg-background border border-border rounded-lg text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <option value="all">All States</option>
          {allStates.map(s => <option key={s} value={s}>{s} — {STATE_NAMES[s]}</option>)}
        </select>
      </div>

      {/* Market count */}
      {filtered.length < markets.length && (
        <p className="text-xs text-muted-foreground">{filtered.length} of {markets.length} markets</p>
      )}

      {/* State groups */}
      {marketsLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading verified carrier markets…
        </div>
      ) : (
        <div className="space-y-3">
          {states.map(abbr => {
            const cityList = byState[abbr];
            const isOpen = expandedState === abbr || !!search.trim() || filterPriority !== "all";
            const trackedAddresses = cityList.reduce((s, m) => s + m.addressCount, 0);
            const hasCritical = cityList.some(m => m.priority === "critical");

            return (
              <Card key={abbr} className="bg-card border-border overflow-hidden">
                <button
                  className="w-full px-4 py-3 flex items-center justify-between hover:bg-muted/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  onClick={() => setExpandedState(isOpen && !search.trim() && filterPriority === "all" ? null : abbr)}
                  data-testid={`state-${abbr}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${
                      hasCritical ? "bg-rose-500/10 border-rose-500/20" : "bg-secondary border-border"
                    }`}>
                      <span className={`text-xs font-semibold tracking-tight ${hasCritical ? "text-rose-400" : "text-muted-foreground"}`}>{abbr}</span>
                    </div>
                    <div className="text-left">
                      <div className="font-semibold tracking-tight text-sm text-foreground">
                        {STATE_NAMES[abbr]}
                      </div>
                      <div className="text-xs text-muted-foreground tabular-nums">
                        {cityList.length} markets · {trackedAddresses.toLocaleString()} addresses inventoried
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {cityList.filter(m=>m.priority==="critical").length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-400 tabular-nums">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                        {cityList.filter(m=>m.priority==="critical").length} critical
                      </span>
                    )}
                    {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-border divide-y divide-border/50">
                    {cityList.sort((a, b) => b.addressCount - a.addressCount).map(market => {
                      const key = `${market.city},${market.state}`;
                      const isActive = activeScan?.city === market.city && activeScan?.state === market.state;
                      const isDone = completedScans.has(key);
                      const isRunning = isActive && isScanning;

                      return (
                        <div
                          key={key}
                          className={`flex items-center justify-between px-4 py-3 transition-colors ${
                            isRunning ? "bg-primary/5" : "hover:bg-muted/20"
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[market.buildStatus]}`} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold tracking-tight text-sm text-foreground">{market.city}</span>
                                <span className="text-xs text-muted-foreground font-mono tabular-nums">{market.zip}</span>
                                <Badge variant="outline" className={`text-xs py-0 rounded-full ${PRIORITY_BADGE[market.priority]}`}>
                                  {market.priority}
                                </Badge>
                              </div>
                              <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1 tabular-nums">
                                  <Building className="w-3 h-3" />
                                  {market.addressCount.toLocaleString()} tracked · {market.freshWeek.toLocaleString()} provisional flips this week
                                </span>
                                <span className="tabular-nums">{market.buildDate}</span>
                                <span className={`font-medium ${market.buildStatus === "active" ? "text-emerald-400" : "text-amber-400"}`}>
                                  {market.buildStatus}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 flex-shrink-0">
                            {isRunning && activeScan.newFiber > 0 && (
                              <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1 tabular-nums">
                                <Zap className="w-3 h-3" />{activeScan.newFiber}
                              </span>
                            )}
                            {isDone && !isRunning && (
                              <span className="text-xs text-emerald-400 flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" /> done
                              </span>
                            )}
                            <Button
                              data-testid={`scan-${abbr}-${market.city}`}
                              size="sm"
                              variant={isRunning ? "destructive" : market.priority === "critical" ? "default" : "outline"}
                              className={`h-7 px-3 text-xs gap-1.5 ${isRunning ? "" : market.priority === "critical" ? "bg-primary hover:bg-primary/90" : ""}`}
                              disabled={isScanning && !isRunning}
                              onClick={() => isRunning ? stopScan() : startScan(market)}
                            >
                              {isRunning ? (
                                <><Square className="w-3 h-3" /> Stop</>
                              ) : activeScan?.status === "pulling" && isActive ? (
                                <><Loader2 className="w-3 h-3 animate-spin" /> Pulling…</>
                              ) : (
                                <><Play className="w-3 h-3" /> Scan</>
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* How it beats FiberFocus */}
      <Card className="bg-card border-border">
        <CardContent className="pt-4 pb-4">
          <p className="text-[11px] font-medium text-muted-foreground mb-3 uppercase tracking-wide">Scan Engine</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 rounded-lg border border-border divide-x divide-y sm:divide-y-0 divide-border overflow-hidden">
            <div className="px-4 py-3">
              <div className="text-lg font-semibold tracking-tight tabular-nums text-foreground">200</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">proxy connections</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-lg font-semibold tracking-tight tabular-nums text-foreground">×2</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">pipeline per socket</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-lg font-semibold tracking-tight tabular-nums text-foreground">4</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">parallel zone workers</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-lg font-semibold tracking-tight tabular-nums text-foreground">5s</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">timeout (fast recycle)</div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            400 simultaneous proxy slots · FCC BDC data tells you exactly where fiber is going before Kinetic announces it
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
