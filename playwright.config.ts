import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The dev server reads PORT (default 5000, but 5000 is taken by macOS
// ControlCenter) — pin E2E to 5050. Override with E2E_BASE_URL to point at an
// already-running instance.
const PORT = Number(process.env.E2E_PORT ?? 5050);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;
const MARKETING_PORT = Number(process.env.E2E_MARKETING_PORT ?? 5187);
const marketingURL = `http://127.0.0.1:${MARKETING_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // shares one SQLite DB — keep specs serial
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [{
        command: "npm run dev",
        env: {
          PORT: String(PORT),
          NODE_ENV: "development",
          APP_ORIGIN: baseURL,
          RESEND_DELIVERY_MODE: "log",
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      }, {
        command: `npm run dev -- --host 127.0.0.1 --port ${MARKETING_PORT}`,
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
        env: { VITE_ONBOARDING_API_URL: baseURL },
        url: marketingURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      }],
});
