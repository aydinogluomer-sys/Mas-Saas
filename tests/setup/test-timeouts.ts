// Süresi test edilen koddan değil BAŞKA bir şeyden gelen testlerin test başına süre sınırları.
//
// ═══ NEDEN GENEL BİR testTimeout YOK ═══
// İncelenmemiş 46541d8 katmanı vitest.config.ts'e `testTimeout: 20000` ekleyip sınırı BÜTÜN testler
// için dört katına çıkarmıştı. Gerçekten yavaş olan bir avuç vakaydı; bedelini iki binden fazla test
// ödüyordu: onlarda 5 sn'yi aşmak gerçek bir yavaşlamanın ya da takılmanın işaretidir ve genel sınır
// bunu 20 sn'ye kadar sessizce yutuyordu. Wave 0 genel sınırı kaldırdı. Testler vitest varsayılanında
// (5 sn) kalır; yalnız aşağıdaki iki sınıftaki vakalar sınıflarının sabitini, ADIYLA ve tek tek,
// üçüncü argüman olarak alır. Yeni bir vakayı bir sınıfa koymanın ölçütü yöntemdir, o günkü süre değil.
//
// ═══ SINIRIN YAPAMADIĞI ═══
// Her iki sınıf da senkron çalışır (`execFileSync`, `readFileSync` + ayrıştırıcı) ve olay döngüsünü
// kilitler: vitest'in zamanlayıcısı ancak iş DÖNDÜKTEN sonra "süre aşıldı" diyebilir. Yani bu sınırlar
// yavaşlığı ölçüp raporlar, hiç dönmeyen bir işi kesemez. Asenkron `execFile` kullanan tek dosya
// (tests/runtime-port-guard.test.ts) çocuğu sınırdan önce kendisi öldürür.

/**
 * Gerçek bir alt süreç başlatan test (node --import tsx, Git Bash, git).
 *
 * Ödenen şey vakanın kendi işi değil, sürecin AYAĞA KALKMASI: soğuk bir tsx modül grafiği, Git Bash
 * ya da git — süitin geri kalanı paralel koşarken. Bu makinede (8 GB RAM) ölçülenler:
 *   tests/p24b-restore-target.test.ts  CASE A        (node --import tsx)  33,2 sn
 *       Wave 0 tabanı, paralel koşu, boş bellek 120–165 MB; dosyanın o zamanki 30 sn'lik sınırında düştü
 *   tests/writer-surface.test.ts       --seed reddi  (node --import tsx)  10,9 sn
 *   tests/dev-reset-safety.test.ts     bayrak + env  (Git Bash)            9,2 sn
 *       ikisi de P1 promotion RC'de 5 sn'lik varsayılanda düştü
 *       (docs/release-evidence/final-production-readiness/p1-promotion-rc/FINAL-P1-PROMOTION-RC.md)
 * Aynı vakalar makine sakinken 0,1–1,4 sn sürüyor; aradaki fark tamamen bellek baskısı. 90 sn, ölçülen
 * en kötünün kabaca üç katı: bir bütçe değil, patolojik bir açılışın tavanı.
 */
export const SUBPROCESS_TEST_TIMEOUT_MS = 90_000;

/**
 * Bütün bir kaynak ağacını (src, src/app, scripts) dosya dosya TypeScript ayrıştırıcısıyla okuyan
 * yapısal test (tests/no-fabricated-figures.test.ts, tests/security/write-gates.test.ts).
 *
 * Süreyi kural belirlemiyor, ağacın büyüklüğü belirliyor: bugün ~480 dosya, her yeni dosyayla artar.
 * Ölçülen en ağırı ("hiçbir kaynak ya da betik kaldırılan modüllere bağlanmaz", src + scripts): tek
 * başına 3,8 sn, tam süit paralel koşarken 7,8 sn — genel sınır kalkınca 5 sn'lik varsayılanda düştü.
 * Diğer dördü tek başına 0,6–2,4 sn. 60 sn, en kötü ölçümün yedi katından fazla: ağacın büyümesine ve
 * alt süreç ölçümlerinde görülen türden bir bellek baskısına yer bırakır; ham metin taramaları
 * (regex, 150 ms altı) bu sınıfa girmez.
 */
export const SOURCE_SCAN_TEST_TIMEOUT_MS = 60_000;
