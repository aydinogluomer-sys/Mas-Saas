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
> **Link temizliği de tamamlandı (commit 890f619):** 11 linkin 11'i `/data/imports/...`'a çevrildi (grep: eski 0, yeni 11, 8 dosya). Canlı doğrulama: `/data/reviews` (52 link), `/cashflow/{ay}`, `/finance/loans/{id}`, `/data/imports` sayfalarında eski yol kalmadı; `/data/reviews`'dan takip edilen link 308 sıçraması olmadan hedefe gidiyor.

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

**Kalan açık iş:** yok — #1…#6 ve `PageHeader action` düzeltmesi kapandı. Yeni bulgu için aşağıdaki "Bulgu #7" bölümüne bakın.

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

## Küçük UI notu — modül içi `PageHeader` gizlendiğinde `action` butonu da erişilemez oluyordu — **DONE (commit sonrası)**

Bulgu #6 doğrulanırken bulundu (yeni bulgu numarası açılmadı).

`globals.css:410` — `.module-content > header:first-child { display: none; }` — modül çerçevesi
zaten başlık gösterdiği için sayfanın kendi `PageHeader`'ını gizliyor. Kasıtlı bir kural. Ancak
`PageHeader`'ın `action` yuvasına konan buton da onunla birlikte gizleniyor.

Somut sonuç: `/system` sayfasındaki **"Metrikleri yenile" butonu DOM'da var ama görünmez** —
Playwright `force: true` ile bile tıklayamıyor (`display: none` zincirin üstünde). Yani metrik
yenileme özelliği arayüzden **çalıştırılamıyor**.

### Gerçek etki alanı (sistematik ölçüldü — ilk not yalnız `/system`'i sanıyordu)

`PageHeader` kullanan **45 rota** canlı tarandı (`getComputedStyle` ile, gerçek admin oturumu).
Aksiyonu olan **11 rota** vardı ve **11'inin de aksiyonu gizliydi**. Takma adlar sadeleşince
**8 farklı sayfa**:

| Sayfa | Gizli olan aksiyon | Tıklayınca (düzeltmeden sonra) |
|---|---|---|
| `/payments` (=`/radar`) | Ödeme ekle | `/payments/new` |
| `/payments/history` | Ödeme ekle | `/payments/new` |
| `/payments/archive` | Ödeme kalemlerine git | `/payments/items` |
| `/finance` (=`/financing`) | Senaryoda dene | `/scenarios?from=finance` |
| `/cashflow` | Senaryoda dene | `/scenarios` |
| `/finance/loans` | Yeni kredi | `/finance/loans/new` |
| `/finance/checks` | Yeni çek | `/finance/checks/new` |
| `/system` (=`/admin`) | Metrikleri yenile | `/system?metrics=24` (gerçekten yeniledi) |

En kritik olanı `/payments`: yeni ödeme ekleme, ana ödeme ekranından erişilemiyordu.

### Çözüm (uygulanan)

Seçenek (b) — sayfa dosyalarına hiç dokunmadan, `globals.css`'te tek kural üçe çıkarıldı:

```css
.module-content > header:first-child { display: none; }
.module-content > header:first-child:has(.shrink-0) { display: flex; }
.module-content > header:first-child:has(.shrink-0) > .min-w-0 { display: none; }
```

Temel kural korunur (yalnız başlık taşıyan header'lar tamamen gizli — kasıtlı ve doğru); aksiyon
İÇEREN header geri gelir, başlık bloğu (`.min-w-0`) gizli kalır.

`:has()` bu kod tabanında ilk kullanım. Belgelenmiş bir tarayıcı-desteği kısıtı yok (`browserslist`
tanımı, `.browserslistrc` veya dokümante edilmiş hedef yok) ve bu bir iç kontrol paneli.

### Doğrulama

45 rota önce/sonra ölçüldü: aksiyonlu 11 rotanın **11'i de görünür** oldu (önce 0), aksiyonsuz
**33 rotanın 32'si aynen `display:none`** kaldı (33.'sü `/production/costs` — yeniden ölçümde o da
`none`, ilk okuma geçici bir artefakttı). **Tıklanabilirlik kanıtı (düzeltildi):** İlk turda "8/8 tıklandı" denmişti ama yöntem yanlıştı —
tıklamadan sonra `networkidle` bekleyip URL okumak, bu uygulamanın iki tasarım özelliğini hesaba
katmıyor: (1) `NavigationFeedbackProvider` her link tıklamasını `requestAnimationFrame` ile bir kare
erteliyor, (2) URL değiştikten sonra rota önce skeleton render edip içeriği stream ediyor (ölçüldü:
`waitForURL` çözüldüğünde `main` 155 karakter, +500ms'de 940 karakter). Doğru yöntemle —
`waitForURL` + içerik işaretini **bekleyen** (örnekleyen değil) kontrol, işaretler tr-locale büyük
harfe çevrilerek karşılaştırılıyor çünkü Panel başlıkları CSS ile uppercase — **8 rota × 5 tekrar =
40/40 PASS**, `force` kullanılmadan, konsol hatası 0. Header 46px, bir sonraki blok 16px altında —
çakışma yok, yatay taşma yok.

### Kozmetik kalıntı da giderildi (commit ddaf39d)

`.min-w-0` gizlenince `.shrink-0` tek flex öğe kalıyordu ve `space-between` dağıtacak boşluk
bulamadığı için buton sola düşüyordu (ölçüm: `actionSol 297 = headerSol 297`). Kurala
`justify-content: flex-end` eklendi; beş sayfada ölçüldü, aksiyonun sağ kenarı artık header'ın sağ
kenarıyla hizalı (`actionSag 1325 = headerSag 1325`).

---

## Bulgu #7 — üç gezinme yolunda istemci navigasyonu sessizce iptal oluyor — **GEÇİCİ ÇÖZÜM UYGULANDI (6542b36), kök neden HÂLÂ BİLİNMİYOR**

**Önem: Orta.** Kullanıcıya görünen arıza kapandı; altındaki hata duruyor.

### Belirti
`/data/imports` listesinde bir workbook adına tıklayınca URL değişmiyor, sayfa aynı kalıyor. Konsol hatası ve `pageerror` yok.

### Ölçülen mekanizma
Tıklama yakalanıyor ve `router.push` çalışıyor; ağ trafiğinde hedefin RSC isteği başlıyor, rota chunk'ı yükleniyor, sonra **RSC isteği iptal ediliyor**:

```
GET /data/imports/{id}?_rsc=…            ← başlıyor
GET /_next/static/chunks/…/[workbookId]/page-….js
FAILED /data/imports/{id}?_rsc=…  net::ERR_ABORTED   ← iptal
```

### Kapsam (izole edildi)
| Deneme | Sonuç |
|---|---|
| `/data/imports` → workbook linki | **gitmiyor** |
| `/data/imports` → modül sekmesi (`/data/quality`) | gidiyor |
| `/data/reviews` → aynı `/data/imports/{id}/reviews` hedefi | gidiyor |
| Doğrudan URL ile `/data/imports/{id}` | açılıyor (3214 karakter) |

Yani rota, hedef sayfa ve genel istemci-taraflı navigasyon sağlam; sorun yalnız **bu sayfadan bu hedefe** geçişte.

### Bulgu #5'in link temizliğiyle ilgisi yok — önceden vardı
Commit 890f619 bu linki `/imports/{id}` → `/data/imports/{id}` yaptı. Regresyon şüphesi doğrudan test edildi: aynı sayfada anchor'ın `href`'i DOM'da **eski hâline** çevrilip tekrar tıklandı — **aynı şekilde gitmiyor**. İki biçim de eşit derecede etkileniyor, yani hata link temizliğinden önce de vardı.

### Teşhis turu (kod değişikliği yok) — hipotez ÇÜRÜTÜLDÜ, kök neden HÂLÂ AÇIK

Önceki tahmin (`NavigationFeedbackProvider`'ın state'i transition'ı iptal ediyor) **yanlış çıktı.**

**Kesin kanıt — provider suçsuz:**
1. Provider geçici olarak enstrümante edildi. Başarısız vakada sıra: `onClick yakaladı` → `beginNavigation` (erken çıkış YOK) → tek `setState` → `rAF → router.push`. `beginNavigation` ile `router.push` arasında **ikinci bir state güncellemesi veya yeniden render YOK**. Başarılı vakada sıra birebir aynı; tek fark `router.push`'un commit edip etmemesi.
2. Interceptor tamamen devre dışı bırakıldı (geçici bayrakla) → sayfanın kendi Next `<Link>`'i devreye girdi → **aynı şekilde gitmiyor**. Provider olmadan da hata sürüyor.

**Ağ zaman çizelgesi (CDP):** Hedefin RSC yükü tıklamadan **önce** prefetch ile çekiliyor ve **200 dönüyor** (+411ms istek, +439ms yanıt). Tıklamadan sonra yalnız rota chunk'ı isteniyor (200), ardından +784ms'de `net::ERR_ABORTED`. Yani veri hazırdı; sorun fetch'te değil, transition'ın commit edilmemesinde.

**Elenen açıklamalar (hepsi deneyle):**

| Hipotez | Sonuç |
|---|---|
| NavigationFeedbackProvider | **elendi** (interceptor kapalıyken de olur) |
| "Alt yol (descendant) navigasyonu bozuk" | **elendi** — `/payments→/payments/new`, `/payments/items`, `/payments/history`, `/system→/system/security`, `/finance→/finance/checks`, `/finance/checks→/finance/checks/new`, `/scenarios→/scenarios/history` hepsi çalışıyor |
| "Re-export rotalar bozuk" | **elendi** — `/insights/reports → /insights/reports/{id}` (ebeveyn ve çocuk ikisi de re-export) çalışıyor |
| "Dinamik segmentli çocuk bozuk" | **elendi** — `/payments/{id}/edit`, `/cashflow/{id}` çalışıyor |
| `next.config.ts` dinamik redirect'leri | **elendi** — dördü de geçici kaldırıldı, hata aynen sürdü |
| Sayfadaki formlar / UploadForm | **elendi** — DOM'dan kaldırıldı, hata sürdü |
| `notFound()` kullanımı | **elendi** — çalışan hedefler de (`reports/[reportId]`, `cashflow/[monthId]`) kullanıyor |
| Yutulmuş JS hatası | **elendi** — console error, pageerror, unhandledrejection: hiçbiri yok |
| Link markup'ı / üstte çakışan eleman | **elendi** — DOM'a enjekte edilen düz `<a>` ile de birebir tekrarlanıyor |

**Kesin tekrar kapsamı (4 geçiş):**
- `/data/imports` → `/data/imports/{id}`
- `/data/imports` → `/data/imports/{id}/reviews`
- `/data/imports/{id}` → `/data/imports/{id}/reviews`
- `/finance/loans` → `/finance/loans/{id}`  ← **yeni**: imports ağacına özgü değilmiş

Test edilen diğer 11 geçişin tamamı çalışıyor. `/data/quality → /data/imports/{id}` ve `/data/reviews → /data/imports/{id}` de çalışıyor — yani hedef tek başına suçlu değil, **kaynak+hedef çifti** belirleyici.

**Bulgu #5'in link temizliğiyle ilgisizliği bağımsız olarak doğrulandı:** `/finance/loans → /finance/loans/{id}` geçişi 890f619'un hiç dokunmadığı bir linkte ve aynı şekilde başarısız.

**Kalan olası açıklamalar (hiçbiri doğrulanmadı):**
- Next.js App Router istemci-taraflı router cache'inde, bu iki spesifik ebeveyn→çocuk çiftine özgü bir segment eşleşme/geçersizleştirme sorunu.
- Prefetch ile alınan RSC yükünün cache'te, tıklama anında beklenen anahtarla eşleşmemesi (prefetch 200 dönüyor ama transition onu kullanamıyor olabilir).
- Sunucu tarafında bu iki rotanın render'ının transition sırasında (prefetch'te değil) hata verip sessizce iptale yol açması — sunucu logları bu turda incelenmedi.

**Sıradaki adım önerisi:** `next start` yerine `next dev` ile tekrarlayıp Next'in geliştirme uyarılarını/router loglarını okumak; ayrıca `router.push`'un döndürdüğü promise'i ve `useRouter` state'ini doğrudan gözlemleyen küçük bir test bileşeni. İkisi de ayrı bir tur.

**Geçici enstrümantasyon geri alındı** — `git status` temiz, `navigation-feedback.tsx` ve `next.config.ts` değişmedi.

### `next dev` turu — ~~KÖK NEDEN KESİNLEŞTİ~~ **GERİ ÇEKİLDİ** (aşağıdaki "swap turu"na bakın)

**Dev modda dört geçişin dördü de çalışıyor.** Aynı kaynak kod, aynı veri, aynı tıklama — yalnız `next start` yerine `next dev`. Konsolda tek uyarı yok (`[Fast Refresh] rebuilding/done` dışında hiçbir şey), Next hata overlay'i açılmıyor (DOM'daki `nextjs-portal` yalnız dev overlay'in kendi stil sayfası), sunucu logları tertemiz: tüm rotalar derlendi ve 200 döndü. Yani arıza **yalnız production build'e özgü**.

**ADIM B — router debug yüzeyi:** `window.next.router` var ama yalnız metotlar açık (`back, forward, prefetch, push, replace, refresh, hmrRefresh`); `window.next.router.state` **undefined**, `window.__NEXT_DATA__` yok. Bu sürümde okunabilir bir App Router state'i **yok** — gözlemlenemedi.

Dev'de prefetch devre dışıdır. Bu ipucu üretim build'inde sınandı ve **kesin tekrar kuralı** çıktı:

> ~~**Prefetch edilmiş + hedef rota bir re-export + hedef rotada dinamik segment var → navigasyon iptal oluyor.**~~
> **BU KURAL ÇÜRÜTÜLDÜ** — aşağıdaki "swap turu" bölümüne bakın. Aşağıdaki matris o turda alınmış ölçümlerdir; bir satırı (`/insights/reports/{id}`) sonradan tekrarlanamadı.

**Kanıt matrisi (hepsi production build, 2500ms bekleme = prefetch tamamlanmış):**

| Hedef | Prefetch | Re-export | Dinamik | Sonuç |
|---|---|---|---|---|
| `/data/imports/{id}` | ✓ | ✓ | ✓ | **gitmiyor** |
| `/data/imports/{id}/reviews` | ✓ | ✓ | ✓ | **gitmiyor** |
| `/finance/loans/{id}` | ✓ | ✓ | ✓ | **gitmiyor** |
| `/insights/reports/{id}` | ✓ | ✓ | ✓ | **gitmiyor** |
| `/data/imports/{id}/sheets/{id}` | ✗ (sayfada Link yok) | ✓ | ✓ | gidiyor |
| `/data/imports/{id}` (`/data/quality`'den) | ✗ | ✓ | ✓ | gidiyor |
| `/system/features` | ✓ | ✓ | ✗ | gidiyor |
| `/insights/reminders` | ✓ | ✓ | ✗ | gidiyor |
| `/payments/{id}/edit` | ✓ | ✗ | ✓ | gidiyor |
| `/payments/items`, `/payments/new` | ✓ | ✗ | ✗ | gidiyor |
| dört başarısız geçiş, **dev modda** | (dev'de prefetch yok) | ✓ | ✓ | gidiyor |

**Önceki turun iki sonucu bu ışıkta düzeltilmelidir:**
- "`/insights/reports → /insights/reports/{id}` çalışıyor, demek ki re-export suçlu değil" — **yanlıştı**. O ölçüm tıklamadan önce beklemiyordu; prefetch tamamlanmadan tıklanınca geçiş başarılı oluyor. 2500ms beklemeyle aynı geçiş **başarısız**. Yani sonuç bir yarış koşuluna bağlı, ve "re-export suçsuz" çıkarımı geçersiz.
- Aynı nedenle kapsam 4 geçişten büyük: **prefetch edilen her dinamik re-export hedefi** etkileniyor (bilinen dördü + `/insights/reports/{id}`).

**Çıkarılan mekanizma (iç işleyiş okunmadı, kanıt buraya kadar):** Üretim build'inde dinamik+re-export bir rota için prefetch ile oluşan istemci RSC cache girdisi, sonraki gerçek geçişte kullanılamıyor ve transition sessizce iptal ediliyor (`net::ERR_ABORTED`, konsola hiçbir şey düşmüyor). Next'in kaynak kodu incelenmedi; bu tanım gözlemlenen davranışın kuralıdır, Next-içi çağrı zincirinin kanıtı değildir.

### Düzeltme seçenekleri — UYGULANMADI, karar kullanıcıya ait

1. **Re-export'ları gerçek dosyaya çevir (dinamik olanlar için).** Etkilenen dört rotanın içeriği alias tarafına taşınır, legacy taraf ya silinir ya kanonik tarafı re-export eder. En temiz çözüm; aynı zamanda daha önce rehbere not düşülen "gerçek içerik legacy tarafta duruyor" konvansiyon tersliğini de giderir. Maliyet: dosya taşıma + import güncellemesi, davranış değişmez.
2. **Bu hedeflere işaret eden linklerde prefetch'i kapat** (`<Link prefetch={false}>`). Küçük ve hedefe yönelik; ama kök nedeni bırakır, ileride eklenecek yeni bir link aynı tuzağa düşer.
3. **Alias rotayı tamamen kaldır**, tek kanonik gerçek dosya bırak, diğerini `next.config.ts` redirect'iyle karşıla. Rota sayısını azaltır; hangi tarafın kanonik olacağı ürün kararı.

Seçenek 1 kök nedeni ortadan kaldırır, 2 semptomu bastırır, 3 hem kök nedeni giderir hem yüzeyi küçültür.

---

## Bulgu #7 — swap turu: seçenek 1 uygulandı, **Bulgu #7'yi ÇÖZMEDİ** (commit 114c702)

**Durum: kök neden yeniden AÇIK.**

### Ne yapıldı
"Kanonik rotalar re-export olmasın" hipotezi gereği beş alias çiftinde gerçek içerik kanonik tarafa taşındı, legacy taraf 1 satırlık re-export oldu (yön tersine döndü):

`data/imports/[workbookId]` · `.../reviews` · `.../sheets/[sheetId]` · `finance/loans/[loanId]` · `insights/reports/[reportId]`

### Sonuç: değişmedi
Swap sonrası, swap öncesiyle **birebir aynı** (dört ardışık çalıştırmada tekrarlanabilir):

| Geçiş | Swap öncesi | Swap sonrası |
|---|---|---|
| `/data/imports → /data/imports/{id}` | gitmiyor | **gitmiyor** |
| `/data/imports/{id} → .../reviews` | gitmiyor | **gitmiyor** |
| `/finance/loans → /finance/loans/{id}` | gitmiyor | **gitmiyor** |
| `.../sheets/{id}` | gidiyor | gidiyor |
| `/insights/reports/{id}` | gidiyor | gidiyor |

### Çürütülen: "hedefin re-export olması"
Kanonik hedefler artık re-export **değil** ve hâlâ başarısız. Ayrıca `sheets/{id}` ve `reports/{id}` üç koşulu da (prefetch + re-export + dinamik) sağladıkları hâlde hem önce hem sonra **çalışıyor**.

**98841fb'deki bir ölçüm yanlıştı:** `/insights/reports/{id}`'nin 2500ms beklemeyle başarısız olduğu rapor edilmişti; bu turda dört çalıştırmanın hiçbirinde tekrarlanmadı. Kural kısmen o tek gözlemin üzerine kurulmuştu.

**Gerçek başarısız küme baştan beri aynı üç geçiş.**

### Swap yine de commit'lendi (114c702) — ama başka bir sebeple
Bulgu #7'yi çözmüyor; Bulgu #5 kapanışında not düşülen **"gerçek içerik legacy tarafta duruyor"** tersliğini gideriyor. O not artık geçersiz: beş çiftte kanonik taraf gerçek içeriği taşıyor.

Doğrulandı: typecheck/lint/vitest 200/build ✓ · içerik bütünlüğü birebir (kredi detayı 48 taksit satırı + 47 "ödendi" butonu, a4a8d1e referansı) · beş legacy yol hâlâ 308 ile kanoniğe gidiyor · konsol hatası 0.

İki yan not: `imports/[workbookId]/reviews`'daki `../../actions` göreli import'u taşıma sonrası kırılacağı için mutlak alias'a çevrildi (davranış değişikliği değil). `financing/page.tsx:152`'deki link düzeltmesi **ölü dosyada** — `/financing` kalıcı olarak `/finance`'e yönlendiği için o sayfa hiç render edilmiyor; zararsız ama etkisiz.

### Sıradaki tur için açık öneri (bu turda ARAŞTIRILMADI)
Hedef tarafı artık **elendi**: beş aday rotanın hepsi hedefte aynı üç özelliği taşıyordu, ikisi çalışıyor üçü çalışmıyor. Yani ayrım hedefte değil, büyük olasılıkla **kaynak sayfada**.

Üç kırık geçişin kaynakları: `/data/imports`, `/data/imports/{id}`, `/finance/loans`.
Çalışan geçişlerin kaynakları: `/data/imports/{id}` (sheets'e giderken **çalışıyor**), `/insights/reports`, `/data/quality`, `/payments`, `/system`.

Dikkat: `/data/imports/{id}` hem kırık (→ reviews) hem çalışan (→ sheets) bir kaynak. Yani "kaynak sayfa" da tek başına yetmeyebilir; ayrım **kaynak+hedef çiftinde** kalıyor olabilir. Kaynak sayfaların ortak özellikleri (render ettikleri bileşenler, `<Link>` sayısı/konumu, `loading.tsx` sınırları, aynı segment altındaki kardeş rota sayısı) hiç sistematik incelenmedi — sonraki turun başlangıç noktası bu olmalı.

---

## Bulgu #7 — geçici çözüm turu (commit 6542b36)

**Durum: kullanıcıya görünen arıza kapandı, kök neden hâlâ bilinmiyor.** Bu tur kök nedeni aramadı; kanıtlanmış tek güvenilir davranışa (gerçek tarayıcı navigasyonu) zorladı.

### Yapılan
`navigation-feedback.tsx`'teki tıklama yakalayıcısına tek bir erken çıkış eklendi:

```ts
if (target.hasAttribute("data-hard-nav")) return;
```

İşaretli bir `<a>` için `preventDefault`/`stopPropagation`/`router.push` zincirinin **hiçbiri** çalışmaz; tarayıcı linke normal, tam sayfa yüklemesiyle gider — adres çubuğuna yazmakla birebir aynı yol, ve bu hatanın hiç görülmediği tek yol.

Dört link düz `<a data-hard-nav="true">`'ya çevrildi (className ve children birebir korundu, yalnız eleman tipi değişti):

| Dosya | Link |
|---|---|
| `imports/page.tsx` | workbook adı → `/data/imports/{id}` |
| `data/imports/[workbookId]/page.tsx` | "N açık inceleme →" → `.../reviews` |
| `components/finance/loans-table.tsx` | kredi adı → `/finance/loans/{id}` |
| `components/finance/loans-table.tsx` | "Taksit planı" → `/finance/loans/{id}` |

### Doğrulama (kanıt yükü bilinçli olarak yüksek tutuldu)
Bu konuda bu oturumda iki kez yanlış ölçüm yapıldığı (98841fb'nin geri çekilmesi) için tek koşuya güvenilmedi:

- **30/30** — üç geçiş × (0ms ve 2500ms bekleme) × 5 tekrar, **gerçek sayfa linklerine** tıklanarak (enjekte edilmiş eleman değil), `force` kullanılmadan.
- Her deneme ayrıca **gerçekten tam sayfa yüklemesi** olduğunu kanıtlamak zorundaydı: `load` olayı **ve** hedef URL için document tipi yanıt. Yalnızca URL değişip içerik SPA tarzı gelseydi o deneme **başarısız** sayılacaktı — yani kaçış kapısının fiilen tetiklendiği doğrulandı, geçişin şans eseri başarılı olması yeterli sayılmadı.

### Regresyon: kapsam dar olduğu doğrulandı
Dokunulmayan geçişler hâlâ çalışıyor **ve hâlâ istemci geçişi** (tam sayfa yüklemesi yok): `.../sheets/{id}`, `/insights/reports/{id}`, `/payments → /payments/items`, ve kenar çubuğundan `/overview → /cashflow`. "Anlık geçiş" hissi yalnız bu üç noktada bilinçli olarak feda edildi — daha önce hiçbir şey yapmayan linkler için kabul edilebilir takas.

### `data-hard-nav` genel bir kaçış mekanizması olarak kalıyor
Kök neden bulunana kadar aynı arıza başka bir yerde görülürse, çözümün tamamı o anchor'ı işaretlemek.

### Kök neden araştırması hâlâ AÇIK (isteğe bağlı)
Bu geçici çözüm hiçbir teşhis sorusunu cevaplamıyor. Bir önceki turda bırakılan iz geçerliliğini koruyor: hedef tarafı elendi, ayrım muhtemelen kaynak+hedef **çiftinde**; `/data/imports/{id}` hem kırık (→ reviews) hem çalışan (→ sheets) bir kaynak olduğu için tek bir değişkene sabitlenemiyor. Kaynak sayfaların ortak özellikleri hiç sistematik incelenmedi.

---

## Bulgu #7 — framework-seviyesi teşhis turu: **kök neden yine bulunamadı**, geçici çözüm korunuyor

Bu tur uygulama katmanından çıkıp Next'in kendi istemci router kaynağını (`node_modules/next/dist/client/components/router-reducer/`) okudu ve geçici olarak enstrümante etti. **Kod değişikliği yok, commit'lenen kaynak dosya yok, `data-hard-nav` yerinde bırakıldı.**

### FAZ 1 — yukarı akış düzeltmesi yok
Kurulu sürüm 15.5.20. Sonrasındaki üç kararlı yama (15.5.21 / 15.5.22 / 15.5.23) **yalnız güvenlik düzeltmesi** içeriyor (DoS, SSRF, middleware bypass, ReplyServer traversal guard). Navigasyon, router cache, prefetch veya iptal ile ilgili hiçbir kayıt yok. **Sürüm yükseltmesi bu arıza için aday değil.**

### FAZ 2 — router akışında okunanlar
- `fetch-server-response.js` modül seviyesinde **tek bir global `AbortController`** tutuyor; `pagehide`'da abort, `pageshow`'da yeniden yaratılıyor. `catch` bloğu hatayı **yalnız signal abort edilmemişse** loglar — bizim vakadaki konsol sessizliğiyle uyumlu.
- İptal/başarısızlık durumunda bile Next `flightData: url.toString()` döndürüp **MPA (tam sayfa) navigasyonuna düşmeyi** amaçlıyor (`handleExternalUrl`). Bizde bu geri düşüş de gerçekleşmiyordu — yani arıza, bu tasarlanmış güvenlik ağının da devreye girmediği bir noktada.
- `navigate-reducer.js` içinde "aliased prefetch" yolu var (`handleAliasedPrefetchEntry`): dinamik rotalar için alınan prefetch başka URL'lere yeniden kullanılıyor, ve **loading bileşeni olmayan segmentler atlanıyor** (`hasLoadingComponentInSeedData`). Hipotez olarak çok uygun görünüyordu.

### FAZ 3 — enstrümantasyon: dört hipotez birden elendi
Next'in kendi kaynağına geçici `console.log`'lar konup üç kırık + iki çalışan geçiş karşılaştırıldı:

| Şüpheli mekanizma | Sonuç |
|---|---|
| Aliased prefetch yolu | **elendi** — hiçbir geçişte devreye girmiyor |
| `AbortController` / fetch catch | **elendi** — catch bloğu hiç çalışmıyor |
| MPA geri düşüşü (`flightData` string) | **elendi** — hiç tetiklenmiyor |
| Ağaç yaması başarısızlığı (`applyRouterStatePatchToTree === null`) | **elendi** — yama **her vakada başarıyla** uygulanıyor (`currentTree-null=false`) |

**Kırık ve çalışan geçişler router içinde birebir aynı yolu izliyor** ("normal istemci geçişi" dalı), aynı segment path'leriyle, aynı başarılı ağaç yamasıyla. Ayrım bu enstrümantasyonun görebildiği noktaların **hiçbirinde** değil.

### Yeni ve rahatsız edici gözlem: sonuç kararsız
`/insights/reports/{id}` bu turda **taraf değiştirdi** — aynı build, aynı yöntem, farklı koşuda bir kez GİDİYOR bir kez GİTMİYOR. Daha önce de (98841fb ↔ swap turu) aynı geçişte çelişkili ölçüm alınmıştı. Yani en az bir geçiş **deterministik değil**; üç çekirdek geçiş (`/data/imports → {id}`, `→ reviews`, `/finance/loans → {id}`) ise tüm turlarda tutarlı biçimde kırık.

Bu, önceki turlarda kurulan "kural"ların neden sürekli çürüdüğünü de açıklıyor: kararsız bir vakayı sabit veri sanıp üzerine kural inşa edilmiş.

### Durum ve öneri
Kök neden **hâlâ bilinmiyor**. `data-hard-nav` geçici çözümü korunuyor ve üç geçişi kullanıcı için sorunsuz çalıştırıyor (30/30 doğrulanmıştı).

Bundan sonrası için gerçekçi seçenekler:
1. **Olduğu gibi bırak.** Geçici çözüm ucuz, dar kapsamlı ve kanıtlanmış. Yeni bir alias rota eklenirse aynı tuzak için `data-hard-nav` hazır.
2. **Yukarı akışa bildir.** Elde minimal repro üretmek için ciddi emek gerekir (bu depo dışında, temiz bir Next projesinde tekrar üretmek) — ama gerçek bir framework hatasıysa tek kalıcı çözüm budur.
3. **Segment cache deneysel bayrağını dene** (`experimental.clientSegmentCache`): router'ın bu kod yolunu tamamen baypas eden alternatif bir navigasyon uygulaması var (`__NEXT_CLIENT_SEGMENT_CACHE`). Deneysel; ayrı ve dikkatli bir tur gerektirir.

Hiçbiri yapılmazsa mevcut durum kabul edilebilir: kullanıcıya görünen arıza yok, teknik borç kayıtlı.
