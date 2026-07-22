import { expect, test } from "@playwright/test";

const baseURL = "http://127.0.0.1:3110";

test.describe("Ödemeler Iteration 15", () => {
  test("özet, dönem ufukları ve dışa aktarma", async ({ page }) => {
    await page.goto(`${baseURL}/payments`);
    await expect(page.getByRole("heading", { name: "Ödemeler" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ödeme ekle" }).first()).toHaveAttribute("href", "/payments/new");
    await expect(page.getByText("Bugün").first()).toBeVisible();
    await expect(page.getByText("Yarın").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Excel" })).toBeVisible();

    for (const period of ["3A", "6A", "12A", "24A", "Tümü"]) {
      await page.getByRole("link", { name: period, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`period=${period === "Tümü" ? "all" : period.toLowerCase()}`));
    }

    await expect(page.getByText("4–6 ay")).toBeVisible();
    await expect(page.getByText("7–12 ay")).toBeVisible();
    await expect(page.getByText("13–24 ay")).toBeVisible();
  });

  test("takvim sınırsız tarih ve yaşlandırma detayı", async ({ page }) => {
    await page.goto(`${baseURL}/payments/calendar?ym=2034-05`);
    await expect(page.getByText(/Mayıs 2034/i)).toBeVisible();
    await expect(page.locator('input[type="month"]')).not.toHaveAttribute("max");
    await page.goto(`${baseURL}/payments/calendar?age=91-plus`);
    await expect(page.getByText(/91\+ gün/i).first()).toBeVisible();
  });

  test("geçmiş durum sekmeleri ve bağlamsal boş durum", async ({ page }) => {
    for (const status of ["paid", "partial", "reopened", "cancelled"]) {
      await page.goto(`${baseURL}/payments/history?status=${status}`);
      await expect(page.locator(`a[href="/payments/history?status=${status}"]`)).toHaveAttribute("aria-current", "page");
    }
    await page.goto(`${baseURL}/payments/history?status=paid&from=2099-01-01&to=2099-01-31`);
    await expect(page.getByText(/seçtiğiniz tarih aralığında/i)).toBeVisible();
  });

  test("ödeme arşivi bağımsız açılır", async ({ page }) => {
    await page.goto(`${baseURL}/payments/archive`);
    await expect(page.getByRole("heading", { name: "Ödeme Arşivi" })).toBeVisible();
    await expect(page.getByText(/arşivlenmiş ödeme/i).first()).toBeVisible();
  });

  for (const width of [390, 1024, 1440, 1920]) {
    test(`${width}px görünümde yatay taşma yok`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`${baseURL}/payments`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(2);
    });
  }
});
