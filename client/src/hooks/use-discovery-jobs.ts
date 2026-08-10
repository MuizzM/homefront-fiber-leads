import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getStoredSessionId } from "@/lib/queryClient";
import {
  discoveryApi,
  isActiveDiscoveryJob,
  normalizeDiscoveryJob,
  type DiscoveryEvent,
  type DiscoveryJob,
} from "@/lib/discoveryApi";

type JobMap = Record<string, DiscoveryJob>;
type Listener = (event: DiscoveryEvent) => void;

function mergeJob(current: DiscoveryJob | undefined, patch: Partial<DiscoveryJob> & { id: string }): DiscoveryJob {
  const next = normalizeDiscoveryJob({ ...(current ?? {}), ...patch, id: patch.id });
  // Identity-preserving merge: SSE re-sends the same counters constantly during
  // a scan; returning the CURRENT object when nothing observable changed lets
  // the reducer's `state[id] === next` bailout actually fire (it was dead code
  // while this always allocated), so no-change events cost zero renders.
  if (current && equalJob(current, next)) return current;
  return next;
}

function equalJob(a: DiscoveryJob, b: DiscoveryJob): boolean {
  for (const key of JOB_KEYS) {
    const x = (a as any)[key];
    const y = (b as any)[key];
    if (x === y) continue;
    // Object-valued fields (geometry, sources, sourceWarnings) arrive as fresh
    // references per event even when deep-equal; compare by value.
    if (x && y && typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y)) continue;
    return false;
  }
  return true;
}

function reducer(state: JobMap, action:
  | { type: "hydrate"; jobs: DiscoveryJob[] }
  | { type: "upsert"; job: Partial<DiscoveryJob> & { id: string } },
): JobMap {
  if (action.type === "upsert") {
    const next = mergeJob(state[action.job.id], action.job);
    return state[action.job.id] === next ? state : { ...state, [next.id]: next };
  }
  const next = { ...state };
  for (const job of action.jobs) next[job.id] = mergeJob(next[job.id], job);
  return next;
}

const JOB_KEYS = new Set([
  "status", "city", "state", "geometry", "boundarySource", "idempotencyKey",
  "discoveredCount", "uniqueCandidateCount", "validatedCount", "checkedCount",
  "qualifiedCount", "newLeadsCount", "stillFreshCount", "serviceActiveCount",
  "comingSoonCount", "unresolvedCount", "failedCount", "cachedCount", "coverageStatus", "sourceWarnings",
  "sources", "createdAt", "startedAt", "completedAt", "cancelledAt", "error",
]);

function jobPatchFromEvent(event: DiscoveryEvent): (Partial<DiscoveryJob> & { id: string }) | null {
  const payload = event.payload ?? {};
  const nested = payload.job && typeof payload.job === "object" ? payload.job : payload;
  const patch: Record<string, unknown> = { id: event.jobId };
  let hasJobData = false;
  for (const key of JOB_KEYS) {
    if (nested[key] !== undefined) { patch[key] = nested[key]; hasJobData = true; }
  }
  const type = event.eventType.toLowerCase();
  if (!patch.status) {
    if (type.includes("cancel")) patch.status = "cancelled";
    else if (type.includes("partial")) patch.status = "partial";
    else if (type.includes("fail")) patch.status = "failed";
    else if (type.includes("complete") || type.includes("done")) patch.status = "completed";
    else if (type.includes("qualif")) patch.status = "qualifying";
    else if (type.includes("boundar")) patch.status = "resolving_boundary";
    else if (type.includes("discover") || type.includes("source") || type.includes("tile")) patch.status = "discovering";
    else if (type.includes("accept") || type.includes("queue")) patch.status = "queued";
  }
  return hasJobData || patch.status ? patch as Partial<DiscoveryJob> & { id: string } : null;
}

function parseSseBlock(block: string): DiscoveryEvent | null {
  const data = block.split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    if (!parsed || parsed.id == null || !parsed.eventType || !parsed.jobId) return null;
    return {
      id: parsed.id,
      eventType: String(parsed.eventType),
      jobId: String(parsed.jobId),
      payload: parsed.payload && typeof parsed.payload === "object" ? parsed.payload : {},
    };
  } catch {
    return null;
  }
}

/**
 * Tenant-multiplexed discovery transport. SSE is primary; when it drops, the
 * hook re-hydrates active jobs with exponentially backed-off GETs until the
 * stream reconnects. Event listeners are ref-based so hundreds of address
 * events do not force hundreds of React renders.
 *
 * `ownedJobIdRef` (optional): when provided, count-only progress ticks for any
 * OTHER job are dropped before they can dispatch — the server's around-the-
 * clock background/nightly scans stop re-rendering the caller (MapView is
 * ~6,000 lines) 4×/s. Status transitions always render (rare, and terminal
 * events carry the full final counters). Listeners still receive every event —
 * the scan-dot SSE bridge is unaffected.
 */
export function useDiscoveryJobs(
  enabled: boolean,
  ownedJobIdRef?: { readonly current: string | null },
) {
  const [byId, dispatch] = useReducer(reducer, {});
  const [connected, setConnected] = useState(false);
  const [hydrating, setHydrating] = useState(false);
  const listenersRef = useRef(new Set<Listener>());
  const lastEventIdRef = useRef<string | null>(null);
  const byIdRef = useRef<JobMap>({});

  useEffect(() => { byIdRef.current = byId; }, [byId]);

  const hydrate = useCallback(async () => {
    if (!enabled) return [];
    setHydrating(true);
    try {
      const active = await discoveryApi.active();
      const activeIds = new Set(active.map(job => job.id));
      // If SSE dropped immediately before a terminal event, the job disappears
      // from `?active=true`. Resolve only those previously-active missing IDs so
      // the UI cannot remain stuck on "running" forever, without polling every
      // historical job or multiplying requests during healthy streaming.
      const missing = Object.values(byIdRef.current)
        .filter(isActiveDiscoveryJob)
        .filter(job => !activeIds.has(job.id));
      const settled = missing.length
        ? await Promise.allSettled(missing.map(job => discoveryApi.get(job.id)))
        : [];
      const terminal = settled.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
      const jobs = [...active, ...terminal];
      dispatch({ type: "hydrate", jobs });
      return jobs;
    } finally {
      setHydrating(false);
    }
  }, [enabled]);

  const pendingRef = useRef(new Map<string, Partial<DiscoveryJob> & { id: string }>());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPending = useCallback(() => {
    if (flushTimerRef.current != null) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    if (!pendingRef.current.size) return;
    const batch = pendingRef.current;
    pendingRef.current = new Map();
    // Multiple dispatches in one tick — React batches them into a single render.
    for (const job of batch.values()) dispatch({ type: "upsert", job });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const publish = (event: DiscoveryEvent) => {
      lastEventIdRef.current = String(event.id);
      const patch = jobPatchFromEvent(event);
      if (patch) {
        if (patch.status) {
          // Status transitions render immediately (a tap must feel instant) —
          // flush any buffered counters first so ordering is preserved.
          flushPending();
          dispatch({ type: "upsert", job: patch });
        } else if (ownedJobIdRef && patch.id !== ownedJobIdRef.current) {
          // Unowned job's count tick — the caller renders nothing from it.
          // Drop it here instead of waking a 6k-line tree 4×/s.
        } else {
          // Count-only progress (checked/qualified/discovered ticks arrive many
          // times per second during a town scan): coalesce to ≤4 renders/s so the
          // map stays at 60fps while the counters still feel live.
          const prev = pendingRef.current.get(patch.id);
          pendingRef.current.set(patch.id, prev ? { ...prev, ...patch, id: patch.id } : patch);
          if (flushTimerRef.current == null) flushTimerRef.current = setTimeout(flushPending, 250);
        }
      }
      for (const listener of listenersRef.current) listener(event);
    };

    const connect = async () => {
      const sessionId = getStoredSessionId();
      if (stopped || !sessionId) return;
      controller = new AbortController();
      try {
        const headers: Record<string, string> = { "x-session-id": sessionId };
        if (lastEventIdRef.current) headers["last-event-id"] = lastEventIdRef.current;
        const response = await fetch("/api/discovery/events", {
          headers,
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`discovery stream ${response.status}`);
        setConnected(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          // Reset the backoff on the first DELIVERED CHUNK, not on response
          // headers. Headers arriving proves the request was routed; it does not
          // prove the stream works. When the stream then ends immediately (the
          // throw below), `attempt` was already back to 0, so the delay computed
          // 1_000 * 2**0 = 1000ms on every single cycle and the exponential
          // backoff could never engage.
          //
          // Measured in production 2026-08-10: GET /api/discovery/jobs/:uuid was
          // called 588 times in 15 minutes - one per 1.5s - totalling 199,576ms,
          // about 23% of all server time in the window, for what is structurally
          // a primary-key lookup.
          attempt = 0;
          buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
          for (;;) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary < 0) break;
            const event = parseSseBlock(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (event) publish(event);
          }
        }
        if (!stopped) throw new Error("discovery stream ended");
      } catch (error: any) {
        if (stopped || error?.name === "AbortError") return;
      } finally {
        if (!stopped) setConnected(false);
      }

      if (stopped) return;
      // The fallback is deliberately one request at a time. It both restores
      // progress and proves the authenticated API is reachable before SSE retry.
      try { await hydrate(); } catch { /* retain the last honest snapshot */ }
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt++, 5));
      retryTimer = setTimeout(() => void connect(), delay);
    };

    void hydrate().catch(() => {});
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      flushPending(); // deliver any buffered counters before teardown
      setConnected(false);
    };
  }, [enabled, hydrate, flushPending]);

  const subscribe = useCallback((listener: Listener) => {
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const submit = useCallback(async (input: Parameters<typeof discoveryApi.create>[0]) => {
    const job = await discoveryApi.create(input);
    dispatch({ type: "upsert", job });
    return job;
  }, []);

  const cancel = useCallback(async (id: string) => {
    const job = await discoveryApi.cancel(id);
    dispatch({ type: "upsert", job });
    return job;
  }, []);

  const jobs = useMemo(() => Object.values(byId).sort((a, b) =>
    Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "")), [byId]);
  const activeJobs = useMemo(() => jobs.filter(isActiveDiscoveryJob), [jobs]);

  return { jobs, activeJobs, connected, hydrating, hydrate, submit, cancel, subscribe };
}
