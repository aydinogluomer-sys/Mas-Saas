import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * ETKİLEŞİM KAPISI — kendi Playwright yapılandırması.
 *
 * ═══ NEDEN AYRI BİR CONFIG, `playwright.config.ts`'e EKLEME DEĞİL ═══
 *
 * Görsel paket `fullyParallel: false, workers: 1` ile koşar ve bunun sebebi ölçümdür: o pakette
 * 50 ms'lik navigasyon onayı ve 200 ms'lik iskelet bütçeleri var, bunlar ancak yüksüz bir makinede
 * anlamlı. Etkileşim kapısının böyle bir zaman bütçesi YOK; onun kısıtı başka: aynı satırları
 * mutasyona uğratan iki test paralel koşarsa birbirinin before/after okumasını bozar. İki paket
 * aynı sebeple değil, FARKLI sebeplerle sıralı olmak zorunda — ve ayrı configler bu iki gerekçeyi
 * ayrı ayrı yazılı tutar. Tek dosyada olsalardı, biri gevşetildiğinde diğerinin gerekçesi sessizce
 * kaybolurdu.
 *
 * ═══ globalSetup NEDEN ZORUNLU ═══
 *
 * Bu kapı, `tests/visual/.auth/*.json` çerez kavanozlarına GÜVENEMEZ. Denetim sırasında birebir
 * şu ölçüldü: kavanozlardaki beş tokenin sha256'sı, veritabanındaki CANLI oturumların hiçbiriyle
 * eşleşmiyordu ve iki rol (manager, admin) 67 rotanın 67'sinde /login'e düştü — paket yine de
 * "0 sorun" raporladı, çünkü /login de geçerli bir sayfadır ve üstünde bir buton vardır. Yani
 * bayat kavanoz, kapsamı SESSİZCE sıfıra indirip yeşil görünebiliyor.
 *
 * globalSetup her koşuda kavanozu siler, beş hesabı GERÇEK /login formundan geçirir ve taze
 * çerezi yazar. Böylece "oturum bayattı" hâli imkânsızlaşır.
 *
 * Kullanım (üretim derlemesine karşı, QA bypass KAPALI):
 *   pnpm build
 *   DATABASE_URL=…/<disposable> PORT=3310 pnpm start
 *   BASE_URL=http://127.0.0.1:3310 MAS_E2E_DATABASE_URL=…/<disposable> pnpm interaction:test
 */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3310";

export default defineConfig({
  testDir: "./tests/interaction",
  globalSetup: "./tests/visual/global-setup.ts",
  // Mutasyon testleri aynı finansal satırlara dokunur; paralel koşmak before/after okumalarını
  // birbirine karıştırır ve YANLIŞ YEŞİL üretir (A'nın yazdığını B "benim click'im yaptı" sanır).
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // Yeniden deneme YOK. Bir mutation testi ikinci denemede geçiyorsa bu "kararsız test" değil,
  // "idempotent olmayan aksiyon" demektir ve tam olarak aramamız gereken şeydir.
  retries: 0,
  timeout: 120_000,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    colorScheme: "dark",
    viewport: { width: 1440, height: 950 },
    storageState: path.join("tests", "visual", ".auth", "admin.json"),
    // İndirme testleri gerçek dosya ister.
    acceptDownloads: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
