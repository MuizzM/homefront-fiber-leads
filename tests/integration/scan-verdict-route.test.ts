import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const scanAddressMock = vi.fn();

let server: Server;
let baseUrl: string;
let sessionId: string;
let rawDb: import("better-sqlite3").Database;

function resultFor(address: string) {
  const base = {
    address,
    city: "Lexington",
    state: "NC",
    zip: "27292",
    lat: 35.82,
    lng: -80.25,
    isTenured: false,
    billingStatus: null,
    apiSource: "kinetic_live",
    blocked: false,
    leadTag: null,
    leadScore: 0,
  };
  if (address.startsWith("100")) return {
    ...base,
    fiberStatus: "new_fiber",
    isNewFiber: true,
    fiberAvailable: true,
    billingStatus: "N",
  };
  if (address.startsWith("200")) return {
    ...base,
    fiberStatus: "tenured_fiber",
    isNewFiber: false,
    isTenured: true,
    fiberAvailable: true,
    billingStatus: "N",
  };
  return {
    ...base,
    fiberStatus: "unknown",
    isNewFiber: false,
    fiberAvailable: false,
    apiSource: "failed",
  };
}

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-scan-verdict-api-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  ({ rawDb } = await import("../../server/db"));
  const admin = storageModule.storage.createUser({
    name: "Scan Admin",
    email: "scan-verdict-admin@example.com",
    role: "admin",
    active: true,
    tenantId: 1,
  } as any);
  sessionId = storageModule.storage.createSession(admin.id).id;

  const { registerRoutes, setAddressScannerForTest } = await import("../../server/routes");
  setAddressScannerForTest(scanAddressMock as any);
  const app = express();
  app.use(express.json());
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  scanAddressMock.mockImplementation(async (address: string) => resultFor(address));
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function api(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...init?.headers },
  });
}

describe("scan verdict API", () => {
  it("streams and summarizes every city address as fresh, not fresh, or unverified", async () => {
    const start = await api("/api/scan/start-city", {
      method: "POST",
      body: JSON.stringify({
        city: "Lexington",
        state: "NC",
        addresses: [
          { address: "100 Fresh St", city: "Lexington", state: "NC", zip: "27292", lat: 35.82, lng: -80.25 },
          { address: "200 Old St", city: "Lexington", state: "NC", zip: "27292", lat: 35.821, lng: -80.251 },
          { address: "300 Retry St", city: "Lexington", state: "NC", zip: "27292", lat: 35.822, lng: -80.252 },
        ],
      }),
    });
    expect(start.status).toBe(200);
    const { jobId } = await start.json() as any;

    let job: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await api(`/api/scan/${jobId}`);
      job = await response.json();
      if (job.status === "done") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    expect(job.status).toBe("done");
    expect(job.results).toHaveLength(3);
    expect(job.results.map((row: any) => row.freshFiberVerdict).sort()).toEqual(["not_fresh", "unverified", "unverified"]);
    expect(job.results.find((row: any) => row.address === "100 Fresh St")).toMatchObject({
      isFreshFiber: false,
      confirmation: "baseline_available",
      verdictLabel: "Freshness unknown",
    });
    expect(job.summary).toMatchObject({ fresh: 0, not_fresh: 1, unverified: 2, eligible: 0, scanned: 3, remaining: 0 });
    expect(job.results.every((row: any) => !("rawResponse" in row) && !("dfAddressId" in row))).toBe(true);
    const worker = await (await api("/api/scanner/state")).json() as any;
    expect(worker.diagNewFiber).toBe(1);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE address='100 Fresh St'`).get() as any).n).toBe(0);
    expect(rawDb.prepare(`SELECT transition_status,fresh FROM availability_snapshots s
      JOIN scan_targets t ON t.id=s.scan_target_id WHERE t.address='100 Fresh St' ORDER BY s.id DESC LIMIT 1`).get())
      .toEqual({ transition_status: "baseline_available", fresh: 0 });
  });

  it("returns only the business verdict from a one-address check", async () => {
    const response = await api("/api/check-fiber", {
      method: "POST",
      body: JSON.stringify({ address: "100 Fresh St", city: "Lexington", state: "NC", zip: "27292" }),
    });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ verdict: "unverified", isFreshFiber: false, label: "Freshness unknown", confirmation: "baseline_available" });
    expect(body.address).toMatchObject({ line1: "100 Fresh St", city: "Lexington", state: "NC", zip: "27292" });
    expect(body).not.toHaveProperty("billingStatus");
    expect(body).not.toHaveProperty("rawResponse");
    expect(body).not.toHaveProperty("apiSource");
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE address='100 Fresh St'`).get() as any).n).toBe(0);
  });

  it("publishes a route observation once only after a proven flip is independently corroborated", async () => {
    const address = "400 Confirmed Flip St";
    const unavailable = {
      ...resultFor(address),
      address,
      fiberStatus: "no_service",
      fiberAvailable: false,
      isNewFiber: false,
      billingStatus: null,
      householdSegmentType: "PROSPECT",
      techType: null,
      apiSource: "kinetic_live",
    };
    scanAddressMock.mockResolvedValue(unavailable);
    const baseline = await api("/api/check-fiber", {
      method: "POST",
      body: JSON.stringify({ address, city: "Lexington", state: "NC", zip: "27292" }),
    });
    expect(baseline.status).toBe(200);
    const target = rawDb.prepare(`SELECT id FROM scan_targets WHERE address=?`).get(address) as { id: number };
    expect(target.id).toBeGreaterThan(0);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE address=?`).get(address) as any).n).toBe(0);

    rawDb.prepare(`INSERT INTO availability_corroboration
      (tenant_id,scan_target_id,source,source_record_id,observed_at,availability,technology,max_down_mbps,evidence_hash,import_batch_id)
      VALUES (1,?,'fcc_bdc_licensed','fcc-route-400',?,'available','Fiber to the Premises',1000,'fcc-route-400-hash','route-test')`)
      .run(target.id, new Date().toISOString());
    await new Promise(resolve => setTimeout(resolve, 5));

    const available = {
      ...unavailable,
      fiberStatus: "new_fiber",
      fiberAvailable: true,
      isNewFiber: true,
      billingStatus: "N",
      householdSegmentType: "NEW FIBER",
      techType: "FTTP",
    };
    scanAddressMock.mockResolvedValue(available);
    const live = await api("/api/check-fiber", {
      method: "POST",
      body: JSON.stringify({ address, city: "Lexington", state: "NC", zip: "27292" }),
    });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ verdict: "fresh", isFreshFiber: true, confirmation: "cross_verified" });
    expect(rawDb.prepare(`SELECT fresh_confidence,lead_tag,source_scan_target_id FROM leads WHERE address=?`).get(address))
      .toEqual({ fresh_confidence: "cross_verified", lead_tag: "fresh_fiber_confirmed", source_scan_target_id: target.id });

    const replay = await api("/api/check-fiber", {
      method: "POST",
      body: JSON.stringify({ address, city: "Lexington", state: "NC", zip: "27292" }),
    });
    expect(replay.status).toBe(200);
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE address=?`).get(address) as any).n).toBe(1);
  });

  it("field-map scan-house: a NEW FIBER + N tap creates a green lead and returns isFreshLead + leadId", async () => {
    const address = "500 Field Tap St";
    scanAddressMock.mockResolvedValue({
      ...resultFor("100 x"), address, city: "Lexington", state: "NC", zip: "27292",
      fiberStatus: "new_fiber", isNewFiber: true, fiberAvailable: true, billingStatus: "N",
      householdSegmentType: "NEW FIBER", techType: "FTTP", apiSource: "kinetic_live",
      // lat/lng absent from the provider answer → the tapped coords must be the fallback.
      lat: null, lng: null,
    });
    const response = await api("/api/leads/scan-house", {
      method: "POST",
      body: JSON.stringify({ address, city: "Lexington", state: "NC", zip: "27292", lat: 35.9, lng: -80.3 }),
    });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.isFreshLead).toBe(true);
    expect(body.leadId).toBeGreaterThan(0);
    expect(body.unresolved).toBe(false);
    // A real, single green lead — created via the projector (never a direct
    // insert), located at the TAPPED point so the pin can't be filtered out.
    const lead = rawDb.prepare(`SELECT lead_tag,lat,lng FROM leads WHERE address=?`).get(address) as any;
    expect(lead).toMatchObject({ lead_tag: "fresh_fiber_confirmed", lat: 35.9, lng: -80.3 });
  });

  it("field-map scan-house: a blocked/failed answer is UNRESOLVED, never a false 'no fiber'", async () => {
    const address = "600 Throttled St";
    scanAddressMock.mockResolvedValue({
      ...resultFor("300 x"), address, city: "Lexington", state: "NC", zip: "27292",
      fiberStatus: "unknown", isNewFiber: false, fiberAvailable: false,
      apiSource: "failed", blocked: true,
    });
    const response = await api("/api/leads/scan-house", {
      method: "POST",
      body: JSON.stringify({ address, city: "Lexington", state: "NC", zip: "27292", lat: 35.9, lng: -80.31 }),
    });
    const body = await response.json() as any;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.unresolved).toBe(true);
    expect(body.isFreshLead).toBe(false);
    expect(body.verdict).not.toBe("not_fresh"); // a throttle must never read as a No
    expect((rawDb.prepare(`SELECT COUNT(*) n FROM leads WHERE address=?`).get(address) as any).n).toBe(0);
  });

  it("rejects malformed one-address checks before spending a provider request", async () => {
    const response = await api("/api/check-fiber", {
      method: "POST",
      body: JSON.stringify({ address: "x", city: "L", state: "North Carolina", zip: "bad" }),
    });
    expect(response.status).toBe(400);
    expect(scanAddressMock).not.toHaveBeenCalled();
  });

  it("admits many consecutive authorized scans without the former three-per-hour cap", async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => api("/api/scan/start-city", {
      method: "POST",
      body: JSON.stringify({
        city: "Lexington",
        state: "NC",
        addresses: [{
          address: `200${index} Existing Fiber St`,
          city: "Lexington",
          state: "NC",
          zip: "27292",
          lat: 35.82 + index * 0.00001,
          lng: -80.25,
        }],
      }),
    })));

    expect(responses.map(response => response.status)).toEqual(Array(12).fill(200));
    expect(responses.every(response => response.headers.get("x-scan-admission") === "queued")).toBe(true);
  });
});
