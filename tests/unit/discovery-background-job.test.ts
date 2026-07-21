import { describe, it, expect } from "vitest";
import {
  isBackgroundDiscoveryJob,
  type DiscoveryJob,
} from "../../client/src/lib/discoveryApi";

/**
 * The field map's scan sheet must bind ONLY to boxes the operator drew on this
 * map — never the server's recurring hot-market / frontier town harvests, which
 * stream through the same tenant job feed around the clock. If those count as
 * "the current scan", the sheet stays pinned to "Scanning fiber" forever, the
 * Scan Map button never returns, and Stop cancels a background job.
 */
const job = (over: Partial<DiscoveryJob>): DiscoveryJob =>
  ({ id: "j", status: "discovering", ...over } as DiscoveryJob);

const FIELD_GEOMETRY = {
  type: "Polygon" as const,
  coordinates: [[[-80.6, 35.4], [-80.5, 35.4], [-80.5, 35.5], [-80.6, 35.5], [-80.6, 35.4]]],
};

describe("isBackgroundDiscoveryJob", () => {
  it("flags recurring hot-market harvests by idempotency key", () => {
    expect(isBackgroundDiscoveryJob(job({ idempotencyKey: "hot:concord:nc:2026-07-21T03" }))).toBe(true);
  });

  it("flags frontier town harvests by idempotency key", () => {
    expect(isBackgroundDiscoveryJob(job({ idempotencyKey: "frontier:durham:nc:2026-07-21T03" }))).toBe(true);
  });

  it("flags any town-based job that carries no drawn geometry", () => {
    expect(isBackgroundDiscoveryJob(job({ city: "Salisbury", geometry: null }))).toBe(true);
    expect(isBackgroundDiscoveryJob(job({ city: "Salisbury" }))).toBe(true); // geometry undefined
  });

  it("treats an operator-drawn box (has geometry, no market key) as a FIELD scan", () => {
    expect(isBackgroundDiscoveryJob(job({
      geometry: FIELD_GEOMETRY,
      idempotencyKey: "v1|7|Polygon|[[...]]",
    }))).toBe(false);
  });

  it("a drawn box is a field scan even if its key happened to start otherwise", () => {
    // Field keys are the discoveryIdempotencyKey hash ("v1|..."), never hot:/frontier:.
    expect(isBackgroundDiscoveryJob(job({ geometry: FIELD_GEOMETRY, idempotencyKey: "v1|hot-ish" }))).toBe(false);
  });
});
