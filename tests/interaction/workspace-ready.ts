/**
 * "Çalışma alanı GERÇEKTEN kullanılabilir mi?" — tam ekran açılış perdesi varsa kapanmasını bekle.
 *
 * ═══ NEDEN YAZILDI ═══
 *
 * `8007887` (feat: preload workspace routes on startup) her tam sayfa yüklemesine tam ekran, opak
 * bir perde ekledi (`.workspace-preloader`, `[data-initial-preload]`). `pointer-events: none` yoktu;
 * perde açıkken kontroller DOM'da DURUYOR ama TIKLANAMIYORDU (Playwright "element intercepts
 * pointer events" der). Envanter taraması ve gezinme süpürmesi `goto` + `networkidle` sonrası hemen
 * tıkladığı için, ürün kusursuzken "tıklanamadı" raporu çıkıyordu — bu denetimin tam olarak
 * engellemeye çalıştığı yanlış teşhis.
 *
 * ═══ DURUM (Wave 0) ═══
 *
 * Perde ve arkasındaki rota ısıtması KALDIRILDI (gerekçe: src/components/ui/navigation-feedback.tsx).
 * `[data-initial-preload]` artık hiç render edilmez, dolayısıyla `waitForWorkspaceReady` ANINDA
 * çözülür. Yardımcı yine de duruyor: çağıranlar (mutations.spec.ts, navigation.spec.ts,
 * scripts/qa/runtime-interaction-crawl.ts) değişmeden çalışsın, ve bir perde bir gün geri gelirse
 * denetim onu "tıklanamadı" diye yanlış teşhis etmek yerine kapanmasını beklesin. Beklenen şey yine
 * GÖZLENEBİLİR DURUMDUR (düğümün DOM'da olmaması), sabit bir sleep değil.
 */

import type { Page } from "@playwright/test";

/** Eski perdenin işaretçisi. `navigation-feedback.tsx` bunu artık render ETMEZ; yalnız geri
 * dönüşü yakalamak için burada. */
export const PRELOAD_MARKER = "[data-initial-preload]";

/**
 * Perde varsa kapanana kadar bekle; yoksa (Wave 0'dan beri hep böyle) anında çözülür.
 *
 * `state: "detached"`: perde gizlenmezdi, React tarafından KALDIRILIRDI; düğüm hiç yoksa bekleme
 * hemen biter.
 *
 * Zaman aşımı yutulmaz: perde 45 sn sonra hâlâ duruyorsa bu ölçülmesi gereken bir durumdur
 * (geri gelmiş ve takılmış bir ön yükleme), sessizce devam edip "tıklanamadı" demek değil.
 */
export async function waitForWorkspaceReady(page: Page, timeoutMs = 45_000): Promise<void> {
  await page.locator(PRELOAD_MARKER).waitFor({ state: "detached", timeout: timeoutMs });
}

/**
 * Perde şu anda açık mı? (teşhis/kanıt amaçlı — beklemez; Wave 0'dan beri beklenen cevap `false`)
 *
 * Kanıt satırlarına "perde görüldü mü, ne kadar sürdü" yazabilmek için var; bir testin kararını
 * buna dayandırması gerekmez.
 */
export async function preloadOverlayVisible(page: Page): Promise<boolean> {
  return (await page.locator(PRELOAD_MARKER).count()) > 0;
}
