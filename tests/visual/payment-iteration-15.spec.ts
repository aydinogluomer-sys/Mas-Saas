import { expect, test } from "@playwright/test";

// Faz 2 §5.2 — this file used to open with its own `const baseURL = ...` naming a loopback host
// and port 3110 literally. It ignored BASE_URL entirely, so pointing the suite at another server
// moved every other spec and left this one talking to whatever was (or was not) listening on that
// port. Every goto below is now a RELATIVE path, resolved against the single baseURL in
// playwright.config.ts. The literal is not repeated here on purpose: the §5.2 gate greps this
// directory for it, and a comment that quotes it would defeat the gate it documents.
//
// This file takes no screenshots, so §5.3's ordering does not apply to it; its assertions are
// already semantic throughout. What it did lack was a session — it now inherits the real admin
// storageState from the config, like every other spec.
//
// FOUR ASSERTIONS HERE ASSERTED THINGS THE PRODUCT HAS NEVER DONE. Once real auth was in place the
// pages loaded fine and four checks still failed. Each was investigated against the running server
// and the git history, and in every case the SPEC was wrong — not the product:
//
//   `age=91-plus`            the page's bucket keys are "1-30" | "31-90" | "91+"
//                            (src/app/(dashboard)/calendar/page.tsx). Requested with the correct
//                            value the page renders "91+ gün gecikmiş"; `git log -S "91-plus" src/`
//                            is EMPTY — that spelling never existed in the application.
//   /arşivlenmiş ödeme/      the archive panel says "1 ARŞİVLENMİŞ KALEM". `git log -S
//                            "arşivlenmiş ödeme" src/` is likewise EMPTY.
//   getByText("Yarın").first()
//                            three nodes contain "Yarın" and the FIRST is hidden, so `.first()`
//                            selected an invisible element and asserted it was visible.
//   a[href="…status=paid"]   two links share that href: the nav tab and the filter panel's
//                            "Temizle" link. Strict mode refuses the ambiguity, correctly.
//
// So this spec was never green; it is harness debt, not a regression. The assertions below now
// state the real contract. Nothing was weakened to obtain a pass — the aging bucket, the archive
// count, the KPI label and the active-tab marker are all still genuinely asserted.

test.describe("Ödemeler Iteration 15", () => {
  test("özet, dönem ufukları ve dışa aktarma", async ({ page }) => {
    await page.goto(`/payments`);
    // exact:true — the `name` option matches by SUBSTRING by default, and "Ödemeler" is a prefix of
    // other headings on this page, so the unqualified locator resolved to two elements and strict
    // mode refused it (correctly).
    await expect(page.getByRole("heading", { name: "Ödemeler", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ödeme ekle" }).first()).toHaveAttribute("href", "/payments/new");
    // filter({visible:true}) rather than .first(): the first "Bugün"/"Yarın" node in DOM order is
    // hidden at this viewport, and asserting visibility on a deliberately hidden element can only fail.
    await expect(page.getByText("Bugün").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText("Yarın").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Excel" })).toBeVisible();

    // The "3A / 6A / 12A / 24A / Tümü" link loop that used to sit here is gone. It clicked links
    // that do not exist: `a[href*="period="]` matches NOTHING on this page, and
    // `git log -S 'period=' -- src/app` is EMPTY across the whole history — the query-param period
    // selector was never in the application. The horizon breakdown it was reaching for is real and
    // is asserted below, so removing the loop drops a phantom, not coverage.

    await expect(page.getByText("4–6 ay")).toBeVisible();
    await expect(page.getByText("7–12 ay")).toBeVisible();
    await expect(page.getByText("13–24 ay")).toBeVisible();
  });

  test("takvim sınırsız tarih ve yaşlandırma detayı", async ({ page }) => {
    await page.goto(`/payments/calendar?ym=2034-05`);
    await expect(page.getByText(/Mayıs 2034/i)).toBeVisible();
    await expect(page.locator('input[type="month"]')).not.toHaveAttribute("max");
    // %2B, not "-plus" and not a bare "+" (which a query string decodes as a space).
    await page.goto(`/payments/calendar?age=91%2B`);
    await expect(page.getByText(/91\+ gün/i).first()).toBeVisible();
  });

  test("geçmiş durum sekmeleri ve bağlamsal boş durum", async ({ page }) => {
    for (const status of ["paid", "partial", "reopened", "cancelled"]) {
      await page.goto(`/payments/history?status=${status}`);
      // Scoped to the tab that is actually marked current. The filter panel's "Temizle" link
      // carries the same href by design, so the unscoped locator matched two elements.
      await expect(page.locator(`a[href="/payments/history?status=${status}"][aria-current="page"]`)).toHaveCount(1);
    }
    await page.goto(`/payments/history?status=paid&from=2099-01-01&to=2099-01-31`);
    // Reworded since the spec was written: the live string is "Seçtiğiniz ödeme adı ve tarih
    // aralığında ödeme hareketi bulunamadı." The old regex assumed the two clauses were adjacent.
    await expect(page.getByText(/seçtiğiniz ödeme adı ve tarih aralığında/i)).toBeVisible();
  });

  test("ödeme arşivi bağımsız açılır", async ({ page }) => {
    await page.goto(`/payments/archive`);

    // The page's own <h1>Ödeme Arşivi</h1> is rendered but DELIBERATELY NOT VISIBLE, and that is
    // the product being right. globals.css:417 — `.module-content > header:first-child { display:
    // none }` — hides a page-level PageHeader inside a ModuleFrame, because the frame already
    // shows the module title and tab strip; showing both would print two competing headings.
    //
    // The chronology settles the classification. This spec landed in 8f068b1 (2026-07-22 19:23) and
    // the nine-module restructure 5deed68 introduced ModuleFrame and that CSS rule at 19:24 — one
    // minute later. So the assertion was correct when written and was invalidated by an INTENTIONAL
    // information-architecture change that nobody came back to update. Not a regression.
    //
    // Asserted accordingly: the heading still EXISTS (it carries the document's semantics for
    // assistive tech), the visible heading is the module frame's, and the archive's own content is
    // on screen. Hiding is checked explicitly so that un-hiding it would be caught too.
    const pageHeading = page.locator('h1:text-is("Ödeme Arşivi")');
    await expect(pageHeading).toBeAttached();
    await expect(pageHeading).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Ödemeler", exact: true })).toBeVisible();
    await expect(page.getByText(/arşivlenmiş kalem/i).first()).toBeVisible();
  });

  for (const width of [390, 1024, 1440, 1920]) {
    test(`${width}px görünümde yatay taşma yok`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`/payments`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(2);
    });
  }
});
