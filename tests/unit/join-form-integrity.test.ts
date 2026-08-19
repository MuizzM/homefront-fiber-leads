import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(path.resolve(__dirname, "../../join-form/index.html"), "utf8");

describe("public join form integrity", () => {
  it("ships parseable inline JavaScript", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0])).not.toThrow();
  });

  it("uses one page heading and discloses the actual contractor terms", () => {
    expect(html.match(/<h1\b/gi)).toHaveLength(1);
    expect(html).toContain("commission-only 1099 independent-contractor");
    expect(html).toContain("There is no hourly wage, salary, or guaranteed earnings");
    expect(html).not.toMatch(/\$150K\+|paid certification|5-day|one to two business days|About 3 minutes/i);
    expect(html).toContain("https://www.homefrontsolutionsllc.com/privacy/");
  });

  it("accepts image identity files only and blocks placeholder intake data", () => {
    const licence = html.match(/<input[^>]+id="licenseFile"[^>]+>/)?.[0] ?? "";
    expect(licence).toContain("image/jpeg,image/png,image/webp");
    expect(licence).not.toContain("application/pdf");
    expect(html).toContain('v !== "00000"');
    expect(html).toContain('$("hasTransport").value !== "true"');
    expect(html).toContain("isPlaceholderCity");
  });
});
