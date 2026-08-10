import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The route stage must not leave a transform behind.
 *
 * ANY non-`none` transform makes an element the containing block for its
 * position:fixed descendants. `.app-route-stage` is also the scroll container,
 * so while a transform rests on it every modal, sheet and overlay inside a
 * page is anchored to the SCROLLING stage instead of the viewport - they drift
 * with the content instead of covering it.
 *
 * That is easy to reintroduce, because the broken version looks completely
 * reasonable: `to { transform: translate3d(0,0,0) }` with `fill-mode: both`
 * reads as "end where you started". An identity transform is still a
 * transform, and `both` makes it permanent. Measured in a browser: fixed
 * children resolved to 65px instead of 0.
 */
const css = fs.readFileSync(
  path.resolve(__dirname, "../../client/src/index.css"), "utf8",
);

/** The body of a named @keyframes block. */
function keyframes(name: string): string {
  const m = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  return m?.[1] ?? "";
}

/** The body of a top-level rule. */
function rule(selector: string): string {
  const m = new RegExp(`\\n\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
  return m?.[1] ?? "";
}

describe("the route entrance leaves no containing block behind", () => {
  it("ends on transform: none, not an identity transform", () => {
    const frames = keyframes("app-route-enter");
    expect(frames).toContain("transform");
    // The final frame must clear the transform outright.
    const to = /to\s*\{([^}]*)\}/.exec(frames)?.[1] ?? "";
    expect(to).toMatch(/transform:\s*none/);
    expect(to).not.toMatch(/translate/);
  });

  it("does not carry a fill mode that would make the from-state stick", () => {
    const stage = rule(".app-route-stage");
    expect(stage).toContain("app-route-enter");
    // `both`/`backwards` would apply the 5px from-state before the animation
    // runs - and a kept tab re-shown by a display flip never re-runs it.
    expect(stage).not.toMatch(/animation:[^;]*\b(both|backwards|forwards)\b/);
  });

  it("still collapses for a viewer who asked for reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.app-route-stage \{ animation: none; \}/);
  });
});
