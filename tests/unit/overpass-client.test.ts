import { describe, expect, it, vi } from "vitest";
import {
  OverpassClient,
  detectOverpassTruncation,
  validateOverpassEndpoint,
} from "../../server/addressDiscovery/overpass";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("Overpass endpoint safety", () => {
  it("accepts public HTTPS endpoints and rejects unsafe configurable URLs", () => {
    expect(validateOverpassEndpoint("https://overpass.example.com/api/interpreter").hostname).toBe("overpass.example.com");
    expect(() => validateOverpassEndpoint("http://overpass.example.com/api/interpreter")).toThrow(/HTTPS/);
    expect(() => validateOverpassEndpoint("https://127.0.0.1/api/interpreter")).toThrow(/private/i);
    expect(() => validateOverpassEndpoint("https://169.254.169.254/latest/meta-data")).toThrow(/private/i);
    expect(() => validateOverpassEndpoint("https://localhost/api/interpreter")).toThrow(/private|local/i);
    expect(() => validateOverpassEndpoint("https://user:password@overpass.example.com/api/interpreter")).toThrow(/credentials/i);
  });

  it("allows an explicitly approved self-hosted hostname while still requiring HTTPS", () => {
    expect(validateOverpassEndpoint("https://overpass.internal/api/interpreter", ["overpass.internal"]).hostname).toBe("overpass.internal");
    expect(() => validateOverpassEndpoint("http://overpass.internal/api/interpreter", ["overpass.internal"])).toThrow(/HTTPS/);
  });
});

describe("Overpass transport reliability", () => {
  it("fails over on 429, updates endpoint health, and caches by query hash", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("primary.example")) return jsonResponse({ error: "limited" }, 429, { "retry-after": "0" });
      return jsonResponse({ elements: [{ type: "node", id: 1, lat: 35.8, lon: -80.2 }], osm3s: { timestamp_osm_base: "2026-07-14T00:00:00Z" } });
    });
    const client = new OverpassClient({
      endpoints: ["https://primary.example/api/interpreter", "https://secondary.example/api/interpreter"],
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
      maxAttempts: 3,
      random: () => 0,
    });
    const first = await client.fetchQuery("[out:json];node(0,0,1,1);out;", "source-v1");
    expect(first.fromCache).toBe(false);
    expect(first.endpoint).toContain("secondary.example");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const cached = await client.fetchQuery("[out:json];node(0,0,1,1);out;", "source-v1");
    expect(cached.fromCache).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.getEndpointHealth().find((item) => item.endpoint.includes("primary"))?.failures).toBe(1);
  });

  it("detects partial responses and subdivides until child tiles complete", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return jsonResponse({ elements: [{ type: "node", id: 1 }], remark: "runtime error: Query timed out" });
      return jsonResponse({ elements: [{ type: "node", id: calls, lat: 35.8, lon: -80.2 }] });
    });
    const events: string[] = [];
    const client = new OverpassClient({
      endpoints: ["https://overpass.example/api/interpreter"],
      fetchImpl: fetchImpl as typeof fetch,
      maxAttempts: 1,
      cacheTtlMs: 0,
    });
    const result = await client.fetchArea({
      type: "Polygon",
      coordinates: [[[-80.3, 35.8], [-80.2, 35.8], [-80.2, 35.9], [-80.3, 35.9], [-80.3, 35.8]]],
    }, {
      targetTileAreaKm2: 1_000_000,
      maxTiles: 1,
      maxSubdivisionDepth: 2,
      onTile: ({ tileId, status }) => { events.push(`${tileId}:${status}`); },
    });
    expect(result.complete).toBe(true);
    expect(result.requests).toBe(5);
    expect(result.completedTileIds).toHaveLength(4);
    expect(result.failedTileIds).toEqual([]);
    expect(events[0]).toBe("r:subdivided");
    expect(result.elements).toHaveLength(4);
  });

  it("reports an unresolved truncation honestly when subdivision is disabled", async () => {
    const client = new OverpassClient({
      endpoints: ["https://overpass.example/api/interpreter"],
      fetchImpl: (async () => jsonResponse({ elements: [], remark: "runtime error: out of memory" })) as typeof fetch,
      maxAttempts: 1,
      cacheTtlMs: 0,
    });
    const result = await client.fetchArea({
      type: "Polygon",
      coordinates: [[[-80.3, 35.8], [-80.2, 35.8], [-80.2, 35.9], [-80.3, 35.9], [-80.3, 35.8]]],
    }, { targetTileAreaKm2: 1_000_000, maxTiles: 1, maxSubdivisionDepth: 0 });
    expect(result.complete).toBe(false);
    expect(result.truncatedTileIds).toEqual(["r"]);
  });
});

describe("truncation detection", () => {
  it("recognizes timeout/memory remarks and configured element ceilings", () => {
    expect(detectOverpassTruncation({ elements: [], remark: "Query timed out" })).toBe(true);
    expect(detectOverpassTruncation({ elements: [], remark: "runtime error: out of memory" })).toBe(true);
    expect(detectOverpassTruncation({ elements: [{ type: "node", id: 1 }] }, 1)).toBe(true);
    expect(detectOverpassTruncation({ elements: [] })).toBe(false);
  });
});
