import { describe, it, expect } from "vitest";
import {
  pickRepStartCamera, STREET_ZOOM, LAST_FIX_TTL_MS,
} from "../../client/src/lib/mapPins";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (field-mode launch, client/src/lib/mapPins.ts).
 * The rep map opens where the rep is standing, at door-knocking zoom — never a
 * regional overview. Live GPS is the ONLY anchor (no resume/session camera);
 * the launch paints the last known GPS fix instantly while the live fix warms
 * up, else null (caller falls back to lead/territory bounds).
 * ────────────────────────────────────────────────────────────────────────────
 */

const NOW = 1_800_000_000_000; // fixed epoch — Date.now() is the caller's job

const fix = (ageMs: number) => ({ lat: 35.545, lng: -80.41, at: NOW - ageMs });

describe("pickRepStartCamera — GPS-only launch", () => {
  it("fresh GPS cache paints at street-level zoom (door-knocking, not city view)", () => {
    const start = pickRepStartCamera(fix(60_000), NOW);
    expect(start).toEqual({ center: [-80.41, 35.545], zoom: STREET_ZOOM, source: "gps-cache" });
    expect(STREET_ZOOM).toBeGreaterThanOrEqual(16); // guardrail: streets + doors visible
  });

  it("a stale GPS cache (past TTL) is ignored — rep likely drove elsewhere", () => {
    expect(pickRepStartCamera(fix(LAST_FIX_TTL_MS + 1), NOW)).toBeNull();
  });

  it("no signal at all → null (caller frames the assigned leads instead)", () => {
    expect(pickRepStartCamera(null, NOW)).toBeNull();
  });

  it("rejects corrupt coordinates instead of jumping to NaN", () => {
    expect(pickRepStartCamera({ lat: Number.NaN, lng: -80.41, at: NOW - 1000 }, NOW)).toBeNull();
  });
});
