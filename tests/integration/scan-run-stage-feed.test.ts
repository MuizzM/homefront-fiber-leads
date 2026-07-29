// ── Run-scoped scan stage feed ────────────────────────────────────────────────
// The Scan Inspector is requireAdmin, so whoever STARTED an area scan could never
// see why it was or wasn't moving. /api/scan/runs/:runId/stages (+ /stream) expose
// the SAME telemetry under a capability gate, narrowed to one run the caller's
// tenant owns. These tests pin the properties that make that safe: capability
// (not admin), the tenant wall, no secret material in the payload, hard bounds,
// and SSE listener cleanup on disconnect.
//
// The authorized non-admin here is a MANAGER, not a rep. scan.submit used to sit
// in the rep set, which is what put a Scan Map in front of every door-knocker;
// it now starts at manager. The tenant-wall cases deliberately use an identity
// that CAN scan — otherwise they would 403 on capability and stop proving
// anything about tenancy at all.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server;
let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let bus: typeof import("../../server/scanStageBus");
let events: typeof import("../../server/scanEvents");

let repSession: string;      // tenant 1, role rep  → must NOT hold scan.submit
let managerSession: string;  // tenant 1, role manager
let callingSession: string;  // tenant 1, role calling_rep → NO scan.submit
let otherTenantSession: string; // tenant 2 admin — full power, wrong tenant

const RUN_A = "run_field_feed_a";     // tenant 1
const RUN_B = "run_field_feed_b";     // tenant 2
const RUN_BOUNDED = "run_field_feed_bounded";

// Secret material that must never survive the projection. The full JWT is the
// literal string an upstream error could echo; the proxy URL/password shapes are
// what a provider failure message has historically carried.
const FULL_TOKEN = "eyJhbGciOiJIUzI1NiJ9.FIELDFEEDSUPERSECRETJWTPAYLOAD.sigABCDwXyZ";
const PROXY_URL = "https://api.gokinetic.com/v3/availability?key=hunter2";
const BASIC_AUTH = "Basic QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw";

const realFetch = globalThis.fetch.bind(globalThis);

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-scan-run-stages-"));
  process.env.NODE_ENV = "test";

  const storageModule = await import("../../server/storage");
  storageModule.runMigrations();
  storage = storageModule.storage;
  const { rawDb } = await import("../../server/db");

  rawDb.prepare(
    "INSERT OR IGNORE INTO tenants (id, slug, company_name, owner_name, owner_email, brand_name) VALUES (2, 'tenant-b-stage-feed', 'Tenant B', 'Owner B', 'owner-b-stage-feed@example.test', 'Tenant B')",
  ).run();

  const mkSession = (name: string, email: string, role: string, tenantId: number) =>
    storage.createSession(storage.createUser({ name, email, role, active: true, tenantId } as any).id).id;

  repSession = mkSession("Stage Feed Rep", "rep-stage-feed@example.test", "rep", 1);
  managerSession = mkSession("Stage Feed Manager", "manager-stage-feed@example.test", "manager", 1);
  callingSession = mkSession("Stage Feed Caller", "caller-stage-feed@example.test", "calling_rep", 1);
  otherTenantSession = mkSession("Tenant B Admin", "admin-b-stage-feed@example.test", "admin", 2);

  const { createScanRun } = await import("../../server/scanIntelStore");
  createScanRun({ id: RUN_A, tenantId: 1, kind: "field", label: "Inman sweep", city: "Inman", state: "SC", budget: 500 });
  createScanRun({ id: RUN_B, tenantId: 2, kind: "field", label: "Other org sweep", city: "Boone", state: "NC", budget: 500 });
  createScanRun({ id: RUN_BOUNDED, tenantId: 1, kind: "field", label: "Bounded sweep", city: "Inman", state: "SC", budget: 5000 });

  bus = await import("../../server/scanStageBus");
  events = await import("../../server/scanEvents");
  events.startScanEvents(); // attach the persist + relay subscriber

  const { registerRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = createServer(app);
  registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;

  seedRun(RUN_A);
  for (let i = 0; i < 260; i++) {
    bus.emitStage({
      addressKey: `bounded|${i}`, address: `${i} Bounded Way`, city: "Inman", state: "SC", zip: "29349",
      runId: RUN_BOUNDED, source: "field", stage: "classified", status: "ok", attempt: 1,
      classification: "fresh_fiber", tsEpoch: Date.now() + i,
    });
  }
  events.flushScanEvents();
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

// One address moving through the pipeline, ending in an auth retry whose upstream
// text carries every secret shape we must scrub.
function seedRun(runId: string) {
  const base = {
    addressKey: "field|1-secret-st", address: "1 Secret St", city: "Inman", state: "SC", zip: "29349",
    runId, source: "field", attempt: 1,
  } as const;
  const t = Date.now();
  bus.emitStage({ ...base, stage: "queued", status: "info", tsEpoch: t });
  bus.emitStage({ ...base, stage: "minting", status: "info", tsEpoch: t + 1 });
  bus.emitStage({
    ...base, stage: "token_ready", status: "info",
    sessionId: "decodo-s3", tokenSuffix: FULL_TOKEN.slice(-4), tsEpoch: t + 2,
  });
  bus.emitStage({
    ...base, stage: "retry", status: "pending_auth", httpStatus: 403,
    sessionId: "decodo-s3", tokenSuffix: FULL_TOKEN.slice(-4),
    retryReason: `auth 403 from ${PROXY_URL} — rotating session`,
    detail: `upstream rejected ${BASIC_AUTH} with token ${FULL_TOKEN}`,
    tsEpoch: t + 3,
  });
  events.flushScanEvents();
}

function request(path: string, sessionId: string, init: RequestInit = {}) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-session-id": sessionId, ...(init.headers ?? {}) },
  });
}

describe("run-scoped scan stage feed — authorization", () => {
  it("lets a MANAGER (capability scan.submit, not admin) read their own tenant's run", async () => {
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, managerSession);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.run).toMatchObject({ id: RUN_A, label: "Inman sweep" });
    expect(body.stages.length).toBeGreaterThan(0);
    expect(body.stages[0].stage).toBe("retry"); // latest stage for the address
    expect(body.counters.found).toBe(1);
    expect(typeof body.paused).toBe("boolean");
  });

  it("refuses a plain REP — scanning is not field work", async () => {
    // A rep knocking doors has no reason to read a discovery run, and holding
    // scan.submit is what let them start one. The UI hides the affordance; this
    // is the half that holds when someone calls the endpoint directly.
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, repSession);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Forbidden", need: "scan.submit" });
  });

  it("rejects an identity without scan.submit with 403 and names the capability", async () => {
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, callingSession);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "Forbidden", need: "scan.submit" });
  });

  it("rejects an unauthenticated caller", async () => {
    const response = await realFetch(`${baseUrl}/api/scan/runs/${RUN_A}/stages`);
    expect(response.status).toBe(401);
  });
});

describe("run-scoped scan stage feed — tenant isolation", () => {
  it("does not serve another tenant's run even to that other tenant's ADMIN", async () => {
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, otherTenantSession);
    expect(response.status).toBe(404); // 404 not 403 — never confirm a foreign run id exists
    expect(await response.json()).toMatchObject({ error: "Run not found" });
  });

  it("does not let a tenant-1 manager reach a tenant-2 run", async () => {
    const response = await request(`/api/scan/runs/${RUN_B}/stages`, managerSession);
    expect(response.status).toBe(404);
  });

  it("ignores a client-supplied tenant hint — the wall is the session's tenant", async () => {
    const response = await request(`/api/scan/runs/${RUN_B}/stages?tenantId=2&tenant_id=2`, managerSession);
    expect(response.status).toBe(404);
  });

  it("404s an unknown run id", async () => {
    const response = await request(`/api/scan/runs/run_does_not_exist/stages`, managerSession);
    expect(response.status).toBe(404);
  });

  it("blocks the SSE variant across the tenant wall before any stream opens", async () => {
    const response = await request(`/api/scan/runs/${RUN_B}/stages/stream`, managerSession);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    await response.text();
  });
});

describe("run-scoped scan stage feed — no secret material", () => {
  it("never emits a token, JWT, proxy credential, or upstream URL", async () => {
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, managerSession);
    const raw = await response.text();
    expect(raw).not.toContain(FULL_TOKEN);
    expect(raw).not.toContain("FIELDFEEDSUPERSECRETJWTPAYLOAD");
    expect(raw).not.toContain("gokinetic");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain(BASIC_AUTH);
    expect(raw).not.toContain("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVoxMjM0NTY3ODkw");
    // The scrubber replaced the secrets in place rather than dropping the field —
    // the rep still learns WHY the address retried.
    const retry = (JSON.parse(raw) as any).stages.find((s: any) => s.stage === "retry");
    expect(retry.retryReason).toContain("auth 403");
    expect(retry.retryReason).toContain("[redacted]");
    expect(retry.detail).toContain("[redacted]");
  });

  it("drops proxy/credential infrastructure fields entirely (allowlist projection)", async () => {
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, managerSession);
    const body = (await response.json()) as any;
    for (const row of body.stages) {
      expect(row).not.toHaveProperty("sessionId");   // masked at the bus, still not shipped
      expect(row).not.toHaveProperty("tokenSuffix"); // ditto
      expect(row).not.toHaveProperty("addressKey");  // exposed only as correlationId
      expect(Object.keys(row).sort()).toEqual([
        "address", "attempt", "city", "classification", "correlationId", "detail",
        "httpStatus", "latencyMs", "retryReason", "runId", "source", "stage",
        "startedAt", "state", "status", "ts", "tsEpoch", "zip",
      ]);
      expect(typeof row.tsEpoch).toBe("number"); // normalized from InspectorRow.updatedAt
    }
  });

  it("omits spend detail from the run header (budget/cost stay manager+)", async () => {
    const response = await request(`/api/scan/runs/${RUN_A}/stages`, managerSession);
    const body = (await response.json()) as any;
    expect(body.run).not.toHaveProperty("budget");
    expect(body.run).not.toHaveProperty("costUsd");
    expect(body.run).not.toHaveProperty("estBytes");
    expect(body.run).not.toHaveProperty("tenantId");
  });
});

describe("run-scoped scan stage feed — bounded", () => {
  it("caps rows regardless of the requested limit", async () => {
    const response = await request(`/api/scan/runs/${RUN_BOUNDED}/stages?limit=100000`, managerSession);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.limit).toBe(200);              // clamped to the field cap
    expect(body.stages.length).toBe(200);      // 260 addresses exist in the run
    expect(body.stages.length).toBeLessThan(260);
  });

  it("clamps hostile limit values instead of trusting them", async () => {
    for (const limit of ["-1", "0", "abc", "1e9", "NaN"]) {
      const body = (await (await request(`/api/scan/runs/${RUN_BOUNDED}/stages?limit=${limit}`, managerSession)).json()) as any;
      expect(body.limit).toBeGreaterThanOrEqual(10);
      expect(body.limit).toBeLessThanOrEqual(200);
      expect(body.stages.length).toBeLessThanOrEqual(200);
    }
  });

  it("exposes no offset/cursor, so the table cannot be walked page by page", async () => {
    const first = (await (await request(`/api/scan/runs/${RUN_BOUNDED}/stages?limit=50`, managerSession)).json()) as any;
    const walked = (await (await request(`/api/scan/runs/${RUN_BOUNDED}/stages?limit=50&offset=50&after=50&page=2`, managerSession)).json()) as any;
    expect(walked.stages.map((s: any) => s.correlationId)).toEqual(first.stages.map((s: any) => s.correlationId));
  });
});

describe("run-scoped scan stage feed — SSE lifecycle", () => {
  it("streams only this run's events and releases its relay listener on disconnect", async () => {
    const baseline = events.scanEventListenerCount();

    const controller = new AbortController();
    const response = await request(`/api/scan/runs/${RUN_A}/stages/stream`, managerSession, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readUntil = async (needle: string, budgetMs = 4000) => {
      const deadline = Date.now() + budgetMs;
      while (!buffered.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
      return buffered.includes(needle);
    };

    expect(await readUntil("event: snapshot")).toBe(true);
    // Subscription is live only once the handler has attached its relay listener.
    await waitFor(() => events.scanEventListenerCount() > baseline);

    // An event for ANOTHER run must not appear on this stream.
    bus.emitStage({
      addressKey: "field|other-run", address: "9 Other Rd", city: "Boone", state: "NC", zip: "28607",
      runId: RUN_B, source: "field", stage: "searching", status: "info", attempt: 1, tsEpoch: Date.now(),
    });
    bus.emitStage({
      addressKey: "field|1-secret-st", address: "1 Secret St", city: "Inman", state: "SC", zip: "29349",
      runId: RUN_A, source: "field", stage: "classified", status: "ok", attempt: 2,
      classification: "fresh_fiber", detail: `saved via ${PROXY_URL}`, tsEpoch: Date.now(),
    });

    expect(await readUntil("fresh_fiber")).toBe(true);
    expect(buffered).not.toContain("9 Other Rd");     // other tenant's run filtered out
    expect(buffered).not.toContain("gokinetic");      // live frames are scrubbed too
    expect(buffered).not.toContain("hunter2");

    controller.abort();
    await reader.cancel().catch(() => {});
    // The close handler must unsubscribe — otherwise every scan event keeps
    // fanning out to a dead socket forever.
    await waitFor(() => events.scanEventListenerCount() === baseline);
    expect(events.scanEventListenerCount()).toBe(baseline);
  });

  it("does not leak listeners across repeated connect/disconnect cycles", async () => {
    const baseline = events.scanEventListenerCount();
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const response = await request(`/api/scan/runs/${RUN_A}/stages/stream`, managerSession, { signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read(); // first frame = snapshot, so the handler is fully attached
      controller.abort();
      await reader.cancel().catch(() => {});
      await waitFor(() => events.scanEventListenerCount() === baseline);
    }
    expect(events.scanEventListenerCount()).toBe(baseline);
  });
});

async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
