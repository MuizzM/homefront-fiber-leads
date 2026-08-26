// ── Two seams, two guards ───────────────────────────────────────────────────
//
// Both of the bugs these guard against were the same shape: a capability was
// hand-rolled at each call site, each site swallowed its own failure, and when
// the underlying thing broke EVERY site broke silently at once.
//
//   * Address lookup: four files fetched api.mapbox.com/geocoding directly.
//     The tokens were retired, every call answered 401, and the map's address
//     search, tap-a-house, the lead-create coordinate fallback and geocodeCity
//     all died without a single alarm.
//
//   * Copy: seven files called navigator.clipboard by hand. One ignored its
//     fallback's return value and claimed success anyway; one had no fallback
//     and an empty catch, so on a phone the button did nothing at all.
//
// The fix in both cases was ONE module. These tests are what stop a eighth
// call site from being hand-rolled next to it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source lines that are not comments — a rule about code should not fire on prose. */
function codeLines(file: string): Array<{ n: number; text: string }> {
  const lines = readFileSync(file, "utf8").split("\n");
  const out: Array<{ n: number; text: string }> = [];
  let inBlock = false;
  lines.forEach((raw, i) => {
    let text = raw;
    if (inBlock) {
      const end = text.indexOf("*/");
      if (end === -1) return;
      text = text.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const open = text.indexOf("/*");
      if (open === -1) break;
      const close = text.indexOf("*/", open + 2);
      if (close === -1) { text = text.slice(0, open); inBlock = true; break; }
      text = text.slice(0, open) + text.slice(close + 2);
    }
    const line = text.replace(/\/\/.*$/, "").trim();
    if (line) out.push({ n: i + 1, text: line });
  });
  return out;
}

describe("geocoding has ONE seam", () => {
  // server/geocoder.ts owns the provider chain. mapbox-addresses.ts is the
  // documented exception: a BULK harvest (~12,800 reverse geocodes per city
  // run) behind the Mapbox spend budget, which must not be pointed at the free
  // community API whose policy forbids bulk use.
  const ALLOWED = new Set(["server/geocoder.ts", "server/mapbox-addresses.ts"]);

  it("no file outside the seam fetches the Mapbox geocoding API directly", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "server")).concat(walk(join(ROOT, "client", "src")))) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      for (const { n, text } of codeLines(file)) {
        if (text.includes("api.mapbox.com/geocoding")) offenders.push(`${rel}:${n}`);
      }
    }
    expect(offenders, "route these through server/geocoder.ts instead").toEqual([]);
  });

  it("the seam offers a fallback provider, so one dead token cannot take lookup down", () => {
    const src = readFileSync(join(ROOT, "server", "geocoder.ts"), "utf8");
    expect(src).toContain("nominatim.openstreetmap.org");
    // The chain must be a LOOP over providers, not an if/else that stops at the
    // first one: a second provider nobody reaches is not a fallback.
    expect(src).toMatch(/for \(const \[name, run\] of providers\)/);
  });
});

describe("copying text has ONE seam", () => {
  const ALLOWED = new Set(["client/src/lib/clipboard.ts"]);

  it("no component calls navigator.clipboard.writeText by hand", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "client", "src"))) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      for (const { n, text } of codeLines(file)) {
        // `clipboardData` (a paste handler) is a read, not a write - allowed.
        if (/navigator\s*\.\s*clipboard/.test(text)) offenders.push(`${rel}:${n}`);
      }
    }
    expect(offenders, "use copyText() from @/lib/clipboard instead").toEqual([]);
  });

  it("no component hand-rolls the execCommand copy fallback", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "client", "src"))) {
      const rel = relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      for (const { n, text } of codeLines(file)) {
        if (/execCommand\s*\(\s*["']copy["']\s*\)/.test(text)) offenders.push(`${rel}:${n}`);
      }
    }
    expect(offenders, "use copyText() from @/lib/clipboard instead").toEqual([]);
  });
});

describe("drag regions cannot silently start stealing taps again", () => {
  // The phone bug: the Copy and Close discs sit inside the sheet's header drag
  // region, and a tap whose finger drifted past the slop was promoted to a drag
  // that ate the click. Both guards must stay in the source.
  const sheet = readFileSync(join(ROOT, "client", "src", "components", "LeadKnockSheet.tsx"), "utf8");

  it("a press on a control never starts a sheet drag", () => {
    expect(sheet).toContain("pressBelongsToAControl");
    expect(sheet).toMatch(/if \(pressBelongsToAControl\(e\.target\)\) return;/);
  });

  it("touch gets a larger slop than a mouse", () => {
    expect(sheet).toMatch(/const TOUCH_SLOP_PX = \d+;/);
    const touch = Number(/const TOUCH_SLOP_PX = (\d+);/.exec(sheet)![1]);
    const mouse = Number(/const TAP_SLOP_PX = (\d+);/.exec(sheet)![1]);
    expect(touch).toBeGreaterThan(mouse);
    // A thumb tap routinely drifts 6-10px. Anything at or under that is the bug.
    expect(touch).toBeGreaterThanOrEqual(12);
  });
});
