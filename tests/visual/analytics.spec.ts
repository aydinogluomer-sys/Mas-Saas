import { expect, test } from "@playwright/test";
import { enableVisualRegressionMode, openScreen } from "./helpers/screen-ready";

// Analytics/chart screens at two viewports.
//
// This file already had SOME semantic assertions before its screenshot (a heading-or-svg check and
// a horizontal-overflow check), which is more than dashboard.spec.ts had. Faz 2 keeps both and puts
// the standard auth/route/content/error gate in front of them, so the ordering §5.3 requires holds
// here too: a chart that renders because the session died and we are looking at /login can no
// longer reach the screenshot step.
// `mode: "serial"` removed, timeout kept. These twelve cases share no state — different routes,
// different viewports, no ordering between them — but serial mode makes the FIRST failure skip the
// other eleven ("11 did not run"). For a suite whose job is to tell you which screens are healthy,
// hiding eleven answers because the first one drifted is the opposite of useful. Execution is still
// sequential: playwright.config.ts sets fullyParallel: false.
test.describe.configure({ timeout: 90_000 });

const routes = [
  { path: "/cashflow", name: "cashflow-analytics" },
  { path: "/cashflow/monthly", name: "cashflow-monthly-analytics" },
  { path: "/payments", name: "payments-analytics" },
  { path: "/finance", name: "finance-analytics" },
  { path: "/production/capacity", name: "capacity-analytics" },
  { path: "/production/profitability", name: "profitability-analytics" },
] as const;

for (const viewport of [{ width: 1440, height: 900, name: "desktop" }, { width: 390, height: 844, name: "mobile" }]) {
  for (const route of routes) {
    test(`${route.name} ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await enableVisualRegressionMode(page);

      // None of these paths is a redirect, so expected === path.
      await openScreen(page, route.path, route.path);

      await expect(page.getByRole("heading", { name: /grafik/i }).or(page.locator("svg").first())).toBeVisible();
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
      await expect(page).toHaveScreenshot(`${route.name}-${viewport.name}.png`, { fullPage: true, animations: "disabled", timeout: 15_000 });
    });
  }
}
