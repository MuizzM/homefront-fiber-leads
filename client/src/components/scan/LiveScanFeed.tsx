import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  Loader2, Radar, TriangleAlert, WifiOff, X,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { cn } from "@/lib/utils";

/**
 * ── LiveScanFeed ──────────────────────────────────────────────────────────────
 * The compact, field-map sibling of `components/fiber/ScanInspector` (the full
 * admin console). Same event vocabulary and same visual language, but sized to
 * float over the map and be read one-handed on a phone mid-route.
 *
 * WHY this exists at all: a scan that stalls used to render as a bare spinner
 * and the counters "8 found · 0 checked · 8 pending" forever. The real cause was
 * the token pool failing to mint, so every address sat at `minting` with
 * "no authorized session" — information the server was already emitting and the
 * UI simply never showed. This component's job is to make that *the first thing
 * you see*, in plain language, without the operator having to read a log.
 *
 * Deliberately transport-agnostic: it takes events via props (controlled) or via
 * an injectable `fetcher`. It hardcodes NO endpoint path — the API for this is
 * owned elsewhere, so the caller supplies the transport.
 */

// ── Event shape ───────────────────────────────────────────────────────────────
// Mirrors `server/scanStageBus.ts#ScanStageEvent` exactly. Kept as its own
// declaration (rather than importing from server) so the client bundle never
// reaches across the boundary; the field comments below are the contract.
export type ScanStage =
  | "discovered" | "queued" | "minting" | "token_ready"
  | "searching" | "parsing" | "saving" | "classified"
  | "retry" | "blocked" | "bad_request" | "error";

export type ScanStageStatus =
  | "ok" | "retry" | "blocked" | "bad_request" | "error" | "pending_auth" | "info";

export interface LiveScanEvent {
  /** Stable per-address correlation id (normalized dedup key). */
  addressKey: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  runId: string | null;
  /** manual | field | lasso | city | market | … */
  source: string;
  stage: ScanStage;
  status: ScanStageStatus;
  attempt: number;
  httpStatus?: number | null;
  latencyMs?: number | null;
  /** MASKED proxy session id (e.g. "decodo-s3"). Never an IP, never a credential. */
  sessionId?: string | null;
  /** Last 4 chars of the JWT ONLY. Never the token. Re-truncated defensively below. */
  tokenSuffix?: string | null;
  retryReason?: string | null;
  classification?: string | null;
  detail?: string | null;
  /** Epoch ms. */
  tsEpoch: number;
  /** Optional durable row id when the events came from the persisted log. */
  id?: number | null;
}

/** Transport health, so a dead socket never masquerades as "nothing happening". */
export type ScanConnectionState =
  | "idle" | "connecting" | "live" | "reconnecting" | "disconnected";

export interface LiveScanSnapshot {
  events: LiveScanEvent[];
  connection?: ScanConnectionState;
  runId?: string | null;
}

/**
 * Injectable transport. Called on mount and every `pollMs` while a runId is set.
 * Receives an AbortSignal so an unmount or runId change cancels in flight work.
 */
export type LiveScanFetcher = (args: {
  runId: string | null;
  signal: AbortSignal;
}) => Promise<LiveScanSnapshot>;

export interface LiveScanFeedProps {
  /** Controlled mode: the caller owns the events (SSE, WebSocket, its own query). */
  events?: LiveScanEvent[];
  /** Uncontrolled mode: supply a fetcher and (optionally) a runId to poll for. */
  fetcher?: LiveScanFetcher;
  runId?: string | null;
  /** Poll interval for `fetcher` mode. Default 2s — fast enough to feel live. */
  pollMs?: number;
  /** Transport health. In fetcher mode it is derived when not supplied. */
  connection?: ScanConnectionState;
  loading?: boolean;
  /** Human-readable error. Renders the error state. */
  error?: string | null;
  /** Hard cap on rendered rows so a 10k-event run cannot jank the map. Default 60. */
  maxRows?: number;
  /** Seconds without progress on a non-terminal stage before we call it stalled. */
  stallSeconds?: number;
  /** How many addresses must agree before the stall banner fires. Default 3. */
  stallMinAddresses?: number;
  /** Optional dismiss affordance when floated over the map. */
  onClose?: () => void;
  className?: string;
  testId?: string;
}

// ── Stage vocabulary ──────────────────────────────────────────────────────────
// Happy path: discovered → queued → minting → token_ready → searching → parsing
// → saving → classified. Anything else is an off-path marker.
export const STAGE_LABEL: Record<ScanStage, string> = {
  discovered: "Discovered", queued: "Queued", minting: "Minting", token_ready: "Token ready",
  searching: "Searching", parsing: "Parsing", saving: "Saving", classified: "Classified",
  retry: "Retry (auth)", blocked: "Throttled", bad_request: "Bad request", error: "Error",
};

/** Plain-language gloss shown in the stall banner — no jargon, no stage names. */
const STAGE_PLAIN: Partial<Record<ScanStage, string>> = {
  minting: "waiting for a scan token",
  token_ready: "holding a token but never searching",
  searching: "waiting on the provider",
  parsing: "reading the provider response",
  saving: "writing results",
  queued: "waiting for a worker",
  discovered: "waiting to be queued",
};

/** Stages that end an address's journey — they can never be "stuck". */
const TERMINAL = new Set<ScanStage>(["classified", "blocked", "bad_request", "error"]);
/** Stages that mean something went wrong, terminal or not. */
const PROBLEM = new Set<ScanStage>(["retry", "blocked", "bad_request", "error"]);

// Same palette as ScanInspector so the two views read as one system.
const STAGE_TONE: Record<ScanStage, string> = {
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

/**
 * Defensive re-truncation. The server contract says `tokenSuffix` is the last 4
 * chars of a JWT, but this component renders into a screen operators screenshot
 * and paste into chat — if a future emitter ever regresses and sends the whole
 * token, we still only paint 4 characters. Never add a field for a raw token.
 */
function maskTokenSuffix(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw);
  return s.length <= 4 ? s : s.slice(-4);
}

function rel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/** The one line that explains a row's trouble, in priority order. */
function failureReason(row: AddressRow): string | null {
  return row.retryReason || (PROBLEM.has(row.stage) ? row.detail : null) || null;
}

// ── Collapse events → one row per address ─────────────────────────────────────
// The feed is per-ADDRESS, not per-event: an address that retried 6 times is one
// row showing "attempt 6", not six rows pushing everything else off screen. This
// is also what keeps rendering bounded when thousands of events arrive.
interface AddressRow {
  addressKey: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  source: string;
  stage: ScanStage;
  status: ScanStageStatus;
  attempt: number;
  httpStatus: number | null;
  latencyMs: number | null;
  sessionId: string | null;
  tokenSuffix: string | null;
  retryReason: string | null;
  classification: string | null;
  detail: string | null;
  /** Latest event timestamp for this address — the basis for "silent for 45s". */
  updatedAt: number;
  /** How many raw events collapsed into this row. */
  events: number;
}

function collapse(events: LiveScanEvent[]): AddressRow[] {
  const byKey = new Map<string, AddressRow>();
  for (const e of events) {
    if (!e || typeof e.addressKey !== "string") continue;
    const prev = byKey.get(e.addressKey);
    // Events may arrive out of order (poll overlap, replayed backlog); the row
    // always reflects the newest event we have seen, never the last one parsed.
    const isNewer = !prev || e.tsEpoch >= prev.updatedAt;
    const stage = isNewer ? e.stage : prev!.stage;
    byKey.set(e.addressKey, {
      addressKey: e.addressKey,
      address: isNewer ? e.address : prev!.address,
      city: isNewer ? e.city : prev!.city,
      state: isNewer ? e.state : prev!.state,
      zip: isNewer ? e.zip : prev!.zip,
      source: isNewer ? e.source : prev!.source,
      stage,
      status: isNewer ? e.status : prev!.status,
      attempt: Math.max(prev?.attempt ?? 1, e.attempt ?? 1),
      httpStatus: (isNewer ? e.httpStatus : prev!.httpStatus) ?? prev?.httpStatus ?? null,
      latencyMs: (isNewer ? e.latencyMs : prev!.latencyMs) ?? prev?.latencyMs ?? null,
      sessionId: (isNewer ? e.sessionId : prev!.sessionId) ?? prev?.sessionId ?? null,
      tokenSuffix: maskTokenSuffix((isNewer ? e.tokenSuffix : prev!.tokenSuffix) ?? prev?.tokenSuffix),
      // A successful classification clears any stale reason from an earlier attempt.
      retryReason: isNewer
        ? (e.retryReason ?? (e.stage === "classified" ? null : prev?.retryReason ?? null))
        : prev!.retryReason,
      classification: (isNewer ? e.classification : prev!.classification) ?? prev?.classification ?? null,
      detail: (isNewer ? e.detail : prev!.detail) ?? prev?.detail ?? null,
      updatedAt: Math.max(prev?.updatedAt ?? 0, e.tsEpoch ?? 0),
      events: (prev?.events ?? 0) + 1,
    });
  }
  // Newest-first: the address that just moved is the one the operator cares about.
  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── Stall diagnosis ───────────────────────────────────────────────────────────
interface Stall {
  headline: string;
  reason: string | null;
  count: number;
  kind: "stuck_stage" | "repeat_failure";
}

/**
 * Two independent signals, either of which would have surfaced the outage in
 * seconds:
 *
 *  1. `repeat_failure` — N+ addresses failing with the SAME reason. No clock
 *     involved: identical reasons repeating is already conclusive, and waiting
 *     on a timer would only delay the answer.
 *  2. `stuck_stage` — N+ addresses parked on the same NON-terminal stage with no
 *     movement for `stallSeconds`, and nothing has completed. This is the exact
 *     shape of "8 found · 0 checked · 8 pending".
 */
function diagnoseStall(
  rows: AddressRow[],
  now: number,
  stallMs: number,
  minAddresses: number,
): Stall | null {
  if (rows.length === 0) return null;

  // (1) Repeated identical failure reason.
  const byReason = new Map<string, number>();
  for (const r of rows) {
    const reason = failureReason(r);
    if (!reason) continue;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  let worstReason: string | null = null;
  let worstReasonCount = 0;
  for (const [reason, n] of byReason) {
    if (n > worstReasonCount) { worstReason = reason; worstReasonCount = n; }
  }
  if (worstReason && worstReasonCount >= minAddresses) {
    return {
      kind: "repeat_failure",
      count: worstReasonCount,
      reason: worstReason,
      headline: `${worstReasonCount} addresses are failing for the same reason`,
    };
  }

  // (2) Many addresses parked on one non-terminal stage, nothing finishing.
  const anyClassified = rows.some((r) => r.stage === "classified");
  const byStage = new Map<ScanStage, AddressRow[]>();
  for (const r of rows) {
    if (TERMINAL.has(r.stage)) continue;
    const list = byStage.get(r.stage);
    if (list) list.push(r); else byStage.set(r.stage, [r]);
  }
  for (const [stage, list] of byStage) {
    if (list.length < minAddresses) continue;
    // Every one of them must be silent for the full window — a single moving
    // address means the pipeline is slow, not stalled, and we should not cry wolf.
    const newest = Math.max(...list.map((r) => r.updatedAt));
    if (now - newest < stallMs) continue;
    if (anyClassified && list.length < rows.length / 2) continue;
    const plain = STAGE_PLAIN[stage] ?? `stuck at ${STAGE_LABEL[stage].toLowerCase()}`;
    const stuckFor = Math.round((now - newest) / 1000);
    return {
      kind: "stuck_stage",
      count: list.length,
      reason: failureReason(list[0]),
      headline: `${list.length} addresses stuck ${plain} for ${stuckFor}s — nothing is completing`,
    };
  }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function LiveScanFeed({
  events: controlledEvents,
  fetcher,
  runId = null,
  pollMs = 2000,
  connection: controlledConnection,
  loading: controlledLoading,
  error: controlledError,
  maxRows = 60,
  stallSeconds = 20,
  stallMinAddresses = 3,
  onClose,
  className,
  testId = "live-scan-feed",
}: LiveScanFeedProps) {
  const [fetched, setFetched] = useState<LiveScanEvent[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [derivedConnection, setDerivedConnection] = useState<ScanConnectionState>("idle");
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // A monotonically bumped tick drives relative times and stall detection without
  // re-fetching. One interval for the whole component, not one per row.
  const [nowTick, setNowTick] = useState(() => Date.now());

  const isControlled = controlledEvents !== undefined;

  // Poll the injectable transport. Aborts on unmount/runId change so a slow
  // response can never resurrect a stale run's rows.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  useEffect(() => {
    if (isControlled || !fetcher) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    setDerivedConnection((c) => (c === "live" ? "reconnecting" : "connecting"));

    const tick = async () => {
      try {
        const snap = await fetcherRef.current?.({ runId, signal: ctrl.signal });
        if (cancelled || !snap) return;
        setFetched(snap.events ?? []);
        setFetchError(null);
        setDerivedConnection(snap.connection ?? "live");
      } catch (err) {
        if (cancelled) return;
        // Keep the last known rows on screen: a blank feed during a blip reads as
        // "scan died", which is exactly the wrong signal.
        setFetchError(err instanceof Error ? err.message : String(err));
        setDerivedConnection((c) => (c === "live" ? "reconnecting" : "disconnected"));
      } finally {
        if (!cancelled) timer = setTimeout(tick, pollMs);
      }
    };
    void tick();
    return () => { cancelled = true; ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [isControlled, fetcher, runId, pollMs]);

  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const events = isControlled ? controlledEvents! : (fetched ?? []);
  const connection = controlledConnection ?? (isControlled ? "live" : derivedConnection);
  const error = controlledError ?? (fetched === null ? fetchError : null);
  const loading = controlledLoading ?? (!isControlled && !!fetcher && fetched === null && !fetchError);

  const rows = useMemo(() => collapse(events), [events]);

  const counts = useMemo(() => {
    const c = { total: rows.length, checked: 0, working: 0, waiting: 0, problem: 0 };
    for (const r of rows) {
      if (r.stage === "classified") c.checked++;
      else if (PROBLEM.has(r.stage)) c.problem++;
      else if (r.stage === "queued" || r.stage === "discovered") c.waiting++;
      else c.working++;
    }
    return c;
  }, [rows]);

  const stall = useMemo(
    () => diagnoseStall(rows, nowTick, stallSeconds * 1000, stallMinAddresses),
    [rows, nowTick, stallSeconds, stallMinAddresses],
  );

  const visible = useMemo(() => {
    const filtered = problemsOnly
      ? rows.filter((r) => PROBLEM.has(r.stage) || !!failureReason(r))
      : rows;
    // Hard cap. Rendering is O(maxRows) regardless of event volume, so the map
    // underneath keeps its frame budget even on a statewide run.
    return { list: filtered.slice(0, maxRows), hidden: Math.max(0, filtered.length - maxRows) };
  }, [rows, problemsOnly, maxRows]);

  /**
   * Screen-reader policy: the row list is an `aria-live="off"` log, because a
   * high-rate feed announced per event is unusable noise. Instead a single
   * throttled summary region speaks — and only when the numbers actually
   * changed, at most once every 10s. The stall banner is a separate polite
   * status region so the one message that matters is never drowned out.
   */
  const [srSummary, setSrSummary] = useState("");
  const lastAnnounce = useRef({ at: 0, text: "" });
  useEffect(() => {
    const text = `${counts.checked} checked, ${counts.working + counts.waiting} in progress, ${counts.problem} with problems.`;
    if (text === lastAnnounce.current.text) return;
    if (Date.now() - lastAnnounce.current.at < 10_000) return;
    lastAnnounce.current = { at: Date.now(), text };
    setSrSummary(text);
  }, [counts]);

  const toggleRow = useCallback((key: string) => {
    setExpanded((cur) => (cur === key ? null : key));
  }, []);

  const shell = cn(
    "flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-card/95 shadow-xl backdrop-blur-xl",
    className,
  );

  // ── Header (always rendered, so switching between states never shifts layout) ──
  const header = (
    <div className="shrink-0 border-b border-border px-3 py-2">
      <div className="flex items-center gap-2">
        <Radar className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          Live scan
        </h2>
        <ConnectionChip state={connection} />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close live scan feed"
            data-testid="live-scan-close"
            className="-mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Counts by stage bucket. tabular-nums + fixed row height = no jitter as
          numbers tick up over a moving map. */}
      <div className="mt-1.5 flex items-center gap-1.5 overflow-x-auto" data-testid="live-scan-counts">
        <CountChip label="Found" value={counts.total} tone="text-foreground" />
        <CountChip label="Checked" value={counts.checked} tone="text-emerald-600 dark:text-emerald-400" />
        <CountChip label="Working" value={counts.working} tone="text-sky-600 dark:text-sky-400" />
        <CountChip label="Waiting" value={counts.waiting} tone="text-muted-foreground" />
        <CountChip label="Problems" value={counts.problem} tone="text-red-600 dark:text-red-400" />
        <button
          type="button"
          onClick={() => setProblemsOnly((v) => !v)}
          aria-pressed={problemsOnly}
          data-testid="live-scan-problems-toggle"
          className={cn(
            "ml-auto min-h-9 shrink-0 rounded-full border px-3 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            problemsOnly
              ? "border-red-500/40 bg-red-500/15 text-red-600 dark:text-red-400"
              : "border-border text-muted-foreground hover:bg-secondary",
          )}
        >
          Problems only
        </button>
      </div>
    </div>
  );

  return (
    <section className={shell} aria-label="Live scan activity" data-testid={testId}>
      {header}

      {/* THE banner. Plain language, prominent, above the feed — the thing that
          would have turned a 40-minute outage into a 5-second diagnosis. */}
      {stall && (
        <div
          role="status"
          data-testid="live-scan-stall-banner"
          className="flex shrink-0 items-start gap-2 border-b border-red-500/30 bg-red-500/12 px-3 py-2.5 text-[12px] text-red-700 dark:text-red-300"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">Scan is stalled — {stall.headline}</p>
            {stall.reason && (
              <p className="mt-0.5 break-words opacity-90" data-testid="live-scan-stall-reason">
                Reported reason: {stall.reason}
              </p>
            )}
            <p className="mt-0.5 opacity-75">
              Addresses will keep showing as pending until this clears. Nothing you do on the map will fix it.
            </p>
          </div>
        </div>
      )}

      {/* Throttled, visually hidden progress summary (see policy note above). */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="live-scan-sr-summary">
        {srSummary}
      </p>

      <div className="min-h-[9rem] flex-1 overflow-y-auto overscroll-contain">
        {error ? (
          <div className="px-4 py-6 text-center" role="alert" data-testid="live-scan-error">
            <AlertTriangle className="mx-auto h-6 w-6 text-red-500" aria-hidden="true" />
            <p className="mt-2 text-[13px] font-semibold text-foreground">Can't load scan activity</p>
            <p className="mt-1 text-[12px] text-muted-foreground">{error}</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-[13px] text-muted-foreground" data-testid="live-scan-loading">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Connecting to scan…
          </div>
        ) : visible.list.length === 0 ? (
          <EmptyState
            testId="live-scan-empty"
            icon={Radar}
            title={problemsOnly && rows.length > 0 ? "No problems" : "No scan running"}
            description={
              problemsOnly && rows.length > 0
                ? "Every address in this run is moving normally."
                : "Start an area scan and each address will appear here as it is checked."
            }
          />
        ) : (
          <ol
            role="log"
            aria-live="off"
            aria-label="Addresses being scanned, newest first"
            data-testid="live-scan-rows"
            className="divide-y divide-border/60"
          >
            {visible.list.map((r) => (
              <FeedRow
                key={r.addressKey}
                row={r}
                now={nowTick}
                open={expanded === r.addressKey}
                onToggle={toggleRow}
              />
            ))}
          </ol>
        )}
      </div>

      {visible.hidden > 0 && (
        <div className="shrink-0 border-t border-border px-3 py-1.5 text-center text-2xs text-muted-foreground" data-testid="live-scan-overflow">
          +{visible.hidden} more {visible.hidden === 1 ? "address" : "addresses"} not shown
        </div>
      )}
    </section>
  );
}

export default LiveScanFeed;

// ── Sub-components ────────────────────────────────────────────────────────────

function CountChip({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <span className="flex shrink-0 items-baseline gap-1 rounded-full border border-border bg-background/50 px-2 py-1">
      <span className={cn("text-[13px] font-bold tabular-nums leading-none", tone)}>{value}</span>
      <span className="text-2xs text-muted-foreground">{label}</span>
    </span>
  );
}

function ConnectionChip({ state }: { state: ScanConnectionState }) {
  const map: Record<ScanConnectionState, { text: string; cls: string; spin: boolean; icon: typeof Activity }> = {
    live: { text: "Live", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", spin: false, icon: Activity },
    connecting: { text: "Connecting", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400", spin: true, icon: Loader2 },
    reconnecting: { text: "Reconnecting", cls: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400", spin: true, icon: Loader2 },
    disconnected: { text: "Offline", cls: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400", spin: false, icon: WifiOff },
    idle: { text: "Idle", cls: "border-border text-muted-foreground", spin: false, icon: Activity },
  };
  const m = map[state] ?? map.idle;
  const Icon = m.icon;
  return (
    <span
      data-testid="live-scan-connection"
      // Not aria-live: transport blips would otherwise interrupt the operator
      // constantly. The label still reads correctly whenever focus lands here.
      aria-label={`Connection: ${m.text}`}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold", m.cls)}
    >
      <Icon className={cn("h-3 w-3", m.spin && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
      {m.text}
    </span>
  );
}

function FeedRow({
  row, now, open, onToggle,
}: { row: AddressRow; now: number; open: boolean; onToggle: (key: string) => void }) {
  const reason = failureReason(row);
  // "Silent" ≠ "failed": an address that has not moved in 10s on a non-terminal
  // stage gets the warning treatment even if the server never sent an error.
  const silent = !TERMINAL.has(row.stage) && now - row.updatedAt > 10_000;
  const tone = silent ? "bg-red-500/15 text-red-400 border-red-500/30" : STAGE_TONE[row.stage];
  const line2 = [row.city, row.state, row.zip].filter(Boolean).join(" ");

  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(row.addressKey)}
        aria-expanded={open}
        data-testid={`live-scan-row-${row.addressKey}`}
        // min-h-11 = 44px: the smallest reliable one-thumb target.
        className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {row.address || row.addressKey}
          </span>
          <span className="block truncate text-2xs text-muted-foreground">
            {line2}
            {row.attempt > 1 ? `${line2 ? " · " : ""}attempt ${row.attempt}` : ""}
            {row.latencyMs != null ? ` · ${row.latencyMs}ms` : ""}
            {row.classification ? ` · ${row.classification}` : ""}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span
            data-testid={`live-scan-stage-${row.addressKey}`}
            className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold", tone)}
          >
            {silent ? <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              : row.stage === "classified" ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                : null}
            {silent ? `Stuck: ${STAGE_LABEL[row.stage]}` : STAGE_LABEL[row.stage]}
          </span>
          <span className="text-2xs tabular-nums text-muted-foreground">{rel(row.updatedAt, now)}</span>
        </span>
      </button>

      {/* The failure reason is ALWAYS visible on a bad row — never hidden behind
          the expander. Hiding it is what made the original outage invisible. */}
      {reason && (
        <p
          data-testid={`live-scan-reason-${row.addressKey}`}
          className="px-3 pb-2 pl-8 text-2xs leading-snug text-red-600 dark:text-red-400"
        >
          {reason}
        </p>
      )}

      {open && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border/60 bg-background/40 px-3 py-2 pl-8 text-2xs">
          <Detail label="Correlation" value={row.addressKey} mono />
          <Detail label="Source" value={row.source} />
          <Detail label="HTTP" value={row.httpStatus != null ? String(row.httpStatus) : null} />
          {/* Masked only: a proxy session alias and 4 characters. */}
          <Detail label="Proxy session" value={row.sessionId} mono />
          <Detail label="Token" value={row.tokenSuffix ? `…${row.tokenSuffix}` : null} mono />
          <Detail label="Events" value={String(row.events)} />
          <Detail label="Detail" value={row.detail} />
        </dl>
      )}
    </li>
  );
}

function Detail({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  if (!value) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-foreground/85", mono && "font-mono")}>{value}</dd>
    </>
  );
}
