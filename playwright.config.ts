import { defineConfig, devices } from "@playwright/test";

// Visual-regression smoke for the dashboard. Runs against an ALREADY-RUNNING server
// (start it with `pnpm build && PORT=3001 pnpm start` and seed the DB first).
// BASE_URL overrides the target; default matches the local dev/prod port used in docs.
export default defineConfig({
  testDir: "./tests/visual",
  snapshotDir: "./tests/visual/__snapshots__",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3001",
    // deterministic rendering
    colorScheme: "dark",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
  // small pixel tolerance for anti-aliasing across machines
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
