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
      "@assets": path.resolve(__dirname, "attached_assets"),
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
  },
});
