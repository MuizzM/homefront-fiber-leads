import { describe, it, expect } from "vitest";
import { isElectedAreaJob } from "../../server/addressDiscovery/electedJob";

const job = (over: Record<string, unknown>) => ({
  areaJson: null, requestedAreaJson: null, idempotencyKey: null, townName: null, ...over,
});

describe("isElectedAreaJob — only an operator-drawn box gets the aggressive tier", () => {
  it("is TRUE for a drawn box: has geometry, no town, not a market burst", () => {
    expect(isElectedAreaJob(job({ areaJson: '{"type":"Polygon"}', idempotencyKey: "v1|7|Polygon|[...]" }))).toBe(true);
    expect(isElectedAreaJob(job({ requestedAreaJson: '{"type":"Polygon"}' }))).toBe(true);
  });

  it("is FALSE for a recurring market burst (hot:/frontier: key), even with a resolved geometry", () => {
    expect(isElectedAreaJob(job({ areaJson: '{"type":"Polygon"}', idempotencyKey: "hot:dalton:ga:2026-07-21T14", townName: "Dalton" }))).toBe(false);
    expect(isElectedAreaJob(job({ areaJson: '{"type":"Polygon"}', idempotencyKey: "frontier:durham:nc:2026-07-21T14" }))).toBe(false);
  });

  it("is FALSE for a town/city discovery (has a town name — a large, cost-sensitive harvest)", () => {
    expect(isElectedAreaJob(job({ areaJson: '{"type":"Polygon"}', townName: "Concord" }))).toBe(false);
  });

  it("is FALSE before a boundary/geometry exists", () => {
    expect(isElectedAreaJob(job({ areaJson: null, requestedAreaJson: null }))).toBe(false);
  });
});
