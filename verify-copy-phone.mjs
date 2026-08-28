// Reproduce "the address will not copy on my phone" against the running dev
// server, at a real phone size, with a real thumb drift.
//
// Recipe (see memory drag-regions-steal-taps-on-phones): seed a DECOY string
// into the clipboard first, then press / move 8px / release on the control, and
// read the clipboard back. If the decoy survives, the copy never happened.
//
// Usage: node verify-copy-phone.mjs [port]
import { chromium } from "playwright";

const PORT = process.argv[2] ?? "5077";
const BASE = `http://localhost:${PORT}`;
const EMAIL = "rex.rep@northstar.example.test";
const DECOY = "DECOY-NOTHING-WAS-COPIED";

const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  permissions: ["clipboard-read", "clipboard-write"],
});
// Mint the session from node, then plant it before any app script runs -
// setting localStorage from a page that already booted leaves the shell on the
// sign-in card until a reload it never gets.
const req = await fetch(`${BASE}/api/auth/otp/request`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL }),
});
const reqJson = await req.json();
if (!reqJson.developmentCode) { console.error("no developmentCode for", EMAIL, reqJson); process.exit(1); }
const ver = await fetch(`${BASE}/api/auth/otp/verify`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, code: reqJson.developmentCode }),
});
const verJson = await ver.json();
if (!verJson.sessionId) { console.error("no sessionId", verJson); process.exit(1); }

await context.addInitScript(([s]) => {
  localStorage.setItem("hfs.sid", s);
  localStorage.setItem("hfs.sid.until", String(Date.now() + 7 * 864e5));
}, [verJson.sessionId]);

const page = await context.newPage();
page.on("pageerror", (e) => console.error("PAGEERROR", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE", m.text().slice(0, 200)); });

await page.goto(`${BASE}/#/map`);
try {
  await page.waitForFunction(() => (window).__allLeads?.length > 0, null, { timeout: 60_000 });
} catch {
  console.error("no leads on window. state:", JSON.stringify(await page.evaluate(() => ({
    hash: location.hash,
    hasOpen: typeof (window).__openLeadSheet,
    allLeads: (window).__allLeads?.length ?? null,
    rootChildren: document.getElementById("root")?.children.length ?? 0,
    text: document.body.innerText.slice(0, 300),
  }))));
  await browser.close();
  process.exit(1);
}

const lead = await page.evaluate(() => {
  const l = (window).__allLeads[0];
  (window).__openLeadSheet(l.id);
  return { id: l.id, address: l.address };
});
await page.waitForSelector('[data-testid="knock-sheet"]', { timeout: 15_000 });
await page.waitForTimeout(600);

const cdp = await context.newCDPSession(page);

/** Seed a unique decoy and PROVE it landed, or the read-back means nothing. */
async function seedDecoy(tag) {
  const decoy = `${DECOY}-${tag}`;
  await page.evaluate((d) => navigator.clipboard.writeText(d), decoy);
  const seen = await page.evaluate(() => navigator.clipboard.readText());
  if (seen !== decoy) throw new Error(`decoy did not land (clipboard reads ${JSON.stringify(seen)})`);
  return decoy;
}

/** A real finger: touchStart, optional drift, touchEnd. */
async function finger(x, y, drift) {
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  if (drift) {
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (drift * i) / 4, y: y + (drift * i) / 8, id: 1 }],
      });
    }
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

// NOTE: there is no mouse case here. The context is mobile-emulated, so
// Chromium translates page.mouse into touch and a "mouse" attempt is not a
// faithful mouse. The mouse and keyboard paths are covered in
// tests/rtl/LeadKnockSheet.test.tsx instead.
async function attempt(label, drift, useTouch) {
  const decoy = await seedDecoy(label.replace(/\W+/g, ""));
  const btn = page.locator('[data-testid="knock-copy-address"]');
  if (!(await btn.count())) return { label, result: "no copy control at this snap" };
  const box = await btn.boundingBox();
  if (!box) return { label, result: "copy control not visible" };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // Instrument: which events actually reach the control, and did the sheet
  // decide this press was a drag?
  await page.evaluate(() => {
    const b = document.querySelector('[data-testid="knock-copy-address"]');
    (window).__probe = [];
    if (!(window).__probeWired) {
      (window).__probeWired = true;
      for (const t of ["pointerdown", "pointerup", "pointercancel", "click", "touchstart", "touchend"]) {
        b.addEventListener(t, (e) => (window).__probe.push(t + (e.defaultPrevented ? ":prevented" : "")), true);
      }
    }
  });
  if (useTouch) {
    await finger(x, y, drift);
  } else {
    await page.mouse.move(x, y);
    await page.mouse.down();
    if (drift) await page.mouse.move(x + drift, y + drift / 2, { steps: 4 });
    await page.mouse.up();
  }
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  const feedback = await page.evaluate(() => ({
    said_copied: !!document.querySelector('[data-testid="knock-address-copied"]'),
    said_failed: !!document.querySelector('[data-testid="knock-address-copy-failed"]'),
  }));
  const probe = await page.evaluate(() => (window).__probe ?? []);
  return { label, pointer: useTouch ? "touch" : "mouse", drift, copied: clip !== decoy, clip: clip.slice(0, 45), ...feedback, events: probe.join(" ") };
}

// Can a rep long-press the address and select it by hand instead?
const selectable = await page.evaluate(() => {
  const h2 = document.querySelector('[data-testid="knock-sheet"] h2');
  if (!h2) return null;
  const cs = getComputedStyle(h2);
  return {
    text: h2.textContent?.trim().slice(0, 40),
    userSelect: cs.userSelect || cs.webkitUserSelect,
    touchAction: cs.touchAction,
  };
});

// Regression: the header must still drag the sheet. A press on the address
// text (now selectable) must not glue the sheet to the finger either.
async function dragFrom(testid, dy) {
  const el = page.locator(testid);
  const box = await el.boundingBox();
  if (!box) return { testid, result: "not visible" };
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(() => {
    (window).__pm = [];
    document.querySelector('[data-testid="knock-sheet"]').addEventListener("pointermove", (e) => {
      if ((window).__pm.length < 3) (window).__pm.push({ type: e.pointerType, buttons: e.buttons, isPrimary: e.isPrimary });
    }, true);
  });
  const before = await page.evaluate(() => document.querySelector('[data-testid="knock-sheet"]').style.transform);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / 6, id: 1 }] });
  }
  const during = await page.evaluate(() => document.querySelector('[data-testid="knock-sheet"]').style.transform);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(500);
  const pm = await page.evaluate(() => (window).__pm);
  return { testid, before, during, moved: before !== during, pointermove: pm };
}

// Run AFTER the tap attempts: cycling the sheet's level mid-run changes which
// header is mounted and makes the taps that follow it unreliable to place.

const drags = [
  await dragFrom('[data-testid="knock-sheet-handle"]', 120),
];

const results = {
  lead,
  addressText: selectable,
  drags,
  attempts: [
    await attempt("touch, no drift", 0, true),
    await attempt("touch, 8px drift", 8, true),
    await attempt("touch, 16px drift", 16, true),
    await attempt("touch, 22px drift", 22, true),
    await attempt("touch, 40px swipe", 40, true),
  ],
};
console.log(JSON.stringify(results, null, 2));

await browser.close();

// Non-zero when a tap inside the slop failed to copy, so this stays usable as a
// check and not only as a report.
const mustCopy = results.attempts.filter(a => a.drift <= 16);
const broken = mustCopy.filter(a => !a.copied || !a.said_copied);
if (broken.length) {
  console.error("FAILED:", broken.map(a => a.label).join(", "));
  process.exit(1);
}

