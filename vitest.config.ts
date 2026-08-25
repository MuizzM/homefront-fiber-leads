import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Unit + component tests only. Playwright E2E lives under tests/e2e and is run
// by `npm run test:e2e` (playwright.config.ts) — excluded here so Vitest never
// tries to execute .spec.ts specs meant for the browser runner.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    css: false,
    clearMocks: true,
    restoreMocks: true,
    // Nearly every integration test builds a real SQLite database in beforeAll:
    // fresh DATA_DIR, full forward-only migration chain, then seed. That
    // legitimately takes 5-19s per file on an unloaded machine, so Vitest's 10s
    // default fails those hooks the moment the runner is under load - observed
    // 2026-08-24 as 7 files timing out at load average 55, all of which pass in
    // isolation. This is calibration of a runner safety valve, NOT a relaxed
    // assertion: a hook that is genuinely hung still fails, just later.
    //
    // testTimeout is deliberately LEFT at the default. Test bodies assert real
    // budgets (e.g. kinetic-build-map-perf holds buildGrid under 400ms), and
    // widening those to accommodate a busy laptop would be weakening a gate.
    hookTimeout: 60_000,
  },
});
