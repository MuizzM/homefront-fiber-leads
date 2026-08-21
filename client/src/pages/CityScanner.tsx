import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";

// Backend base — empty string in dev, proxy path after deploy (rewritten by deploy_website)
const _API_BASE: string = ("__PORT_5000__" as string).startsWith("__") ? "" : ("__PORT_5000__" as string);
import { useToast } from "@/hooks/use-toast";
import { RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import type { FreshFiberVerdict } from "@shared/freshFiberVerdict";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ScanRow {
  address: string; city: string; state: string; zip: string;
  fiberStatus: string;
  isNewFiber: boolean; fiberAvailable: boolean;
  billingStatus?: string | null;
  apiSource?: string | null;
  blocked?: boolean | null;
  lat: number | null; lng: number | null;
  freshFiberVerdict?: FreshFiberVerdict;
  isFreshFiber?: boolean | null;
  verdictLabel?: string;
  verdictMessage?: string;
  confirmation?: "cross_verified" | "single_source_provisional" | "baseline_available" | "not_fresh" | "inconclusive";
}

interface ScanJobStatus {
  id: string; city: string; zip: string;
  status: "running" | "done" | "error";
  total: number; done: number;
  resultCount?: number;
  results: ScanRow[];
  summary: {
    new_fiber: number; tenured_fiber: number; existing_fiber: number;
    copper: number; no_service: number; unknown: number;
    fresh: number; not_fresh: number; unverified: number;
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

const VERDICT_CONFIG: Record<FreshFiberVerdict, { answer: string; label: string; dot: string; pill: string }> = {
  fresh: { answer: "YES", label: "Fresh fiber", dot: "bg-emerald-400", pill: "bg-emerald-500/15 text-emerald-400 ring-emerald-500/25" },
  not_fresh: { answer: "NO", label: "Not fresh fiber", dot: "bg-slate-400", pill: "bg-slate-500/15 text-slate-300 ring-slate-500/25" },
  unverified: { answer: "RECHECK", label: "Couldn't verify", dot: "bg-amber-400", pill: "bg-amber-500/15 text-amber-400 ring-amber-500/25" },
};

type FilterKey = "all" | FreshFiberVerdict;

// Stable empty array so the no-job renders don't hand every memo a fresh []
// identity (same convention as MapView's EMPTY_PINS).
const EMPTY_RESULTS: ScanRow[] = [];

function verdictOf(row: ScanRow): FreshFiberVerdict {
  // Eligibility is server-authored. Older/malformed rows fail closed instead of
  // being reclassified from raw provider fields in the browser.
  return row.freshFiberVerdict ?? "unverified";
}

function emptySummary(total: number): ScanJobStatus["summary"] {
  return {
    fresh: 0, not_fresh: 0, unverified: 0,
    new_fiber: 0, tenured_fiber: 0, existing_fiber: 0,
    copper: 0, no_service: 0, unknown: 0,
    scanned: 0, remaining: total,
  };
}

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
  const [jobId, setJobId] = useState<string | null>(null);
  const [pullingAddresses, setPullingAddresses] = useState(false);
  const [overpassResult, setOverpassResult] = useState<OverpassResult | null>(null);

  // SSE stream ref
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const streamCursorRef = useRef(0);
  const reattachingJobRef = useRef<string | null>(null);
  const connectSseStreamRef = useRef<(id: string, since?: number) => Promise<void>>(async () => {});
  const { toast } = useToast();
  const qc = useQueryClient();

  // Keep a low-frequency idle heartbeat too. A city job runs on the server, so
  // closing/reloading this tab must not make an overnight scan look stopped.
  const { data: scannerState } = useQuery<{
    isRunning: boolean;
    checksPerSec: number;
    concurrency: number;
    maxInFlight: number;
    queueDepth: number;
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
    refetchInterval: scanning ? 3000 : 15000,
    enabled: true,
  });

  // Persistent address-pool stats (harvest-once, re-scan-for-free engine)
  const { data: poolStats } = useQuery<{ total: number; scanned: number; neverScanned: number; newFiber: number; lastScannedAt: string | null }>({
    queryKey: ["/api/scan/pool-stats"],
    queryFn: async () => (await apiRequest("GET", "/api/scan/pool-stats")).json(),
    // Pool counters only move during a scan — fast while scanning, slow when idle.
    refetchInterval: scanning ? 8000 : 60000,
  });

  const stopAll = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    activeJobIdRef.current = null;
  }, []);

  // Same as USAScanner: Scanners.tsx swaps these panels conditionally, so a tab
  // change unmounts this without any user-initiated stop. Tear the scan
  // plumbing down here or the poll and the SSE reader outlive the component.
  useEffect(() => stopAll, [stopAll]);

  // SSE stream connection — streams results in real time
  const connectSseStream = useCallback(async (id: string, since = streamCursorRef.current) => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const cursor = Math.max(0, Math.floor(Number(since) || 0));
    streamCursorRef.current = cursor;
    let reconnectAfterMs = 1500;
    // See USAScanner: the window.__sessionId fallback is gone deliberately.
    const sessionId = getStoredSessionId() ?? "";
    try {
      const resp = await fetch(`${_API_BASE}/api/scan/stream/${id}?since=${cursor}`, {
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
              toast({
                title: `${status.summary.fresh} fresh-fiber lead${status.summary.fresh === 1 ? "" : "s"} found`,
                description: status.summary.unverified > 0 ? `${status.summary.unverified} address${status.summary.unverified === 1 ? " needs" : "es need"} a recheck` : "Every address received a conclusive answer",
              });
            } else if (status.status === "error") {
              // A scan that terminates in 'error' server-side used to poll
              // forever, leaving the button stuck on "Scanning". Stop and say so.
              clearInterval(pollRef.current!); pollRef.current = null;
              setScanning(false);
              toast({ title: "The scan stopped early", description: "It hit an error before finishing. You can start it again.", variant: "destructive" });
            }
          } catch {}
        }, 1500);
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let eventType = "";

      // Result events are BATCHED per network chunk: a fast scan streams many
      // `result` lines in one read(), and appending them one-per-setState was
      // O(n) array copy × n events = O(n²) work across a run (plus a render per
      // address). One concat per chunk keeps the copy cost linear and the
      // render count at ~one per chunk.
      const resultBatch: ScanRow[] = [];
      const flushResults = () => {
        if (resultBatch.length === 0) return;
        const rows = resultBatch.splice(0);
        streamCursorRef.current += rows.length;
        setJobStatus(prev => prev ? { ...prev, results: prev.results.concat(rows) } : null);
      };

      // Exit when stopAll() aborts, not only when the server ends the stream.
      while (!ctrl.signal.aborted) {
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
                resultBatch.push(payload);
              } else if (eventType === "progress") {
                flushResults(); // keep results/summary ordering intact
                setJobStatus(prev => prev ? {
                  ...prev,
                  status: payload.status, done: payload.done, total: payload.total,
                  summary: payload.summary ?? prev.summary,
                } : null);
              } else if (eventType === "done") {
                flushResults(); // final GET below may fail — never drop streamed rows
                activeJobIdRef.current = null;
                setScanning(false); setDone(true);
                qc.invalidateQueries({ queryKey: ["/api/leads"] });
                qc.invalidateQueries({ queryKey: ["/api/stats"] });
                try {
                  const finalStatus: ScanJobStatus = await (await apiRequest("GET", `/api/scan/${id}`)).json();
                  setJobStatus(finalStatus);
                  toast({
                    title: `${finalStatus.summary.fresh} fresh-fiber lead${finalStatus.summary.fresh === 1 ? "" : "s"} found`,
                    description: finalStatus.summary.unverified > 0 ? `${finalStatus.summary.unverified} address${finalStatus.summary.unverified === 1 ? " needs" : "es need"} a recheck` : "Every address received a conclusive answer",
                  });
                } catch {}
              } else if (eventType === "reconnect") {
                reconnectAfterMs = Math.min(10_000, Math.max(500, Number(payload.reconnectAfterMs) || 1500));
              }
            } catch {}
            eventType = "";
          }
        }
        flushResults(); // one append (and ~one render) per network chunk
      }
    } catch (e: any) {
      if (e.name !== "AbortError") console.warn("SSE error:", e.message);
    }
    // Streams intentionally expire server-side to bound socket use. Resume from
    // the exact result cursor instead of replaying a whole city or silently
    // losing overnight updates. stopAll() clears the active id and this timer.
    if (!ctrl.signal.aborted && activeJobIdRef.current === id) {
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        if (activeJobIdRef.current === id) {
          void connectSseStreamRef.current(id, streamCursorRef.current);
        }
      }, reconnectAfterMs);
    }
  }, [qc, toast]);

  useEffect(() => {
    connectSseStreamRef.current = connectSseStream;
  }, [connectSseStream]);

  // Rehydrate the server-owned job after a reload/tab change. The status GET
  // supplies the historical rows once; the SSE `since` cursor then carries only
  // new rows, avoiding duplicate cards and O(total) replay on every reconnect.
  useEffect(() => {
    const active = scannerState?.activeJob;
    if (!active || scanning || jobId || reattachingJobRef.current === active.id) return;
    reattachingJobRef.current = active.id;
    let cancelled = false;
    void (async () => {
      try {
        const status: ScanJobStatus = await (await apiRequest("GET", `/api/scan/${active.id}`)).json();
        if (cancelled || status.status !== "running") return;
        const resultCount = Math.max(0, Number(status.resultCount ?? status.results.length) || 0);
        activeJobIdRef.current = active.id;
        streamCursorRef.current = resultCount;
        setJobId(active.id);
        setJobStatus(status);
        setScanning(true);
        setDone(false);
        const cityState = status.city.match(/^(.+),\s*([A-Z]{2})$/);
        if (cityState) { setCityInput(cityState[1]); setStateInput(cityState[2]); }
        toast({
          title: "Reconnected to active scan",
          description: `${status.city} · ${status.done.toLocaleString()} of ${status.total.toLocaleString()} checked`,
        });
        void connectSseStream(active.id, resultCount);
      } catch {
        // A job can finish between the state heartbeat and this GET. The next
        // idle heartbeat will discover whatever is still active.
      } finally {
        if (reattachingJobRef.current === active.id) reattachingJobRef.current = null;
      }
    })();
    return () => { cancelled = true; };
  }, [scannerState?.activeJob, scanning, jobId, connectSseStream, toast]);

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
        description: `${result.cityName} - ready to scan`,
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
      // Send ONLY the city — never the full address array. A whole city is
      // thousands of addresses (>>64 KB), which the API body limit rejects as
      // "request too large" (413). The Pull step already cached them to the
      // address pool, so the server re-reads the identical set instantly and
      // streams it to Kinetic. (OSM in → pool → Kinetic, exactly as intended.)
      const body: any = { city: cityInput.trim(), state: stateInput.trim() };

      const { jobId: newJobId, total, city: cityLabel } = await (await apiRequest("POST", "/api/scan/start-city", body)).json();
      activeJobIdRef.current = newJobId;
      streamCursorRef.current = 0;
      setJobId(newJobId);
      setJobStatus({
        id: newJobId, city: cityLabel, zip: "",
        status: "running", total, done: 0, results: [],
        summary: emptySummary(total),
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
      activeJobIdRef.current = data.jobId;
      streamCursorRef.current = 0;
      setJobId(data.jobId);
      setJobStatus({
        id: data.jobId, city: "Address pool re-scan", zip: "",
        status: "running", total: data.total, done: 0, results: [],
        summary: emptySummary(data.total),
      });
      toast({ title: "Pool re-scan started", description: `Re-checking ${Number(data.total).toLocaleString()} stored addresses - free, no geocoding` });
      connectSseStream(data.jobId);
    } catch (e: any) {
      setScanning(false);
      toast({ title: "Failed to start pool re-scan", description: e.message, variant: "destructive" });
    }
  }, [stopAll, connectSseStream, toast]);

  const results = jobStatus?.results ?? EMPTY_RESULTS;
  const summary = jobStatus?.summary;
  const total = jobStatus?.total ?? 0;
  const checkedCount = jobStatus?.done ?? 0;
  const pct = total ? Math.round((checkedCount / total) * 100) : 0;
  const currentAddr = results[checkedCount - 1]?.address ?? "";

  // Memoized: this used to be a bare filter().sort() in the render body, so
  // EVERY render — each SSE result batch, the 3s scanner-state poll, the 8s
  // pool-stats poll, any keystroke — re-sorted the whole result set (O(n log n)
  // localeCompare calls over up to tens of thousands of pool-re-scan rows).
  // Now it recomputes only when the results or the filter actually change.
  const filteredResults = useMemo(() => {
    const rank: Record<FreshFiberVerdict, number> = { fresh: 0, unverified: 1, not_fresh: 2 };
    return results
      .filter(r => filter === "all" || verdictOf(r) === filter)
      .sort((a, b) => rank[verdictOf(a)] - rank[verdictOf(b)] || a.address.localeCompare(b.address));
  }, [results, filter]);

  // One counting pass for the filter chips — they ran results.filter().length
  // per verdict per render (3 extra full passes each time anything re-rendered).
  const verdictCounts = useMemo(() => {
    const counts: Record<FreshFiberVerdict, number> = { fresh: 0, not_fresh: 0, unverified: 0 };
    for (const r of results) counts[verdictOf(r)]++;
    return counts;
  }, [results]);

  const exportCSV = useCallback(() => {
    const cell = (value: unknown) => {
      let text = String(value ?? "");
      // Neutralize spreadsheet formulas in exported provider/address text.
      if (/^[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const header = "Address,City,State,ZIP,Fresh Fiber,Verification";
    const rows = filteredResults.map(r => {
      const verdict = verdictOf(r);
      const cfg = VERDICT_CONFIG[verdict];
      return [r.address, r.city, r.state, r.zip, verdict === "fresh" ? "YES" : verdict === "not_fresh" ? "NO" : "RECHECK", cfg.label].map(cell).join(",");
    });
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `homefront_fiber_${cityInput.trim().toLowerCase()}_scan.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredResults, cityInput]);

  return (
    <div className="w-full max-w-5xl mx-auto p-4 pt-5 pb-24 space-y-5 md:p-6 md:space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            
            <h2 className="text-xl font-bold tracking-tight text-foreground">City Scanner</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Scan every address and get one sales answer: confirmed fresh, not fresh, or recheck. Only independently confirmed leads are saved.
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
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Primary matches</div>
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
              
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Step 1</span>
              <span className="text-sm font-semibold tracking-tight text-foreground">Select City</span>
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label htmlFor="city-scanner-city" className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5 block">City Name</label>
                <Input
                  id="city-scanner-city"
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
                <label htmlFor="city-scanner-state" className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5 block">State</label>
                <select
                  id="city-scanner-state"
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
                  {pullingAddresses ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                  {pullingAddresses ? "Pulling..." : "Pull Addresses"}
                </Button>
              </div>
            </div>

            {/* Overpass result */}
            {overpassResult && (
              <div className="flex items-center gap-3 rounded-xl border border-border bg-secondary/40 p-3">
                
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

          </div>
        </CardContent>
      </Card>

      {/* Scan control */}
      <Card className="bg-card border-border rounded-xl">
        <CardContent className="pt-5 pb-5">
          <div className="flex items-center gap-2 mb-4">
            
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
                <p className="text-xs text-muted-foreground mt-1 font-mono truncate max-w-[280px]">{currentAddr}</p>
              )}
            </div>
            <div className="flex gap-2">
              {!scanning ? (
                <Button
                  data-testid="button-start-scan"
                  onClick={runScan}
                  className="gap-2 bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                   Start Scan
                </Button>
              ) : (
                <Button
                  data-testid="button-stop-scan"
                  onClick={stopScan}
                  variant="destructive"
                  className="gap-2"
                >
                   Stop
                </Button>
              )}
              {!scanning && poolStats && poolStats.total > 0 && (
                <Button
                  data-testid="button-rescan-pool"
                  onClick={rescanPool}
                  variant="outline"
                  className="gap-2"
                  title={`Re-scan ${poolStats.total.toLocaleString()} stored addresses for availability changes - no geocoding cost`}
                >
                   Re-scan Pool
                </Button>
              )}
              {done && results.length > 0 && (
                <Button
                  data-testid="button-export-csv"
                  onClick={exportCSV}
                  variant="outline"
                  className="gap-2"
                >
                   Export CSV
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
                <p className="text-xs text-muted-foreground font-mono truncate">{currentAddr}</p>
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
              
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Worker State</span>
              {scannerState.isStuck ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-500/15 px-2.5 py-0.5 text-xs font-medium text-rose-400">
                   Stuck - no heartbeat {scannerState.secondsSinceHeartbeat}s
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
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">primary matches</div>
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
              <span className="font-mono tabular-nums">
                {scannerState.queueDepth > 0 ? `${scannerState.queueDepth.toLocaleString()} queued · ` : ""}max {scannerState.maxInFlight} provider-safe
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary metric strip */}
      {summary && (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="grid grid-cols-3 divide-x divide-border">
            <div className="p-4 text-center sm:p-5">
              <div className="text-3xl font-bold tracking-tight tabular-nums text-emerald-400">{summary.fresh}</div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-400/80">Yes · Confirmed fresh</div>
            </div>
            <div className="p-4 text-center sm:p-5">
              <div className="text-3xl font-bold tracking-tight tabular-nums text-slate-300">{summary.not_fresh}</div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">No · Not fresh</div>
            </div>
            <div className="p-4 text-center sm:p-5">
              <div className="text-3xl font-bold tracking-tight tabular-nums text-amber-400">{summary.unverified}</div>
              <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-amber-400/80">Recheck</div>
            </div>
          </div>
          <div className="border-t border-border px-4 py-2 text-center text-[11px] text-muted-foreground">
            {summary.scanned.toLocaleString()} checked · {(summary.remaining ?? 0).toLocaleString()} remaining
          </div>
        </div>
      )}

      {/* Filter bar */}
      {results.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {(["all", "fresh", "not_fresh", "unverified"] as FilterKey[]).map(f => {
            const cfg = f === "all" ? null : VERDICT_CONFIG[f];
            const count = f === "all" ? results.length : verdictCounts[f];
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
                {f === "all" ? "All answers" : cfg?.label} <span className="tabular-nums opacity-70">({count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Results list */}
      {filteredResults.length > 0 && (
        <div className="space-y-2">
          {filteredResults.map((r, i) => {
            const verdict = verdictOf(r);
            const cfg = VERDICT_CONFIG[verdict];
            return (
              <div
                key={`${r.address}-${i}`}
                data-testid={`result-row-${i}`}
                data-verdict={verdict}
                className={`render-lazy rounded-2xl border bg-card px-4 py-3.5 ${verdict === "fresh" ? "border-emerald-500/30" : verdict === "unverified" ? "border-amber-500/25" : "border-border"}`}
              >
                <div className="flex items-center gap-3">
                  
                  <div className="flex-1 min-w-0">
                    <div className={`text-[13px] font-bold tracking-wide ${verdict === "fresh" ? "text-emerald-400" : verdict === "unverified" ? "text-amber-400" : "text-slate-300"}`}>{cfg.answer} · {r.verdictLabel ?? cfg.label}</div>
                    <div className="mt-0.5 truncate text-sm font-semibold text-foreground">{r.address}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{r.city}, {r.state} {r.zip}</div>
                    {r.verdictMessage && <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{r.verdictMessage}</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {done && results.length === 0 && (
        <Card className="bg-card border-border rounded-xl">
          <CardContent className="pt-10 pb-10 text-center">
            
            <p className="text-sm text-muted-foreground">Scan complete - no addresses returned results. Try a different city or check token status.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
