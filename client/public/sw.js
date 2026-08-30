// ── Service worker — enterprise PWA shell ─────────────────────────────────────
// App-shell precache + runtime caching for offline-friendly field use on weak
// signal. Deliberately conservative: NEVER cache /api (auth + live data must
// stay fresh and tenant-correct), and NEVER cache cross-origin (Mapbox tiles/JS
// have their own headers + a token that must not be persisted here).
//
// Update flow: the build stamps SW_VERSION → the new worker installs, the client
// compares SW_VERSION (via the GET_VERSION handshake below) against its own
// stamped build and — only when they differ — shows an "update ready" prompt;
// skipWaiting()+reload then swaps atomically.
//
// SW_VERSION IS STAMPED AT BUILD TIME (script/build.ts rewrites the __SW_BUILD__
// token in dist/public/sw.js with a digest of the built assets). This is not
// cosmetic: a browser only treats a worker as new if the FILE'S BYTES changed.
// While this was a hardcoded literal, every deploy shipped a byte-identical
// sw.js, no `updatefound` ever fired, and the whole update prompt in
// client/src/lib/pwa.ts was unreachable. The literal below is the dev fallback
// for `vite dev` / direct file loads, where no build step runs.
const SW_VERSION = "__SW_BUILD__".startsWith("__") ? "dev" : "__SW_BUILD__";

// Versioned per build: the shell must be re-precached when index.html changes.
const SHELL_CACHE = `shell-${SW_VERSION}`;
// DELIBERATELY NOT versioned. Everything in here is content-hashed by Vite, so
// the URL already is the version — an unchanged chunk keeps its filename across
// deploys and should stay cached. Versioning this would throw away the entire
// warm cache on every deploy and re-download chunks that did not change.
const RUNTIME_CACHE = "runtime-v2";
// Bound on the runtime cache. Content-hashed names never collide, so without a
// cap it accumulates every asset from every deploy forever; once the origin hits
// the browser's quota Android evicts the WHOLE origin, taking the persisted
// query cache (localStorage) with it. Sized to hold TWO full builds with slack:
// the build has grown to ~150 hashed assets, so the old cap of 250 was evicting
// ~50 of the PREVIOUS build's chunks right after every deploy — exactly the
// chunks a still-open old tab needs next, turning its next tab switch into a
// 404 → full stale-chunk recovery reload instead of a cache hit.
const RUNTIME_MAX_ENTRIES = 360;

// The minimum needed to boot the app offline. Hashed JS/CSS are picked up at
// runtime since their names change per build.
//
// Deliberately NOT precached: "/" (the navigate handler below already stores
// and serves the same document under /index.html) and icon-512.png, which is
// 162 KB the OS only needs at Add-to-Home-Screen time. Install fires on
// window.load — exactly when the app's own route chunks are downloading — so
// precaching those two was ~200 KB competing with the screen the rep is
// waiting for, on their very first visit.
const SHELL_ASSETS = ["/index.html", "/manifest.webmanifest", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL_ASSETS)).catch(() => {}),
  );
  // New worker waits until the client tells it to take over (graceful update).
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Client → SW handshake for the update prompt.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
  // Version handshake: the page (client/src/lib/pwa.ts) compares its own
  // stamped build against this worker's before prompting. A tab that reloads
  // right after a deploy already RUNS the new build — without this check it
  // was prompted to "update" into the very code it was executing, paying a
  // second full reload for nothing.
  else if (event.data && event.data.type === "GET_VERSION" && event.ports[0]) {
    event.ports[0].postMessage(SW_VERSION);
  }
});

function isCacheable(url) {
  return url.origin === self.location.origin
    && !url.pathname.startsWith("/api/")
    && url.protocol.startsWith("http");
}

/** Vite emits every hashed build artifact under /assets/. The hash IS the
 *  cache key, so these are immutable — matching the year-long immutable
 *  Cache-Control the server sets for them (server/static.ts). */
function isImmutableAsset(url) {
  return url.pathname.startsWith("/assets/");
}

/** Only the payloads a hashed chunk URL legitimately carries — JS and CSS —
 *  may enter the immutable runtime cache. Anything else arriving with a 200
 *  (the SPA fallback's index.html before the server 404-guarded /assets/
 *  misses, a proxy or captive-portal interstitial) would be pinned forever
 *  under a URL that is never refetched, and every later load of that chunk
 *  gets HTML-as-JavaScript: the blank-tab-after-deploy failure. Fonts/images
 *  under /assets/ simply skip this cache and ride the browser's HTTP cache,
 *  which holds them under the same year-long immutable policy. */
function isChunkPayload(res) {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  return type.includes("javascript") || type.includes("text/css");
}

/** Keep the runtime cache bounded. cache.keys() returns insertion order, so the
 *  oldest entries go first. Runs after a put, never in the response path. */
async function trimRuntimeCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= RUNTIME_MAX_ENTRIES) return;
    for (const req of keys.slice(0, keys.length - RUNTIME_MAX_ENTRIES)) await cache.delete(req);
  } catch { /* quota/permission hiccup — the cache is an optimisation, not state */ }
}

async function putInRuntime(req, res) {
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    await cache.put(req, res);
    await trimRuntimeCache(cache);
  } catch { /* storage full or unavailable — serve from network and move on */ }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!isCacheable(url)) return; // /api, cross-origin (Mapbox), etc. → straight to network

  // SPA navigations: network-first so a fresh deploy lands immediately, falling
  // back to the cached shell when the signal drops (offline field launch).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        // Only a REAL shell may overwrite the cached shell. Unguarded, a proxy
        // 502 page mid-deploy, an Express error page, or a captive portal's
        // 200 replaced the precached index.html — and the next offline launch
        // served that junk as the app, defeating the offline design this
        // cache exists for. Same status+content-type bar the asset path sets.
        const type = (res.headers.get("content-type") || "").toLowerCase();
        if (res.ok && type.includes("text/html")) {
          caches.open(SHELL_CACHE).then((c) => c.put("/index.html", res.clone())).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("/index.html").then((m) => m || caches.match("/"))),
    );
    return;
  }

  // Content-hashed build assets: cache-first with NO revalidation. A hit here
  // can never be stale — a changed file gets a different filename. The old
  // stale-while-revalidate path re-fetched every route chunk on every single
  // navigation, so tapping Map returned the 287KB chunk from cache AND
  // re-downloaded it, competing on LTE with the API calls the incoming screen
  // was actually waiting on.
  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE)
        .then((cache) => cache.match(req))
        .catch(() => undefined)
        .then((cached) => cached || fetch(req).then((res) => {
          if (res && res.status === 200 && isChunkPayload(res)) void putInRuntime(req, res.clone());
          return res;
        })),
    );
    return;
  }

  // Everything else same-origin and unhashed (icons, manifest, the join form):
  // stale-while-revalidate — instant from cache, refreshed in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) void putInRuntime(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});

// ── Push notifications ───────────────────────────────────────────────────────
// Payload arrives encrypted (RFC 8291) and is decrypted by the browser before
// it reaches here, so event.data is already plaintext JSON.
//
// `tag` is the collapse key and it matters in the field: "Power Hour, 20 min
// left" should REPLACE "Power Hour, 40 min left" rather than stacking beneath
// it. A rep who unlocks their phone to six notifications about one challenge
// turns notifications off, and we never get them back.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* malformed → generic */ }
  const title = data.title || "Homefront";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag || "hfs",
      renotify: true,
      data: { url: data.url || "/" },
    }),
  );
});

// Tapping a notification focuses an existing tab rather than opening a new one —
// a rep mid-knock should land back in the app they already had open, with their
// map state intact, not in a fresh window that reloads everything.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // The app is HASH-routed (client/src/main.tsx forces "#/" when the hash is
  // empty), but push payloads carry plain route paths like "/spiffs". Opening
  // "/spiffs" hits the SPA fallback, boots with no hash, and lands the rep on
  // the dashboard instead of the screen the notification was about. Normalise
  // here so every payload — including ones added later — routes correctly.
  const raw = (event.notification.data && event.notification.data.url) || "/";
  // "/" means "no particular destination" — focus the rep's existing tab and
  // leave whatever they were doing alone, exactly as before.
  const hasDestination = raw !== "/" && raw !== "/#/" && raw !== "#/";
  const target = raw.startsWith("/#") || raw.startsWith("#") ? raw : `/#${raw}`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client && hasDestination) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
