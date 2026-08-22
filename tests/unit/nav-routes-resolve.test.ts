import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Every link works.
 *
 * The sidebar, the More sheet and the command palette all render from the one
 * NAV_ITEMS table in Layout.tsx; the routes live in App.tsx. Nothing ties the
 * two together except this test: an entry whose href no <Route> serves lands
 * on the 404 with a confident label above it, and that only shows up by
 * clicking every entry, which a reviewer does not do and a test can.
 *
 * Static on purpose. Rendering the router would need every page's data
 * mocked; reading the two sources needs nothing and catches the same slip.
 */
const layoutSource = fs.readFileSync(path.resolve(__dirname, "../../client/src/pages/Layout.tsx"), "utf8");
const appSource = fs.readFileSync(path.resolve(__dirname, "../../client/src/App.tsx"), "utf8");

/** Hrefs declared in NAV_ITEMS (the object-literal block only). */
function navHrefs(): string[] {
  const block = layoutSource.slice(layoutSource.indexOf("const NAV_ITEMS"), layoutSource.indexOf("function navItemIsActive"));
  return [...block.matchAll(/\{\s*href:\s*"([^"]+)"/g)].map(m => m[1]);
}

/** Route path patterns declared in App.tsx. */
function routePatterns(): string[] {
  return [...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map(m => m[1]);
}

/** wouter-style match: literal segments must equal, ":param" segments match anything. */
function matches(pattern: string, href: string): boolean {
  const p = pattern.split("/"), h = href.split("/");
  if (p.length !== h.length) return false;
  return p.every((seg, i) => seg.startsWith(":") ? h[i].length > 0 : seg === h[i]);
}

describe("every nav entry resolves to a route", () => {
  const hrefs = navHrefs();
  const patterns = routePatterns();

  it("reads both tables", () => {
    expect(hrefs.length).toBeGreaterThan(30);
    expect(patterns.length).toBeGreaterThan(30);
  });

  it("has a <Route> for every NAV_ITEMS href", () => {
    const dead = hrefs.filter(href => !patterns.some(pattern => matches(pattern, href)));
    expect(dead).toEqual([]);
  });

  it("keeps the palette's action targets routable", () => {
    const actionTargets = [...layoutSource.matchAll(/window\.location\.hash = "#(\/[^"]*)"/g)].map(m => m[1]);
    expect(actionTargets.length).toBeGreaterThan(3);
    const dead = actionTargets.filter(href => !patterns.some(pattern => matches(pattern, href)));
    expect(dead).toEqual([]);
  });
});
