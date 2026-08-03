// ── Service worker — enterprise PWA shell ─────────────────────────────────────
// App-shell precache + runtime caching for offline-friendly field use on weak
// signal. Deliberately conservative: NEVER cache /api (auth + live data must
// stay fresh and tenant-correct), and NEVER cache cross-origin (Mapbox tiles/JS
// have their own headers + a token that must not be persisted here).
//
// Update flow: bump SW_VERSION on deploy → the new worker installs, the client
// shows an "update ready" prompt, and skipWaiting()+reload swaps atomically.

const SW_VERSION = "hfs-v1";
const SHELL_CACHE = `shell-${SW_VERSION}`;
const RUNTIME_CACHE = `runtime-${SW_VERSION}`;

// The minimum needed to boot the app offline. Hashed JS/CSS are picked up at
// runtime (stale-while-revalidate) since their names change per build.
const SHELL_ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

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
});

function isCacheable(url) {
  return url.origin === self.location.origin
    && !url.pathname.startsWith("/api/")
    && url.protocol.startsWith("http");
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
        caches.open(SHELL_CACHE).then((c) => c.put("/index.html", res.clone())).catch(() => {});
        return res;
      }).catch(() => caches.match("/index.html").then((m) => m || caches.match("/"))),
    );
    return;
  }

  // Static assets (hashed JS/CSS, icons, images): stale-while-revalidate —
  // instant from cache, refreshed in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
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
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          if ("navigate" in client && target !== "/") client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
