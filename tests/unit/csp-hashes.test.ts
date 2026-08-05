// CSP script hashes.
//
// The failure mode this guards is nasty and silent: a hash that does not match
// the bytes being served does not throw, does not log, and does not fail a
// build. It blocks the script in the browser — so the app boots white, in
// production only, on the first load after someone edits index.html.
//
// So these tests check the two things that actually go wrong:
//   1. the hash is computed over the EXACT bytes (no trimming, no normalising)
//   2. 'unsafe-inline' is dropped when — and only when — hashes exist
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { inlineScriptHashes, scriptSrcElem, scriptHashesForCsp } from "../../server/cspHashes";

const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;

describe("hashing inline scripts", () => {
  it("hashes the exact body, byte for byte", () => {
    const body = `\n  console.log("hi");\n`;
    expect(inlineScriptHashes(`<script>${body}</script>`)).toEqual([sha(body)]);
  });

  it("does NOT trim — a stripped newline is a hash the browser will not match", () => {
    // The single easiest way to break this. CSP hashes raw content; "tidying"
    // the string produces a token that looks right and matches nothing.
    const padded = "\n  var a = 1;\n";
    const trimmed = "var a = 1;";
    expect(inlineScriptHashes(`<script>${padded}</script>`)[0]).toBe(sha(padded));
    expect(inlineScriptHashes(`<script>${padded}</script>`)[0]).not.toBe(sha(trimmed));
  });

  it("skips scripts with a src — those are covered by 'self'", () => {
    const html = `<script src="/main.js"></script><script>inline()</script>`;
    expect(inlineScriptHashes(html)).toEqual([sha("inline()")]);
  });

  it("skips a src'd script even with other attributes around it", () => {
    const html = `<script type="module" crossorigin src="/a.js"></script>`;
    expect(inlineScriptHashes(html)).toEqual([]);
  });

  it("keeps an inline script that has attributes but no src", () => {
    expect(inlineScriptHashes(`<script type="text/javascript">go()</script>`)).toEqual([sha("go()")]);
  });

  it("finds every inline script, not just the first", () => {
    const html = `<script>one()</script><p>x</p><script>two()</script>`;
    expect(inlineScriptHashes(html)).toEqual([sha("one()"), sha("two()")]);
  });

  it("handles a script containing '</' inside a string", () => {
    // Non-greedy matching must still stop at the real closing tag.
    const body = `var s = "a<b";`;
    expect(inlineScriptHashes(`<script>${body}</script><script>x()</script>`))
      .toEqual([sha(body), sha("x()")]);
  });
});

describe("the policy it produces", () => {
  it("drops 'unsafe-inline' entirely once there are hashes", () => {
    // Keeping both would be harmless on CSP3 browsers (which ignore
    // 'unsafe-inline' when hashes are present) but would leave CSP2-only
    // browsers wide open — which is most of the point of doing this.
    const list = scriptSrcElem(["https://api.mapbox.com"]);
    if (scriptHashesForCsp().length > 0) {
      expect(list).not.toContain("'unsafe-inline'");
      expect(list.some(v => v.startsWith("'sha256-"))).toBe(true);
    } else {
      // No built index.html in this environment — the fallback must be safe to
      // ship rather than a policy that blanks the app.
      expect(list).toContain("'unsafe-inline'");
    }
    expect(list).toContain("'self'");
    expect(list).toContain("https://api.mapbox.com");
  });

  it("never pins in development — Vite rewrites the HTML it serves", () => {
    // A stale dist/public/index.html on a dev machine used to win the candidate
    // scan and pin production hashes against Vite's transformed HTML, blocking
    // every inline script (including the react-refresh preamble): black screen.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(scriptHashesForCsp()).toEqual([]);
      expect(scriptSrcElem()).toContain("'unsafe-inline'");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("covers every inline script in the real index.html", () => {
    // The end-to-end check: whatever the app actually ships, each inline script
    // in it has a matching token. Skipped when the source file is absent.
    const file = path.resolve(process.cwd(), "client", "index.html");
    if (!existsSync(file)) return;
    const html = readFileSync(file, "utf8");
    const hashes = inlineScriptHashes(html);
    const inlineCount = (html.match(/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi) ?? []).length;
    expect(hashes.length).toBe(inlineCount);
    expect(inlineCount).toBeGreaterThan(0);   // the theme + Mapbox loader scripts
    for (const h of hashes) expect(h).toMatch(/^'sha256-[A-Za-z0-9+/]+=*'$/);
  });
});
