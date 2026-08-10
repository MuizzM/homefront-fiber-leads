// ── Rep status and location freshness ────────────────────────────────────────
//
// ONE derivation, used by the ingest route, the dashboard projection and the
// rep's own indicator. Today three screens each compute "active" differently -
// LiveMap calls it a ping inside 15 minutes, ClockIn calls it an open shift,
// Team calls it the roster employment flag - and they disagree on screen. This
// file is the single answer.
//
// The load-bearing idea is that STATUS and FRESHNESS are different questions.
// "Saad is knocking" and "we last heard from Saad's phone 18 minutes ago" are
// both true at once, and a dashboard that merges them into one green dot tells
// a supervisor something false. Everything here keeps them apart.

import { haversineMeters } from "./knock";
import { MAX_CLOCK_LEAD_MS } from "./geoVerify";
import {
  ACCURACY_GRACE_MS,
  FRESHNESS_LIVE_MS,
  FRESHNESS_RECENT_MS,
  INACTIVE_AFTER_MS,
  KNOCKING_WINDOW_MS,
  MAX_ACCURACY_M,
  MAX_SILENCE_MS,
  MIN_MOVEMENT_M,
  PRESENCE_OFFLINE_AFTER_MS,
  TRAVELING_SPEED_MPS,
  type LocationFreshness,
  type RepStatus,
} from "./liveOps";

/** Parse an ISO timestamp to epoch ms, or null. Never throws on junk. */
export function tsMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The device clock, clamped so it cannot claim the future.
 *
 * Phones drift, and a handset set minutes ahead would otherwise make a stale
 * fix measure as brand new - the exact failure the brief forbids, arriving
 * through the back door. A fix that claims to be from after the server received
 * it is pinned to the receipt time; the same MAX_CLOCK_LEAD_MS tolerance the
 * knock verifier already applies. Lag is left alone: a fix genuinely captured
 * before it could be uploaded is normal and its real age is the honest one.
 */
export function clampCapturedAt(capturedAtMs: number | null, receivedAtMs: number): number | null {
  if (capturedAtMs == null) return null;
  if (capturedAtMs > receivedAtMs + MAX_CLOCK_LEAD_MS) return receivedAtMs;
  return Math.min(capturedAtMs, receivedAtMs);
}

/**
 * How much to trust a position, from the age of the DEVICE fix.
 *
 * Measured against capture rather than receipt because that is when the rep was
 * actually standing there; a point that sat in an offline queue for ten minutes
 * is ten minutes old however promptly it uploaded.
 */
export function locationFreshness(capturedAtMs: number | null, nowMs: number): LocationFreshness {
  if (capturedAtMs == null) return "none";
  const age = nowMs - capturedAtMs;
  if (age < 0) return "live";               // clamped upstream; treat as now
  if (age <= FRESHNESS_LIVE_MS) return "live";
  if (age <= FRESHNESS_RECENT_MS) return "recent";
  return "stale";
}

/** Freshness tiers that may be drawn as a rep's CURRENT position. */
export function isPresentablePosition(freshness: LocationFreshness): boolean {
  return freshness === "live" || freshness === "recent";
}

export interface RepStatusInput {
  nowMs: number;
  clockedInAtMs: number | null;
  /** Rep-declared pause, when org policy permits one. */
  pausedAtMs: number | null;
  /** Last app heartbeat, for the logged-in-but-off-shift case. */
  lastSeenAtMs: number | null;
  lastKnockAtMs: number | null;
  capturedAtMs: number | null;
  speedMps: number | null;
  /** Distance from the previous accepted fix; null when there is no previous. */
  movedM: number | null;
  appointmentActive: boolean;
  /** The device said it cannot supply a fix (permission denied, timeout). */
  locationDenied: boolean;
  /** Policy/consent allow collection at all. When false, absence of a fix is
   *  expected and must NOT be reported as a GPS failure. */
  trackingPermitted: boolean;
}

export interface RepStatusResult {
  status: RepStatus;
  /** When this status began, as far as the inputs can say. */
  sinceMs: number | null;
}

/**
 * The rep's working state.
 *
 * Precedence is "most specific true thing wins", and the order matters:
 *
 *   off-shift first, because a logged-in rep who is not clocked in is not being
 *   tracked and none of the field states can apply to them;
 *   then rep-declared intent (break, appointment), because a human saying what
 *   they are doing outranks anything inferred from sensors;
 *   then a stated inability to locate, so a denied-GPS rep reads as
 *   `location_unavailable` rather than being frozen on their last known point -
 *   which would be the worst lie this screen could tell;
 *   then the freshest evidence - a knock or a fix - with the more recent of the
 *   two winning, so a rep who knocked then drove away shows as traveling;
 *   then silence, which is `inactive`, not `offline` - they are still on shift.
 */
export function deriveRepStatus(input: RepStatusInput): RepStatusResult {
  const {
    nowMs, clockedInAtMs, pausedAtMs, lastSeenAtMs, lastKnockAtMs,
    capturedAtMs, speedMps, movedM, appointmentActive, locationDenied,
    trackingPermitted,
  } = input;

  // ── Off shift ──────────────────────────────────────────────────────────────
  if (clockedInAtMs == null) {
    const seenAge = lastSeenAtMs == null ? Infinity : nowMs - lastSeenAtMs;
    return seenAge <= PRESENCE_OFFLINE_AFTER_MS
      ? { status: "online", sinceMs: lastSeenAtMs }
      : { status: "offline", sinceMs: lastSeenAtMs };
  }

  // ── Declared intent ────────────────────────────────────────────────────────
  if (pausedAtMs != null) return { status: "break", sinceMs: pausedAtMs };
  if (appointmentActive) return { status: "appointment", sinceMs: clockedInAtMs };

  // ── Cannot locate ──────────────────────────────────────────────────────────
  // Only when we were supposed to be able to. With tracking switched off by
  // policy there is nothing broken to report, and the rep still gets a working
  // status from their knocks.
  if (trackingPermitted && (locationDenied || capturedAtMs == null)) {
    return { status: "location_unavailable", sinceMs: clockedInAtMs };
  }

  // ── Freshest evidence wins ─────────────────────────────────────────────────
  const knockAge = lastKnockAtMs == null ? Infinity : nowMs - lastKnockAtMs;
  const knockIsRecent = knockAge <= KNOCKING_WINDOW_MS;
  const moving = (speedMps ?? 0) >= TRAVELING_SPEED_MPS;
  const fixNewerThanKnock =
    capturedAtMs != null && (lastKnockAtMs == null || capturedAtMs > lastKnockAtMs);

  if (moving && fixNewerThanKnock) return { status: "traveling", sinceMs: capturedAtMs };
  if (knockIsRecent) return { status: "knocking", sinceMs: lastKnockAtMs };
  if (moving) return { status: "traveling", sinceMs: capturedAtMs };

  // ── Silence ────────────────────────────────────────────────────────────────
  // On shift but nothing happening: no knock in the window and no meaningful
  // movement. Still `inactive`, never `offline` - the shift is open.
  const stillFor = Math.min(
    knockAge,
    capturedAtMs == null ? Infinity : nowMs - capturedAtMs,
  );
  const wentNowhere = movedM != null && movedM < MIN_MOVEMENT_M;
  if (stillFor >= INACTIVE_AFTER_MS || (wentNowhere && knockAge >= INACTIVE_AFTER_MS)) {
    return { status: "inactive", sinceMs: capturedAtMs ?? clockedInAtMs };
  }

  return { status: "active", sinceMs: capturedAtMs ?? clockedInAtMs };
}

export interface FixCandidate {
  lat: number;
  lng: number;
  accuracyM: number | null;
  capturedAtMs: number;
}

export interface FixDecision {
  accept: boolean;
  /** Set when accepted despite poor accuracy, so the UI widens its uncertainty. */
  lowConfidence: boolean;
  reason: "first-fix" | "moved" | "silence-elapsed" | "insignificant" | "too-vague" | "out-of-order";
}

/**
 * Should this fix be written at all?
 *
 * This is the whole answer to "do not write a GPS point every second", and it
 * lives in shared/ because the phone and the ingest route must apply the SAME
 * rule. If the server were merely stricter, a rep's battery would pay for
 * uploads that get thrown away; if it were merely looser, the client would be
 * the only thing standing between the table and unbounded growth.
 *
 * A fix is worth storing when the rep has actually moved, or when enough
 * silence has passed that "no news" would otherwise be indistinguishable from a
 * dead handset. Anything else is jitter around a parked car.
 */
export function shouldAcceptFix(
  prev: FixCandidate | null,
  next: FixCandidate,
  opts: { lastGoodAccuracyAtMs?: number | null } = {},
): FixDecision {
  // A fix vaguer than a city block is worse than none: it would paint a
  // confident pin on the wrong street. Held back until nothing better has
  // arrived for a while, then let through FLAGGED rather than silently.
  if (next.accuracyM != null && next.accuracyM > MAX_ACCURACY_M) {
    const lastGood = opts.lastGoodAccuracyAtMs ?? null;
    const starved = lastGood == null || next.capturedAtMs - lastGood >= ACCURACY_GRACE_MS;
    if (!starved) return { accept: false, lowConfidence: true, reason: "too-vague" };
    return { accept: true, lowConfidence: true, reason: "silence-elapsed" };
  }

  if (prev == null) return { accept: true, lowConfidence: false, reason: "first-fix" };

  // Out-of-order arrival from a flushed offline queue. Never let an older fix
  // overwrite a newer one - that would walk the pin backwards.
  if (next.capturedAtMs <= prev.capturedAtMs) {
    return { accept: false, lowConfidence: false, reason: "out-of-order" };
  }

  const moved = haversineMeters(
    { lat: prev.lat, lng: prev.lng },
    { lat: next.lat, lng: next.lng },
  );
  if (moved >= MIN_MOVEMENT_M) return { accept: true, lowConfidence: false, reason: "moved" };

  const silence = next.capturedAtMs - prev.capturedAtMs;
  if (silence >= MAX_SILENCE_MS) {
    return { accept: true, lowConfidence: false, reason: "silence-elapsed" };
  }

  return { accept: false, lowConfidence: false, reason: "insignificant" };
}

/** Metres per second between two fixes, or null when it cannot be known. */
export function speedBetween(prev: FixCandidate | null, next: FixCandidate): number | null {
  if (prev == null) return null;
  const dtSec = (next.capturedAtMs - prev.capturedAtMs) / 1000;
  if (dtSec <= 0) return null;
  const meters = haversineMeters(
    { lat: prev.lat, lng: prev.lng },
    { lat: next.lat, lng: next.lng },
  );
  return meters / dtSec;
}
