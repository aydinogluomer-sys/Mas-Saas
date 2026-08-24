import { expect, test } from "@playwright/test";
import { assertScreenReady, enableVisualRegressionMode, watchScreen } from "./helpers/screen-ready";

// The instant-navigation skeleton, at three viewports.
//
// This one reaches its subject by CLICKING rather than by navigating, so it uses the split form of
// the helper: watchScreen() before the first load, assertScreenReady() once /overview is up, and
// only then the deliberately-slowed click that puts the skeleton on screen. Faz 2's contribution is
// the same as everywhere else — the screenshot is no longer the first thing that would notice the
// session had died.
const viewports = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
] as const;

for (const viewport of viewports) {
  test(`instant navigation skeleton ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await enableVisualRegressionMode(page);

    const watch = watchScreen(page);
    // Prefetch refused for the same reason as navigation-performance.spec.ts: if Next's prefetch
    // lands before the click, the navigation resolves from cache, no skeleton is due, and this test
    // would fail the product for being fast. This one happened to pass, but the race is identical.
    await page.route(/\/cashflow(?:\?.*)?$/, async (route) => {
      if (route.request().headers()["next-router-prefetch"] === "1") {
        // Held open rather than aborted — an aborted prefetch logs "Failed to fetch" and the §5.3
        // gate fails the page for it.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      if (route.request().headers().rsc === "1") await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });

    await page.goto("/overview", { waitUntil: "domcontentloaded" });
    await assertScreenReady(page, { expected: "/overview", watch });

    await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");
    await page.locator('.sidebar-link[href="/cashflow"]').dispatchEvent("click");
    const shell = page.locator(".instant-navigation-skeleton");
    await expect(shell).toBeVisible({ timeout: 200 });
    const shellLeft = await shell.evaluate((element) => Number.parseFloat(getComputedStyle(element).left));
    expect(shellLeft).toBe(viewport.width >= 1024 ? 255 : 0);
    await expect(page.locator(".navigation-progress")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect(page).toHaveScreenshot(`instant-navigation-${viewport.name}.png`, { animations: "disabled" });
  });
}
