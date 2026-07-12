import { useState, useCallback, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";

// Backend base — empty string in dev, proxy path after deploy (rewritten by deploy_website)
const _API_BASE: string = ("__PORT_5000__" as string).startsWith("__") ? "" : ("__PORT_5000__" as string);
import { useToast } from "@/hooks/use-toast";
import {
  Radar, Play, Square, Wifi, CheckCircle,
  Zap, Download, RefreshCw,
  MapPin, Search, Globe, Flame,
  Activity, AlertCircle
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

const STATUS_CONFIG: Record<string, { label: string; dot: string; pill: string }> = {
  new_fiber:      { label: "New fiber",  dot: "bg-emerald-400", pill: "bg-emerald-500/15 text-emerald-400" },
  tenured_fiber:  { label: "Tenured",    dot: "bg-violet-400",  pill: "bg-violet-500/15 text-violet-400" },
  existing_fiber: { label: "Fiber",      dot: "bg-sky-400",     pill: "bg-sky-500/15 text-sky-400" },
  copper:         { label: "Copper/DSL", dot: "bg-amber-400",   pill: "bg-amber-500/15 text-amber-400" },
  no_service:     { label: "No service", dot: "bg-rose-400",    pill: "bg-rose-500/15 text-rose-400" },
  unknown:        { label: "Unknown",    dot: "bg-muted-foreground", pill: "bg-muted text-muted-foreground" },
};

const TAG_CONFIG: Record<string, { label: string; icon: string; color: string }> = {
  hot_lead:       { label: "HOT LEAD",       icon: "🔥", color: "bg-amber-500/15 text-amber-400" },
  coming_soon:    { label: "COMING SOON",     icon: "⏳", color: "bg-amber-500/15 text-amber-400" },
  upgrade_target: { label: "UPGRADE TARGET",  icon: "⬆️", color: "bg-sky-500/15 text-sky-400" },
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

  // Zero-Mapbox CNS discovery (get fresh leads for any indexed city, no geocoding)
  const [coverage, setCoverage] = useState<any>(null);
  const [discovery, setDiscovery] = useState<any>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState(false);
  const discPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  // Pure DB read — what does the CNS index know about this city? Zero proxy, zero Mapbox.
  const checkCoverage = useCallback(async () => {
    if (!cityInput.trim()) return;
    setCoverage(null); setDiscovery(null);
    try {
      const c = await (await apiRequest("GET", `/api/scan/city-cns-coverage?city=${encodeURIComponent(cityInput.trim())}&state=${encodeURIComponent(stateInput.trim())}`)).json();
      setCoverage(c);
    } catch (e: any) {
      toast({ title: "Coverage check failed", description: e.message, variant: "destructive" });
    }
  }, [cityInput, stateInput, toast]);

  // Launch a budgeted, zero-Mapbox discovery run against the city's CNS frontier.
  const startDiscovery = useCallback(async () => {
    if (!cityInput.trim()) return;
    setDiscoveryBusy(true); setDiscovery(null);
    if (discPollRef.current) clearInterval(discPollRef.current);
    try {
      const job = await (await apiRequest("POST", "/api/scan/discover-city", { city: cityInput.trim(), state: stateInput.trim(), budget: 750 })).json();
      setDiscovery(job);
      discPollRef.current = setInterval(async () => {
        try {
          const p = await (await apiRequest("GET", `/api/scan/discover-city/${job.id}`)).json();
          setDiscovery(p);
          if (p.done) {
            if (discPollRef.current) clearInterval(discPollRef.current);
            setDiscoveryBusy(false);
            qc.invalidateQueries({ queryKey: ["/api/leads"] });
            qc.invalidateQueries({ queryKey: ["/api/scan/pool-stats"] });
          }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e: any) {
      const msg = e?.message?.includes("NO_COVERAGE")
        ? "No CNS history for this city yet — run an ordinary scan or the nightly sweep there first (both feed the index for free)."
        : e.message;
      toast({ title: "Discovery not started", description: msg, variant: "destructive" });
      setDiscoveryBusy(false);
    }
  }, [cityInput, stateInput, toast, qc]);

  // Step 2: Run scan on pulled addresses
  const runScan = useCallback(async () => {
    stopAll();
    setScanning(true);
    setDone(false);
    setJobStatus(null);
    setJobId(null);

    try {
      // Send ONLY the city — never the full address array. A whole city is
      // thousands of addresses (>>64 KB), which the API body limit rejects as
      // "request too large" (413). The Pull step already cached them to the
      // address pool, so the server re-reads the identical set instantly and
      // streams it to Kinetic. (OSM in → pool → Kinetic, exactly as intended.)
      const body: any = { city: cityInput.trim(), state: stateInput.trim() };

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
  }, [stopAll, connectSseStream, toast, cityInput, stateInput]);

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
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Radar className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold tracking-tight text-foreground">City Scanner</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Type any city in the USA — pulls all addresses via Overpass, then scans each live against Kinetic. Hot Leads saved automatically.
          </p>
        </div>
        {scanning && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-primary">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> Scanning live
          </span>
        )}
      </div>

      {/* Address-pool metric strip */}
      {poolStats && poolStats.total > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border">
            <div className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pool stored</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{poolStats.total.toLocaleString()}</div>
            </div>
            <div className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Scanned</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{poolStats.scanned.toLocaleString()}</div>
            </div>
            <div className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Never scanned</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-foreground">{poolStats.neverScanned.toLocaleString()}</div>
            </div>
            <div className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">New fiber found</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-primary">{poolStats.newFiber.toLocaleString()}</div>
            </div>
          </div>
        </div>
      )}

      {/* City search */}
      <Card className="bg-card border-border rounded-xl">
        <CardContent className="pt-5 pb-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Globe className="w-4 h-4 text-primary" />
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Step 1</span>
              <span className="text-sm font-semibold tracking-tight text-foreground">Select City</span>
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5 block">City Name</label>
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
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5 block">State</label>
                <select
                  data-testid="select-state"
                  value={stateInput}
                  onChange={e => setStateInput(e.target.value)}
                  disabled={scanning}
                  className="w-full h-9 px-2 bg-background border border-border rounded-md text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
              <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3">
                <MapPin className="w-4 h-4 text-primary flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-semibold tabular-nums text-foreground">{overpassResult.count.toLocaleString()} addresses</span>
                  <span className="text-xs text-muted-foreground ml-2">in {overpassResult.cityName}</span>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Ready to scan
                </span>
                {/* No static-map preview: it was a billable Mapbox Static Images
                    request (with a hardcoded token) for pure decoration. The scan
                    results land on the Field Map anyway. */}
              </div>
            )}

            {/* ── Zero-Mapbox discovery — find fresh leads from Kinetic's own index ── */}
            <div className="rounded-xl border border-border bg-secondary/30 p-4 space-y-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Flame className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold tracking-tight text-foreground">Discover fresh</span>
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">no Mapbox</span>
                <span className="text-[11px] text-muted-foreground ml-auto">probes Kinetic's CNS frontier directly</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Targets the control-number bands where this city already lives (learned for free from past scans) and checks the frontier for brand-new builds. Zero geocoding.
              </p>
              <div className="flex gap-2 flex-wrap">
                <Button data-testid="button-check-coverage" onClick={checkCoverage} disabled={!cityInput.trim() || discoveryBusy} variant="outline" size="sm" className="gap-2">
                  <Search className="w-3.5 h-3.5" /> Check coverage
                </Button>
                <Button data-testid="button-discover-city" onClick={startDiscovery} disabled={!cityInput.trim() || discoveryBusy || (coverage && coverage.needsAnchor)} size="sm" className="gap-2">
                  {discoveryBusy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                  {discoveryBusy ? "Discovering…" : "Discover (no Mapbox)"}
                </Button>
              </div>
              {coverage && (
                <div className="text-xs text-muted-foreground">
                  {coverage.needsAnchor
                    ? <span className="text-amber-400">No CNS history yet — run an ordinary scan or the nightly sweep here first (both feed the index for free).</span>
                    : <span className="tabular-nums"><b className="text-foreground">{coverage.knownAddresses?.toLocaleString()}</b> known · <b className="text-foreground">{coverage.cnsBands}</b> band(s) · ENV {coverage.env} · ~{coverage.suggestedProbes?.toLocaleString()} probe candidates</span>}
                </div>
              )}
              {discovery && (
                <div className="rounded-lg bg-background/60 border border-border p-3 text-xs space-y-1.5 tabular-nums">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Probed <b className="text-foreground">{discovery.probed ?? 0}</b>/{discovery.planned ?? 0}</span>
                    <span className="text-amber-400 font-semibold">{discovery.newFiber ?? 0} new fiber · {discovery.leadsCreated ?? 0} lead(s)</span>
                  </div>
                  <div className="text-muted-foreground">In {cityInput}: <b className="text-foreground">{discovery.sameCityHits ?? 0}</b> · pool +{discovery.poolAdded ?? 0} · failures {discovery.failures ?? 0}</div>
                  {discovery.reason && <div className="text-[11px] text-muted-foreground/80 pt-1.5 border-t border-border">{discovery.reason}</div>}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Scan control */}
      <Card className="bg-card border-border rounded-xl">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-2 mb-4">
            <Radar className="w-4 h-4 text-primary" />
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Step 2</span>
            <span className="text-sm font-semibold tracking-tight text-foreground">Run Kinetic Scan</span>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="min-w-0">
              {overpassResult
                ? <p className="text-sm text-foreground tabular-nums">{overpassResult.count.toLocaleString()} addresses in <span className="font-semibold">{cityInput}, {stateInput}</span></p>
                : <p className="text-sm text-muted-foreground">Pull addresses first, or scan will use built-in Rockwell list</p>
              }
              {scanning && checkedCount > 0 && (
                <p className="text-xs text-muted-foreground mt-1 font-mono truncate max-w-[280px]">→ {currentAddr}</p>
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
            <div className="mt-5 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground tabular-nums">{checkedCount.toLocaleString()} / {total.toLocaleString()} scanned</span>
                <span className="font-mono font-semibold text-primary tabular-nums">{pct}%</span>
              </div>
              <Progress value={pct} className="h-2" />
              {scanning && currentAddr && (
                <p className="text-xs text-muted-foreground font-mono truncate">⟶ {currentAddr}</p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Live worker stats — shown while scanning */}
      {scanning && scannerState && (
        <Card className="bg-card border-border rounded-xl">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 mb-4">
              <Activity className={`w-4 h-4 ${scannerState.isStuck ? "text-rose-400" : "text-primary animate-pulse"}`} />
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Worker State</span>
              {scannerState.isStuck ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-400">
                  <AlertCircle className="w-3 h-3" /> Stuck — no heartbeat {scannerState.secondsSinceHeartbeat}s
                </span>
              ) : scannerState.isRunning && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> Running
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border border-y border-border">
              <div className="px-4 py-3">
                <div className="text-lg font-semibold font-mono tabular-nums text-primary">{scannerState.checksPerSec.toFixed(1)}</div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">checks/sec</div>
              </div>
              <div className="px-4 py-3">
                <div className="text-lg font-semibold font-mono tabular-nums text-foreground">{scannerState.concurrency}</div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">in-flight</div>
              </div>
              <div className="px-4 py-3">
                <div className="text-lg font-semibold font-mono tabular-nums text-emerald-400">{scannerState.diagNewFiber}</div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">new fiber</div>
              </div>
              <div className="px-4 py-3">
                <div className={`text-lg font-semibold font-mono tabular-nums ${scannerState.diagHttpError > 0 ? "text-rose-400" : "text-muted-foreground"}`}>
                  {scannerState.diagHttpError}
                </div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">errors</div>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">{scannerState.totalChecked.toLocaleString()} total checks this session</span>
              <span className="font-mono tabular-nums">max {scannerState.maxInFlight} concurrent</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary metric strip */}
      {summary && (
        <div className="rounded-xl border border-border bg-card">
          <div className={`grid ${hotLeads > 0 ? "grid-cols-2 md:grid-cols-5" : "grid-cols-2 md:grid-cols-4"} divide-x divide-border`}>
            <div className="p-4">
              <div className="text-2xl font-semibold tracking-tight tabular-nums text-emerald-400">{summary.new_fiber}</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">New fiber</div>
            </div>
            {hotLeads > 0 && (
              <div className="p-4">
                <div className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight tabular-nums text-amber-400">
                  <Flame className="w-5 h-5" />{hotLeads}
                </div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">Hot leads</div>
              </div>
            )}
            <div className="p-4">
              <div className="text-2xl font-semibold tracking-tight tabular-nums text-violet-400">{summary.tenured_fiber}</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">Tenured</div>
            </div>
            <div className="p-4">
              <div className="text-2xl font-semibold tracking-tight tabular-nums text-amber-400">{summary.copper}</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">Copper/DSL</div>
            </div>
            <div className="p-4">
              <div className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">{summary.scanned}</div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">Scanned</div>
            </div>
          </div>
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
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  filter === f
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-border hover:border-primary/50 hover:text-foreground"
                }`}
              >
                {cfg && <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />}
                {f === "all" ? "All" : cfg?.label} <span className="tabular-nums opacity-70">({count})</span>
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
                className="rounded-xl border border-border bg-card transition-colors cursor-pointer hover:border-primary/40"
                onClick={() => setExpandedIdx(isExpanded ? null : i)}
              >
                <div className="px-4 py-3 flex items-center gap-3">
                  <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot} ${r.isNewFiber ? "shadow-[0_0_8px_currentColor] animate-pulse" : ""}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">{r.address}</span>
                      <span className="text-xs text-muted-foreground">{r.city}, {r.state} {r.zip}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cfg.pill}`}>{cfg.label}</span>
                      {tag && (
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${tag.color}`}>{tag.icon} {tag.label}</span>
                      )}
                      {r.leadScore > 0 && (
                        <span className="text-xs text-muted-foreground">Score: <span className={`font-semibold tabular-nums ${r.leadScore >= 85 ? "text-amber-400" : r.leadScore >= 60 ? "text-emerald-400" : "text-muted-foreground"}`}>{r.leadScore}</span></span>
                      )}
                      {r.billingStatus === "N" && (
                        <span className="text-xs font-semibold text-emerald-400">No subscriber</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {r.maxDownloadMbps && (
                      <span className="text-xs text-sky-400 font-mono tabular-nums">
                        {r.maxDownloadMbps >= 1000 ? (r.maxDownloadMbps / 1000).toFixed(0) + "G" : r.maxDownloadMbps + "M"}
                      </span>
                    )}
                    {r.fiberAvailable && <Wifi className="w-3.5 h-3.5 text-emerald-400" />}
                    {r.isNewFiber && <Zap className="w-3.5 h-3.5 text-emerald-400" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="px-4 pb-4 pt-0 border-t border-border">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3 text-xs">
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Segment</div>
                        <div className="font-mono text-foreground">{r.householdSegmentType ?? "—"}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Subscriber</div>
                        <div className={`font-semibold ${r.billingStatus === "N" ? "text-emerald-400" : "text-foreground"}`}>
                          {r.billingStatus === "N" ? "Not subscribed — prime target" : r.billingStatus === "Y" ? "Active subscriber" : "—"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Technology</div>
                        <div className="font-mono text-foreground">{r.techType ?? "—"} {r.chipSetType ? `/ ${r.chipSetType}` : ""}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Max Speed</div>
                        <div className="font-mono text-sky-400 tabular-nums">{r.maxDownloadMbps ? `${r.maxDownloadMbps} Mbps` : "—"}</div>
                      </div>
                      {r.competitorName && (
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Competitor</div>
                          <div className="font-mono text-amber-400">{r.competitorName} {r.competitorSpeedMbps ? `${r.competitorSpeedMbps}M` : ""}</div>
                        </div>
                      )}
                      <div>
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Catalog Date</div>
                        <div className="font-mono text-foreground">{r.addressCatalogDate ?? "—"}</div>
                      </div>
                      {r.leadScore > 0 && (
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Lead Score</div>
                          <div className={`font-bold tabular-nums ${r.leadScore >= 85 ? "text-amber-400" : r.leadScore >= 60 ? "text-emerald-400" : "text-foreground"}`}>
                            {r.leadScore} / 100
                          </div>
                        </div>
                      )}
                    </div>
                    {r.notes && (
                      <div className="mt-3 text-xs text-muted-foreground border-t border-border pt-2">{r.notes}</div>
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
        <Card className="bg-card border-border rounded-xl">
          <CardContent className="pt-10 pb-10 text-center">
            <CheckCircle className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Scan complete — no addresses returned results. Try a different city or check token status.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
