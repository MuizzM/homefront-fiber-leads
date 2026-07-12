import { useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  ScanSearch, Play, Square, PauseCircle, PlayCircle, Trash2,
  Zap, Globe, RefreshCw, AlertTriangle, KeyRound,
  Activity, ChevronDown, ChevronUp, MapPin, Download
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

// Resolve backend base URL (empty string in dev, proxied path after deploy)
const API_BASE_URL: string = ("__PORT_5000__" as string).startsWith("__") ? "" : "__PORT_5000__";

// ── Types ─────────────────────────────────────────────────────────────────────
interface KineticEnv {
  code: string; label: string; states: string; upperLimit: number;
}

interface CnsResult {
  env: string; cns: number; dfAddressId: string;
  address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null;
  householdSegmentType: string | null;
  isNewFiber: boolean;
  techType: string | null; speedTier: string | null; maxDownloadMbps: number | null;
  billingStatus: string | null; addressCatalogDate: string | null;
  competitorName: string | null; discoveredAt: string;
}

interface CnsJob {
  id: string; env: string; envLabel: string;
  startCns: number; endCns: number; currentCns: number;
  status: "running" | "paused" | "done" | "stopped" | "error";
  scanned: number; hits: number; newFiberHits: number;
  ratePerMin: number; estimatedMinutes?: number;
  startedAt: string; completedAt?: string; lastError?: string;
}

interface CnsJobDetail extends CnsJob {
  found: CnsResult[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function statusStyle(s: string): { pill: string; dot: string } {
  const map: Record<string, { pill: string; dot: string }> = {
    running: { pill: "bg-primary/15 text-primary",                dot: "bg-primary" },
    paused:  { pill: "bg-amber-500/15 text-amber-400",           dot: "bg-amber-400" },
    done:    { pill: "bg-sky-500/15 text-sky-400",               dot: "bg-sky-400" },
    stopped: { pill: "bg-muted text-muted-foreground",           dot: "bg-muted-foreground" },
    error:   { pill: "bg-rose-500/15 text-rose-400",             dot: "bg-rose-400" },
  };
  return map[s] ?? map.stopped;
}

function fmtEta(min?: number) {
  if (min == null || min < 0) return "—";
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

function fmtCns(n: number) {
  return n.toLocaleString();
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function CnsScanner() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // ── Form state ───────────────────────────────────────────────────────────────
  const [selectedEnv, setSelectedEnv] = useState("MS");
  const [startCns, setStartCns] = useState("1");
  const [endCns, setEndCns] = useState("10000");

  // ── Jobs list (from API, polled) ─────────────────────────────────────────────
  const { data: jobs = [], refetch: refetchJobs } = useQuery<CnsJob[]>({
    queryKey: ["/api/cns/jobs"],
    // Poll fast only while a job is actually in flight; idle when nothing runs.
    refetchInterval: (q) => (Array.isArray(q.state.data) && q.state.data.some((j: any) => j.status === "running" || j.status === "queued")) ? 3000 : 15000,
  });

  // ── ENV list ─────────────────────────────────────────────────────────────────
  const { data: envs = [] } = useQuery<KineticEnv[]>({
    queryKey: ["/api/cns/envs"],
  });

  // ── Token status ─────────────────────────────────────────────────────────────
  const { data: tokenStatus } = useQuery<{ hasToken: boolean; expiresIn: number | null }>({
    queryKey: ["/api/token-status"],
  });
  const tokenOk = tokenStatus?.hasToken && (tokenStatus.expiresIn ?? 0) > 60;

  // ── Active job SSE stream ─────────────────────────────────────────────────────
  const [streamJobId, setStreamJobId] = useState<string | null>(null);
  const [streamResults, setStreamResults] = useState<CnsResult[]>([]);
  const [, setStreamProgress] = useState<Partial<CnsJob> | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const connectStream = useCallback((jobId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }
    setStreamJobId(jobId);
    setStreamResults([]);

    // Build the SSE URL with auth header via fetch is not possible — SSE doesn't support headers
    // Instead, we use a query parameter approach: the session token is passed in URL
    // The server validates it via x-session-id normally, but for SSE we'll use polling fallback
    // Actually: we just poll the /api/cns/jobs/:id endpoint every 2s for the stream view
    // and use the SSE endpoint for progress events only (progress events don't need full auth in URL)
    // The proper SSE solution: open it and the server validates the x-session-id cookie/header
    // Since EventSource can't set headers, we instead poll for results and use SSE for progress
    // via a small helper that uses fetch with ReadableStream
    startFetchStream(jobId);
  }, []);

  const startFetchStream = useCallback(async (jobId: string) => {
    try {
      const sessionId = getStoredSessionId() ?? (window as any).__sessionId ?? "";

      const resp = await fetch(`${API_BASE_URL}/api/cns/jobs/${jobId}/stream`, {
        headers: {
          "x-session-id": sessionId,
          "x-csrf-token": sessionId, // CSRF token = session ID in this app
        },
      });

      if (!resp.ok || !resp.body) return;

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            try {
              const payload = JSON.parse(line.slice(5).trim());
              if (eventType === "result") {
                setStreamResults(prev => [...prev, payload]);
              } else if (eventType === "progress") {
                setStreamProgress(payload);
                refetchJobs();
              } else if (eventType === "done") {
                qc.invalidateQueries({ queryKey: ["/api/leads"] });
                refetchJobs();
              }
            } catch {}
            eventType = "";
          }
        }
      }
    } catch (e) {
      // SSE failed — fall back to polling for results
    }
  }, [qc, refetchJobs]);

  // ── Start scan ───────────────────────────────────────────────────────────────
  const [starting, setStarting] = useState(false);

  const handleStart = useCallback(async () => {
    if (!tokenOk) {
      toast({ title: "API token required", description: "Set your token first.", variant: "destructive" });
      return;
    }
    const start = parseInt(startCns, 10);
    const end   = parseInt(endCns, 10);
    if (isNaN(start) || isNaN(end) || start >= end) {
      toast({ title: "Invalid range", description: "Start CNS must be less than end CNS.", variant: "destructive" });
      return;
    }
    setStarting(true);
    try {
      const job: CnsJobDetail = await (await apiRequest("POST", "/api/cns/jobs", {
        env: selectedEnv, startCns: start, endCns: end,
      })).json();
      toast({ title: "CNS scan started", description: `${selectedEnv} · CNS ${fmtCns(start)}–${fmtCns(end)}` });
      refetchJobs();
      connectStream(job.id);
    } catch (e: any) {
      toast({ title: "Failed to start", description: e.message, variant: "destructive" });
    } finally {
      setStarting(false);
    }
  }, [selectedEnv, startCns, endCns, tokenOk, toast, refetchJobs, connectStream]);

  // ── Job controls ─────────────────────────────────────────────────────────────
  const handleStop = useCallback(async (jobId: string) => {
    await apiRequest("POST", `/api/cns/jobs/${jobId}/stop`);
    refetchJobs();
  }, [refetchJobs]);

  const handlePause = useCallback(async (jobId: string) => {
    await apiRequest("POST", `/api/cns/jobs/${jobId}/pause`);
    refetchJobs();
  }, [refetchJobs]);

  const handleResume = useCallback(async (jobId: string) => {
    await apiRequest("POST", `/api/cns/jobs/${jobId}/resume`);
    refetchJobs();
  }, [refetchJobs]);

  const handleDelete = useCallback(async (jobId: string) => {
    await apiRequest("DELETE", `/api/cns/jobs/${jobId}`);
    if (streamJobId === jobId) {
      setStreamJobId(null);
      setStreamResults([]);
      setStreamProgress(null);
    }
    refetchJobs();
  }, [refetchJobs, streamJobId]);

  // ── Load results for a job ───────────────────────────────────────────────────
  const [viewJobId, setViewJobId] = useState<string | null>(null);
  const { data: viewJob } = useQuery<CnsJobDetail>({
    queryKey: ["/api/cns/jobs", viewJobId],
    queryFn: async () => (await apiRequest("GET", `/api/cns/jobs/${viewJobId}`)).json(),
    enabled: !!viewJobId,
    refetchInterval: viewJobId ? 3000 : false,
  });

  const displayedResults = viewJobId === streamJobId
    ? streamResults
    : (viewJob?.found ?? []);

  const newFiberResults = displayedResults.filter(r => r.isNewFiber);

  // ── CSV export ───────────────────────────────────────────────────────────────
  const exportCSV = useCallback(() => {
    const header = "ENV,CNS,dfAddressId,Address,City,State,ZIP,Lat,Lng,Segment,isNewFiber,Tech,Speed,billingStatus,CatalogDate,Competitor,DiscoveredAt";
    const rows = displayedResults.map(r =>
      `"${r.env}","${r.cns}","${r.dfAddressId}","${r.address}","${r.city}","${r.state}","${r.zip}","${r.lat ?? ""}","${r.lng ?? ""}","${r.householdSegmentType ?? ""}","${r.isNewFiber}","${r.techType ?? ""}","${r.maxDownloadMbps ?? ""}","${r.billingStatus ?? ""}","${r.addressCatalogDate ?? ""}","${r.competitorName ?? ""}","${r.discoveredAt}"`
    );
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cns_scan_${viewJobId ?? "results"}.csv`;
    a.click();
  }, [displayedResults, viewJobId]);

  const selectedEnvInfo = envs.find(e => e.code === selectedEnv);
  const rangeSize = Math.max(0, (parseInt(endCns) || 0) - (parseInt(startCns) || 0));

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Token warning */}
      {!tokenOk && (
        <div className="flex items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
          <AlertTriangle className="w-5 h-5 text-rose-400 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-rose-400">API token required for CNS scanning</p>
            <p className="text-xs text-muted-foreground mt-0.5">Paste a valid Kinetic token in Token Setup before running scans.</p>
          </div>
          <a href="#/token"
            className="flex items-center gap-1.5 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-400 text-xs font-semibold px-3 py-1.5 transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/50">
            <KeyRound className="w-3.5 h-3.5" /> Set Token
          </a>
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <ScanSearch className="w-5 h-5 text-primary" />
          CNS Scanner
        </h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
          Brute-force scan Kinetic control numbers to discover new fiber builds before anyone else.
          Finds NEW FIBER addresses directly by their internal address ID — works across all markets.
        </p>
      </div>

      {/* How it works — calm reference row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-4 rounded-xl border border-border bg-card p-5">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">What is a CNS?</div>
          <p className="text-xs text-muted-foreground">
            Every address in Kinetic's network has an internal ID: <span className="font-mono text-foreground">ENV + 7-digit control number</span>.
            e.g. <span className="font-mono text-emerald-400">MS0012345</span>
          </p>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">How we find new fiber</div>
          <p className="text-xs text-muted-foreground">
            We iterate CNS values sequentially. When the API returns
            <span className="font-mono text-emerald-400 mx-1">householdSegmentType = "NEW FIBER"</span>
            that address just entered the Kinetic network — it's a brand-new build.
          </p>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">What happens to hits</div>
          <p className="text-xs text-muted-foreground">
            Every NEW FIBER address is auto-saved as a lead in Lead Management.
            TENURED and other segment types are shown in results but not saved.
          </p>
        </div>
      </div>

      {/* Start new scan — config console */}
      <Card className="bg-card border-border rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold tracking-tight flex items-center gap-2">
            <Globe className="w-4 h-4 text-primary" />
            Start New CNS Scan
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* ENV selector */}
            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Region (ENV)</label>
              <Select value={selectedEnv} onValueChange={setSelectedEnv}>
                <SelectTrigger data-testid="select-env" className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {envs.map(e => (
                    <SelectItem key={e.code} value={e.code}>
                      <span className="font-mono font-bold text-primary mr-2">{e.code}</span>
                      <span className="text-muted-foreground text-xs">{e.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedEnvInfo && (
                <div className="text-xs text-muted-foreground tabular-nums">
                  {selectedEnvInfo.states} · up to {fmtCns(selectedEnvInfo.upperLimit)} addresses
                </div>
              )}
            </div>

            {/* Start CNS */}
            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Start CNS</label>
              <Input
                type="number"
                value={startCns}
                onChange={e => setStartCns(e.target.value)}
                className="h-9 text-sm font-mono tabular-nums"
                data-testid="input-start-cns"
                min={1}
              />
            </div>

            {/* End CNS */}
            <div className="space-y-1.5">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground">End CNS</label>
              <Input
                type="number"
                value={endCns}
                onChange={e => setEndCns(e.target.value)}
                className="h-9 text-sm font-mono tabular-nums"
                data-testid="input-end-cns"
                min={2}
              />
              <div className="text-xs text-muted-foreground tabular-nums">
                Max 100,000 per job · {rangeSize.toLocaleString()} addresses
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <div className="text-xs text-muted-foreground">
              <span className="font-mono font-semibold text-foreground">{selectedEnv}</span>
              <span className="mx-1.5">·</span>
              <span className="tabular-nums">CNS {fmtCns(parseInt(startCns) || 0)} – {fmtCns(parseInt(endCns) || 0)}</span>
            </div>
            <Button
              onClick={handleStart}
              disabled={starting || !tokenOk}
              size="lg"
              className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
              data-testid="btn-start-cns"
            >
              {starting ? (
                <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Starting…</>
              ) : (
                <><Play className="w-4 h-4 mr-2" /> Start Scan</>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active Jobs */}
      {jobs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-[11px] uppercase tracking-wide text-muted-foreground">Scan Jobs</h2>
          {jobs.map(job => {
            const isStreaming = streamJobId === job.id;
            const isOpen = viewJobId === job.id;
            const st = statusStyle(job.status);
            const pct = job.endCns > job.startCns
              ? Math.round(((job.currentCns - job.startCns) / (job.endCns - job.startCns)) * 100)
              : 0;

            const metrics: { label: string; value: string; accent?: boolean }[] = [
              { label: "Current CNS", value: fmtCns(job.currentCns) },
              { label: "Scanned",     value: job.scanned.toLocaleString() },
              { label: "Rate",        value: `${job.ratePerMin}/min` },
              { label: "Found",       value: job.hits.toLocaleString() },
              { label: "New Fiber",   value: job.newFiberHits.toLocaleString(), accent: true },
              { label: "ETA",         value: fmtEta(job.estimatedMinutes) },
            ];

            return (
              <Card key={job.id} className={`rounded-xl border transition-colors ${
                isStreaming ? "border-primary/40 bg-primary/[0.03]" : "border-border bg-card"
              }`}>
                <CardContent className="pt-4 pb-4">
                  {/* Header row */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${st.pill}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${st.dot} ${job.status === "running" ? "animate-pulse" : ""}`} />
                      {job.status}
                    </span>
                    <span className="font-mono text-sm font-bold text-foreground">
                      {job.env}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {fmtCns(job.startCns)} → {fmtCns(job.endCns)}
                    </span>
                    <span className="text-xs text-muted-foreground">{job.envLabel}</span>

                    <div className="ml-auto flex items-center gap-2">
                      {/* New fiber badge */}
                      {job.newFiberHits > 0 && (
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-semibold tabular-nums">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                          {job.newFiberHits} new fiber
                        </span>
                      )}

                      {/* Controls */}
                      {job.status === "running" && (
                        <>
                          <Button size="sm" variant="outline" className="h-7 text-xs px-2"
                            onClick={() => handlePause(job.id)} data-testid={`btn-pause-${job.id}`}>
                            <PauseCircle className="w-3.5 h-3.5 mr-1" /> Pause
                          </Button>
                          <Button size="sm" variant="outline"
                            className="h-7 text-xs px-2 border-rose-500/50 text-rose-400 hover:bg-rose-500/10"
                            onClick={() => handleStop(job.id)} data-testid={`btn-stop-${job.id}`}>
                            <Square className="w-3.5 h-3.5 mr-1" /> Stop
                          </Button>
                        </>
                      )}
                      {job.status === "paused" && (
                        <Button size="sm" variant="outline" className="h-7 text-xs px-2 border-emerald-500/50 text-emerald-400 hover:bg-emerald-500/10"
                          onClick={() => handleResume(job.id)} data-testid={`btn-resume-${job.id}`}>
                          <PlayCircle className="w-3.5 h-3.5 mr-1" /> Resume
                        </Button>
                      )}
                      {(job.status === "done" || job.status === "stopped" || job.status === "error") && (
                        <Button size="sm" variant="ghost" className="h-7 text-xs px-2 text-muted-foreground"
                          onClick={() => handleDelete(job.id)} data-testid={`btn-delete-${job.id}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      <Button size="sm" variant={isOpen ? "default" : "outline"}
                        className="h-7 text-xs px-2"
                        onClick={() => {
                          setViewJobId(isOpen ? null : job.id);
                          if (!isOpen && job.status === "running") {
                            connectStream(job.id);
                          }
                        }}
                        data-testid={`btn-view-${job.id}`}>
                        {isOpen ? <ChevronUp className="w-3.5 h-3.5 mr-1" /> : <ChevronDown className="w-3.5 h-3.5 mr-1" />}
                        Results
                      </Button>
                    </div>
                  </div>

                  {/* Metric strip — hairline divided */}
                  <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px rounded-lg overflow-hidden border border-border bg-border">
                    {metrics.map(m => (
                      <div key={m.label} className="bg-card px-3 py-2">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{m.label}</div>
                        <div className={`text-sm font-semibold tabular-nums ${m.accent ? "text-emerald-400" : "text-foreground"}`}>
                          {m.value}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Progress bar */}
                  <div className="mt-4 space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        {job.status === "running" && <Activity className="w-3 h-3 animate-pulse text-primary" />}
                        <span className="tabular-nums">{job.hits} in fabric</span>
                        <span className="text-emerald-400 font-semibold tabular-nums">· {job.newFiberHits} saved as leads</span>
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {pct}% · ETA {fmtEta(job.estimatedMinutes)}
                      </span>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                    {job.lastError && (
                      <div className="text-xs text-rose-400 bg-rose-500/10 rounded-lg px-2 py-1 mt-1">
                        {job.lastError}
                      </div>
                    )}
                  </div>

                  {/* Results panel */}
                  {isOpen && (
                    <div className="mt-4 border-t border-border pt-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-muted-foreground tabular-nums">
                          Showing {displayedResults.length} addresses found in Kinetic fabric
                          {newFiberResults.length > 0 && (
                            <span className="ml-2 text-emerald-400 font-semibold">
                              ({newFiberResults.length} NEW FIBER)
                            </span>
                          )}
                        </div>
                        {displayedResults.length > 0 && (
                          <Button size="sm" variant="outline" className="h-7 text-xs px-2"
                            onClick={exportCSV} data-testid="btn-export-cns">
                            <Download className="w-3 h-3 mr-1" /> CSV
                          </Button>
                        )}
                      </div>

                      {displayedResults.length === 0 ? (
                        <div className="text-xs text-muted-foreground text-center py-6">
                          {job.status === "running" ? "Scanning… results will appear here as they're found." : "No addresses found in this range."}
                        </div>
                      ) : (
                        <div className="space-y-1 max-h-96 overflow-y-auto">
                          {displayedResults.map((r, i) => (
                            <div key={i}
                              className={`rounded-lg border text-xs px-3 py-2 flex items-center gap-2.5 ${
                                r.isNewFiber
                                  ? "border-emerald-500/30 bg-emerald-500/[0.06]"
                                  : "border-border bg-card"
                              }`}
                              data-testid={`cns-result-${i}`}
                            >
                              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${r.isNewFiber ? "bg-emerald-400" : "bg-muted-foreground"}`} />

                              <span className="font-mono text-muted-foreground text-[10px] w-14 flex-shrink-0 tabular-nums">
                                {r.dfAddressId}
                              </span>

                              <span className="font-medium text-foreground flex-1 min-w-0 truncate">
                                {r.address}, {r.city}, {r.state} {r.zip}
                              </span>

                              {r.householdSegmentType && (
                                <span className={`px-1.5 py-0.5 rounded font-mono font-bold text-[10px] flex-shrink-0 ${
                                  r.isNewFiber
                                    ? "bg-emerald-500/15 text-emerald-400"
                                    : "bg-muted text-muted-foreground"
                                }`}>
                                  {r.householdSegmentType}
                                </span>
                              )}

                              {r.maxDownloadMbps && (
                                <span className="text-muted-foreground flex items-center gap-0.5 flex-shrink-0 tabular-nums">
                                  <Zap className="w-3 h-3 text-primary" />
                                  {r.maxDownloadMbps >= 1000
                                    ? `${r.maxDownloadMbps / 1000}G`
                                    : `${r.maxDownloadMbps}M`}
                                </span>
                              )}

                              {r.lat && r.lng && (
                                <MapPin className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              )}

                              {r.isNewFiber && (
                                <span className="text-emerald-400 font-bold text-[10px] flex-shrink-0">SAVED</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {jobs.length === 0 && (
        <Card className="bg-card border-border border-dashed rounded-xl">
          <CardContent className="py-12 text-center">
            <ScanSearch className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-30" />
            <div className="text-sm text-muted-foreground mb-1">No CNS scans yet</div>
            <div className="text-xs text-muted-foreground max-w-sm mx-auto">
              Select a region and CNS range above to discover new fiber builds.
              Start with a small range (1–10,000) to test, then scale up.
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
