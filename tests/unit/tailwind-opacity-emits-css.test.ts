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
 *  narrow this list rather than deleting the test. */
const DEAD_OPACITY =
  /\b((?:bg|text|border|ring|from|to|via|shadow|outline|divide|accent|caret|decoration|fill|stroke)-[a-z0-9-]+)\/(8|12)\b/g;

/** Tailwind 3.4's built-in opacity scale. Anything off it needs the bracketed
 *  arbitrary form. Kept here so the reason a value is legal is stated, not
 *  implied. */
const EMITTING_STEPS = new Set([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

describe("no colour utility uses an opacity step Tailwind will not emit", () => {
  it("finds zero /8 or /12 colour utilities in client/src", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(CLIENT)) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(DEAD_OPACITY)) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}  ${m[0]}`);
        }
      });
    }
    expect(
      offenders,
      `These compile to NO CSS, and tailwind-merge still lets them displace the base utility, so the surface renders unfilled. Use the bracketed form instead: /8 -> /[0.08], /12 -> /[0.12].\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("states which plain steps are safe, so the next author does not guess", () => {
    // A guard against someone "fixing" a future /8 by picking another off-scale
    // value like /7 or /13.
    expect(EMITTING_STEPS.has(8)).toBe(false);
    expect(EMITTING_STEPS.has(12)).toBe(false);
    expect(EMITTING_STEPS.has(10)).toBe(true);
    expect(EMITTING_STEPS.has(15)).toBe(true);
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
