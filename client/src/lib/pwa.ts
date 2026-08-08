// ── PWA registration + graceful update flow ───────────────────────────────────
// Registers the service worker (prod only — a SW in dev fights Vite HMR), and
// when a new deploy is detected, dispatches "hfs:update-ready" so the app can
// offer a one-tap reload. applyUpdate() tells the waiting worker to take over.
//
// A worker being NEW does not mean the PAGE is old. A tab that (re)loads just
// after a deploy boots the new build while the OLD worker still controls it;
// the new worker then installs, and judged by lifecycle events alone that
// looks like an update — so every deploy ended in a redundant "New version
// available" prompt and a second, pointless full reload (splash + auth round
// trip) of a page already running the new code. Updates are therefore judged
// by VERSION: script/build.ts stamps one build digest into both index.html
// (window.__HFS_BUILD__) and sw.js (SW_VERSION); the page asks the incoming
// worker for its version over a MessageChannel and prompts ONLY when they
// differ. On a match it stays silent and lets the worker activate on its own
// when the app's tabs go away — no forced takeover, so tabs genuinely running
// an old build keep their prompt and their choice.

declare global {
  interface Window {
    /** Build digest stamped by script/build.ts; absent in dev. */
    __HFS_BUILD__?: string;
  }
}

let waitingWorker: ServiceWorker | null = null;

export function registerServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return; // dev: no SW (HMR owns the page)
  window.addEventListener("load", () => {
    void initUpdateFlow(navigator.serviceWorker);
  });
}

// Separated from registerServiceWorker so tests can drive the whole flow with
// a mock container (registerServiceWorker no-ops under vitest's DEV env).
// `reload` is injectable only because jsdom's window.location is unforgeable.
export async function initUpdateFlow(
  container: ServiceWorkerContainer,
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  // Captured BEFORE registering. On a first-ever launch there is no
  // controller, so the worker installs, activates and calls clients.claim() —
  // which fires controllerchange and, without this guard, hard-reloaded the
  // page. Every new device and every post-storage-clear launch paid a second
  // full React boot and auth round trip, with a white flash, at exactly the
  // moment the route chunks were downloading. A first install has nothing to
  // swap in: the page is already running the code the worker just cached.
  const hadController = !!container.controller;

  // True while the incoming worker matches the page's own build. The
  // controllerchange below must not reload then: this page already runs the
  // new code, and the worker taking over (activating naturally, or applied
  // from an older tab's prompt) changes nothing this tab can see. Re-decided
  // for every new worker, so a later genuine deploy still reloads normally.
  let suppressReload = false;

  const decide = async (sw: ServiceWorker): Promise<void> => {
    const page = pageBuild();
    const worker = page === null ? null : await workerBuild(sw);
    if (page !== null && worker === page) {
      suppressReload = true; // the page already runs this exact build
      return;
    }
    suppressReload = false;
    notifyUpdate(sw);
  };

  // The new worker took control → reload once to run fresh code atomically.
  let reloaded = false;
  container.addEventListener("controllerchange", () => {
    if (reloaded || !hadController || suppressReload) return;
    reloaded = true;
    reload();
  });

  try {
    const reg = await container.register("/sw.js");
    // A worker already waiting (returning user mid-deploy) → decide now.
    if (reg.waiting) void decide(reg.waiting);
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        // Installed + an existing controller = a NEW version is ready.
        if (sw.state === "installed" && container.controller) void decide(sw);
      });
    });
  } catch { /* registration blocked (private mode / policy) — app still runs online */ }
}

/** The page's own build digest, stamped into index.html by script/build.ts.
 *  Null when unstamped (dev, or a stamping regression) — the update flow then
 *  falls back to its historical always-prompt behavior, erring on the side of
 *  offering an update rather than silently swallowing one. */
function pageBuild(): string | null {
  const v = window.__HFS_BUILD__;
  return typeof v === "string" && v !== "" && !v.startsWith("__") ? v : null;
}

/** Ask an installed/waiting worker for its stamped SW_VERSION. Null on
 *  timeout or failure (e.g. a worker predating the GET_VERSION handshake),
 *  which the caller treats as "different" — prompt, never suppress. */
function workerBuild(sw: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 2000);
    const channel = new MessageChannel();
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(typeof e.data === "string" ? e.data : null);
    };
    try {
      sw.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
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

export function __resetPwaForTest(): void {
  waitingWorker = null;
}
