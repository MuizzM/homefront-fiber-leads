import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hf-calling-provider-"));
let Provider: typeof import("../../server/calling/providers").GenericHttpResidentContactProvider;
type ProviderConfig = import("../../server/calling/providers").ProviderConfig;

const ADDRESS = {
  leadId: 7,
  address: "100 Main Street",
  city: "Lexington",
  state: "NC",
  zip: "27292",
};

const MATCH_RESPONSE = JSON.stringify({
  requestId: "provider-request-1",
  matches: [{
    phone: "3365551212",
    name: "Current Resident",
    relationship: "resident",
    confidence: 0.96,
    providerRecordId: "record-1",
  }],
});

const operation = (suffix = "1") => ({
  operationId: `00000000-0000-4000-8000-00000000000${suffix}`,
});

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: `provider-${crypto.randomUUID()}`,
    tenantId: 1,
    providerName: "Licensed HTTP test provider",
    adapterType: "generic_http_v1",
    enabled: true,
    contractStatus: "approved",
    permittedUseApproved: true,
    permittedUses: ["telemarketing_contact_enrichment", "phone_validation"],
    contractReference: "contract://test",
    queryCostMicros: 1,
    cacheTtlSeconds: 60,
    retentionDays: 30,
    rateLimitPerMinute: 10_000,
    secretEnvName: "TEST_CONTACT_PROVIDER_KEY",
    baseUrl: "https://8.8.8.8/v1/contact",
    dailyBudgetMicros: 10_000,
    monthlyBudgetMicros: 100_000,
    circuitOpenUntil: null,
    ...overrides,
  };
}

function response(body = MATCH_RESPONSE, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

beforeAll(async () => {
  process.env.DATA_DIR = dataDir;
  process.env.CONTACT_PROVIDER_HOST_ALLOWLIST = "8.8.8.8,127.0.0.1";
  process.env.CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST = "TEST_CONTACT_PROVIDER_KEY";
  process.env.CONTACT_PROVIDER_SECRET_BINDINGS_JSON = JSON.stringify({
    "1": { "Licensed HTTP test provider": "TEST_CONTACT_PROVIDER_KEY" },
  });
  process.env.TEST_CONTACT_PROVIDER_KEY = "test-secret-never-logged";
  ({ GenericHttpResidentContactProvider: Provider } = await import("../../server/calling/providers"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const name of [
    "DATA_DIR",
    "CONTACT_PROVIDER_HOST_ALLOWLIST",
    "CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST",
    "CONTACT_PROVIDER_SECRET_BINDINGS_JSON",
    "TEST_CONTACT_PROVIDER_KEY",
  ]) delete process.env[name];
  try {
    const { rawDb } = await import("../../server/db");
    rawDb.close();
  } catch {
    // Another teardown may already have closed this isolated database.
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("licensed calling provider HTTP boundary", () => {
  it("does not retry terminal 4xx responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response("denied", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new Provider(config()).lookup(ADDRESS, operation(), new AbortController().signal))
      .rejects.toThrow("Provider returned HTTP 401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries 429 and 5xx only, preserving one upstream operation id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("busy", { status: 503 }))
      .mockResolvedValueOnce(response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    const stableOperation = operation("2");

    const result = await new Provider(config()).lookup(ADDRESS, stableOperation, new AbortController().signal);

    expect(result.matches).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      const request = init as RequestInit;
      const headers = new Headers(request.headers);
      expect(headers.get("idempotency-key")).toBe(stableOperation.operationId);
      expect(headers.get("x-homefront-operation-id")).toBe(stableOperation.operationId);
      expect(JSON.parse(String(request.body))).toMatchObject({
        operation: "enrich_address",
        operationId: stableOperation.operationId,
      });
    }
  });

  it("retries a transport rejection but not invalid provider JSON", async () => {
    const networkFetch = vi.fn()
      .mockRejectedValueOnce(new TypeError("socket reset"))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", networkFetch);
    await expect(new Provider(config()).lookup(ADDRESS, operation("3"), new AbortController().signal))
      .resolves.toMatchObject({ requestId: "provider-request-1" });
    expect(networkFetch).toHaveBeenCalledTimes(2);

    const invalidJsonFetch = vi.fn().mockResolvedValue(response("not-json"));
    vi.stubGlobal("fetch", invalidJsonFetch);
    await expect(new Provider(config()).lookup(ADDRESS, operation("4"), new AbortController().signal))
      .rejects.toThrow("Provider returned invalid JSON");
    expect(invalidJsonFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps response-size and restricted-network failures terminal", async () => {
    const oversizedFetch = vi.fn().mockResolvedValue(response("{}", {
      headers: { "content-length": "1000001", "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", oversizedFetch);
    await expect(new Provider(config()).lookup(ADDRESS, operation("5"), new AbortController().signal))
      .rejects.toThrow("Provider response exceeded 1 MB");
    expect(oversizedFetch).toHaveBeenCalledTimes(1);

    const restrictedFetch = vi.fn();
    vi.stubGlobal("fetch", restrictedFetch);
    await expect(new Provider(config({ baseUrl: "https://127.0.0.1/private" }))
      .lookup(ADDRESS, operation("6"), new AbortController().signal))
      .rejects.toThrow("restricted network");
    expect(restrictedFetch).not.toHaveBeenCalled();
  });

  it("aborts immediately while waiting in the provider throttle", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    const throttledConfig = config({ rateLimitPerMinute: 1 });
    const provider = new Provider(throttledConfig);
    await provider.lookup(ADDRESS, operation("7"), new AbortController().signal);

    const controller = new AbortController();
    const pending = provider.lookup(ADDRESS, operation("8"), controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts retry backoff without issuing another paid request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = new Provider(config()).lookup(ADDRESS, operation("9"), controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsafe operation identifier before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new Provider(config()).lookup(ADDRESS, { operationId: "header-injection\r\nvalue" },
      new AbortController().signal)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not let another tenant use an allowlisted provider secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new Provider(config({ tenantId: 2 })).lookup(ADDRESS, operation("a"),
      new AbortController().signal)).rejects.toThrow("not bound to this tenant");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
