import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Two floors, both physical rather than aesthetic.
 *
 * 11px is the legibility floor: a rep reads this screen on a phone, outdoors,
 * in direct sun, at arm's length, between doors. 44px is the one-handed
 * hit-area floor (WCAG 2.5.5, iOS HIG).
 *
 * Both floors were documented in `tailwind.config.ts` and in
 * `docs/DESIGN_SYSTEM.md`, and both kept being breached anyway - not by anyone
 * disagreeing with them, but because an arbitrary `text-[10px]` is one keystroke
 * cheaper than looking up `text-2xs`, and nothing failed when you wrote it. The
 * app accumulated 93 sub-floor type call sites across 41 files that way.
 *
 * A comment cannot fail a build. This can.
 *
 * The type floor is a hard failure: `text-2xs` exists, it is size-only (no
 * line-height tuple), so the swap never reflows a line box and there is no
 * reason to reach past it.
 */
const SRC = path.resolve(__dirname, "../../client/src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const files = sourceFiles(SRC).map((file) => ({
  file: path.relative(SRC, file),
  text: fs.readFileSync(file, "utf8"),
}));

describe("11px type floor", () => {
  // Any arbitrary font size below 11px, whole or fractional: text-[10px],
  // text-[10.5px], text-[9px], text-[8.5px].
  const SUB_FLOOR = /text-\[(\d+(?:\.\d+)?)px\]/g;

  /**
   * The one legitimate exception, and it is narrow: a scale MODEL of another
   * interface. `AddToHomeScreen` draws a miniature of the iOS share sheet and
   * `AnnouncementComposer` draws a miniature lock-screen notification, both so
   * the user can recognise the real thing when it appears. That text is a
   * picture of type, not type - nobody is asked to read it, and scaling it to
   * 11px would break the illusion that makes the preview useful.
   *
   * Marked at the call site with a trailing `type-floor-exempt:` comment
   * carrying the reason, so the exception is reviewable where it is taken
   * rather than in a list here that nobody reads.
   */
  const EXEMPT = /type-floor-exempt:/;

  it("has no text below 11px anywhere in client source", () => {
    const violations: string[] = [];
    for (const { file, text } of files) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        // The marker may sit on the line itself or in the comment block
        // immediately above it, which is usually a few lines once the reason
        // is written out properly.
        const window = [line, lines[i - 1], lines[i - 2], lines[i - 3], lines[i - 4]];
        if (window.some((l) => EXEMPT.test(l ?? ""))) return;
        for (const m of line.matchAll(SUB_FLOOR)) {
          if (Number(m[1]) < 11) violations.push(`${file}:${i + 1}  ${m[0]}`);
        }
      });
    }
    expect(
      violations,
      `Below the 11px legibility floor. Use text-2xs (11px), which is size-only so it will not reflow the line box:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("still exposes the token that replaces them", () => {
    const tailwind = fs.readFileSync(path.resolve(__dirname, "../../tailwind.config.ts"), "utf8");
    expect(tailwind).toMatch(/"2xs":\s*"0\.6875rem"/);
  });
});

/**
 * The tap floor cannot be a blanket source rule the way the type floor can: a
 * `h-8` is correct on a decorative avatar and wrong on a button, and only the
 * element's role tells them apart. What IS mechanically checkable is the
 * pattern that is always wrong on a touch screen - an affordance that only
 * exists on hover. A rep has no pointer, so `opacity-0 group-hover:opacity-100`
 * on an interactive element is not a subtle control, it is an absent one.
 */
/**
 * The two primitives that put a sub-floor control on many screens at once, so
 * they are pinned by name. Both were found by measuring the running app, not by
 * reading class strings: `size="sm"` rendered at 40px on Referrals' Retry and
 * Mileage's Export, and every Switch in the app had a 24px hit area.
 */
describe("shared control primitives clear the tap floor", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(SRC, rel), "utf8");

  it("Button size=sm is 44px on touch, small only on the desktop half", () => {
    const button = read("components/ui/button.tsx");
    const sm = button.match(/sm:\s*"([^"]+)"/)?.[1] ?? "";
    expect(sm, `Button size="sm" was "${sm}"`).toContain("min-h-11");
    expect(sm).toMatch(/md:min-h-\d/);
  });

  it("Switch keeps a 24px track and a 44px hit area", () => {
    const sw = read("components/ui/switch.tsx");
    // The track stays small on purpose - a 44px switch stops reading as one.
    expect(sw).toContain("h-6 w-11");
    // ...so the hit area has to come from somewhere else.
    expect(sw, "Switch needs tap-expand, or its hit area is its 24px track").toContain("tap-expand");
  });

  it("tap-expand floors the hit area at the token, not at a fixed inset", () => {
    const css = fs.readFileSync(path.resolve(SRC, "index.css"), "utf8");
    const start = css.indexOf(".tap-expand::after");
    expect(start, "tap-expand::after is missing from index.css").toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("min-width: var(--tap-target-min)");
    expect(block).toContain("min-height: var(--tap-target-min)");
  });

  it("Checkbox keeps a 16px box and a 44px hit area", () => {
    // Same shape as Switch: the drawn control stays small (a 44px checkbox
    // stops reading as one), the hit area comes from tap-expand. Found on the
    // Incentives money-approval queue, where the per-row checkbox is the ONLY
    // way to select a bonus and admins were aiming at 16px on phones.
    const cb = read("components/ui/checkbox.tsx");
    expect(cb).toContain("h-4 w-4");
    expect(cb, "Checkbox needs tap-expand, or its hit area is its 16px box").toContain("tap-expand");
  });
});

describe("arbitrary min-h values do not undercut the tap floor", () => {
  // min-h-[36px] on a button passes every primitive-level check while sitting
  // 8px under the floor. Any interactive element that reaches for an arbitrary
  // min-height must reach AT LEAST the token value - or use min-h-tap, which
  // says what it means.
  it("no interactive element declares an arbitrary min-h below 44px", () => {
    const violations: string[] = [];
    for (const { file, text } of files) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const m = line.match(/min-h-\[(\d+(?:\.\d+)?)(px|rem)\]/);
        if (!m) return;
        const px = m[2] === "rem" ? parseFloat(m[1]) * 16 : parseFloat(m[1]);
        if (px >= 44) return;
        // Only interactive elements: a short message bubble or meta row may be
        // any height it likes.
        const window = lines.slice(Math.max(0, i - 7), i + 2).join(" ");
        const interactive = /<button|<a\b|onClick|role="button"|<Link|type="button"|type="submit"/.test(window);
        if (interactive) violations.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
    expect(
      violations,
      `Interactive element with an arbitrary min-h under the 44px floor. Use min-h-tap (or pair the small drawn size with .tap-expand):\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});

describe("touch reachability", () => {
  it("hides no interactive control behind hover alone", () => {
    const violations: string[] = [];
    for (const { file, text } of files) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        const hoverOnly = /opacity-0[^"'`]*group-hover:opacity-100|group-hover:opacity-100[^"'`]*opacity-0/.test(line);
        if (!hoverOnly) return;
        // Only interactive elements matter; a decorative flourish may fade in.
        const interactive = /<button|<a\b|onClick|role="button"|<Link/.test(line);
        if (interactive) violations.push(`${file}:${i + 1}  ${line.trim().slice(0, 120)}`);
      });
    }
    expect(
      violations,
      `Hover-only affordance on an interactive element. Touch devices have no hover, so this control does not exist for a rep on a phone. Make it always visible, or move it into a menu that a tap can open:\n${violations.join("\n")}`,
    ).toEqual([]);
  });
});
