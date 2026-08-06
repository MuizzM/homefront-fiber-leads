// ── Location verification for lead activity — PURE and auditable ──────────────
// The anti-fabrication core: given the rep's device position AT THE MOMENT a
// lead was marked and the lead's own coordinates, decide whether that activity
// is a trustworthy piece of field work. ALL of this runs server-side (never
// trust a client-sent verdict) and is pure so the whole decision table is
// unit-tested without a DB, a device, or a network.
//
// Precedence is deliberate: the most protective verdicts win. A single piece of
// tamper evidence makes an activity Invalid regardless of how close the pin is;
// anything merely uncertain (missing/poor GPS, out of range, offline) is
// Needs Review, never silently Verified. Only a clean, in-range, accurate,
// well-timed fix earns Verified — and ONLY Verified activities count toward a
// territory's "Area Worked" percentage.

import { haversineMeters } from "./knock";

export type VerificationStatus = "verified" | "needs_review" | "invalid";

// Admin-configurable thresholds (see app_settings geo.* keys). Distance is the
// canvassing radius; accuracy is the worst (largest) GPS error we still trust.
export interface GeoConfig {
  maxDistanceM: number;   // rep must be within this many metres of the lead
  maxAccuracyM: number;   // GPS accuracy worse (larger) than this → Needs Review
}
export const DEFAULT_GEO_CONFIG: GeoConfig = { maxDistanceM: 100, maxAccuracyM: 50 };

// A rep can't credibly move faster than this between two consecutive marks —
// beyond it the location data is physically impossible (spoofed/replayed).
// 62 m/s ≈ 223 km/h ≈ 139 mph. Well above driving, far below teleporting.
export const IMPOSSIBLE_SPEED_MPS = 62;

// How far a device clock may lead the server before we treat it as manipulated.
// Small skew is normal; ten minutes into the future is not a real field tap.
export const MAX_CLOCK_LEAD_MS = 10 * 60 * 1000;

export interface KnockLocationInput {
  repLat: number | null;
  repLng: number | null;
  gpsAccuracyM: number | null;      // metres of horizontal uncertainty
  leadLat: number | null;
  leadLng: number | null;
  deviceTs: string | null;          // ISO time the DEVICE reports for the tap
  serverTs: string;                 // ISO authoritative receive time
  mockLocation?: boolean | null;    // device flagged mock/spoofed location
  netState?: "online" | "offline" | null;
  duplicate?: boolean | null;       // server detected a duplicate submission
  // The rep's previous recorded position, for impossible-travel detection.
  prev?: { lat: number; lng: number; at: string } | null;
}

export interface VerificationResult {
  status: VerificationStatus;
  distanceM: number | null;         // null ⇒ location unavailable (never faked)
  accuracyM: number | null;
  // Machine-readable reason keys; the UI maps them to human copy + tooltips.
  reasons: string[];
}

function isFiniteCoord(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

// Parse an ISO timestamp to epoch ms WITHOUT Date.now() (kept pure/deterministic
// — the caller passes serverTs, we only compare the two supplied instants).
function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Classify one lead-marking activity. Pure: same inputs → same verdict.
 * Order of checks encodes precedence (Invalid > Needs Review > Verified).
 */
export function classifyKnockLocation(input: KnockLocationInput, config: GeoConfig = DEFAULT_GEO_CONFIG): VerificationResult {
  const reasons: string[] = [];
  const haveRep = isFiniteCoord(input.repLat) && isFiniteCoord(input.repLng);
  const haveLead = isFiniteCoord(input.leadLat) && isFiniteCoord(input.leadLng);
  const accuracyM = isFiniteCoord(input.gpsAccuracyM) ? input.gpsAccuracyM : null;

  const distanceM = haveRep && haveLead
    ? haversineMeters(
        { lat: input.repLat as number, lng: input.repLng as number },
        { lat: input.leadLat as number, lng: input.leadLng as number },
      )
    : null;

  // ── INVALID: hard tamper evidence. Any one is disqualifying. ──────────────
  if (input.mockLocation === true) reasons.push("mock_location");
  if (input.duplicate === true) reasons.push("duplicate");

  const deviceMs = parseMs(input.deviceTs);
  const serverMs = parseMs(input.serverTs);
  if (deviceMs != null && serverMs != null && deviceMs - serverMs > MAX_CLOCK_LEAD_MS) {
    reasons.push("timestamp_future"); // device clock reports the future → manipulated
  }

  if (input.prev && haveRep && deviceMs != null) {
    const prevMs = parseMs(input.prev.at);
    if (prevMs != null) {
      const dt = Math.abs(deviceMs - prevMs) / 1000; // seconds
      const jump = haversineMeters({ lat: input.prev.lat, lng: input.prev.lng }, { lat: input.repLat as number, lng: input.repLng as number });
      // Guard the divide; sub-second gaps with a real jump are impossible too.
      if (jump > config.maxDistanceM && jump / Math.max(dt, 1) > IMPOSSIBLE_SPEED_MPS) {
        reasons.push("impossible_speed");
      }
    }
  }

  if (reasons.length > 0) {
    return { status: "invalid", distanceM, accuracyM, reasons };
  }

  // ── NEEDS REVIEW: uncertain, out of range, or unverifiable. Never Verified. ─
  if (!haveRep) reasons.push("location_unavailable");
  if (!haveLead) reasons.push("lead_location_missing");
  if (input.netState === "offline") reasons.push("offline_pending");
  if (accuracyM == null && haveRep) reasons.push("accuracy_unknown");
  else if (accuracyM != null && accuracyM > config.maxAccuracyM) reasons.push("poor_accuracy");
  if (deviceMs == null) reasons.push("timestamp_missing");
  if (distanceM != null && distanceM > config.maxDistanceM) reasons.push("outside_radius");

  if (reasons.length > 0) {
    return { status: "needs_review", distanceM, accuracyM, reasons };
  }

  // ── VERIFIED: coords present both sides, accurate, in range, well-timed. ───
  return { status: "verified", distanceM, accuracyM, reasons: [] };
}

// Human-readable copy for each reason key (UI tooltips / review labels). Kept
// beside the logic so a new reason can never ship without an explanation.
export const REASON_LABELS: Record<string, string> = {
  mock_location: "Mock or spoofed location detected on the device",
  duplicate: "Duplicate submission for this lead",
  timestamp_future: "Device clock reported a future time (possible tampering)",
  impossible_speed: "Impossible travel speed since the previous mark",
  location_unavailable: "Rep location was unavailable when marked",
  lead_location_missing: "Lead has no stored coordinates to compare against",
  offline_pending: "Marked offline — pending sync verification",
  accuracy_unknown: "GPS accuracy was not reported",
  poor_accuracy: "GPS accuracy was worse than the allowed threshold",
  timestamp_missing: "No valid device timestamp for the mark",
  outside_radius: "Rep was outside the allowed distance from the lead",
};


// Does this activity count toward "Area Worked"? ONLY verified work does — the
// single rule the whole percentage depends on, expressed once.
export function countsAsWorked(status: VerificationStatus): boolean {
  return status === "verified";
}
