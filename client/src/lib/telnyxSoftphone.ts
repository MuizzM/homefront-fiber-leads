import { useCallback, useEffect, useRef, useState } from "react";

// ── Browser softphone (Telnyx WebRTC) ────────────────────────────────────────
//
// The client half of click-to-call. The server mints a short-lived registration
// JWT (POST /api/v1/calling/voice-token); this hook connects a Telnyx WebRTC
// client with it and exposes just what the lead screen needs: a registration
// status, the current call, and dial/hangup/mute. Everything else about the SDK
// stays behind this seam.
//
// The SDK is dynamically imported so its ~hundreds-of-KB bundle never loads for
// the vast majority of users who never open the dialer. It also means a build
// without the package still compiles (the import is resolved at call time).
//
// Posture note: this hook DIALS a number the server already authorized for one
// manual attempt. It has no auto-advance, no queue, no dialing of anything the
// rep did not just tap. The "one call per authorization" invariant lives on the
// server; this is only the transport.

export type SoftphoneStatus = "idle" | "connecting" | "registered" | "error";

/** UI-facing call phase, collapsed from Telnyx's ~12 internal states. */
export type CallPhase = "connecting" | "active" | "held" | "ended";

export interface SoftphoneCall {
  phase: CallPhase;
  /** Seconds since the call went active. 0 until answered. */
  durationSec: number;
  muted: boolean;
}

export interface Softphone {
  status: SoftphoneStatus;
  error: string | null;
  call: SoftphoneCall | null;
  /** Connect the client with a freshly minted token. Idempotent while registered. */
  register: (fetchToken: () => Promise<{ token: string }>) => Promise<void>;
  /** Place a call to an E.164 number. Rejects if not registered. */
  dial: (destinationNumber: string) => Promise<void>;
  hangup: () => void;
  toggleMute: () => void;
  /** Tear the client down (also runs on unmount). */
  disconnect: () => void;
}

// Telnyx call states that mean "still setting up" vs "up" vs "gone". Kept as a
// map rather than inlined so an SDK that adds a state fails toward "connecting"
// (harmless) rather than crashing.
const ACTIVE_STATES = new Set(["active"]);
const HELD_STATES = new Set(["held"]);
const ENDED_STATES = new Set(["hangup", "destroy", "purge"]);

export function useTelnyxSoftphone(): Softphone {
  const clientRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const durationTimerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<SoftphoneStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [call, setCall] = useState<SoftphoneCall | null>(null);

  const clearDurationTimer = useCallback(() => {
    if (durationTimerRef.current != null) {
      window.clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }, []);

  const teardownCall = useCallback(() => {
    clearDurationTimer();
    callRef.current = null;
    setCall(null);
  }, [clearDurationTimer]);

  const disconnect = useCallback(() => {
    try { callRef.current?.hangup?.(); } catch { /* already gone */ }
    try { clientRef.current?.disconnect?.(); } catch { /* already gone */ }
    clientRef.current = null;
    teardownCall();
    if (audioElRef.current) { audioElRef.current.remove(); audioElRef.current = null; }
    setStatus("idle");
  }, [teardownCall]);

  // Always tear down on unmount - a live WebRTC socket must never outlive the
  // screen, and a dangling audio element would keep the far end audible.
  useEffect(() => disconnect, [disconnect]);

  // Reflect one Telnyx call's state onto our simplified model.
  const onCallUpdate = useCallback((telnyxCall: any) => {
    // Ignore updates for a call we already replaced (rapid hangup/redial).
    if (callRef.current && telnyxCall && callRef.current.id && telnyxCall.id && callRef.current.id !== telnyxCall.id) return;
    const state: string = telnyxCall?.state ?? "";
    if (ENDED_STATES.has(state)) { teardownCall(); return; }
    const phase: CallPhase = ACTIVE_STATES.has(state) ? "active" : HELD_STATES.has(state) ? "held" : "connecting";
    setCall(prev => {
      // Start the duration clock exactly once, when the call first goes active.
      if (phase === "active" && durationTimerRef.current == null) {
        const startedAt = Date.now();
        durationTimerRef.current = window.setInterval(() => {
          setCall(c => (c ? { ...c, durationSec: Math.floor((Date.now() - startedAt) / 1000) } : c));
        }, 1000);
      }
      return { phase, durationSec: prev?.durationSec ?? 0, muted: prev?.muted ?? false };
    });
  }, [teardownCall]);

  const register = useCallback(async (fetchToken: () => Promise<{ token: string }>) => {
    if (status === "registered" || status === "connecting") return;
    setError(null);
    setStatus("connecting");
    try {
      const { token } = await fetchToken();
      // Dynamic import: the SDK only loads when someone actually opens the dialer.
      const mod: any = await import("@telnyx/webrtc");
      const TelnyxRTC = mod.TelnyxRTC ?? mod.default?.TelnyxRTC ?? mod.default;
      if (!TelnyxRTC) throw new Error("Voice SDK failed to load");

      // A hidden audio sink for the far end. Created here so the component that
      // uses the hook needs no wiring.
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.style.display = "none";
      document.body.appendChild(audioEl);
      audioElRef.current = audioEl;

      const client = new TelnyxRTC({ login_token: token });
      // Route remote media into our sink (both the property and the element id
      // are honored across SDK minor versions; set both defensively).
      audioEl.id = "hfs-telnyx-remote-audio";
      client.remoteElement = "hfs-telnyx-remote-audio";
      clientRef.current = client;

      client.on("telnyx.ready", () => { setStatus("registered"); });
      client.on("telnyx.error", (e: any) => {
        // Never surface a raw SDK/provider error string; it can carry endpoint
        // and credential detail. Log for a dev, show a safe line to the rep.
        console.warn("[softphone] telnyx.error", e?.error ?? e);
        setError("The dialer lost its connection. Reload to reconnect.");
        setStatus("error");
      });
      client.on("telnyx.socket.close", () => {
        if (clientRef.current) setStatus("error");
      });
      client.on("telnyx.notification", (notification: any) => {
        if (notification?.type === "callUpdate" && notification.call) {
          if (!callRef.current) callRef.current = notification.call;
          onCallUpdate(notification.call);
        }
      });

      client.connect();
    } catch (e: any) {
      console.warn("[softphone] register failed", e?.message);
      setError("The dialer could not start. Fall back to reveal-and-hand-dial.");
      setStatus("error");
      if (audioElRef.current) { audioElRef.current.remove(); audioElRef.current = null; }
    }
  }, [status, onCallUpdate]);

  const dial = useCallback(async (destinationNumber: string) => {
    const client = clientRef.current;
    if (!client || status !== "registered") throw new Error("The dialer is not connected");
    if (callRef.current) throw new Error("A call is already in progress");
    // callerNumber is intentionally omitted: the outbound caller ID is the
    // Telnyx SIP connection's configured default, which is where the authorized
    // caller-id belongs (see .env.example). audio only, never video.
    const newCall = client.newCall({ destinationNumber, audio: true, video: false });
    callRef.current = newCall;
    setCall({ phase: "connecting", durationSec: 0, muted: false });
  }, [status]);

  const hangup = useCallback(() => {
    try { callRef.current?.hangup?.(); } catch { /* already ended */ }
    teardownCall();
  }, [teardownCall]);

  const toggleMute = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    setCall(prev => {
      if (!prev) return prev;
      const next = !prev.muted;
      try { if (next) c.muteAudio?.(); else c.unmuteAudio?.(); } catch { /* no-op */ }
      return { ...prev, muted: next };
    });
  }, []);

  return { status, error, call, register, dial, hangup, toggleMute, disconnect };
}
