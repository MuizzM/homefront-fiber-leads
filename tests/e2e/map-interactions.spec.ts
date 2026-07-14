import { test, expect } from "@playwright/test";
import { mintSession, loginAs } from "./helpers/auth";

const SEARCHED = { lng: -80.2534, lat: 35.8241 };

test("search camera is stable and concurrent drawn areas use durable discovery jobs", async ({ page, request }) => {
  const { sessionId } = await mintSession(request);
  await loginAs(page, sessionId);

  await page.route("**/api/geocode?**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...SEARCHED, placeName: "1 Testing Way, Lexington, North Carolina 27292" }),
    });
  });

  const scanFeatures = Array.from({ length: 2_000 }, (_, i) => ({
    type: "Feature",
    id: `canonical-${i}`,
    geometry: {
      type: "Point",
      coordinates: [
        SEARCHED.lng + Math.floor(i / 50) * 0.000001,
        SEARCHED.lat + (i % 50) * 0.000001,
      ],
    },
    properties: {
      // Exact minimal wire shape currently emitted by the backend. The client
      // must accept `lead.published` GeoJSON without relying on richer lead rows.
      id: `canonical-${i}`,
      status: "fresh",
      fresh: true,
    },
  }));

  const jobs = new Map<string, Record<string, any>>();
  const scanBodies: Array<Record<string, any>> = [];
  const pendingStreams: Array<{ route: any; resolve: () => void }> = [];
  let scanStarts = 0;
  let eventSequence = 0;
  let eventsReleased = false;
  let legacyAreaCalls = 0;
  let rejectNextSubmission = false;

  await page.route("**/api/scan/area**", async route => {
    legacyAreaCalls += 1;
    await route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ error: "legacy scan route must not be used" }) });
  });

  await page.route("**/api/discovery/**", async route => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const method = route.request().method();

    if (path === "/api/discovery/events") {
      if (!eventsReleased) {
        await new Promise<void>(resolve => pendingStreams.push({ route, resolve }));
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: ": keepalive\n\n",
      });
      return;
    }

    if (path === "/api/discovery/jobs" && method === "POST") {
      scanStarts += 1;
      const body = route.request().postDataJSON();
      scanBodies.push(body);
      if (rejectNextSubmission) {
        rejectNextSubmission = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary queue outage" }) });
        return;
      }
      const id = `map-e2e-${scanStarts}`;
      const job = {
        id,
        status: "queued",
        geometry: body.geometry,
        idempotencyKey: body.idempotencyKey,
        discoveredCount: 0,
        uniqueCandidateCount: 0,
        validatedCount: 0,
        checkedCount: 0,
        qualifiedCount: 0,
        failedCount: 0,
        cachedCount: 0,
        coverageStatus: "processing",
        createdAt: new Date().toISOString(),
      };
      jobs.set(id, job);
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ job }) });
      return;
    }

    if (path === "/api/discovery/jobs" && method === "GET") {
      const rows = Array.from(jobs.values()).filter(job =>
        requestUrl.searchParams.get("active") !== "true"
        || ["queued", "resolving_boundary", "discovering", "qualifying"].includes(job.status));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: rows }) });
      return;
    }

    const jobMatch = path.match(/^\/api\/discovery\/jobs\/([^/]+)$/);
    if (jobMatch && method === "GET") {
      const job = jobs.get(jobMatch[1]);
      await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "not found" }) });
      return;
    }

    const cancelMatch = path.match(/^\/api\/discovery\/jobs\/([^/]+)\/cancel$/);
    if (cancelMatch && method === "POST") {
      const job = jobs.get(cancelMatch[1]);
      if (job) Object.assign(job, { status: "cancelled", cancelledAt: new Date().toISOString() });
      await route.fulfill({ status: job ? 200 : 404, contentType: "application/json", body: JSON.stringify(job ? { job } : { error: "not found" }) });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `unmocked ${method} ${path}` }) });
  });

  const releaseDiscoveryEvents = async () => {
    const firstJob = jobs.get("map-e2e-1")!;
    const secondJob = jobs.get("map-e2e-2")!;
    const terminal = {
      status: "completed",
      discoveredCount: 2_100,
      uniqueCandidateCount: 2_000,
      validatedCount: 2_000,
      checkedCount: 2_000,
      qualifiedCount: 2_000,
      failedCount: 0,
      cachedCount: 120,
      coverageStatus: "high",
      completedAt: new Date().toISOString(),
    };
    Object.assign(firstJob, terminal);
    Object.assign(secondJob, terminal);

    const event = (eventType: string, jobId: string, payload: Record<string, any>) => {
      eventSequence += 1;
      return `id: ${eventSequence}\ndata: ${JSON.stringify({ id: eventSequence, eventType, jobId, payload })}\n\n`;
    };
    const blocks: string[] = [
      event("job.progress", firstJob.id, { job: { ...firstJob, status: "qualifying", checkedCount: 1_000, qualifiedCount: 1_000 } }),
      event("job.progress", secondJob.id, { job: { ...secondJob, status: "qualifying", checkedCount: 1_000, qualifiedCount: 1_000 } }),
      ...scanFeatures.map(feature => event("lead.published", firstJob.id, { feature })),
      event("job.completed", firstJob.id, { job: firstJob }),
      event("job.completed", secondJob.id, { job: secondJob }),
    ];

    eventsReleased = true;
    const pending = pendingStreams.shift();
    expect(pending).toBeTruthy();
    await pending!.route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      body: blocks.join(""),
    });
    pending!.resolve();
  };

  await page.goto("/?perf=1#/map");
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__map?.isStyleLoaded()))).toBe(true);

  await page.getByTestId("ctl-search").click();
  await page.getByTestId("map-search").fill("1 Testing Way Lexington NC");
  await page.getByTestId("map-search-goto").click();
  await expect.poll(() => page.evaluate(({ lng, lat }) => {
    const map = (window as any).__map;
    const center = map.getCenter();
    return Math.abs(center.lng - lng) < 0.001
      && Math.abs(center.lat - lat) < 0.001
      && Math.abs(map.getZoom() - 17.25) < 0.1;
  }, SEARCHED)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__map.getSource("search-result")._data.features.length)).toBe(1);

  const beforeZoom = await page.evaluate(() => {
    const map = (window as any).__map;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom() };
  });
  await page.locator(".mapboxgl-canvas").hover();
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(700);
  const afterZoom = await page.evaluate(() => {
    const map = (window as any).__map;
    const center = map.getCenter();
    return { lng: center.lng, lat: center.lat, zoom: map.getZoom() };
  });
  expect(afterZoom.zoom).toBeGreaterThan(beforeZoom.zoom);
  expect(afterZoom.lng).toBeCloseTo(beforeZoom.lng, 4);
  expect(afterZoom.lat).toBeCloseTo(beforeZoom.lat, 4);

  await page.evaluate(() => (window as any).__mapPerf?.reset?.());
  const canvas = page.locator(".mapboxgl-canvas");
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();

  const drawBox = async (start: number, end: number) => {
    await page.getByTestId("ctl-scan").click();
    await expect(page.getByTestId("ctl-scan")).toHaveAttribute("aria-pressed", "true");
    // Let the draw-mode effect attach its Mapbox pointer listeners before the
    // first mouse-down; otherwise a very fast headless click-drag can race it.
    await page.waitForTimeout(50);
    const currentBox = await canvas.boundingBox();
    expect(currentBox).toBeTruthy();
    await page.mouse.move(currentBox!.x + currentBox!.width * start, currentBox!.y + currentBox!.height * start);
    await page.mouse.down();
    await page.mouse.move(currentBox!.x + currentBox!.width * end, currentBox!.y + currentBox!.height * end, { steps: 8 });
    await page.mouse.up();
  };

  await drawBox(0.30, 0.55);
  await expect.poll(() => scanStarts).toBe(1);
  const selectedDrawCoordinateCount = () => page.evaluate(() => {
    const data = (window as any).__map.getSource("draw-bbox")._data;
    if (data?.type === "FeatureCollection") {
      return data.features.reduce((count: number, feature: any) =>
        count + (feature?.geometry?.coordinates?.[0]?.length ?? 0), 0);
    }
    return data?.geometry?.coordinates?.[0]?.length ?? 0;
  });
  await expect.poll(selectedDrawCoordinateCount).toBe(0);

  // The accepted job owns its geometry, so another area can be submitted while
  // the first remains queued. No mode prompt, cooldown, or cancel-all toggle.
  await drawBox(0.58, 0.78);
  await expect.poll(() => scanStarts).toBe(2);
  await expect(page.getByTestId("discovery-job-map-e2e-1")).toBeVisible();
  await expect(page.getByTestId("discovery-job-map-e2e-2")).toBeVisible();
  await expect(page.getByRole("button", { name: /Quick scan|Deep scan/i })).toHaveCount(0);
  expect(scanBodies.every(body => body.geometry?.type === "Polygon")).toBe(true);
  expect(scanBodies.every(body => typeof body.idempotencyKey === "string" && body.idempotencyKey.length > 20)).toBe(true);
  expect(scanBodies[0].idempotencyKey).not.toBe(scanBodies[1].idempotencyKey);
  expect(scanBodies.every(body => !("deep" in body))).toBe(true);
  expect(legacyAreaCalls).toBe(0);

  await expect.poll(() => pendingStreams.length).toBeGreaterThan(0);
  await releaseDiscoveryEvents();

  await expect(page.getByTestId("scan-panel").getByText(/2000 fresh-fiber leads found/i)).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__map.getSource("scan-results")._data.features.length)).toBe(2_000);
  const scanState = await page.evaluate(() => {
    const map = (window as any).__map;
    const drawData = map.getSource("draw-bbox")._data;
    return {
      drawCoordinateCount: drawData?.type === "FeatureCollection"
        ? drawData.features.reduce((count: number, feature: any) =>
          count + (feature?.geometry?.coordinates?.[0]?.length ?? 0), 0)
        : (drawData?.geometry?.coordinates?.[0]?.length ?? 0),
      scanDomMarkers: document.querySelectorAll(".mapboxgl-marker:not(.mapboxgl-user-location-dot)").length,
    };
  });
  expect(scanState.drawCoordinateCount).toBe(0);
  expect(scanState.scanDomMarkers).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).__map.queryRenderedFeatures({
    layers: ["scan-results-points", "scan-results-clusters"],
  }).length)).toBeGreaterThan(0);

  await page.waitForTimeout(750);
  const perf = await page.evaluate(() => {
    const values: number[] = (window as any).__mapPerf?.samples?.() ?? [];
    return {
      fps: (window as any).__mapPerf?.fps?.() ?? 0,
      p95: (window as any).__mapPerf?.p95?.() ?? Number.POSITIVE_INFINITY,
      samples: values.length,
      longFrameRate: values.length ? values.filter(value => value > 50).length / values.length : 1,
    };
  });
  console.log(`[map-e2e-perf] fps=${perf.fps.toFixed(1)} p95=${perf.p95.toFixed(1)}ms long=${(perf.longFrameRate * 100).toFixed(1)}% frames=${perf.samples}`);
  expect(perf.fps).toBeGreaterThan(45);
  expect(perf.p95).toBeLessThan(45);
  expect(perf.longFrameRate).toBeLessThan(0.05);

  // A rejected submission never transfers ownership of the geometry. Keep the
  // rectangle visible and retry with the same request key; clear it only after
  // the retry is accepted.
  rejectNextSubmission = true;
  // Stay below the compact scan-status banner; pointer events on that overlay
  // correctly do not reach the Mapbox canvas.
  await drawBox(0.45, 0.68);
  await expect.poll(() => scanStarts).toBe(3);
  await expect(page.getByRole("button", { name: "Retry this exact area" })).toBeVisible();
  await expect.poll(selectedDrawCoordinateCount).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Retry this exact area" }).click();
  await expect.poll(() => scanStarts).toBe(4);
  expect(scanBodies[3].idempotencyKey).toBe(scanBodies[2].idempotencyKey);
  await expect.poll(selectedDrawCoordinateCount).toBe(0);
});
