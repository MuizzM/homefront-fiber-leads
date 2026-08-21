import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getVoiceProvider,
  setVoiceProvider,
  resetVoiceProvider,
  voiceProviderReady,
  type VoiceProvider,
} from "../../server/calling/voiceProviders";

// The voice seam is the browser softphone's only server dependency. Its whole
// safety story is fail-closed: with no provider wired, it must REFUSE (not
// no-op), so the client falls back to reveal-and-hand-dial instead of believing
// it can place a call. These tests pin that contract.

const savedEnv = { key: process.env.TELNYX_API_KEY, cred: process.env.TELNYX_WEBRTC_CREDENTIAL_ID };

beforeEach(() => {
  delete process.env.TELNYX_API_KEY;
  delete process.env.TELNYX_WEBRTC_CREDENTIAL_ID;
  resetVoiceProvider();
});

afterEach(() => {
  process.env.TELNYX_API_KEY = savedEnv.key;
  process.env.TELNYX_WEBRTC_CREDENTIAL_ID = savedEnv.cred;
  if (savedEnv.key === undefined) delete process.env.TELNYX_API_KEY;
  if (savedEnv.cred === undefined) delete process.env.TELNYX_WEBRTC_CREDENTIAL_ID;
  resetVoiceProvider();
  vi.restoreAllMocks();
});

describe("voice provider seam (fail-closed)", () => {
  it("defaults to the unconfigured refuser when no credentials are set", () => {
    expect(getVoiceProvider().name).toBe("none");
    expect(voiceProviderReady()).toBe(false);
  });

  it("the refuser returns a safe error, never a fake success token", async () => {
    const result = await getVoiceProvider().mintClientToken({ identity: "t1-u1" });
    expect(result.ok).toBe(false);
    expect(result.token).toBeNull();
    expect(result.safeError).toBeTruthy();
    // The refusal string is admin-actionable and leaks nothing sensitive.
    expect(result.safeError).not.toMatch(/telnyx|bearer|token|key/i);
  });

  it("selects Telnyx only when BOTH credentials are present", () => {
    process.env.TELNYX_API_KEY = "KEYtest";
    resetVoiceProvider();
    // One of two is not enough - still fail-closed.
    expect(voiceProviderReady()).toBe(false);
    process.env.TELNYX_WEBRTC_CREDENTIAL_ID = "cred_123";
    resetVoiceProvider();
    expect(getVoiceProvider().name).toBe("telnyx");
    expect(voiceProviderReady()).toBe(true);
  });

  it("Telnyx never surfaces a raw provider error body to the caller", async () => {
    process.env.TELNYX_API_KEY = "KEYtest";
    process.env.TELNYX_WEBRTC_CREDENTIAL_ID = "cred_123";
    resetVoiceProvider();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("credential cred_123 for account acct_secret is invalid", { status: 422 }),
    );
    const result = await getVoiceProvider().mintClientToken({ identity: "t1-u1" });
    expect(result.ok).toBe(false);
    expect(result.token).toBeNull();
    expect(result.safeError).not.toMatch(/acct_secret|cred_123/);
  });

  it("Telnyx accepts a raw-text JWT body and reports an expiry", async () => {
    process.env.TELNYX_API_KEY = "KEYtest";
    process.env.TELNYX_WEBRTC_CREDENTIAL_ID = "cred_123";
    resetVoiceProvider();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("eyJhbGciOiJFUzI1NiJ9.header.sig", { status: 200 }));
    const result = await getVoiceProvider().mintClientToken({ identity: "t1-u1", ttlSeconds: 300 });
    expect(result.ok).toBe(true);
    expect(result.token).toBe("eyJhbGciOiJFUzI1NiJ9.header.sig");
    expect(result.expiresAt && Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("a swapped-in stub can force-refuse (the hook a test uses to assert no dial)", async () => {
    const stub: VoiceProvider = {
      name: "stub",
      isConfigured: () => false,
      mintClientToken: async () => ({ ok: false, token: null, expiresAt: null, safeError: "stubbed" }),
    };
    setVoiceProvider(stub);
    expect(voiceProviderReady()).toBe(false);
    expect((await getVoiceProvider().mintClientToken({ identity: "x" })).safeError).toBe("stubbed");
  });
});
