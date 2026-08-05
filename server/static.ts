import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import fs from "node:fs";
import path from "node:path";

// ── Precompressed asset delivery ─────────────────────────────────────────────
// script/build.ts writes a .br (brotli q11) and .gz (gzip 9) sibling next to
// every compressible file in dist/public. Serving those instead of compressing
// per request is a straight win on both ends: the bytes are smaller than an
// online compressor can afford at request time (measured on this build — entry
// JS 108.5 KB gzip -> 93.8 KB brotli, CSS 26.5 -> 21.0), and the server does no
// compression work at all for the assets it serves most.
//
// It also un-breaks the proxy. The Caddyfile declares `encode zstd gzip`, but a
// proxy will not re-encode a response that already carries Content-Encoding —
// so while the app gzipped everything itself, Caddy's encoder was dead weight.
const PRECOMPRESSED = /\.(js|css|svg|json|webmanifest|txt)$/;
const ENCODINGS: readonly { ext: string; encoding: string; token: RegExp }[] = [
  { ext: ".br", encoding: "br", token: /(^|,)\s*br\s*(;|,|$)/ },
  { ext: ".gz", encoding: "gzip", token: /(^|,)\s*gzip\s*(;|,|$)/ },
];

/** Only Vite's fingerprinted output is safe to freeze for a year: the content
 *  hash is in the filename, so a change is a new URL. Everything else in
 *  dist/public (icons, manifest, sw.js, the join form) keeps its name across
 *  deploys and must be allowed to change. */
const IMMUTABLE_PREFIX = "/assets/";
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=3600";

function cacheControlFor(urlPath: string): string {
  if (urlPath.startsWith(IMMUTABLE_PREFIX)) return IMMUTABLE;
  // sw.js is what TELLS the app a new deploy exists. A cached copy pins reps to
  // an old build, so it must always revalidate.
  if (urlPath.endsWith("/sw.js") || urlPath.endsWith(".html")) return "no-cache";
  return REVALIDATE;
}

/** Index the precompressed files ONCE at boot. dist/ never changes while the
 *  process runs, so this replaces a stat syscall on every asset request with a
 *  Set lookup. */
function indexPrecompressed(root: string): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else if (entry.name.endsWith(".br") || entry.name.endsWith(".gz")) found.add(rel);
    }
  };
  walk(root, "");
  return found;
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(__dirname, "public");
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  const precompressed = indexPrecompressed(distPath);

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const urlPath = req.path;
    if (!PRECOMPRESSED.test(urlPath)) return next();

    // Vary regardless of whether THIS response ended up encoded: the same URL
    // can answer differently per Accept-Encoding, and a shared cache must know.
    res.setHeader("Vary", "Accept-Encoding");

    const accepted = String(req.headers["accept-encoding"] ?? "");
    const chosen = ENCODINGS.find(
      (e) => precompressed.has(urlPath + e.ext) && e.token.test(accepted),
    );
    if (!chosen) return next();

    const file = path.join(distPath, urlPath + chosen.ext);
    // Defence in depth: the Set was built by walking distPath, so a hit already
    // implies containment — but never hand a joined path to sendFile without
    // confirming it did not escape the root.
    if (!file.startsWith(distPath + path.sep)) return next();

    res.setHeader("Content-Encoding", chosen.encoding);
    // Content-Type comes from the ORIGINAL extension: the browser must see
    // application/javascript, not whatever ".br" maps to. sendFile leaves an
    // already-set Content-Type alone.
    res.type(path.extname(urlPath));
    res.setHeader("Cache-Control", cacheControlFor(urlPath));
    res.sendFile(file, (err) => {
      // Nothing written yet (a race with a deploy swapping dist) → fall through
      // to express.static and serve the plain file.
      if (err && !res.headersSent) next();
    });
  });

  // Cache policy tuned for bad connections + instant repeat loads: fingerprinted
  // assets are immutable for a year, everything unhashed revalidates so a
  // changed icon, manifest or service worker actually reaches the field.
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      const rel = filePath.slice(distPath.length).split(path.sep).join("/");
      res.setHeader("Cache-Control", cacheControlFor(rel));
    },
  }));

  // fall through to index.html if the file doesn't exist
  app.use("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
