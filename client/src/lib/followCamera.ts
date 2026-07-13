// ── Shake-free GPS follow-camera — pure math + state (OEDR-Spring) ─────────────
// The estimator/predictor/integrator for a Google-Maps-grade car-navigation
// follow camera. PURE and framework-free (like shared/knock.ts / mapPins.ts):
// no map, no DOM, no timers — the impure glue (requestAnimationFrame, map.jumpTo,
// the puck Marker, GeolocateControl wiring) lives in MapView.tsx. This split lets
// the smoothing math be unit-tested against recorded jittery GPS tracks so a
// future tuning change can never silently reintroduce the "whole map shakes" bug.
//
// Why the OLD approach shook: it issued a fresh `map.easeTo(...)` per GPS fix
// (~1 Hz, jittery), so (a) raw ±5 m jitter was applied straight to the camera and
// (b) restarting the animation every second created velocity discontinuities.
//
// The fix, three decoupled stages on two clocks with ONE smoothed point:
//   A) ESTIMATOR (fix clock): a One-Euro low-pass whose cutoff rises with a
//      de-noised speed — heavy (kills jitter) when parked/slow, transparent (kills
//      lag) at driving speed. Speed is de-noised from Doppler + multi-fix
//      displacement, never the raw 1 Hz per-axis derivative.
//   B) PREDICTOR (render clock): dead-reckon the goal forward along the de-noised
//      velocity, horizon-clamped and confidence-ramped (off at crawl, full by 8 m/s).
//   C) INTEGRATOR (render clock): a goal-velocity-aware critically-damped spring
//      that carries camera velocity across frames (C¹, never overshoots).
// The render loop (stepFrame) is the SOLE camera writer; ingestFix only mutates
// estimator state. All maths in local ENU metres; only the final read converts to
// lng/lat. Every smoothing constant is in exp(-k·dt) form → identical at any FPS.

// ── Tunables ──────────────────────────────────────────────────────────────────
export const FOLLOW = {
  FCMIN: 0.10, BETA: 0.04,          // One-Euro position cutoff: fc = FCMIN + BETA·speed  (Hz, 1/m)
  FC_CROSS: 0.08,                   // cross-track cutoff while moving (heavy — no signal ⟂ to heading)
  SPD_TAU: 0.40,                    // low-pass on the de-noised speed scalar (s)
  H_POS: 0.33, H_HDG: 0.30,         // spring halflives (s) — position, heading. H_POS raised for extra
                                    // velocity smoothing; the goal-velocity feed-forward cancels its lag.
  HORIZON: 1.5,                     // dead-reckon clamp (s): goal coasts then freezes
  GATE_ON: 0.7, GATE_OFF: 0.4,      // moving/park gate on de-noised speed (m/s, hysteresis)
  HEAD_ON: 2.5, HEAD_OFF: 1.5,      // heading-display gate (m/s) — differenced heading is junk below ~2.5
  CONF_LO: 3, CONF_HI: 8,           // dead-reckon confidence ramp (m/s): off ≤3, full ≥8
  SNAP_M: 50, GAP_SNAP: 5, HUBER_LO: 15,   // teleport / gap-reacquire / lone-outlier band (m, s, m)
  HUBER_GAIN: 0.35,                 // gain applied to a lone far (15–50 m) fix before it is corroborated
  PARK_DIST: 0.5, PARK_V: 0.05, PARK_SPD: 0.3,   // converged/slow → cancel rAF (m, m/s, m/s)
  STAT_DEAD: 8, STAT_DAMP: 0.05,    // parked freeze: deadband (m) on smoothed pos + residual gain factor
  DISP_WIN: 3.0, DISP_STAT_M: 3,    // multi-fix speed window / stationarity threshold (s, m)
  MAXDT: 0.05, DTF_MIN: 0.2, DTF_MAX: 2.0,   // frame dt clamp, fix-interval clamp (s)
  REANCHOR_DEG: 0.2,                // re-seed the ENU anchor past this many degrees (~22 km)
  DEG_M: 111320,                    // metres per degree latitude
} as const;

const LN2 = Math.LN2, D2R = Math.PI / 180, R2D = 180 / Math.PI, TWO_PI = Math.PI * 2;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const smoothstep = (lo: number, hi: number, x: number) => {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};
// Rate-independent One-Euro alpha for cutoff fc over interval dt.
const alphaOf = (fc: number, dt: number) => { const tau = 1 / (TWO_PI * fc); return 1 / (1 + tau / dt); };
// Shortest signed angular delta a→b, result in (-π, π].
const angDelta = (a: number, b: number) => { let d = (b - a + Math.PI) % TWO_PI; if (d < 0) d += TWO_PI; return d - Math.PI; };
// Critically-damped spring toward a MOVING goal (pos g, vel gv). Exact + stable at any dt.
function spring(x: number, v: number, g: number, gv: number, half: number, dt: number): [number, number] {
  const y = (2 * LN2) / half, px = x - g, pv = v - gv, j1 = pv + px * y, e = Math.exp(-y * dt);
  return [g + gv * dt + e * (px + j1 * dt), gv + e * (pv - j1 * y * dt)];
}

// ── Inputs / outputs ──────────────────────────────────────────────────────────
export interface FollowFix {
  lat: number;
  lon: number;
  speed: number | null;    // coords.speed (m/s), or null on devices without Doppler
  heading: number | null;  // coords.heading (deg), or null
  tSec: number;            // fix time on the SAME clock stepFrame uses (perf seconds), latency-adjusted
}

export interface FrameOut {
  center: [number, number]; // [lng, lat] — write to BOTH camera and puck (same point → puck pinned)
  headingDeg: number | null; // smoothed heading for the puck arrow, or null when not moving
  parked: boolean;           // true → converged + slow; caller cancels the rAF (0 CPU) until next fix
}

export interface FollowState {
  anchorLat: number | null; anchorLon: number | null; cosA: number;
  pxHat: number; pyHat: number;                 // One-Euro low-pass state (ENU m)
  pFix: { x: number; y: number } | null;        // filtered position (mirror of pxHat/pyHat)
  tFix: number;                                  // time of last fix (s)
  spd: number;                                   // de-noised speed scalar (m/s)
  hdgT: number; hdgShown: number; hdgValid: boolean; // heading target/shown (rad)
  moving: boolean;
  hist: { t: number; x: number; y: number }[];   // ring for multi-fix displacement speed
  snapN: number; snapPt: { x: number; y: number };// teleport corroboration
  cam: { x: number; y: number }; cvx: number; cvy: number; // camera pos (m) + velocity (m/s) — persists → C¹
  lastFrame: number;                             // last stepFrame time (s); 0 = loop just (re)started
}

export function createFollowState(): FollowState {
  return {
    anchorLat: null, anchorLon: null, cosA: 1,
    pxHat: 0, pyHat: 0, pFix: null, tFix: 0,
    spd: 0, hdgT: 0, hdgShown: 0, hdgValid: false, moving: false,
    hist: [], snapN: 0, snapPt: { x: 0, y: 0 },
    cam: { x: 0, y: 0 }, cvx: 0, cvy: 0, lastFrame: 0,
  };
}

// ── ENU (local tangent-plane) helpers ─────────────────────────────────────────
function setAnchor(M: FollowState, lat: number, lon: number) {
  M.anchorLat = lat; M.anchorLon = lon; M.cosA = Math.cos(lat * D2R);
}
function toM(M: FollowState, lat: number, lon: number) {
  return { x: (lon - (M.anchorLon as number)) * FOLLOW.DEG_M * M.cosA, y: (lat - (M.anchorLat as number)) * FOLLOW.DEG_M };
}
function toLL(M: FollowState, x: number, y: number): [number, number] {
  return [(M.anchorLon as number) + x / (FOLLOW.DEG_M * M.cosA), (M.anchorLat as number) + y / FOLLOW.DEG_M];
}

/** The current FILTERED position as [lng, lat] — for the puck while the rAF loop
 *  is not the writer (exploring in BACKGROUND, or reduced-motion). Null pre-first-fix. */
export function filteredLngLat(M: FollowState): [number, number] | null {
  return M.pFix ? toLL(M, M.pFix.x, M.pFix.y) : null;
}

// ── STAGE A — ingest a fix: mutate the estimator ONLY (never the camera) ───────
// Returns { firstFix } so the caller can do the one-time zoom-to-street.
export function ingestFix(M: FollowState, fix: FollowFix): { firstFix: boolean } {
  const { lat, lon, tSec: now } = fix;
  const dop = fix.speed;

  if (M.anchorLat == null || Math.abs(lat - M.anchorLat) > FOLLOW.REANCHOR_DEG) setAnchor(M, lat, lon);
  const z = toM(M, lat, lon);

  // ── First fix: seed everything, no glide-in ──
  if (!M.pFix) {
    setAnchor(M, lat, lon);
    const z0 = toM(M, lat, lon);
    M.pxHat = z0.x; M.pyHat = z0.y; M.pFix = { x: z0.x, y: z0.y }; M.tFix = now;
    M.cam = { x: z0.x, y: z0.y }; M.cvx = 0; M.cvy = 0;
    M.spd = 0; M.moving = false; M.hdgValid = false;
    M.hist = [{ t: now, x: z0.x, y: z0.y }]; M.snapN = 0;
    return { firstFix: true };
  }

  const gap = now - M.tFix, jump = Math.hypot(z.x - M.pxHat, z.y - M.pyHat);

  // ── Teleport / tunnel re-acquire: require 2 corroborating fixes (or a >5 s gap) ──
  if (jump > FOLLOW.SNAP_M || gap > FOLLOW.GAP_SNAP) {
    if (gap > FOLLOW.GAP_SNAP || (M.snapN > 0 && Math.hypot(z.x - M.snapPt.x, z.y - M.snapPt.y) < FOLLOW.SNAP_M)) {
      M.pxHat = z.x; M.pyHat = z.y; M.pFix = { x: z.x, y: z.y }; M.tFix = now;
      M.cam = { x: z.x, y: z.y }; M.cvx = 0; M.cvy = 0;
      M.spd = 0; M.moving = false; M.hdgValid = false;
      M.hist = [{ t: now, x: z.x, y: z.y }]; M.snapN = 0;
      return { firstFix: false };
    }
    M.snapN = 1; M.snapPt = { x: z.x, y: z.y }; // 1st far fix: hold, treat as a soft outlier below
  } else {
    M.snapN = 0;
  }

  // ── De-noised SPEED. hist holds RAW fixes, not the filtered position, so real
  //    motion stays detectable even while the position is FROZEN below (otherwise a
  //    frozen pFix → zero displacement → speed 0 → stays frozen forever: a deadlock
  //    where the car drives off but the map never unfreezes). Doppler is primary when
  //    present (accurate while driving); multi-fix displacement is the fallback. ──
  M.hist.push({ t: now, x: z.x, y: z.y });
  while (M.hist.length > 2 && now - M.hist[0].t > FOLLOW.DISP_WIN) M.hist.shift();
  const old = M.hist[0], dtWin = Math.max(0.5, now - old.t);
  const dispRaw = Math.hypot(z.x - old.x, z.y - old.y);
  const cand = dop != null && dop >= 0 ? dop : dispRaw / dtWin;
  const dtf = clamp(gap, FOLLOW.DTF_MIN, FOLLOW.DTF_MAX);
  M.spd += (1 - Math.exp(-dtf / FOLLOW.SPD_TAU)) * (cand - M.spd);
  M.moving = M.spd > (M.moving ? FOLLOW.GATE_OFF : FOLLOW.GATE_ON);
  if (dop == null && dispRaw < FOLLOW.DISP_STAT_M) M.moving = false; // no Doppler: displacement says stopped
  if (dop != null && dop < FOLLOW.GATE_OFF) M.moving = false;        // Doppler stop is definitive

  // ── One-Euro position update. ANISOTROPIC while moving: responsive ALONG the
  //    heading (fast cutoff; the goal-velocity feed-forward cancels its lag) but heavy
  //    ACROSS it (low fixed cutoff). Cross-track carries no signal on a straight road,
  //    so lateral GPS jitter is smoothed hard WITHOUT adding along-track lag — this is
  //    what stops the map swaying side-to-side at speed. A turn simply rotates the
  //    along/cross frame with the heading, so it is never smoothed away. Parked (or no
  //    heading yet) → isotropic with the freeze deadband so a stopped puck is dead-still. ──
  const gain = M.snapN === 1 ? FOLLOW.HUBER_GAIN : 1;              // soft-gate a lone far outlier
  const dtp = clamp(gap, 0.05, FOLLOW.DTF_MAX);
  const ex = z.x - M.pxHat, ey = z.y - M.pyHat;                    // fix error (ENU m)
  if (M.moving && M.hdgValid) {
    const sh = Math.sin(M.hdgT), ch = Math.cos(M.hdgT);           // heading unit (sinθ, cosθ), 0 = N
    const along = ex * sh + ey * ch, cross = ex * ch - ey * sh;   // decompose error
    const dA = along * alphaOf(FOLLOW.FCMIN + FOLLOW.BETA * M.spd, dtp) * gain;
    const dC = cross * alphaOf(FOLLOW.FC_CROSS, dtp) * gain;
    M.pxHat += dA * sh + dC * ch;                                 // recompose the step
    M.pyHat += dA * ch - dC * sh;
  } else {
    let a = alphaOf(FOLLOW.FCMIN + FOLLOW.BETA * M.spd, dtp) * gain;
    if (!M.moving) { const off = Math.hypot(ex, ey); a = off < FOLLOW.STAT_DEAD ? 0 : a * FOLLOW.STAT_DAMP; }
    M.pxHat += a * ex; M.pyHat += a * ey;
  }
  const prev = M.pFix; M.pFix = { x: M.pxHat, y: M.pyHat }; M.tFix = now;

  // ── Heading (display + DR direction), gated with hysteresis, shortest arc ──
  if (M.spd >= (M.hdgValid ? FOLLOW.HEAD_OFF : FOLLOW.HEAD_ON)) {
    const h = (dop != null && fix.heading != null && dop >= FOLLOW.HEAD_ON)
      ? fix.heading * D2R
      : Math.atan2(M.pFix.x - prev.x, M.pFix.y - prev.y); // 0 = North, +CW
    M.hdgT = h;
    if (!M.hdgValid) { M.hdgShown = h; M.hdgValid = true; }
  }
  // Below HEAD_OFF: freeze heading (keep last shown).

  return { firstFix: false };
}

// ── STAGE B + C — advance one render frame. The SOLE camera writer's math. ─────
export function stepFrame(M: FollowState, tSec: number): FrameOut | null {
  if (!M.pFix) return null;
  let dt = M.lastFrame ? tSec - M.lastFrame : 1 / 60;
  M.lastFrame = tSec;
  if (dt <= 0) dt = 1 / 60;
  if (dt > FOLLOW.MAXDT) dt = FOLLOW.MAXDT;

  // De-noised velocity VECTOR = de-noised magnitude × de-noised direction (no 1 Hz lateral sweep).
  const vmag = M.moving ? M.spd : 0;
  const vx = M.moving && M.hdgValid ? vmag * Math.sin(M.hdgT) : 0;
  const vy = M.moving && M.hdgValid ? vmag * Math.cos(M.hdgT) : 0;

  // STAGE B: dead-reckon the goal forward, horizon-clamped + confidence-ramped.
  const age = clamp(tSec - M.tFix, 0, FOLLOW.HORIZON);
  const conf = smoothstep(FOLLOW.CONF_LO, FOLLOW.CONF_HI, M.spd); // 0 at crawl → no noise extrapolation
  const past = age >= FOLLOW.HORIZON;
  const gx = M.pFix.x + vx * age * conf, gy = M.pFix.y + vy * age * conf;
  const gvx = past ? 0 : vx * conf, gvy = past ? 0 : vy * conf;   // feed-forward = derivative of the CLAMPED goal

  // STAGE C: goal-velocity-aware critically-damped spring (carries velocity, no overshoot).
  [M.cam.x, M.cvx] = spring(M.cam.x, M.cvx, gx, gvx, FOLLOW.H_POS, dt);
  [M.cam.y, M.cvy] = spring(M.cam.y, M.cvy, gy, gvy, FOLLOW.H_POS, dt);

  // Heading spring (own, slower, shortest-arc) → puck arrow only; map stays north-up.
  let headingDeg: number | null = null;
  if (M.hdgValid) {
    M.hdgShown += (1 - Math.exp(-((2 * LN2) / FOLLOW.H_HDG) * dt)) * angDelta(M.hdgShown, M.hdgT);
    headingDeg = M.hdgShown * R2D;
  }

  const center = toLL(M, M.cam.x, M.cam.y);

  // PARK: converged + camera slow + (rep slow OR fixes stale) → caller stops the loop.
  const err = Math.hypot(M.cam.x - gx, M.cam.y - gy), cs = Math.hypot(M.cvx, M.cvy);
  const stale = tSec - M.tFix > FOLLOW.HORIZON;
  const parked = err < FOLLOW.PARK_DIST && cs < FOLLOW.PARK_V && (M.spd < FOLLOW.PARK_SPD || stale);

  return { center, headingDeg, parked };
}
