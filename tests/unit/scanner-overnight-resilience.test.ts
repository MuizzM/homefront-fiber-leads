import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const city = readFileSync(join(root, "client/src/pages/CityScanner.tsx"), "utf8");
const routes = readFileSync(join(root, "server/routes.ts"), "utf8");

describe("overnight city scan monitoring", () => {
  it("discovers a server-owned active job while the scanner page is idle", () => {
    expect(city).toContain("refetchInterval: scanning ? 3000 : 15000");
    expect(city).toContain("enabled: true");
    expect(city).toContain('title: "Reconnected to active scan"');
    expect(city).toContain('apiRequest("GET", `/api/scan/${active.id}`)');
  });

  it("resumes an expired SSE stream from a one-way cursor", () => {
    expect(city).toContain("/api/scan/stream/${id}?since=${cursor}");
    expect(city).toContain('eventType === "reconnect"');
    expect(city).toContain("connectSseStreamRef.current(id, streamCursorRef.current)");
    expect(routes).toContain("const requestedSince = Math.max(0, Math.floor(Number(req.query.since) || 0))");
    expect(routes).toContain("let lastSent = Math.min(requestedSince, job.results.length)");
  });

  it("never exposes another tenant's in-memory scan through the state heartbeat", () => {
    expect(routes).toContain("canReadScanJob(stateUser, j)");
  });
});
