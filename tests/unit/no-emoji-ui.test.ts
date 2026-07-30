// Guardrail: rep-facing UI stays emoji-free (professional SaaS look). This fails
// the build if a pictographic emoji is reintroduced into client source — labels,
// toasts, badges, and even comments. Icons come from lucide-react, never emoji.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PICTO = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("rep-facing UI is emoji-free", () => {
  it("no pictographic emoji anywhere in client/src", () => {
    const offenders: string[] = [];
    for (const file of walk("client/src")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const m = line.match(PICTO);
        if (m) offenders.push(`${file}:${i + 1}  ${JSON.stringify(m[0])}  ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders, `Found emoji in UI (use a lucide icon instead):\n${offenders.join("\n")}`).toEqual([]);
  });
});
