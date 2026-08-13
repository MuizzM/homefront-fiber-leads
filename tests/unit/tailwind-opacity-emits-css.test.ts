// Colour utilities whose opacity modifier generates NO CSS.
//
// Tailwind 3.4 generates opacity modifiers only for the values on its scale
// (0, 5, 10, 20, 25, ...). `/8` and `/12` are not on it, and this project's
// tailwind.config.ts does not extend the scale - so `bg-success/8` compiles to
// nothing at all. The class is not a weaker tint; it is absent. And because
// `cn()` is tailwind-merge, the dead class still DISPLACES the base utility, so
// the surface renders with no fill whatsoever.
//
// That is invisible at review time, which is how 126 of them accumulated across
// 30 files: the quiz right/wrong feedback, five calling disposition buttons, the
// coverage-gap banner, the active sidebar nav item, the Profile role chip, and a
// 110px watermark numeral in RankedLeads that was rendering at FULL saturation
// because its 8% opacity never compiled.
//
// Verified empirically before the sweep, by compiling a probe file through this
// repo's own tailwindcss 3.4.19 with the project's colour tokens:
//   emitted:     bg-success/10  bg-warning/15  bg-destructive/20  bg-success/[0.08]
//   NOT emitted: bg-success/8   bg-warning/12  bg-primary/12      border-warning/12
//
// The bracketed arbitrary form is the fix, deliberately: it compiles AND
// preserves the exact opacity the author asked for, so nothing about the
// intended design changes - the tints simply start existing.
//
// docs/ui-audit-2026-08.md, cross-cutting item 3, asked for exactly this test:
// "a comment cannot fail a build, which is how 126 sites accumulated silently".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const CLIENT = join(ROOT, "client/src");

/** Colour utilities that take an opacity modifier. `text-` is included even
 *  though `text-sm/8` is valid line-height shorthand: the capture requires a
 *  colour-ish token, and any genuine line-height use would be `text-<size>/<n>`
 *  where the size is one of Tailwind's named sizes - if one ever appears here,
 *  narrow this list rather than deleting the test.
 *
 *  Matches ANY numeric opacity, not a hand-listed pair. The first version of
 *  this test looked only for /8 and /12 - the two values the audit happened to
 *  name - and three background classes at /92 sailed straight through it,
 *  leaving the OFFLINE BANNER over the map with no background at all. A guard
 *  that only knows the values you already found is not a guard. */
const NUMERIC_OPACITY =
  /\b((?:bg|text|border|ring|from|to|via|shadow|outline|divide|accent|caret|decoration|fill|stroke)-[a-z0-9-]+)\/(\d{1,3})\b/g;

/** Tailwind 3.4's built-in opacity scale, determined EMPIRICALLY by compiling
 *  every value 0-100 through this repo's own tailwindcss with the project
 *  config: exactly the 21 multiples of five emit, and the other 80 values emit
 *  nothing at all. */
const EMITTING_STEPS = new Set(Array.from({ length: 21 }, (_, i) => i * 5));

/** Positioning utilities that this regex would otherwise catch: `left-1/2` is a
 *  FRACTION, not an opacity, and `from-left-1/2` / `to-left-1/2` are real
 *  classes in this codebase. Excluded by name so the exclusion is auditable. */
const FRACTION_UTILITIES = /\b(?:from|to|via)-(?:left|right|top|bottom|inset)-\d+\/\d+\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("no colour utility uses an opacity step Tailwind will not emit", () => {
  it("finds zero off-scale colour opacities anywhere in client/src", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(CLIENT)) {
      const src = readFileSync(file, "utf8");
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(NUMERIC_OPACITY)) {
          if (FRACTION_UTILITIES.test(m[0])) continue;   // left-1/2 and friends
          const step = Number(m[2]);
          if (EMITTING_STEPS.has(step)) continue;
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}  ${m[0]}  (/${step} is not a multiple of 5)`);
        }
      });
    }
    expect(
      offenders,
      `These compile to NO CSS, and because cn() is tailwind-merge they still DISPLACE the base utility - the surface renders with nothing.\n` +
      `Only multiples of five emit. Use the bracketed form to keep the exact value: /8 -> /[0.08], /92 -> /[0.92].\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("knows the real scale, not a hand-listed pair of bad values", () => {
    // Empirically compiled: exactly the 21 multiples of five emit.
    expect(EMITTING_STEPS.size).toBe(21);
    for (const dead of [8, 12, 92, 7, 13, 33, 99]) expect(EMITTING_STEPS.has(dead)).toBe(false);
    for (const live of [0, 5, 10, 15, 90, 95, 100]) expect(EMITTING_STEPS.has(live)).toBe(true);
  });

  it("does not flag fraction utilities, which are not opacities", () => {
    // `from-left-1/2` is a real class here; /2 is a fraction, not 2% opacity.
    expect(FRACTION_UTILITIES.test("from-left-1/2")).toBe(true);
    expect(FRACTION_UTILITIES.test("bg-slate-950/92")).toBe(false);
  });
});

describe("the offline banner actually has a background", () => {
  it("FieldStatusBar uses emitting opacities for its overlay tones", () => {
    // Three bg-*/92 classes meant the banner that tells a rep they have lost
    // signal - drawn OVER the map - painted no background at all. /92 is not a
    // multiple of five. The first version of this guard only knew /8 and /12
    // and walked straight past it.
    const src = readFileSync(join(CLIENT, "components/FieldStatusBar.tsx"), "utf8");
    expect(src).toContain("bg-red-950/[0.92]");
    expect(src).toContain("bg-slate-950/[0.92]");
    expect(src).not.toMatch(/bg-(?:red|slate)-950\/92\b/);
  });
});

describe("the bracketed replacements are present where the sweep ran", () => {
  it("RankedLeads' watermark numeral is faint again, not fully saturated", () => {
    // aria-hidden 110px "1" behind the hero card, commented as "pure background
    // texture". With /8 dead it painted at full success-green.
    const src = readFileSync(join(CLIENT, "components/fiber/RankedLeads.tsx"), "utf8");
    expect(src).toContain("text-success/[0.08]");
  });

  it("the hero gradient no longer appears only on hover", () => {
    // `from-success/8` emitted nothing while `hover:from-success/10` emitted, so
    // the card had no base tint and grew one on hover.
    const src = readFileSync(join(CLIENT, "components/fiber/RankedLeads.tsx"), "utf8");
    expect(src).toContain("from-success/[0.08]");
    expect(src).toContain("hover:from-success/10");
  });
});
