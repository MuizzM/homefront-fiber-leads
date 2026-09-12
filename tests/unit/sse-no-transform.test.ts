// Guardrail: every SSE endpoint opts out of the compressor.
//
// compression() is mounted globally (server/index.ts) and text/event-stream is
// compressible under its text/* fallback, so unless a response says
// `no-transform` zlib buffers the small progress frames instead of delivering
// them. The symptom is not an error: the stream simply goes quiet, and the
// live view sits blank until enough bytes accumulate or the stream ends.
// X-Accel-Buffering only instructs nginx and does not reach the in-process
// compressor, so it is not a substitute.
//
// This is a source invariant rather than a per-endpoint request test because
// the bug was DRIFT: seven of eight endpoints had the header and one did not.
// A test that only covers today's endpoints would not catch tomorrow's.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

// A handler declares SSE by naming the content type. Cache-Control is set
// within a few lines either side of it in every style this repo uses (a
// res.set({...}) block or consecutive res.setHeader calls), so a small window
// around the declaration is enough to find the opt-out without parsing TS.
const WINDOW = 8;
const SSE_DECLARATION = /(?:["']Content-Type["']\s*[:,]\s*["']text\/event-stream|\.type\(\s*["']text\/event-stream)/i;

// Match the DIRECTIVE inside an actual Cache-Control value, never a mention of
// the word. An earlier version of this test searched the window for the bare
// string and passed against a handler whose only "no-transform" was in the
// comment explaining why it needed one.
const CACHE_CONTROL_NO_TRANSFORM =
  /["']Cache-Control["']\s*[,:]\s*["'][^"']*no-transform[^"']*["']/i;

/** A comment or a line of prose, not a header assignment. */
function isProse(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("SSE responses are never compressed", () => {
  it("recognizes header declarations without treating comparisons as endpoints", () => {
    expect(SSE_DECLARATION.test('res.setHeader("Content-Type", "text/event-stream");')).toBe(true);
    expect(SSE_DECLARATION.test('"Content-Type": "text/event-stream; charset=utf-8"')).toBe(true);
    expect(SSE_DECLARATION.test('res.type("text/event-stream")')).toBe(true);
    expect(SSE_DECLARATION.test('res.getHeader("Content-Type").startsWith("text/event-stream")')).toBe(false);
  });
  it("every text/event-stream handler sets Cache-Control: no-transform", () => {
    const offenders: string[] = [];
    let declarations = 0;

    for (const file of walk("server")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!SSE_DECLARATION.test(line)) return;
        // Skip mentions in prose and in negative assertions about the type.
        if (isProse(line)) return;
        declarations++;
        const near = lines
          .slice(Math.max(0, i - WINDOW), i + WINDOW + 1)
          .filter((l) => !isProse(l));
        if (!near.some((l) => CACHE_CONTROL_NO_TRANSFORM.test(l))) {
          offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }

    // If this drops to zero the walk or the marker broke, and the test would
    // pass while checking nothing.
    expect(declarations).toBeGreaterThanOrEqual(7);
    expect(
      offenders,
      `SSE endpoints missing Cache-Control: no-transform (compression() will buffer their events):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
