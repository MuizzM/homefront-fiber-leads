// Does a failed "Go to <address> on the map" tell the rep WHY?
//
// /api/geocode answers 404 for "no such address" and 503 when every provider is
// down. apiRequest THROWS on both, so the old catch reported one generic
// "Address lookup failed" and the distinction the route was built to make never
// reached the screen. Drives the real panel and reads the real toast.
import { chromium } from "playwright";

const PORT = process.argv[2] ?? "5077";
const BASE = `http://localhost:${PORT}`;
const EMAIL = "ada.admin@northstar.example.test"; // needs scan.submit for the Go-to button

const rq = await (await fetch(`${BASE}/api/auth/otp/request`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL }),
})).json();
if (!rq.developmentCode) { console.error("no dev code", rq); process.exit(1); }
const vf = await (await fetch(`${BASE}/api/auth/otp/verify`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, code: rq.developmentCode }),
})).json();

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await context.addInitScript(([s]) => {
  localStorage.setItem("hfs.sid", s);
  localStorage.setItem("hfs.sid.until", String(Date.now() + 7 * 864e5));
}, [vf.sessionId]);
const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));

// Two staged failures + the real 404: the outage case cannot be produced by
// typing, so intercept the route and answer exactly what the server would.
async function run(label, query, stub) {
  await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
  if (stub) await page.route("**/api/geocode?*", (r) => r.fulfill(stub));
  // Full reload between cases: the hash never changes, so page.goto is a no-op
  // and the panel would still be open from the previous case - the "open" tap
  // would then CLOSE it.
  await page.goto(`${BASE}/#/map`);
  await page.reload();
  await page.waitForFunction(() => window.__allLeads?.length > 0, null, { timeout: 60_000 });
  await page.waitForSelector('[data-testid="map-search-open"]', { timeout: 30_000 });
  await page.click('[data-testid="map-search-open"]');
  await page.waitForSelector('[data-testid="map-search"]', { timeout: 20_000 });
  await page.fill('[data-testid="map-search"]', query);
  await page.waitForSelector('[data-testid="map-search-goto"]', { timeout: 20_000 });
  await page.click('[data-testid="map-search-goto"]');
  await page.waitForTimeout(3000);
  const toast = await page.evaluate(() =>
    [...document.querySelectorAll("[role='status'],[role='alert'],li[data-state]")]
      .map((n) => n.textContent?.trim()).filter(Boolean).slice(0, 3));
  console.log(label, "->", JSON.stringify(toast));
  return toast.join(" | ");
}

// Mapbox matches almost any string to SOMETHING - it resolved a deliberate
// nonsense query to a road in Oklahoma - so the 404 has to be staged too.
const miss = await run("404 (no such address)", "zzqqxx nowhere street 99999", {
  status: 404, contentType: "application/json",
  body: JSON.stringify({ error: "No match for \u201czzqqxx nowhere street 99999\u201d" }),
});
const down = await run("503 staged (providers down)", "120 W Main St Rockwell NC", {
  status: 503, contentType: "application/json",
  body: JSON.stringify({ error: "Address lookup is unavailable (mapbox: HTTP 401; nominatim: HTTP 503)" }),
});
const limited = await run("429 staged (rate limited)", "120 W Main St Rockwell NC", {
  status: 429, contentType: "application/json", body: JSON.stringify({ error: "Too many requests" }),
});

await browser.close();
const fails = [];
if (!/No match for/i.test(miss)) fails.push(`404 did not say "No match for": ${miss}`);
if (!/unavailable/i.test(down) || !/401/.test(down)) fails.push(`503 lost the reason: ${down}`);
if (!/Too many/i.test(limited)) fails.push(`429 not distinguished: ${limited}`);
if (fails.length) { console.error("FAIL\n" + fails.join("\n")); process.exit(1); }
console.log("PASS: every geocode failure reports its own cause");
