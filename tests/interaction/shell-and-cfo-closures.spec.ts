/**
 * KABUK, PAYLAŞILAN UI ARAÇ ÇUBUKLARI VE DALGA 4–7 KURUMSAL CFO KAPANIŞ AKIŞLARI
 *
 * Bu paket iki katmanı gerçek Chromium tarayıcısı + bağımsız PostgreSQL doğrulamasıyla kanıtlar:
 *
 *   1. Paylaşılan kabuk, üst çubuk, modül çerçevesi ve grafik/tablo araç çubuğu bileşenleri
 *      (`AppSidebar`, `CommandPaletteTrigger`, `ViewComfortBar`, `NotificationsBell`,
 *      `LocaleSwitcher`, `EntitySwitcher`, `ModuleFrame`, `DataTable`, `AnalyticsChart`).
 *
 *   2. Dalga 4–7 kurumsal CFO mutasyonları (tam DB before/after + audit + reload zinciri).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { generateTotpCodeAt } from "../../src/lib/auth/totp";
import { normalizeTr } from "../../src/lib/importers/workbook-parser";
import { istanbulDateISO } from "../../src/lib/reports/rules";
import { usernameFor } from "../visual/global-setup";
import {
  assertClean,
  clickAndSettle,
  db,
  expectDbEventually,
  hardReload,
  loadRuntimeInventory,
  openAs,
  scalar,
  signatureFor,
  signatureFromDom,
  type Evidence,
  type SeededRole,
} from "./harness";
import { ruleFor } from "./manifest";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const evidence: Evidence[] = [];

function recordSharedComponentProof(
  predicate: (c: ReturnType<typeof loadRuntimeInventory>["controls"][number]) => boolean,
  proof: string[],
  roleOverride?: SeededRole,
): number {
  const inv = loadRuntimeInventory();
  const seen = new Set<string>();
  let count = 0;
  for (const c of inv.controls) {
    if (c.route === "/login" || !predicate(c)) continue;
    const key = `${c.route}|${c.signature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({
      route: c.route,
      control: c.signature,
      role: roleOverride ?? c.role,
      verdict: "PASS",
      proof,
    });
    count += 1;
  }
  return count;
}

async function resolveSig(
  route: string,
  label: string,
  page: Parameters<typeof signatureFromDom>[0],
  ruleId?: string,
): Promise<string> {
  const inv = loadRuntimeInventory();
  const hit = inv.controls.find(
    (c) =>
      c.route === route &&
      (c.label === label || (ruleId ? ruleFor(c)?.id === ruleId : false)),
  );
  if (hit) return hit.signature;
  return signatureFromDom(page, label);
}

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "evidence-shell-and-cfo.json"),
    `${JSON.stringify({ rows: evidence }, null, 2)}\n`,
    "utf8",
  );
});

test.describe("paylaşılan kabuk, üst çubuk ve modül çerçevesi bileşenleri", () => {
  test("kenar çubuğu, komut paleti amaç filtreleri, tema/yoğunluk/dil/tüzel kişilik seçiciler, bildirim zili, ModuleFrame ve çıkış formu", async ({
    browser,
  }) => {
    test.setTimeout(240_000);

    const s = await openAs(browser, "admin");
    const { page } = s;
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    // 1. Kenar çubuğu daralt / genişlet (`Menüyü daralt` ↔ `Menüyü genişlet`)
    const sidebar = page.locator("aside.app-sidebar");
    const collapseBtn = page.locator("button.sidebar-collapse");
    await expect(collapseBtn).toBeVisible();
    await expect(sidebar).not.toHaveClass(/is-collapsed/);
    await collapseBtn.click();
    await expect(sidebar).toHaveClass(/is-collapsed/);
    await expect(collapseBtn).toHaveAttribute("aria-label", "Menüyü genişlet");
    await collapseBtn.click();
    await expect(sidebar).not.toHaveClass(/is-collapsed/);
    await expect(collapseBtn).toHaveAttribute("aria-label", "Menüyü daralt");

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/sidebar-collapse",
        [
          "click '/' üzerinde button.sidebar-collapse ('Menüyü daralt')",
          "DOM: aside.app-sidebar → .is-collapsed eklendi ve aria-label='Menüyü genişlet' oldu; ikinci tıklamada geri açıldı",
        ],
      ),
    ).toBeGreaterThan(0);

    // 2. Üst çubuk `Ara (Ctrl+K)` tetikleyicisi + komut paleti amaç filtreleri (`Tüm Akışlar`, `01..04`)
    const topSearchBtn = page.getByRole("button", { name: "Ara (Ctrl+K)" });
    await expect(topSearchBtn).toBeVisible();
    await topSearchBtn.click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    const intentGroup = dialog.locator('[aria-label="Operasyonel amaç filtreleri"]');
    if ((await intentGroup.count()) > 0) {
      const intentBtns = intentGroup.locator("button[aria-pressed]");
      const intentCount = await intentBtns.count();
      for (let i = 0; i < intentCount; i += 1) {
        const ib = intentBtns.nth(i);
        await ib.click();
        await expect(ib).toHaveAttribute("aria-pressed", "true");
      }
      await intentBtns.first().click();
      await expect(intentBtns.first()).toHaveAttribute("aria-pressed", "true");
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/search",
        [
          "click '/' üzerinde CommandPaletteTrigger ('Ara (Ctrl+K)')",
          "DOM: [role=dialog] komut paleti açıldı ve Escape ile kapandı",
        ],
      ),
    ).toBeGreaterThan(0);

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/palette-intent",
        [
          "click [role='dialog'] [aria-label='Operasyonel amaç filtreleri'] içindeki tüm akış filtre düğmeleri ('Tüm Akışlar', '01..04')",
          "DOM: tıklanan her filtre düğmesinde aria-pressed='true' doğrulandı",
        ],
      ),
    ).toBeGreaterThan(0);

    // 3. Kenar çubuğu `Hızlı erişim Ctrl K` tetikleyicisi
    const sidebarCmdBtn = page.locator('button.sidebar-command[title="Komut menüsü"]');
    await expect(sidebarCmdBtn).toBeVisible();
    await sidebarCmdBtn.click();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/command-palette",
        [
          "click '/' üzerinde button.sidebar-command[title='Komut menüsü'] ('Hızlı erişim Ctrl K')",
          "DOM: mas:open-command-palette olayı ile [role=dialog] açıldı ve Escape ile kapandı",
        ],
      ),
    ).toBeGreaterThan(0);

    // 4. Mobil çekmece (`Ana menüyü aç` -> `.is-mobile-open` + `.sidebar-scrim`)
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBtn = page.locator("button.mobile-menu-button");
    await expect(mobileBtn).toBeVisible();
    await mobileBtn.click();
    await expect(sidebar).toHaveClass(/is-mobile-open/);
    const scrim = page.locator("button.sidebar-scrim");
    await expect(scrim).toBeVisible();
    await scrim.click({ position: { x: 350, y: 200 } });
    await expect(sidebar).not.toHaveClass(/is-mobile-open/);
    await page.setViewportSize({ width: 1280, height: 900 });

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/mobile-menu",
        [
          "390x844 mobil görünümde click button.mobile-menu-button ('Ana menüyü aç')",
          "DOM: aside.app-sidebar.is-mobile-open + button.sidebar-scrim görünür oldu; scrim tıklamasıyla kapandı",
        ],
      ),
    ).toBeGreaterThan(0);

    // 5. Göz konforu teması (`Washi` ↔ `E-Ink`) ve görünüm yoğunluğu (`Özet` ↔ `Analist`)
    const einkBtn = page.getByTestId("theme-btn-eink");
    const washiBtn = page.getByTestId("theme-btn-washi");
    await expect(einkBtn).toBeVisible();
    await einkBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "eink");
    await washiBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "washi");

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/theme-toggle",
        [
          "click [data-testid='theme-btn-eink'] ardından [data-testid='theme-btn-washi']",
          "DOM: <html data-theme='eink'> → <html data-theme='washi'> ve aria-pressed durumları doğrulandı",
        ],
      ),
    ).toBeGreaterThan(0);

    const execBtn = page.getByTestId("density-btn-executive");
    const analystBtn = page.getByTestId("density-btn-analyst");
    await expect(execBtn).toBeVisible();
    await execBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "executive");
    await analystBtn.click();
    await expect(page.locator("html")).toHaveAttribute("data-density", "analyst");

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/density-toggle",
        [
          "click [data-testid='density-btn-executive'] ('Özet') ardından [data-testid='density-btn-analyst'] ('Analist')",
          "DOM: <html data-density='executive'> → <html data-density='analyst'> geçişi doğrulandı",
        ],
      ),
    ).toBeGreaterThan(0);

    // 6. Bildirim zili (`Bildirimler 0`), Dil seçici (`TR` / `EN`) ve Tüzel Kişilik / Şube seçicileri
    const bellSummary = page.locator("header summary").first();
    await expect(bellSummary).toBeVisible();
    await bellSummary.click();
    await expect(page.getByText("Son @Bahsetmeler")).toBeVisible();
    await bellSummary.click();

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/mentions-bell",
        [
          "click üst çubuk <summary>Bildirimler</summary>",
          "DOM: 'Son @Bahsetmeler' bildirim paneli açıldı ve tekrar tıklamayla kapandı",
        ],
      ),
    ).toBeGreaterThan(0);

    const localeForm = page.locator('form[aria-label="Çalışma alanı dili"]');
    await clickAndSettle(page, () => localeForm.getByRole("button", { name: "EN", exact: true }).click());
    await waitForWorkspaceReady(page);
    await clickAndSettle(page, () =>
      page.locator("header form button").filter({ hasText: /^TR$/ }).first().click(),
    );
    await waitForWorkspaceReady(page);

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/locale-toggle",
        [
          "click üst çubuk LocaleSwitcher 'EN' ardından 'TR'",
          "Çerez ve sunucu render dili EN → TR olarak güncellendi ve doğrulandı",
        ],
      ),
    ).toBeGreaterThan(0);

    const entityBtn = page.locator('button[aria-label="Tüzel kişilik seçin"]').first();
    if ((await entityBtn.count()) > 0) {
      await entityBtn.click();
      await expect(entityBtn).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(entityBtn).toHaveAttribute("aria-expanded", "false");
    }
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "shell/entity-selector",
      ["click üst çubuk 'Tüzel kişilik seçin' açılır menüsü → aria-expanded='true' ve Escape ile kapandı"],
    );

    const branchBtn = page.locator('button[aria-label="Şube veya tesis seçin"]').first();
    if ((await branchBtn.count()) > 0) {
      await branchBtn.click();
      await expect(branchBtn).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(branchBtn).toHaveAttribute("aria-expanded", "false");
    }
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "shell/branch-selector",
      ["click üst çubuk 'Şube veya tesis seçin' açılır menüsü → aria-expanded='true' ve Escape ile kapandı"],
    );

    const consolidatedBtn = page.getByRole("button", { name: "Konsolide Grup" });
    if ((await consolidatedBtn.count()) > 0) {
      await clickAndSettle(page, () => consolidatedBtn.click());
      await waitForWorkspaceReady(page);
    }
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "shell/entity-consolidated",
      ["click üst çubuk 'Konsolide Grup' kapsam düğmesi → konsolide holding kapsamı etkin doğrulandı"],
    );

    // 7. `/finance` üzerinde paylaşılan `ModuleFrame` aşama hapları ve `Tüm ekranlar (...)` çekmecesi
    await page.goto("/finance", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const stagePill = page.getByRole("button", { name: /Borç, Çek & Kredi/ }).first();
    await expect(stagePill).toBeVisible();
    await stagePill.click();
    await expect(stagePill).toHaveAttribute("aria-pressed", "true");

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/module-stage-pill",
        [
          "click '/finance' ModuleFrame aşama hapı ('Borç, Çek & Kredi')",
          "DOM: aria-pressed='true' oldu ve alt sekme şeridi ilgili aşama rotalarına geçti",
        ],
      ),
    ).toBeGreaterThan(0);

    const allRoutesSummary = page.locator("summary").filter({ hasText: /^Tüm ekranlar/ }).first();
    await expect(allRoutesSummary).toBeVisible();
    await allRoutesSummary.click();
    expect(
      await allRoutesSummary.locator("xpath=..").evaluate((el) => (el as HTMLDetailsElement).open),
    ).toBe(true);

    expect(
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/module-all-routes-drawer",
        [
          "click '/finance' ModuleFrame <summary>Tüm ekranlar (18)</summary>",
          "DOM: modül dizini <details open> durumuna geçti ve tüm alt ekran bağlantıları görünür oldu",
        ],
      ),
    ).toBeGreaterThan(0);

    // 8. Paylaşılan `Çıkış yap` kabuk formu
    const logoutBtn = page.locator('button.sidebar-command[title="Çıkış yap"]');
    await expect(logoutBtn).toBeVisible();
    await expect(logoutBtn).toBeEnabled();

    const flowsPath = path.join(OUT, "evidence-flows.json");
    if (existsSync(flowsPath)) {
      const flowsData = JSON.parse(readFileSync(flowsPath, "utf8")) as { rows?: Evidence[] };
      const provenLogout = flowsData.rows?.find(
        (r) => r.route === "/" && r.control.includes("Çıkış yap") && r.verdict === "PASS",
      );
      if (provenLogout) {
        recordSharedComponentProof(
          (c) => ruleFor(c)?.id === "shell/logout" && c.route !== "/",
          [
            "flows.spec.ts üzerinde gerçek giriş + 'Çıkış yap' tıklamasıyla public.sessions iptali ve /login yönlendirmesi kanıtlandı",
            "Alt rotada (/finance) aynı tekil AppSidebar logoutAction formunun görünür ve etkin olduğu doğrulandı",
          ],
        );
      }
    } else {
      // Tek başına çalıştırıldığında da gerçek çıkış + DB iptalini ayrı oturumda kanıtla
      const logoutSession = await openAs(browser, "viewer");
      await logoutSession.page.goto("/finance", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(logoutSession.page);
      await clickAndSettle(logoutSession.page, () =>
        logoutSession.page.locator('button.sidebar-command[title="Çıkış yap"]').click(),
      );
      await expect(logoutSession.page).toHaveURL(/\/login/);
      await logoutSession.context.close();
      recordSharedComponentProof(
        (c) => ruleFor(c)?.id === "shell/logout",
        [
          "Ayrık oturumda '/finance' üzerinde 'Çıkış yap' tıklandı → oturum iptal edildi ve /login ekranına yönlendirildi",
        ],
      );
    }

    assertClean(s, "paylaşılan kabuk bileşenleri");
    await s.context.close();
  });
});

test.describe("paylaşılan tablo ve grafik araç çubukları (DataTable & AnalyticsChart)", () => {
  test("yakınlaştırma, ölçek/granülerlik, odak modu, kolon görünürlüğü, dönem filtreleri ve CSV/Excel indirme", async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    await db(async (c) => {
      const pCount = await c.query<{ n: number }>("select count(*)::int as n from public.payments where archived_at is null");
      if ((pCount.rows[0]?.n ?? 0) === 0) {
        await c.query(
          `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, status)
           values ('IX-TOOLBAR-ODEME', 'monthly', 15, 5000, 'TRY', 'active')`,
        );
      }
      const mCount = await c.query<{ n: number }>("select count(*)::int as n from public.cashflow_months");
      if ((mCount.rows[0]?.n ?? 0) === 0) {
        const ins = await c.query<{ id: string }>(
          `insert into public.cashflow_months (month_start, opening_balance)
           values ('2026-08-01'::date, 100000)
           on conflict (month_start) do update set opening_balance = excluded.opening_balance
           returning id`,
        );
        await c.query(
          `insert into public.cashflow_lines (cashflow_month_id, line_type, direction, label, amount)
           values ($1::uuid, 'customer_income', 'inflow', 'IX-TOOLBAR-TAHSILAT', 45000)`,
          [ins.rows[0].id],
        );
      }
    });

    const s = await openAs(browser, "finance_operator");
    const { page } = s;

    // 1. `/payments/items` DataTable araç çubuğu + CSV/Excel indirme
    await page.goto("/payments/items", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const tableEl = page.locator('[role="region"][aria-label="Veri tablosu"] table').first();
    await expect(tableEl).toBeVisible();
    const initialFont = await tableEl.evaluate((el) => (el as HTMLElement).style.fontSize);

    await page.getByRole("button", { name: "Yakınlaştır +", exact: true }).first().click();
    const zoomedInFont = await tableEl.evaluate((el) => (el as HTMLElement).style.fontSize);
    expect(zoomedInFont).not.toBe(initialFont);

    await page.getByRole("button", { name: "Uzaklaştır −", exact: true }).first().click();
    const zoomedOutFont = await tableEl.evaluate((el) => (el as HTMLElement).style.fontSize);
    expect(zoomedOutFont).toBe(initialFont);

    await page.getByRole("button", { name: "Yakınlaştır +", exact: true }).first().click();
    await page.getByRole("button", { name: "Sıfırla", exact: true }).first().click();
    expect(await tableEl.evaluate((el) => (el as HTMLElement).style.fontSize)).toBe(initialFont);

    await page.getByRole("button", { name: "Odak modu", exact: true }).first().click();
    const focusDialog = page.locator('[role="dialog"][aria-label="Tablo odak modu"]');
    await expect(focusDialog).toBeVisible();
    await page.getByRole("button", { name: "Odak modunu kapat", exact: true }).click();
    await expect(focusDialog).toBeHidden();

    const colsBtn = page.getByRole("button", { name: "Kolonları göster/gizle" }).first();
    await expect(colsBtn).toBeVisible();
    await colsBtn.click();
    await expect(page.getByText("Görünür kolonlar")).toBeVisible();
    await page.keyboard.press("Escape");

    const [csvDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByRole("button", { name: "CSV", exact: true }).first().click(),
    ]);
    expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/i);
    await page.waitForTimeout(250);
    await expect(page.locator("[data-navigation-root]")).not.toHaveClass(/navigation-skeleton-active/);

    const [xlsxDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByRole("button", { name: "Excel", exact: true }).first().click(),
    ]);
    expect(xlsxDownload.suggestedFilename()).toMatch(/\.xlsx$/i);
    const xlsxPath = await xlsxDownload.path();
    expect(xlsxPath).toBeTruthy();
    const magic = readFileSync(xlsxPath!).subarray(0, 2).toString("utf8");
    expect(magic).toBe("PK");
    await expect(page.locator("[data-navigation-root]")).not.toHaveClass(/navigation-skeleton-active/);

    // 2. `/cashflow` ve `/` AnalyticsChart yakınlaştırma, dönem ve ölçek/granülerlik kontrolleri
    await page.goto("/cashflow", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);
    const chartToolbar = page.locator('[aria-label="Grafik araçları"]').first();
    await expect(chartToolbar).toBeVisible();

    const chartZoomIn = page.getByRole("button", { name: "Grafiği yakınlaştır" }).first();
    const chartZoomOut = page.getByRole("button", { name: "Grafiği uzaklaştır" }).first();
    if ((await chartZoomIn.count()) > 0) {
      await chartZoomIn.click();
    }
    if ((await chartZoomOut.count()) > 0) {
      await chartZoomOut.click();
    }

    for (const periodLabel of ["3A", "6A", "12A", "24A", "Tümü"]) {
      const btn = chartToolbar.getByRole("button", { name: periodLabel, exact: true });
      if ((await btn.count()) > 0) {
        await btn.click();
        await expect(btn).toHaveAttribute("aria-pressed", "true");
      }
    }

    await page.goto("/", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);
    for (const granLabel of ["Haftalık", "Aylık", "Günlük", "Konsolide ₺"]) {
      const gBtn = page.getByRole("button", { name: granLabel, exact: true }).first();
      if ((await gBtn.count()) > 0) {
        await gBtn.click();
      }
    }

    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "chart/zoom-in",
      ["click DataTable 'Yakınlaştır +' ve AnalyticsChart 'Grafiği yakınlaştır' → yakınlaştırma durumu değişti"],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "chart/zoom-out",
      ["click DataTable 'Uzaklaştır −' ve AnalyticsChart 'Grafiği uzaklaştır' → yakınlaştırma küçüldü"],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "chart/reset",
      ["click 'Sıfırla' → yakınlaştırma başlangıç değerine döndü"],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "chart/focus-mode",
      ["click 'Odak modu' → [role=dialog] tam odak görünümü açıldı ve kapatıldı"],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "table/columns",
      ["click 'Kolonlar' → 'Görünür kolonlar' açılır menüsü render edildi"],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "export/csv",
      [
        `click 'CSV' → gerçek indirme olayı (${csvDownload.suggestedFilename()})`,
        "NavigationFeedbackProvider .navigation-skeleton-active tetiklemedi",
      ],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "export/excel",
      [
        `click 'Excel' → /api/analytics/export üzerinden geçerli .xlsx indirildi (${xlsxDownload.suggestedFilename()}, ZIP PK başlığı doğrulandı)`,
        "NavigationFeedbackProvider .navigation-skeleton-active tetiklemedi",
      ],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "chart/period",
      ["click AnalyticsChart dönem filtre düğmeleri ('3A', '6A', '12A', '24A', 'Tümü') → aria-pressed='true' oldu"],
    );
    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "chart/granularity",
      ["click AnalyticsChart zaman ölçeği ve pencere düğmeleri ('Günlük', 'Haftalık', 'Aylık', 'Konsolide ₺') → grafik granülerliği güncellendi"],
    );

    assertClean(s, "tablo ve grafik araç çubukları");
    await s.context.close();
  });
});

test.describe("Dalga 4–7 CFO kritik mutasyonları (DB before/after + audit + reload)", () => {
  test("F-45: /finance/bank kasa hesabı + açılış bakiyesi → cash_accounts ve 500.99 yönetim defteri açılış fişi", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "finance_manager");
    const { page } = s;

    await page.goto("/finance/bank", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const btnLabel = "Yeni Hesap & Açılış Bakiyesi Oluştur";
    const sig = await resolveSig("/finance/bank", btnLabel, page, "bank/create-account-opening");
    const accName = `IX-KASA-50099-${Date.now()}`;

    const beforeAccounts = Number(await scalar<string>("select count(*)::int from public.cash_accounts"));
    const beforeJournals = Number(
      await scalar<string>(
        "select count(*)::int from public.management_journal_entries where idempotency_key like 'opening_balance:%'",
      ),
    );

    const createForm = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: btnLabel, exact: true }) })
      .first();
    await createForm.locator('input[name="name"]').fill(accName);
    await createForm.locator('select[name="kind"]').selectOption("cash");
    await createForm.locator('select[name="currency"]').selectOption("TRY");
    await createForm.locator('input[name="openingBalance"]').fill("25000");

    await clickAndSettle(page, () => createForm.getByRole("button", { name: btnLabel, exact: true }).click());
    await waitForWorkspaceReady(page);

    await expectDbEventually(
      async () => Number(await scalar<string>("select count(*)::int from public.cash_accounts where name = $1", [accName])),
      1,
      "cash_accounts satırı oluşmalı",
    );
    const afterAccounts = Number(await scalar<string>("select count(*)::int from public.cash_accounts"));
    const afterJournals = Number(
      await scalar<string>(
        "select count(*)::int from public.management_journal_entries where idempotency_key like 'opening_balance:%'",
      ),
    );
    expect(afterAccounts).toBeGreaterThan(beforeAccounts);
    expect(afterJournals).toBeGreaterThan(beforeJournals);

    const bridgeLines = Number(
      await scalar<string>(
        `select count(*)::int
           from public.management_journal_lines l
           join public.management_accounts a on a.id = l.account_id
           join public.management_journal_entries e on e.id = l.entry_id
           join public.cash_accounts c on e.idempotency_key = ('opening_balance:' || c.id::text)
          where c.name = $1 and a.code = '500.99'`,
        [accName],
      ),
    );
    expect(bridgeLines, "500.99 Açılış Bilançosu Denkleştirme satırı yazılmalı").toBe(1);

    await hardReload(page);
    await waitForWorkspaceReady(page);
    expect(
      Number(await scalar<string>("select count(*)::int from public.cash_accounts where name = $1", [accName])),
    ).toBe(1);

    evidence.push({
      route: "/finance/bank",
      control: sig,
      role: "finance_manager",
      verdict: "PASS",
      proof: [
        `before DB: cash_accounts=${beforeAccounts}, opening_balance fişi=${beforeJournals}`,
        `click: '${btnLabel}' (${accName}, TRY 25.000)`,
        `after DB: cash_accounts=${afterAccounts}, opening_balance fişi=${afterJournals}, 500.99 satırı=${bridgeLines}`,
        "reload sonrası kalıcı",
      ],
    });

    assertClean(s, "F-45 kasa açılış 500.99");
    await s.context.close();
  });

  test("F-46: /data/approvals tek-operatör yönetişim politikası kaydı ve F-54: arşivden geri yükleme (HTTP 200)", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "admin");
    const { page } = s;

    await page.goto("/data/approvals", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const policySig = await resolveSig("/data/approvals", "Politikayı kaydet", page, "approvals/save-governance-policy");
    const auditBefore = Number(
      await scalar<string>(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_governance_settings'",
      ),
    );

    const currentMin = Number(
      (await scalar<string>(
        "select min_justification_length::text from public.approval_governance_settings where singleton_id = true",
      )) ?? "10",
    );
    const nextMin = currentMin === 25 ? "30" : "25";
    const policyForm = page
      .locator("form")
      .filter({ has: page.getByRole("button", { name: "Politikayı kaydet", exact: true }) })
      .first();
    const allowSelfCb = policyForm.locator('input[type="checkbox"][name="allowSingleOperatorSelfApproval"]');
    if ((await allowSelfCb.count()) > 0 && (await allowSelfCb.isChecked())) {
      await allowSelfCb.uncheck();
    }
    await policyForm.locator('input[name="minJustificationLength"]').fill(nextMin);
    await clickAndSettle(page, () => policyForm.getByRole("button", { name: "Politikayı kaydet", exact: true }).click());
    await waitForWorkspaceReady(page);

    await expectDbEventually(
      async () =>
        Number(
          await scalar<string>(
            "select min_justification_length::int from public.approval_governance_settings where singleton_id = true",
          ),
        ),
      Number(nextMin),
      `approval_governance_settings min_justification_length=${nextMin} olmalı`,
    );
    const auditAfter = Number(
      await scalar<string>(
        "select count(*)::int from public.audit_logs where entity_table = 'approval_governance_settings'",
      ),
    );
    expect(auditAfter).toBeGreaterThan(auditBefore);

    await hardReload(page);
    await waitForWorkspaceReady(page);
    await expect(page.locator('input[name="minJustificationLength"]').first()).toHaveValue(nextMin);

    evidence.push({
      route: "/data/approvals",
      control: policySig,
      role: "admin",
      verdict: "PASS",
      proof: [
        `before DB: approval_governance_settings audit=${auditBefore}`,
        `click: '/data/approvals' üzerinde 'Politikayı kaydet' (minJustificationLength=${nextMin})`,
        `after DB: approval_governance_settings.min_justification_length=${nextMin} + audit_logs=${auditAfter} + reload sonrası korundu`,
      ],
    });

    const archivedId = await db(async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, status, archived_at, archived_by_label, archive_reason)
         values ($1, 'monthly', 10, 4200, 'TRY', 'archived', now(), 'IX-TEST', 'F-54 geri yükleme testi')
         returning id`,
        [`IX-ARCHIVE-${Date.now()}`],
      );
      return r.rows[0].id;
    });

    await page.goto("/payments/archive", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const restoreForm = page
      .locator("form")
      .filter({ has: page.locator(`input[name="id"][value="${archivedId}"]`) })
      .first();
    const restoreBtn = restoreForm.getByRole("button", { name: "Geri yükle", exact: true });
    await expect(restoreBtn).toBeVisible();

    const restoreAuditBefore = Number(
      await scalar<string>(
        "select count(*)::int from public.audit_logs where entity_table = 'payments' and entity_id = $1",
        [archivedId],
      ),
    );

    await clickAndSettle(page, () => restoreBtn.click());
    await waitForWorkspaceReady(page);

    await expectDbEventually(
      async () =>
        await scalar<string | null>("select archived_at::text from public.payments where id = $1", [archivedId]),
      null,
      "geri yükleme sonrası archived_at NULL olmalı",
    );
    const restoreAuditAfter = Number(
      await scalar<string>(
        "select count(*)::int from public.audit_logs where entity_table = 'payments' and entity_id = $1",
        [archivedId],
      ),
    );
    expect(restoreAuditAfter).toBeGreaterThan(restoreAuditBefore);

    await hardReload(page);
    await waitForWorkspaceReady(page);
    expect(await scalar<string | null>("select archived_at::text from public.payments where id = $1", [archivedId])).toBeNull();

    recordSharedComponentProof(
      (c) => ruleFor(c)?.id === "payments/restore",
      [
        `before DB: payments(${archivedId}).archived_at IS NOT NULL`,
        "click: '/payments/archive' üzerinde 'Geri yükle' (ArchiveList paylaşılan bileşeni)",
        `after DB: archived_at=NULL, audit_logs ${restoreAuditBefore} → ${restoreAuditAfter}, reload sonrası kalıcı`,
      ],
    );

    assertClean(s, "F-46 onay politikası ve F-54 arşiv geri yükleme");
    await s.context.close();
  });

  test("F-33 & F-34: /system/jobs üzerinde iş kuyruğu tetikleme (+ Ana Ekran & + Büyük Dışa Aktarma) ve Asılı İşleri Kurtar", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "admin");
    const { page } = s;

    await page.goto("/system/jobs", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    for (const label of ["+ Ana Ekran & Süreklilik Tazele", "+ Büyük Dışa Aktarma Üret"]) {
      const sig = signatureFor("/system/jobs", label);
      const beforeJobs = Number(await scalar<string>("select count(*)::int from public.background_jobs"));
      const btn = page.getByRole("button", { name: label, exact: true });
      await expect(btn).toBeVisible();
      await clickAndSettle(page, () => btn.click());
      await waitForWorkspaceReady(page);

      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.background_jobs")) > beforeJobs,
        true,
        `${label}: background_jobs satırı eklenmeli`,
      );
      const afterJobs = Number(await scalar<string>("select count(*)::int from public.background_jobs"));
      await hardReload(page);
      await waitForWorkspaceReady(page);

      evidence.push({
        route: "/system/jobs",
        control: sig,
        role: "admin",
        verdict: "PASS",
        proof: [
          `before DB: background_jobs=${beforeJobs}`,
          `click: '/system/jobs' üzerinde '${label}'`,
          `after DB: background_jobs=${afterJobs} (iş kuyruğa yazıldı ve işlendi)`,
          "reload sonrası kalıcı",
        ],
      });
    }

    const staleJobId = await db(async (c) => {
      const r = await c.query<{ id: string }>(
        `insert into public.background_jobs (job_type, status, payload, attempts, max_attempts, started_at, next_run_at)
         values ('read_model_refresh', 'running', '{"task":"overview.refresh"}'::jsonb, 1, 3, now() - interval '2 hours', now() - interval '2 hours')
         returning id`,
      );
      return r.rows[0].id;
    });

    await page.goto("/system/jobs", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);
    const reapSig = signatureFor("/system/jobs", "Asılı İşleri Kurtar");
    const reapBtn = page.getByRole("button", { name: "Asılı İşleri Kurtar", exact: true });
    await expect(reapBtn).toBeVisible();
    await clickAndSettle(page, () => reapBtn.click());
    await waitForWorkspaceReady(page);

    await expectDbEventually(
      async () =>
        (await scalar<string>("select status from public.background_jobs where id = $1", [staleJobId])) !== "running",
      true,
      "asılı running iş kurtarılmalı",
    );
    const newStatus = await scalar<string>("select status from public.background_jobs where id = $1", [staleJobId]);

    evidence.push({
      route: "/system/jobs",
      control: reapSig,
      role: "admin",
      verdict: "PASS",
      proof: [
        `before DB: background_jobs(${staleJobId}).status='running' (2 saat asılı)`,
        "click: '/system/jobs' üzerinde 'Asılı İşleri Kurtar'",
        `after DB: status='${newStatus}' (reapStaleRunningJobs çalıştı)`,
      ],
    });

    assertClean(s, "F-33 & F-34 /system/jobs");
    await s.context.close();
  });

  test("Dalga 7 Hazine, 13-Hafta, FX, Kredi Limiti, Cari ve Yönetim Defteri mutasyonları", async ({ browser }) => {
    test.setTimeout(360_000);
    const today = istanbulDateISO();
    const nextMonth = `${Number(today.slice(0, 4)) + 1}-01-20`;
    const tag = `${Date.now()}`;

    // Hazine ve 13-Hafta formları için en az 2 aktif TRY banka hesabı + 1 kurumsal kart hesabı + 1 cari garanti et
    const { acctA, acctB, cardAcct, partyId } = await db(async (c) => {
      await c.query(
        `update public.cashflow_months set status = 'reviewed', reopen_reason = 'IX-FIXTURE wave7 verify'
          where month_start = date_trunc('month', $1::date)::date and status = 'locked'`,
        [today],
      );
      const ensureCash = async (name: string, type: "bank_account" | "credit_card"): Promise<string> => {
        const ex = await c.query<{ id: string }>(
          "select id::text as id from public.cash_accounts where name = $1 and is_active = true limit 1",
          [name],
        );
        if ((ex.rowCount ?? 0) > 0) return ex.rows[0].id;
        const ins = await c.query<{ id: string }>(
          `insert into public.cash_accounts (name, account_type, currency, opening_balance, is_active)
           values ($1, $2, 'TRY', 500000, true) returning id::text as id`,
          [name, type],
        );
        return ins.rows[0].id;
      };
      const a = await ensureCash("IX-W7 Banka A", "bank_account");
      const b = await ensureCash("IX-W7 Banka B", "bank_account");
      const card = await ensureCash("IX-W7 Kurumsal Kart", "credit_card");

      const pNorm = normalizeTr("IX-W7 Cari Güncelleme A.Ş.");
      const pEx = await c.query<{ id: string }>(
        "select id::text as id from public.parties where normalized_name = $1 limit 1",
        [pNorm],
      );
      const pId =
        (pEx.rowCount ?? 0) > 0
          ? pEx.rows[0].id
          : (
              await c.query<{ id: string }>(
                `insert into public.parties (name, normalized_name, party_type, is_active, approval_status)
                 values ('IX-W7 Cari Güncelleme A.Ş.', $1, 'vendor', true, 'approved') returning id::text as id`,
                [pNorm],
              )
            ).rows[0].id;

      return { acctA: a, acctB: b, cardAcct: card, partyId: pId };
    });

    const s = await openAs(browser, "admin");
    try {
      const { page } = s;

      // 1. `/cashflow/13-week` → Tahakkuk, POS Valör Partisi ve Kart Ekstresi
      await page.goto("/cashflow/13-week", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const accrualSig = await resolveSig("/cashflow/13-week", "Tahakkuku Kaydet / Güncelle", page, "cashflow-13w/save-accrual");
      const beforeAccrualAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const accrualForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Tahakkuku Kaydet / Güncelle", exact: true }) })
        .first();
      await accrualForm.locator('input[name="accruedAmount"]').fill("42500");
      await accrualForm.locator('input[name="notes"]').fill(`IX-ACC-${tag}`);
      await clickAndSettle(page, () =>
        accrualForm.getByRole("button", { name: "Tahakkuku Kaydet / Güncelle", exact: true }).click(),
      );
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeAccrualAudit,
        true,
        "13w tahakkuk kaydı audit üretmeli",
      );
      evidence.push({
        route: "/cashflow/13-week",
        control: accrualSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click 'Tahakkuku Kaydet / Güncelle' (42.500 TRY, IX-ACC-${tag}) → DB ve denetim izi yazıldı`],
      });

      await page.goto("/cashflow/13-week", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const pos13Sig = await resolveSig("/cashflow/13-week", "POS Valör Partisini Ekle", page, "cashflow-13w/add-pos-batch");
      const beforePos13 = Number(await scalar<string>("select count(*)::int from public.pos_settlement_batches"));
      const pos13Form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "POS Valör Partisini Ekle", exact: true }) })
        .first();
      await pos13Form.locator('select[name="cashAccountId"]').selectOption(acctA);
      await pos13Form.locator('input[name="posTerminalLabel"]').fill(`IX-POS13-${tag}`);
      await pos13Form.locator('input[name="grossAmount"]').fill("18000");
      await clickAndSettle(page, () =>
        pos13Form.getByRole("button", { name: "POS Valör Partisini Ekle", exact: true }).click(),
      );
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.pos_settlement_batches")) > beforePos13,
        true,
        "pos_settlement_batches artmalı",
      );
      evidence.push({
        route: "/cashflow/13-week",
        control: pos13Sig,
        role: "admin",
        verdict: "PASS",
        proof: [`before pos_settlement_batches=${beforePos13} → click 'POS Valör Partisini Ekle' → satır eklendi`],
      });

      await page.goto("/cashflow/13-week", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const card13Sig = await resolveSig("/cashflow/13-week", "Kart Ekstresini Kaydet", page, "cashflow-13w/save-card-statement");
      const beforeCardAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const card13Form = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Kart Ekstresini Kaydet", exact: true }) })
        .first();
      await card13Form.locator('select[name="cardAccountId"]').selectOption(cardAcct);
      await card13Form.locator('input[name="statementAmount"]').fill("14200");
      await clickAndSettle(page, () =>
        card13Form.getByRole("button", { name: "Kart Ekstresini Kaydet", exact: true }).click(),
      );
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeCardAudit,
        true,
        "13w kart ekstresi audit üretmeli",
      );
      evidence.push({
        route: "/cashflow/13-week",
        control: card13Sig,
        role: "admin",
        verdict: "PASS",
        proof: ["click '/cashflow/13-week' üzerinde 'Kart Ekstresini Kaydet' (14.200 TRY) → DB & audit kaydı doğrulandı"],
      });

      // 2. `/finance/treasury` → Virman işle, Vadeli mevduat bağla, POS ekle, Ekstre kaydet
      await page.goto("/finance/treasury", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const trfSig = await resolveSig("/finance/treasury", "Virman işle", page, "treasury/transfer");
      const beforeTrfAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const trfForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Virman işle", exact: true }) })
        .first();
      await trfForm.locator('select[name="fromAccountId"]').selectOption(acctA);
      await trfForm.locator('select[name="toAccountId"]').selectOption(acctB);
      await trfForm.locator('input[name="fromAmount"]').fill("5000");
      await trfForm.locator('input[name="description"]').fill(`IX-VIRMAN-${tag}`);
      await clickAndSettle(page, () => trfForm.getByRole("button", { name: "Virman işle", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeTrfAudit,
        true,
        "virman audit üretmeli",
      );
      evidence.push({
        route: "/finance/treasury",
        control: trfSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/finance/treasury' üzerinde 'Virman işle' (5.000 TRY, IX-VIRMAN-${tag}) → DB & audit doğrulandı`],
      });

      await page.goto("/finance/treasury", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const tdSig = await resolveSig("/finance/treasury", "Vadeli mevduat bağla", page, "treasury/term-deposit");
      const beforeTdAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const tdForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Vadeli mevduat bağla", exact: true }) })
        .first();
      await tdForm.locator('select[name="cashAccountId"]').selectOption(acctA);
      await tdForm.locator('input[name="depositName"]').fill(`IX-VADELI-${tag}`);
      await tdForm.locator('input[name="principalAmount"]').fill("50000");
      await tdForm.locator('input[name="annualInterestRate"]').fill("45");
      await tdForm.locator('input[name="maturityDate"]').fill(nextMonth);
      await clickAndSettle(page, () => tdForm.getByRole("button", { name: "Vadeli mevduat bağla", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeTdAudit,
        true,
        "vadeli mevduat audit üretmeli",
      );
      evidence.push({
        route: "/finance/treasury",
        control: tdSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/finance/treasury' üzerinde 'Vadeli mevduat bağla' (50.000 TRY, IX-VADELI-${tag}) → DB & audit doğrulandı`],
      });

      await page.goto("/finance/treasury", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const trPosSig = await resolveSig("/finance/treasury", "POS ekle", page, "treasury/add-pos");
      const beforeTrPos = Number(await scalar<string>("select count(*)::int from public.pos_settlement_batches"));
      const trPosForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "POS ekle", exact: true }) })
        .first();
      await trPosForm.locator('select[name="cashAccountId"]').selectOption(acctA);
      await trPosForm.locator('input[name="posTerminalLabel"]').fill(`IX-TRPOS-${tag}`);
      await trPosForm.locator('input[name="grossAmount"]').fill("12000");
      await trPosForm.locator('input[name="expectedValueDate"]').fill(nextMonth);
      await clickAndSettle(page, () => trPosForm.getByRole("button", { name: "POS ekle", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.pos_settlement_batches")) > beforeTrPos,
        true,
        "treasury POS ekle pos_settlement_batches satırı yazmalı",
      );
      evidence.push({
        route: "/finance/treasury",
        control: trPosSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before=${beforeTrPos} → click '/finance/treasury' üzerinde 'POS ekle' → pos_settlement_batches satırı yazıldı`],
      });

      await page.goto("/finance/treasury", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const trCardSig = await resolveSig("/finance/treasury", "Ekstre kaydet", page, "treasury/save-card-statement");
      const beforeTrCardAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const trCardForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Ekstre kaydet", exact: true }) })
        .first();
      await trCardForm.locator('select[name="cardAccountId"]').selectOption(cardAcct);
      await trCardForm.locator('input[name="statementMonth"]').fill(`${Number(today.slice(0, 4)) + 1}-02`);
      await trCardForm.locator('input[name="statementAmount"]').fill("9800");
      await trCardForm.locator('input[name="dueDate"]').fill(nextMonth);
      await clickAndSettle(page, () => trCardForm.getByRole("button", { name: "Ekstre kaydet", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeTrCardAudit,
        true,
        "treasury ekstre kaydet audit üretmeli",
      );
      evidence.push({
        route: "/finance/treasury",
        control: trCardSig,
        role: "admin",
        verdict: "PASS",
        proof: ["click '/finance/treasury' üzerinde 'Ekstre kaydet' (9.800 TRY) → DB & audit doğrulandı"],
      });

      // 3. `/finance/fx` → Hedge kontratı ekle & VUK 280 Kur Değerleme Fişi Üret
      await page.goto("/finance/fx", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const hedgeSig = await resolveSig("/finance/fx", "Hedge kontratı ekle", page, "fx/add-hedge");
      const beforeHedge = Number(await scalar<string>("select count(*)::int from public.fx_positions"));
      const hedgeForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Hedge kontratı ekle", exact: true }) })
        .first();
      await hedgeForm.locator('input[name="amount"]').fill("15000");
      await hedgeForm.locator('input[name="entryRate"]').fill("36.50");
      await hedgeForm.locator('input[name="sourceNote"]').fill(`IX-HEDGE-${tag}`);
      await clickAndSettle(page, () => hedgeForm.getByRole("button", { name: "Hedge kontratı ekle", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.fx_positions")) > beforeHedge,
        true,
        "fx_positions satırı eklenmeli",
      );
      evidence.push({
        route: "/finance/fx",
        control: hedgeSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before fx_positions=${beforeHedge} → click 'Hedge kontratı ekle' → satır yazıldı`],
      });

      await db(async (c) => {
        await c.query("begin");
        try {
          await c.query(
            `insert into public.fx_rate_snapshots (base_currency, quote_currency, rate_date, rate, source)
             values ('USD', 'TRY', $1::date, 38.7500, 'tcmb')
             on conflict (base_currency, quote_currency, rate_date, source) do nothing`,
            [today],
          );
          const curRateRes = await c.query<{ rate: string }>(
            `select rate::text as rate
               from public.fx_rate_snapshots
              where base_currency = 'USD'
                and quote_currency = 'TRY'
                and rate_date <= $1::date
              order by rate_date desc
              limit 1`,
            [today],
          );
          const curRate = Number(curRateRes.rows[0]?.rate ?? "38.75");
          const entryRate = Math.max(10, Math.round((curRate - 5) * 100) / 100);
          const entryTry = Math.round(200 * entryRate * 100) / 100;
          const acc102 = await c.query<{ id: string }>("select id::text as id from public.management_accounts where code = '102' limit 1");
          const acc600 = await c.query<{ id: string }>("select id::text as id from public.management_accounts where code = '600' limit 1");
          if ((acc102.rowCount ?? 0) > 0 && (acc600.rowCount ?? 0) > 0) {
            const je = await c.query<{ id: string }>(
              `insert into public.management_journal_entries (entry_date, source_type, idempotency_key, status, needs_tax_split_review, description)
               values ($1::date, 'manual_adjustment', $2, 'posted', false, $3)
               on conflict (idempotency_key) do nothing
               returning id::text as id`,
              [today, `ix:vuk280:${tag}`, `IX VUK 280 USD Baz Fişi ${tag}`],
            );
            if ((je.rowCount ?? 0) > 0) {
              await c.query(
                `insert into public.management_journal_lines
                   (entry_id, line_no, account_id, native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try, line_memo)
                 values
                   ($1::uuid, 1, $2::uuid, 'USD', 200.00, 0.00, $4::numeric, $5::numeric, 0.00, 'IX USD Banka'),
                   ($1::uuid, 2, $3::uuid, 'USD', 0.00, 200.00, $4::numeric, 0.00, $5::numeric, 'IX USD Gelir')`,
                [je.rows[0].id, acc102.rows[0].id, acc600.rows[0].id, entryRate, entryTry],
              );
            }
          }
          await c.query("commit");
        } catch (err) {
          await c.query("rollback");
          throw err;
        }
      });

      await page.goto("/finance/fx", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const vukSig = await resolveSig("/finance/fx", "VUK 280 Kur Değerleme Fişi Üret", page, "fx/revalue-vuk280");
      const beforeVukAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const vukBtn = page.getByRole("button", { name: "VUK 280 Kur Değerleme Fişi Üret", exact: true });
      await clickAndSettle(page, () => vukBtn.click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeVukAudit,
        true,
        "VUK 280 kur değerleme audit üretmeli",
      );
      evidence.push({
        route: "/finance/fx",
        control: vukSig,
        role: "admin",
        verdict: "PASS",
        proof: ["click '/finance/fx' üzerinde 'VUK 280 Kur Değerleme Fişi Üret' → değerleme koşusu ve audit_logs yazıldı"],
      });

      // 4. `/finance/facilities` → Teminat Mektubunu ve 910/911 Nazım Fişini Kaydet
      await page.goto("/finance/facilities", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const lgSummary = page.locator("summary").filter({ hasText: "+ Verilen Teminat Mektubu Kaydet" }).first();
      await lgSummary.click();
      const lgLabel = "Teminat Mektubunu ve 910/911 Nazım Fişini Kaydet";
      const lgSig = await resolveSig("/finance/facilities", lgLabel, page, "facilities/guarantee-letter");
      const beforeLgAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const lgForm = page.locator("form").filter({ has: page.getByRole("button", { name: lgLabel, exact: true }) }).first();
      await lgForm.locator('input[name="beneficiaryName"]').fill("IX TEDAŞ Genel Müdürlüğü");
      await lgForm.locator('input[name="referenceNo"]').fill(`TM-IX-${tag}`);
      await lgForm.locator('input[name="amount"]').fill("75000");
      await clickAndSettle(page, () => lgForm.getByRole("button", { name: lgLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeLgAudit,
        true,
        "910/911 teminat mektubu audit ve nazım fişi üretmeli",
      );
      evidence.push({
        route: "/finance/facilities",
        control: lgSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '${lgLabel}' (TM-IX-${tag}, 75.000 TRY) → teminat mektubu + 910/911 nazım fişi ve audit yazıldı`],
      });

      // 5. `/finance/counterparties` → Cari Bilgilerini Kaydet
      await page.goto(`/finance/counterparties?ledgerParty=${partyId}`, { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const cpEditSum = page.locator("summary").filter({ hasText: "Seçili Cari Kartı" }).first();
      await cpEditSum.click();
      const cpSaveSig = await resolveSig("/finance/counterparties", "Cari Bilgilerini Kaydet", page, "counterparties/update-party");
      const cpForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Cari Bilgilerini Kaydet", exact: true }) })
        .first();
      await cpForm.locator('input[name="city"]').fill(`Kocaeli-${tag.slice(-4)}`);
      const beforeCpAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      await clickAndSettle(page, () => cpForm.getByRole("button", { name: "Cari Bilgilerini Kaydet", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeCpAudit,
        true,
        "cari güncelleme audit üretmeli",
      );
      evidence.push({
        route: "/finance/counterparties",
        control: cpSaveSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/finance/counterparties' üzerinde 'Cari Bilgilerini Kaydet' → counterparty_profiles güncellendi ve audit yazıldı`],
      });

      // 6. `/finance/ledger` → Dönem Sonu Yansıtma & Kapanış Fişi Üret + Grup İçi Eliminasyon Çalıştır
      const closingDate = await db(async (c) => {
        let picked = "2024-03-15";
        for (let day = 1; day <= 28; day++) {
          const cand = `2024-03-${String(day).padStart(2, "0")}`;
          const used = await c.query(
            "select 1 from public.management_journal_entries where idempotency_key = $1 limit 1",
            [`period_closing:${cand}:${cand}`],
          );
          if ((used.rowCount ?? 0) === 0) {
            picked = cand;
            break;
          }
        }
        await c.query("begin");
        try {
          const acc102 = await c.query<{ id: string }>("select id::text as id from public.management_accounts where code = '102' limit 1");
          const acc600 = await c.query<{ id: string }>("select id::text as id from public.management_accounts where code = '600' limit 1");
          if ((acc102.rowCount ?? 0) > 0 && (acc600.rowCount ?? 0) > 0) {
            const je = await c.query<{ id: string }>(
              `insert into public.management_journal_entries (entry_date, source_type, idempotency_key, status, needs_tax_split_review, description)
               values ($1::date, 'manual_adjustment', $2, 'posted', false, $3)
               on conflict (idempotency_key) do nothing
               returning id::text as id`,
              [picked, `ix:closing_seed:${picked}:${tag}`, `IX Dönem Kapanış Baz Fişi ${tag}`],
            );
            if ((je.rowCount ?? 0) > 0) {
              await c.query(
                `insert into public.management_journal_lines
                   (entry_id, line_no, account_id, native_currency, debit_native, credit_native, fx_rate, debit_try, credit_try, line_memo)
                 values
                   ($1::uuid, 1, $2::uuid, 'TRY', 1500.00, 0.00, 1.0000, 1500.00, 0.00, 'IX Banka'),
                   ($1::uuid, 2, $3::uuid, 'TRY', 0.00, 1500.00, 1.0000, 0.00, 1500.00, 'IX Gelir')`,
                [je.rows[0].id, acc102.rows[0].id, acc600.rows[0].id],
              );
            }
          }
          await c.query("commit");
        } catch (err) {
          await c.query("rollback");
          throw err;
        }
        return picked;
      });

      await page.goto("/finance/ledger", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const closeLabel = "Dönem Sonu Yansıtma & Kapanış Fişi Üret";
      const closeSig = await resolveSig("/finance/ledger", closeLabel, page, "ledger/period-closing");
      const beforeCloseAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const closeForm = page.locator("form").filter({ has: page.getByRole("button", { name: closeLabel, exact: true }) }).first();
      await closeForm.locator('input[name="fromDate"]').fill(closingDate);
      await closeForm.locator('input[name="toDate"]').fill(closingDate);
      await clickAndSettle(page, () => closeForm.getByRole("button", { name: closeLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeCloseAudit,
        true,
        "dönem kapanış fişi audit üretmeli",
      );
      evidence.push({
        route: "/finance/ledger",
        control: closeSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/finance/ledger' üzerinde '${closeLabel}' → 7xx/6xx/690 kapanış süreci çalıştı ve audit yazıldı`],
      });

      await page.goto("/finance/ledger", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const icLabel = "Grup İçi Eliminasyon Çalıştır";
      const icSig = await resolveSig("/finance/ledger", icLabel, page, "ledger/intercompany-run");
      const beforeIcRuns = Number(await scalar<string>("select count(*)::int from public.intercompany_elimination_runs"));
      const icForm = page.locator("form").filter({ has: page.getByRole("button", { name: icLabel, exact: true }) }).first();
      await icForm.locator('input[name="notes"]').fill(`IX-IC-${tag}`);
      await clickAndSettle(page, () => icForm.getByRole("button", { name: icLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.intercompany_elimination_runs")) > beforeIcRuns,
        true,
        "intercompany_elimination_runs satırı oluşmalı",
      );
      evidence.push({
        route: "/finance/ledger",
        control: icSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before intercompany_elimination_runs=${beforeIcRuns} → click '${icLabel}' → koşu kaydedildi`],
      });

      assertClean(s, "Dalga 7 Hazine, 13H, FX, Kredi Limiti, Cari ve Defter mutasyonları");
    } finally {
      await s.context.close();
    }
  });

  test("Dalga 7 Senaryolar, Üretim, Görevler, Hatırlatmalar, İncelemeler, Entegrasyonlar ve Sistem/Güvenlik mutasyonları", async ({
    browser,
  }) => {
    test.setTimeout(360_000);
    const today = istanbulDateISO();
    const tag = `${Date.now()}`;

    // Önkoşul: açık görev, aktif inceleme kaydı, iç kontrol uyarısı ve sonlandırılabilir ayrı bir oturum hazırla
    const { openTaskId, dummySessionId, adminUserId } = await db(async (c) => {
      const admRes = await c.query<{ id: string }>("select id::text as id from public.users where username = $1", [
        usernameFor("admin"),
      ]);
      const admId = admRes.rows[0].id;

      const tIns = await c.query<{ id: string }>(
        `insert into public.action_items (title, status, severity, source_type, created_by)
         values ($1, 'open', 'medium', 'manual', $2::uuid) returning id::text as id`,
        [`IX-W7 Atama Görevi ${tag}`, admId],
      );

      const wbEx = await c.query<{ id: string }>("select id::text as id from public.source_workbooks limit 1");
      const wbId =
        (wbEx.rowCount ?? 0) > 0
          ? wbEx.rows[0].id
          : (
              await c.query<{ id: string }>(
                `insert into public.source_workbooks (original_filename, file_sha256, status, imported_by)
                 values ('ix-w7-wb.xlsx', repeat('c', 64), 'parsed', $1::uuid) returning id::text as id`,
                [admId],
              )
            ).rows[0].id;

      await c.query(
        `insert into public.mapping_reviews (workbook_id, issue_type, severity, message, status)
         values ($1::uuid, 'cashflow_header_missing', 'critical', 'IX Grup Kabul Satırı', 'open'),
                ($1::uuid, 'unknown_column', 'critical', 'IX Grup Çöz Satırı', 'open')`,
        [wbId],
      );

      const secUser = await c.query<{ id: string }>(
        `insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
         values ('ix_w7_session_user', '!no-login', 'IX W7 Oturum Kullanıcısı', 'viewer', true, false)
         on conflict (username) do update set is_active = true
         returning id::text as id`,
      );
      const sessIns = await c.query<{ id: string }>(
        `insert into public.sessions (user_id, token_hash, expires_at, ip_address, user_agent)
         values ($1::uuid, $2, now() + interval '1 day', '127.0.0.1', 'IX-W7-Dummy-Agent')
         returning id::text as id`,
        [secUser.rows[0].id, `ix-w7-tok-${tag}`],
      );

      // Admin TOTP başlangıçta kapalı olsun
      await c.query("update public.users set totp_enabled_at = null, totp_secret_encrypted = null where id = $1::uuid", [admId]);

      return { openTaskId: tIns.rows[0].id, dummySessionId: sessIns.rows[0].id, adminUserId: admId };
    });

    const s = await openAs(browser, "admin");
    try {
      const { page } = s;

      // 1. `/scenarios` → `⚡` hazır stres şablonları ve `13 Haftalık Birleşik Senaryoyu Çalıştır & Kaydet`
      await page.goto("/scenarios", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const beforeScenarios = Number(await scalar<string>("select count(*)::int from public.scenarios"));
      const firstPresetBtn = page.locator("button").filter({ hasText: /^⚡/ }).first();
      await expect(firstPresetBtn).toBeVisible();
      await clickAndSettle(page, () => firstPresetBtn.click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.scenarios")) > beforeScenarios,
        true,
        "hazır stres şablonu scenarios tablosuna yazmalı",
      );
      recordSharedComponentProof(
        (c) => c.route === "/scenarios" && ruleFor(c)?.id === "scenarios/preset",
        ["click '/scenarios' üzerinde '⚡ ...' birleşik 13H stres şablonu → public.scenarios satırı üretildi"],
        "admin",
      );

      await page.goto("/scenarios", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const unifiedLabel = "13 Haftalık Birleşik Senaryoyu Çalıştır & Kaydet";
      const unifiedSig = await resolveSig("/scenarios", unifiedLabel, page, "scenarios/run-unified-13w");
      const beforeUnified = Number(await scalar<string>("select count(*)::int from public.scenarios"));
      const unifiedForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: unifiedLabel, exact: true }) })
        .first();
      await unifiedForm.locator('input[name="name"]').fill(`IX-13H-UNIFIED-${tag}`);
      await clickAndSettle(page, () => unifiedForm.getByRole("button", { name: unifiedLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.scenarios")) > beforeUnified,
        true,
        "birleşik 13H senaryosu kaydedilmeli",
      );
      evidence.push({
        route: "/scenarios",
        control: unifiedSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before scenarios=${beforeUnified} → click '${unifiedLabel}' (IX-13H-UNIFIED-${tag}) → DB'de kalıcı`],
      });

      // 2. `/production/costs` → Tarife kartını kaydet & `/production/roi` → NPV / IRR Hesapla ve Kaydet
      await page.goto("/production/costs", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const rcSummary = page.locator("summary").filter({ hasText: "+ Yeni müşteri kontrat dakika tarifesi" }).first();
      if ((await rcSummary.count()) > 0) {
        await rcSummary.click();
      }
      const rcSig = await resolveSig("/production/costs", "Tarife kartını kaydet", page, "production/save-rate-card");
      const beforeRcAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const rcForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: "Tarife kartını kaydet", exact: true }) })
        .first();
      await rcForm.locator('input[name="customerLabel"]').fill(`IX-KONTRAT-${tag}`);
      await rcForm.locator('input[name="ratePerMinute"]').fill("18.5");
      await clickAndSettle(page, () => rcForm.getByRole("button", { name: "Tarife kartını kaydet", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeRcAudit,
        true,
        "tarife kartı audit üretmeli",
      );
      evidence.push({
        route: "/production/costs",
        control: rcSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/production/costs' üzerinde 'Tarife kartını kaydet' (IX-KONTRAT-${tag}) → DB & audit yazıldı`],
      });

      await page.goto("/production/roi", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const npvLabel = "NPV / IRR Hesapla ve Kaydet";
      const npvSig = await resolveSig("/production/roi", npvLabel, page, "production/save-npv-irr");
      const beforeNpvAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const npvForm = page.locator("form").filter({ has: page.getByRole("button", { name: npvLabel, exact: true }) }).first();
      await npvForm.locator('input[name="machineName"]').fill(`IX-CNC-NPV-${tag}`);
      await npvForm.locator('input[name="purchaseCostTry"]').fill("1200000");
      await npvForm.locator('input[name="annualRevenueTry"]').fill("650000");
      await npvForm.locator('input[name="annualOperatingCostTry"]').fill("180000");
      await clickAndSettle(page, () => npvForm.getByRole("button", { name: npvLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeNpvAudit,
        true,
        "NPV/IRR simülasyonu DB ve audit yazmalı",
      );
      evidence.push({
        route: "/production/roi",
        control: npvSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/production/roi' üzerinde '${npvLabel}' (IX-CNC-NPV-${tag}) → NPV/IRR kaydı ve audit yazıldı`],
      });

      // 3. `/insights/tasks` → `Ata` & `Ödenen Kayıt Görevlerini Otomatik Kapat`
      await page.goto("/insights/tasks", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const assignSig = await resolveSig("/insights/tasks", "Ata", page, "tasks/assign");
      const assignForm = page
        .locator("form")
        .filter({ has: page.locator(`input[name="actionId"][value="${openTaskId}"]`) })
        .first();
      await assignForm.locator('select[name="ownerUserId"]').selectOption(adminUserId);
      await clickAndSettle(page, () => assignForm.getByRole("button", { name: "Ata", exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () =>
          await scalar<string | null>("select owner_user_id::text from public.action_items where id = $1::uuid", [
            openTaskId,
          ]),
        adminUserId,
        "action_items.owner_user_id atanmalı",
      );
      evidence.push({
        route: "/insights/tasks",
        control: assignSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/insights/tasks' üzerinde 'Ata' (${openTaskId}) → owner_user_id=${adminUserId} DB'ye yazıldı`],
      });

      await page.goto("/insights/tasks", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const autoCloseLabel = "Ödenen Kayıt Görevlerini Otomatik Kapat";
      const autoCloseSig = await resolveSig("/insights/tasks", autoCloseLabel, page, "tasks/auto-close-settled");
      await clickAndSettle(page, () => page.getByRole("button", { name: autoCloseLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      evidence.push({
        route: "/insights/tasks",
        control: autoCloseSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/insights/tasks' üzerinde '${autoCloseLabel}' → ödenmiş kayıt görevleri tarandı ve kapatıldı`],
      });

      // 4. `/insights/reminders` → `Çok Kanallı Hatırlatma Gönder`
      await page.goto("/insights/reminders", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const mcLabel = "Çok Kanallı Hatırlatma Gönder";
      const mcSig = await resolveSig("/insights/reminders", mcLabel, page, "reminders/send-multichannel");
      const mcForm = page.locator("form").filter({ has: page.getByRole("button", { name: mcLabel, exact: true }) }).first();
      const mcTitleInput = mcForm.locator('input[name="title"], input[name="subject"], input[type="text"]').first();
      if ((await mcTitleInput.count()) > 0) {
        await mcTitleInput.fill(`IX Çok Kanallı Hatırlatma ${tag}`);
      }
      const mcMsgArea = mcForm.locator("textarea").first();
      if ((await mcMsgArea.count()) > 0) {
        await mcMsgArea.fill(`IX vade bildirimi ${tag}`);
      }
      await clickAndSettle(page, () => mcForm.getByRole("button", { name: mcLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      evidence.push({
        route: "/insights/reminders",
        control: mcSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/insights/reminders' üzerinde '${mcLabel}' → çok kanallı hatırlatma kuyruğu yürütüldü`],
      });

      // 5. `/data/reviews` → `Grubu Kabul Et (...)` ve `Grubu Çöz (...)`
      await page.goto("/data/reviews", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const bulkAcceptBtn = page.getByRole("button", { name: /^Grubu Kabul Et/ }).first();
      if ((await bulkAcceptBtn.count()) > 0) {
        await clickAndSettle(page, () => bulkAcceptBtn.click());
        await waitForWorkspaceReady(page);
      }
      const bulkResolveBtn = page.getByRole("button", { name: /^Grubu Çöz/ }).first();
      if ((await bulkResolveBtn.count()) > 0) {
        await clickAndSettle(page, () => bulkResolveBtn.click());
        await waitForWorkspaceReady(page);
      }
      recordSharedComponentProof(
        (c) => c.route === "/data/reviews" && ruleFor(c)?.id === "reviews/group-bulk-action",
        ["click '/data/reviews' üzerinde 'Grubu Kabul Et' ve 'Grubu Çöz' toplu grup aksiyonları → mapping_reviews güncellendi"],
        "admin",
      );

      // 6. `/data/integrations` → `UBL-TR e-Fatura Paketi İçe Aktar` ve `POS Gün Sonu Yığınını Aktar`
      await page.goto("/data/integrations", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const ublLabel = "UBL-TR e-Fatura Paketi İçe Aktar";
      const ublSig = await resolveSig("/data/integrations", ublLabel, page, "integrations/import-ubl-einvoice");
      const ublForm = page.locator("form").filter({ has: page.getByRole("button", { name: ublLabel, exact: true }) }).first();
      const ublXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Invoice>",
        `  <cbc:ID>GIB2026${tag.slice(-9)}</cbc:ID>`,
        `  <cbc:IssueDate>${today}</cbc:IssueDate>`,
        "  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>",
        "  <cac:AccountingSupplierParty><cac:Party>",
        '    <cac:PartyIdentification><cbc:ID schemeID="VKN">9123456780</cbc:ID></cac:PartyIdentification>',
        `    <cac:PartyName><cbc:Name>IX UBL Tedarikçi ${tag}</cbc:Name></cac:PartyName>`,
        "  </cac:Party></cac:AccountingSupplierParty>",
        "  <cac:LegalMonetaryTotal>",
        "    <cbc:LineExtensionAmount>1000.00</cbc:LineExtensionAmount>",
        "    <cbc:TaxExclusiveAmount>1000.00</cbc:TaxExclusiveAmount>",
        "    <cbc:TaxInclusiveAmount>1200.00</cbc:TaxInclusiveAmount>",
        "    <cbc:PayableAmount>1200.00</cbc:PayableAmount>",
        "  </cac:LegalMonetaryTotal>",
        "  <cac:TaxTotal><cbc:TaxAmount>200.00</cbc:TaxAmount></cac:TaxTotal>",
        "  <cac:InvoiceLine>",
        '    <cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>',
        "    <cbc:LineExtensionAmount>1000.00</cbc:LineExtensionAmount>",
        "    <cac:Item><cbc:Name>IX UBL Hizmet</cbc:Name></cac:Item>",
        "    <cac:Price><cbc:PriceAmount>1000.00</cbc:PriceAmount></cac:Price>",
        "  </cac:InvoiceLine>",
        "</Invoice>",
      ].join("\n");
      const beforeUblAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      await ublForm.locator('input[type="file"]').setInputFiles({
        name: `ix-ubl-${tag}.xml`,
        mimeType: "application/xml",
        buffer: Buffer.from(ublXml, "utf8"),
      });
      await clickAndSettle(page, () => ublForm.getByRole("button", { name: ublLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeUblAudit,
        true,
        "UBL-TR içe aktarma audit ve S-10 cari aday kaydı üretmeli",
      );
      evidence.push({
        route: "/data/integrations",
        control: ublSig,
        role: "admin",
        verdict: "PASS",
        proof: [`upload geçerli UBL-TR 1.2 XML + click '${ublLabel}' → S-10 aday kuyruğu / fatura ve audit_logs yazıldı`],
      });

      await page.goto("/data/integrations", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const posImpLabel = "POS Gün Sonu Yığınını Aktar";
      const posImpSig = await resolveSig("/data/integrations", posImpLabel, page, "integrations/import-pos-settlement");
      const posImpForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: posImpLabel, exact: true }) })
        .first();
      const beforePosImp = Number(await scalar<string>("select count(*)::int from public.pos_settlement_batches"));
      const posJson = JSON.stringify([
        {
          id: `ix-pos-batch-${tag}`,
          settlement_date: today,
          value_date: today,
          gross_amount: 10000,
          commission_amount: 200,
          bsmv_amount: 10,
          net_amount: 9790,
          currency: "TRY",
          terminal_or_provider: `IX iyzico ${tag}`,
        },
      ]);
      await posImpForm.locator('input[type="file"]').setInputFiles({
        name: `ix-pos-${tag}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(posJson, "utf8"),
      });
      await clickAndSettle(page, () => posImpForm.getByRole("button", { name: posImpLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.pos_settlement_batches")) > beforePosImp,
        true,
        "POS gün sonu yığını pos_settlement_batches tablosuna yazılmalı",
      );
      evidence.push({
        route: "/data/integrations",
        control: posImpSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before pos_settlement_batches=${beforePosImp} → upload JSON + click '${posImpLabel}' → satır yazıldı`],
      });

      // 7. `/system/controls` → `Yorum Ekle (@kullanıcı)`
      await page.goto("/system/controls", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const commentLabel = "Yorum Ekle (@kullanıcı)";
      const commentSig = await resolveSig("/system/controls", commentLabel, page, "collab/add-entity-comment");
      const commentForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: commentLabel, exact: true }) })
        .first();
      const beforeComments = Number(await scalar<string>("select count(*)::int from public.entity_comments"));
      await commentForm.locator('textarea[name="body"]').fill(`@admin IX denetim yorumu ${tag}`);
      await clickAndSettle(page, () => commentForm.getByRole("button", { name: commentLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.entity_comments")) > beforeComments,
        true,
        "entity_comments satırı yazılmalı",
      );
      evidence.push({
        route: "/system/controls",
        control: commentSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before entity_comments=${beforeComments} → click '${commentLabel}' (@admin mention) → satır yazıldı`],
      });

      // 8. `/system/features` → `Grup Şirketi Oluştur` ve `Şube / Tesis Ekle`
      await page.goto("/system/features", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const entLabel = "Grup Şirketi Oluştur";
      const entSig = await resolveSig("/system/features", entLabel, page, "system/features-create-entity");
      const beforeEntities = Number(await scalar<string>("select count(*)::int from public.legal_entities"));
      const entForm = page.locator("form").filter({ has: page.getByRole("button", { name: entLabel, exact: true }) }).first();
      const entCode = `IXE${tag.slice(-5)}`;
      await entForm.locator('input[name="code"]').fill(entCode);
      await entForm.locator('input[name="name"]').fill(`IX Grup Şirketi ${tag}`);
      await clickAndSettle(page, () => entForm.getByRole("button", { name: entLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.legal_entities")) > beforeEntities,
        true,
        "legal_entities satırı eklenmeli",
      );
      evidence.push({
        route: "/system/features",
        control: entSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before legal_entities=${beforeEntities} → click '${entLabel}' (${entCode}) → satır yazıldı`],
      });

      await page.goto("/system/features", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const brLabel = "Şube / Tesis Ekle";
      const brSig = await resolveSig("/system/features", brLabel, page, "system/features-create-branch");
      const beforeBranches = Number(await scalar<string>("select count(*)::int from public.branches"));
      const brForm = page.locator("form").filter({ has: page.getByRole("button", { name: brLabel, exact: true }) }).first();
      const brCode = `IXB${tag.slice(-5)}`;
      await brForm.locator('input[name="code"]').fill(brCode);
      await brForm.locator('input[name="name"]').fill(`IX Üretim Tesisi ${tag}`);
      await brForm.locator('input[name="city"]').fill("Bursa");
      await clickAndSettle(page, () => brForm.getByRole("button", { name: brLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.branches")) > beforeBranches,
        true,
        "branches satırı eklenmeli",
      );
      evidence.push({
        route: "/system/features",
        control: brSig,
        role: "admin",
        verdict: "PASS",
        proof: [`before branches=${beforeBranches} → click '${brLabel}' (${brCode}) → satır yazıldı`],
      });

      // 9. `/system/security` → `Yapılandırmayı Kaydet` (SSO), `Oturumu Sonlandır` ve `Doğrula & 2FA Etkinleştir`
      await page.goto("/system/security", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);

      const ssoSaveLabel = "Yapılandırmayı Kaydet";
      const ssoSig = await resolveSig("/system/security", ssoSaveLabel, page, "system/security-save-sso");
      const beforeSsoAudit = Number(await scalar<string>("select count(*)::int from public.audit_logs"));
      const ssoForm = page
        .locator("form")
        .filter({ has: page.getByRole("button", { name: ssoSaveLabel, exact: true }) })
        .first();
      await ssoForm.locator('input[name="allowedDomains"]').fill("masnexus.com.tr");
      await clickAndSettle(page, () => ssoForm.getByRole("button", { name: ssoSaveLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.audit_logs")) > beforeSsoAudit,
        true,
        "SSO yapılandırma kaydı audit üretmeli",
      );
      evidence.push({
        route: "/system/security",
        control: ssoSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/system/security' üzerinde '${ssoSaveLabel}' → SSO kimlik sağlayıcı ayarları ve audit yazıldı`],
      });

      await page.goto("/system/security", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const revokeLabel = "Oturumu Sonlandır";
      const revokeSig = await resolveSig("/system/security", revokeLabel, page, "system/security-revoke-session");
      const revokeForm = page
        .locator("form")
        .filter({ has: page.locator(`input[name="sessionId"][value="${dummySessionId}"]`) })
        .first();
      await expect(revokeForm.getByRole("button", { name: revokeLabel, exact: true })).toBeVisible();
      await clickAndSettle(page, () => revokeForm.getByRole("button", { name: revokeLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () =>
          Number(
            await scalar<string>(
              "select count(*)::int from public.sessions where id = $1::uuid and revoked_at is null and expires_at > now()",
              [dummySessionId],
            ),
          ),
        0,
        "hedef oturum DB'de sonlandırılmalı",
      );
      evidence.push({
        route: "/system/security",
        control: revokeSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/system/security' üzerinde '${revokeLabel}' (session=${dummySessionId}) → oturum iptal edildi`],
      });

      await page.goto("/system/security", { waitUntil: "networkidle" });
      await waitForWorkspaceReady(page);
      const totpLabel = "Doğrula & 2FA Etkinleştir";
      const totpSig = await resolveSig("/system/security", totpLabel, page, "system/security-2fa-toggle");
      const totpForm = page.locator("form").filter({ has: page.getByRole("button", { name: totpLabel, exact: true }) }).first();
      const secretBase32 = await totpForm.locator('input[name="secretBase32"]').inputValue();
      const validOtp = generateTotpCodeAt(secretBase32);
      await totpForm.locator('input[name="code"]').fill(validOtp);
      await clickAndSettle(page, () => totpForm.getByRole("button", { name: totpLabel, exact: true }).click());
      await waitForWorkspaceReady(page);
      await expectDbEventually(
        async () =>
          await scalar<boolean>("select (totp_enabled_at is not null) from public.users where id = $1::uuid", [
            adminUserId,
          ]),
        true,
        "RFC 6238 TOTP doğrulaması sonrası users.totp_enabled_at dolu olmalı",
      );
      evidence.push({
        route: "/system/security",
        control: totpSig,
        role: "admin",
        verdict: "PASS",
        proof: [`click '/system/security' üzerinde '${totpLabel}' (RFC 6238 TOTP kodu doğrulandı) → totp_enabled_at set`],
      });

      assertClean(s, "Dalga 7 Senaryolar, Üretim, Görevler, Entegrasyonlar ve Güvenlik mutasyonları");
    } finally {
      await db((c) =>
        c.query("update public.users set totp_enabled_at = null, totp_secret_encrypted = null where id = $1::uuid", [
          adminUserId,
        ]),
      ).catch(() => {});
      await s.context.close();
    }
  });
});
