import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

// Visual + E2E harness. Runs against an ALREADY-RUNNING production server:
//
//   pnpm build
//   DATABASE_URL=…/<disposable-db> PORT=3210 pnpm start      (NO MAS_QA_BYPASS_AUTH)
//   BASE_URL=http://127.0.0.1:3210 MAS_E2E_DATABASE_URL=…/<disposable-db> pnpm test:visual
//
// Faz 2 changed two things here.
//
// 1. THE PORT LIVES IN EXACTLY ONE PLACE. It used to be written into the specs as well —
//    payment-iteration-15.spec.ts hard-coded http://127.0.0.1:3110 and ignored BASE_URL entirely,
//    and navigation-performance.spec.ts carried its own `?? "http://127.0.0.1:3110"` fallback. So
//    "point the suite at a different server" silently moved only some of it, and two specs went on
//    talking to whatever happened to be listening on 3110 — or to nothing. The fallback below is
//    now the ONLY default in the repository; `grep -R "127.0.0.1:31" tests/visual` returns nothing.
//
// 2. AUTH IS REAL. globalSetup logs five accounts in through the real /login form and writes one
//    storageState per role. The default context below carries the admin jar, so a legacy spec that
//    just calls page.goto() is authenticated the way a human is — no QA bypass, no redirect loop.
//    Specs that need a specific tier import statePathFor() from ./tests/visual/global-setup.
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3210";

export default defineConfig({
  testDir: "./tests/visual",
  snapshotDir: "./tests/visual/__snapshots__",
  globalSetup: "./tests/visual/global-setup.ts",
  // Was `true`. navigation-performance.spec.ts asserts that a sidebar click is acknowledged within
  // 50ms and that a delayed route shows its skeleton within 200ms; navigation-visual.spec.ts waits
  // on a progress bar that exists only while a navigation is in flight. Those numbers are only
  // meaningful on an uncontended machine.
  //
  // `fullyParallel: false` ALONE IS NOT ENOUGH, and this was measured rather than assumed. It only
  // serialises tests WITHIN a file; separate files still run concurrently across workers (default
  // = half the CPUs). Run one spec at a time everything passed; run all five together and three
  // timing assertions failed — ".navigation-progress" hidden, "Route skeleton did not appear within
  // 200ms" — while the screenshot failures stayed identical. That is the scheduler being measured,
  // not the product. `workers: 1` makes the whole suite genuinely sequential.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    storageState: path.join("tests", "visual", ".auth", "admin.json"),
    // deterministic rendering
    colorScheme: "dark",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
  // small pixel tolerance for anti-aliasing across machines
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: "disabled" } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
