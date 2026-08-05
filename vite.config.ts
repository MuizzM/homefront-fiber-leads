import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { visualizer } from "rollup-plugin-visualizer";

// Opt-in bundle analysis: `ANALYZE=1 npx vite build` emits dist/public/stats.html
// (treemap) with gzip/brotli sizes. Off by default so normal / production builds
// are unaffected.
const analyze = process.env.ANALYZE === "1" || process.env.ANALYZE === "true";

export default defineConfig({
  plugins: [
    react(),
    ...(analyze
      ? [
          visualizer({
            filename: path.resolve(import.meta.dirname, "dist/public/stats.html"),
            template: "treemap",
            gzipSize: true,
            brotliSize: true,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  // ABSOLUTE, not "./". The server serves index.html for every unmatched path
  // (server/static.ts), so with a relative base a URL like /a/b resolves its
  // script to /a/assets/index-<hash>.js — which the SPA fallback answers with
  // index.html. The browser then fails to parse HTML as a module and the rep
  // gets a blank screen with no way out. Nothing here is served from a subpath,
  // so absolute URLs boot correctly at any depth.
  base: "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // ONE split, and only because it pays for itself across deploys: the
        // React runtime is ~47 KB of the entry's ~108 KB gzip and changes only
        // on a React upgrade, so parking it in its own chunk means a returning
        // rep re-downloads 47 KB less after each release. Vite emits a
        // modulepreload for it, so there is no waterfall.
        //
        // Deliberately NOT split: lucide-react (rollup already isolates the
        // shared icons into ~59 sub-2KB chunks; forcing one chunk would pull
        // all 82 KB into first paint) and @radix-ui (already correctly shared
        // between the pages that use it, and absent from the entry).
        manualChunks: (id: string) =>
          /node_modules\/(react|react-dom|scheduler|use-sync-external-store)\//.test(id)
            ? "vendor-react"
            : undefined,
      },
    },
    // Hardening: never ship source maps to production — they reverse the
    // minification/mangling and expose original source. Vite defaults to
    // false, but pin it explicitly so a future config tweak can't
    // silently re-enable it. (Minify defaults to esbuild, which also
    // mangles identifiers — accepted posture; no heavyweight obfuscator.)
    sourcemap: false,
    // Strip console.* and debugger from the production bundle. Two reasons, and
    // the second is the one that matters: console lines leak internal state and
    // field names into anyone's devtools, and they cost real time on a mid-range
    // Android during a knock burst.
    //
    // NOTE ON OBFUSCATION, deliberately not done here: esbuild already mangles
    // local identifiers, but no minifier hides CONSTANTS — the odds, ceilings
    // and caps stay readable as numbers whatever you rename around them. A
    // heavyweight obfuscator would add 15–80% runtime cost on phones that must
    // last a shift while leaving those same numbers legible. The effective fix
    // is to stop SENDING logic the client does not render; see the audit in the
    // PR that introduced this comment.
    minify: "esbuild",
  },
  esbuild: {
    drop: ["console", "debugger"],
    legalComments: "none",
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
