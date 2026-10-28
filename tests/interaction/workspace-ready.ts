/**
 * "Çalışma alanı GERÇEKTEN kullanılabilir mi?" — ön yükleme perdesinin kapanmasını bekle.
 *
 * ═══ NE ÖLÇÜLDÜ ═══
 *
 * `8007887` (feat: preload workspace routes on startup) her sayfa yüklemesine tam ekran bir perde
 * ekledi:
 *
 *     .workspace-preloader { position: fixed; inset: 0; z-index: 200; background: …var(--surface-0) }
 *
 * `pointer-events: none` YOK ve arka plan OPAK. Yani perde açıkken:
 *   · viewport'un tamamını kaplar
 *   · altındaki her kontrolün tıklamasını yakalar (Playwright "element intercepts pointer events" der)
 *   · kendi <h1>'ini taşır ("Uygulama hazırlanıyor")
 *
 * Perdenin ömrü kısa değil. `WORKSPACE_PRELOAD_ROUTES` 60 rota içerir, parti boyu 3, ilk parti
 * 4000 ms'ye kadar bekler, sonraki her parti 700 ms, sonda 250 ms:
 *
 *     4000 + 19 × 700 + 250 ≈ 17.5 sn   (en kötü hâl, HER tam sayfa yüklemesinde)
 *
 * Ve `useState({ active: true })` olduğu için perde İLK RENDER'da, yani SSR HTML'inde var. Tarayıcı
 * her `page.goto()`'da sağlayıcıyı yeniden mount eder, dolayısıyla perde her rotada yeniden başlar.
 *
 * ═══ BU NEDEN DENETİMİ BOZAR ═══
 *
 * Envanter taraması ve gezinme süpürmesi `goto` + `networkidle` sonrası hemen DOM okur ve tıklar.
 * Perde açıkken kontroller DOM'da DURUR (arkada render edilirler) ama TIKLANAMAZLAR. Sonuç:
 * ürün kusursuzken "tıklanamadı" raporu — bu denetimin tam olarak engellemeye çalıştığı yanlış
 * teşhis.
 *
 * ═══ NEDEN SLEEP DEĞİL ═══
 *
 * Sabit bir bekleme iki türlü de yanlış olurdu: 17.5 sn beklemek her rotayı gereksiz yavaşlatır
 * (66 rota × 5 rol), kısa beklemek ise yarış bırakır. Burada beklenen şey GÖZLENEBİLİR DURUMDUR —
 * `[data-initial-preload]` düğümünün DOM'dan ayrılması. Perde hiç açılmadıysa (zaten sıcak) bekleme
 * anında çözülür; açıldıysa tam kapandığında çözülür. İkisi de doğru, ikisi de ölçülebilir.
 */

import type { Page } from "@playwright/test";

/** Perdenin işaretçisi. `navigation-feedback.tsx` bu attribute'u perdeye basar. */
export const PRELOAD_MARKER = "[data-initial-preload]";

/**
 * Perde kapanana kadar bekle.
 *
 * `state: "detached"` seçildi çünkü perde React tarafından KALDIRILIR (`{preload.active && …}`),
 * gizlenmez. "hidden" beklemek, düğüm hiç var olmadığında da hemen çözülürdü ve aradaki farkı
 * kaybederdik.
 *
 * Zaman aşımı yutulmaz: perde 45 sn sonra hâlâ duruyorsa bu ölçülmesi gereken bir durumdur
 * (ön yükleme takılmış), sessizce devam edip "tıklanamadı" demek değil.
 */
export async function waitForWorkspaceReady(page: Page, timeoutMs = 45_000): Promise<void> {
  await page.locator(PRELOAD_MARKER).waitFor({ state: "detached", timeout: timeoutMs });
}

/**
 * Perde şu anda açık mı? (teşhis/kanıt amaçlı — beklemez)
 *
 * Kanıt satırlarına "perde görüldü mü, ne kadar sürdü" yazabilmek için var; bir testin kararını
 * buna dayandırması gerekmez.
 */
export async function preloadOverlayVisible(page: Page): Promise<boolean> {
  return (await page.locator(PRELOAD_MARKER).count()) > 0;
}
