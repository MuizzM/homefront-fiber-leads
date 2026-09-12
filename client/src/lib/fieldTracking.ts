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
import { useAuth } from "./auth";
import { currentWorkLease, isCurrentWorkLease, workOwner, workJson } from "./workAuthority";
import { appendFieldFix, flushFieldFixes, queuedFieldFixes, type QueuedFix } from "./fieldFixQueue";
import { shouldAcceptFix, type FixCandidate } from "@shared/repStatus";
import {
  MAX_ACCURACY_M,
  MIN_INGEST_GAP_MS,
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

/**
 * Arms location sampling only when the server says it may run.
 *
 * Returns everything the tracking indicator needs, so the rep can always see
 * whether they are being tracked and why not when they are not.
 */
export function useFieldTracking(enabled = true): TrackingRuntime {
  const { user } = useAuth();
  const lease = user ? currentWorkLease(workOwner(user)) : null;
  const [state, setState] = useState<TrackingState>(IDLE);
  const [denied, setDenied] = useState(false);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const lastFix = useRef<FixCandidate | null>(null);
  const allowed = useRef(false);
  const mounted = useRef(false);
  const refreshVersion = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useCallback(() => mounted.current && enabled && isCurrentWorkLease(lease), [enabled, lease]);

  const refresh = useCallback(() => {
    if (!live()) return;
    const version = ++refreshVersion.current;
    void workJson(lease, "GET", "/api/live-ops/me", undefined).then(body => {
      if (!live() || version !== refreshVersion.current) return;
      allowed.current = body?.tracking === true;
      setState({ ...IDLE, ...body });
    }).catch(() => {
      if (!live() || version !== refreshVersion.current) return;
      allowed.current = false; setState(IDLE);
    });
  }, [lease, live]);

  useEffect(() => {
    mounted.current = true; allowed.current = false; lastFix.current = null;
    setState(IDLE); setLastSentAt(null); setDenied(false); setQueuedCount(queuedFieldFixes(lease));
    if (enabled && lease) refresh();
    const stop = () => { allowed.current = false; refreshVersion.current++; if (retryTimer.current) clearTimeout(retryTimer.current); setState(IDLE); };
    lease?.signal.addEventListener("abort", stop, { once: true });
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const id = enabled && lease ? setInterval(refresh, 60_000) : null;
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false; allowed.current = false; refreshVersion.current++;
      if (id) clearInterval(id);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      lease?.signal.removeEventListener("abort", stop);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, lease, refresh]);

  const flush = useCallback(async () => {
    if (!live() || !allowed.current || !lease) return;
    const result = await flushFieldFixes(lease, async ({ id: _id, ...fix }) => {
      if (!live() || !allowed.current) throw new Error("Location delivery suspended");
      const body = await workJson(lease, "POST", "/api/live-ops/ping", fix);
      if (!live()) throw new Error("Location delivery suspended");
      if (body?.stored === false && body.reason === "rate-limited") return { retryAfterMs: MIN_INGEST_GAP_MS };
      const stop = body?.stored === false && ["policy-off", "not-clocked-in", "revoked", "paused", "not-disclosed", "disclosure-outdated", "no-tenant"].includes(body.reason);
      if (stop) { allowed.current = false; refreshVersion.current++; setState(s => ({ ...s, tracking: false, reason: body.reason })); }
      if (body?.stored) setLastSentAt(Date.now());
      return { stop: !!stop };
    });
    if (live()) {
      setQueuedCount(queuedFieldFixes(lease));
      if (result.retryAfterMs && allowed.current) {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => { retryTimer.current = null; void flush(); }, result.retryAfterMs);
      }
    }
  }, [lease, live]);

  const send = useCallback((fix: QueuedFix) => {
    if (!live() || !allowed.current || !lease) return;
    appendFieldFix(lease, fix); setQueuedCount(queuedFieldFixes(lease)); void flush();
  }, [lease, live, flush]);

  useEffect(() => {
    if (!enabled || !state.tracking) return;
    void flush();
    const onOnline = () => { refresh(); };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [enabled, state, flush, refresh]);

  useEffect(() => {
    if (!live() || !state.tracking || !navigator.geolocation) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const current = () => !stopped && live() && allowed.current;
    const schedule = (speed: number | null) => {
      if (!current()) return;
      const delay = document.visibilityState === "hidden" ? PING_INTERVAL_HIDDEN_MS
        : (speed ?? 0) >= TRAVELING_SPEED_MPS ? PING_INTERVAL_MOVING_MS : PING_INTERVAL_STATIONARY_MS;
      timer = setTimeout(step, delay);
    };
    const step = () => {
      if (!current()) return;
      navigator.geolocation.getCurrentPosition(pos => {
        if (!current()) return;
        setDenied(false);
        const next: FixCandidate = { lat: pos.coords.latitude, lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy ?? null, capturedAtMs: pos.timestamp || Date.now() };
        if (shouldAcceptFix(lastFix.current, next, { lastGoodAccuracyAtMs: lastFix.current?.capturedAtMs ?? null }).accept) {
          lastFix.current = next;
          send({ lat: next.lat, lng: next.lng, accuracyM: next.accuracyM, capturedAt: new Date(next.capturedAtMs).toISOString() });
        }
        schedule(pos.coords.speed ?? null);
      }, () => {
        if (!current()) return;
        setDenied(true);
        void workJson(lease, "POST", "/api/live-ops/ping", { locationDenied: true }).catch(() => {});
        schedule(null);
      }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
    };
    const stop = () => { stopped = true; if (timer) clearTimeout(timer); };
    lease?.signal.addEventListener("abort", stop, { once: true });
    step();
    return () => { stop(); lease?.signal.removeEventListener("abort", stop); };
  }, [state.tracking, lease, live, send]);

  const acknowledge = useCallback(async () => {
    if (!live()) return;
    await workJson(lease, "POST", "/api/live-ops/consent/acknowledge", {});
    if (live()) refresh();
  }, [lease, live, refresh]);
  const setPaused = useCallback(async (paused: boolean) => {
    if (!live()) return;
    await workJson(lease, "POST", "/api/live-ops/consent/pause", { paused });
    if (live()) refresh();
  }, [lease, live, refresh]);
  return { ...state, active: live() && state.tracking, denied, lastSentAt, queuedCount, refresh, acknowledge, setPaused };
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
