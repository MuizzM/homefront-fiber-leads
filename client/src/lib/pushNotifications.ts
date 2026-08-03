// ── Turning on phone notifications ──────────────────────────────────────────
//
// THE IOS RULE, because it decides the whole flow:
//
// On iPhone, web push works ONLY when the app has been added to the Home Screen
// and launched from that icon (Safari 16.4+). In an ordinary Safari tab,
// `Notification.requestPermission()` either does not exist or resolves to
// "denied" — and a denied permission is STICKY. Asking a rep in Safari does not
// merely fail; it burns the one prompt iOS will ever show them, and the only way
// back is deleting and reinstalling.
//
// So on iOS the order is not negotiable: install first, ask second. That is what
// `pushReadiness()` encodes, and why the UI shows install instructions instead
// of an "Enable notifications" button when the app is in a tab.
//
// Android/Chrome subscribes fine from a tab, so it gets the direct ask.

export type PushState =
  | "unsupported"        // no service worker or no Push API at all
  | "needs_install"      // iOS in a browser tab — must be added to Home Screen first
  | "prompt"             // ready to ask
  | "granted"
  | "denied";

export interface PushReadiness {
  state: PushState;
  isIOS: boolean;
  isStandalone: boolean;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS reports its own flag; everyone else uses the media query.
  return (window.navigator as any).standalone === true
    || window.matchMedia?.("(display-mode: standalone)").matches === true;
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // iPadOS 13+ reports itself as a Mac, so the touch-point check is what
  // distinguishes an iPad from a desktop Safari that supports push in a tab.
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1);
}

export function pushReadiness(): PushReadiness {
  const ios = isIOS(), standalone = isStandalone();
  const base = { isIOS: ios, isStandalone: standalone };

  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return { ...base, state: "unsupported" };
  }
  // The install gate comes BEFORE the capability check on iOS: in a tab, iOS
  // may not expose PushManager at all, and reporting "unsupported" there would
  // tell a rep their phone can't do this when it can.
  if (ios && !standalone) return { ...base, state: "needs_install" };
  if (!("PushManager" in window) || typeof Notification === "undefined") {
    return { ...base, state: "unsupported" };
  }
  if (Notification.permission === "granted") return { ...base, state: "granted" };
  if (Notification.permission === "denied") return { ...base, state: "denied" };
  return { ...base, state: "prompt" };
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Ask, subscribe, and register the device.
 *
 * Returns false rather than throwing on refusal — a rep declining notifications
 * is an ordinary outcome, not an error, and the caller should just carry on.
 */
export async function enablePush(): Promise<boolean> {
  const readiness = pushReadiness();
  if (readiness.state !== "prompt" && readiness.state !== "granted") return false;

  try {
    const permission = readiness.state === "granted"
      ? "granted"
      : await Notification.requestPermission();
    if (permission !== "granted") return false;

    const res = await fetch("/api/push/key", { credentials: "include" });
    if (!res.ok) return false;
    const { publicKey } = await res.json();
    if (!publicKey) return false;

    const reg = await navigator.serviceWorker.ready;
    // An existing subscription is reused rather than re-created: unsubscribing
    // and resubscribing mints a new endpoint and orphans the stored row.
    const sub = await reg.pushManager.getSubscription()
      ?? await reg.pushManager.subscribe({
        userVisibleOnly: true,                      // required; silent push is not allowed
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

    const save = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth,
        userAgent: navigator.userAgent,
      }),
    });
    return save.ok;
  } catch {
    return false;
  }
}

/** Turn them off on this device only. Other devices keep receiving. */
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    // Tell the server too — an unsubscribed endpoint would otherwise linger
    // until it failed ten sends.
    await fetch("/api/push/unsubscribe", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
  } catch { /* best effort */ }
}
