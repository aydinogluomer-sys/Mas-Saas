// AŞAMA 10 "Eksik 3" — interactive readiness.
//
// Rehber §15 dört zaman damgası istiyor:
//
//   navigation start → main visible → critical KPI visible → interactive control enabled
//
// ═══ NEDEN BU DÖRT ŞEY BURADA ÖLÇÜLÜYOR, route-slo.ts'te DEĞİL ═══
//
// `scripts/perf/route-slo.ts` SUNUCUYU ölçer: TTFB, tam yanıt, rota başına sorgu sayısı. Orada
// tarayıcı yoktur, çünkü tarayıcı olsa Next'in prefetch'i ölçümü kirletirdi. Ama "main görünür
// oldu", "kritik KPI ekranda", "kullanıcı bir kontrolü GERÇEKTEN kullanabiliyor" soruları
// yalnız tarayıcıda cevaplanabilir: ilk üçü render, dördüncüsü HYDRATION sorusudur ve HTML'in
// gelmiş olması hiçbirini kanıtlamaz.
//
// ═══ HER MİLAT NEYE GÖRE TANIMLANDI (ve neden bu tanım) ═══
//
//   navigation start          `performance.timeOrigin` — yani 0. Bütün süreler ona görelidir.
//   main visible              `main.workspace-content` içinde rotanın KENDİ <h1>'i var ve
//                             yüksekliği > 0. Kabuk her rotada aynıdır; ayırt edici olan sayfanın
//                             kendi başlığıdır, o yüzden milat odur.
//   critical KPI visible      `main` metninde ilk PARASAL büyüklüğün belirmesi ("… TL"). Bir
//                             finans panelinde "ekran geldi" ile "karar sayısı ekranda" aynı şey
//                             değildir; ölçülmesi gereken ikincisidir. Sayı-temelli ekran
//                             (/data/quality) için desen rakama düşer ve bu TABLODA yazılıdır.
//   interactive control       `document.documentElement.dataset.navigationReady === "true"`.
//                             Bunu `NavigationFeedbackProvider`ın useEffect'i yazar; yani işaret
//                             "React bu ağacı hydrate etti" demektir — CommandPalette düğmesi de
//                             aynı ağaçta. TEK BAŞINA yeterli sayılmadı: her rotada düğmeye
//                             GERÇEKTEN tıklanır ve paletin açılması ayrıca doğrulanır. Bayrak
//                             doğru ama düğme ölü olsaydı, sert kapı bunu yakalar.
//
// ═══ EŞİK POLİTİKASI ═══
//
// route-slo.ts ile aynı ayrım. SERT olan şey deterministik: dört milat da GÖZLENDİ mi, sıralama
// tutarlı mı, kontrol gerçekten çalışıyor mu. Wall-clock yalnız cömert bir felaket tavanıyla
// sınırlanır; milisaniye bütçeleri kanıt dosyasına TREND olarak yazılır, testi kırmaz. Bu makine
// 4 çekirdekli bir dizüstü ve ölçüm sırasında Postgres + canlı bir production örneği koşuyor.
//
// Kullanım (route-slo sunucusuyla aynı disposable hedefe karşı; QA bypass KAPALI):
//   BASE_URL=http://127.0.0.1:3280 MAS_E2E_DATABASE_URL=…/<disposable> \
//     pnpm exec playwright test tests/visual/interactive-readiness.spec.ts

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Rehber §15'in rota kümesi. `/radar` kalıcı 301 ile `/payments`e gider (next.config.ts).
 *
 * `kpi` alanı, o ekranda "kritik KPI göründü" milatının NE OLDUĞUNU yazar:
 *   money  parasal büyüklük ("… TL") — bir finans ekranının karar sayısı
 *   digit  sayısal karar (eksik kayıt sayısı, kopya sayısı); /data/quality parasal değildir
 *   none   BU FIXTURE'DA VERİ YOK. Ölçülemeyen milat "geçti" sayılmaz; ölçülmediği YAZILIR.
 *
 * `/cashflow` neden `none`: `scripts/perf/volume.ts` fatura/banka/ödeme/çek üretir ama
 * `cashflow_months` üretmez — bu veritabanında SAYILDI: cashflow_months = 0, loans = 0.
 * Yani /cashflow burada BOŞ DURUM render'ıdır ve öyle raporlanır. Ona parasal bir KPI
 * beklemek olmayan bir şeyi beklemektir; sessizce atlamak ise rehber §30.1'in "hiçbir satır
 * dönmedi → geçti" anti-pattern'idir. Üçüncü yol: milat ÖLÇÜLMEDİ olarak kaydedilir.
 */
const ROUTES: Array<{ href: string; expected: string; kpi: "money" | "digit" | "none" }> = [
  { href: "/overview", expected: "/overview", kpi: "money" },
  { href: "/radar", expected: "/payments", kpi: "money" },
  { href: "/cashflow", expected: "/cashflow", kpi: "none" },
  { href: "/payments", expected: "/payments", kpi: "money" },
  { href: "/finance/bank", expected: "/finance/bank", kpi: "money" },
  { href: "/finance/invoices", expected: "/finance/invoices", kpi: "money" },
  // Veri kalite ekranı parasal değil SAYISAL karar verir (eksik kayıt sayısı, kopya sayısı);
  // ona parasal desen dayatmak, olmayan bir şeyi beklemek olurdu.
  { href: "/data/quality", expected: "/data/quality", kpi: "digit" },
  { href: "/insights/briefing", expected: "/insights/briefing", kpi: "money" },
];

const KPI_PATTERNS = {
  money: "\\d[\\d.]*(?:,\\d+)?\\s*(?:TL|₺)",
  digit: "\\d",
  // Hiçbir zaman eşleşmeyen desen: milat ölçülmez ve bu, satırda açıkça görünür.
  none: "(?!)",
} as const;

/** SERT felaket tavanı: bunu aşan bir ekran yavaş değil, kırıktır. */
const CATASTROPHE_MS = Number(process.env.READINESS_CATASTROPHE_MS ?? 20_000);
/** TREND bütçesi — aşılırsa yalnız kanıta yazılır, test kırılmaz. */
const INTERACTIVE_BUDGET_MS = Number(process.env.READINESS_INTERACTIVE_BUDGET_MS ?? 5_000);

const OUT = path.join("test-results", "interactive-readiness.json");

interface Milestones { mainMs: number | null; kpiMs: number | null; interactiveMs: number | null }
interface Row extends Milestones {
  href: string; landedOn: string; kpi: string;
  controlWorks: boolean; withinBudget: boolean;
}

declare global {
  interface Window { __masReadiness?: Milestones }
}

const rows: Row[] = [];

test.describe.configure({ timeout: 240_000 });

test("her kritik rotada dört milat gözlenir ve kontrol gerçekten çalışır", async ({ page }) => {
  for (const route of ROUTES) {
    // Gözlemci SAYFADAN ÖNCE kurulur. Sonradan kurulan bir gözlemci, ölçmek istediği ilk
    // render'ı zaten kaçırmış olur — `screen-ready.ts`'in `watchScreen` için yazdığı kural.
    await page.addInitScript((pattern: string) => {
      const state: { mainMs: number | null; kpiMs: number | null; interactiveMs: number | null } =
        { mainMs: null, kpiMs: null, interactiveMs: null };
      window.__masReadiness = state;
      const re = new RegExp(pattern);
      let observer: MutationObserver | null = null;
      let timer: number | undefined;
      const check = (): void => {
        const main = document.querySelector("main.workspace-content");
        if (state.mainMs === null && main
          && main.querySelector("h1") && main.getBoundingClientRect().height > 0) {
          state.mainMs = performance.now();
        }
        if (state.kpiMs === null && main && re.test(main.textContent ?? "")) {
          state.kpiMs = performance.now();
        }
        if (state.interactiveMs === null
          && document.documentElement.dataset.navigationReady === "true") {
          state.interactiveMs = performance.now();
        }
        if (state.mainMs !== null && state.kpiMs !== null && state.interactiveMs !== null) {
          observer?.disconnect();
          if (timer !== undefined) window.clearInterval(timer);
        }
      };
      const start = (): void => {
        // MutationObserver render'ı yakalar; `attributes: true` <html> üzerindeki
        // data-navigation-ready yazımını yakalar. Aralık yalnız emniyet ağı.
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        timer = window.setInterval(check, 8);
        check();
      };
      if (document.documentElement) start();
      else document.addEventListener("readystatechange", start, { once: true });
    }, KPI_PATTERNS[route.kpi]);

    await page.goto(route.href, { waitUntil: "domcontentloaded" });

    // Dördüncü milat gelene kadar bekle — gelmezse `waitForFunction` zaman aşımıyla düşer ve
    // bu, "hydration hiç olmadı" demektir: yavaşlık değil, arıza.
    await page.waitForFunction(() => window.__masReadiness?.interactiveMs !== null, undefined,
      { timeout: CATASTROPHE_MS });
    const milestones = await page.evaluate(() => ({ ...(window.__masReadiness as Milestones) }));

    // FONKSİYONEL KANIT: bayrak "hydrate oldu" diyor; düğme gerçekten çalışıyor mu?
    const trigger = page.locator('button[aria-label="Ara (Ctrl+K)"]');
    await trigger.click();
    const palette = page.locator("input[placeholder]").first();
    const controlWorks = await palette.isVisible().catch(() => false);
    await page.keyboard.press("Escape");

    const landedOn = new URL(page.url()).pathname;
    const worst = Math.max(milestones.mainMs ?? 0, milestones.kpiMs ?? 0, milestones.interactiveMs ?? 0);
    rows.push({
      href: route.href, landedOn, kpi: route.kpi, controlWorks,
      mainMs: milestones.mainMs, kpiMs: milestones.kpiMs, interactiveMs: milestones.interactiveMs,
      withinBudget: (milestones.interactiveMs ?? Number.POSITIVE_INFINITY) <= INTERACTIVE_BUDGET_MS,
    });

    /* ── SERT iddialar: deterministik, makineden bağımsız ── */
    expect(landedOn, `${route.href} beklenen sayfaya varmalı`).toBe(route.expected);
    expect(milestones.mainMs, `${route.href}: main görünür olmadı`).not.toBeNull();
    if (route.kpi === "none") {
      // ÖLÇÜLMEDİ — ve bu görmezden gelinmiyor, YAZILIYOR. Fixture bu ekranı besleyen tabloyu
      // doldurmuyor; milat ancak veri yüklü bir hedefte anlamlıdır.
      console.log(`[ölçülmedi] ${route.href}: kritik KPI milatı bu fixture'da ÖLÇÜLEMEZ `
        + "(cashflow_months = 0) — boş durum render'ı ölçüldü.");
    } else {
      expect(milestones.kpiMs, `${route.href}: kritik KPI (${route.kpi}) ekranda belirmedi`).not.toBeNull();
    }
    expect(milestones.interactiveMs, `${route.href}: kontrol etkinleşmedi`).not.toBeNull();
    // Sıralama: KPI, main'den ÖNCE görünemez — ikisi aynı ms'de olabilir (uygulama stream
    // etmiyor, sunucu HTML'i tek parça geliyor), ama ters sıra ölçümün bozuk olduğunu söyler.
    if (milestones.kpiMs !== null) {
      expect(milestones.kpiMs, `${route.href}: KPI main'den önce görünmüş — ölçüm tutarsız`)
        .toBeGreaterThanOrEqual(milestones.mainMs!);
    }
    expect(controlWorks, `${route.href}: komut paleti düğmesi tıklanınca açılmadı`).toBe(true);
    // Felaket tavanı (cömert backstop) — wall-clock bütçesi DEĞİL.
    expect(worst, `${route.href}: felaket tavanı aşıldı`).toBeLessThan(CATASTROPHE_MS);
  }

  // TREND kanıtı: bütçe aşımı testi KIRMAZ, kanıt dosyasına yazılır (rehber §15 "environment
  // aware threshold + trend evidence").
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    measuredAt: new Date().toISOString(),
    baseUrl: process.env.BASE_URL ?? null,
    thresholds: { catastropheMs: CATASTROPHE_MS, interactiveBudgetMs: INTERACTIVE_BUDGET_MS },
    rows,
  }, null, 2), "utf8");
  test.info().annotations.push({ type: "interactive-readiness", description: JSON.stringify(rows) });

  const overBudget = rows.filter((r) => !r.withinBudget);
  if (overBudget.length > 0) {
    console.log(`[trend] ${overBudget.length}/${rows.length} rota interaktif bütçesini aştı `
      + `(${INTERACTIVE_BUDGET_MS} ms): `
      + overBudget.map((r) => `${r.href}=${Math.round(r.interactiveMs ?? -1)}ms`).join(", "));
  }
});

test("SPA geçişinde kabuk zaten etkileşimli kalır — kullanıcı tıklamayı bekletmez", async ({ page }) => {
  // Tam sayfa yüklemesinde dört milat ayrışır (yukarıdaki test). Uygulama içi geçişte kabuk
  // ZATEN hydrate'tir; ölçülmesi gereken şey, geçişin onu YENİDEN ölü hâle getirmediğidir.
  await page.goto("/overview", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.navigationReady === "true");

  const transitions: Array<{ href: string; mainMs: number }> = [];
  // YALNIZ kenar çubuğunda GERÇEKTEN bulunan modül bağlantıları. `(dashboard)/layout.tsx`'in
  // NAV listesi dokuz moduldür; `/finance/invoices` bir ALT sayfadır ve kenar çubuğunda yoktur.
  // İlk sürüm onu tıklamaya çalıştı ve var olmayan bir bağlantıyı bekleyerek zaman aşımına
  // uğradı — ürün hatası değil, spec hatasıydı.
  for (const href of ["/cashflow", "/payments", "/finance", "/data/quality"]) {
    const startedAt = Date.now();
    await page.locator(`.sidebar-link[href="${href}"]`).click({ noWaitAfter: true });
    await page.waitForURL((u) => u.pathname === href, { timeout: 30_000 });
    await page.waitForFunction(() => {
      const main = document.querySelector("main.workspace-content");
      return !!main && !!main.querySelector("h1") && main.getBoundingClientRect().height > 0;
    }, undefined, { timeout: CATASTROPHE_MS });
    transitions.push({ href, mainMs: Date.now() - startedAt });

    // Kontrol geçiş boyunca ETKİN kaldı mı? Bayrak silinmemeli ve düğme çalışmalı.
    expect(await page.evaluate(() => document.documentElement.dataset.navigationReady),
      `${href}: geçişten sonra kabuk etkileşimliliğini kaybetti`).toBe("true");
  }
  await page.locator('button[aria-label="Ara (Ctrl+K)"]').click();
  await expect(page.locator("input[placeholder]").first()).toBeVisible();
  await page.keyboard.press("Escape");

  test.info().annotations.push({ type: "spa-transitions", description: JSON.stringify(transitions) });
});
