// ── The Android install prompt, caught before React exists ──────────────────
//
// Chrome fires `beforeinstallprompt` ONCE, early, and only hands you a usable
// event if a listener calls preventDefault() on it. A listener added inside a
// React component almost always misses: by the time the component mounts the
// event has already fired and been discarded. That is the failure mode where
// an "Install" button works on a hard refresh and silently does nothing every
// time after - the button is fine, the event was never captured.
//
// So the listener goes in at MODULE LOAD, from main.tsx, and the event is
// parked here. Components ask this module what it caught.
//
// iOS has no equivalent. Safari never fires this event and the only install
// path is the Share sheet, so on iPhone the banner shows the walkthrough in
// AddToHomeScreen instead. Nothing in this file applies there.

/** The Chrome-only event. Not in lib.dom, so it is spelled out here. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let wired = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach(cb => { try { cb(); } catch { /* a bad subscriber must not break the rest */ } });
}

/** Install the capture listeners. Idempotent; call as early as possible. */
export function captureInstallPrompt(): void {
  if (wired || typeof window === "undefined") return;
  wired = true;

  window.addEventListener("beforeinstallprompt", (e: Event) => {
    // Without this the browser shows its own mini-infobar and the event is
    // not reusable - we want to place the ask ourselves, next to the reason.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });

  // Installed from anywhere (our button, the omnibox icon, the mini-infobar):
  // the parked event is spent, and any banner still on screen is now a lie.
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

/** True when a real, un-spent install prompt is in hand. */
export function canPromptInstall(): boolean {
  return deferred !== null;
}

/** Subscribe to capture/spend changes. Returns an unsubscribe. */
export function subscribeInstallPrompt(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Show the browser's install dialog.
 *
 * The event is single-use whatever the user chooses, so it is cleared either
 * way. A dismissal is not a failure to retry - Chrome re-fires
 * `beforeinstallprompt` on a later visit when it decides the user is ready
 * again, and this module will catch that one too.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const evt = deferred;
  if (!evt) return "unavailable";
  deferred = null;
  notify();
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    return outcome;
  } catch {
    return "dismissed";
  }
}

/** Test seam: drop captured state between cases. */
export function _resetInstallPromptForTests(): void {
  deferred = null;
  wired = false;
  listeners.clear();
}
