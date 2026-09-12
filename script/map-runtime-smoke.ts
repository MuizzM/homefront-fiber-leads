import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium, type Browser } from "@playwright/test";

// Real production chunks, local GeoJSON only. No app account, database, tile
// provider, or external browser request is used by this smoke test.
const root = path.resolve("dist/public");
const chunk = (await readdir(path.join(root, "assets"))).find(name => /^mapLibraryChunk-.*\.js$/.test(name));
assert(chunk, "Build the application before running the map smoke test");
const html = '<!doctype html><html><body><div id="map" style="width:800px;height:600px"></div></body></html>';
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (["/", "/index.html"].includes(pathname)) { res.setHeader("Content-Type", "text/html"); res.end(html); return; }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    res.setHeader("Content-Type", ({ ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
      ".webmanifest": "application/manifest+json", ".png": "image/png" } as Record<string, string>)[ext] ?? "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
let browser: Browser | undefined;
const deadline = setTimeout(() => { void browser?.close(); server.closeAllConnections(); }, 60_000);
try {
  browser = await chromium.launch({ headless: true, timeout: 30_000, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const context = await browser.newContext();
  const external: string[] = [], failures: string[] = [];
  await context.route("**/*", route => {
    if (route.request().url().startsWith(`${origin}/`)) return route.continue();
    external.push(new URL(route.request().url()).origin); return route.abort();
  });
  const page = await context.newPage();
  // tsx preserves function names with this helper inside serialized callbacks.
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  page.on("pageerror", error => failures.push(error.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
  });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const exercise = async () => page.evaluate(async (chunkName: string) => {
    const module = await import(`/assets/${chunkName}`);
    const lib = Object.values(module).find((value: any) => typeof value?.Map === "function") as any;
    if (!lib) throw new Error("Built map facade is missing");
    lib.accessToken = "fixture-token";
    const payload = '<a onclick="window.__unsafe=1" onmouseover="window.__unsafe=2" href="javascript:window.__unsafe=3">Fixture attribution</a>';
    const points = { type: "FeatureCollection", features: Array.from({ length: 12 }, (_, id) => ({ type: "Feature", id,
      geometry: { type: "Point", coordinates: [id * 0.0001, 0] }, properties: { id } })) };
    const style = (background: string) => ({ version: 8, sources: {
      points: { type: "geojson", data: points, cluster: true, clusterRadius: 60, attribution: payload },
      territory: { type: "geojson", data: { type: "Feature", properties: { id: 77 }, geometry: {
        type: "Polygon", coordinates: [[[-.01, -.01], [.01, -.01], [.01, .01], [-.01, .01], [-.01, -.01]]],
      } } },
    }, layers: [{ id: "background", type: "background", paint: { "background-color": background } },
      { id: "territory", type: "fill", source: "territory", paint: { "fill-color": "#00aa88", "fill-opacity": .2 } },
      { id: "clusters", type: "circle", source: "points", filter: ["has", "point_count"], paint: { "circle-radius": 20, "circle-color": "#22aa22" } },
      { id: "pins", type: "circle", source: "points", filter: ["!", ["has", "point_count"]], paint: { "circle-radius": 7, "circle-color": "#aa2222" } }],
    });
    const map = new lib.Map({ container: "map", center: [0, 0], zoom: 4, style: style("#ffffff"), zoomLevelsToOverscale: undefined, attributionControl: false });
    const mapErrors: string[] = []; map.on("error", (event: any) => mapErrors.push(event.error?.message ?? "map error"));
    const idle = () => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Map worker did not reach idle")), 15_000);
      map.once("idle", () => { clearTimeout(timer); resolve(); });
    });
    try {
      const firstIdle = idle();
      map.addControl(new lib.AttributionControl({ compact: false, customAttribution: payload }));
      await firstIdle;
      const cluster = map.queryRenderedFeatures({ layers: ["clusters"] })[0];
      if (!cluster || cluster.properties.point_count !== 12) throw new Error("Cluster worker failed");
      const zoom = await map.getSource("points").getClusterExpansionZoom(cluster.properties.cluster_id);
      if (!Number.isFinite(zoom)) throw new Error("Cluster expansion did not return a zoom");
      const zoomIdle = idle(); map.jumpTo({ zoom: 20, center: [0.0005, 0] }); await zoomIdle;
      const pins = map.queryRenderedFeatures({ layers: ["pins"] });
      const territory = map.queryRenderedFeatures(map.project([0.0005, 0]), { layers: ["territory"] });
      if (!pins.length || !territory.some((f: any) => f.properties.id === 77)) throw new Error("Pin or territory picking failed");
      const switched = idle(); map.setStyle(style("#222222")); await switched;
      const attribution = document.querySelector(".maplibregl-ctrl-attrib-inner");
      if (!attribution?.textContent?.includes("Fixture attribution")) throw new Error("Normal attribution disappeared");
      if (attribution.querySelector('[onclick],[onmouseover],[href^="javascript:"]') || (window as any).__unsafe) throw new Error("Unsafe attribution survived sanitizer");
      if (mapErrors.length) throw new Error(mapErrors.join("; "));
      return { worker: lib.getWorkerUrl(), clusters: cluster.properties.point_count, pins: pins.length, territory: true, sanitizer: true };
    } finally { map.remove(); }
  }, chunk);
  const online = await exercise();
  await page.waitForFunction(async () => {
    const cache = await caches.open("runtime-v2"); const keys = await cache.keys();
    return keys.some(key => /maplibre-gl-worker.*\.js$/.test(key.url));
  });
  await context.setOffline(true);
  await page.reload();
  const offline = await exercise();
  assert.deepEqual(external, []); assert.deepEqual(failures, []);
  console.log(JSON.stringify({ online, offline, outboundRequests: external.length, pageErrors: failures.length }));
  await context.close();
} finally { clearTimeout(deadline); await browser?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
