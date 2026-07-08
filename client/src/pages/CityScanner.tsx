import { useState, useCallback, useRef, useEffect } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";

// Backend base — empty string in dev, proxy path after deploy (rewritten by deploy_website)
const _API_BASE: string = ("__PORT_5000__" as string).startsWith("__") ? "" : ("__PORT_5000__" as string);
import { useToast } from "@/hooks/use-toast";
import {
  Radar, Play, Square, Wifi, CheckCircle,
  Zap, Download, RefreshCw, AlertTriangle,
  MapPin, Search, Globe, Flame, Star, TrendingUp, Users,
  Activity, Cpu, Timer, AlertCircle
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ScanRow {
  address: string; city: string; state: string; zip: string;
  fiberStatus: string;
  isNewFiber: boolean; isTenured: boolean; fiberAvailable: boolean;
  householdSegmentType: string | null;
  billingStatus: string | null;
  techType: string | null; chipSetType: string | null; placement: string | null;
  maxDownloadMbps: number | null;
  competitorName: string | null; competitorSpeedMbps: number | null; competitorTech: string | null;
  addressCatalogDate: string | null;
  confidence: string; apiSource: string; notes: string;
  lat: number | null; lng: number | null;
  leadTag: string | null;
  leadScore: number;
}

interface ScanJobStatus {
  id: string; city: string; zip: string;
  status: "running" | "done" | "error";
  total: number; done: number;
  results: ScanRow[];
  summary: {
    new_fiber: number; tenured_fiber: number; existing_fiber: number;
    copper: number; no_service: number; unknown: number;
    scanned: number; remaining: number;
  };
}

interface OverpassResult {
  count: number;
  cityName: string;
  center: [number, number];
  bbox: { south: number; west: number; north: number; east: number };
  addresses: { address: string; city: string; state: string; zip: string; lat: number; lng: number }[];
}

const STATUS_CONFIG: Record<string, { label: string; dot: string; bg: string }> = {
  new_fiber:      { label: "NEW FIBER",  dot: "bg-green-400",  bg: "bg-green-400/10 border-green-400/30" },
  tenured_fiber:  { label: "TENURED",    dot: "bg-purple-400", bg: "bg-purple-400/10 border-purple-400/30" },
  existing_fiber: { label: "FIBER",      dot: "bg-sky-400",    bg: "bg-sky-400/10 border-sky-400/30" },
  copper:         { label: "COPPER/DSL", dot: "bg-amber-400",  bg: "bg-amber-400/10 border-amber-400/30" },
  no_service:     { label: "NO SERVICE", dot: "bg-red-400",    bg: "bg-red-400/10 border-red-400/30" },
  unknown:        { label: "UNKNOWN",    dot: "bg-slate-500",  bg: "bg-slate-500/10 border-slate-500/30" },
};

const TAG_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  hot_lead:       { label: "HOT LEAD",       icon: "🔥", color: "text-orange-400" },
  coming_soon:    { label: "COMING SOON",     icon: "⏳", color: "text-yellow-400" },
  upgrade_target: { label: "UPGRADE TARGET",  icon: "⬆️", color: "text-sky-400" },
};

type FilterKey = "all" | "new_fiber" | "tenured_fiber" | "copper" | "no_service";

// US State abbreviations
const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY"
];

export default function CityScanner() {
  const [cityInput, setCityInput] = useState("Rockwell");
  const [stateInput, setStateInput] = useState("NC");
  const [scanning, setScanning] = useState(false);
  const [done, setDone] = useState(false);
  const [jobStatus, setJobStatus] = useState<ScanJobStatus | null>(null);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [pullingAddresses, setPullingAddresses] = useState(false);
  const [overpassResult, setOverpassResult] = useState<OverpassResult | null>(null);

  // SSE stream ref
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── FiberFocus-style: poll scanner state every 3s while scanning ───────────
  const { data: scannerState } = useQuery<{
    isRunning: boolean;
    checksPerSec: number;
    concurrency: number;
    maxInFlight: number;
    lastHeartbeat: number;
    totalChecked: number;
    diagHttpError: number;
    diagNewFiber: number;
    diagSuccess: number;
    isStuck: boolean;
    secondsSinceHeartbeat: number;
    activeJob: { id: string; city: string; total: number; done: number; pct: number; newFiber: number } | null;
  }>({
    queryKey: ["/api/scanner/state"],
    queryFn: async () => (await apiRequest("GET", "/api/scanner/state")).json(),
    refetchInterval: scanning ? 3000 : false,
    enabled: scanning,
  });

  // Persistent address-pool stats (harvest-once, re-scan-for-free engine)
  const { data: poolStats } = useQuery<{ total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null }>({
    queryKey: ["/api/scan/pool-stats"],
    queryFn: async () => (await apiRequest("GET", "/api/scan/pool-stats")).json(),
    refetchInterval: 8000,
  });

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  // SSE stream connection — streams results in real time
  const connectSseStream = useCallback(async (id: string) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const sessionId = getStoredSessionId() ?? (window as any).__sessionId ?? "";
    try {
      const resp = await fetch(`${_API_BASE}/api/scan/stream/${id}`, {
        headers: { "x-session-id": sessionId, "x-csrf-token": sessionId },
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        // SSE unavailable — fall back to polling
        pollRef.current = setInterval(async () => {
          try {
            const status: ScanJobStatus = await (await apiRequest("GET", `/api/scan/${id}`)).json();
            setJobStatus(status);
            if (status.status === "done") {
              clearInterval(pollRef.current!); pollRef.current = null;
              setScanning(false); setDone(true);
              qc.invalidateQueries({ queryKey: ["/api/leads"] });
              qc.invalidateQueries({ queryKey: ["/api/stats"] });
              toast({ title: "Scan complete", description: `${status.summary.new_fiber} new fiber · ${status.summary.tenured_fiber} tenured` });
            }
          } catch {}
        }, 1500);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let eventType = "";

      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event:")) { eventType = line.slice(6).trim(); }
          else if (line.startsWith("data:")) {
            try {
              const payload = JSON.parse(line.slice(5).trim());
              if (eventType === "result") {
                setJobStatus(prev => prev ? { ...prev, results: [...prev.results, payload] } : null);
              } else if (eventType === "progress") {
                setJobStatus(prev => prev ? {
                  ...prev,
                  status: payload.status, done: payload.done, total: payload.total,
                  summary: payload.summary ?? prev.summary,
                } : null);
              } else if (eventType === "done") {
                setScanning(false); setDone(true);
                qc.invalidateQueries({ queryKey: ["/api/leads"] });
                qc.invalidateQueries({ queryKey: ["/api/stats"] });
                try {
                  const finalStatus: ScanJobStatus = await (await apiRequest("GET", `/api/scan/${id}`)).json();
                  setJobStatus(finalStatus);
                  toast({
                    title: "Scan complete",
                    description: `${finalStatus.summary.new_fiber} new fiber · ${finalStatus.summary.tenured_fiber} tenured`
                  });
                } catch {}
              }
            } catch {}
            eventType = "";
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") console.warn("SSE error:", e.message);
    }
  }, [qc, toast]);

  // Step 1: Pull addresses from Overpass
  const pullAddresses = useCallback(async () => {
    if (!cityInput.trim()) return;
    setPullingAddresses(true);
    setOverpassResult(null);
    try {
      const result: OverpassResult = await (await apiRequest(
        "GET",
        `/api/scan/city-addresses?city=${encodeURIComponent(cityInput.trim())}&state=${encodeURIComponent(stateInput.trim())}`
      )).json();
      setOverpassResult(result);
      toast({
        title: `${result.count.toLocaleString()} addresses found`,
        description: `${result.cityName} — ready to scan`,
      });
    } catch (e: any) {
      toast({ title: "Address pull failed", description: e.message, variant: "destructive" });
    } finally {
      setPullingAddresses(false);
    }
  }, [cityInput, stateInput, toast]);

  // Step 2: Run scan on pulled addresses
  const runScan = useCallback(async () => {
    stopAll();
    setScanning(true);
    setDone(false);
    setJobStatus(null);
    setJobId(null);

    try {
      // Use pre-pulled addresses if available, otherwise let backend pull
      const body: any = { city: cityInput.trim(), state: stateInput.trim() };
      if (overpassResult?.addresses) body.addresses = overpassResult.addresses;

      const { jobId: newJobId, total, city: cityLabel } = await (await apiRequest("POST", "/api/scan/start-city", body)).json();
      setJobId(newJobId);
      setJobStatus({
        id: newJobId, city: cityLabel, zip: "",
        status: "running", total, done: 0, results: [],
        summary: { new_fiber: 0, tenured_fiber: 0, existing_fiber: 0, copper: 0, no_service: 0, unknown: 0, scanned: 0, remaining: total }
      });
      toast({ title: "Scan started", description: `Checking ${total.toLocaleString()} addresses via live stream` });
      connectSseStream(newJobId);
    } catch (e: any) {
      setScanning(false);
      toast({ title: "Failed to start scan", description: e.message, variant: "destructive" });
    }
  }, [stopAll, connectSseStream, toast, cityInput, stateInput, overpassResult]);

  const stopScan = useCallback(async () => {
    stopAll();
    if (jobId) {
      try { await apiRequest("DELETE", `/api/scan/${jobId}`); } catch {}
    }
    setScanning(false);
  }, [stopAll, jobId]);

  // Re-scan the stored address pool for newly-lit fiber — zero geocoding cost.
  const rescanPool = useCallback(async () => {
    stopAll();
    setScanning(true); setDone(false); setJobStatus(null); setJobId(null);
    try {
      const data = await (await apiRequest("POST", "/api/scan/rescan-pool", {})).json();
      if (!data.jobId) {
        setScanning(false);
        toast({ title: data.message || "Nothing to re-scan yet", description: "Run a city scan first to build the address pool." });
        return;
      }
      setJobId(data.jobId);
      setJobStatus({
        id: data.jobId, city: "Address pool re-scan", zip: "",
        status: "running", total: data.total, done: 0, results: [],
        summary: { new_fiber: 0, tenured_fiber: 0, existing_fiber: 0, copper: 0, no_service: 0, unknown: 0, scanned: 0, remaining: data.total },
      });
      toast({ title: "Pool re-scan started", description: `Re-checking ${Number(data.total).toLocaleString()} stored addresses — free, no geocoding` });
      connectSseStream(data.jobId);
    } catch (e: any) {
      setScanning(false);
      toast({ title: "Failed to start pool re-scan", description: e.message, variant: "destructive" });
    }
  }, [stopAll, connectSseStream, toast]);

  const results = jobStatus?.results ?? [];
  const summary = jobStatus?.summary;
  const total = jobStatus?.total ?? 0;
  const checkedCount = jobStatus?.done ?? 0;
  const pct = total ? Math.round((checkedCount / total) * 100) : 0;
  const currentAddr = results[checkedCount - 1]?.address ?? "";

  const exportCSV = useCallback(() => {
    const header = "Address,City,ZIP,Status,Tag,Score,Segment,billingStatus,Tech,ChipSet,Speed Mbps,Competitor,CompSpeed,Catalog Date,Notes";
    const rows = filteredResults.map(r =>
      `"${r.address}","${r.city}","${r.zip}","${r.fiberStatus}","${r.leadTag ?? ""}","${r.leadScore ?? ""}","${r.householdSegmentType ?? ""}","${r.billingStatus ?? ""}","${r.techType ?? ""}","${r.chipSetType ?? ""}","${r.maxDownloadMbps ?? ""}","${r.competitorName ?? ""}","${r.competitorSpeedMbps ?? ""}","${r.addressCatalogDate ?? ""}","${r.notes}"`
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `homefront_fiber_${cityInput.trim().toLowerCase()}_scan.csv`;
    a.click();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, filter, cityInput]);

  const filteredResults = results.filter(r => {
    if (filter === "all") return true;
    return r.fiberStatus === filter;
  }).sort((a, b) => {
    // Sort by lead score descending (hot leads first)
    return (b.leadScore ?? 0) - (a.leadScore ?? 0);
  });

  // Hot leads count
  const hotLeads = results.filter(r => r.leadTag === "hot_lead").length;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold">City Scanner</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Type any city in the USA — pulls all addresses via Overpass, then scans each live against Kinetic. Hot Leads saved automatically.
        </p>
      </div>

      {/* City search */}
      <Card className="bg-card border-border">
        <CardContent className="pt-5 pb-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Globe className="w-4 h-4 text-primary" />
              Step 1: Select City
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground mb-1 block">City Name</label>
                <Input
                  data-testid="input-city"
                  placeholder="e.g. Rockwell, Charlotte, Concord..."
                  value={cityInput}
                  onChange={e => setCityInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && pullAddresses()}
                  disabled={scanning}
                  className="bg-background border-border"
                />
              </div>
              <div className="w-24">
                <label className="text-xs text-muted-foreground mb-1 block">State</label>
                <select
                  data-testid="select-state"
                  value={stateInput}
                  onChange={e => setStateInput(e.target.value)}
                  disabled={scanning}
                  className="w-full h-9 px-2 bg-background border border-border rounded-md text-sm text-foreground"
                >
                  {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="flex items-end">
                <Button
                  data-testid="button-pull-addresses"
                  onClick={pullAddresses}
                  disabled={pullingAddresses || scanning || !cityInput.trim()}
                  variant="outline"
                  className="gap-2"
                >
                  {pullingAddresses ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  {pullingAddresses ? "Pulling..." : "Pull Addresses"}
                </Button>
              </div>
            </div>

            {/* Overpass result */}
            {overpassResult && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <MapPin className="w-4 h-4 text-primary flex-shrink-0" />
                  <div className="flex-1">
                    <span className="text-sm font-semibold text-foreground">{overpassResult.count.toLocaleString()} addresses</span>
                    <span className="text-xs text-muted-foreground ml-2">in {overpassResult.cityName}</span>
                  </div>
                  <span className="text-xs text-green-400 font-semibold">Ready to scan</span>
                </div>
                {/* No static-map preview: it was a billable Mapbox Static Images
                    request (with a hardcoded token) for pure decoration. The scan
                    results land on the Field Map anyway. */}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Scan control */}
      <Card className="bg-card border-border">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground mb-4">
            <Radar className="w-4 h-4 text-primary" />
            Step 2: Run Kinetic Scan
          </div>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              {overpassResult
                ? <p className="text-sm text-foreground">{overpassResult.count.toLocaleString()} addresses in <span className="font-semibold">{cityInput}, {stateInput}</span></p>
                : <p className="text-sm text-muted-foreground">Pull addresses first, or scan will use built-in Rockwell list</p>
              }
              {poolStats && poolStats.total > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Address pool: <span className="font-semibold text-foreground">{poolStats.total.toLocaleString()}</span> stored · <span className="text-teal-400">{poolStats.newFiber.toLocaleString()}</span> new fiber found
                </p>
              )}
              {scanning && checkedCount > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5 font-mono truncate max-w-[280px]">→ {currentAddr}</p>
              )}
            </div>
            <div className="flex gap-2">
              {!scanning ? (
                <Button
                  data-testid="button-start-scan"
                  onClick={runScan}
                  className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  <Play className="w-4 h-4" /> Start Scan
                </Button>
              ) : (
                <Button
                  data-testid="button-stop-scan"
                  onClick={stopScan}
                  variant="destructive"
                  className="gap-2"
                >
                  <Square className="w-4 h-4" /> Stop
                </Button>
              )}
              {!scanning && poolStats && poolStats.total > 0 && (
                <Button
                  data-testid="button-rescan-pool"
                  onClick={rescanPool}
                  variant="outline"
                  className="gap-2"
                  title={`Re-scan ${poolStats.total.toLocaleString()} stored addresses for new fiber — no geocoding cost`}
                >
                  <RefreshCw className="w-4 h-4" /> Re-scan Pool
                </Button>
              )}
              {done && results.length > 0 && (
                <Button
                  data-testid="button-export-csv"
                  onClick={exportCSV}
                  variant="outline"
                  className="gap-2"
                >
                  <Download className="w-4 h-4" /> Export CSV
                </Button>
              )}
            </div>
          </div>

          {/* Progress bar */}
          {(scanning || done) && total > 0 && (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{checkedCount.toLocaleString()} / {total.toLocaleString()} scanned</span>
                <span className="font-mono font-bold text-foreground">{pct}%</span>
              </div>
              <Progress value={pct} className="h-2.5" />
              {scanning && currentAddr && (
                <p className="text-xs text-muted-foreground font-mono truncate">⟶ {currentAddr}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* FiberFocus-style live worker stats — shown while scanning */}
      {scanning && scannerState && (
        <Card className={`border ${scannerState.isStuck ? "border-red-500/40 bg-red-500/5" : "border-primary/30 bg-primary/5"}`}>
          <CardContent className="pt-3 pb-3">
            <div className="flex items-center gap-2 mb-3">
              <Activity className={`w-4 h-4 ${scannerState.isStuck ? "text-red-400" : "text-primary animate-pulse"}`} />
              <span className="text-xs font-bold uppercase tracking-wider text-foreground">Worker State</span>
              {scannerState.isStuck && (
                <span className="flex items-center gap-1 text-xs text-red-400 font-semibold">
                  <AlertCircle className="w-3 h-3" /> STUCK — no heartbeat {scannerState.secondsSinceHeartbeat}s
                </span>
              )}
              {!scannerState.isStuck && scannerState.isRunning && (
                <span className="text-xs text-green-400 font-semibold">RUNNING</span>
              )}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="text-center">
                <div className="text-lg font-black font-mono text-primary">{scannerState.checksPerSec.toFixed(1)}</div>
                <div className="text-xs text-muted-foreground">checks/sec</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-black font-mono text-foreground">{scannerState.concurrency}</div>
                <div className="text-xs text-muted-foreground">in-flight</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-black font-mono text-green-400">{scannerState.diagNewFiber}</div>
                <div className="text-xs text-muted-foreground">new fiber</div>
              </div>
              <div className="text-center">
                <div className={`text-lg font-black font-mono ${scannerState.diagHttpError > 0 ? "text-red-400" : "text-muted-foreground"}`}>
                  {scannerState.diagHttpError}
                </div>
                <div className="text-xs text-muted-foreground">errors</div>
              </div>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-mono">{scannerState.totalChecked.toLocaleString()} total checks this session</span>
              <span className="font-mono">max {scannerState.maxInFlight} concurrent</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="bg-green-500/10 border-green-500/30">
            <CardContent className="pt-3 pb-3 text-center">
              <div className="text-2xl font-bold text-green-400">{summary.new_fiber}</div>
              <div className="text-xs text-muted-foreground mt-0.5">NEW FIBER</div>
            </CardContent>
          </Card>
          {hotLeads > 0 && (
            <Card className="bg-orange-500/10 border-orange-500/30">
              <CardContent className="pt-3 pb-3 text-center">
                <div className="text-2xl font-bold text-orange-400 flex items-center justify-center gap-1">
                  <Flame className="w-5 h-5" />{hotLeads}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">HOT LEADS</div>
              </CardContent>
            </Card>
          )}
          <Card className="bg-purple-500/10 border-purple-500/30">
            <CardContent className="pt-3 pb-3 text-center">
              <div className="text-2xl font-bold text-purple-400">{summary.tenured_fiber}</div>
              <div className="text-xs text-muted-foreground mt-0.5">TENURED</div>
            </CardContent>
          </Card>
          <Card className="bg-amber-500/10 border-amber-500/30">
            <CardContent className="pt-3 pb-3 text-center">
              <div className="text-2xl font-bold text-amber-400">{summary.copper}</div>
              <div className="text-xs text-muted-foreground mt-0.5">COPPER/DSL</div>
            </CardContent>
          </Card>
          <Card className="bg-card border-border">
            <CardContent className="pt-3 pb-3 text-center">
              <div className="text-2xl font-bold text-foreground">{summary.scanned}</div>
              <div className="text-xs text-muted-foreground mt-0.5">SCANNED</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filter bar */}
      {results.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {(["all", "new_fiber", "tenured_fiber", "copper", "no_service"] as FilterKey[]).map(f => {
            const cfg = STATUS_CONFIG[f];
            const count = f === "all" ? results.length : results.filter(r => r.fiberStatus === f).length;
            return (
              <button
                data-testid={`filter-${f}`}
                key={f}
                onClick={() => setFilter(f)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  filter === f
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-border hover:border-primary/50"
                }`}
              >
                {cfg && <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />}
                {f === "all" ? "All" : cfg?.label} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Results list */}
      {filteredResults.length > 0 && (
        <div className="space-y-2">
          {filteredResults.map((r, i) => {
            const cfg = STATUS_CONFIG[r.fiberStatus] ?? STATUS_CONFIG.unknown;
            const tag = r.leadTag ? TAG_CONFIG[r.leadTag] : null;
            const isExpanded = expandedIdx === i;
            return (
              <div
                key={i}
                data-testid={`result-row-${i}`}
                className={`rounded-xl border bg-card transition-all cursor-pointer hover:border-primary/40 ${cfg.bg}`}
                onClick={() => setExpandedIdx(isExpanded ? null : i)}
              >
                <div className="px-4 py-3 flex items-center gap-3">
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot} ${r.isNewFiber ? "shadow-[0_0_8px_currentColor] animate-pulse" : ""}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">{r.address}</span>
                      <span className="text-xs text-muted-foreground">{r.city}, {r.state} {r.zip}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">{cfg.label}</span>
                      {tag && (
                        <span className={`text-xs font-semibold ${tag.color}`}>{tag.icon} {tag.label}</span>
                      )}
                      {r.leadScore > 0 && (
                        <span className="text-xs text-muted-foreground">Score: <span className={`font-semibold ${r.leadScore >= 85 ? "text-orange-400" : r.leadScore >= 60 ? "text-green-400" : "text-muted-foreground"}`}>{r.leadScore}</span></span>
                      )}
                      {r.billingStatus === "N" && (
                        <span className="text-xs font-semibold text-green-400">No subscriber</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {r.maxDownloadMbps && (
                      <span className="text-xs text-sky-400 font-mono">
                        {r.maxDownloadMbps >= 1000 ? (r.maxDownloadMbps / 1000).toFixed(0) + "G" : r.maxDownloadMbps + "M"}
                      </span>
                    )}
                    {r.fiberAvailable && <Wifi className="w-3.5 h-3.5 text-green-400" />}
                    {r.isNewFiber && <Zap className="w-3.5 h-3.5 text-green-400" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4 pt-0 border-t border-border/50">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3 text-xs">
                      <div>
                        <div className="text-muted-foreground mb-1">Segment</div>
                        <div className="font-mono text-foreground">{r.householdSegmentType ?? "—"}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Subscriber</div>
                        <div className={`font-semibold ${r.billingStatus === "N" ? "text-green-400" : "text-foreground"}`}>
                          {r.billingStatus === "N" ? "Not subscribed — prime target" : r.billingStatus === "Y" ? "Active subscriber" : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Technology</div>
                        <div className="font-mono text-foreground">{r.techType ?? "—"} {r.chipSetType ? `/ ${r.chipSetType}` : ""}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground mb-1">Max Speed</div>
                        <div className="font-mono text-sky-400">{r.maxDownloadMbps ? `${r.maxDownloadMbps} Mbps` : "—"}</div>
                      </div>
                      {r.competitorName && (
                        <div>
                          <div className="text-muted-foreground mb-1">Competitor</div>
                          <div className="font-mono text-amber-400">{r.competitorName} {r.competitorSpeedMbps ? `${r.competitorSpeedMbps}M` : ""}</div>
                        </div>
                      )}
                      <div>
                        <div className="text-muted-foreground mb-1">Catalog Date</div>
                        <div className="font-mono text-foreground">{r.addressCatalogDate ?? "—"}</div>
                      </div>
                      {r.leadScore > 0 && (
                        <div>
                          <div className="text-muted-foreground mb-1">Lead Score</div>
                          <div className={`font-bold ${r.leadScore >= 85 ? "text-orange-400" : r.leadScore >= 60 ? "text-green-400" : "text-foreground"}`}>
                            {r.leadScore} / 100
                          </div>
                        </div>
                      )}
                    </div>
                    {r.notes && (
                      <div className="mt-3 text-xs text-muted-foreground border-t border-border/50 pt-2">{r.notes}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {done && results.length === 0 && (
        <Card className="bg-card border-border">
          <CardContent className="pt-8 pb-8 text-center">
            <CheckCircle className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Scan complete — no addresses returned results. Try a different city or check token status.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
