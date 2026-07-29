import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  GLASS,
  MAP_CHROME,
  NAV_PUCK,
  RADIUS_REM,
  ROOT_FONT_SIZE_PX,
  TAP_TARGET_MIN_PX,
  TEXT_2XS_REM,
  TEXT_MIN_PX,
  TEXT_SM_MINUS_REM,
  remToPx,
} from "../../client/src/lib/designTokens";
import { STATUS_CONFIG } from "../../shared/statusConfig";

const ROOT = path.resolve(__dirname, "..", "..");
const CSS = readFileSync(path.join(ROOT, "client", "src", "index.css"), "utf8");
const TW = readFileSync(path.join(ROOT, "tailwind.config.ts"), "utf8");

/** Returns the body of every rule whose selector matches, brace-balanced. */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  const opener = new RegExp(`(^|[\\s}])${selector.replace(".", "\\.")}\\s*\\{`, "g");
  for (const match of css.matchAll(opener)) {
    let depth = 1;
    let i = match.index! + match[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies;
}

/** Every `:root` declaration block — the app's default token surface. Theme and
 *  scope overrides (`.light`, `.glass-ink-scope`) live on other selectors and
 *  are excluded on purpose: a theme override is intent, not drift. */
const ROOT_CSS = ruleBodies(CSS, ":root").join("\n");
const LIGHT_CSS = ruleBodies(CSS, ".light").join("\n");

/**
 * Reads a CSS custom property's declared value out of index.css's `:root`.
 *
 * Deliberately throws when a token is declared more than once with DIFFERENT
 * values — that is the exact bug this suite exists to catch. Repeat
 * declarations of the SAME value are tolerated.
 */
function cssToken(name: string, source = ROOT_CSS): string {
  const re = new RegExp(`--${name}\\s*:\\s*([^;]+);`, "g");
  const values = [...source.matchAll(re)].map((m) => m[1].trim().replace(/\s+/g, " "));
  if (values.length === 0) throw new Error(`--${name} is not declared in :root`);
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(`--${name} is declared ${values.length}x with conflicting values: ${distinct.join(" | ")}`);
  }
  return distinct[0];
}

/** Pulls a `key: "value"` pair out of a named object literal in the Tailwind
 *  config. The config is read as TEXT rather than imported because it calls
 *  `require()` for its plugins, which does not resolve under the ESM runner. */
function twEntry(block: string, key: string): string {
  const blockRe = new RegExp(`${block}:\\s*\\{([\\s\\S]*?)\\n      \\}`);
  const body = TW.match(blockRe)?.[1];
  if (!body) throw new Error(`Tailwind theme block "${block}" not found`);
  const entryRe = new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`);
  const value = body.match(entryRe)?.[1];
  if (!value) throw new Error(`Tailwind ${block}.${key} not found`);
  return value;
}

const rem = (n: number) => `${n}rem`;

describe("design tokens — CSS, Tailwind and JS agree", () => {
  describe("type scale", () => {
    it("the 11px legibility floor is one value in all three places", () => {
      expect(cssToken("text-2xs")).toBe(rem(TEXT_2XS_REM));
      expect(twEntry("fontSize", "2xs")).toBe(rem(TEXT_2XS_REM));
      expect(TEXT_MIN_PX).toBe(11);
    });

    it("the 13px dense-body step is one value in all three places", () => {
      expect(cssToken("text-sm-minus")).toBe(rem(TEXT_SM_MINUS_REM));
      expect(twEntry("fontSize", "sm-minus")).toBe(rem(TEXT_SM_MINUS_REM));
      expect(remToPx(TEXT_SM_MINUS_REM)).toBe(13);
    });

    it("no --text-* token is sanctioned below the 11px legibility floor", () => {
      const declared = [...ROOT_CSS.matchAll(/--text-[\w-]+\s*:\s*([\d.]+)rem\s*;/g)]
        .map((m) => Number(m[1]));
      expect(declared.length).toBeGreaterThan(0);
      for (const value of declared) expect(remToPx(value)).toBeGreaterThanOrEqual(TEXT_MIN_PX);
    });

    it("the type tokens are size-only — a line-height tuple would reflow every call site", () => {
      const fontSize = (TW.match(/fontSize:\s*\{([\s\S]*?)\n      \}/)?.[1] ?? "")
        .replace(/\/\/.*$/gm, "");
      expect(fontSize).toMatch(/2xs/); // control: the block IS being read
      expect(fontSize).not.toMatch(/\[/); // array form is [size, lineHeight]
    });
  });

  describe("hit areas", () => {
    it("the tap-target floor matches between CSS, Tailwind and JS", () => {
      expect(cssToken("tap-target-min")).toBe(`${TAP_TARGET_MIN_PX}px`);
      expect(twEntry("spacing", "tap")).toBe(rem(TAP_TARGET_MIN_PX / ROOT_FONT_SIZE_PX));
    });

    it("h-11 — the class the app actually uses — is the same metric", () => {
      // Tailwind's default scale: 11 * 0.25rem = 2.75rem = 44px.
      expect(remToPx(11 * 0.25)).toBe(TAP_TARGET_MIN_PX);
    });
  });

  describe("map chrome", () => {
    it("mirrors index.css", () => {
      expect(cssToken("map-chrome-surface")).toBe(MAP_CHROME.surface);
      expect(cssToken("map-chrome-foreground")).toBe(MAP_CHROME.foreground);
      expect(cssToken("map-chrome-border")).toBe(MAP_CHROME.border);
    });

    it("stays pinned to the dark palette — the basemap never lightens", () => {
      expect(LIGHT_CSS).not.toMatch(/--map-chrome-/);
      expect(LIGHT_CSS).toMatch(/--card:/); // control: the theme block IS being read
    });

    it("carries the dark-theme card/foreground/border values verbatim", () => {
      expect(MAP_CHROME.surface).toBe(`hsl(${cssToken("card")})`);
      expect(MAP_CHROME.foreground).toBe(`hsl(${cssToken("foreground")})`);
      expect(MAP_CHROME.border).toBe(`hsl(${cssToken("border")})`);
    });
  });

  describe("glass", () => {
    it("blur radii and saturation mirror index.css", () => {
      expect(cssToken("glass-blur-capsule")).toBe(`${GLASS.blurCapsulePx}px`);
      expect(cssToken("glass-blur-panel")).toBe(`${GLASS.blurPanelPx}px`);
      expect(cssToken("glass-blur-sheet")).toBe(`${GLASS.blurSheetPx}px`);
      expect(cssToken("glass-saturate")).toBe(`${GLASS.saturatePct}%`);
      expect(cssToken("glass-saturate-sheet")).toBe(`${GLASS.saturateSheetPct}%`);
      expect(cssToken("glass-radius-panel")).toBe(`${GLASS.radiusPanelPx}px`);
    });

    it("every glass class drives its blur from a token, never a literal", () => {
      const components = CSS.slice(CSS.indexOf(".glass-surface"), CSS.indexOf(".glass-ink-scope"));
      const blurs = [...components.matchAll(/backdrop-filter:\s*blur\(([^)]+)\)/g)].map((m) => m[1]);
      expect(blurs.length).toBeGreaterThan(0);
      for (const blur of blurs) expect(blur).toMatch(/^var\(--glass-blur-/);
    });

    it("the capsule keeps a pill radius rather than a scale step", () => {
      const capsule = CSS.slice(CSS.indexOf(".glass-capsule"), CSS.indexOf(".glass-sheet"));
      expect(capsule).toMatch(/border-radius:\s*9999px/);
    });
  });

  describe("navigation puck", () => {
    it("mirrors index.css", () => {
      expect(cssToken("nav-puck")).toBe(NAV_PUCK.live);
      expect(cssToken("nav-puck-stale")).toBe(NAV_PUCK.stale);
      expect(cssToken("nav-puck-ring")).toBe(NAV_PUCK.ring);
    });

    it("the puck blue is typed exactly once in the stylesheet", () => {
      const hits = CSS.match(/#2f7bff/gi) ?? [];
      expect(hits).toHaveLength(1); // the --nav-puck declaration itself
    });
  });

  it("the base radius matches index.css", () => {
    expect(cssToken("radius")).toBe(rem(RADIUS_REM));
  });
});

describe("design tokens — no second source of truth", () => {
  it("Tailwind declares no `status` colour palette competing with STATUS_CONFIG", () => {
    // A dead `colors.status = {online, away, busy, offline}` block used to live
    // in the theme with values that did not match the canonical field statuses.
    expect(TW).not.toMatch(/\bstatus:\s*\{/);
  });

  it("designTokens.ts does not restate any canonical field-status colour", () => {
    const tokens = readFileSync(path.join(ROOT, "client", "src", "lib", "designTokens.ts"), "utf8");
    const code = tokens.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const { color } of Object.values(STATUS_CONFIG)) {
      expect(code.toLowerCase()).not.toContain(color.toLowerCase());
    }
  });

  it("field-status colour has exactly one home, and it is shared/statusConfig.ts", () => {
    // shared/knock.ts derives STATE_COLORS from STATUS_CONFIG rather than
    // relisting hexes; only the legacy `contacted` slate is defined locally.
    const knock = readFileSync(path.join(ROOT, "shared", "knock.ts"), "utf8");
    const stateColors = knock.slice(knock.indexOf("export const STATE_COLORS"));
    const block = stateColors.slice(0, stateColors.indexOf("};"));
    const literals = block.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
    expect(literals).toEqual(["#64748b"]);
  });
});
