import { describe, expect, it } from "vitest";
import {
  clampCapturedAt,
  deriveRepStatus,
  isPresentablePosition,
  locationFreshness,
  shouldAcceptFix,
  speedBetween,
  tsMs,
  type RepStatusInput,
} from "@shared/repStatus";
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
} from "@shared/liveOps";
import { MAX_CLOCK_LEAD_MS } from "@shared/geoVerify";

const NOW = Date.parse("2026-08-10T18:00:00.000Z");
const min = (n: number) => n * 60_000;

/** On shift, tracking allowed, nothing else asserted. */
function base(over: Partial<RepStatusInput> = {}): RepStatusInput {
  return {
    nowMs: NOW,
    clockedInAtMs: NOW - min(120),
    pausedAtMs: null,
    lastSeenAtMs: NOW - min(1),
    lastKnockAtMs: null,
    capturedAtMs: NOW - min(1),
    speedMps: 0,
    movedM: 30,
    appointmentActive: false,
    locationDenied: false,
    trackingPermitted: true,
    ...over,
  };
}

describe("location freshness is measured, never assumed", () => {
  it("tiers on the age of the DEVICE fix", () => {
    expect(locationFreshness(NOW, NOW)).toBe("live");
    expect(locationFreshness(NOW - FRESHNESS_LIVE_MS, NOW)).toBe("live");
    expect(locationFreshness(NOW - FRESHNESS_LIVE_MS - 1, NOW)).toBe("recent");
    expect(locationFreshness(NOW - FRESHNESS_RECENT_MS, NOW)).toBe("recent");
    expect(locationFreshness(NOW - FRESHNESS_RECENT_MS - 1, NOW)).toBe("stale");
    expect(locationFreshness(null, NOW)).toBe("none");
  });

  it("NEVER reports a half-hour-old fix as live - the core promise of this screen", () => {
    const half = locationFreshness(NOW - min(30), NOW);
    expect(half).toBe("stale");
    expect(isPresentablePosition(half)).toBe(false);
  });

  it("only live and recent may be drawn as a current position", () => {
    expect(isPresentablePosition("live")).toBe(true);
    expect(isPresentablePosition("recent")).toBe(true);
    expect(isPresentablePosition("stale")).toBe(false);
    expect(isPresentablePosition("none")).toBe(false);
  });

  it("a phone whose clock runs fast cannot forge freshness", () => {
    // Device claims 30 minutes into the future; without clamping that fix would
    // measure as "live" forever.
    const future = NOW + min(30);
    const clamped = clampCapturedAt(future, NOW);
    expect(clamped).toBe(NOW);
    expect(locationFreshness(clamped, NOW + min(30))).toBe("stale");
  });

  it("leaves ordinary lag alone - a queued fix keeps its real age", () => {
    const captured = NOW - min(12);
    expect(clampCapturedAt(captured, NOW)).toBe(captured);
    expect(locationFreshness(captured, NOW)).toBe("stale");
  });

  it("tolerates small skew without pinning it", () => {
    const slightlyAhead = NOW + MAX_CLOCK_LEAD_MS - 1000;
    expect(clampCapturedAt(slightlyAhead, NOW)).toBe(NOW);
  });

  it("parses junk timestamps to null rather than NaN", () => {
    expect(tsMs("not a date")).toBeNull();
    expect(tsMs(null)).toBeNull();
    expect(tsMs("2026-08-10T18:00:00.000Z")).toBe(NOW);
  });
});

describe("rep status precedence", () => {
  it("off shift with a heartbeat is online, not active", () => {
    const r = deriveRepStatus(base({ clockedInAtMs: null, lastSeenAtMs: NOW - min(1) }));
    expect(r.status).toBe("online");
  });

  it("off shift and silent is offline", () => {
    const r = deriveRepStatus(base({
      clockedInAtMs: null,
      lastSeenAtMs: NOW - PRESENCE_OFFLINE_AFTER_MS - 1,
    }));
    expect(r.status).toBe("offline");
  });

  it("a rep-declared break outranks any sensor reading", () => {
    const r = deriveRepStatus(base({
      pausedAtMs: NOW - min(5),
      lastKnockAtMs: NOW - min(1),   // would otherwise be "knocking"
      speedMps: 9,                    // and would otherwise be "traveling"
    }));
    expect(r.status).toBe("break");
    expect(r.sinceMs).toBe(NOW - min(5));
  });

  it("an appointment outranks inferred activity", () => {
    const r = deriveRepStatus(base({ appointmentActive: true, lastKnockAtMs: NOW - min(1) }));
    expect(r.status).toBe("appointment");
  });

  it("a denied GPS reads as location_unavailable, NOT frozen on a last known pin", () => {
    const r = deriveRepStatus(base({ locationDenied: true, capturedAtMs: NOW - min(40) }));
    expect(r.status).toBe("location_unavailable");
  });

  it("no fix at all while tracking is permitted is location_unavailable", () => {
    const r = deriveRepStatus(base({ capturedAtMs: null }));
    expect(r.status).toBe("location_unavailable");
  });

  it("but with tracking switched off, a missing fix is NOT a GPS failure", () => {
    // Nothing is broken - the org does not collect location. The rep still gets
    // a real working status from their knocks.
    const r = deriveRepStatus(base({
      trackingPermitted: false, capturedAtMs: null, lastKnockAtMs: NOW - min(2),
    }));
    expect(r.status).toBe("knocking");
  });

  it("a recent knock is knocking", () => {
    const r = deriveRepStatus(base({ lastKnockAtMs: NOW - min(3), capturedAtMs: NOW - min(4) }));
    expect(r.status).toBe("knocking");
  });

  it("knocking lapses at the window edge", () => {
    const r = deriveRepStatus(base({
      lastKnockAtMs: NOW - KNOCKING_WINDOW_MS - 1,
      capturedAtMs: NOW - min(1),
      movedM: 40,
    }));
    expect(r.status).toBe("active");
  });

  it("knocked, then drove away: the newer signal wins", () => {
    const r = deriveRepStatus(base({
      lastKnockAtMs: NOW - min(4),      // still inside the knocking window
      capturedAtMs: NOW - min(1),       // but the fix is newer
      speedMps: 8,
    }));
    expect(r.status).toBe("traveling");
  });

  it("driving with a stale knock is traveling", () => {
    const r = deriveRepStatus(base({ lastKnockAtMs: null, speedMps: 6 }));
    expect(r.status).toBe("traveling");
  });

  it("on shift but long silent is inactive, never offline", () => {
    const r = deriveRepStatus(base({
      lastKnockAtMs: NOW - INACTIVE_AFTER_MS - min(5),
      capturedAtMs: NOW - INACTIVE_AFTER_MS - min(5),
      speedMps: 0,
      movedM: 2,
    }));
    expect(r.status).toBe("inactive");
  });

  it("working normally is active", () => {
    const r = deriveRepStatus(base({ capturedAtMs: NOW - min(1), movedM: 60, speedMps: 0.5 }));
    expect(r.status).toBe("active");
  });

  it("status is independent of freshness - knocking with a stale fix is still knocking", () => {
    // The exact pair the brief cares about: a true activity status next to an
    // untrustworthy position. Both must survive; neither may overwrite the other.
    const r = deriveRepStatus(base({ lastKnockAtMs: NOW - min(2), capturedAtMs: NOW - min(25) }));
    expect(r.status).toBe("knocking");
    expect(locationFreshness(NOW - min(25), NOW)).toBe("stale");
  });
});

describe("a GPS point is not written every second", () => {
  const at = (mins: number, lat = 35.5, lng = -80.4) =>
    ({ lat, lng, accuracyM: 10, capturedAtMs: NOW - min(mins) });

  it("always keeps the first fix", () => {
    expect(shouldAcceptFix(null, at(0))).toMatchObject({ accept: true, reason: "first-fix" });
  });

  it("drops jitter around a parked car", () => {
    const prev = at(2);
    const barelyMoved = { ...at(1), lat: prev.lat + 0.00005 }; // ~5.5 m
    const d = shouldAcceptFix(prev, barelyMoved);
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("insignificant");
  });

  it("keeps a fix once the rep has actually moved", () => {
    const prev = at(2);
    const moved = { ...at(1), lat: prev.lat + 0.0005 }; // ~55 m
    expect(shouldAcceptFix(prev, moved)).toMatchObject({ accept: true, reason: "moved" });
  });

  it("still reports after a long silence, so a dead phone is distinguishable", () => {
    const prev = { lat: 35.5, lng: -80.4, accuracyM: 10, capturedAtMs: NOW - MAX_SILENCE_MS - 1000 };
    const same = { lat: 35.5, lng: -80.4, accuracyM: 10, capturedAtMs: NOW };
    expect(shouldAcceptFix(prev, same)).toMatchObject({ accept: true, reason: "silence-elapsed" });
  });

  it("the movement floor is the documented one", () => {
    const prev = at(2);
    // ~0.00001 degree of latitude is ~1.1 m; scale to just under/over the floor.
    const justUnder = { ...at(1), lat: prev.lat + (MIN_MOVEMENT_M - 5) / 111_320 };
    const justOver = { ...at(1), lat: prev.lat + (MIN_MOVEMENT_M + 5) / 111_320 };
    expect(shouldAcceptFix(prev, justUnder).accept).toBe(false);
    expect(shouldAcceptFix(prev, justOver).accept).toBe(true);
  });

  it("refuses a fix vaguer than a city block", () => {
    const vague = { ...at(0), accuracyM: MAX_ACCURACY_M + 50 };
    const d = shouldAcceptFix(at(5), vague, { lastGoodAccuracyAtMs: NOW - min(1) });
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("too-vague");
    expect(d.lowConfidence).toBe(true);
  });

  it("...but accepts it FLAGGED once nothing better has arrived", () => {
    const vague = { ...at(0), accuracyM: MAX_ACCURACY_M + 50 };
    const d = shouldAcceptFix(at(30), vague, {
      lastGoodAccuracyAtMs: NOW - ACCURACY_GRACE_MS - 1000,
    });
    expect(d.accept).toBe(true);
    expect(d.lowConfidence).toBe(true);
  });

  it("never walks the pin backwards when an offline queue flushes out of order", () => {
    const newer = at(1);
    const older = { ...at(9), lat: 35.51 };  // far away AND older
    const d = shouldAcceptFix(newer, older);
    expect(d.accept).toBe(false);
    expect(d.reason).toBe("out-of-order");
  });

  it("computes speed between fixes, and nothing from a single one", () => {
    const a = { lat: 35.5, lng: -80.4, accuracyM: 10, capturedAtMs: NOW - 60_000 };
    const b = { lat: 35.5045, lng: -80.4, accuracyM: 10, capturedAtMs: NOW }; // ~500 m
    const v = speedBetween(a, b);
    expect(v).toBeGreaterThan(7);
    expect(v).toBeLessThan(9);
    expect(speedBetween(null, b)).toBeNull();
  });

  it("returns null speed for a zero or negative interval rather than dividing by zero", () => {
    const a = { lat: 35.5, lng: -80.4, accuracyM: 10, capturedAtMs: NOW };
    expect(speedBetween(a, { ...a })).toBeNull();
  });
});
