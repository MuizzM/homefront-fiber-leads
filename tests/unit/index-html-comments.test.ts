import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A stray `-->` inside an explanatory comment closes it early and dumps the
// REST of that comment onto the page as visible text, at the top of every
// route, on every load. That shipped once: a preconnect comment in <head> was
// extended with a second paragraph placed after an existing terminator, and
// production rendered "Both carry crossorigin: MapLibre fetches tiles ..." above
// the app. Nothing caught it — the markup is still well-formed HTML, the build
// succeeds, and no component test reads index.html.
//
// This is an INVARIANT over the file rather than a check for that one sentence:
// a test naming today's paragraph would not catch tomorrow's comment.
const HTML_PATH = resolve(__dirname, "../../client/index.html");

/** Walk the file once, tracking whether we are inside a comment. */
function scanComments(src: string) {
  const strays: Array<{ line: number; text: string }> = [];
  let unclosed: { line: number } | null = null;
  let inComment = false;
  let openedAt = 0;

  src.split("\n").forEach((line, i) => {
    let col = 0;
    for (;;) {
      if (!inComment) {
        const open = line.indexOf("<!--", col);
        // A `-->` reached while OUTSIDE a comment is the bug: it either closed
        // one early (leaking the remainder) or is itself literal page text.
        const close = line.indexOf("-->", col);
        if (close !== -1 && (open === -1 || close < open)) {
          strays.push({ line: i + 1, text: line.trim() });
          col = close + 3;
          continue;
        }
        if (open === -1) break;
        inComment = true;
        openedAt = i + 1;
        col = open + 4;
      } else {
        const close = line.indexOf("-->", col);
        if (close === -1) break;
        inComment = false;
        col = close + 3;
      }
    }
  });

  if (inComment) unclosed = { line: openedAt };
  return { strays, unclosed };
}

describe("client/index.html comment integrity", () => {
  const src = readFileSync(HTML_PATH, "utf8");

  it("has no `-->` outside a comment (which would leak comment text onto the page)", () => {
    const { strays } = scanComments(src);
    expect(
      strays,
      `stray comment terminator(s) — the text after each of these renders on the page:\n` +
        strays.map((s) => `  line ${s.line}: ${s.text}`).join("\n"),
    ).toEqual([]);
  });

  it("leaves no comment unclosed", () => {
    const { unclosed } = scanComments(src);
    expect(unclosed, `comment opened at line ${unclosed?.line} is never closed`).toBeNull();
  });

  it("puts no bare text between <head> and </head>", () => {
    const head = src.match(/<head[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    // Strip comments, then elements; whatever survives would be rendered text.
    const leftover = head
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // <title> holds real text, but it names the tab and never renders in the page.
      .replace(/<title[\s\S]*?<\/title>/gi, "")
      .replace(/<[^>]+>/g, "")
      .trim();
    expect(leftover, `text in <head> renders above the app: ${JSON.stringify(leftover.slice(0, 200))}`).toBe("");
  });
});
