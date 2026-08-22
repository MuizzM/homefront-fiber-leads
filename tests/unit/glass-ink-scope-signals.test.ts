// A surface that is dark in both app themes must carry the DARK signal tokens,
// not only the dark neutrals. Pinned after the door card's "At door" chip and
// its primary buttons were found resolving to the light palette on the ink
// sheet under the light default.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "client/src/index.css"), "utf8");
const block = (selector: string) => {
  const a = css.indexOf(`${selector} {`);
  expect(a, `missing ${selector}`).toBeGreaterThan(-1);
  return css.slice(a, css.indexOf("}", a));
};
const tokenIn = (body: string, name: string) => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(body);
  return m ? m[1].replace(/\s*\/\*.*$/, "").trim() : null;
};

describe("glass-ink-scope carries the dark signal set", () => {
  const scope = block(".glass-ink-scope");
  const dark = block(":root.dark");
  for (const name of ["primary", "primary-foreground", "success", "warning", "info", "destructive", "destructive-foreground", "ring", "accent-gold-text", "accent-gold-soft", "background"]) {
    it(`--${name} matches :root.dark`, () => {
      expect(tokenIn(scope, name), `--${name} missing from .glass-ink-scope`).not.toBeNull();
      expect(tokenIn(scope, name)).toBe(tokenIn(dark, name));
    });
  }
  it("the door card (dark in both themes) opts in", () => {
    const sheet = readFileSync(join(ROOT, "client/src/components/LeadKnockSheet.tsx"), "utf8");
    expect(sheet).toContain('"glass-sheet glass-ink-scope fixed z-40');
  });
});
