import { describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  isScanMutationPath, isScanPollPath, isScanReadPath,
  scanMutationRateLimitMax, scanReadRateLimitMax, scanPollRateLimitMax,
  rescanPoolRateLimitMax, shouldSkipGlobalRateLimit,
} from "../../server/rateLimitPolicy";
import { scanWorkflowRateLimits, authorizedScanAdmission, createPerUserLimiter } from "../../server/limiters";

async function withServer(app: express.Express, fn: (base: string) => Promise<void>) {
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function scanApp(overrides: { mutationMax?: number; readMax?: number; pollMax?: number }) {
  const app = express();
  app.use(express.json());
  app.use(scanWorkflowRateLimits(overrides));
  app.post("/api/scan/start", (_req, res) => res.json({ ok: true }));
  app.post("/api/check-fiber", (_req, res) => res.json({ ok: true }));
  app.get("/api/scan/job-1", (_req, res) => res.json({ ok: true }));      // hot poll path
  app.get("/api/scan/mapbox-harvest/preview", (_req, res) => res.json({ ok: true })); // read path
  app.get("/api/leads", (_req, res) => res.json({ ok: true }));            // non-scan
  return app;
}

const SID = { "x-session-id": "session-user-1" };

describe("scan path classification", () => {
  it("flags money-spending mutations", () => {
    for (const p of [
      "/api/scan/start", "/api/scan/start-city", "/api/scan/area", "/api/scan/tiled",
      "/api/scan/daily-refresh", "/api/scan/runs", "/api/scan/rescan-pool", "/api/scan/deploy",
      "/api/sweeps/city", "/api/sweeps/state", "/api/sweeps/address",
      "/api/check-fiber", "/api/leads/scan-house",
    ]) expect(isScanMutationPath(p), p).toBe(true);
    expect(isScanMutationPath("/api/scan/runs/abc/resume")).toBe(true);
    expect(isScanMutationPath("/api/scan/job-1")).toBe(false);
    expect(isScanMutationPath("/api/sweeps")).toBe(false);
  });

  it("splits reads into hot-poll vs ordinary read", () => {
    expect(isScanPollPath("/api/scan")).toBe(true);
    expect(isScanPollPath("/api/scan/job-1")).toBe(true);
    expect(isScanPollPath("/api/scanner/state")).toBe(true);
    expect(isScanReadPath("/api/scan/mapbox-harvest/preview")).toBe(true);
    expect(isScanReadPath("/api/sweeps/7/results")).toBe(true);
    expect(isScanReadPath("/api/scan/job-1")).toBe(false); // poll, not read bucket
  });

  it("keeps scan paths out of the GLOBAL bucket (dedicated budgets meter them instead)", () => {
    expect(shouldSkipGlobalRateLimit("/api/scan/start", "production")).toBe(true);
    expect(shouldSkipGlobalRateLimit("/api/sweeps/state", "production")).toBe(true);
  });

  it("defaults: 120/h mutations, 600/h reads, 3600/h polls, 6/h rescan-pool", () => {
    expect(scanMutationRateLimitMax(undefined)).toBe(120);
    expect(scanReadRateLimitMax(undefined)).toBe(600);
    expect(scanPollRateLimitMax(undefined)).toBe(3_600);
    expect(rescanPoolRateLimitMax(undefined)).toBe(6);
    expect(scanMutationRateLimitMax("999")).toBe(999);
    expect(scanReadRateLimitMax("bad")).toBe(600);
  });
});

describe("scan workflow rate limits (live middleware)", () => {
  it("mutation #121 in an hour is 429; reads are unaffected", async () => {
    await withServer(scanApp({ mutationMax: 120, readMax: 600, pollMax: 3600 }), async (base) => {
      let last = 0;
      for (let i = 0; i < 121; i++) {
        const res = await fetch(`${base}/api/scan/start`, { method: "POST", headers: { "Content-Type": "application/json", ...SID }, body: "{}" });
        last = res.status;
      }
      expect(last).toBe(429);
      // Reads draw from their own bucket — still fine after the mutation cap blew.
      const read = await fetch(`${base}/api/scan/mapbox-harvest/preview`, { headers: SID });
      expect(read.status).toBe(200);
      const poll = await fetch(`${base}/api/scan/job-1`, { headers: SID });
      expect(poll.status).toBe(200);
    });
  }, 60_000);

  it("read #601 in an hour is 429 while a different session keeps its own budget", async () => {
    await withServer(scanApp({ mutationMax: 120, readMax: 600, pollMax: 3600 }), async (base) => {
      let last = 0;
      for (let i = 0; i < 601; i++) {
        const res = await fetch(`${base}/api/scan/mapbox-harvest/preview`, { headers: SID });
        last = res.status;
      }
      expect(last).toBe(429);
      const other = await fetch(`${base}/api/scan/mapbox-harvest/preview`, { headers: { "x-session-id": "session-user-2" } });
      expect(other.status).toBe(200);
    });
  }, 60_000);

  it("non-scan routes are untouched by the scan budgets", async () => {
    await withServer(scanApp({ mutationMax: 2, readMax: 2, pollMax: 2 }), async (base) => {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/api/leads`, { headers: SID });
        expect(res.status).toBe(200);
      }
    });
  });
});

describe("authorizedScanAdmission is a real admission check", () => {
  const run = (user: any) =>
    new Promise<{ status: number; body: any }>((resolve) => {
      const req: any = { user };
      const res: any = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) { this.headers[name] = value; return this; },
        status(code: number) { this.statusCode = code; return this; },
        json(body: any) { resolve({ status: this.statusCode, body, headers: this.headers }); return this; },
      };
      authorizedScanAdmission(req, res, () => resolve({ status: 200, body: { passed: true }, headers: res.headers }));
    });

  it("rejects a missing session (401)", async () => {
    expect((await run(undefined)).status).toBe(401);
    expect((await run(null)).status).toBe(401);
  });

  it("rejects a caller without scan.submit (403) — reps cannot spend scan budget", async () => {
    const out = await run({ id: 7, role: "rep" });
    expect(out.status).toBe(403);
    expect(out.body.need).toBe("scan.submit");
  });

  it("admits team lead and above (team_lead holds scan.submit per shared/capabilities)", async () => {
    for (const role of ["team_lead", "manager", "admin", "super_admin"]) {
      const out = await run({ id: 1, role });
      expect(out.status, role).toBe(200);
      expect(out.body.passed).toBe(true);
      // The admission stamp the route contract (and scan-verdict suite) relies on.
      expect((out as any).headers?.["X-Scan-Admission"]).toBe("queued");
    }
  });
});

describe("createPerUserLimiter", () => {
  it("keys on the session token, not the shared IP", async () => {
    const app = express();
    app.use(createPerUserLimiter({ max: 2, message: "cap" }));
    app.get("/x", (_req, res) => res.json({ ok: true }));
    await withServer(app, async (base) => {
      for (let i = 0; i < 2; i++) expect((await fetch(`${base}/x`, { headers: SID })).status).toBe(200);
      expect((await fetch(`${base}/x`, { headers: SID })).status).toBe(429);
      // Same IP, different session → independent budget.
      expect((await fetch(`${base}/x`, { headers: { "x-session-id": "other" } })).status).toBe(200);
    });
  });
});
