import { test, expect } from "@playwright/test";
import { mintSession, loginAs } from "./helpers/auth";

const SEARCHED = { lng: -80.2534, lat: 35.8241 };

test("address search owns the camera, zoom preserves center, and scans use one cleared GeoJSON overlay", async ({ page, request }) => {
  const { sessionId } = await mintSession(request);
  await loginAs(page, sessionId);

  await page.route("**/api/geocode?**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...SEARCHED, placeName: "1 Testing Way, Lexington, North Carolina 27292" }),
    });
  });

  const scanRows = Array.from({ length: 2_000 }, (_, i) => ({
    address: `${i + 1} Scan Performance Way`, city: "Lexington", state: "NC", zip: "27292",
    fiberStatus: "new_fiber", isNewFiber: true, billingStatus: "N",
    householdSegmentType: null, techType: "fiber", chipSetType: null, placement: "underground",
    maxDownloadMbps: 2000, competitorName: null, competitorSpeedMbps: null,
    lat: SEARCHED.lat + (i % 50) * 0.000001,
    lng: SEARCHED.lng + Math.floor(i / 50) * 0.000001,
    leadTag: "hot_lead", leadScore: 95,
  }));
  await page.route("**/api/scan/area", async route => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "map-e2e", total: scanRows.length }) });
  });
  await page.route("**/api/scan/map-e2e?**", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "map-e2e", status: "done", total: scanRows.length, done: scanRows.length,
        results: scanRows, resultCount: scanRows.length,
        summary: { new_fiber: scanRows.length, scanned: scanRows.length, remaining: 0 },
      }),
    });
  });

  await page.goto("/?perf=1#/map");
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__map?.isStyleLoaded()))).toBe(true);

  await page.getByTestId("ctl-search").click();
  await page.getByTestId("map-search").fill("1 Testing Way Lexington NC");
  await page.getByTestId("map-search-goto").click();
  await expect.poll(() => page.evaluate(({ lng, lat }) => {
    const map = (window as any).__map;
    const c = map.getCenter();
    return Math.abs(c.lng - lng) < 0.001 && Math.abs(c.lat - lat) < 0.001 && Math.abs(map.getZoom() - 17.25) < 0.1;
  }, SEARCHED)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__map.getSource("search-result")._data.features.length)).toBe(1);

  const beforeZoom = await page.evaluate(() => {
    const map = (window as any).__map;
    const c = map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: map.getZoom() };
  });
  await page.locator(".mapboxgl-canvas").hover();
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(700);
  const afterZoom = await page.evaluate(() => {
    const map = (window as any).__map;
    const c = map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: map.getZoom() };
  });
  expect(afterZoom.zoom).toBeGreaterThan(beforeZoom.zoom);
  expect(afterZoom.lng).toBeCloseTo(beforeZoom.lng, 4);
  expect(afterZoom.lat).toBeCloseTo(beforeZoom.lat, 4);

  await page.getByTestId("ctl-scan").click();
  const canvas = page.locator(".mapboxgl-canvas");
  const box = await canvas.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * 0.35, box!.y + box!.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.65, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: /Quick scan/i }).click();

  await expect(page.getByTestId("scan-panel").getByText(/2000 new-fiber leads found/i)).toBeVisible();
  const scanState = await page.evaluate(() => {
    const map = (window as any).__map;
    return {
      featureCount: map.getSource("scan-results")._data.features.length,
      drawCoordinates: map.getSource("draw-bbox")._data.geometry.coordinates,
      scanDomMarkers: document.querySelectorAll(".mapboxgl-marker:not(.mapboxgl-user-location-dot)").length,
    };
  });
  expect(scanState.featureCount).toBe(2_000);
  expect(scanState.drawCoordinates).toEqual([[]]);
  expect(scanState.scanDomMarkers).toBe(0);
  await expect.poll(() => page.evaluate(() => (window as any).__map.queryRenderedFeatures({
    layers: ["scan-results-points", "scan-results-clusters"],
  }).length)).toBeGreaterThan(0);
  await page.waitForTimeout(750);
  const perf = await page.evaluate(() => ({
    fps: (window as any).__mapPerf?.fps?.() ?? 0,
    p95: (window as any).__mapPerf?.p95?.() ?? Number.POSITIVE_INFINITY,
    samples: (window as any).__mapPerf?.frames ?? 0,
  }));
  console.log(`[map-e2e-perf] fps=${perf.fps.toFixed(1)} p95=${perf.p95.toFixed(1)}ms frames=${perf.samples}`);
  expect(perf.fps).toBeGreaterThan(45);
  expect(perf.p95).toBeLessThan(30);
});
