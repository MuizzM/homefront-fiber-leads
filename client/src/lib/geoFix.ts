// ── Field GPS capture for location-verified activity ──────────────────────────
// When a rep marks a lead, we record WHERE they were standing at that moment so
// the server can verify the work (see shared/geoVerify.ts). This grabs a fresh,
// accuracy-bearing fix quickly: a recent cached reading returns instantly
// (maximumAge), otherwise we wait briefly then fall back to "no location" —
// which the server classifies as Needs Review, never silently Verified.

import { APP_VERSION } from "@shared/diagnostics";

export interface FieldFix {
  repLat: number | null;
  repLng: number | null;
  gpsAccuracy: number | null;   // metres
  deviceTs: string;             // ISO time of the mark on the device
  netState: "online" | "offline";
  mockLocation: boolean;        // best-effort; browsers rarely expose this
  appVersion: string;
}

function baseFix(): FieldFix {
  const online = typeof navigator !== "undefined" ? navigator.onLine : true;
  return {
    repLat: null, repLng: null, gpsAccuracy: null,
    deviceTs: new Date().toISOString(),
    netState: online ? "online" : "offline",
    mockLocation: false,
    appVersion: APP_VERSION,
  };
}

// Resolve with the rep's position, or a location-less fix on denial/timeout.
// NEVER rejects — a knock must always be recordable; missing location just
// downgrades the verdict to Needs Review server-side.
export function captureFieldFix(timeoutMs = 4000): Promise<FieldFix> {
  const base = baseFix();
  return new Promise<FieldFix>(resolve => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(base);
    let settled = false;
    const done = (f: FieldFix) => { if (!settled) { settled = true; resolve(f); } };
    try {
      navigator.geolocation.getCurrentPosition(
        pos => done({
          ...base,
          repLat: Number.isFinite(pos.coords.latitude) ? pos.coords.latitude : null,
          repLng: Number.isFinite(pos.coords.longitude) ? pos.coords.longitude : null,
          gpsAccuracy: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
          deviceTs: new Date(pos.timestamp || Date.parse(base.deviceTs)).toISOString(),
        }),
        () => done(base), // permission denied / position unavailable / timeout
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15_000 },
      );
      // Hard backstop in case the callback never fires (some WebViews).
      setTimeout(() => done(base), timeoutMs + 750);
    } catch { done(base); }
  });
}
