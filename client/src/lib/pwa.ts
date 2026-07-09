// ── PWA registration + graceful update flow ───────────────────────────────────
// Registers the service worker (prod only — a SW in dev fights Vite HMR), and
// when a new deploy is detected, dispatches "hfs:update-ready" so the app can
// offer a one-tap reload. applyUpdate() tells the waiting worker to take over.

let waitingWorker: ServiceWorker | null = null;

export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return; // dev: no SW (HMR owns the page)

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => {
      // A worker already waiting (returning user mid-deploy) → prompt now.
      if (reg.waiting) notifyUpdate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          // Installed + an existing controller = a NEW version is ready.
          if (sw.state === "installed" && navigator.serviceWorker.controller) notifyUpdate(sw);
        });
      });
    }).catch(() => { /* registration blocked (private mode / policy) — app still runs online */ });

    // The new worker took control → reload once to run fresh code atomically.
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
  });
}

function notifyUpdate(sw: ServiceWorker): void {
  waitingWorker = sw;
  window.dispatchEvent(new CustomEvent("hfs:update-ready"));
}

// Called by the update toast/button — swap to the new version.
export function applyUpdate(): void {
  waitingWorker?.postMessage("SKIP_WAITING");
}
