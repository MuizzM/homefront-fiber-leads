import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

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
interface Health {
  decodoConnected: boolean; proxySessionId: string; tokenReady: boolean; tokenExpiresIn: number | null;
  tokenPool: { ready: number; size: number }; paused: boolean;
}
interface Counters {
  found: number; checked: number; queued: number; checking: number; retrying: number; unresolved: number;
  newNow: number; newlyLit: number; stillFresh: number; comingSoon: number;
}

const STAGE_TONE: Record<string, string> = {
  classified: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  saving: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  searching: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  parsing: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  minting: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  token_ready: "bg-violet-500/10 text-violet-300 border-violet-500/20",
  queued: "bg-muted text-muted-foreground border-border",
  discovered: "bg-muted text-muted-foreground border-border",
  retry: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  blocked: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  bad_request: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  error: "bg-red-500/15 text-red-400 border-red-500/30",
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

export default function ScanInspector() {
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
  }, []);

  // Live SSE via fetch (EventSource can't send the x-session-id auth header).
  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    (async () => {
      try {
        const res = await fetch("/api/scan/inspector/stream", {
          headers: { "x-session-id": sessionId },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) { setConnected(false); return; }
        setConnected(true);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
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
      } catch { /* aborted or network */ } finally { if (!closed) setConnected(false); }
    })();
    return () => { closed = true; ctrl.abort(); };
  }, [sessionId, applyEvent]);

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

  // 1s tick so relative times + blocked-stage detection stay live — but ONLY
  // while there is something live to keep honest, and only while the tab is on
  // screen. This is mounted in Fiber Intelligence's Coverage tab, so an admin
  // who leaves that tab open was re-rendering every row once a second, all day,
  // for a clock nobody was reading with the pipeline idle.
  const scanLive = rows.size > 0;
  useEffect(() => {
    if (!scanLive) return;
    const t = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        forceTick((n) => n + 1);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [scanLive]);

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
    navigator.clipboard?.writeText(JSON.stringify(safe, null, 2))
      .then(() => toast({ title: "Copied safe diagnostics", description: "No tokens or credentials included." }))
      .catch(() => toast({ title: "Copy failed", variant: "destructive" }));
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
      {/* Health + connection */}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium ${connected ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" : "border-amber-500/30 bg-amber-500/10 text-amber-400"}`}>
          {connected ? null : <Loader2 className="h-3.5 w-3.5 animate-spin" />} {connected ? "Live" : "Connecting…"}
        </span>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${health?.decodoConnected ? "border-emerald-500/30 text-emerald-600 dark:text-emerald-400" : "border-red-500/30 text-red-600 dark:text-red-400"}`}>
          {health?.decodoConnected ? null : null} Decodo {health?.decodoConnected ? "connected" : "down"}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground font-mono">{health?.proxySessionId ?? "decodo-s?"}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-muted-foreground">
           token {health?.tokenReady ? `ready · ${health?.tokenExpiresIn ?? "?"}s` : "none"} · pool {health?.tokenPool?.ready ?? 0}/{health?.tokenPool?.size ?? 0}
        </span>
        {health?.paused && <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-amber-400">Paused</span>}
      </div>

      {/* Accounting counters — found = checked + queued + checking + retrying + unresolved */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {([
          ["Found", liveCounters.found, "text-foreground"],
          ["Checked", liveCounters.checked, "text-emerald-600 dark:text-emerald-400"],
          ["Queued", liveCounters.queued, "text-muted-foreground"],
          ["Checking", liveCounters.checking, "text-sky-600 dark:text-sky-400"],
          ["Retrying", liveCounters.retrying, "text-amber-600 dark:text-amber-400"],
          ["Unresolved", liveCounters.unresolved, "text-orange-600 dark:text-orange-400"],
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

      {/* Controls */}
      <div className="flex flex-wrap gap-2">
        {health?.paused
          ? <button onClick={() => control("resume")} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-[13px] font-semibold text-[#04241f] hover:bg-emerald-400"> Resume</button>
          : <button onClick={() => control("pause")} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-secondary"> Pause</button>}
        <button onClick={() => control("retry-failed")} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[13px] font-semibold hover:bg-secondary"> Retry failed</button>
        <button onClick={() => control("stop")} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-card px-3 py-2 text-[13px] font-semibold text-red-600 hover:bg-red-500/10 dark:text-red-400"> Stop</button>
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
            No addresses in flight. Start a scan (Field Map, city, or statewide) - rows appear here in real time.
          </div>
        )}
        {sortedRows.map((r) => {
          const stale = !TERMINAL.has(r.stage) && Date.now() - r.updatedAt > BLOCKED_MS;
          const isOpen = expanded === r.addressKey;
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
                  <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stale ? "bg-red-500/15 text-red-400 border-red-500/30" : STAGE_TONE[r.stage] ?? "bg-muted text-muted-foreground border-border"}`}>
                    {stale ? null : r.stage === "classified" ? null : null}
                    {stale ? `Blocked at ${STAGE_LABEL[r.stage] ?? r.stage}` : STAGE_LABEL[r.stage] ?? r.stage}
                  </span>
                  {r.classification && <span className="pl-0.5 text-2xs text-muted-foreground">{r.classification}</span>}
                </div>
                <div className="text-right text-[12px] tabular-nums text-muted-foreground">{r.latencyMs != null ? `${r.latencyMs}ms` : " - "}{r.httpStatus ? ` · ${r.httpStatus}` : ""}</div>
                <div className="text-right text-[11px] tabular-nums text-muted-foreground">{rel(r.updatedAt)}</div>
              </button>
              {stale && r.retryReason && (
                <div className="px-4 pb-2 pl-9 text-[11px] text-red-600 dark:text-red-400">{r.retryReason}</div>
              )}
              {isOpen && (
                <div className="border-t border-border/60 bg-background/40 px-4 py-3 pl-9">
                  <button
                    onClick={() => { void navigator.clipboard?.writeText(r.addressKey); }}
                    title="Copy correlation id"
                    data-testid="insp-correlation-id"
                    className="mb-2 inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-secondary/70 hover:text-foreground"
                  >correlation: {r.addressKey}</button>
                  {timeline.length === 0 ? <div className="text-[12px] text-muted-foreground">Loading timeline…</div> : (
                    <ol className="space-y-1.5">
                      {timeline.map((t) => (
                        <li key={t.id} className="flex items-start gap-2 text-[12px]">
                          <span className={`mt-0.5 inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-2xs font-semibold ${STAGE_TONE[t.stage] ?? "bg-muted text-muted-foreground border-border"}`}>{STAGE_LABEL[t.stage] ?? t.stage}</span>
                          <div className="min-w-0 flex-1">
                            <span className="text-muted-foreground">
                              {new Date(t.tsEpoch).toLocaleTimeString()} ·
                              {t.httpStatus ? ` HTTP ${t.httpStatus} ·` : ""}{t.latencyMs != null ? ` ${t.latencyMs}ms ·` : ""}
                              {t.sessionId ? ` ${t.sessionId} ·` : ""}{t.tokenSuffix ? ` token …${t.tokenSuffix} ·` : ""}{t.attempt > 1 ? ` attempt ${t.attempt} ·` : ""}
                            </span>
                            {(t.retryReason || t.detail) && <span className="text-foreground/80"> {t.retryReason || t.detail}</span>}
                          </div>
                        </li>
                      ))}
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
