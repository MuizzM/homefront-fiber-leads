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
  base: "./",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    // Hardening: never ship source maps to production — they reverse the
    // minification/mangling and expose original source. Vite defaults to
    // false, but pin it explicitly so a future config tweak can't
    // silently re-enable it. (Minify defaults to esbuild, which also
    // mangles identifiers — accepted posture; no heavyweight obfuscator.)
    sourcemap: false,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
