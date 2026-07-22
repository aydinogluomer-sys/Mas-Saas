import { expect, test } from "@playwright/test";

const viewports = [
  { name: "desktop", width: 1366, height: 900 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "mobile", width: 375, height: 812 },
] as const;

for (const viewport of viewports) {
  test(`instant navigation skeleton ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => document.documentElement.setAttribute("data-vr", "1"));
    await page.route(/\/cashflow(?:\?.*)?$/, async (route) => {
      if (route.request().headers().rsc === "1") await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.goto("/overview", { waitUntil: "domcontentloaded" });
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
