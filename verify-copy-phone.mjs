// Real-browser verification of the phone copy fix, at a phone viewport: a tap
// on the header Copy disc whose pointer DRIFTS past the slop must still put the
// address on the clipboard. Before the fix the drift promoted the press to a
// sheet drag and the click was swallowed in the capture phase, so nothing was
// copied.
//
// Chromium, not WebKit: helmet sends HSTS, and WebKit honours it for localhost
// too, so every Vite module request on http://localhost:5081 is upgraded to
// https and fails. That is a dev-server artefact (prod is https) - the WebKit
// clipboard mechanisms were verified separately at an iPhone viewport.
// Run:
//   1. start the dev server (launch.json `homefront-fieldmap-b`, port 5081)
//   2. mint a rep session, then:  node verify-copy-phone.mjs <sessionId>
// Exits non-zero if the address did not reach the clipboard.
import { chromium } from "playwright";

const ORIGIN = "http://localhost:5081";
const SID = process.argv[2];

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();
await page.addInitScript((sid) => {
  localStorage.setItem("hfs.sid", sid);
  localStorage.setItem("hfs.sid.until", String(Date.now() + 86400000));
}, SID);

page.on("console", (m) => { if (m.type() === "error") console.log("  [console error]", m.text().slice(0, 160)); });

await page.goto(`${ORIGIN}/#/map`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => typeof window.__openLeadSheet === "function", null, { timeout: 90000 });
await page.waitForFunction(() => Array.isArray(window.__allLeads) && window.__allLeads.length > 0, null, { timeout: 90000 });

const lead = await page.evaluate(() => {
  const l = window.__allLeads.find((x) => x.lat != null && x.lng != null && x.address);
  window.__openLeadSheet(l.id);
  return { id: l.id, address: l.address, city: l.city, state: l.state, zip: l.zip };
});
console.log("lead:", JSON.stringify(lead));

const copy = page.locator("[data-testid=knock-copy-address]");
await copy.waitFor({ state: "visible", timeout: 30000 });

const expected = [
  lead.address,
  [lead.city, [lead.state, lead.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
].filter(Boolean).join(", ");
console.log("expected on clipboard:", JSON.stringify(expected));

// Seed the clipboard with a decoy, so "copied" cannot be confused with "was
// already there" - the exact way the old dishonest-success bug hid itself.
await page.evaluate(() => {
  const b = document.createElement("button");
  b.id = "seed"; b.textContent = "seed";
  b.style.cssText = "position:fixed;top:0;left:0;width:60px;height:30px;z-index:99999";
  b.onclick = () => navigator.clipboard.writeText("DECOY-NOT-THE-ADDRESS");
  document.body.appendChild(b);
});
await page.click("#seed");
await page.waitForTimeout(200);
await page.evaluate(() => document.getElementById("seed").remove());

// The gesture: press on the disc, DRIFT 8px, release. 8px is past the 6px
// mouse slop, so pre-fix this became a sheet drag and the click was eaten.
const box = await copy.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy + 4);
await page.mouse.move(cx, cy + 8);
await page.mouse.up();
await page.waitForTimeout(500);

const uiSaid = await page.evaluate(() => {
  const ok = document.querySelector("[data-testid=knock-address-copied]");
  const bad = document.querySelector("[data-testid=knock-address-copy-failed]");
  return ok ? "Address copied" : bad ? "Could not copy" : "(no feedback)";
});

// Read the clipboard back - the only honest check.
const clip = await page.evaluate(() => navigator.clipboard.readText());

console.log("UI feedback :", uiSaid);
console.log("clipboard   :", JSON.stringify(clip));
const pass = clip === expected && uiSaid === "Address copied";
console.log(pass ? "PASS - a drifting tap copied the address" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
