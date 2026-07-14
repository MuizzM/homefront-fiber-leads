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
  return normalizeDiscoveryJob({ ...(current ?? {}), ...patch, id: patch.id });
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
  "qualifiedCount", "failedCount", "cachedCount", "coverageStatus", "sourceWarnings",
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
 */
export function useDiscoveryJobs(enabled: boolean) {
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

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const publish = (event: DiscoveryEvent) => {
      lastEventIdRef.current = String(event.id);
      const patch = jobPatchFromEvent(event);
      if (patch) dispatch({ type: "upsert", job: patch });
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
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
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
      setConnected(false);
    };
  }, [enabled, hydrate]);

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
