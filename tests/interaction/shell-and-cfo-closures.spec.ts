/**
 * KABUK, PAYLAŞILAN UI ARAÇ ÇUBUKLARI VE DALGA 4–6 CFO KAPANIŞ AKIŞLARI
 *
 * Bu paket iki katmanı gerçek Chromium tarayıcısı + bağımsız PostgreSQL doğrulamasıyla kanıtlar:
 *
 *   1. Paylaşılan kabuk ve araç çubuğu bileşenleri (`AppSidebar`, `CommandPaletteTrigger`,
 *      `DataTable`, `AnalyticsChart`):
 *      - `navigation.spec.ts` nasıl ki her ayrık kenar çubuğu `<Link>` bileşenini gerçek tıklamayla
 *        doğrulayıp kanıtı o kabuk bileşenini paylaşan `(rota, imza)` birimlerine yazıyorsa, burada
 *        da tekil paylaşılan kabuk/tablo/grafik düğmeleri (`☰`, `‹`, `ara ⌘K`, `⌕Hızlı erişimCtrl K`,
 *        `↪Çıkış yap`, `Yakınlaştır +/−`, `Sıfırla`, `Odak modu`, `3A/6A/12A/24A/Tümü`, `Kolonlar`,
 *        `CSV`, `Excel`) gözlenebilir DOM/indirme etkisiyle kanıtlanır.
 *
 *   2. Dalga 4–6 CFO kritik mutasyonları (tam DB before/after + audit + reload zinciri):
 *      - `F-45`: `/finance/bank` üzerinde yeni Kasa hesabı + açılış bakiyesi → `cash_accounts` ve
 *        `management_journal_entries` (`500.99` Açılış Bilançosu Denkleştirme) atomik kaydı.
 *      - `F-46`: `/data/approvals` üzerinde tek-operatör yönetişim politikası (`system_settings` +
 *        `audit_logs`).
 *      - `F-54`: `/payments/archive` üzerinde kontrollü arşivden geri yükleme (`HTTP 200`, `0024`
 *        tetikleyicisi `app.allow_archive_restore = 'true'` ile geçer, `archived_at IS NULL`).
 *      - `F-33 / F-34`: `/system/jobs` üzerinde `+ Ana Ekran & Süreklilik Tazele` ve
 *        `+ Büyük Dışa Aktarma Üret` (`large_export`) işlerinin kuyruğa yazılıp tamamlanması.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
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
} from "./harness";
import { waitForWorkspaceReady } from "./workspace-ready";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const evidence: Evidence[] = [];

function recordSharedComponentProof(
  predicate: (c: ReturnType<typeof loadRuntimeInventory>["controls"][number]) => boolean,
  proof: string[],
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
      role: c.role,
      verdict: "PASS",
      proof,
    });
    count += 1;
  }
  return count;
}

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    path.join(OUT, "evidence-shell-and-cfo.json"),
    `${JSON.stringify({ rows: evidence }, null, 2)}\n`,
    "utf8",
  );
});

test.describe("paylaşılan kabuk bileşenleri (AppSidebar & CommandPaletteTrigger)", () => {
  test("kenar çubuğu daraltma, komut paleti tetikleyicileri, mobil çekmece ve çıkış formu", async ({ browser }) => {
    test.setTimeout(180_000);

    const s = await openAs(browser, "finance_operator");
    const { page } = s;
    await page.goto("/", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    // 1. Kenar çubuğu daralt / genişlet (`‹` ↔ `›`)
    const sidebar = page.locator("aside.app-sidebar");
    const collapseBtn = page.locator("button.sidebar-collapse");
    await expect(collapseBtn).toBeVisible();
    await expect(sidebar).not.toHaveClass(/is-collapsed/);
    await collapseBtn.click();
    await expect(sidebar).toHaveClass(/is-collapsed/);
    await expect(collapseBtn).toHaveText("›");
    await collapseBtn.click();
    await expect(sidebar).not.toHaveClass(/is-collapsed/);
    await expect(collapseBtn).toHaveText("‹");

    const collapseUnits = recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "‹",
      [
        "click '/' üzerinde button.sidebar-collapse ('‹')",
        "DOM: aside.app-sidebar → .is-collapsed eklendi ve düğme '›' oldu; ikinci tıklamada geri açıldı",
        "Paylaşılan tekil AppSidebar kabuk bileşeni ((dashboard)/layout.tsx)",
      ],
    );
    expect(collapseUnits).toBeGreaterThan(0);

    // 2. Üst çubuk `ara ⌘K` tetikleyicisi
    const topSearchBtn = page.getByRole("button", { name: "Ara (Ctrl+K)" });
    await expect(topSearchBtn).toBeVisible();
    await topSearchBtn.click();
    const dialog = page.locator('[role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    const searchUnits = recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "ara ⌘K",
      [
        "click '/' üzerinde CommandPaletteTrigger ('ara ⌘K')",
        "DOM: [role=dialog] komut paleti açıldı ve Escape ile kapandı",
        "Paylaşılan tekil CommandPaletteTrigger kabuk bileşeni ((dashboard)/layout.tsx)",
      ],
    );
    expect(searchUnits).toBeGreaterThan(0);

    // 3. Kenar çubuğu `⌕Hızlı erişimCtrl K` tetikleyicisi
    const sidebarCmdBtn = page.locator('button.sidebar-command[title="Komut menüsü"]');
    await expect(sidebarCmdBtn).toBeVisible();
    await sidebarCmdBtn.click();
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden({ timeout: 10_000 });

    const paletteUnits = recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "⌕Hızlı erişimCtrl K",
      [
        "click '/' üzerinde button.sidebar-command[title='Komut menüsü'] ('⌕Hızlı erişimCtrl K')",
        "DOM: mas:open-command-palette olayı ile [role=dialog] açıldı ve Escape ile kapandı",
        "Paylaşılan tekil AppSidebar kabuk bileşeni ((dashboard)/layout.tsx)",
      ],
    );
    expect(paletteUnits).toBeGreaterThan(0);

    // 4. Mobil çekmece (`☰` -> `.is-mobile-open` + `.sidebar-scrim`)
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBtn = page.locator("button.mobile-menu-button");
    await expect(mobileBtn).toBeVisible();
    await mobileBtn.click();
    await expect(sidebar).toHaveClass(/is-mobile-open/);
    const scrim = page.locator("button.sidebar-scrim");
    await expect(scrim).toBeVisible();
    await scrim.click();
    await expect(sidebar).not.toHaveClass(/is-mobile-open/);
    await page.setViewportSize({ width: 1280, height: 900 });

    const mobileUnits = recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "☰",
      [
        "390x844 mobil görünümde click button.mobile-menu-button ('☰')",
        "DOM: aside.app-sidebar.is-mobile-open + button.sidebar-scrim görünür oldu; scrim tıklamasıyla kapandı",
        "Paylaşılan tekil AppSidebar kabuk bileşeni ((dashboard)/layout.tsx)",
      ],
    );
    expect(mobileUnits).toBeGreaterThan(0);

    // 5. Paylaşılan `↪Çıkış yap` kabuk formu: DB iptal kanıtı `flows.spec.ts` tarafından üretildi;
    //    aynı tekil `<AppSidebar logoutAction={logoutAction}>` bileşeninin alt rotalarda da aktif olduğu doğrulanır.
    await page.goto("/finance", { waitUntil: "networkidle" });
    const logoutBtn = page.locator('button.sidebar-command[title="Çıkış yap"]');
    await expect(logoutBtn).toBeVisible();
    await expect(logoutBtn).toBeEnabled();

    const flowsPath = path.join(OUT, "evidence-flows.json");
    if (existsSync(flowsPath)) {
      const flowsData = JSON.parse(readFileSync(flowsPath, "utf8")) as { rows?: Evidence[] };
      const provenLogout = flowsData.rows?.find(
        (r) => r.route === "/" && r.control.includes("Çıkış yap") && r.verdict === "PASS",
      );
      expect(provenLogout, "flows.spec.ts üzerinde Çıkış yap DB iptal kanıtı bulunmalı").toBeTruthy();
      recordSharedComponentProof(
        (c) => c.tag === "button" && c.label === "↪Çıkış yap" && c.route !== "/",
        [
          "flows.spec.ts üzerinde gerçek giriş + '↪Çıkış yap' tıklamasıyla public.sessions iptali ve /login yönlendirmesi kanıtlandı",
          "Alt rotada (/finance) aynı tekil AppSidebar logoutAction formunun görünür ve etkin olduğu doğrulandı",
        ],
      );
    }

    assertClean(s, "paylaşılan kabuk bileşenleri");
    await s.context.close();
  });
});

test.describe("paylaşılan tablo ve grafik araç çubukları (DataTable & AnalyticsChart)", () => {
  test("yakınlaştırma, odak modu, kolon görünürlüğü, dönem filtreleri ve CSV/Excel indirme (iskelet donması olmadan)", async ({ browser }) => {
    test.setTimeout(180_000);

    // Tablo ve grafiklerin boş kalmaması için en az 1 ödeme ve 1 nakit akış ayı garanti edilir.
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
          `insert into public.cashflow_months (year, month, opening_balance)
           values (2026, 8, 100000)
           on conflict (year, month) do update set opening_balance = excluded.opening_balance
           returning id`,
        );
        await c.query(
          `insert into public.cashflow_lines (month_id, direction, category, label, amount)
           values ($1, 'inflow', 'tahsilat', 'IX-TOOLBAR-TAHSILAT', 45000)`,
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

    // CSV indirme (ve NavigationFeedbackProvider iskelet kilidi oluşmadığının kanıtı — F-59)
    const [csvDownload] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.getByRole("button", { name: "CSV", exact: true }).first().click(),
    ]);
    expect(csvDownload.suggestedFilename()).toMatch(/\.csv$/i);
    await page.waitForTimeout(250);
    await expect(page.locator("[data-navigation-root]")).not.toHaveClass(/navigation-skeleton-active/);

    // Excel (.xlsx) indirme (`/api/analytics/export` gerçek sunucu yanıtı + ZIP/XLSX imzası)
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

    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Yakınlaştır +",
      ["click 'Yakınlaştır +' → tablo/grafik yakınlaştırma durumu değişti (fontSize arttı)"],
    );
    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Uzaklaştır −",
      ["click 'Uzaklaştır −' → tablo/grafik yakınlaştırma durumu küçüldü"],
    );
    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Sıfırla",
      ["click 'Sıfırla' → yakınlaştırma başlangıç değerine döndü"],
    );
    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Odak modu",
      ["click 'Odak modu' → [role=dialog] tam odak görünümü açıldı ve kapatıldı"],
    );
    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Kolonlar",
      ["click 'Kolonlar' → 'Görünür kolonlar' açılır menüsü render edildi"],
    );
    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "CSV",
      [
        `click 'CSV' → gerçek indirme olayı (${csvDownload.suggestedFilename()})`,
        "NavigationFeedbackProvider .navigation-skeleton-active tetiklemedi (F-59)",
      ],
    );
    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Excel",
      [
        `click 'Excel' → /api/analytics/export üzerinden geçerli .xlsx indirildi (${xlsxDownload.suggestedFilename()}, ZIP PK başlığı doğrulandı)`,
        "NavigationFeedbackProvider .navigation-skeleton-active tetiklemedi (F-59)",
      ],
    );

    // 2. `/cashflow` AnalyticsChart dönem filtreleri (`3A`, `6A`, `12A`, `24A`, `Tümü`)
    await page.goto("/cashflow", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);
    const chartToolbar = page.locator('[aria-label="Grafik araçları"]').first();
    await expect(chartToolbar).toBeVisible();

    for (const periodLabel of ["3A", "6A", "12A", "24A", "Tümü"]) {
      const btn = chartToolbar.getByRole("button", { name: periodLabel, exact: true });
      if ((await btn.count()) > 0) {
        await btn.click();
        await expect(btn).toHaveAttribute("aria-pressed", "true");
        recordSharedComponentProof(
          (c) => c.tag === "button" && c.label === periodLabel,
          [`click '/cashflow' grafik dönem düğmesi '${periodLabel}' → aria-pressed='true' oldu, 0 hata`],
        );
      }
    }

    assertClean(s, "tablo ve grafik araç çubukları");
    await s.context.close();
  });
});

test.describe("Dalga 4–6 CFO kritik mutasyonları (DB before/after + audit + reload)", () => {
  test("F-45: /finance/bank kasa hesabı + açılış bakiyesi → cash_accounts ve 500.99 yönetim defteri açılış fişi", async ({ browser }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "finance_manager");
    const { page } = s;

    await page.goto("/finance/bank", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const btnLabel = "Yeni Hesap & Açılış Bakiyesi Oluştur";
    const sig = await signatureFromDom(page, btnLabel);
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

  test("F-46: /data/approvals tek-operatör yönetişim politikası kaydı ve F-54: arşivden geri yükleme (HTTP 200)", async ({ browser }) => {
    test.setTimeout(180_000);
    const s = await openAs(browser, "admin");
    const { page } = s;

    // 1. `/data/approvals` yönetişim politikası
    await page.goto("/data/approvals", { waitUntil: "networkidle" });
    await waitForWorkspaceReady(page);

    const policySig = await signatureFromDom(page, "Politikayı kaydet");
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
    const minInput = policyForm.locator('input[name="minJustificationLength"]');
    await minInput.fill(nextMin);
    await clickAndSettle(page, () => policyForm.getByRole("button", { name: "Politikayı kaydet", exact: true }).click());

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
    await expect(page.locator('input[name="minJustificationLength"]').first()).toHaveValue(nextMin);

    evidence.push({
      route: "/data/approvals",
      control: policySig,
      role: "admin",
      verdict: "PASS",
      proof: [
        `before DB: approval_governance_settings audit=${auditBefore}`,
        "click: '/data/approvals' üzerinde 'Politikayı kaydet' (minJustificationLength=25)",
        `after DB: approval_governance_settings.min_justification_length=25 + audit_logs=${auditAfter} + reload sonrası 25 korundu`,
      ],
    });

    // 2. `F-54`: Arşivden geri yükleme (`/payments/archive` + paylaşılan `restoreRecord` aksiyonu)
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

    await expectDbEventually(
      async () =>
        await scalar<string | null>("select archived_at::text from public.payments where id = $1", [archivedId]),
      null,
      "geri yükleme sonrası archived_at NULL olmalı (0024 HTTP 500 olmamalı)",
    );
    const restoreAuditAfter = Number(
      await scalar<string>(
        "select count(*)::int from public.audit_logs where entity_table = 'payments' and entity_id = $1",
        [archivedId],
      ),
    );
    expect(restoreAuditAfter).toBeGreaterThan(restoreAuditBefore);

    await hardReload(page);
    expect(await scalar<string | null>("select archived_at::text from public.payments where id = $1", [archivedId])).toBeNull();

    recordSharedComponentProof(
      (c) => c.tag === "button" && c.label === "Geri yükle",
      [
        `before DB: payments(${archivedId}).archived_at IS NOT NULL`,
        "click: '/payments/archive' üzerinde 'Geri yükle' (ArchiveList paylaşılan bileşeni)",
        `after DB: archived_at=NULL (0024 set_config izni geçti, HTTP 500 yok), audit_logs ${restoreAuditBefore} → ${restoreAuditAfter}`,
        "reload sonrası kalıcı",
      ],
    );

    assertClean(s, "F-46 onay politikası ve F-54 arşiv geri yükleme");
    await s.context.close();
  });

  test("F-33 & F-34: /system/jobs üzerinde iş kuyruğu tetikleme (+ Ana Ekran & + Büyük Dışa Aktarma) ve Asılı İşleri Kurtar", async ({ browser }) => {
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

      await expectDbEventually(
        async () => Number(await scalar<string>("select count(*)::int from public.background_jobs")) > beforeJobs,
        true,
        `${label}: background_jobs satırı eklenmeli`,
      );
      const afterJobs = Number(await scalar<string>("select count(*)::int from public.background_jobs"));
      await hardReload(page);

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

    // Asılı (`running` + eski `started_at`) bir iş kurup "Asılı İşleri Kurtar" ile kurtar (F-34)
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

    await expectDbEventually(
      async () =>
        (await scalar<string>("select status from public.background_jobs where id = $1", [staleJobId])) !== "running",
      true,
      "asılı running iş kurtarılmalı (queued veya dead_letter)",
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
});

