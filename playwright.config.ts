import { defineConfig, devices } from "@playwright/test";

// The dev server reads PORT (default 5000, but 5000 is taken by macOS
// ControlCenter) — pin E2E to 5050. Override with E2E_BASE_URL to point at an
// already-running instance.
const PORT = Number(process.env.E2E_PORT ?? 5050);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

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
    : {
        command: "npm run dev",
        env: { PORT: String(PORT), NODE_ENV: "development" },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
