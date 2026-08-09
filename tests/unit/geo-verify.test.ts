import { describe, it, expect } from "vitest";
import {
  classifyKnockLocation, countsAsWorked, DEFAULT_GEO_CONFIG,
  type KnockLocationInput,
} from "../../shared/geoVerify";

/**
 * CONTRACT (shared/geoVerify.ts): the anti-fabrication verdict. Precedence is
 * Invalid > Needs Review > Verified. Only a clean, in-range, accurate,
 * well-timed fix is Verified — and ONLY Verified counts as worked. A tap near
 * a lead in Rockwell NC: lead at (35.5492, -80.4012).
 */

const LEAD = { leadLat: 35.5492, leadLng: -80.4012 };
const SERVER_TS = "2026-07-09T18:00:00.000Z";

// A rep standing ~15 m from the lead (roughly 0.00013° north).
const base: KnockLocationInput = {
  repLat: 35.54933, repLng: -80.4012,
  gpsAccuracyM: 8,
  ...LEAD,
  deviceTs: "2026-07-09T17:59:58.000Z", // 2s before server receive — normal
  serverTs: SERVER_TS,
  mockLocation: false,
  netState: "online",
};

describe("classifyKnockLocation - Verified", () => {
  it("in-range, accurate, online, well-timed → verified with a real distance", () => {
    const r = classifyKnockLocation(base);
    expect(r.status).toBe("verified");
    expect(r.reasons).toEqual([]);
    expect(r.distanceM).toBeGreaterThan(0);
    expect(r.distanceM!).toBeLessThan(DEFAULT_GEO_CONFIG.maxDistanceM);
    expect(countsAsWorked(r.status)).toBe(true);
  });
});

describe("classifyKnockLocation - Needs Review (never silently verified)", () => {
  it("outside the radius → needs_review, does NOT count as worked", () => {
    // ~0.01° north ≈ 1.1 km away
    const r = classifyKnockLocation({ ...base, repLat: 35.5592 });
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toContain("outside_radius");
    expect(countsAsWorked(r.status)).toBe(false);
  });

  it("poor GPS accuracy → needs_review", () => {
    const r = classifyKnockLocation({ ...base, gpsAccuracyM: 120 });
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toContain("poor_accuracy");
  });

  it("missing rep location → needs_review with null distance (never faked)", () => {
    const r = classifyKnockLocation({ ...base, repLat: null, repLng: null });
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toContain("location_unavailable");
    expect(r.distanceM).toBeNull();
  });

  it("offline pending sync → needs_review", () => {
    const r = classifyKnockLocation({ ...base, netState: "offline" });
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toContain("offline_pending");
  });

  it("unknown accuracy → needs_review", () => {
    const r = classifyKnockLocation({ ...base, gpsAccuracyM: null });
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toContain("accuracy_unknown");
  });

  it("lead has no coordinates → needs_review, distance null", () => {
    const r = classifyKnockLocation({ ...base, leadLat: null, leadLng: null });
    expect(r.status).toBe("needs_review");
    expect(r.reasons).toContain("lead_location_missing");
    expect(r.distanceM).toBeNull();
  });
});

describe("classifyKnockLocation - Invalid (tamper evidence wins over everything)", () => {
  it("mock location → invalid even when standing on the doorstep", () => {
    const r = classifyKnockLocation({ ...base, mockLocation: true });
    expect(r.status).toBe("invalid");
    expect(r.reasons).toContain("mock_location");
    expect(countsAsWorked(r.status)).toBe(false);
  });

  it("duplicate submission → invalid", () => {
    const r = classifyKnockLocation({ ...base, duplicate: true });
    expect(r.status).toBe("invalid");
    expect(r.reasons).toContain("duplicate");
  });

  it("device clock far in the future → invalid (timestamp_future)", () => {
    const r = classifyKnockLocation({ ...base, deviceTs: "2026-07-09T18:20:00.000Z" }); // 20 min ahead
    expect(r.status).toBe("invalid");
    expect(r.reasons).toContain("timestamp_future");
  });

  it("impossible travel speed since the previous mark → invalid", () => {
    // Previous mark 10 s ago, 5 km away → 500 m/s, physically impossible.
    const r = classifyKnockLocation({
      ...base,
      prev: { lat: 35.5942, lng: -80.4012, at: "2026-07-09T17:59:48.000Z" },
    });
    expect(r.status).toBe("invalid");
    expect(r.reasons).toContain("impossible_speed");
  });

  it("a normal walk between two nearby marks is NOT impossible", () => {
    // 30 m in 60 s = 0.5 m/s — a slow stroll, stays verified.
    const r = classifyKnockLocation({
      ...base,
      prev: { lat: 35.54960, lng: -80.4012, at: "2026-07-09T17:58:58.000Z" },
    });
    expect(r.status).toBe("verified");
  });
});

describe("Area Worked math (the headline metric)", () => {
  it("4 verified worked of 177 total → 2.26%", () => {
    const pct = Math.round((4 / 177) * 100 * 100) / 100;
    expect(pct).toBe(2.26);
  });
  it("only verified statuses count as worked", () => {
    expect(countsAsWorked("verified")).toBe(true);
    expect(countsAsWorked("needs_review")).toBe(false);
    expect(countsAsWorked("invalid")).toBe(false);
  });
});
