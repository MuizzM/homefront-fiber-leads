import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// DECODO_UNLIMITED=on must be set BEFORE the governor module loads (the flag is
// read once at module init). This file exercises the unlimited-plan behavior:
// never throttle down, never freeze — rotate to fresh IPs on a denial burst.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hf-bw-unl-"));
process.env.DECODO_UNLIMITED = "on";
process.env.DECODO_BUDGET_GB = "1";
vi.mock("../../server/scanService", () => ({ startTargetRun: vi.fn(() => ({ runId: "r", queued: 0, budget: 0 })) }));

let gov: typeof import("../../server/bandwidthGovernor");

beforeAll(async () => {
  await import("../../server/db");
  gov = await import("../../server/bandwidthGovernor");
});
beforeEach(() => gov._resetGovernorForTests());

describe("unlimited Decodo plan — uninterrupted scanning, rotate don't freeze", () => {
  it("reports unlimited mode", () => {
    expect(gov.isUnlimitedProxyMode()).toBe(true);
  });

  it("budget scale is full throttle and NEVER throttles down, even after heavy burn", () => {
    // Record a large spend that would push the metered pacing toward the 0.1 floor.
    for (let i = 0; i < 50; i++) gov.recordProxyResponse(200_000);
    gov.flushBandwidthLedger();
    expect(gov.bandwidthBudgetScale()).toBe(1.5); // hunt-harder ceiling, not throttled
  });

  it("a 407 denial burst NEVER opens the circuit / freezes — it rotates instead", () => {
    let rotations = 0;
    gov.setProxyRotateHook(() => { rotations += 1; });
    for (let i = 0; i < 20; i++) gov.noteProxyAuthFailure();
    expect(gov.isProxyCircuitOpen()).toBe(false);   // never suspended
    expect(gov.proxyThrottleScale()).toBe(1);        // never throttled
    expect(gov.bandwidthBudgetScale()).toBe(1.5);    // still full
    expect(rotations).toBeGreaterThanOrEqual(1);      // rotated to fresh IPs
  });

  it("rotation is rate-limited so a storm triggers one rotation, not thousands", () => {
    let rotations = 0;
    gov.setProxyRotateHook(() => { rotations += 1; });
    for (let i = 0; i < 200; i++) gov.noteProxyAuthFailure();
    // Bounded by ROTATE_MIN_INTERVAL_MS within this synchronous burst → exactly one.
    expect(rotations).toBe(1);
  });
});
