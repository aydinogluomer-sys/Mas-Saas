import { test, expect } from "@playwright/test";

// Visual smoke for the 7 core dashboard routes. Deterministic: we set data-vr="1" on
// <html> before each shot, which hides [data-volatile] elements (timestamps, "bugün"
// badges) via CSS in globals.css. Seed the DB with a stable domain first.
const ROUTES: Array<{ path: string; name: string }> = [
  { path: "/radar", name: "radar" },
  { path: "/cashflow", name: "cashflow" },
  { path: "/financing", name: "financing" },
  { path: "/reports", name: "reports" },
  { path: "/reminders", name: "reminders" },
  { path: "/production", name: "production" },
  { path: "/scenarios", name: "scenarios" },
];

for (const r of ROUTES) {
  test(`visual: ${r.name}`, async ({ page }) => {
    await page.addInitScript(() => document.documentElement.setAttribute("data-vr", "1"));
    const res = await page.goto(r.path, { waitUntil: "networkidle" });
    expect(res?.status(), `${r.path} should be 200`).toBe(200);
    // let the entrance animation settle (it's near-instant, but be safe)
    await page.waitForTimeout(400);
    await expect(page).toHaveScreenshot(`${r.name}.png`, { fullPage: true });
  });
}
