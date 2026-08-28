// Does the map search find a door the map has NOT loaded?
//
// Forces the exact production shape locally: pick a lead, prove it is absent
// from window.__allLeads (the client pin set the old search was built from),
// then type its address into the map search and see whether it appears.
import { chromium } from "playwright";

const PORT = process.argv[2] ?? "5077";
const BASE = `http://localhost:${PORT}`;
const EMAIL = "ada.admin@northstar.example.test";

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

await page.goto(`${BASE}/#/map`);
await page.waitForFunction(() => (window).__allLeads?.length > 0, null, { timeout: 60_000 });

// A door the client pin set does NOT hold: take one from the server list and
// shrink __allLeads to prove the point deterministically.
const target = await page.evaluate(async () => {
  const sid = localStorage.getItem("hfs.sid");
  const r = await fetch("/api/leads?limit=400", { headers: { "x-session-id": sid } });
  const j = await r.json();
  const loaded = new Set(((window).__allLeads ?? []).map((l) => l.id));
  const missing = j.leads.find((l) => !loaded.has(l.id) && l.lat != null && l.address);
  return missing ? { id: missing.id, address: missing.address } : null;
});
if (!target) { console.log(JSON.stringify({ result: "every server lead is already loaded here; cannot stage the prod shape" })); await browser.close(); process.exit(0); }

await page.waitForSelector('[data-testid="map-search-open"]', { timeout: 30_000 });
await page.click('[data-testid="map-search-open"]');
await page.waitForSelector('[data-testid="map-search"]', { timeout: 15_000 });
await page.fill('[data-testid="map-search"]', target.address);
await page.waitForTimeout(2500);

const out = await page.evaluate((addr) => {
  const rows = [...document.querySelectorAll('[role="dialog"][aria-label="Search locations"] button')]
    .map((b) => b.textContent?.trim().slice(0, 60))
    .filter((t) => t && !t.startsWith('Close'));
  return {
    rows,
    empty: document.querySelector('[data-testid="map-search-empty"]')?.textContent?.trim() ?? null,
    pending: !!document.querySelector('[data-testid="map-search-pending"]'),
    found: rows.some((t) => t.toUpperCase().includes(addr.toUpperCase())),
  };
}, target.address);

console.log(JSON.stringify({ target, ...out }, null, 2));
await browser.close();
