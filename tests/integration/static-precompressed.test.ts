// @vitest-environment node
// ── Precompressed assets must survive a dot-directory checkout ───────────────
// Express 5's res.sendFile (send 1.x) applies its dotfiles policy to EVERY
// component of a rootless absolute path. A build running under a dot-directory
// (a git worktree in .claude/worktrees, a deploy in ~/.local) therefore had
// sendFile 404 every precompressed asset before writing a byte; the handler
// fell through to express.static, which served the PLAIN body while the
// already-set `Content-Encoding: br` stuck — every js/css load died in the
// browser with ERR_CONTENT_DECODING_FAILED and the app black-screened. The fix
// serves with { root: distPath } so the dotfile check covers only the URL part,
// and the fall-through strips every header it staged so a genuine sendFile
// failure (a deploy swapping dist mid-run) can never mislabel the next body.
//
// The fixture root deliberately contains a ".dot-checkout" path component:
// that is the whole regression.
import { createServer, request as httpRequest, type Server, type IncomingHttpHeaders } from "node:http";
import { brotliCompressSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStatic } from "../../server/static";

const PLAIN = 'console.log("the plain, uncompressed asset body — long enough to differ");\n';
const BR = brotliCompressSync(Buffer.from(PLAIN));
const INDEX_HTML = "<!doctype html><title>app shell</title>";

let server: Server;
let port: number;

// Raw http (not fetch): undici transparently decodes br/gzip, and this suite
// exists to assert the bytes and headers actually on the wire.
function rawGet(urlPath: string, acceptEncoding?: string) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: urlPath,
        headers: acceptEncoding !== undefined ? { "accept-encoding": acceptEncoding } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hf-static-"));
  const distPath = path.join(scratch, ".dot-checkout", "public");
  fs.mkdirSync(path.join(distPath, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distPath, "index.html"), INDEX_HTML);
  for (const name of ["app-abc123.js", "gone-def456.js", "razed-0f9e8d.js"]) {
    fs.writeFileSync(path.join(distPath, "assets", name), PLAIN);
    fs.writeFileSync(path.join(distPath, "assets", `${name}.br`), BR);
  }

  const app = express();
  serveStatic(app, distPath);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;

  // Simulate deploys swapping dist AFTER boot indexed the .br siblings: the
  // handler still believes both .br files exist.
  fs.rmSync(path.join(distPath, "assets", "gone-def456.js.br"));
  fs.rmSync(path.join(distPath, "assets", "razed-0f9e8d.js.br"));
  fs.rmSync(path.join(distPath, "assets", "razed-0f9e8d.js"));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("precompressed assets under a dot-directory checkout", () => {
  it("serves the brotli bytes, not the plain body mislabelled as brotli", async () => {
    const res = await rawGet("/assets/app-abc123.js", "br");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers.vary).toBe("Accept-Encoding");
    expect(res.body.equals(BR)).toBe(true);
  });

  it("serves the plain body to a client that does not accept brotli", async () => {
    const res = await rawGet("/assets/app-abc123.js", "identity");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString()).toBe(PLAIN);
    // A shared cache must still know this URL answers per Accept-Encoding.
    expect(res.headers.vary).toBe("Accept-Encoding");
  });

  it("falls through to the plain file without Content-Encoding when the indexed .br is gone", async () => {
    const res = await rawGet("/assets/gone-def456.js", "br");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.body.toString()).toBe(PLAIN);
  });

  it("reaches the index.html fallback with no stale js headers when both files are gone", async () => {
    const res = await rawGet("/assets/razed-0f9e8d.js", "br");
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-cache");
    expect(res.body.toString()).toBe(INDEX_HTML);
  });

  it("serves the app shell for SPA deep links", async () => {
    const res = await rawGet("/leads/42");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body.toString()).toBe(INDEX_HTML);
  });
});
