// ── Killing 'unsafe-inline' from script-src ─────────────────────────────────
//
// The CSP here was already strong — no eval, object-src 'none', base-uri 'self',
// frame-ancestors locked, HSTS preloaded. One hole was left, with a TODO on it:
//
//     scriptSrcElem: ["'self'", "'unsafe-inline'", ...]
//
// `'unsafe-inline'` is the single largest remaining XSS lever in the policy. It
// exists because index.html carries two first-party inline scripts — the
// pre-paint theme switch (which must run before first paint or the app flashes
// white) and the lazy Mapbox loader.
//
// ── WHY HASHES, NOT NONCES ─────────────────────────────────────────────────
//
// Nonces need a fresh random value per RESPONSE, which means index.html can no
// longer be a cacheable static file — every load has to be templated, and the
// `Cache-Control: no-cache` static path in server/static.ts would have to become
// a render. Hashes cost nothing at request time and the scripts are static.
//
// ── WHY COMPUTED AT BOOT, NOT AT BUILD ─────────────────────────────────────
//
// A hardcoded hash list is a trap: edit the theme script, forget the list, and
// the app breaks in production with a CSP violation that never appears in dev
// (where the CSP is looser and Vite serves a different HTML). Reading the actual
// served file at startup means the hashes CANNOT drift from the bytes — the
// thing being hashed is the thing being served.
//
// If the file cannot be read (dev, or a broken build), we fall back to
// 'unsafe-inline' rather than shipping a policy that blanks the app. A hardened
// CSP that takes the site down is worse than the hole it closed.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Inline <script> bodies — those WITHOUT a src attribute. */
function inlineScriptBodies(html: string): string[] {
  const out: string[] = [];
  // Deliberately tolerant of attributes and whitespace; a missed script is a
  // broken app, so this errs toward matching.
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;   // external — covered by 'self'
    out.push(m[2] ?? "");
  }
  return out;
}

/**
 * CSP hash tokens for every inline script in the built index.html.
 *
 * The hash covers the EXACT bytes between the tags, with no trimming — CSP
 * hashes the raw content, and stripping a single leading newline produces a
 * token the browser will not match.
 */
export function inlineScriptHashes(html: string): string[] {
  return inlineScriptBodies(html).map(body =>
    `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
  );
}

// This module is loaded in BOTH module formats: the production bundle is CJS
// (script/build.ts → format "cjs", where __dirname exists), while `npm run dev`
// runs the TypeScript directly as ESM, where it does not. Referencing it bare
// threw `ReferenceError: __dirname is not defined in ES module scope` at import
// time — before the server ever listened, so the dev server could not boot at
// all. `typeof` on an undeclared identifier is the one safe way to ask.
const bundleDir: string | null = typeof __dirname === "string" ? __dirname : null;

/** Candidate locations for the served index.html, prod first. */
function indexCandidates(): string[] {
  return [
    // prod: dist/public, resolved next to the bundle. Absent under ESM dev,
    // where the two cwd-relative candidates below are the real answers anyway.
    ...(bundleDir ? [path.resolve(bundleDir, "public", "index.html")] : []),
    path.resolve(process.cwd(), "dist", "public", "index.html"),
    path.resolve(process.cwd(), "client", "index.html"),    // dev source
  ];
}

let cached: string[] | null = null;

/**
 * Hashes for the CSP, computed once at boot.
 *
 * Returns an EMPTY array when index.html cannot be read, and the caller falls
 * back to 'unsafe-inline'. That fallback is deliberate: in dev, Vite injects its
 * own HMR client inline, which no build-time hash could ever cover.
 */
export function scriptHashesForCsp(): string[] {
  // Dev never pins. Vite serves a TRANSFORMED index.html — it injects the
  // react-refresh preamble inline and rewrites the first-party scripts — so no
  // hash computed from a file on disk can match the bytes actually served. A
  // stale dist/public/index.html on a dev machine would otherwise win the
  // candidate scan below and pin production hashes against Vite's HTML, which
  // blocks every inline script and boots the app black.
  if (process.env.NODE_ENV === "development") return [];
  if (cached) return cached;
  for (const file of indexCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const hashes = inlineScriptHashes(fs.readFileSync(file, "utf8"));
      if (hashes.length > 0) {
        cached = hashes;
        return cached;
      }
    } catch { /* try the next candidate */ }
  }
  cached = [];
  return cached;
}

/**
 * The script-src-elem list.
 *
 * With hashes present, CSP3 browsers IGNORE 'unsafe-inline' — so including it
 * would be harmless there but would still leave CSP2-only browsers wide open.
 * We omit it entirely when we have hashes, and keep it only when we could not
 * compute any.
 */
export function scriptSrcElem(extraOrigins: string[] = []): string[] {
  const hashes = scriptHashesForCsp();
  const base = ["'self'", "blob:", ...extraOrigins];
  return hashes.length > 0 ? [...base, ...hashes] : [...base, "'unsafe-inline'"];
}

/** True when the hardened policy is actually in force — surfaced on the
 *  diagnostics endpoint so "did it apply?" is answerable without a browser. */
export function inlineScriptsAreHashed(): boolean {
  return scriptHashesForCsp().length > 0;
}
