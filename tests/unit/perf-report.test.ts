import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM analysis script, no .d.ts by design
import { analyze, normalizeRoute, percentile, KNOWN_GAPS } from "../../scripts/perf-report.mjs";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("perf-report route normalization (redaction boundary)", () => {
  it("collapses numeric record ids so no customer identifier reaches the report", () => {
    expect(normalizeRoute("/api/leads/8213")).toBe("/api/leads/:id");
    expect(normalizeRoute("/api/leads/8213/knocks")).toBe("/api/leads/:id/knocks");
    expect(normalizeRoute("/api/leads/9002/knocks")).toBe("/api/leads/:id/knocks");
  });

  it("collapses uuids and long hex tokens (invite/session-shaped segments)", () => {
    expect(normalizeRoute("/api/x/f4edef80-8188-4809-bf47-273bcf1f2610")).toBe("/api/x/:uuid");
    expect(normalizeRoute("/api/x/a1b2c3d4e5f6a7b8c9d0e1f2")).toBe("/api/x/:token");
  });

  it("strips query strings, which is where tokens and emails would ride", () => {
    expect(normalizeRoute("/api/auth/verify?token=secret123&email=a@b.com")).toBe("/api/auth/verify");
  });

  it("keeps real route words intact", () => {
    expect(normalizeRoute("/api/commission-statements")).toBe("/api/commission-statements");
    expect(normalizeRoute("/api/leads/map/grid")).toBe("/api/leads/map/grid");
  });

  it("never throws on malformed input", () => {
    expect(normalizeRoute("")).toBe("(unknown)");
    expect(normalizeRoute(undefined as any)).toBe("(unknown)");
  });
});

describe("percentile", () => {
  it("uses nearest-rank and clamps at both ends", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 99)).toBe(10);
    expect(percentile([], 95)).toBeNull();
  });
});

describe("perf-report analyze", () => {
  it("groups distinct record ids into ONE route bucket and computes percentiles", () => {
    const lines = [
      line({ ts: "2026-08-08T01:00:00Z", event: "http.request", method: "GET", path: "/api/leads/1", status: 200, durationMs: 10 }),
      line({ ts: "2026-08-08T01:00:01Z", event: "http.request", method: "GET", path: "/api/leads/2", status: 200, durationMs: 20 }),
      line({ ts: "2026-08-08T01:00:02Z", event: "http.request", method: "GET", path: "/api/leads/3", status: 200, durationMs: 90 }),
    ];
    const r = analyze(lines);
    expect(r.routes).toHaveLength(1);
    expect(r.routes[0].route).toBe("GET /api/leads/:id");
    expect(r.routes[0].count).toBe(3);
    expect(r.routes[0].p50).toBe(20);
    expect(r.routes[0].totalMs).toBe(120);
    expect(r.window.from).toBe("2026-08-08T01:00:00Z");
    expect(r.window.to).toBe("2026-08-08T01:00:02Z");
  });

  it("survives interleaved non-JSON output instead of dying mid-incident", () => {
    const lines = [
      "1:38:16 AM [express] serving on port 5050",
      "[migration] idx_leads_canonical UNIQUE index active",
      line({ event: "http.request", method: "GET", path: "/api/x", status: 200, durationMs: 5 }),
      "{ not json at all",
    ];
    const r = analyze(lines);
    expect(r.window.parsedRecords).toBe(1);
    expect(r.window.skippedLines).toBe(3);
  });

  it("counts 5xx per route and classifies status families", () => {
    const lines = [
      line({ event: "http.request", method: "GET", path: "/api/a", status: 200, durationMs: 1 }),
      line({ event: "http.request", method: "GET", path: "/api/a", status: 500, durationMs: 2 }),
      line({ event: "http.request", method: "GET", path: "/api/a", status: 404, durationMs: 3 }),
    ];
    const r = analyze(lines);
    expect(r.routes[0].errors).toBe(1);
    expect(r.statusClasses).toEqual({ "2xx": 1, "5xx": 1, "4xx": 1 });
  });

  it("surfaces write-lock contention signals that explain a latency spike", () => {
    const lines = [
      line({ event: "auth.otp_unavailable", stage: "request", code: "SQLITE_BUSY" }),
      line({ event: "some.other", error: "database is locked" }),
      line({ event: "db.wal_guard", reason: "threshold" }),
    ];
    const r = analyze(lines);
    expect(r.signals.otpUnavailable).toBe(1);
    expect(r.signals.sqliteBusy).toBe(2); // one via code, one via error text
    expect(r.signals.walGuard).toBe(1);
  });

  it("aggregates perf.leads_map db timing separately from total request time", () => {
    const lines = [
      line({ event: "perf.leads_map", dbMs: 10, rows: 100, format: "packed", cache: "bbox" }),
      line({ event: "perf.leads_map", dbMs: 50, rows: 900, format: "packed", cache: "bbox", truncated: true }),
    ];
    const r = analyze(lines);
    expect(r.leadsMap!.samples).toBe(2);
    // Nearest-rank: p50 of two samples is the LOWER one (ceil(0.5*2)=rank 1).
    expect(r.leadsMap!.dbMs.p50).toBe(10);
    expect(r.leadsMap!.dbMs.p95).toBe(50);
    expect(r.leadsMap!.truncated).toBe(1);
    expect(r.leadsMap!.byFormat).toEqual({ packed: 2 });
  });

  it("reports an empty window honestly rather than as zero latency", () => {
    const r = analyze([]);
    expect(r.window.parsedRecords).toBe(0);
    expect(r.routes).toEqual([]);
    expect(r.leadsMap).toBeNull();
  });

  it("always ships the gap list, so a missing metric cannot read as a healthy one", () => {
    expect(KNOWN_GAPS.length).toBeGreaterThan(0);
    const names = KNOWN_GAPS.map((g: [string, string]) => g[0]);
    expect(names).toContain("event-loop delay");
    expect(names).toContain("response payload bytes");
  });
});

describe("perf-report stall attribution", () => {
  const lines = [
    // Two workers: 41 serves http and stalls, 42 serves http and is quiet, 7 is the primary (no requests).
    line({ ts: "2026-08-22T15:10:59.000Z", event: "perf.loop_lag", pid: 41, p50Ms: 12, p95Ms: 4100, maxMs: 8200 }),
    line({ ts: "2026-08-22T15:10:59.100Z", event: "perf.loop_lag", pid: 42, p50Ms: 1, p95Ms: 3, maxMs: 40 }),
    line({ ts: "2026-08-22T15:10:59.200Z", event: "perf.loop_lag", pid: 7, p50Ms: 1, p95Ms: 9, maxMs: 1500 }),
    line({ ts: "2026-08-22T15:11:59.000Z", event: "perf.loop_lag", pid: 41, p50Ms: 1, p95Ms: 2, maxMs: 30 }),
    line({ ts: "2026-08-22T15:10:41.000Z", event: "http.request", method: "GET", path: "/api/leads", status: 200, durationMs: 7900, pid: 41 }),
    line({ ts: "2026-08-22T15:10:42.000Z", event: "http.request", method: "GET", path: "/api/health", status: 200, durationMs: 2, pid: 42 }),
    line({ ts: "2026-08-22T15:10:40.500Z", event: "db.slow_statement", pid: 41, where: "worker:1", kind: "all", ms: 7850, sql: "SELECT * FROM leads WHERE tenant_id = ? AND address LIKE '?'" }),
    line({ ts: "2026-08-22T15:10:45.000Z", event: "db.slow_statement", pid: 41, where: "worker:1", kind: "transaction", ms: 1200, sql: null, origin: "server/buyerScoreJob.ts:210" }),
    line({ ts: "2026-08-22T15:10:50.000Z", event: "db.wal_guard", where: "cluster-primary", reason: "tick", beforeMb: 700, afterMb: 12, blockedMs: 1400 }),
    line({ ts: "2026-08-22T15:10:55.000Z", event: "yield_rollups.street_done", tookMs: 3100, pid: 7 }),
    line({ ts: "2026-08-22T15:10:56.000Z", event: "yield_rollups.street_chunk", tookMs: 200, pid: 7 }),
  ];

  it("aggregates slow statements by masked shape, with the worker pids that ran them", () => {
    const r = analyze(lines);
    expect(r.slowStatements).toHaveLength(2);
    expect(r.slowStatements[0].label).toContain("SELECT * FROM leads");
    expect(r.slowStatements[0].kind).toBe("all");
    expect(r.slowStatements[0].max).toBe(7850);
    expect(r.slowStatements[0].pids).toEqual([41]);
    expect(r.slowStatements[1].label).toBe("transaction @ server/buyerScoreJob.ts:210");
  });

  it("lines the worst loop-lag minute up with the requests, statements, guard and jobs stamped in it", () => {
    const r = analyze(lines);
    expect(r.stalls.minutesOver1s).toBe(1);
    const worst = r.stalls.worst[0];
    expect(worst.minute).toBe("2026-08-22T15:10");
    expect(worst.worstLagMs).toBe(8200);
    expect(worst.lag[0]).toEqual({ pid: 41, maxMs: 8200, p95Ms: 4100 });
    expect(worst.requests).toEqual([{ route: "GET /api/leads", ms: 7900, pid: 41 }]);
    expect(worst.statements[0].ms).toBe(7850);
    expect(worst.guards).toEqual([{ where: "cluster-primary", blockedMs: 1400, beforeMb: 700, afterMb: 12 }]);
    // Only durations at or above a second count as a job worth seeing.
    expect(worst.jobs).toEqual([{ event: "yield_rollups.street_done", field: "tookMs", ms: 3100, pid: 7 }]);
  });

  it("tells a worker that serves http from the primary that never does", () => {
    const r = analyze(lines);
    const byPid = Object.fromEntries(r.lagByPid.map((p: any) => [p.pid, p]));
    expect(byPid[41].servedHttp).toBe(true);
    expect(byPid[41].stalledMinutes).toBe(1);
    expect(byPid[41].samples).toBe(2);
    expect(byPid[7].servedHttp).toBe(false);
    expect(byPid[7].worstMs).toBe(1500);
    expect(byPid[42].stalledMinutes).toBe(0);
  });

  it("leaves the new sections out when the window predates the emitters", () => {
    const r = analyze([line({ ts: "2026-08-08T01:00:00Z", event: "http.request", method: "GET", path: "/api/health", status: 200, durationMs: 3 })]);
    expect(r.slowStatements).toBeNull();
    expect(r.stalls).toBeNull();
    expect(r.lagByPid).toBeNull();
  });
});
