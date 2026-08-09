import { describe, expect, it } from "vitest";
import { provenHourlyCapacity, MIN_ASSUMED_HOURLY_CHECKS } from "../../shared/scanPolicy";

// The production incident this guards against, verbatim from the logs:
//   keepwarm.throughput_capped requested=45000 capped=500 checkedLastHour=34
// Sizing dispatch from the instantaneous last hour is self-reinforcing
// downward — throughput fell 3,376/hr → 43/hr with no path back.

describe("dispatch capacity cannot spiral downward", () => {
  it("a collapsed last hour never drags capacity below the proven floor", () => {
    // The exact incident numbers: 34 checks in the last hour, 24h avg ~998.
    expect(provenHourlyCapacity(34, 23_959)).toBe(MIN_ASSUMED_HOURLY_CHECKS);
    // Even a total stall (a release window) keeps the floor.
    expect(provenHourlyCapacity(0, 0)).toBe(MIN_ASSUMED_HOURLY_CHECKS);
  });

  it("uses the 24h average when it beats both the last hour and the floor", () => {
    // Healthy day at ~5k/hr, but this hour dipped to 200.
    expect(provenHourlyCapacity(200, 120_000)).toBe(5000);
  });

  it("uses the last hour when the system is accelerating", () => {
    // Recovering fast: this hour is already the best evidence.
    expect(provenHourlyCapacity(9000, 24_000)).toBe(9000);
  });

  it("is monotonic in every input - more evidence never lowers capacity", () => {
    const base = provenHourlyCapacity(1000, 48_000);
    expect(provenHourlyCapacity(2000, 48_000)).toBeGreaterThanOrEqual(base);
    expect(provenHourlyCapacity(1000, 96_000)).toBeGreaterThanOrEqual(base);
  });

  it("honours an explicit floor override and never returns zero", () => {
    expect(provenHourlyCapacity(0, 0, 500)).toBe(500);
    expect(provenHourlyCapacity(0, 0, 0)).toBeGreaterThan(0);
  });
});
