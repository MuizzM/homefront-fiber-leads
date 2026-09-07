import { useForegroundActivity } from "@/hooks/use-foreground-activity";
import { useTabActive } from "@/lib/tabActivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { summarizeScanYield } from "@/lib/scanYield";
import { classifyScanIssue, scanIssueLabel } from "@/lib/scanIssue";
import { copyText } from "@/lib/clipboard";

// The pipeline the admin watches each address move through. Order matters — it
// drives the progress rail and "blocked stage" detection.
const STAGES = [
  "queued", "minting", "token_ready", "searching", "parsing", "saving", "classified",
] as const;
type Stage =
  | (typeof STAGES)[number] | "discovered" | "retry" | "blocked" | "bad_request" | "error";

const STAGE_LABEL: Record<string, string> = {
  discovered: "Discovered", queued: "Queued", minting: "Minting", token_ready: "Token Ready",
  searching: "Searching", parsing: "Parsing", saving: "Saving", classified: "Classified",
  retry: "Retry (auth)", blocked: "Throttled", bad_request: "Bad request", error: "Error",
};
const TERMINAL = new Set(["classified", "blocked", "bad_request", "error", "retry"]);
// Queue wait is normal backpressure under a large city/state scan. Only stages
// that already hold active provider/persistence work can truly stall; calling a
// queued row "Blocked" after ten seconds created hundreds of false alarms.
const STALLABLE = new Set(["minting", "token_ready", "searching", "parsing", "saving"]);
const BLOCKED_MS = 10_000; // no progress for 10s on a non-terminal stage → surface it

interface Ev {
  id: number | null; addressKey: string; address: string; city: string; state: string; zip: string;
  runId: string | null; source: string; stage: Stage; status: string; attempt: number;
  httpStatus?: number | null; latencyMs?: number | null; sessionId?: string | null;
  tokenSuffix?: string | null; retryReason?: string | null; classification?: string | null;
  detail?: string | null; tsEpoch: number;
}
interface Row {
  addressKey: string; address: string; city: string; state: string; zip: string;
  source: string; stage: Stage; status: string; attempt: number;
  httpStatus: number | null; latencyMs: number | null; sessionId: string | null;
  tokenSuffix: string | null; retryReason: string | null; classification: string | null;
  detail: string | null; startedAt: number; updatedAt: number;
}
interface ScanInspectorProps {
  city?: string;
  state?: string;
  scopeLabel?: string;
}
interface Health {
  decodoConnected: boolean; proxySessionId: string; tokenReady: boolean; tokenExpiresIn: number | null;
  publicIp: string | null; stickyPort: number | null; checksOnThisIp: number; checksPerIp: number;
  tokenPool: { ready: number; size: number }; paused: boolean;
}
interface Counters {
  found: number; checked: number; queued: number; checking: number; retrying: number; unresolved: number;
  newNow: number; newlyLit: number; stillFresh: number; comingSoon: number;
}

const STAGE_TONE: Record<string, string> = {
  classified: "bg-success/10 text-success border-success/25",
  saving: "bg-success/[0.08] text-success border-success/[0.12]",
  searching: "bg-info/10 text-info border-info/25",
  parsing: "bg-info/[0.08] text-info border-info/[0.12]",
  minting: "bg-info/10 text-info border-info/25",
  token_ready: "bg-info/[0.06] text-info border-info/20",
  queued: "bg-muted text-muted-foreground border-border",
  discovered: "bg-muted text-muted-foreground border-border",
  retry: "bg-warning/10 text-warning border-warning/25",
  blocked: "bg-warning/10 text-warning border-warning/25",
  bad_request: "bg-warning/10 text-warning border-warning/25",
  error: "bg-destructive/10 text-destructive border-destructive/25",
};

function rel(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ONE column template shared by the header row and every data row. The two are
// separate grid containers, so `auto` tracks would size to their own content
// and drift out of alignment — fixed trailing tracks keep the columns lined up,
// and the table scrolls horizontally on narrow screens instead of squeezing.
const TABLE_COLS = "grid grid-cols-[minmax(0,1fr)_10.5rem_5.5rem_4.5rem] items-center gap-3";
const TABLE_MIN_W = "min-w-[34rem]";

export default function ScanInspector({ city, state, scopeLabel }: ScanInspectorProps) {
  const { sessionId } = useAuth();
  const { toast } = useToast();
  const [rows, setRows] = useState<Map<string, Row>>(new Map());
  const [counters, setCounters] = useState<Counters | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Ev[]>([]);
  const [, forceTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const applyEvent = useCallback((e: Ev) => {
    if (city && String(e.city ?? "").trim().toLowerCase() !== city.trim().toLowerCase()) return;
    if (state && String(e.state ?? "").trim().toUpperCase() !== state.trim().toUpperCase()) return;
    setRows((prev) => {
      const next = new Map(prev);
      const cur = next.get(e.addressKey);
      next.set(e.addressKey, {
        addressKey: e.addressKey, address: e.address, city: e.city, state: e.state, zip: e.zip,
        source: e.source, stage: e.stage, status: e.status, attempt: Math.max(cur?.attempt ?? 1, e.attempt ?? 1),
        httpStatus: e.httpStatus ?? cur?.httpStatus ?? null, latencyMs: e.latencyMs ?? cur?.latencyMs ?? null,
        sessionId: e.sessionId ?? cur?.sessionId ?? null, tokenSuffix: e.tokenSuffix ?? cur?.tokenSuffix ?? null,
        retryReason: e.retryReason ?? (e.stage === "classified" ? null : cur?.retryReason ?? null),
        classification: e.classification ?? cur?.classification ?? null, detail: e.detail ?? cur?.detail ?? null,
        startedAt: cur?.startedAt ?? e.tsEpoch, updatedAt: e.tsEpoch,
      });
      // Keep the map bounded to the most-recent addresses.
      if (next.size > 300) {
        const oldest = [...next.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(0, next.size - 300);
        for (const r of oldest) next.delete(r.addressKey);
      }
      return next;
    });
  }, [city, state]);

  // Live SSE via fetch (EventSource can't send the x-session-id auth header).
  // retryTick re-runs this effect 5s after a stream dies: the old loop ran
  // once and never reconnected, freezing the rows behind a permanent
  // "Connecting…" spinner that implied progress.
  const [retryTick, setRetryTick] = useState(0);
  const displayActive = useForegroundActivity(useTabActive());
  // Stop halts EVERY running scan tenant-wide - one tap arms, the second fires.
  const [stopArmed, setStopArmed] = useState(false);
  useEffect(() => {
    if (!sessionId || !displayActive) { setConnected(false); return; }
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = () => {
      if (closed || retryTimer) return;
      retryTimer = setTimeout(() => setRetryTick(t => t + 1), 5_000);
    };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    (async () => {
      try {
        const params = new URLSearchParams();
        if (city) params.set("city", city);
        if (state) params.set("state", state);
        const res = await fetch(`/api/scan/inspector/stream${params.size ? `?${params.toString()}` : ""}`, {
          headers: { "x-session-id": sessionId },
          signal: ctrl.signal,
        });
        if (closed) return;
        if (!res.ok || !res.body) { setConnected(false); scheduleRetry(); return; }
        setConnected(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done || closed) break;
          buf += dec.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            let ev = "message", data = "";
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) ev = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (ev === "stage") applyEvent(parsed);
              else if (ev === "health") setHealth(parsed);
              else if (ev === "snapshot") {
                setHealth(parsed.health);
                setCounters(parsed.counters);
                setRows(() => {
                  const m = new Map<string, Row>();
                  for (const r of parsed.rows ?? []) m.set(r.addressKey, r);
                  return m;
                });
              }
            } catch { /* skip malformed frame */ }
          }
        }
      } catch { /* aborted or network */ } finally { if (!closed) { setConnected(false); scheduleRetry(); } }
    })();
    return () => { closed = true; if (retryTimer) clearTimeout(retryTimer); ctrl.abort(); };
  }, [sessionId, applyEvent, city, state, retryTick, displayActive]);

  // Recompute counters from live rows so the accounting invariant always holds:
  // found = checked + queued + checking + retrying + unresolved.
  const liveCounters = useMemo<Counters>(() => {
    const c: Counters = { found: 0, checked: 0, queued: 0, checking: 0, retrying: 0, unresolved: 0, newNow: 0, newlyLit: 0, stillFresh: 0, comingSoon: 0 };
    for (const r of rows.values()) {
      c.found++;
      if (r.stage === "classified") c.checked++;
      else if (r.stage === "queued" || r.stage === "discovered") c.queued++;
      else if (r.stage === "retry") c.retrying++;
      else if (r.stage === "blocked" || r.stage === "bad_request" || r.stage === "error") c.unresolved++;
      else c.checking++; // minting/token_ready/searching/parsing/saving
      const cl = (r.classification ?? "").toLowerCase();
      if (cl === "fresh_fiber" || cl === "new") c.newNow++;
      else if (cl === "newly_lit") c.newlyLit++;
      else if (cl === "still_fresh") c.stillFresh++;
      else if (cl === "coming_soon") c.comingSoon++;
    }
    return rows.size ? c : (counters ?? c);
  }, [rows, counters]);
  const yieldSummary = useMemo(() => summarizeScanYield(liveCounters), [liveCounters]);
  const issueBreakdown = useMemo(() => {
    const out = { addressCorrections: 0, authRetries: 0, otherProviderIssues: 0 };
    for (const row of rows.values()) {
      const kind = classifyScanIssue(row);
      if (kind === "address_correction") out.addressCorrections++;
      else if (kind === "auth_retry") out.authRetries++;
      else if (kind === "provider_issue") out.otherProviderIssues++;
    }
    return out;
  }, [rows]);

  // 1s tick so relative times + blocked-stage detection stay live — but ONLY
  // while there is something live to keep honest, and only while the tab is on
  // screen. This is mounted in Fiber Intelligence's Coverage tab, so an admin
  // who leaves that tab open was re-rendering every row once a second, all day,
  // for a clock nobody was reading with the pipeline idle.
  const scanLive = rows.size > 0;
  useEffect(() => {
    if (!scanLive || !displayActive) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        forceTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [scanLive, displayActive]);

  const control = async (action: string) => {
    try {
      const res = await apiRequest("POST", "/api/scan/inspector/control", { action });
      const j = await res.json();
      toast({ title: `Scan ${action}`, description: j.requeued != null ? `${j.requeued} requeued` : j.stopped != null ? `${j.stopped} stopped` : j.paused != null ? (j.paused ? "paused" : "resumed") : "ok" });
    } catch (e: any) {
      toast({ title: "Control failed", description: String(e?.message ?? e), variant: "destructive" });
    }
  };

  const copyDiagnostics = () => {
    const safe = {
      capturedAt: new Date().toISOString(),
      health, counters: liveCounters,
      rows: [...rows.values()].slice(0, 100).map((r) => ({
        address: `${r.address}, ${r.city} ${r.state} ${r.zip}`.trim(), stage: r.stage, status: r.status,
        attempt: r.attempt, httpStatus: r.httpStatus, latencyMs: r.latencyMs,
        proxySession: r.sessionId, tokenSuffix: r.tokenSuffix ? `…${r.tokenSuffix}` : null,
        retryReason: r.retryReason, classification: r.classification,
      })),
    };
    void copyText(JSON.stringify(safe, null, 2)).then((ok) =>
      toast(ok
        ? { title: "Copied safe diagnostics", description: "No tokens or credentials included." }
        : { title: "Copy failed", variant: "destructive" }));
  };

  const openTimeline = async (key: string) => {
    if (expanded === key) { setExpanded(null); return; }
    setExpanded(key); setTimeline([]);
    try {
      const res = await apiRequest("GET", `/api/scan/inspector/timeline/${encodeURIComponent(key)}`);
      const j = await res.json();
      setTimeline(j.timeline ?? []);
    } catch { setTimeline([]); }
  };

  // Log-viewer filters: one address is traceable end-to-end by its correlation id
  // (the stable addressKey hash) — filter rows by it, by pipeline stage, or by outcome.
  const [filterQuery, setFilterQuery] = useState("");
  const [filterStage, setFilterStage] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "ok" | "working" | "problem">("all");
  const PROBLEM_STAGES = ["error", "blocked", "bad_request", "retry"];
  const sortedRows = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return [...rows.values()]
      .filter((r) => {
        if (q && !r.addressKey.toLowerCase().includes(q) && !(r.address ?? "").toLowerCase().includes(q)) return false;
        if (filterStage !== "all" && r.stage !== filterStage) return false;
        if (filterStatus === "ok" && r.stage !== "classified") return false;
        if (filterStatus === "problem" && !PROBLEM_STAGES.includes(r.stage)) return false;
        if (filterStatus === "working" && (r.stage === "classified" || PROBLEM_STAGES.includes(r.stage))) return false;
        return true;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [rows, filterQuery, filterStage, filterStatus]);
  const totalRows = rows.size;

  return (
    <div className="space-y-4" data-testid="scan-inspector">
      {scopeLabel && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/25 bg-primary/[0.06] px-3 py-2 text-[12px]">
          <span className="font-semibold text-foreground">Showing {scopeLabel} only</span>
          <span className="text-muted-foreground">Rows and counters exclude every other market.</span>
        </div>
      )}
      {/* Health + connection */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${connected ? "border-success/25 bg-success/[0.08] text-success" : "border-warning/25 bg-warning/[0.08] text-warning"}`}>
          {connected ? null : <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />} {connected ? "Live" : retryTick > 0 ? "Reconnecting - rows may be stale" : "Connecting…"}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${health?.decodoConnected ? "border-success/25 text-success" : "border-destructive/25 text-destructive"}`}>
          {health?.decodoConnected ? null : null} Decodo {health?.decodoConnected ? "connected" : "down"}
        </span>
        {/* The address the rows below were answered from, and how much of its
            20-check budget is spent. A masked session id alone never told an
            operator whether traffic was leaving from Decodo or from here. */}
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 font-mono text-foreground"
          data-testid="inspector-egress-ip"
        >
          {health?.publicIp ?? (health?.stickyPort ? `port ${health.stickyPort}` : "resolving")}
          {health?.checksPerIp ? (
            <span className="text-muted-foreground">· {health.checksOnThisIp}/{health.checksPerIp}</span>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground font-mono">{health?.proxySessionId ?? "decodo-s?"}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground">
           token {health?.tokenReady ? `ready · ${health?.tokenExpiresIn ?? "?"}s` : "none"} · pool {health?.tokenPool?.ready ?? 0}/{health?.tokenPool?.size ?? 0}
        </span>
        {health?.paused && <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning/[0.08] px-2.5 py-1 text-warning">Paused</span>}
      </div>

      {/* Accounting counters — found = checked + queued + checking + retrying + unresolved */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {([
          ["Found", liveCounters.found, "text-foreground"],
          ["Checked", liveCounters.checked, "text-success"],
          ["Queued", liveCounters.queued, "text-muted-foreground"],
          ["Checking", liveCounters.checking, "text-info"],
          ["Retrying", liveCounters.retrying, "text-warning"],
          ["Unresolved", liveCounters.unresolved, "text-warning"],
        ] as const).map(([label, val, tone]) => (
          <div key={label} className="rounded-xl border border-border bg-card px-3 py-2.5">
            <div className={`text-[22px] font-bold leading-none tabular-nums ${tone}`}>{val}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">
        Invariant: {liveCounters.checked} + {liveCounters.queued} + {liveCounters.checking} + {liveCounters.retrying} + {liveCounters.unresolved} = {liveCounters.checked + liveCounters.queued + liveCounters.checking + liveCounters.retrying + liveCounters.unresolved} (found {liveCounters.found})
      </div>
      {(issueBreakdown.addressCorrections > 0 || issueBreakdown.authRetries > 0 || issueBreakdown.otherProviderIssues > 0) && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-xl border border-border bg-card px-3 py-2 text-[11px] text-muted-foreground" data-testid="scan-issue-breakdown">
          <span><b className="text-warning">{issueBreakdown.addressCorrections}</b> address corrections (HTTP 200, not proxy failures)</span>
          <span><b className="text-warning">{issueBreakdown.authRetries}</b> session retries (401/403)</span>
          <span><b className="text-foreground">{issueBreakdown.otherProviderIssues}</b> other provider issues</span>
        </div>
      )}

      {liveCounters.found > 0 && (
        <div
          role={yieldSummary.tone === "degraded" ? "alert" : "status"}
          data-testid="scan-yield-health"
          className={`rounded-xl border px-3 py-2.5 text-[12px] ${
            yieldSummary.tone === "degraded"
              ? "border-destructive/25 bg-destructive/[0.08] text-destructive"
              : yieldSummary.tone === "attention"
                ? "border-warning/25 bg-warning/[0.08] text-warning"
                : "border-border bg-card text-muted-foreground"
          }`}
        >
          <span className="font-semibold">{yieldSummary.title}.</span>{" "}
          {yieldSummary.completedPercent}% classified · {yieldSummary.unresolvedPercent}% unresolved.
          {yieldSummary.tone === "degraded" && " Review blocked rows and latency before adding more scan volume."}
        </div>
      )}

      {/* Controls are intentionally global: the shared provider queue does not
          support a truthful per-city pause. Make that blast radius explicit. */}
      {scopeLabel && <div className="text-[11px] font-semibold text-warning">All-market controls below affect every running scan, not only {scopeLabel}.</div>}
      {/* Controls */}
      <div className="flex flex-wrap gap-2">
        {health?.paused
          ? <button onClick={() => control("resume")} className="inline-flex items-center gap-1.5 rounded-lg bg-success px-3 py-2 text-[13px] font-semibold text-success-foreground hover:bg-success/90"> Resume</button>
          : <button onClick={() => control("pause")} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-secondary"> Pause</button>}
        <button onClick={() => control("retry-failed")} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-secondary"> Retry failed</button>
        {stopArmed ? (
          <>
            <button onClick={() => { setStopArmed(false); control("stop"); }} data-testid="inspector-stop-confirm" className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-[13px] font-semibold text-destructive-foreground hover:bg-destructive/90"> Stop every running scan</button>
            <button onClick={() => setStopArmed(false)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold text-foreground hover:bg-secondary"> Keep running</button>
          </>
        ) : (
          <button onClick={() => setStopArmed(true)} data-testid="inspector-stop" className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-3 py-2 text-[13px] font-semibold text-destructive hover:bg-destructive/[0.08]"> Stop</button>
        )}
        <button onClick={copyDiagnostics} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-secondary"> Copy diagnostics</button>
      </div>

      {/* Log-viewer filters — trace one address end-to-end by correlation id */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
          placeholder="Filter by correlation id or address…"
          aria-label="Filter by correlation id or address"
          data-testid="insp-filter-query"
          className="h-8 w-56 rounded-lg border border-border bg-card px-2.5 text-[12px] text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <select
          value={filterStage}
          onChange={(e) => setFilterStage(e.target.value)}
          aria-label="Filter by pipeline stage"
          data-testid="insp-filter-stage"
          className="h-8 rounded-lg border border-border bg-card px-2 text-[12px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All stages</option>
          {["queued", "minting", "token_ready", "searching", "parsing", "saving", "classified", "retry", "blocked", "bad_request", "error"].map((s) => (
            <option key={s} value={s}>{STAGE_LABEL[s] ?? s}</option>
          ))}
        </select>
        <div className="flex gap-1" role="group" aria-label="Filter by outcome">
          {(["all", "ok", "working", "problem"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilterStatus(s)}
              data-testid={`insp-filter-status-${s}`}
              className={`rounded-lg px-2.5 py-1 text-[12px] font-semibold capitalize transition-colors ${filterStatus === s ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:bg-secondary"}`}
            >{s === "ok" ? "Classified" : s}</button>
          ))}
        </div>
        {(filterQuery || filterStage !== "all" || filterStatus !== "all") && (
          <span className="text-[11px] text-muted-foreground">{sortedRows.length} of {totalRows} rows</span>
        )}
      </div>

      {/* Live rows */}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
        <div className={TABLE_MIN_W}>
        <div className={`${TABLE_COLS} border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`}>
          <span>Address</span><span>Stage</span><span className="text-right">Latency</span><span className="text-right">Updated</span>
        </div>
        {sortedRows.length === 0 && (
          <div className="px-4 py-8 text-center text-[13px] text-muted-foreground">
            {scopeLabel
              ? `No ${scopeLabel} addresses are present in the recent live window.`
              : "No addresses in flight. Start a scan (Field Map, city, or statewide) - rows appear here in real time."}
          </div>
        )}
        {sortedRows.map((r) => {
          const stale = !TERMINAL.has(r.stage) && STALLABLE.has(r.stage) && Date.now() - r.updatedAt > BLOCKED_MS;
          const isOpen = expanded === r.addressKey;
          const issueKind = classifyScanIssue(r);
          const issueLabel = scanIssueLabel(issueKind);
          return (
            <div key={r.addressKey} className="border-b border-border/60 last:border-0">
              <button onClick={() => openTimeline(r.addressKey)} className={`${TABLE_COLS} w-full px-4 py-2.5 text-left hover:bg-secondary/40`} data-testid={`insp-row-${r.addressKey}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate text-[13px] font-medium text-foreground">{r.address || r.addressKey}</span>
                  </div>
                  <div className="truncate pl-5 text-[11px] text-muted-foreground">{[r.city, r.state, r.zip].filter(Boolean).join(" ")} · {r.source}{r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}</div>
                </div>
                <div className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stale ? "bg-destructive/10 text-destructive border-destructive/25" : issueKind === "address_correction" ? "bg-warning/10 text-warning border-warning/25" : STAGE_TONE[r.stage] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {stale ? null : r.stage === "classified" ? null : null}
                    {stale ? `Blocked at ${STAGE_LABEL[r.stage] ?? r.stage}` : issueLabel ?? STAGE_LABEL[r.stage] ?? r.stage}
                  </span>
                  {r.classification && <span className="pl-0.5 text-2xs text-muted-foreground">{r.classification}</span>}
                </div>
                <div className="text-right text-[12px] tabular-nums text-muted-foreground">{r.latencyMs != null ? `${r.latencyMs}ms` : " - "}{r.httpStatus ? ` · ${r.httpStatus}` : ""}</div>
                <div className="text-right text-[11px] tabular-nums text-muted-foreground">{rel(r.updatedAt)}</div>
              </button>
              {stale && r.retryReason && (
                <div className="px-4 pb-2 pl-9 text-[11px] text-destructive">{r.retryReason}</div>
              )}
              {isOpen && (
                <div className="border-t border-border/60 bg-background/40 px-4 py-3 pl-9">
                  <button
                    onClick={() => { void copyText(r.addressKey); }}
                    title="Copy correlation id"
                    data-testid="insp-correlation-id"
                    className="mb-2 inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
                  >correlation: {r.addressKey}</button>
                  {timeline.length === 0 ? <div className="text-[12px] text-muted-foreground">Loading timeline…</div> : (
                    <ol className="space-y-1.5">
                      {timeline.map((t) => {
                        const timelineIssue = classifyScanIssue(t);
                        return (
                        <li key={t.id} className="flex items-start gap-2 text-[12px]">
                          <span className={`mt-0.5 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-2xs font-semibold ${timelineIssue === "address_correction" ? "bg-warning/10 text-warning border-warning/25" : STAGE_TONE[t.stage] ?? "bg-muted text-muted-foreground border-border"}`}>{scanIssueLabel(timelineIssue) ?? STAGE_LABEL[t.stage] ?? t.stage}</span>
                          <div className="min-w-0 flex-1">
                            <span className="text-muted-foreground">
                              {new Date(t.tsEpoch).toLocaleTimeString()} ·
                              {t.httpStatus ? ` HTTP ${t.httpStatus} ·` : ""}{t.latencyMs != null ? ` ${t.latencyMs}ms ·` : ""}
                              {t.sessionId ? ` ${t.sessionId} ·` : ""}{t.tokenSuffix ? ` token …${t.tokenSuffix} ·` : ""}{t.attempt > 1 ? ` attempt ${t.attempt} ·` : ""}
                            </span>
                            {(t.retryReason || t.detail) && <span className="text-foreground/80"> {t.retryReason || t.detail}</span>}
                          </div>
                        </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              )}
            </div>
          );
        })}
        </div>
        </div>
      </div>
    </div>
  );
}
