// ── Lazy map-library loader ─────────────────────────────────────────────────
//
// Replaces the inline <script> loader that used to live in index.html and pull
// mapbox-gl from api.mapbox.com. Same public contract, three differences that
// matter:
//
//   · It loads MapLibre GL JS, not mapbox-gl. MapLibre forked from mapbox-gl
//     v1 and kept the API surface, and this codebase uses none of the v2/v3
//     additions (no setConfigProperty, no projection, no fog/terrain, no
//     standard style), so every existing call site works untouched.
//   · It resolves through Vite's `import()` instead of a CDN <script>. The
//     library now ships from our own origin, which removes a third-party
//     script origin from the CSP outright - a strictly better posture than the
//     hash-plus-allowlist arrangement it replaces.
//   · `window.mapboxgl` is an ALIAS. Five call sites construct maps through
//     that global; renaming it across them buys nothing and risks missing one
//     in a file the size of MapView.
//
// ── THE CONTRACT, UNCHANGED ────────────────────────────────────────────────
//
//   window.__onMapboxReady(cb)  cb() on success, cb(Error) on failure
//   window.__loadMapbox()       start the load, no callback
//   window.__retryMapbox()      clear the failure latch and try again
//   window.__mapboxReady        boolean
//   window.__mapboxFailed       boolean
//
// FAILURE IS A STATE, NOT SILENCE - carried over verbatim from the old loader,
// because it was learned the hard way. On a blocked CDN, a captive portal or a
// dropped LTE fetch the callback used to simply never fire, leaving the rep on
// the app's primary screen with no spinner, no error and no retry, forever.
// Callbacks are invoked WITH an error so the caller can render its own failure
// UI.

declare global {
  interface Window {
    mapboxgl?: any;
    __mapboxReady?: boolean;
    __mapboxFailed?: boolean;
    __mapboxLoading?: boolean;
    __loadMapbox?: () => void;
    __onMapboxReady?: (cb: (err?: Error) => void) => void;
    __retryMapbox?: () => void;
  }
}

/**
 * Stand-in for a Mapbox access token.
 *
 * MapLibre needs no token, but several screens hold the fetched token in state
 * and use its truthiness as the "we can build a map now" gate. Rather than
 * re-plumb that gate through five components - one of which is 8,000 lines -
 * the token fetch stays and falls back to this when the server has none
 * configured. It exists to be truthy; nothing reads its value.
 */
export const NO_TOKEN_REQUIRED = "maplibre-no-token";

/**
 * Cluster expansion zoom, whichever calling convention the library uses.
 *
 * mapbox-gl took `(clusterId, callback)`. MapLibre v5 takes `(clusterId)` and
 * returns a Promise, IGNORING any callback passed alongside it. That
 * difference does not throw and does not log - the callback simply never runs,
 * so a rep taps a cluster of doors and the map sits there. Silent dead
 * controls are the worst failure shape a migration can leave behind, so this
 * normalises both into one Promise.
 *
 * Resolves null when the source cannot answer; callers should do nothing
 * rather than guess a zoom.
 */
export async function clusterExpansionZoom(
  source: any,
  clusterId: number,
  isCurrent: () => boolean = () => true,
): Promise<number | null> {
  if (!source?.getClusterExpansionZoom) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Armed BEFORE the call, because the callback flavour can fire
    // synchronously when the cluster index is already in memory.
    let settle: (z: number | null) => void = () => {};
    const viaCallback = new Promise<number | null>((resolve) => {
      settle = resolve;
      // Never hang a tap on a worker that does not answer.
      timer = setTimeout(() => resolve(null), 2000);
    });

    const maybe = source.getClusterExpansionZoom(clusterId, (err: any, zoom: number) => {
      settle(err || typeof zoom !== "number" || !Number.isFinite(zoom) ? null : zoom);
    });

    const zoom = await (maybe && typeof maybe.then === "function" ? Promise.race([maybe, viaCallback]) : viaCallback);
    return isCurrent() && typeof zoom === "number" && Number.isFinite(zoom) ? zoom : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type ReadyCallback = (err?: Error) => void;

let callbacks: ReadyCallback[] = [];

function flush(err?: Error): void {
  const pending = callbacks;
  callbacks = [];
  pending.forEach(cb => { try { cb(err); } catch { /* one bad caller must not strand the rest */ } });
}

function load(): void {
  if (window.__mapboxLoading || window.__mapboxReady || window.mapboxgl) return;
  window.__mapboxLoading = true;

  void import("./mapLibraryChunk")
    .then((mod) => {
      const lib = mod.default;
      // The alias. Assigning `accessToken` on it later is a harmless no-op:
      // MapLibre has no such property and needs none, and leaving the five
      // assignments in place keeps this change off those call sites.
      window.mapboxgl = lib;
      window.__mapboxReady = true;
      window.__mapboxLoading = false;
      flush();
    })
    .catch(() => {
      window.__mapboxLoading = false;
      window.__mapboxFailed = true;
      flush(new Error("map library failed to load"));
    });
}

/** Install the globals. Idempotent; called once from main.tsx, before React. */
export function installMapLibraryLoader(): void {
  if (typeof window === "undefined" || window.__onMapboxReady) return;

  window.__mapboxReady = false;
  window.__mapboxFailed = false;

  window.__loadMapbox = load;

  window.__onMapboxReady = (cb: ReadyCallback) => {
    if (window.__mapboxReady || window.mapboxgl) { cb(); return; }
    if (window.__mapboxFailed) { cb(new Error("map library failed to load")); return; }
    callbacks.push(cb);
    load();
  };

  /** Clears the failure latch so a "Retry" affordance can genuinely retry. */
  window.__retryMapbox = () => {
    window.__mapboxFailed = false;
    window.__mapboxLoading = false;
    load();
  };
}
