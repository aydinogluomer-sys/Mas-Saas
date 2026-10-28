# Faz 3 — Golden UI Smoke kanıtı

**Tarih:** 2026-08-24 · **Branch:** `release/production-readiness-hardening`
**Spec:** `tests/visual/golden-ui-smoke.spec.ts` · **Sonuç: 36/36 PASS** (üç ardışık koşuda aynı)

---

## 1. Veri sınıfı — "golden" kelimesine güvenmeden önce okuyun

| | |
|---|---|
| **Sınıf** | `DISPOSABLE_SYNTHETIC` — **`REAL_READ_ONLY` DEĞİL** |
| Veritabanı | `mas_radar_ui_golden_clone` |
| Cluster | `mas-radar-pg-faz3-sandbox`, port **55434** (izole; `mas_radar_dev` bu cluster'da YOK) |
| Ledger | `87 / 0087` (gerçek `pnpm db:migrate` runner'ı ile) |
| Veri kaynağı | `pnpm seed:demo` |

Plan §6.1 `pg_dump mas_radar_dev → restore → pnpm db:migrate → 0087` istiyor. **Bu çalıştırılmadı**,
çünkü gerçek veritabanının kimlik bilgisi bu harness'a kasten verilmedi. Onun yerine aynı kaynak
çalışma dosyasını işleyen `seed:demo` kullanıldı; başlık sayıları gerçek taban çizgisiyle örtüşüyor:

```text
payments = 19 · checks = 7 · loans = 1 · cashflow_months = 35
```

Gerçek aritmetiği çalıştırmaya yeter; **birebir-klon kapısının yerine geçmez**. O kapı hâlâ gerçek
kimlik bilgisine sahip birinin çalıştırması gereken ayrı bir iştir. Buradaki PASS, o kapının
geçildiği anlamına **gelmez**.

## 2. Kritik rota seti — 24/24 mevcut, ikame yok

Planın §6.3 listesindeki 24 rotanın **tamamı** `src/app/(dashboard)/…/page.tsx` olarak var; hiçbiri
için "en yakın eşlenik" uydurmak gerekmedi. Dördü kalıcı 301:

```text
/radar      -> /payments             /reports    -> /insights/reports
/financing  -> /finance              /reminders  -> /insights/reminders
```

Spec `expected` sütununda hedefi açıkça yazıyor: istenen yolu iddia etmek dört doğru yönlendirmeyi
düşürürdü, kontrolü kaldırmak ise `/login`'e yönlendirmeyi görünmez yapardı.

## 3. Uygulanan assertion'lar (§6.4)

Her rota için, §5.3 sırasıyla:

| Sınıf | Kontroller |
|---|---|
| HTTP/runtime | status 200 · 3xx döngüsü yok (son URL sabit) · 5xx alt istek yok · pageerror yok · console.error yok · hydration hatası yok · takılı navigasyon yok |
| Auth | `/login`'e düşmüyor · yetkisiz kabuk yok · doğru rol görüyor · yanlış rol reddediliyor · nav bağlantısı rol bazlı · direct URL rol bazlı · **rol DB'de değişince aynı oturum yeni rolü kullanıyor** |
| İçerik | ana başlık var ve boş değil · boş kabuk değil (`<main>` > 80 karakter) · en az bir veri/KPI yüzeyi · `NaN` yok · `Infinity` yok · `undefined` yok · beklenmedik `0` yok (§5'teki gerekçeli sıfır) |
| Görsel | sayfa yüksekliği makul (400px < h < 60.000px) · yatay taşma ≤ 2px (tablo/kart kırılmıyor) · **screenshot kaydı** her rota için ek olarak iliştiriliyor |

**Screenshot karşılaştırılmıyor, KAYDEDİLİYOR.** `docs/visual-snapshot-policy.md` insan incelemesi
olmadan baseline üretmeyi yasaklıyor; 24 yeni baseline basmak o politikayı ihlal ederdi. Bunun
yerine her koşu kendi kanıtını ek olarak taşıyor.

`/system/controls` bu sette rol kısıtı olan **tek** rota (`finance_manager`, `admin`). Diğer 23'ü
beş katmana da açık — `rolesAllowedOn()` ile bir kez ölçüldü ve spec'e **yazıldı** (import
edilmedi: `canAccessRoute()`'u import etmek, tarayıcıya modülün zaten inandığı şeyi doğrulatırdı ki
bu tam da guard'ı çağırmayı unutan sayfayı yakalayamayan kontroldür).

## 4. DB ↔ UI parasal spot-check (§6.5) — 12 değer, exact equality

Beklenen taraf **owner** bağlantısıyla, uygulamanın sorgu katmanından geçmeden okundu.
Karşılaştırma, belgelenmiş görüntüleme kuralından (`fmtTL` = tr-TR, 0 ondalık, `" TL"`) geçirilen
**tam sayı** üzerinden yapılıyor — parsed float karşılaştırması planın yasakladığı toleransı geri
getirirdi.

| # | Değer | Bağımsız SQL | Ekran |
|---|---|---:|---|
| 1 | bugünkü açık ödeme yükü | `30.000` | /payments |
| 2 | 7 günlük çıkış | `145.000` | /payments |
| 3 | gecikmiş portföy | `710.000` | /payments |
| 4 | gecikmiş kayıt adedi | `29` | /payments |
| 5 | en kötü ay bakiyesi | `-3.064.608` | /cashflow |
| 6 | negatif ay adedi | `31` | /cashflow |
| 7 | runway ayı | `2026-09` | /cashflow |
| 8 | aktif çek adedi (arşivli hariç) | `6` | /finance/checks |
| 9 | kredi anaparası | `1.500.000` | /finance/loans |
| 10 | toplam taksit | `3.443.718` | /finance/loans |
| 11 | finansman maliyeti | `1.943.718` | /finance/loans |
| 12 | açık alacak + gerekçesi | `0` (fatura sayısı `0`) | /finance/receivables |

## 5. Yol boyunca yakalanan üç kusur — üçünde de haklı olan ÜRÜNDÜ

**(a) "BUGÜN" brüt değil, KALAN tutarı gösteriyor.** İlk sorgum `sum(amount)` ile 50.000 buldu, ekran
30.000 diyordu. Bugün vadesi gelen tek kalem 50.000 ve 20.000'i ödenmiş (`status='partial'`,
`paid_amount=20000`). Doğru tanım `sum(amount - coalesce(paid_amount,0))` — yani hâlâ borçlu olunan.
Ürün doğruydu, sorgu yanlıştı. Aynı düzeltme 7 günlük çıkışı da 165.000'den 145.000'e getirdi.

**(b) Çek sayısı 7 değil 6 gösteriliyor — ve bu doğru.** Tabloda 7 satır var, biri arşivli. Ekran
aktif portföyü gösteriyor. Spec artık `archived_at is null` ile 6 bekliyor ve fixture'ın gerçekten
bir arşivli çek taşıdığını ayrıca doğruluyor; 7 görünmeye başlarsa arşivlenmiş bir enstrüman canlı
portföye geri dönmüş demektir ki bu kozmetik değil finansal bir kusurdur.

**(c) `.instant-navigation-skeleton` kalıcı bir düğüm.** "Takılı navigasyon" kontrolünü
`toHaveCount(0)` ile yazmıştım; 24 sağlıklı rotanın hepsinde düştü. Ölçüldü: yerleşmiş sayfada
`count=1, display:none, visible=false`. Doğru iddia "gösterilmiyor olmalı" — `not.toBeVisible()`.

## 6. En önemli bulgu — spot-check'in kendisi sessizce yalan söylüyordu

Beklenen değerler ilk sürümde `MAS_E2E_DATABASE_URL` (yani `mas_radar_app`) üzerinden okunuyordu.
O rol **RLS'e tabi** ve katman bağlamı verilmediğinde **hiçbir şey görmüyor**. Aynı veritabanında
yan yana ölçüm:

```text
owner (postgres):  checks = 7   gecikmiş payment_instances = 29
mas_radar_app:     checks = 0   payment_instances          = 0
```

Buna rağmen üç spot-check **PASS** raporluyordu: sıfır satır üzerinden toplam 0, `fmtTL(0)` = `"0 TL"`
ve `"0 TL"` neredeyse her ekranda geçiyor. Yani mutabakat sıfırı sıfırla karşılaştırıp "uyuştu"
diyordu. **Bu, mutabakat olmamasından daha kötüdür** — arkasında hiçbir şey olmayan bir yeşil ışık.

İki düzeltme yapıldı:
1. Beklenen taraf artık `MAS_E2E_OWNER_DATABASE_URL` (owner) ile okunuyor — hem doğru, hem de
   doğrulanan katmandan gerçekten bağımsız.
2. `beforeAll` içinde ground-truth boşsa **sert hata**: `payment_instances`, `checks`,
   `cashflow_months` sıfırsa paket çalışmadan durur. Aynı kaza bir daha sessizce yeşile dönemez.

## 7. Faz 3 PASS kriterleri

| Kriter | Sonuç |
|---|---|
| critical route semantic smoke = 100% | **24/24** |
| critical monetary spot checks = 100% | **12/12 değer, exact equality** |
| unexplained blank page = 0 | **0** — her rotada başlık + veri/KPI yüzeyi |
| unexplained console/page error = 0 | **0** — console.error, pageerror, 5xx, hydration ayrı ayrı |
| unauthorized access = 0 | **0** — `/system/controls` üç düşük katmana kapalı; rol düşürülünce aynı oturum yeni rolü kullanıyor |

Toplam **36/36 PASS**, üç ardışık koşuda aynı. Aynı clone üzerinde Faz 1/2 paketleri de yeşil:
`legacy-semantic-smoke` **10/10**, `phase17-38-routes` **94/94**.

## 8. Açık kalan

- **Birebir gerçek klon kapısı çalıştırılmadı** (kimlik bilgisi yok). Faz 3'ün bu çalıştırması
  sentetik-ama-gerçekçi klon üzerindedir ve öyle etiketlenmiştir.
- Spec CI'da **koşmuyor**: gerçek sunucu + veri taşıyan klon gerektiriyor. CI'daki karşılığı
  boş-veritabanı `legacy-semantic-smoke` job'udur.
