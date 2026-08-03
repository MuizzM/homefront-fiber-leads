import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Source-level wiring assertions for the SEC-B hardening: the route handlers
// for money mutations live in sibling-owned modules, so the limiters attach
// by PATH in server/index.ts — these tests fail if that wiring is removed.

const indexSrc = fs.readFileSync(path.resolve(__dirname, "../../server/index.ts"), "utf8");
const routesSrc = fs.readFileSync(path.resolve(__dirname, "../../server/routes.ts"), "utf8");
const kineticSrc = fs.readFileSync(path.resolve(__dirname, "../../server/kineticScannerRoutes.ts"), "utf8");

describe("CSP staged fix", () => {
  it("script-src no longer allows unsafe-eval", () => {
    const scriptLine = indexSrc.split("\n").find((l) => l.includes("scriptSrc:"));
    expect(scriptLine).toBeDefined();
    expect(scriptLine).not.toContain("unsafe-eval");
    expect(indexSrc).not.toContain("'unsafe-eval'");
  });
});

describe("money-mutation limiter wiring (fix 5)", () => {
  const expectations: [string, string][] = [
    ["/api/payouts/week/pay", "payoutTransitionLimiter"],
    ["/api/commission/week/transition", "payoutTransitionLimiter"],
    ["/api/pay/disputes", "payDisputeLimiter"],
    ["/api/pay/punch-corrections", "punchCorrectionLimiter"],
    ["/api/onboarding/documents/:id/sign", "documentSignLimiter"],
    ["/api/leads/:id/knock", "knockPostLimiter"],
    ["/api/v1/calling/attempts/start", "callingAttemptLimiter"],
    ["/api/pay/nacha", "moneyExportLimiter"],
    ["/api/commission/week-export.csv", "moneyExportLimiter"],
  ];
  for (const [routePath, limiter] of expectations) {
    it(`${routePath} is behind ${limiter}`, () => {
      expect(indexSrc).toContain(`app.use("${routePath}", ${limiter})`);
    });
  }

  it("the scan budget dispatcher is mounted", () => {
    expect(indexSrc).toContain("app.use(scanWorkflowRateLimits())");
  });
});

describe("scan hardening wiring", () => {
  it("rescan-pool runs behind its dedicated limiter and the 10k cap", () => {
    const line = routesSrc.split("\n").find((l) => l.includes('"/api/scan/rescan-pool"'));
    expect(line).toContain("rescanPoolLimiter");
    expect(routesSrc).toContain("rescanPoolPlan(req.body?.limit)");
    expect(routesSrc).toContain("filterInChunks(targets, RESCAN_POOL_CHUNK");
  });

  it("SSE stream enforces connection caps and a max-duration auto-close", () => {
    expect(routesSrc).toContain("scanSseCaps.tryAcquire(");
    expect(routesSrc).toContain("scanSseCaps.options.maxDurationMs");
    expect(routesSrc).toContain("event: reconnect");
  });

  it("OTP limiters are SQLite-backed (no in-memory Maps)", () => {
    expect(routesSrc).toContain("otpRateBuckets.check(");
    expect(routesSrc).not.toContain("otpRequestLimiter = new Map");
    expect(routesSrc).not.toContain("otpVerifyLimiter  = new Map");
  });

  it("activity-log clamps its limit via the shared policy", () => {
    expect(routesSrc).toContain("clampActivityLogLimit(req.query.limit)");
  });

  it("territory-requests escapes the email HTML and caps the message", () => {
    const section = routesSrc.slice(routesSrc.indexOf('app.post("/api/territory-requests"'), routesSrc.indexOf('app.get("/api/territory-requests"'));
    expect(section).toContain("validateTerritoryRequestMessage(req.body?.message)");
    expect(section).toContain("escapeHtml(String(member.name))");
    expect(section).toContain("escapeHtml(message)");
  });

  it("leads PATCH validates allowlisted field values", () => {
    const section = routesSrc.slice(routesSrc.indexOf('app.patch("/api/leads/:id"'), routesSrc.indexOf('app.delete("/api/leads/:id"'));
    expect(section).toContain("validateLeadPatch(req.body ?? {})");
  });

  it("photo uploads validate magic bytes after multer", () => {
    expect(routesSrc).toContain('uploadKindAllowed(req.file.path, ["jpeg", "png", "webp"])');
    expect(routesSrc).toContain('uploadKindAllowed(f.path, ["jpeg", "png", "webp", "pdf"])');
  });
});

describe("kinetic CSV export cap", () => {
  it("caps rows and streams the build in chunks", () => {
    expect(kineticSrc).toContain("LIMIT ?");
    expect(kineticSrc).toContain("KINETIC_EXPORT_MAX_ROWS + 1");
    expect(kineticSrc).toContain("X-Export-Truncated");
    expect(kineticSrc).toContain("KINETIC_EXPORT_CHUNK");
  });
});
