import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * ONE page title treatment across the whole app.
 *
 * The most prominent element on every screen had drifted into three sizes
 * (text-xl, text-2xl, text-[22px]) and two weights, because half the screens
 * used the shared PageHeader and half hand-rolled an <h1>. Nothing catches
 * that by looking at one screen at a time - it is only visible by comparing
 * them, which is exactly what a test can do and a reviewer cannot.
 *
 * The rule: a page-level <h1> is text-xl font-bold, whether it comes from
 * PageHeader or from a screen that keeps its own header markup for a custom
 * action row. Sub-page headings are not page titles and are not covered.
 */
const pagesDir = path.resolve(__dirname, "../../client/src/pages");
const scaffold = path.resolve(__dirname, "../../client/src/components/ui/page-scaffold.tsx");

/** Every <h1 ...> opening tag in a file, with its className text. */
function pageTitles(source: string): string[] {
  return [...source.matchAll(/<h1\b[^>]*>/g)].map(m => m[0]);
}

describe("one page-title treatment app-wide", () => {
  it("PageHeader is still the reference: text-xl and font-bold", () => {
    const titles = pageTitles(fs.readFileSync(scaffold, "utf8"));
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("text-xl");
    expect(titles[0]).toContain("font-bold");
  });

  // Not page titles, and deliberately left alone: the login card's heading on a
  // full-screen auth view, the 404, and the section/document headings that sit
  // INSIDE a screen rather than naming it.
  const NOT_PAGE_TITLES = new Set([
    "Login.tsx", "not-found.tsx", "CallingLead.tsx", "PropertyDetail.tsx", "StatementPage.tsx",
  ]);

  it("no screen invents its own page-title size or weight", () => {
    const offenders: string[] = [];
    for (const file of fs.readdirSync(pagesDir)) {
      if (!file.endsWith(".tsx") || NOT_PAGE_TITLES.has(file)) continue;
      const source = fs.readFileSync(path.join(pagesDir, file), "utf8");
      for (const tag of pageTitles(source).slice(0, 1)) {
        // A title that carries no className at all inherits, which is fine.
        if (!/className=/.test(tag)) continue;
        const sized = /text-(xs|sm|base|lg|xl|2xl|3xl|\[\d+px\])/.exec(tag)?.[0];
        const bold = /font-(medium|semibold|bold|extrabold)/.exec(tag)?.[0];
        if (sized && sized !== "text-xl") offenders.push(`${file}: ${sized}`);
        if (bold && bold !== "font-bold") offenders.push(`${file}: ${bold}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
