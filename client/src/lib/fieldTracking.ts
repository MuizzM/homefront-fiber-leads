// ── Field location tracking, on the rep's phone ──────────────────────────────
//
// Three things this has to get right, in priority order.
//
// 1. NEVER RUN WHEN IT SHOULD NOT. The server refuses an off-shift fix, but a
//    client that keeps asking the GPS anyway has already taken the reading -
//    the refusal happens after the battery is spent and after the handset has
//    located its owner. So the loop is armed from the server's own answer
//    (`/api/live-ops/me`) and disarms itself the moment that answer changes.
//
// 2. COST THE REP AS LITTLE BATTERY AS POSSIBLE. Sampling follows what the rep
//    is doing rather than a fixed tick, and a fix that says nothing new is
//    discarded before it becomes a request.
//
// 3. BE VISIBLE. Everything the indicator needs is exposed as state, because a
//    tracker a rep cannot see running is one they cannot trust.
//
// The accept/reject rule itself lives in shared/repStatus so the phone and the
// ingest route apply exactly the same one. If the client were merely stricter
// the rep would pay for uploads that get thrown away; if it were merely looser
// the client would be the only thing standing between the table and unbounded
// growth.

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { shouldAcceptFix, type FixCandidate } from "@shared/repStatus";
import {
  MAX_ACCURACY_M,
  PING_INTERVAL_HIDDEN_MS,
  PING_INTERVAL_MOVING_MS,
  PING_INTERVAL_STATIONARY_MS,
  TRAVELING_SPEED_MPS,
} from "@shared/liveOps";

export interface TrackingState {
  /** The server's answer: is a fix allowed to be recorded right now. */
  tracking: boolean;
  reason: string;
  needsDisclosure: boolean;
  paused: boolean;
  canPause: boolean;
  retentionDays: number;
  clockedIn: boolean;
}

export interface TrackingRuntime extends TrackingState {
  /** True while the loop is actually armed and sampling. */
  active: boolean;
  /** The device refused or could not supply a fix. Surfaced so the UI can say
   *  "location unavailable" rather than showing a stale position as current. */
  denied: boolean;
  lastSentAt: number | null;
  queuedCount: number;
  refresh: () => void;
  acknowledge: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
}

const IDLE: TrackingState = {
  tracking: false, reason: "unknown", needsDisclosure: false,
  paused: false, canPause: true, retentionDays: 7, clockedIn: false,
};

/** Queue key. Fixes that could not be sent wait here rather than being lost -
 *  a rep working a basement should not leave a hole in their own shift. */
const QUEUE_KEY = "hfs.fieldTracking.queue";
const QUEUE_MAX = 200;

interface QueuedFix { lat: number; lng: number; accuracyM: number | null; capturedAt: string }

function readQueue(): QueuedFix[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-QUEUE_MAX) : [];
  } catch { return []; }
}

function writeQueue(items: QueuedFix[]): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items.slice(-QUEUE_MAX))); }
  catch { /* storage full or blocked; the queue is best-effort */ }
}

/**
 * Arms location sampling only when the server says it may run.
 *
 * Returns everything the tracking indicator needs, so the rep can always see
 * whether they are being tracked and why not when they are not.
 */
export function useFieldTracking(enabled = true): TrackingRuntime {
  const [state, setState] = useState<TrackingState>(IDLE);
  const [denied, setDenied] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);

  const lastFix = useRef<FixCandidate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const refresh = useCallback(() => {
    apiRequest("GET", "/api/live-ops/me")
      .then((r) => r.json())
      .then((body) => setState({ ...IDLE, ...body }))
      .catch(() => setState(IDLE));   // unreachable server means do not sample
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    // Re-ask on a slow cadence AND whenever the tab comes back, so a shift that
    // ended on another device stops this one too.
    const id = setInterval(refresh, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, refresh]);

  /** Send one fix, queueing it if the network is gone. */
  const send = useCallback(async (fix: QueuedFix) => {
    try {
      const res = await apiRequest("POST", "/api/live-ops/ping", fix);
      const body = await res.json().catch(() => ({}));
      // A refusal is authoritative: stop sampling until the next /me poll says
      // otherwise, rather than retrying into a closed door.
      if (body?.stored === false && body?.reason && body.reason !== "insignificant") {
        if (["policy-off", "not-clocked-in", "revoked", "paused", "not-disclosed"].includes(body.reason)) {
          setState((s) => ({ ...s, tracking: false, reason: body.reason }));
        }
      }
      if (body?.stored) setLastSentAt(Date.now());
      return true;
    } catch {
      const q = readQueue();
      q.push(fix);
      writeQueue(q);
      setQueuedCount(q.length);
      return false;
    }
  }, []);

  /** Drain whatever the network took from us. Ordered oldest-first so the
   *  server's out-of-order guard never has to reject a queued fix. */
  const flush = useCallback(async () => {
    let q = readQueue();
    if (q.length === 0) return;
    q = [...q].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    writeQueue([]);
    setQueuedCount(0);
    for (const fix of q) {
      const ok = await send(fix);
      if (!ok) break;   // still offline; send() has re-queued it
    }
  }, [send]);

  useEffect(() => {
    if (!enabled) return;
    const onOnline = () => { flush(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [enabled, flush]);

  // ── The sampling loop ──────────────────────────────────────────────────────
  useEffect(() => {
    stopped.current = false;
    if (!enabled || !state.tracking || typeof navigator === "undefined" || !navigator.geolocation) {
      if (timer.current) clearTimeout(timer.current);
      return;
    }

    const step = () => {
      if (stopped.current) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setDenied(false);
          const next: FixCandidate = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracyM: pos.coords.accuracy ?? null,
            capturedAtMs: pos.timestamp || Date.now(),
          };
          // The same rule the server applies. Deciding here is what keeps a
          // parked car from generating a request every minute.
          const decision = shouldAcceptFix(lastFix.current, next, {
            lastGoodAccuracyAtMs: lastFix.current?.capturedAtMs ?? null,
          });
          if (decision.accept) {
            lastFix.current = next;
            void send({
              lat: next.lat, lng: next.lng, accuracyM: next.accuracyM,
              capturedAt: new Date(next.capturedAtMs).toISOString(),
            });
          }
          schedule(pos.coords.speed ?? null);
        },
        () => {
          // Denied or timed out. Report it as a STATUS rather than letting the
          // last known position quietly stand in for the current one.
          setDenied(true);
          apiRequest("POST", "/api/live-ops/ping", { locationDenied: true }).catch(() => {});
          schedule(null);
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
      );
    };

    const schedule = (speedMps: number | null) => {
      if (stopped.current) return;
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const moving = (speedMps ?? 0) >= TRAVELING_SPEED_MPS;
      const delay = hidden
        ? PING_INTERVAL_HIDDEN_MS
        : moving ? PING_INTERVAL_MOVING_MS : PING_INTERVAL_STATIONARY_MS;
      timer.current = setTimeout(step, delay);
    };

    step();
    return () => {
      stopped.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, state.tracking, send]);

  useEffect(() => { setQueuedCount(readQueue().length); }, []);

  const acknowledge = useCallback(async () => {
    await apiRequest("POST", "/api/live-ops/consent/acknowledge", {});
    refresh();
  }, [refresh]);

  const setPaused = useCallback(async (paused: boolean) => {
    await apiRequest("POST", "/api/live-ops/consent/pause", { paused });
    refresh();
  }, [refresh]);

  return {
    ...state,
    active: enabled && state.tracking,
    denied,
    lastSentAt,
    queuedCount,
    refresh,
    acknowledge,
    setPaused,
  };
}

/** Human-readable reason, for the indicator. */
export function trackingReasonLabel(reason: string): string {
  switch (reason) {
    case "ok": return "Sharing location";
    case "policy-off": return "Location sharing is off for your company";
    case "not-disclosed": return "Review how location is used to continue";
    case "disclosure-outdated": return "The location notice has changed - please review it";
    case "revoked": return "You turned location sharing off";
    case "paused": return "Paused by you";
    case "not-clocked-in": return "Off shift - not sharing";
    default: return "Not sharing";
  }
}

/** Accuracy in words. A number in metres means nothing to a rep on a doorstep. */
export function accuracyLabel(accuracyM: number | null | undefined): string {
  if (accuracyM == null) return "Accuracy unknown";
  if (accuracyM <= 15) return "Precise";
  if (accuracyM <= MAX_ACCURACY_M) return "Approximate";
  return "Very approximate";
}
