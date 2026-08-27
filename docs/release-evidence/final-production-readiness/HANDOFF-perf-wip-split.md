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

**Ölü kod (bu turda dokunulmadı):** `paymentOverviewInstances()` artık hiçbir yerden
çağrılmıyor ama `queries.ts`'te export olarak duruyor.

---

## 7. Push durumu ve sıradaki adım

Push **yapılmadı**. Uzak branch'e göre **4 commit ileri** (`6dd6c68`, `68f7aca`, `44d9c5f`,
`4b8eb19`), 0 geri. `origin/master`'a göre 58 ileri.

P24B keşfine **başlanmadı** (talimat gereği).

Sıradaki kritik yol değişmedi: çalışma ağacını stabilize et → P24B salt-okunur → off-device
yedek → açık onay → fixture temizliği → final RC → branch CI → PR/master → master CI → cutover.
