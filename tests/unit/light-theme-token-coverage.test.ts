import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Light is the default theme, so every token the app reads must resolve
 * WITHOUT the `.dark` class on <html>.
 *
 * This guards a bug that has now shipped twice, because it is invisible in the
 * code and loud on the screen. The stylesheet used to open with a `:root` block
 * that held both the dark palette AND the theme-agnostic foundations - the
 * component border tokens, the chart ramp, the radius, the type scale. Scoping
 * that block to `.dark` (correct for the palette) silently took the
 * foundations with it.
 *
 * The failure mode is not a missing colour. `border-color: var(--card-border)`
 * with `--card-border` undefined falls back to `currentColor`, so every Card
 * gets a 1px border in the TEXT colour - hard ink hairlines on white instead of
 * a soft rule. Nothing errors; it just looks wrong, and only on one theme.
 *
 * The rule: a token may live under `.dark` only if `:root` or `.light` also
 * defines it. Dark-only overrides are fine. Dark-only DEFINITIONS are not.
 */
const cssPath = path.resolve(__dirname, "../../client/src/index.css");
const css = fs.readFileSync(cssPath, "utf8");
const tailwind = fs.readFileSync(
  path.resolve(__dirname, "../../tailwind.config.ts"), "utf8",
);

/**
 * Custom properties declared by the blocks whose selector passes `match`.
 *
 * Brace-counts rather than regex-matching a body, so a nested block cannot end
 * the scan early and under-report what a theme defines.
 */
function declaredIn(match: (selector: string) => boolean): Set<string> {
  const found = new Set<string>();
  const openers = [...css.matchAll(/(^|\n)([^{}\n][^{}]*?)\{/g)];
  for (const opener of openers) {
    const selector = opener[2].trim();
    if (!match(selector)) continue;
    let depth = 1;
    let i = opener.index! + opener[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    // Only this block's own declarations, not those of any nested block.
    const body = css.slice(start, i - 1).replace(/\{[^{}]*\}/g, "");
    for (const decl of body.matchAll(/(--[\w-]+)\s*:/g)) found.add(decl[1]);
  }
  return found;
}

const selects = (selector: string, cls: string) =>
  selector.split(",").some(part => part.trim().split(/\s+/).some(
    unit => unit === cls || unit.startsWith(`${cls}.`) || unit.endsWith(cls),
  ));

/**
 * Does any ONE selector in this list apply when `.dark` is absent?
 *
 * Judged per comma-separated part, which matters in both directions. The dark
 * palette is written `:root.dark` (it needs the specificity to outrank the
 * light `:root` further down the file), so a substring test for ":root" would
 * count it as a light scope and this file would quietly stop guarding anything.
 * Meanwhile the shared block really is `:root, .light, .dark`, and its `:root`
 * part genuinely does define light tokens.
 */
const appliesToLight = (selector: string) =>
  selector.split(",").some(part => {
    const units = part.trim().split(/\s+/);
    if (units.some(unit => unit === ".dark" || unit.endsWith(".dark"))) return false;
    return part.includes(":root") || units.some(unit => unit === ".light" || unit.endsWith(".light"));
  });

const lightTokens = declaredIn(appliesToLight);
const darkTokens = declaredIn(s => selects(s, ".dark"));

/** Tokens read from a source, ignoring any named only inside a comment. */
function tokensReadBy(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...new Set([...code.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))]
    // Radix measures its own collapsible content and sets these on the element
    // at runtime. They are not ours to define.
    .filter(token => !token.startsWith("--radix-"));
}

describe("light mode resolves every token it reads", () => {
  it("defines everything the dark theme defines", () => {
    const darkOnly = [...darkTokens].filter(t => !lightTokens.has(t)).sort();
    expect(darkOnly).toEqual([]);
  });

  it("defines every token referenced by the stylesheet itself", () => {
    // Tokens are also read by @keyframes and utility rules, not just by
    // Tailwind. A reference with no light definition is the same bug.
    const missing = tokensReadBy(css).filter(t => !lightTokens.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("defines every token the Tailwind theme maps to a class", () => {
    // tailwind.config.ts turning `--card-border` into a `border-card` utility
    // is the path that produced the currentColor fallback in the first place.
    const missing = tokensReadBy(tailwind).filter(t => !lightTokens.has(t)).sort();
    expect(missing).toEqual([]);
  });
});
