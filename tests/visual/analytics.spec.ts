import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial", timeout: 90_000 });

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
      await page.addInitScript(() => document.documentElement.setAttribute("data-vr", "1"));
      const response = await page.goto(route.path, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: /grafik/i }).or(page.locator("svg").first())).toBeVisible();
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
      await expect(page).toHaveScreenshot(`${route.name}-${viewport.name}.png`, { fullPage: true, animations: "disabled", timeout: 15_000 });
    });
  }
}
