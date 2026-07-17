import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KINETIC_345_JAMES_ALLGOOD as FIBER_FIX } from "../fixtures/kinetic345JamesAllgood";
import { selectReliableAddressSuggestion } from "../../server/kineticResponseParser";

// Same transport doubles as kinetic-scanner-transport.test.ts: mint AND search both
// funnel through the mocked proxyFetch (the Decodo transport), so the correction
// retry is observable through ONE call log — proving zero direct requests.
const { proxyFetch, rotateProxySession } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  rotateProxySession: vi.fn(async () => {}),
}));
vi.mock("../../server/proxy-fetch", () => ({
  proxyFetch,
  rotateProxySession,
  getProxySessionId: () => "decodo-s1",
  isProxyConnected: () => true,
  getProxyStatus: () => ({ enabled: true, url: "http://redacted@proxy", slots: 100, sessionId: "decodo-s1" }),
}));
vi.mock("../../server/distributedProviderCoordinator", () => {
  class DistributedProviderCoordinator<T> {
    async execute(_key: string, _source: string, task: () => Promise<T>): Promise<T> { return task(); }
    pauseFor() { return Date.now(); }
    halt() {}
    resume() {}
    snapshot() {
      return { active: 0, queued: 0, startsLastMinute: 0, maxConcurrency: 45, maxRequestsPerMinute: 100,
        pausedUntil: null, halted: false, haltReason: null, instanceId: "test" };
    }
  }
  return { DistributedProviderCoordinator, DistributedProviderHaltedError: Error };
});

let scanner: typeof import("../../server/scanner");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The search endpoint (KFS_SCAN_URL) ends in /address/search; every OTHER
// proxyFetch call is a token mint (its URL varies with KFS_AUTH_URL). Keying off
// the search path makes the mock robust to whatever mint URL is configured.
const isSearchUrl = (url: string) => url.includes("/address/search");

// A soft success=false AddressNeedsFix response carrying suggested corrections.
function needsFix(validationResult: string, candidates: any[]): Record<string, unknown> {
  return {
    success: false,
    validationResult,
    errorCode: 0, techType: "", maxQual: "", dfAddressId: "", accessId: "",
    exchangeId: "", exactMatch: false, fiberFastFlag: false,
    addressCandidates: candidates,
  };
}

// A conclusive not-serviceable answer for the CORRECTED address (guardrail #2 probe).
const addressNotFound = {
  success: false, validationResult: "AddressNotFound", errorCode: 0, techType: "", maxQual: "",
  dfAddressId: "", accessId: "", exchangeId: "", exactMatch: false, fiberFastFlag: false,
};

// One unambiguous suggestion that corrects the queried typo to the real fiber address.
// Each scan test uses a DISTINCT address so the scanner's result cache (a module
// singleton keyed by normalized address) never leaks one test's verdict into another.
const RELIABLE_SUGGESTION = { addressLine1: "345 James Allgood Dr", city: "Inman", stateProvinceCd: "SC", postalCd: "29349" };
const TYPO_QUERY = { address: "345 Jame Allgod Drive", city: "Inman", state: "SC", zip: "29349" };

const GUARDRAIL_SUGGESTION = { addressLine1: "410 Maplewood St", city: "Inman", stateProvinceCd: "SC", postalCd: "29349" };
const GUARDRAIL_QUERY = { address: "410 Maplewod Steet", city: "Inman", state: "SC", zip: "29349" };

const BOUND_SUGGESTION = { addressLine1: "512 Piney Grove Rd", city: "Inman", stateProvinceCd: "SC", postalCd: "29349" };
const BOUND_QUERY = { address: "512 Piney Grov Road", city: "Inman", state: "SC", zip: "29349" };

describe("Kinetic scanner — apply reliable address suggestions instead of repeating unchanged requests", () => {
  // Default transport: satisfy every token mint (so background pool-warming never
  // sees an undefined response) and treat any stray search as a benign no-suggestion
  // non-answer. Each test overrides the SEARCH behavior via trackedSearch.
  const defaultTransport = async (url: string) =>
    isSearchUrl(url) ? json(200, needsFix("AddressNeedsFix", [])) : json(200, { access_token: "fresh", expires_in: 2_100 });

  beforeAll(async () => {
    process.env.KFS_AUTOMATION_AUTHORIZED = "false";
    // 0 warm tokens: these tests inject a manual token, so no background pool-warm
    // mint should fire (a stray warm mint racing across test boundaries hit an
    // undefined mock and flaked the first correction test in the full-suite run).
    process.env.KFS_TOKEN_POOL_WARM_MIN = "0";
    process.env.KFS_MINT_MIN_INTERVAL_MS = "0";
    // Serve token mints BEFORE importing the scanner so the pool's import-time warm
    // mint succeeds instead of failing (a failed warm mint would later clobber the
    // installed manual token and wedge the very first lease).
    proxyFetch.mockImplementation(defaultTransport);
    scanner = await import("../../server/scanner");
    process.env.KFS_AUTOMATION_AUTHORIZED = "true";
    // Settle the pool with a real token so no pending failed mint races the first test.
    await scanner.getAuthToken().catch(() => {});
  });

  beforeEach(() => {
    proxyFetch.mockReset();
    proxyFetch.mockImplementation(defaultTransport);
    scanner.setManualToken("test-server-token-with-a-safe-fallback-expiry");
  });

  // Records the addressLine1 of every SEARCH request (not token mints) so we can
  // assert the corrected address was re-searched and that the retry is bounded.
  function trackedSearch(handler: (addressLine1: string) => Response) {
    const searched: string[] = [];
    proxyFetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (!isSearchUrl(url)) return json(200, { access_token: "fresh", expires_in: 2_100 }); // token mint
      const body = JSON.parse(String(init.body ?? "{}"));
      searched.push(String(body.addressLine1 ?? ""));
      return handler(String(body.addressLine1 ?? ""));
    });
    return searched;
  }

  it("applies the single reliable suggestion and re-searches ONCE with the corrected address (conclusive)", async () => {
    const searched = trackedSearch(a =>
      a.includes("James Allgood") ? json(200, FIBER_FIX) : json(200, needsFix("AddressNeedsFix", [RELIABLE_SUGGESTION])));

    const r = await scanner.scanAddress(TYPO_QUERY.address, TYPO_QUERY.city, TYPO_QUERY.state, TYPO_QUERY.zip, { source: "manual" });

    // The corrected search produced the conclusive fiber verdict.
    expect(r).toMatchObject({ apiSource: "kinetic_live", fiberStatus: "new_fiber", fiberAvailable: true, techType: "FIBER" });
    // Correction is recorded on the notes, and the corrected/canonical address is adopted.
    expect(r.notes).toMatch(/Corrected AddressNeedsFix → 345 James Allgood Dr/);
    expect(r.address).toBe("345 James Allgood Dr");
    // Exactly TWO searches: the original + ONE corrected retry (bounded, no loop).
    expect(searched).toHaveLength(2);
    expect(searched[0]).toBe(TYPO_QUERY.address);
    expect(searched[1]).toContain("James Allgood");
  });

  it("falls back to non-conclusive (never NO_SERVICE) when suggestions are ambiguous — no correction attempted", async () => {
    const searched = trackedSearch(() => json(200, needsFix("AddressSuggestions", [
      { addressLine1: "100 Main St", city: "Inman", stateProvinceCd: "SC", postalCd: "29349" },
      { addressLine1: "200 Elm Ave", city: "Inman", stateProvinceCd: "SC", postalCd: "29349" },
    ])));

    const r = await scanner.scanAddress("Ambiguous Rd", "Inman", "SC", "29349", { source: "manual" });

    expect(r.apiSource).toBe("failed");
    expect(r.fiberStatus).toBe("unknown");
    expect(r.fiberStatus).not.toBe("no_service");
    expect(searched).toHaveLength(1); // ambiguous → we never guess, only the original request
    // Marker preserved so the engine's AddressNeedsFix/AddressSuggestions backoff still applies.
    expect(r.notes).toMatch(/AddressSuggestions/);
  });

  it("falls back to non-conclusive (never NO_SERVICE) when the response has no suggestions", async () => {
    const searched = trackedSearch(() => json(200, needsFix("AddressNeedsFix", [])));

    const r = await scanner.scanAddress("No Suggestions Ln", "Inman", "SC", "29349", { source: "city" });

    expect(r.apiSource).toBe("failed");
    expect(r.fiberStatus).toBe("unknown");
    expect(r.fiberStatus).not.toBe("no_service");
    expect(searched).toHaveLength(1);
  });

  it("GUARDRAIL: a correction that resolves to AddressNotFound stays unresolved — NEVER becomes NO_SERVICE", async () => {
    const searched = trackedSearch(a =>
      a.includes("Maplewood") ? json(200, addressNotFound) : json(200, needsFix("AddressNeedsFix", [GUARDRAIL_SUGGESTION])));

    const r = await scanner.scanAddress(GUARDRAIL_QUERY.address, GUARDRAIL_QUERY.city, GUARDRAIL_QUERY.state, GUARDRAIL_QUERY.zip, { source: "manual" });

    // The correction WAS attempted (two searches) …
    expect(searched).toHaveLength(2);
    expect(searched[1]).toContain("Maplewood");
    // … but a guessed correction resolving to not-found must not flip the original to no-service.
    expect(r.fiberStatus).not.toBe("no_service");
    expect(r.apiSource).toBe("failed");
    expect(r.notes).toMatch(/did not resolve|unresolved/i);
  });

  it("bounds the correction to ONE retry: if the corrected search also needs fixing, it does not loop", async () => {
    const searched = trackedSearch(() => json(200, needsFix("AddressNeedsFix", [BOUND_SUGGESTION])));

    const r = await scanner.scanAddress(BOUND_QUERY.address, BOUND_QUERY.city, BOUND_QUERY.state, BOUND_QUERY.zip, { source: "manual" });

    // Original + exactly ONE corrected retry — the retry does not spawn further corrections.
    expect(searched).toHaveLength(2);
    expect(r.apiSource).toBe("failed");
    expect(r.fiberStatus).not.toBe("no_service");
  });
});

describe("selectReliableAddressSuggestion — suggestion-selection heuristic", () => {
  it("picks a single unambiguous suggestion", () => {
    const sel = selectReliableAddressSuggestion({ addressCandidates: [RELIABLE_SUGGESTION] });
    expect(sel.suggestion?.addressLine1).toBe("345 James Allgood Dr");
    expect(sel.reason).toMatch(/single unambiguous/);
  });

  it("returns no pick for two ambiguous (unscored) suggestions", () => {
    const sel = selectReliableAddressSuggestion({ suggestions: [
      { addressLine1: "100 Main St", city: "Inman" },
      { addressLine1: "200 Elm Ave", city: "Inman" },
    ] });
    expect(sel.suggestion).toBeNull();
    expect(sel.reason).toMatch(/ambiguous/);
  });

  it("picks a clearly top-ranked scored suggestion among several", () => {
    const sel = selectReliableAddressSuggestion({ addressSuggestions: [
      { addressLine1: "345 James Allgood Dr", city: "Inman", matchScore: 96 },
      { addressLine1: "345 James Allgood Ct", city: "Inman", matchScore: 55 },
    ] });
    expect(sel.suggestion?.addressLine1).toBe("345 James Allgood Dr");
    expect(sel.reason).toMatch(/clears threshold/);
  });

  it("returns no pick when two suggestions are both flagged exact (ambiguous)", () => {
    const sel = selectReliableAddressSuggestion({ candidates: [
      { addressLine1: "1 A St", city: "X", exactMatch: true },
      { addressLine1: "2 B St", city: "X", exactMatch: true },
    ] });
    expect(sel.suggestion).toBeNull();
    expect(sel.reason).toMatch(/exact-match suggestions — ambiguous/);
  });

  it("does not apply a single explicitly low-confidence suggestion", () => {
    const sel = selectReliableAddressSuggestion({ addressCandidates: [
      { addressLine1: "9 Uncertain Way", city: "X", matchScore: 22 },
    ] });
    expect(sel.suggestion).toBeNull();
    expect(sel.reason).toMatch(/low-confidence/);
  });

  it("returns no pick when there are no candidates", () => {
    expect(selectReliableAddressSuggestion({}).suggestion).toBeNull();
  });
});
