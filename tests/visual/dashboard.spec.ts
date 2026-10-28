import { expect, test } from "@playwright/test";
import { enableVisualRegressionMode, openScreen } from "./helpers/screen-ready";

// Visual smoke for the core dashboard routes. Deterministic: we set data-vr="1" on <html> before
// each shot, which hides [data-volatile] elements (timestamps, "bugün" badges) via CSS in
// globals.css.
//
// FAZ 2 CHANGED TWO THINGS.
//
// 1. AUTH IS REAL. This file used to `goto -> expect 200 -> screenshot` with no session at all,
//    which only "worked" behind MAS_QA_BYPASS_AUTH — and that bypass redirect-loops against the
//    cookie-only middleware (see tests/visual/global-setup.ts for the full mechanism). The suite
//    now carries a genuine session cookie minted through the real /login form.
//
// 2. FOUR OF THESE PATHS ARE 301s AND THE OLD LIST DID NOT SAY SO. next.config.ts permanently
//    redirects /radar -> /payments, /financing -> /finance, /reports -> /insights/reports and
//    /reminders -> /insights/reminders. The old spec still requested the legacy paths and named
//    the screenshots after them, so `radar.png` was in fact a picture of /payments and nobody
//    could tell from the file name. `expected` now states the destination, so a redirect that was
//    NOT planned still fails while the four that were planned pass honestly.
//
// The snapshot names are deliberately left on their historical spellings so the committed
// baselines stay addressable; the `expected` column is the thing that carries the truth.
const ROUTES: Array<{ path: string; expected: string; name: string }> = [
  { path: "/", expected: "/", name: "home" },
  { path: "/radar", expected: "/payments", name: "radar" },
  { path: "/cashflow", expected: "/cashflow", name: "cashflow" },
  { path: "/financing", expected: "/finance", name: "financing" },
  { path: "/reports", expected: "/insights/reports", name: "reports" },
  { path: "/reminders", expected: "/insights/reminders", name: "reminders" },
  { path: "/production", expected: "/production", name: "production" },
  { path: "/scenarios", expected: "/scenarios", name: "scenarios" },
];

for (const r of ROUTES) {
  test(`visual: ${r.name}`, async ({ page }) => {
    await enableVisualRegressionMode(page);

    // auth -> route -> heading -> content -> no error. Only then are pixels worth comparing.
    await openScreen(page, r.path, r.expected);

    // let the entrance animation settle (it's near-instant, but be safe)
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`${r.name}.png`, { fullPage: true });
  });
}
