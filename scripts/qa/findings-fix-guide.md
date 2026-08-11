# MAS Nakit Radar — Tespit Edilen Sorunlar ve Düzeltme Rehberi

Bu dosya, önceki iki denetim turunda (motor/UI eşleşme taraması + `scripts/qa/browser_crawl.py` gezintisi) bulunan **5 gerçek bulguyu** tek tek çıkarır ve her biri için somut, dosya/fonksiyon seviyesinde bir çözüm adımı verir. Öncelik sırasına göre dizilmiştir. Kod burada yazılmadı — bu, bir sonraki uygulama turu için rehber.

---

## Bulgu #1 — Çekler ve kredi taksitleri asla "tahsil edildi / karşılıksız / ödendi" işaretlenemiyor

**Önem: Yüksek** — CLAUDE.md'nin on ana hedefinden ikisini ("çekler/vade riski", "krediler/taksitler") doğrudan etkiliyor.

### Sorun
- `checks.status` enum'u `planned/cleared/bounced/cancelled/unknown` içeriyor, `loan_installments.status` `planned/unpaid/partial/paid/late/cancelled` içeriyor — şema tamamen hazır.
- Ama `src/lib/financing/engine.ts`'de yalnız `cancelCheck`/`cancelLoanInstallment` var. `markCheckCleared`, `markCheckBounced`, `markInstallmentPaid` gibi bir fonksiyon **hiç yazılmamış**.
- DB tetikleyicileri (`checks_status_transition_guard`, `loan_installments_status_transition_guard`, migration `0027`) yalnız `planned→cancelled`'a izin veriyor.
- Somut kanıt: gerçek `mas_radar_dev`'de 7 çekin 7'si, 48 taksitin 48'i hâlâ `status='planned'`. Kredi detayında gösterilen "ödenen taksit" sayacı (`paid_count`, `financing/engine.ts:379`) `count(*) filter (where status='paid')` — yazan yol olmadığı için **her zaman 0**.
- Orijinal tasarım (implementation.md:1320) `check_events.event_type`'a zaten `cleared`/`bounced` koymuştu — bu baştan planlanmış, hiç inşa edilmemiş.

### Çözüm adımları

**1) Yeni migration** (`supabase/migrations/00XX_check_installment_settlement.sql`) — `payment_instances_status_transition_guard`'ı 0033'te genişlettiğimiz desenin aynısı:

```sql
-- checks_status_transition_guard: 'planned'den 'cleared'/'bounced'e de izin ver
if (old.status, new.status) not in (
  ('planned', 'cancelled'),
  ('planned', 'cleared'),
  ('planned', 'bounced')
) then ...

-- loan_installments_status_transition_guard: gerçekçi taksit yaşam döngüsü
if (old.status, new.status) not in (
  ('planned', 'cancelled'),
  ('planned', 'paid'),
  ('planned', 'late'),
  ('late', 'paid'),
  ('late', 'cancelled')
) then ...
```
`create or replace function` ile idempotent yaz (0033'ün aynı deseni).

**2) `src/lib/financing/engine.ts`'e üç fonksiyon ekle** — `cancelCheck`/`cancelLoanInstallment`'ın birebir aynı iskeleti (transaction, `for update`, allow-list Set + `DomainError`, `audit()`):

```ts
const CHECK_SETTLEABLE_FROM = new Set(["planned"]);
const LOAN_INSTALLMENT_PAYABLE_FROM = new Set(["planned", "late"]);

export async function markCheckCleared(pool, checkId, actorId) { ... status='cleared' ...
  // + check_events'e 'cleared' olayı yaz (mapAcceptedChecks'in 'created' yazma deseniyle aynı)
}
export async function markCheckBounced(pool, checkId, actorId) { ... status='bounced' ... + check_events 'bounced' }
export async function markInstallmentPaid(pool, installmentId, paidAt, actorId) { ... status='paid', paid_at=$2 ... }
```

**3) `src/app/(dashboard)/finance/actions.ts`'e server action'lar ekle** (`createCheckAction`'ın yanına):
`markCheckClearedAction`, `markCheckBouncedAction`, `markInstallmentPaidAction` — `requireSession()` ilk satırda, `DomainError` yakalama deseni `radar/actions.ts`'teki gibi.

**4) UI** — `src/app/(dashboard)/finance/checks/page.tsx`'e (şu an salt-okunur) ve `src/app/(dashboard)/financing/loans/[loanId]/page.tsx`'e (taksit satırlarına) `instance-row.tsx`'teki "iptal" formunun yanına "tahsil edildi"/"karşılıksız"/"ödendi" formları ekle — aynı `<form action={...}><input type="hidden" name="id".../><button>...</button></form>` deseni.

**5) Test** — `scripts/db/transitions-verify.ts`'e `CHECK_ALLOWED`/`LI_ALLOWED`'a yeni satırları ekle (0033'te `PI_ALLOWED` için yaptığımızın aynısı) + tam matris testi otomatik yeni geçişleri doğrular.

**6) Doğrulama** — düzeltme sonrası gerçek `mas_radar_dev`'de kredi detayına gidip birkaç geçmiş taksidi "ödendi" işaretle; `paid_count` artık 0 değil gerçek sayıyı göstermeli.

**Gate:** typecheck, lint, vitest, `db:verify`, `db:transitions:verify`, yeni migration `db:migrate:dev` ile `mas_radar_dev`'e uygulanmadan önce disposable DB'de doğrulanmalı (bu oturumdaki 0033 disiplini).

---

## Bulgu #2 — Kaybolmuş panel: "teorik vs gerçek gelir"

**Önem: Orta** — Phase 7'de vardı, UI yeniden yapılanmasında kayboldu; motor hâlâ sağlam.

### Sorun
`src/lib/production/engine.ts`'teki `loadActualMonthlyIncome` fonksiyonu hâlâ doğru ve `phase7-verify.ts` onu hâlâ doğruluyor, ama `/production`, `/production/capacity`, `/production/costs`, `/production/profitability`, `/production/roi` sayfalarının **hiçbirinde** kullanılmıyor.

### Çözüm
`src/app/(dashboard)/production/capacity/page.tsx`'e (kapasite kullanımı zaten burada gösteriliyor, en doğal yer) bir `KpiCard` ekle:
```ts
const actual = await loadActualMonthlyIncome(pool);
// capacity modelinden theoretical_monthly_revenue zaten yükleniyor — yan yana göster
<KpiCard label="Teorik gelir" value={fmtTL(theoretical)} />
<KpiCard label="Gerçek gelir" value={fmtTL(actual)} tone={actual != null && theoretical != null && actual < theoretical ? "warn" : "pos"} />
```
Motor/migration değişikliği yok — yalnız ekleyici bir UI değişikliği. Düşük risk.

---

## Bulgu #3 — `calculateMachineRoiSnapshot`: kullanılmayan motor fonksiyonu — **DONE (seçenek B, commit 2185d03)**

**Önem: Düşük** — ürün kararı verildi: elle ROI girişi istenmiyor, ölü kod kaldırıldı.

> **Karar notu:** Seçenek A yalnız "form ekle" değildi. `calculateMachineRoiSnapshot` denetim kaydı yazmıyordu ve `actorId` almıyordu (`mapMachineRoi` yazıyor), yani A finansal bir tabloya denetlenmeyen bir yazma yolu açardı. Ayrıca gerçek ROI kaynak sekmesi `personal_data_mixed` incelemesiyle **bilerek** bloklu; elle giriş formu tam olarak o kapının yanına ikinci bir kapı olurdu.
>
> **Kabul edilen ödün:** `seed-demo.ts`'in her makine×yıl için manuel snapshot yazan ikinci geçişi kalktı; workbook yolu bloklandığında demo artık ROI göstermiyor (üretimin gerçekte gösterdiğiyle aynı).
>
> **Açık kalan:** Kodu kaldırmak, onun daha önce yazdığı satırları silmez. `mas_radar_dev`'de 8 demo ROI snapshot'ı (2025/2026 × 4 makine) duruyor ve `/production/roi`'de gerçek veriymiş gibi görünüyor. Gerçek veritabanından satır silmek kullanıcı kararıdır.

### Sorun
Tam işlevli, doğru yazılmış bir fonksiyon (`src/lib/production/engine.ts`) var ama hiçbir form/buton onu çağırmıyor; yalnız `seed-demo.ts` ve `phase7-verify.ts` kullanıyor. Gerçek yol yalnız `mapMachineRoi` (workbook'tan içe aktarma).

### İki seçenek — birini seçin

**A) UI ekle (elle ROI girişi isteniyorsa):** `/production/roi`'ye admin-only bir form ekle (yıl/gelir/maliyet/vergi), yeni bir `enterMachineRoiAction` server action'ı `calculateMachineRoiSnapshot`'ı çağırsın. `needs_review` confidence zaten motor tarafında garanti.

**B) Ölü kodu temizle (yalnız içe aktarım isteniyorsa):** `calculateMachineRoiSnapshot`'ı `engine.ts`'den, `seed-demo.ts`'deki çağrısını (`mapMachineRoi` tabanlı seed'e çevirerek), ve `phase7-verify.ts`'deki testini kaldır. Kod tabanını "gerçekten var olan" özelliklerle tutarlı tutar.

**Öneri:** Karar öncesi kullanıcıya sorulmalı — "elle ROI girişi gerçekten isteniyor mu?" Bu belirsiz bir ürün sorusu, tahmin edilmemeli.

---

## Bulgu #4 — Çalışması için ek kurulum adımı gereken özellikler — **DOĞRULANDI (2026-08-11)**

**Önem: Bilgilendirici** — kod hatası değil, operasyonel adım eksikliği. Kod değişikliği yapılmadı; üç madde de tek tek **davranışsal olarak kanıtlandı**.

> **Doğrulama sonucu (atılabilir DB kopyasında, gerçek admin oturumuyla):**
>
> | Madde | Ortam | Kanıt |
> |---|---|---|
> | AI soru-cevap | `OPENAI_API_KEY` bu ortamda **ayarlı** (rehberin "yok" varsayımı geçerli değil) | Anahtarsız dalı dış çağrı yapmadan kanıtlamak için `AI_FORCE_DETERMINISTIC=1` kullanıldı — `callOpenAI` aynı şekilde `null` döner. UI'dan sorulan soru `ai_response_snapshots`'a `response_mode=deterministic`, `model=NULL` olarak yazıldı; sayfa çökmedi, konsol hatası 0. |
> | Telegram | `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` **boş** | "Bekleyenleri gönder" → 5 bekleyen teslimat `failed`'a döndü, her biri `error='TELEGRAM_BOT_TOKEN/CHAT_ID tanımlı değil'` ve `sent_at=NULL`. Sessiz "sent" yok. |
> | seed-admin.ts | — | `--password` argv'den **reddediliyor** (exit 1, "shell geçmişinde/process listesinde görünür"); TTY yokken maskeli giriş yerine açık hata (exit 1); 12 karakterden kısa parola reddediliyor (exit 1). Üç denemede de hesap oluşmadı. |
>
> **Not:** `OPENAI_API_KEY` ayarlı olduğu için bu ortamda AI gerçek model çağrısı yapar ve şirketin finansal bağlamını dışarıya gönderir. Doğrulama sırasında bilinçli olarak dış çağrı yapılmadı.

| Özellik | Gereken adım |
|---|---|
| AI soru-cevap (gerçek yanıt) | `.env.local`'a `OPENAI_API_KEY=...` ekle, sunucuyu yeniden başlat. Yoksa deterministik fallback'e düşer (çökmez, dürüst). |
| Telegram hatırlatmaları | BotFather'dan bot oluştur → `TELEGRAM_BOT_TOKEN`; hedef sohbetin chat ID'sini al → `TELEGRAM_CHAT_ID`; `.env.local`'a ekle. Yoksa 'failed' olarak dürüstçe loglanır. |
| İlk admin hesabı | `tsx scripts/db/seed-admin.ts --username admin --display-name "Admin"` (tek seferlik, CLI'dan). UI'dan self-servis oluşturulamaz — bilinçli tasarım (public signup yok). |

---

## Bulgu #5 — Eski `/financing/loans/[id]` ve `/imports/[workbookId]/*` rotaları kanonik rotalara yönlenmiyor — **DONE (commit a4a8d1e + c0f9c1c)**

**Önem: Düşük** — sayfalar çalışıyor, veri doğru; yalnız URL/tutarlılık meselesi.

> **Çözüldü.** Alternatif ("yalnız h1 ekle, URL'leri bırak") seçilmedi; tam redirect altyapısı kuruldu.
>
> - `/financing/loans/:loanId` → `/finance/loans/:loanId` (a4a8d1e). Gerçek kredi id'siyle 308 + doğru `Location` doğrulandı; yönlendirme sonrası sayfa kanonikle birebir aynı (h1, 5 KPI, 48 taksit satırı, 47 "ödendi" butonu).
> - `/imports/:workbookId`, `.../reviews`, `.../sheets/:sheetId` → `/data/imports/...` (c0f9c1c). Kanonik konum **önce yaratıldı** (üç 1-satırlık re-export, `default` ile birlikte `dynamic` de aktarılıyor — kaynak sayfaların üçü de `force-dynamic`), sonra üç redirect eklendi. Gerçek workbook/sheet id'leriyle 3×308 + 3×200 doğrulandı, içerik uzunlukları birebir eşleşti.
>
> **Açık kalan (isteğe bağlı temizlik):** Uygulama içinde hâlâ **11 link, 8 dosyada** eski `/imports/...` yolunu gösteriyor — `/data/imports` liste sayfasındaki workbook linki dâhil. Hepsi çalışıyor (her biri bir 308 sıçraması yapıyor). Kanonik yollara çevirmek ayrı ve isteğe bağlı bir iş; routing değişikliğine dâhil edilmedi.

### Kök neden (kesin — kaynak kodda doğrulandı)
`next.config.ts`'nin `redirects()`'i `/financing` ve `/imports` için **yalnız liste sayfasını** yönlendiriyor (`{ source: "/financing", destination: "/finance" }`), `/reports` için yapıldığı gibi **dinamik alt-rotayı** (`/reports/:reportId`) kapsamıyor:

```ts
// next.config.ts — MEVCUT (eksik)
{ source: "/financing", destination: "/finance", permanent: true },
{ source: "/imports", destination: "/data/imports", permanent: true },
// /reports İÇİN VAR AMA /financing VE /imports İÇİN YOK:
{ source: "/reports/:reportId", destination: "/insights/reports/:reportId", permanent: true },
```

### Çözüm — `/financing/loans/[id]` (kolay, sıfır risk)
`src/app/(dashboard)/finance/loans/[loanId]/page.tsx` **zaten** `/financing/loans/[loanId]/page.tsx`'in ince bir yeniden-export'u (`system/features`→`phases` ile aynı desen) — yani içerik, iptal butonu dahil, zaten birebir aynı. Tek eksik olan `next.config.ts`'e satır eklemek:

```ts
{ source: "/financing/loans/:loanId", destination: "/finance/loans/:loanId", permanent: true },
```

Bu kadar. Fonksiyon kaybı riski yok (aynı component iki route'tan da render ediliyor).

### Çözüm — `/imports/[workbookId]` ve alt sayfaları (biraz daha iş)
Bunların **kanonik bir eşdeğeri yok** (`/data/imports/` altında yalnız liste sayfası var, detay sayfası hiç yok) — bu yüzden doğrudan yönlendirilemez. Aynı re-export deseniyle önce kanonik konumu yaratmak gerekiyor:

1. `src/app/(dashboard)/data/imports/[workbookId]/page.tsx` yarat: `export { default, dynamic } from "@/app/(dashboard)/imports/[workbookId]/page";`
2. Aynısını `reviews` ve `sheets/[sheetId]` için tekrarla.
3. `next.config.ts`'e 3 redirect satırı ekle (`/imports/:workbookId` → `/data/imports/:workbookId`, vb.).

**Alternatif (daha düşük efor):** Yönlendirme yerine, yalnız bu 4 sayfaya `PageHeader`/`<h1>` ekleyip tasarım sistemine uydur, URL'lerini olduğu gibi bırak — eğer bu rotaları "eski" saymak öncelikli değilse.

### Doğrulama
`curl -sI http://localhost:PORT/financing/loans/{gerçek-id}` → `308` ve `Location: /finance/loans/{id}` beklenir. `pnpm build` sonrası `next.config.ts` redirects tablosunu build çıktısında kontrol et.

---

## Öneri sırası

1. **#1** (çek/taksit ayarlama) — en yüksek etki, tek başına bir "faz" büyüklüğünde (migration + motor + UI + test).
2. ~~**#5'in `/financing/loans/[id]` kısmı**~~ — **DONE** (a4a8d1e), 1 satırlık redirect.
3. ~~**#2** (gerçek gelir paneli)~~ — **DONE** (66ed07c).
4. ~~**#3**~~ — **DONE**, karar seçenek B: ölü kod kaldırıldı (2185d03) + veri kalıntısı temizlendi (43cadea).
5. ~~**#5'in `/imports/*` kısmı**~~ — **DONE** (c0f9c1c). "Yalnız h1 ekle" alternatifi seçilmedi; kanonik rotalar yaratılıp tam redirect kuruldu.
6. ~~**#4**~~ — **DOĞRULANDI** (dc67b58), kod değişikliği gerekmedi.

7. ~~**#6**~~ — **DONE** (7bc9a13 + 4ecaea7), karar: ayrı KPI'lar.

**Kalan açık iş (ikisi de isteğe bağlı):** #5'in link temizliği (11 link, 8 dosya — hepsi 308 üzerinden çalışıyor) ve aşağıdaki `PageHeader action` gözlemi.

---

## Bulgu #6 — Kapasite açığı hesaplamasında yıl/ay birim uyumsuzluğu — **DONE (commit 7bc9a13 + 4ecaea7)**

**Önem: Düşük-Orta** — sayı yanlış değil, karşılaştırma yanlıştı. Önce bayraklandı (222d604), sonra kaldırıldı.

> **Karar: seçenek 3 — iki periyot ayrı KPI olarak yan yana, aralarında çıkarma/bölme YOK.**
> Talebi 12'ye bölmek ya da kapasiteyi 12'yle çarpmak, işletmenin hangi periyotta planladığına dair
> bir tahmin olurdu ve bu tahmin sonuçta görünmezdi.
>
> **Üçüncü çağrı noktası (bu turda keşfedildi):** `src/lib/analytics/snapshots.ts`'deki
> `collectMetricSnapshots` aynı hatalı oranı `capacity_utilization` metriği olarak **kalıcı
> yazıyordu**. Hiçbir önceki raporda yoktu. Metrik tamamen kaldırıldı (Bulgu #3'ün seçenek-B
> mantığı: yanlış tek sayı üreten kaynağı yamamak yerine kaldır).
>
> **Veri kalıntısı temizliği:** `mas_radar_dev`'de 8 haftalık snapshot (2026-05-29 … 2026-07-17)
> `37.8605` (=%3786) değerini taşıyordu; `metric_key`'e scoped silindi, 8 satırın tamamı
> `audit_logs.before_data`'da kanıt olarak duruyor (4ecaea7).
>
> **Yapılanlar:** `loadCapacityDemand` alan adı `demandMinutes` → `demandMinutesPerYear` (SQL aynı;
> amaç periyodu çağrı yerinde görünür kılmak) · `/production/capacity` "Açık / fazla" kartı
> kaldırıldı, kalan iki kart "Etkin dakika (aylık)" / "Talep dakika (yıllık)" olarak etiketlendi ·
> `/production` "Kapasite kullanımı" kartı ve ölü girdileri kaldırıldı.
>
> **phase7-verify'a neden yeni assertion eklenmedi:** Bu değişiklikten sonra doğrulanacak tek bir
> "doğru oran" kalmadı — düzeltmenin özü zaten o tek sayıyı üretmemek. Mevcut iddia (talep = kaynak
> G5+H5) korundu ve geçiyor. `phase7-verify.ts` promptta listelenmeyen **4. çağrı noktasıydı**;
> yeniden adlandırmanın derlenmesi için güncellendi.
>
> **Dokunulmayan:** `production/rules.ts`'teki `utilizationRate`/`capacityGap` saf fonksiyonları
> duruyor (testleri var, açık argüman alıyorlar — hata onlarda değil, çağıranların ne verdiğindeydi).
> Artık üretim çağıranları yok.

### Sorun
`loadCapacityDemand()` (`src/lib/production/engine.ts`) `production_parts` üzerinden `quantity×(torna+freze)` topluyor. Bu, kaynak Excel'in G5/H5 dakika toplamları — `docs/import-mapping.md §5`'e göre I8'in **yıllık** teorik toplam olarak özetlediği rakam (≈18,57M).

Buna karşı `capacity_models.monthly_minutes` (K8, **aylık**) doğrudan çıkarılıyor/bölünüyor:
- `src/app/(dashboard)/production/capacity/page.tsx` → `gap = available - demand.demandMinutes`
- `src/app/(dashboard)/production/page.tsx` → `utilization = demand.demandMinutes / capacity`

Gerçek veride: talep 1.199.420 (yıllık) vs etkin 31.680 (aylık) → **−1.167.740 açık / %3786 kullanım**. Aylık-aylık karşılaştırma ≈ **−68.272** verir; hâlâ ciddi bir açık ama ~12× daha küçük.

### Neden şimdi düzeltilmedi
Hangi normalizasyonun doğru olduğu bir ürün/veri kararı: talebi 12'ye mi bölmeli, etkin dakikayı 12'yle mi çarpmalı, yoksa "yıllık talep" ve "aylık talep" ayrı iki KPI olarak mı gösterilmeli? Kullanıcıların halihazırda okuyor olabileceği bir sayıyı sessizce yeniden ölçeklemek, `docs/database-schema.md`'nin yasakladığı sessiz düzeltme olurdu.

### Şu anki durum
Her iki kart da değerini **aynen** koruyor ve amber `birim uyumsuz` rozeti + "talep yıllık toplam, etkin dakika aylık — birebir kıyaslanamaz" notu taşıyor. Hesaplamanın yapıldığı yerde de aynı açıklama yorum olarak duruyor.

### Çözüm için gereken
1. Ürün kararı: hangi periyot esas alınacak.
2. Karar sonrası `loadCapacityDemand`'e açık bir periyot semantiği (ör. `demandMinutesPerYear` + `demandMinutesPerMonth`) ve iki sayfanın buna göre güncellenmesi.
3. `phase7-verify.ts`'e periyot tutarlılığı iddiası eklenmesi (şu an talep toplamını kaynak G5+H5 ile doğruluyor ama periyodunu iddia etmiyor).

---

## Küçük mimari not — alias rotalarda gerçek içerik legacy tarafta duruyor

Bulgu #5 sırasında ölçüldü (yeni bulgu numarası açılmadı; kullanıcı isterse açar).

Alias'lı rota çiftlerinde **gerçek içerik legacy dosyada, kanonik dosya 1 satırlık re-export**:

| Kanonik | Legacy (içerik burada) |
|---|---|
| `finance/loans/[loanId]/page.tsx` — 1 satır | `financing/loans/[loanId]/page.tsx` — 132 satır |
| `system/features/page.tsx` — 1 satır | `phases/page.tsx` — 67 satır |
| `data/imports/page.tsx` — 1 satır | `imports/page.tsx` |

Bu **tutarlı bir konvansiyon**, çelişki değil: her iki çift de aynı yönde. (Bu turun görev tanımında `system/features` çiftinin ters yönde olduğu varsayılmıştı; ölçüm bunu doğrulamadı — o dosya da 1 satırlık re-export.)

Fonksiyonel etkisi yok: redirect'ler devrede olduğu için legacy URL'ler kullanıcıya hiç görünmüyor, ikisi de aynı bileşeni render ediyor. Tek maliyeti okunabilirlik — kanonik yolu açan biri gerçek JSX'i bulmak için legacy dosyaya gitmek zorunda. Tersine çevirmek istenirse dosya taşıma + import güncellemesi gerektiren ayrı bir temizliktir; davranış değişmez.

---

## Küçük UI notu — modül içi `PageHeader` gizlendiğinde `action` butonu da erişilemez oluyor

Bulgu #6 doğrulanırken bulundu (yeni bulgu numarası açılmadı; kullanıcı isterse açar).

`globals.css:410` — `.module-content > header:first-child { display: none; }` — modül çerçevesi
zaten başlık gösterdiği için sayfanın kendi `PageHeader`'ını gizliyor. Kasıtlı bir kural. Ancak
`PageHeader`'ın `action` yuvasına konan buton da onunla birlikte gizleniyor.

Somut sonuç: `/system` sayfasındaki **"Metrikleri yenile" butonu DOM'da var ama görünmez** —
Playwright `force: true` ile bile tıklayamıyor (`display: none` zincirin üstünde). Yani metrik
yenileme özelliği arayüzden **çalıştırılamıyor**.

Bu turda kapsam dışı bırakıldı (Bulgu #6 ile ilgisi yok, ondan önce de vardı). Doğrulama, motor
(`refreshMetricSnapshots`) doğrudan çağrılarak yapıldı — 24 metrik yazıldı, hiçbiri
`capacity_utilization` değil.

Çözüm seçenekleri: (a) `action` içeriğini `header` dışına taşımak, (b) kuralı
`.module-content > header:first-child > :not(.shrink-0)` gibi daraltmak, (c) modül sayfalarında
`PageHeader` yerine `ModuleFrame`'in kendi action yuvasını kullanmak. Hangisi olacağı bir tasarım
kararı.
