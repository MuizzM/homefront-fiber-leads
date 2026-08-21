// ── Voice providers - the browser-softphone seam ─────────────────────────────
//
// Sibling of server/messagingProviders.ts, same discipline. The calling module
// historically had NO telephony at all: a rep revealed a number and hand-dialed
// on their own phone. Click-to-call adds a browser softphone (Telnyx WebRTC) so
// a remote cold-caller dials through a headset instead - one call per tap, the
// same manual TCPA posture the compliance engine already enforces.
//
// WHAT A PROVIDER OWES, AND ONLY THAT. For click-to-call the BROWSER places the
// call; the server's whole job is to mint a short-lived registration token the
// softphone connects with. So the interface is deliberately just isConfigured()
// + mintClientToken(). No server-initiated dial lives here - a power/predictive
// dialer would be a separate, consent-gated capability, and putting a
// `placeCall()` here now would be a loaded gun for a posture we have not chosen.
//
// WHY THE DEFAULT REFUSES RATHER THAN NO-OPS. Same reason as the SMS seam: a
// token stub that "succeeds" would let the client believe it can dial, then the
// softphone fails to register with a raw provider error in front of a caller.
// The default fails loudly with an admin-actionable string, and the calling
// status route reads isConfigured() as the `calling_voice_provider_missing`
// gate, so an unconfigured org sees it on the status screen, not mid-call.

export interface VoiceTokenResult {
  ok: boolean;
  /** The short-lived JWT the browser WebRTC SDK registers with. Null on refusal. */
  token: string | null;
  /** Best-effort ISO expiry, for the client to schedule a refresh before it lapses. */
  expiresAt: string | null;
  /** Safe to store and to show. Never a credential, never a raw provider body. */
  safeError: string | null;
}

export interface VoiceProvider {
  readonly name: string;
  /** False when the org has not configured a voice provider. The status route
   *  reads it as `calling_voice_provider_missing` rather than minting a token. */
  isConfigured(): boolean;
  /** Mint a registration token for one caller's browser softphone. `identity`
   *  is an opaque per-user label for provider-side call tagging, never a secret. */
  mintClientToken(input: { identity: string; ttlSeconds?: number }): Promise<VoiceTokenResult>;
}

// ── The default voice provider: none ─────────────────────────────────────────

class UnconfiguredVoiceProvider implements VoiceProvider {
  readonly name = "none";
  isConfigured(): boolean { return false; }
  async mintClientToken(): Promise<VoiceTokenResult> {
    return {
      ok: false,
      token: null,
      expiresAt: null,
      safeError: "No voice provider is configured. The browser dialer cannot place calls until one is set up.",
    };
  }
}

// ── Telnyx WebRTC ────────────────────────────────────────────────────────────
//
// The browser SDK (@telnyx/webrtc) registers with a short-lived JWT minted from
// a Telephony Credential tied to a Credential SIP Connection. Outbound caller ID
// and the from-number come from that connection's voice profile - the same
// authorized caller-id the calling profile already tracks - so nothing about
// caller-id policy moves into this file.
//
// No Telnyx server SDK: minting is a single REST call, and Node 20's global
// fetch covers it. Keeping the server dependency-free also keeps the attack
// surface of a money/compliance module small.

const TELNYX_TOKEN_ENDPOINT = "https://api.telnyx.com/v2/telephony_credentials";

class TelnyxVoiceProvider implements VoiceProvider {
  readonly name = "telnyx";

  isConfigured(): boolean {
    return Boolean(process.env.TELNYX_API_KEY?.trim() && process.env.TELNYX_WEBRTC_CREDENTIAL_ID?.trim());
  }

  async mintClientToken(input: { identity: string; ttlSeconds?: number }): Promise<VoiceTokenResult> {
    const apiKey = process.env.TELNYX_API_KEY?.trim();
    const credentialId = process.env.TELNYX_WEBRTC_CREDENTIAL_ID?.trim();
    if (!apiKey || !credentialId) {
      return { ok: false, token: null, expiresAt: null, safeError: "Telnyx voice credentials are not configured." };
    }
    // Telnyx token TTL is fixed server-side on the credential; ttlSeconds is
    // advisory only, used to compute the client's refresh deadline.
    const ttl = Math.max(60, Math.min(3600, input.ttlSeconds ?? 600));
    try {
      const res = await fetch(`${TELNYX_TOKEN_ENDPOINT}/${encodeURIComponent(credentialId)}/token`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // The credential's own TTL governs; body carries the advisory expiry so
        // Telnyx can cap it. Harmless if the account ignores it.
        body: JSON.stringify({ expires_in: ttl }),
      });
      if (!res.ok) {
        // Never surface res.text() - Telnyx error bodies can echo account/credential
        // identifiers. Log the status for an admin, hand the caller a safe string.
        console.warn(`[calling-voice] Telnyx token mint failed: HTTP ${res.status}`);
        return { ok: false, token: null, expiresAt: null, safeError: "The voice provider rejected the token request." };
      }
      // Telnyx returns the JWT as a raw text body (not JSON). Be defensive: some
      // gateways wrap it as { data: { token } } - accept either shape.
      const raw = (await res.text()).trim();
      let token = raw;
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          token = parsed?.data?.token ?? parsed?.token ?? "";
        } catch { token = ""; }
      }
      if (!token) {
        console.warn("[calling-voice] Telnyx token mint returned an empty token");
        return { ok: false, token: null, expiresAt: null, safeError: "The voice provider returned no usable token." };
      }
      return { ok: true, token, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), safeError: null };
    } catch (e: any) {
      console.warn("[calling-voice] Telnyx token mint error:", e?.message);
      return { ok: false, token: null, expiresAt: null, safeError: "The voice provider could not be reached." };
    }
  }
}

// ── Registry ─────────────────────────────────────────────────────────────────
//
// Resolved at call time, not import time, so a test (or a late-configured org)
// can swap the implementation without a restart. `pickDefaultVoiceProvider`
// returns Telnyx only when its credentials are present, so getVoiceProvider()
// stays fail-closed: no config -> the refuser, and the status gate lights up.

function pickDefaultVoiceProvider(): VoiceProvider {
  const telnyx = new TelnyxVoiceProvider();
  return telnyx.isConfigured() ? telnyx : new UnconfiguredVoiceProvider();
}

let voiceProvider: VoiceProvider = pickDefaultVoiceProvider();

export function getVoiceProvider(): VoiceProvider { return voiceProvider; }

/** Swap an implementation in. The only way a vendor gets wired, and the hook a
 *  test uses to assert the fail-closed default refuses. */
export function setVoiceProvider(provider: VoiceProvider): void { voiceProvider = provider; }

/** Restore the shipped default (re-reading env), so one test's stub cannot leak. */
export function resetVoiceProvider(): void { voiceProvider = pickDefaultVoiceProvider(); }

/** True when a real voice provider is wired. Read by callingEnvironment() to
 *  drive the `calling_voice_provider_missing` status gate and to tell the
 *  client whether to offer the softphone or fall back to reveal-and-hand-dial. */
export function voiceProviderReady(): boolean {
  return getVoiceProvider().isConfigured();
}
