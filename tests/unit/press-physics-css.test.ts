// The card's press physics and the cascade fix they depend on. Tailwind v3
// flattens @layer, so a base rule `button:active { transform: ... }` (0,2,1)
// outranked every `active:scale-*` utility (0,2,0) and no <button> ever showed
// its press. The base rule must use the independent `translate` property.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const css = readFileSync(resolve(__dirname, "../../client/src/index.css"), "utf8");

describe("press physics css", () => {
  it("the base button press never sets transform (it would shadow every active:scale utility)", () => {
    const rule = css.match(/button:not\(:disabled\):active\s*\{([^}]*)\}/);
    expect(rule, "base button press rule missing").not.toBeNull();
    expect(rule![1]).toMatch(/translate:\s*0 0\.5px/);
    expect(rule![1]).not.toMatch(/\btransform\s*:/);
  });

  it("disc and pill presses are transform-only, under 320ms, with a 40ms press-in", () => {
    for (const sel of [".disc-press", ".tap-press"]) {
      const block = css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`));
      expect(block, `${sel} missing`).not.toBeNull();
      const durations = [...block![1].matchAll(/(\d+)ms/g)].map(m => Number(m[1]));
      expect(durations.length).toBeGreaterThan(0);
      for (const d of durations) expect(d).toBeLessThanOrEqual(320);
    }
    expect(css).toMatch(/button:active > \.disc-press\s*\{[^}]*transform:\s*scale\(0\.9\)[^}]*transition-duration:\s*40ms/);
    expect(css).toMatch(/\.tap-press:active\s*\{[^}]*transform:\s*scale\(var\(--press-scale, 0\.95\)\)[^}]*transition-duration:\s*40ms/);
    expect(css).toMatch(/--press-scale:\s*0\.95;/);
  });

  it("the post-mark entrance holds inside its duration, never via animation-delay, and animates opacity only", () => {
    const kf = css.match(/@keyframes post-mark-in\s*\{([^}]*\}[^}]*\})/);
    expect(kf).not.toBeNull();
    expect(kf![1]).toMatch(/0%,\s*40%\s*\{\s*opacity:\s*0;\s*\}/);
    expect(kf![1]).not.toMatch(/transform|height|width|top|margin/);
    const use = css.match(/\.post-mark-in\s*\{([^}]*)\}/);
    expect(use![1]).not.toMatch(/animation-delay/);
    expect(use![1]).toMatch(/280ms/);
  });

  it("the status pop and the card crossfade stay under 320ms", () => {
    expect(css).toMatch(/\.status-pop\s*\{[^}]*240ms/);
    expect(css).toMatch(/\.card-swap-in\s*\{[^}]*0\.12s/);
  });
});
