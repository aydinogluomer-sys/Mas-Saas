# Performans WIP Ayrıştırma — Devir

**Tarih:** 2026-08-27 · **Branch:** `release/production-readiness-hardening` · **HEAD:** `4b8eb19`
**Kapsam:** Yalnız çalışma ağacındaki mevcut performans WIP'i incelendi ve commit'lendi.
Yeni özellik/interaction kapsamı açılmadı. Gerçek `mas_radar_dev` üzerinde **hiçbir mutation**
çalıştırılmadı; bütün ölçümler harcanabilir `mas_radar_interaction_verify` üzerinde yapıldı.

---

## 0. ÖNCE OKUNMASI GEREKEN İKİ ŞEY

### 0.1 `.env.example` içinde GERÇEK SECRET'LAR var — commit EDİLMEDİ

`.env.example` git'te **izlenen** bir şablon dosyası ve boş placeholder taşıması gerekir. Çalışma
ağacındaki hâli dört gerçek kimlik bilgisiyle doldurulmuş:

| Anahtar | Durum |
|---|---|
| `MAS_RADAR_APP_DB_PASSWORD` | gerçek parola yazılmış |
| `TELEGRAM_BOT_TOKEN` | gerçek bot token'ı yazılmış |
| `TELEGRAM_CHAT_ID` | gerçek chat id yazılmış |
| `OPENAI_API_KEY` | gerçek `sk-proj-…` anahtarı yazılmış |

**Commit edilmedi ve staged edilmedi.** Ama dosya diskte duruyor ve `git status`'ta değişik
görünüyor; bir sonraki `git add -A` onu geçmişe kalıcı olarak sokar.

**Önerilen aksiyon (karar sizin):**
1. `.env.example`'ı boş placeholder hâline geri döndürün.
2. Bu dört kimlik bilgisini **döndürün (rotate)** — dosya bir süredir çalışma ağacında duruyor
   ve bu oturumda diff çıktısına da düştü.
3. Gerçek değerler yalnız `.env.local`'da kalsın (o dosya zaten ignore'lu).

### 0.2 `git add -A` yapılmış, index'te 2155 dosya bekliyordu

Turun başında index'te **2155 staged dosya** vardı; ~2100'ü `.next-preload-*`,
`.next-pre-speed-release-*` build çıktısı, ayrıca `bot.py`, `p24b-discovery/`,
`HANDOFF-2026-08-27.md`, `_probe-authz.ts` ve yukarıdaki `.env.example`.

`git reset` (mixed) ile index boşaltıldı — **hiçbir dosya silinmedi**, hepsi diskte duruyor.
Sonra yalnız kapsamdaki dosyalar bilerek staged edildi. `--hard`, `checkout --`, `clean`
kullanılmadı.

---

## 1. Oluşturulan üç commit

| SHA | Commit | Neden ayrı |
|---|---|---|
| `68f7aca` | `fix(build): pnpm install --frozen-lockfile HEAD'de kırılıyordu` | Performans değil, **açılış/kurulum** düzeltmesi |
| `44d9c5f` | `perf(payments): reduce dashboard startup cost and lazy-load chart` | İstenen commit 1 |
| `4b8eb19` | `perf(finance): reduce dashboard query and payload cost` | İstenen commit 2 |

Üçünde de `git diff --cached --check` temiz, yasaklı dosya listesi grep ile boş doğrulandı.

### Neden üçüncü bir commit

`pnpm-lock.yaml` + `scripts/prepare-runtime.ts`'in "gerçekten gerekli" olup olmadığı **ölçüldü**:

```
HEAD lock ile:  pnpm install --frozen-lockfile
  → Failure reason: specifiers in the lockfile don't match specifiers in package.json:
    * 1 dependencies were added: @next/env@15.5.20
WIP lock ile:   "Already up to date", exit 0
```

`@next/env` `package.json`'da vardı, lock'ta yoktu → **HEAD'de CI'ın ilk adımı kırıktı.**
Kökeni benim `529acc7` commit'im: o commit'te başka bir oturumun `@next/env` satırını
`package.json`'a aldığımı yazmıştım, ama lock'un da gerekli olduğunu fark etmemiştim.
`prepare-runtime.ts` `@next/env`'in tek tüketicisi olduğu için aynı commit'te.

Bu bir performans değişikliği olmadığı için payments/finance commit'lerine karıştırılmadı.

---

## 2. Raporlanması gereken davranış değişiklikleri

Hepsi commit mesajlarında da yazılı; buraya karar verilmesi gerekenler alındı.

### 2.1 ⚠ `/finance/receivables` — ekrandaki finansal toplamların kapsamı daraldı

Limitler yarıya indi (`150→75`, `40→20`, `20→10`). Sayfa kodunda:

```
recTotal   = receivables.reduce(...)        ← ÇEKİLEN ALT KÜMEDEN
payTotal   = payables.reduce(...)           ← ÇEKİLEN ALT KÜMEDEN
recAgeing  = summarizeAgeing(receivables…)  ← ÇEKİLEN ALT KÜMEDEN
overdue    = receivables.filter(...)        ← ÇEKİLEN ALT KÜMEDEN
```

Yani limit, "Toplam açık alacak" ve yaşlandırma rakamlarının **kapsamını** belirliyor. 75'in
üzerinde açık alacak olduğunda bu rakamlar **gerçeğin altında** kalır.

- Bu zaten 150'de de böyleydi — toplamlar hiçbir zaman "tüm alacaklar" değildi.
- Limitin yarıya inmesi yanılma olasılığını **iki katına** çıkarıyor.
- **Ölçüldü:** `invoices` tablosunda şu an **0 satır** → fark bugün **uykuda**, üretim verisinde
  canlı olur.

**Karar sizin:** toplamları SQL'de (limitten bağımsız) hesaplamak bu turun kapsamı dışında
bırakıldı.

### 2.2 `/payments` — risk günü tespiti `dayFlags()` yerine satır içi yazıldı

| | `dayFlags` (eski) | yeni satır içi |
|---|---|---|
| toplam | `amount` toplar | `remaining` toplar (`amount − paid_amount`) |
| büyük kalem | kalem `amount` ≥ large | `max(remaining)` ≥ large |
| kritik | `anyCritical` **VEYA** `knownSum ≥ critical` | yalnız `toplam ≥ critical` |
| statü | `OPEN_STATUSES` | SQL `'unknown'`u da alıyor |

- `remaining` farkı **canlı** (fixture'da 1 kısmi ödeme var). Tartışmalı biçimde daha doğru
  ("baskı" = hâlâ borçlu olunan) ama bir değişiklik.
- `anyCritical` dalının eksikliği **mevcut eşiklerde ortaya çıkmıyor**: `large=50.000 <
  critical=100.000` olduğu için kritiği aşan her kalem `maxAmount ≥ large` dalına takılıyor.
  Biri `large > critical` yapılandırırsa yeni sürüm gün kaçırır — **uyuyan ayrışma**.
- `'unknown'` statüsü fixture'da **0 satır** → uykuda.

### 2.3 `/finance/checks` — sayfalama eklendi

Ekran artık bir kerede en fazla **500** çek gösteriyor (üstte toplam + sayfa göstergesi).
`loadChecks`'in varsayılan limiti **100.000**; üzerinde sessiz kırpma olur. Mevcut hacimde
(7 çek) alâkasız, ama sınır artık var.

### 2.4 `/finance` — KPI tanımları birebir korundu (doğrulandı)

Dördü de kaynağıyla karşılaştırıldı ve **aynı**: kalan kredi borcu (`loadLoans`'ın
`remaining_amount` tanımı), 30 günlük ödeme (`maturityWindows`'un yarı-açık penceresi), açık çek
(aynı statü filtresi), aktif kredi (aynı arşiv filtresi). Vade akışının statü filtreleri de
`loadMaturityItems` ile birebir aynı.

**Kayıp:** "Açık çek"in neden statü filtreli olduğunu anlatan yorum (0034 öncesi hiçbir çek
`planned` dışına çıkamıyordu) sayfadan silinmiş. Gerekçe SQL'de yaşıyor, yazılı açıklama yok.

### 2.5 `/insights/briefing` — semantik değişiklik YOK

Beş küçük toplu sorgu seriden paralele alındı; paylaşılan yükleyiciler iki kez değil bir kez
koşuyor. Aynı sorgular, aynı alanlar, aynı hesap. `loadWidgetFacts` eski imzasını koruyor.

---

## 3. Bulunan ve kapatılan yarım entegrasyon

`/api/payments/dashboard-chart` **oturum kontrolü taşımıyordu.** `middleware.ts` yalnız çerezin
varlığına bakar (Edge'de DB sorgusu yapamaz, iptal/süre dolumunu göremez); bu yüzden repodaki
her JSON ucu ayrıca `getCurrentUser()` çağırır — `/api/facts`, `/api/search`,
`/api/analytics/export` üçü de öyle.

**Ölçüldü (uydurma çerezle):**

```
önce :  çerezsiz 307 · uydurma çerez 200 + gövde
sonra:  çerezsiz 307 · uydurma çerez 401 {"error":{"code":"unauthorized"}}
```

Finansal **satır sızmıyordu** — oturum yoksa katman verilemez, bağlantı `mas_radar_app`'e döner
ve RLS keser (ölçüldü: 3 seri, **0 nokta, 0 TL**). Ama `criticalThreshold` gibi yapılandırma
değerleri yanıtta yer alıyordu ve kimliği doğrulanmamış her istek **iki DB sorgusu** harcıyordu.

Düzeltme `44d9c5f` içinde; `/api/search`'ün kendi deseni kullanıldı.

---

## 4. Doğrulama sonuçları

```
pnpm lint        PASS   (0 uyarı)
pnpm typecheck   PASS
pnpm test        PASS   (60 dosya, 1328 test)
pnpm build       PASS   (BUILD_ID g-SwZCITJXsPbuYJIJ6kj)
finansal golden  PASS   (96/96, tests/financial)
frozen install   PASS   (68f7aca sonrası)
```

**Duman testi** (üretim derlemesi, gerçek admin oturumu, harcanabilir DB — hepsi 200, 0 konsol
hatası, 0 pageerror, 0 HTTP 5xx):

```
/payments             h1 "Ödemeler"     2858ms
/finance              h1 "Finansman"    3220ms
/finance/checks       h1 "Finansman"    2082ms
/finance/receivables  h1 "Finansman"    1801ms
/insights/briefing    h1 "İçgörüler"    1613ms

/api/payments/dashboard-chart (sayfa içinden fetch, gerçek kod yolu)
  http 200 · application/json · 3 seri · 387 nokta · grafik DOM'da
```

### ⚠ Navigation latency testi — 1 başarısız, BU TURDAN KAYNAKLANMIYOR

```
ok  primary navigation acknowledges every click within 50ms
ok  module tabs acknowledge click and preserve keyboard focus behavior
x   a delayed route is never left hanging: within 200ms EXACTLY the right one of skeleton/arrival
ok  reduced motion disables navigation and skeleton animation
```

Hata: `prefetch önbellekten servis etti; 200 ms içinde varılmalıydı (72ms)` — yani rota
önbellekten geldi ama **iskelet** göründü, "varıldı" yerine.

**Atıf ölçüldü, tahmin edilmedi:**

| Derleme | Sonuç |
|---|---|
| Bu turun HEAD'i | 3/3 koşuda başarısız |
| `6dd6c68` **öncesi** (preload düzeltmesinden önceki sürüm, yeniden derlendi) | 2/2 koşuda başarısız |

Yani ne bu turun performans WIP'inden, ne de önceki turun ön yükleme düzeltmesinden
kaynaklanıyor — **önceden var olan bir başarısızlık.**

Kök neden yönü (kanıtlanmadı, not olarak): `.navigation-pending .instant-navigation-skeleton
{ display: grid }` gecikmesiz; `beginNavigation()` sınıfı tıklamada senkron ekliyor. Testin
`MutationObserver`'ı yalnız `childList`/`subtree` izliyor (attribute değil), dolayısıyla
önbellekten gelen gezinmede ilk DOM mutasyonu ile `[pathname]` efektinin sınıfı temizlemesi
arasında bir yarış var. Ayrı bir tur konusu.

---

## 5. TestSprite — BLOCKED

```
testsprite --version    0.3.0                                   OK
testsprite auth status  key_7f6a6f1b4d37, scopes tam            OK
hedef URL   https://intervals-murphy-ultimately-levitra.trycloudflare.com
curl        Could not resolve host                              ÇÖZÜMLENMİYOR
```

Kayıtlı trycloudflare tüneli ölü. TestSprite yalnız herkese açık bir hedefe karşı
çalışabildiği için bu tur **BLOCKED**; localhost'a karşı çalışmış gibi gösterilmedi.

---

## 6. Çalışma ağacında kalan kirli dosyalar

**Bilerek commit edilmedi:**

| Dosya | Neden |
|---|---|
| `.env.example` | **Gerçek secret'lar içeriyor** — bkz. §0.1 |
| `src/components/ui/module-tabs.tsx` | Tek boş satır eklenmiş; performans değil, gürültü |

**Dokunulmadı (yasaklı liste + sahipliği belirsiz):**
`bot.py` · `scripts/qa/_probe-authz.ts` · `.navigation-run-clean.json` ·
`.testsprite-nav-run.json` · `.next-preload-dev/` · `.next-preload-final/` ·
`.next-preload-verify/` · `.next-pre-speed-release-20260826/` ·
`docs/release-evidence/final-production-readiness/HANDOFF-2026-08-27.md` ·
`docs/release-evidence/final-production-readiness/p24b-discovery/` ·
`docs/release-evidence/final-production-readiness/08-performance-trend.jsonl`

`.next-*` dizinleri yeniden üretilebilir build çıktısı; commit edilmemeli. `bot.py` ve
`_probe-authz.ts` kaynağı doğrulanmadan commit edilmemeli.

**~~Ölü kod~~ — düzeltildi:** `paymentOverviewInstances()` "artık hiçbir yerden çağrılmıyor"
diye not edilmişti. Silinmedi, ve iyi ki silinmemiş: §8'deki diferansiyel doğrulamanın
**normatif referansı** o. Eski yolun kendisi olmadan "yeni SQL eskisiyle birebir aynı" iddiası
ölçülemezdi — yalnız yeniden anlatılabilirdi.

---

## 7. Push durumu ve sıradaki adım

Push **yapılmadı**. Uzak branch'e göre **6 commit ileri** (`6dd6c68`, `68f7aca`, `44d9c5f`,
`4b8eb19`, `4c7f3ad`, `1a88dca`), 0 geri. `origin/master`'a göre 60 ileri.

Son iki commit, önceki dördün içinde bulunan finansal semantik riskleri kapatıyor — §8.

P24B keşfine **başlanmadı** (talimat gereği).

Sıradaki kritik yol değişmedi: çalışma ağacını stabilize et → P24B salt-okunur → off-device
yedek → açık onay → fixture temizliği → final RC → branch CI → PR/master → master CI → cutover.

---

## 8. Takip turu — hızlandırma commitlerindeki finansal semantik riskler

`44d9c5f` ve `4b8eb19` performansı gerçekten düzeltti, ama ikisi de aynı şeyi yaptı: **bir
finansal kuralı, hızlandırmak için yeniden yazdı.** Kural bir daha yazıldığı anda iki tanım olur
ve ikisinin ayrıştığını kimse söylemez. Bu tur o iki yerde tanımı **tek**e indirir.

Yeni commitler: `4c7f3ad` (alacak KPI'ları) · `1a88dca` (ödeme risk bayrakları). Önceki dört
commit **yeniden yazılmadı**, force-push yok.

### 8.1 Alacak KPI'ları listeye bağlıydı — `4c7f3ad`

`/finance/receivables` ekranında açık alacak toplamı, yaşlandırma kovaları ve gecikmiş sayacı
**listeye gelen satırlardan** hesaplanıyordu. Liste `loadReceivables(pool, 75)` ile sınırlıydı,
yani ekrandaki "AÇIK ALACAK" aslında *en büyük 75 alacağın toplamı*ydı. 75'in üzerinde açık
kayıt olduğunda her rakam **gerçeğin altında** kalıyordu ve bunu söyleyen hiçbir şey yoktu.

> Bu 150 limitinde de böyleydi. Limitin 75'e inmesi yalnız yanılma eşiğini yarıya indirdi —
> sorun limitin **değeri** değil, toplamların listeye **bağlı** olmasıydı.

**Çözüm.** `loadOpenTotals()` aynı view üzerinden **limitsiz** aggregate döndürüyor. Filtre ve
statü semantiği `public.receivables_open` / `payables_open` view'larının içinde yaşıyor;
toplamları **aynı view**'dan almak, o semantiği yeniden yazmadan birebir korumanın tek yolu.
Kendi `where` cümlemi yazsaydım iki tanım olur ve ilk şema değişikliğinde sessizce ayrışırlardı.

Kova sınırları `collectionBucket()` ile birebir aynı; tek sorguda `group by rollup (bucket)`,
yani kova satırları ve genel toplam **aynı okumadan** gelir.

**UI dürüstlüğü:** liste kırpıldıysa başlık `75 / 121` gösterir ve altında "yukarıdaki toplamlar
121 kaydın tamamını kapsıyor" yazar. Kırpılmış bir listeyi tam sanmak, üstteki toplamla
satırların toplamı arasındaki farkı **hataya** yormaya yol açardı.

Ayrıca `loadPayables` çağrısı kaldırıldı: bu ekran borç **listesi** göstermiyor, yalnız borç
toplamını ve yaşlandırmasını gösteriyor — ikisi de artık aggregate'ten geliyor.

### 8.2 Risk bayrakları `dayFlags()`ten ayrışmıştı — `1a88dca`

**Normatif referans** (`src/lib/radar/rules.ts` — bu turda **değişmedi**, ölçüt odur):

```ts
const open = dayInstances.filter((i) => isOpen(i.status));   // unpaid|partial|planned|late
knownSum   = Σ decimal(i.amount)  where amount != null && amount > 0
anyCritical= open.some((i) => i.amount != null && i.amount >= t.critical);
anyLarge   = open.some((i) => i.amount != null && i.amount >= t.large);
return { count: open.length, knownSum,
         cluster:  open.length >= t.clusterCount,
         large:    anyLarge,
         critical: anyCritical || knownSum >= t.critical };
```

`44d9c5f` bunu toplanmış satırlardan yeniden yazdı:

```ts
bucketCount(rows) >= clusterCount
  || rows.some((row) => (row.maxAmount ?? 0) >= large)
  || bucketTotal(rows) >= critical
```

**İki gerçek kayma:**

| # | Kayma | Sonucu |
|---|---|---|
| 1 | Eşikler `remaining` (= amount − paid_amount) üzerindeydi | 120.000 TL'lik, 119.000'i ödenmiş bir kalem **1.000 TL** gibi tartılıyor, günü kritik olmaktan çıkarıyordu |
| 2 | Sayım SQL'in `active` kümesindendi; o küme `'unknown'` **içerir**, `OPEN_STATUSES` içermez | Statüsü bilinmeyen kalemler günü kalabalık gösterip `cluster`ı erken ateşliyordu |

**Üçüncü fark gerçek çıkmadı — ve bunu ölçerek öğrendim.** `anyCritical` dalı da düşmüştü;
üçüncü hata olarak raporlamaya hazırdım. Dalı geri düşürüp testi koşturdum: **tek bir kırmızı
yok.** Nedeni tek satır — `anyCritical` true ise günde `amount >= critical` olan bir kalem
vardır; `critical > 0` iken o tutar pozitiftir, `knownSum`a **girer** ve diğer terimler negatif
olamaz, yani `knownSum >= critical` zaten sağlanır. `critical <= 0` iken de
`knownSum >= 0 >= critical`. **11.310 kombinasyon tarandı, karşı örnek yok.**

Dal referansta olduğu için **korundu** (`knownSum`un tanımı değişirse yeniden anlam kazanır),
ama hata olarak **sayılmıyor**. Üç bulgu gibi göstermek sayıyı şişirmek olurdu.

**Çözüm.** Görüntüleme alanlarına dokunulmadan üç alan eklendi — `open_count`,
`flag_known_sum` (sum(**amount**)), `flag_max_amount` (max(**amount**)); karar
`dayFlagsFromAggregate()`e taşındı ve o, `dayFlags()`in **tam yanında** duruyor. Bir gün
`pressure_status`e göre birden çok kovaya bölünebildiği için birleştirme `dayFlagsForDate()`
içinde, **tek yerde**: sayfa da doğrulama scripti de aynı fonksiyonu çağırıyor, yani test
sayfanın gerçekten koştuğu yolu ölçüyor, ona benzeyen bir kopyayı değil.

**`remaining` kullanımı — ayrı karar gerektiren bulgu, bu turda DEĞİŞTİRİLMEDİ.**
`knownAmount`/`maxAmount` hâlâ `remaining` üzerinden ve grafiği/KPI'ları besliyor. "Bugün ne
kadar para çıkacak" için `remaining` ürün açısından **daha doğru** görünüyor; risk eşiği ise
kural olarak `amount`a bağlı. İkisi ayrı soru ve şimdi ayrı alanlarla cevaplanıyor. Hangisinin
nerede doğru olduğu **ürün kararı** — talimat gereği bu turda dokunulmadı, burada raporlanıyor.

**İkinci bulgu — iptal edilmiş kayıtlar, ayrı karar gerektirir.** Eski sayfa `status !== 'paid'`
süzüyordu, yani **iptal edilmiş** ödemeler "Bugün / Yarın / 7 günlük çıkış" KPI'larına
**giriyordu**. Yeni SQL `active` kümesini beş statüyle sınırlıyor ve iptalleri dışarıda
bırakıyor. Yeni davranış daha doğru görünüyor (iptal edilmiş ödeme bir nakit çıkışı değildir),
ama bu bir **ürün kararı** ve hızlandırma commit'i onu sessizce aldı. Ölçülen etki:
harcanabilir veritabanında bugün-ve-sonrası **0 iptal / 0 unknown / 0 paid** kayıt var, yani
şu an rakamlar **hiç değişmiyor**. Fark semantik, henüz görünür değil.

*(Gecikmiş sayacında böyle bir fark **yok**: `active` içindeki `or` yan tümcesi, geçmiş tarihli
satırların yalnız `OPEN_STATUSES` olanlarını geçiriyor — eski `overdue.length` ile birebir.)*

### 8.3 Doğrulama

```
pnpm lint        PASS   (0 uyarı)
pnpm typecheck   PASS
pnpm test        PASS   (60 dosya, 1328 test)
pnpm build       PASS
finansal golden  PASS   (96/96, tests/financial)
```

**`scripts/db/receivable-totals-verify.ts` — 16/16 PASS** (121 uygun fatura: 11 sınır vakası +
110 hacim; 4 hariç tutulması gereken kayıt)

```
PASS  fixture elle aritmetikle uyuşuyor (bağımsız SQL ile çapraz kontrol)
PASS  liste yalnız ilk 75 satırı döndürüyor
PASS  KPI kayıt sayısı listeyi DEĞİL bütün uygun kayıtları sayıyor
PASS  KPI toplamı 121 kaydın tamamını içeriyor
PASS  gecikmiş sayacı bütün uygun satırları sayıyor
PASS  kova tutar/adet toplamları genel toplamla mutabık
PASS  altı kova sınırının her biri doğru
PASS  liste limiti 5'e indirilince toplamlar DEĞİŞMİYOR
PASS  paid / tam dağıtılmış / purchase / draft kayıtlar toplamın DIŞINDA
PASS  borç toplamı da aynı limitsiz yoldan geliyor
```

Beklenen değerler ürün kodundan **değil**, view'a hiç dokunmayan ayrı bir SQL'den ve elle
aritmetikten (121 kayıt / 7.700 TL) geliyor; ikisi birbiriyle çapraz kontrol ediliyor.

**`scripts/db/payment-day-flags-verify.ts` — 22/22 PASS**

Diferansiyel: aynı fixture üzerinde **eski yol** (`paymentOverviewInstances` + `dayFlags`) ile
**yeni yol** (`loadPaymentDashboard` + `dayFlagsForDate`) koşuluyor ve beş alanın
(`count · knownSum · cluster · large · critical`) **tamamı** karşılaştırılıyor.

```
398 gün × 4 eşik kurulumu — hepsi birebir aynı
  large < critical (ölçülen kurulum) · large = critical · large > critical · cluster susturulmuş

vaka matrisi (elle yazılmış beklenenler)
  ödenmemiş tam tutar · kısmi ödeme · paid/cancelled hariç · tek kalem kritiği aşıyor ·
  toplam kritiği aşıyor · yalnız büyük eşiği aşıyor · tutar NULL · aynı günde çok ödeme ·
  'unknown' statü · sıfır ve negatif tutar · neredeyse tamamı ödenmiş (kalan 1.000 / amount 120.000)
```

### 8.4 Mutasyon kanıtı — testin gerçekten tuttuğunun ölçüsü

| Sabotaj | Sonuç |
|---|---|
| Alacak toplamları yeniden liste limitine bağlandı | **9 / 16 KIRMIZI** |
| Eşikler `remaining`e bağlandı | **7 KIRMIZI** (4 diferansiyel + 3 vaka) |
| `'unknown'` sayıma dahil edildi | **6 KIRMIZI** (4 diferansiyel + 2 vaka) |
| `anyCritical` düşürüldü | **0 kırmızı** ← §8.2'deki bulgunun kaynağı |

Her sabotaj geri alındı.

### 8.5 Uçtan uca duman testi

Üretim derlemesi, harcanabilir DB, gerçek `/login` (QA bypass **KAPALI**), `finance_manager`:

```
/payments             http 200   önyükleme perdesi kapandıktan sonra ölçüldü
/finance/receivables  http 200

RİSKLİ GÜN kartı        6
eski dayFlags() yolu    6      ← aynı veri, bağımsız hesap
```

Ekrandaki rakam, eski uygulamanın aynı veriye verdiği cevapla **birebir**. Alacak ekranı bu
veritabanında 0 fatura gördüğü için "Açık alacak yok" gösteriyor — kırpma yolu duman testinde
değil, 121 fixture'lı doğrulamada ölçüldü.

### 8.6 Fixture temizliği ve gerçek veritabanı

Her iki script de **transaction ROLLBACK** ile temizleniyor, `delete` ile değil. İlk yazımda
silme deneniyordu ve ürün **haklı olarak** reddetti:

```
invoices_block_issued_delete      düzenlenmiş fatura silinemez (durum=open)
invoices_status_transition_guard  open→draft izinli değil
```

Faz 21'in invariant'ı. Rollback yolunda hiçbir tetikleyici ateşlenmiyor, hiçbir invariant
delinmiyor, hiçbir satır kalıcı olmuyor. Kalıntı kontrolü **ayrı bir bağlantıdan** yapılıyor
(iki script de 0 satır doğruladı).

İkisi de `set local role mas_radar_admin` alıyor: bağlantı `mas_radar_app` ile açıldığında RLS
altında `parties` **boş** görünüyor ve `receivable-totals-verify` "referans seed uygulanmamış"
diye duruyordu. Politikalar **delinmiyor** — script ürünün gerçekten kullandığı katmandan
konuşuyor, rol transaction ile geri alınıyor.

`payment-day-flags-verify` fixture penceresini **çalışma anında** seçiyor: sabit bir gün aralığı
yazmak, seed verisi o günlere dokunduğunda testi sessizce "başka satırlarla karışmış" hâle
getirirdi.

**Gerçek `mas_radar_dev` üzerinde hiçbir mutation çalıştırılmadı.** Her şey
`mas_radar_interaction_verify` üzerinde.

### 8.7 Bu turda değişmeyenler

- **Navigation latency testindeki 1 başarısızlık** — §4'teki ayrı bulgu, bu turda dokunulmadı.
- **`.env.example`** — okunmadı, diff'i yazdırılmadı, stage edilmedi. Secret rotation ayrı iş.
- **P24B** — başlanmadı.
- **Push** — yapılmadı.

### 8.8 TestSprite — BLOCKED

Bu oturumda TestSprite **çalıştırılmadı**. Yapılandırılmış bir TestSprite MCP/CLI yolu yok;
`api.testsprite.com` yerel çözümleyicide reddediliyor (`Query refused`), herkese açık DNS ile
çözülüyor ve kök uç 404 dönüyor — yani host ayakta ama bu oturumdan kullanılabilir bir koşu
yolu yok. Localhost'a karşı koşmuş gibi **gösterilmedi**.
