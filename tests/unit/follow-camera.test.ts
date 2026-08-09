import { describe, it, expect } from "vitest";
import {
  createFollowState, ingestFix, stepFrame, filteredLngLat, FOLLOW,
  type FollowFix, type FollowState,
} from "../../client/src/lib/followCamera";

// ── Deterministic jitter ──────────────────────────────────────────────────────
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const ANCHOR = { lat: 35.4107, lon: -80.58 };
const COS = Math.cos(ANCHOR.lat * Math.PI / 180);
const mToLat = (m: number) => m / FOLLOW.DEG_M;
const mToLon = (m: number) => m / (FOLLOW.DEG_M * COS);

// Build a fix stream driving along `headingDeg` at `speed` m/s with ±jitter metres.
function drive(opts: {
  speed: number; headingDeg?: number; seconds: number; jitter: number; seed: number;
  hz?: number; doppler?: boolean; startM?: number;
}): FollowFix[] {
  const { speed, headingDeg = 0, seconds, jitter, seed, hz = 1, doppler = true, startM = 0 } = opts;
  const rnd = lcg(seed);
  const hdg = headingDeg * Math.PI / 180;
  const fixes: FollowFix[] = [];
  for (let i = 0; i <= seconds * hz; i++) {
    const t = i / hz;
    const dist = startM + speed * t;
    const dN = dist * Math.cos(hdg) + (rnd() * 2 - 1) * jitter;
    const dE = dist * Math.sin(hdg) + (rnd() * 2 - 1) * jitter;
    fixes.push({
      lat: ANCHOR.lat + mToLat(dN), lon: ANCHOR.lon + mToLon(dE),
      speed: doppler ? speed : null, heading: doppler ? headingDeg : null, tSec: t,
    });
  }
  return fixes;
}

interface Sample { t: number; camx: number; camy: number; parked: boolean; spd: number }
// Ingest fixes at their tSec and step the render loop at `fps` between them.
function pump(M: FollowState, fixes: FollowFix[], opts: { fps?: number; tail?: number } = {}): Sample[] {
  const fps = opts.fps ?? 60, frameDt = 1 / fps, tail = opts.tail ?? 2;
  const end = fixes[fixes.length - 1].tSec + tail;
  const out: Sample[] = [];
  let fi = 0;
  for (let t = fixes[0].tSec; t <= end + 1e-9; t += frameDt) {
    while (fi < fixes.length && fixes[fi].tSec <= t + 1e-9) { ingestFix(M, fixes[fi]); fi++; }
    const f = stepFrame(M, t);
    if (f) out.push({ t, camx: M.cam.x, camy: M.cam.y, parked: f.parked, spd: M.spd });
  }
  return out;
}

const dist = (a: Sample, b: Sample) => Math.hypot(a.camx - b.camx, a.camy - b.camy);

describe("followCamera - first fix + geometry", () => {
  it("seeds camera exactly on the first fix (no glide-in from null island)", () => {
    const M = createFollowState();
    const r = ingestFix(M, { lat: ANCHOR.lat, lon: ANCHOR.lon, speed: 0, heading: null, tSec: 0 });
    expect(r.firstFix).toBe(true);
    expect(M.cam.x).toBeCloseTo(0, 6);
    expect(M.cam.y).toBeCloseTo(0, 6);
    const ll = filteredLngLat(M)!;
    expect(ll[0]).toBeCloseTo(ANCHOR.lon, 6);
    expect(ll[1]).toBeCloseTo(ANCHOR.lat, 6);
  });

  it("stepFrame returns null before any fix", () => {
    expect(stepFrame(createFollowState(), 0)).toBeNull();
  });
});

describe("followCamera - no shake (the field complaint)", () => {
  it("rejects ±5 m jitter into low lateral wobble while cruising straight", () => {
    const M = createFollowState();
    const s = pump(M, drive({ speed: 13.4, headingDeg: 0, seconds: 14, jitter: 5, seed: 7 }));
    const warm = s.filter(x => x.t > 4 && x.t < 13); // steady segment
    // Driving due north → true east (camx) is 0; ±5 m east jitter must be filtered small.
    const maxLat = Math.max(...warm.map(x => Math.abs(x.camx)));
    expect(maxLat).toBeLessThan(3.5); // < ~0.7× raw jitter
  });

  it("moves at near-constant velocity (no per-fix restart stutter)", () => {
    const M = createFollowState();
    // ±3 m is realistic 30 mph high-accuracy GPS; the metric is smoothness, not jitter size.
    const s = pump(M, drive({ speed: 13.4, headingDeg: 0, seconds: 16, jitter: 3, seed: 11 }), { fps: 60 });
    const warm = s.filter(x => x.t > 5 && x.t < 15);
    const speeds: number[] = [];
    for (let i = 1; i < warm.length; i++) speeds.push(dist(warm[i], warm[i - 1]) / (warm[i].t - warm[i - 1].t));
    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const std = Math.sqrt(speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length);
    expect(mean).toBeGreaterThan(11); // actually tracking the 13.4 m/s motion
    // Coefficient of variation low = smooth; the old 1 Hz easeTo-restart sawtooth was ~0.5+.
    expect(std / mean).toBeLessThan(0.15);
    // No single-frame velocity step > 25% of mean (a restart discontinuity / the "shake").
    let maxStep = 0;
    for (let i = 1; i < speeds.length; i++) maxStep = Math.max(maxStep, Math.abs(speeds[i] - speeds[i - 1]));
    expect(maxStep / mean).toBeLessThan(0.25);
  });

  it("is dead-still (freeze) and PARKS when stationary under typical ±5 m jitter", () => {
    const M = createFollowState();
    const s = pump(M, drive({ speed: 0, seconds: 30, jitter: 5, seed: 3 }), { tail: 3 });
    const tail = s.filter(x => x.t > 8);
    let wander = 0;
    for (let i = 0; i < tail.length; i++) for (let j = i + 1; j < tail.length; j++) wander = Math.max(wander, dist(tail[i], tail[j]));
    expect(wander).toBeLessThan(1.5);          // ±5 m raw shake → sub-1.5 m camera
    expect(s[s.length - 1].parked).toBe(true); // rAF would cancel → 0 CPU
  });

  it("stays calm even under extreme urban ±12 m jitter while parked", () => {
    const M = createFollowState();
    const s = pump(M, drive({ speed: 0, seconds: 30, jitter: 12, seed: 8 }), { tail: 3 });
    const tail = s.filter(x => x.t > 8);
    let wander = 0;
    for (let i = 0; i < tail.length; i++) for (let j = i + 1; j < tail.length; j++) wander = Math.max(wander, dist(tail[i], tail[j]));
    expect(wander).toBeLessThan(4.0);          // 24 m p2p raw → sub-4 m camera (≥6× calmer)
    expect(s[s.length - 1].parked).toBe(true);
  });
});

describe("followCamera - responsiveness + robustness", () => {
  it("does not overshoot when decelerating to a stop (Doppler-reported)", () => {
    const M = createFollowState();
    // cruise, then a realistic 3 s deceleration (Doppler falls), then parked.
    const speeds = [13.4, 13.4, 13.4, 13.4, 13.4, 13.4, 10, 6, 2.5, 0, 0, 0, 0, 0, 0];
    const fixes: FollowFix[] = [];
    let y = 0;
    for (let t = 0; t < speeds.length; t++) {
      fixes.push({ lat: ANCHOR.lat + mToLat(y), lon: ANCHOR.lon, speed: speeds[t], heading: speeds[t] > 0 ? 0 : null, tSec: t });
      y += speeds[t];
    }
    const stopY = y;
    const s = pump(M, fixes, { tail: 2 });
    const maxY = Math.max(...s.map(x => x.camy));
    expect(maxY).toBeLessThan(stopY + 2.5); // gentle settle, no forward lunge past the stop
    expect(s[s.length - 1].parked).toBe(true);
  });

  it("absorbs a lone >50 m GPS spike instead of snapping the map to it", () => {
    const M = createFollowState();
    const base = drive({ speed: 0, seconds: 6, jitter: 1, seed: 9 });
    // one wild fix 70 m east, then back to normal
    const spike: FollowFix = { lat: ANCHOR.lat, lon: ANCHOR.lon + mToLon(70), speed: 0, heading: null, tSec: 6.5 };
    const after = drive({ speed: 0, seconds: 4, jitter: 1, seed: 21 }).map(f => ({ ...f, tSec: f.tSec + 7 }));
    const s = pump(M, [...base, spike, ...after], { tail: 2 });
    const maxEast = Math.max(...s.map(x => Math.abs(x.camx)));
    expect(maxEast).toBeLessThan(20); // huber-gated: nowhere near 70 m
    expect(Math.abs(s[s.length - 1].camx)).toBeLessThan(3); // recovers to ~origin
  });

  it("hard-snaps on a corroborated teleport (2 agreeing far fixes)", () => {
    const M = createFollowState();
    ingestFix(M, { lat: ANCHOR.lat, lon: ANCHOR.lon, speed: 0, heading: null, tSec: 0 });
    ingestFix(M, { lat: ANCHOR.lat, lon: ANCHOR.lon, speed: 0, heading: null, tSec: 1 });
    // two agreeing fixes ~120 m north = a real teleport (tunnel re-acquire)
    const far = ANCHOR.lat + mToLat(120);
    ingestFix(M, { lat: far, lon: ANCHOR.lon, speed: 0, heading: null, tSec: 2 }); // 1st far → held
    ingestFix(M, { lat: far, lon: ANCHOR.lon, speed: 0, heading: null, tSec: 3 }); // 2nd far → SNAP
    expect(M.cam.y).toBeGreaterThan(110); // camera hard-moved to the new location
  });

  it("re-acquires after a long GPS gap by snapping (not dead-reckoning stale velocity)", () => {
    const M = createFollowState();
    ingestFix(M, { lat: ANCHOR.lat, lon: ANCHOR.lon, speed: 10, heading: 0, tSec: 0 });
    ingestFix(M, { lat: ANCHOR.lat + mToLat(10), lon: ANCHOR.lon, speed: 10, heading: 0, tSec: 1 });
    // 8 s gap, reappears somewhere new
    const r = ingestFix(M, { lat: ANCHOR.lat + mToLat(90), lon: ANCHOR.lon, speed: 0, heading: null, tSec: 9 });
    expect(r.firstFix).toBe(false);
    expect(M.cam.y).toBeGreaterThan(80); // snapped to the re-acquire, not stuck coasting
    expect(M.spd).toBe(0);
  });
});

describe("followCamera - frame-rate independence", () => {
  it("converges to the same camera position at 30 vs 120 fps", () => {
    const track = drive({ speed: 8, headingDeg: 30, seconds: 12, jitter: 4, seed: 42 });
    const a = pump(createFollowState(), track, { fps: 30 });
    const b = pump(createFollowState(), track, { fps: 120 });
    const la = a[a.length - 1], lb = b[b.length - 1];
    expect(Math.hypot(la.camx - lb.camx, la.camy - lb.camy)).toBeLessThan(1.0);
  });
});
