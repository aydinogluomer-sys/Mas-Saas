# PROGRESS — production readiness hardening

Kaynak plan: `MAS_SaaS_Production_Readiness_Aggressive_Plan` (agresif hardening / cutover planı).
Branch: `release/production-readiness-hardening` (kaynak: `master` @ `093573e`).

**Kural:** Her faz `PASS / FAIL / BLOCKED` olarak kapanır. "Büyük ölçüde geçti", "lokalde
çalışıyor", "muhtemelen test sorunu" kabul edilmez. Her satır komut / exit code / assertion
sayısı / DB hedefi ile desteklenir.

**Feature freeze aktif.** Bu branch'te yeni finans modülü, dashboard, AI özelliği, entegrasyon,
rapor türü, veri modeli veya route ailesi eklenmez.

---

## Faz 0 — Kanıt dondurma ve release manifest

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Commit | `093573e30f451bb8857bed777352e80838e2e80e` (baseline), Faz 0 commit'i aşağıda |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `REAL_READ_ONLY` (yalnız orkestratörün aldığı fingerprint; bu branch gerçek DB'ye bağlanmadı) |

**Yapılanlar**

- `release/production-readiness-hardening` branch'i `093573e`'den oluşturuldu.
- `docs/release-evidence/migration-manifest.txt`: 87 migration dosyasının SHA256'sı,
  deterministik (zaman damgası yok), iki kez üretilip aynı hash doğrulandı.
  - Manifest SHA256: `f70de82b4d269c3df477db03c963a96b2b793ba755ed918c57013cdf886f495d`
- `docs/release-evidence/2026-08-24-baseline.md`: release manifest YAML + manifest özeti +
  yeniden üretim komutları.

**Bağımsız doğrulama (verilen değerler yeniden hesaplandı)**

| Değer | Beklenen | Gerçekleşen | Sonuç |
|---|---|---|---|
| `sha256sum .github/workflows/ci.yml` | `56635813…c8587c` | `56635813…c8587c` | MATCH |
| `sha256sum pnpm-lock.yaml` | `c676108d…eea9f2c` | `c676108d…eea9f2c` | MATCH |
| `ls supabase/migrations/*.sql \| wc -l` | 87 | 87 | MATCH |
| son migration | `0087` | `0087_assistant_conversations.sql` | MATCH |

**Gerçek DB yazımı:** YOK.

---

## Faz 1 — CI'ı Faz 16'dan gerçek Faz 38 release gate'e yükselt

| Alan | Değer |
|---|---|
| **Durum** | **PASS** (lokal doğrulama), **clean-runner CI sonucu NOT VERIFIED** |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` + `CI_EPHEMERAL` (tamamı harcanabilir; gerçek DB'ye bağlantı yok) |

### Neden Job 2 GERÇEK `pnpm db:migrate` kullanmak zorundaydı

Mevcut CI migration'ları `psql < dosya` döngüsüyle uyguluyordu. Ölçüldü, varsayılmadı:

1. `psql`, `-1` olmadan **her İFADEYİ kendi örtük transaction'ında** çalıştırır. Üç ifadelik bir
   dosyayla kanıtlandı (`create table` / `insert` / `select 1/0`): psql exit 3 verdi, ama tablo
   satırıyla birlikte **commit edilmiş** kaldı. `migrate.ts` ise her pending dosyayı tek bir açık
   `BEGIN/COMMIT` içine alır (`applyPendingSequentially`) ve hata halinde dosyanın tamamını geri
   alır.
2. Ham döngü `schema_migrations`'a **hiç satır yazmıyor**. Bu yüzden planın istediği
   `ledger_count = 87, max(version) = 0087` iddiası o modelde **ifade bile edilemez**.

**Dürüst sınır:** CI veritabanları BOŞ. Migration 0056'nın "pending trigger events" tuzağı,
UPDATE'in eşleşeceği mevcut operatör satırları gerektirir; sıfır satırda hiçbir deferred trigger
kuyruğa girmez (0056'nın kendi başlığı bunu yazıyor). **Hiçbir boş-veritabanı CI koşusu bu hata
sınıfını yakalayamaz** — yalnız veri taşıyan bir clone üzerinden migration yakalar. Bu, sonraki
bir fazın işidir ve bu job onun yerine geçmez.

### İkinci bulgu — mevcut CI'nın phase adımı ZATEN ölüydü

Eski workflow `MIGRATION_DATABASE_URL`'i `mas_phase` adlı bir veritabanına yöneltiyordu.
Faz 17-38 denetiminden beri bu script'ler `requireDisposableOwnerDatabaseUrl()` üzerinden
çözümleniyor ve disposable işareti taşımayan adı reddediyor. `mas_phase` hiçbir işaret taşımıyor.
Yeniden üretildi: `phase11b:verify` o adla **exit 1**, bağlantı bile açmadan. Yani o adım
yalnızca kırmızı olabilirdi; ilan ettiği altı faz hiç kontrol edilmiyordu.

### Lokal doğrulama sonuçları (gerçek komut çıktıları)

| Job | Komut / assertion | Beklenen | Gerçekleşen | Sonuç |
|---|---|---|---|---|
| static | `pnpm typecheck` | 0 hata | 0 hata, exit 0 | PASS |
| static | `pnpm lint` | 0 error | 0 error, 1 warning (mevcut) | PASS |
| static | `pnpm test` | %100 | 1101/1101, exit 0 | PASS (bkz. flake notu) |
| database-migration | ledger runner | `87\|0087` | `87\|0087`, exit 0 | PASS |
| runtime-role-security | rol nitelikleri | `true false false` | `true false false` | PASS |
| runtime-role-security | `db:roles:verify` | ALL PASS | 8/8, exit 0 | PASS |
| runtime-role-security | `db:roles-rls:verify` | ALL PASS | 29/29, exit 0 | PASS |
| runtime-role-security | `db:export-leakage:verify` | 36/36 | 36/36, exit 0 | PASS |
| phase-verifies | Sınıf A tamamı | 28/28 | **28 PASS / 0 FAIL**, exit 0 | PASS |
| build | `pnpm build` | exit 0 | exit 0 | PASS |
| e2e-authz | `phase17-38-routes.spec.ts` | 94/94 | **94 passed**, exit 0 | PASS |
| legacy-semantic-smoke | `legacy-semantic-smoke.spec.ts` | 10/10 | **10 passed**, exit 0 | PASS |

### Faz 2'yi MİRAS ALMADI

Görev, yeni smoke paketinin QA-bypass/redirect-loop sorununa çarpabileceği konusunda uyarmıştı.
Çarpmadı: paket QA bypass'ı **hiç kullanmıyor**, `phase17-38-routes.spec.ts` ile aynı mekanizmayla
gerçek oturum satırı basıyor. On rotanın onu da 200 döndü, hiçbiri `/login`'e düşmedi.

### Smoke paketi vakumlu değil — iki gerçek hatayı yakaladı

Yazıldığı ilk hâliyle iki kez kırmızı verdi ve **her ikisinde de haklı olan üründü, testti yanılan**:

1. `/overview`: "veri/KPI yüzeyi yok" dedi. İncelendi — sayfa tamamen doğruydu: başlık "Ana Ekran",
   tam navigasyon, ve bilinçli bir "Henüz veri yok" onboarding paneli. CI veritabanı migrate
   edilmiş ama finansal satır taşımıyor (`supabase/seed.sql` yalnız referans veri). Boş durum
   DOĞRU render'dır. Assertion "veri VAR" yerine "**ya veri göster ya nedenini söyle, asla sessiz
   kalma**" olarak düzeltildi. Sahte para seed'lenmedi — finansal fixture'a uydurma para koymak,
   testin yalan söylemeye başlama biçimidir. Daha katı "gerçek KPI rakamı" iddiası
   `MAS_SMOKE_REQUIRE_DATA=1` ile golden-clone gate'ine bırakıldı.
2. `/radar`: "son URL beklenenden farklı, /payments'a gitti". İncelendi — `next.config.ts`'te
   **kalıcı 301**. Planın on rotalık listesi IA konsolidasyonundan ÖNCE yazılmış. Dördü yönlendirme:
   `/radar→/payments`, `/financing→/finance`, `/reports→/insights/reports`,
   `/reminders→/insights/reminders`. Beklenen hedef artık testte açıkça yazılı, böylece plansız bir
   yönlendirme (örn. `/login`) hâlâ kırmızı verir.

### Push öncesi yakalanan CI-kırıcı hata

`scripts/ci/*.sh` git'te `100644` (executable değil) kayıtlıydı; workflow onları doğrudan
çağırıyordu → Linux runner'da "Permission denied". Çağrılar `bash …` önekine çevrildi ve
`.gitattributes`'a `*.sh text eol=lf` eklendi (CRLF'li bir `.sh` Linux'ta "bad interpreter" ile ölür).

**Düzeltme (Faz 2'de fark edildi):** Bu bölüm önce "`git update-index --chmod=+x` uygulandı" diyordu.
Doğru değil. Komut çalıştırıldı, ama sonrasındaki `git add` mod'u çalışma ağacından geri yazdı ve
commit `100644` ile gitti — `git ls-files -s scripts/ci/` bugün hâlâ `100644` gösteriyor. Pratik
etkisi yok, çünkü workflow ve runner script'i dosyaları her yerde `bash script.sh` ile çağırıyor
(execute-bit gerekmiyor); ama iddia yanlıştı ve kanıt belgesinde yanlış bir satır bırakmak, yanlışın
kendisinden daha pahalıdır.

### Gerçek DB yazımı

**YOK.** Rol/parola gerektiren işler ayrı bir Docker cluster'ında (`mas-radar-pg-ci-sandbox`,
port 55432) yapıldı; PostgreSQL rolleri **cluster genelindedir**, dolayısıyla `mas_radar_dev`'i
barındıran cluster'da `mas_radar_app`'e parola vermek gerçek veritabanına login dağıtmak olurdu.
Sandbox cluster'da `mas_radar_dev` yok.

### Açık kalanlar

- **NOT VERIFIED:** Yedi job'un GERÇEK GitHub runner'daki sonucu. Lokalde her job'un
  komutları tek tek çalıştırıldı; `act`/gerçek runner kullanılmadı.
- **P1 (izlenecek):** `pnpm test` bir kez ağır eşzamanlı yük altında 1098/1098 test geçmesine
  rağmen "Errors 1 error" ile exit 1 verdi (bir test dosyası timer hatasıyla düştü). Sonraki iki
  koşuda 1101/1101 exit 0. Kök neden bulunmadı; retry ile maskelenmedi.
- **P2:** `src/components/charts/analytics-chart.tsx:62` React Hook uyarısı. Düzeltilmedi —
  bu depoda Claude'un ürün kaynak kodunu düzenlememesi yönünde duran bir kural var ve görev bu
  düzeltmeyi açıkça opsiyonel/blocker-değil olarak işaretledi. Önerilen düzeltme:
  `normalizeGranularity`'yi `useCallback(…, [granularityOptions, model.defaultGranularityByPeriod])`
  ile sarıp effect bağımlılığına eklemek (`granularityOptions` zaten `useMemo`'lu).
- **P2:** `/radar`, `/financing`, `/reports`, `/reminders` altındaki `page.tsx` dosyaları
  `next.config.ts` 301'leri yüzünden kendi URL'lerinden **erişilemez** durumda (ölü kod).
- **P2:** `scripts/db/verify.sh` de migration'ları ham `psql` döngüsüyle uyguluyor; `pnpm db:verify`
  bu yüzden production migration yolunu temsil etmiyor. Bu fazda değiştirilmedi.


---

## Faz 2 — Legacy Playwright harness'ını güvenilir hale getir

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Commit | aşağıdaki Faz 2 commit'i |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — `mas_radar_visual_verify`, **izole** sandbox cluster (`mas-radar-pg-faz2-sandbox`, port 55433) |
| Gerçek DB yazımı | **YOK** |

### Kök sorun ve çözüm

QA bypass `getCurrentUser()` içinde (Node, DB'li) **çerezsiz** bir kullanıcı döndürüyor;
`src/middleware.ts` (Edge) yalnız **çerez varlığına** bakıyor. İkisi birbirini görmüyor →
`/overview → /login → /overview` sonsuz döngüsü. Ayrıca `getQaBypassUser()` production'da `null`
döndüğü için bypass, hedef ortamda zaten yapısal olarak ölü.

Çözüm: `tests/visual/global-setup.ts` beş rolü disposable DB'ye seed eder, her birini **gerçek
`/login` formundan** giriş yaptırır, `storageState` kaydeder (viewer/operator/approver/manager/admin).
Sunucunun kapalı olduğu doğrulandı: çerezsiz `/overview` → **307 → /login**.

### Faz 2 PASS kriterleri

| Kriter | Durum |
|---|---|
| legacy harness auth loop yok | **PASS** — 35 testin hiçbiri `/login`'e düşmedi |
| hard-coded port 0 | **PASS** — `grep -R "127.0.0.1:31" tests/visual` → 0 |
| critical semantic smoke green | **PASS** — 35/35 semantik kapıyı geçti |
| visual failures 0 ya da açıklanmış delta | **AÇIKLANMIŞ** — 20 baseline deltası + 1 performans bulgusu |
| ürün ↔ harness regresyonu ayrılabiliyor | **PASS** — kalan 21 kırmızının 20'si yalnız `toHaveScreenshot` |

### Son koşu (35 test): **14 PASS / 21 FAIL**

```text
20  Error: expect(page).toHaveScreenshot     -> baseline deltası
 1  Error: 200ms içinde ne iskelet ne varış  -> gerçek performans gözlemi
```

Auth hatası **0**, semantik hata **0**, harness flake'i **0**.
Faz 1 paketleri regresyona uğramadı: `legacy-semantic-smoke` 10/10, `phase17-38-routes` 94/94.

### Bulunan ve kaydedilen kusurlar

1. **`data-vr` mekanizması hiç çalışmamış.** Üç spec `addInitScript` içinde
   `document.documentElement.setAttribute(...)` çağırıyordu; o anda `documentElement` henüz yok,
   script her yüklemede patlıyordu. Ölçüm: `data-vr=null`, pageerror=1, `[data-volatile]` **görünür**.
   Yani mevcut baseline'ların tamamı zaman damgası içeriyor ve takvimle kayıyor. Düzeltildikten
   sonra: `data-vr=1`, pageerror=0, `[data-volatile]` gizli. Kimse fark etmemişti çünkü eski
   spec'lerin hiçbiri `pageerror` dinlemiyordu.
2. **`payment-iteration-15.spec.ts` hiç yeşil olmamış.** Dört assertion üründe hiç var olmayan
   şeyleri iddia ediyordu (`age=91-plus`, `/arşivlenmiş ödeme/`, gizli düğüme `.first()`, iki
   elemanlı selector) — `git log -S` ile doğrulandı. Beşincisi (`Ödeme Arşivi` başlığı görünür)
   yazıldığında doğruydu: spec `8f068b1`'de **19:23**'te eklendi, dokuz-modül yeniden yapılandırması
   `5deed68` `ModuleFrame` + `globals.css:417` kuralını **19:24**'te getirdi. Bilinçli IA değişikliği,
   regresyon değil.
3. **`workers: 1` gerekiyordu.** `fullyParallel: false` yalnız dosya içini sıralar; dosyalar
   worker'lar arası paralel koşmaya devam eder. Zamanlama testleri bu yüzden birlikte koşunca
   düşüyordu.
4. **Giriş oran sınırı ve giriş sonrası yarış** globalSetup'ta ele alındı; sınır **gevşetilmedi**.
5. **`mode: "serial"`** iki spec'te ilk hatadan sonrasını "did not run" yapıyordu; kaldırıldı.

### Baseline'lar GÜNCELLENMEDİ

`docs/visual-snapshot-policy.md` altı koşul sayıyor; "screenshot bir insan tarafından incelendi" ve
"PR'da before/after görsel kanıt" koşullarını karşılayacak olan insandır, ajan değil. Kök nedenler
yazıldı, karar insana bırakıldı. `pnpm test:visual:update` **çalıştırılmadı**.

### Açık kalanlar

- **P2 (performans):** gecikmeli rotada kullanıcı üç koşunun ikisinde 200 ms içinde ne iskelet ne
  varış alıyor. Ölçüm ortamı yüklü (Postgres + Next + Chromium aynı makinede). Planın Faz 14
  performans kapısının konusu.
- **P2 (baseline):** 23 baseline `-chromium-win32`; Linux runner'da `-chromium-linux` aranır ve
  bulunamaz. Legacy görsel paketin CI release gate'inde **olmamasının** teknik nedeni budur.
- **P1 (güvenlik) — KAPANDI.** `scripts/seed-demo.ts` artık
  `requireDisposableOwnerDatabaseUrl("seed:demo")` kullanıyor (commit `c287bed`). İzole sandbox'ta
  iki yönlü doğrulandı: `mas_radar_dev` → exit 1 "GÜVENLİK DURDURMASI", disposable klon → exit 0.


---

## Faz 3 — Kritik eski ekranlar için "Golden UI Smoke"

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | **`DISPOSABLE_SYNTHETIC`** — `mas_radar_ui_golden_clone`, izole cluster (`mas-radar-pg-faz3-sandbox`, port 55434) |
| Gerçek DB yazımı | **YOK** |
| Spec | `tests/visual/golden-ui-smoke.spec.ts` — **36/36 PASS**, üç ardışık koşuda aynı |

### Veri sınıfı dürüstlüğü

Plan §6.1 gerçek `mas_radar_dev`'in `pg_dump → restore → migrate → 0087` klonunu istiyor. **Bu
çalıştırılmadı** — gerçek DB kimlik bilgisi bu harness'a kasten verilmedi. Onun yerine aynı kaynak
çalışma dosyasını işleyen `seed:demo` klonu kullanıldı; başlık sayıları örtüşüyor
(payments=19, checks=7, loans=1, cashflow_months=35), ledger `87/0087`. Bu PASS, **birebir-klon
kapısının geçildiği anlamına gelmez**.

### Faz 3 PASS kriterleri

| Kriter | Sonuç |
|---|---|
| critical route semantic smoke = 100% | **24/24** (planın 24 rotasının tamamı mevcut, ikame yok) |
| critical monetary spot checks = 100% | **12/12 değer**, exact equality, float toleransı yok |
| unexplained blank page = 0 | **0** |
| unexplained console/page error = 0 | **0** (console.error, pageerror, 5xx, hydration ayrı ayrı) |
| unauthorized access = 0 | **0** (`/system/controls` üç düşük katmana kapalı; rol düşürülünce aynı oturum yeni rolü kullanıyor) |

Aynı clone üzerinde Faz 1/2 paketleri de yeşil: `legacy-semantic-smoke` **10/10**,
`phase17-38-routes` **94/94**.

### En önemli bulgu — spot-check'in kendisi sessizce yalan söylüyordu

Beklenen değerler ilk sürümde `mas_radar_app` bağlantısıyla okunuyordu. O rol **RLS'e tabi** ve
katman bağlamı yokken **hiçbir şey görmüyor**:

```text
owner (postgres):  checks = 7   gecikmiş payment_instances = 29
mas_radar_app:     checks = 0   payment_instances          = 0
```

Buna rağmen üç spot-check PASS veriyordu: sıfır satır → toplam 0 → `fmtTL(0)` = `"0 TL"` → bu
metin neredeyse her ekranda var. Mutabakat sıfırı sıfırla karşılaştırıp "uyuştu" diyordu — arkasında
hiçbir şey olmayan bir yeşil ışık. Düzeltme: beklenen taraf artık **owner** bağlantısıyla okunuyor
ve `beforeAll` ground-truth boşsa paketi **durduruyor**.

### Ürünün haklı çıktığı üç bulgu

1. **"BUGÜN" brüt değil KALAN tutarı gösteriyor.** Bugün vadesi gelen tek kalem 50.000, 20.000'i
   ödenmiş; ekran 30.000 diyor. Doğru tanım `sum(amount - coalesce(paid_amount,0))`.
2. **Çek sayısı 7 değil 6.** 7 satırın biri arşivli; ekran aktif portföyü gösteriyor. 7 görünmeye
   başlarsa arşivlenmiş enstrüman canlı portföye dönmüş demektir — finansal kusur.
3. **`.instant-navigation-skeleton` kalıcı düğüm** (`count=1, display:none`); "takılı navigasyon"
   kontrolü varlık değil **görünürlük** üzerinden yazılmalıydı.

### Yan düzeltme

Üç spec'in disposable-ad kapısı `/verify|test|e2e/` idi ve adı açıkça "clone" olan bir veritabanını
reddediyordu. Liste `scripts/db/owner-url.ts`'deki kanonik `DISPOSABLE_MARKERS` ile hizalandı —
doğru girdide yanlış alarm veren bir kapı, insanlara kapıyı atlamayı öğretir.

### Açık kalanlar

- **Birebir gerçek klon kapısı çalıştırılmadı** (kimlik bilgisi yok).
- Golden spec **CI'da koşmuyor**: gerçek sunucu + veri taşıyan klon gerektiriyor. CI'daki karşılığı
  boş-veritabanı `legacy-semantic-smoke` job'udur.


---

## Faz 4 — RBAC / RLS / güvenlik

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — `mas_radar_security_verify`, izole cluster (port 55435) |
| Gerçek DB yazımı | **YOK** |
| Yeni gate | `pnpm db:security-matrix:verify` — **17/17**, CI'da `runtime-role-security` job'unda |

**Toplam 90 güvenlik iddiası geçti:** roles 8/8 · roles-rls 29/29 · export-leakage 36/36 ·
security-matrix 17/17.

### Kapatılan beş boşluk

| Plan | Boşluk | Kapanış |
|---|---|---|
| 7.1 | UPDATE/DELETE yalnız `payments`'ta kodla karşılaştırılıyordu; EXPORT/SEARCH hücresi yok | 443 deneme (5 katman × 47 dolu tablo × 2 fiil) + EXPORT/SEARCH önkoşulu |
| 7.2 | Üç katman vardı, **anlaştıkları** doğrulanmıyordu (bağ bir yorumdu) | menü↔guard 45 kombinasyon + RLS açıklık taraması |
| 7.3 | Oturum yaşam döngüsü tamamen doğrulanmamıştı | 7 senaryo canlı sunucuya karşı + DB predicate fixture'ları |
| 7.4 | `getRawPool()` iki dosyada kontrol ediliyordu | depo geneli allowlist assertion'ı |
| 7.5 | Hiçbir tarama mutasyon yüzeyini kapsamıyordu | 30 server-action dosyası taranıyor |

### Testimin yanıldığı, ürünün haklı çıktığı üç yer

1. **GRANT ≠ yetki.** `has_table_privilege()` ile `can()`'i karşılaştıran ilk sürüm doğru kodda
   kırmızı verdi. Grant'lar sahiplik-kapsamlı tablolarda kasten geniş; yetki = grant **VE** politika.
   Ölçüldü: viewer `action_items` INSERT grant'ı taşıyor, insert yine de RLS ile reddediliyor.
2. **RLS sessizce reddeder.** İstisna bekleyen sürüm altı sağlıklı tabloyu suçladı; reddedilen
   UPDATE hata vermez, **0 satır** ile başarıyla döner. Satır sayısıyla ölçmeye çevrildi.
3. **`canSeeModule` ≠ `canAccessRoute`.** Farklı granülerlikte sorular. Asıl yanıltıcı durum
   assertion'a çevrildi: bir modül ancak içinde açılabilir rota varsa menüde sunulur.

### Oturum adversarial (canlı sunucu, aynı çerez)

iptal → **307 /login** · süresi dolmuş → **307 /login** · pasif kullanıcı → **307 /login** ·
rol yükseltildi → erişim **açıldı** · rol düşürüldü → **red kabuğu**. `public.sessions` rol kopyası
taşımıyor. Atıl süre yalnız kodda pinlendi (60 dk beklenmedi) — bu maddenin HTTP kanıtı yok.

### Açık P2 (kapatılmadı, gizlenmedi)

`src/app/(dashboard)/reminders/actions.ts`'teki iki server action kimlik doğrulaması çağırmıyor.
Gate'te gerekçeli istisna olarak **kayıtlı**. P1 değil çünkü ölçüldü: middleware çerezsiz reddediyor,
`getDbContext()` geçersiz oturumu `EMPTY` yapıyor ("katman yok" hiçbir şey yazamaz) ve 443 denemelik
tarama `reminder_deliveries` dâhil hiçbir katmanın satır oynatamadığını gösterdi. Yetkisiz durum
değişikliği erişilebilir değil; eksik olan **temiz ret**. Onaylanırsa düzeltme: iki action'a
`requireSession()` + `finance_manager+` rol kontrolü. Ürün kaynağı olduğu için uygulanmadı.

### Yan gözlem

`seed:demo` fixture'ında aktif admin sayısı **0**; migration 0031'in
`enforce_at_least_one_active_admin()` trigger'ı bu yüzden her kullanıcı güncellemesini reddediyor.
Ürün kusuru değil — invariant görevini yapıyor.

### Faz 4 PASS

Plan kriteri "Security checklist'te P0/P1 açık = 0": **P0 = 0, P1 = 0** (P2 = 1). **PASS.**


---

## Faz 4 ek — reminders auth boşluğu KAPATILDI

`scheduleRemindersAction` / `dispatchRemindersAction` artık `requireSession()` + `finance_manager`
veya `admin` kapısından geçiyor (commit `17de55f`). Gerekçe iki katmanlı:

1. **RLS yedeği koşulluydu.** O argüman yalnız runtime gerçekten `mas_radar_app` kimliğiyle
   bağlanırken geçerli; gerçek kurulumda bu bilerek henüz böyle değil (cutover adımı). O zamana
   kadar bu iki action, önemli olan tek ortamda hiç guard taşımıyordu.
2. **RLS yan etkiye ulaşamaz.** `dispatchPending()` Telegram mesajı gönderir; satır güvenliğinin
   giden mesaj hakkında söyleyecek sözü yok. Alt katmanlar bekleyen kümeyi okuyabildiği için bir
   viewer, teslim satırı reddedilirken mesaj gönderilmesine yol açabilirdi.

`security-matrix-verify.ts`'teki gerekçeli istisna kaldırıldı: **30/30 dosya**, tek istisna giriş
yüzeyinin kendisi. Doğrulama: 17/17 ALL PASS, typecheck 0, lint 0 error, build exit 0.

---

## Faz 5 — Migration ve veri bütünlüğü release prosedürü

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — izole cluster (`mas-radar-pg-faz5-sandbox`, port 55436) |
| Gerçek DB yazımı | **YOK** |
| Komut | `pnpm release:golden-fingerprint` → **14/14 PASS** |

### Ne değişti

Golden exact-clone koşusu zaten yapılmıştı (orkestratör, gerçek DB). Eksik olan kanıt değil
**tekrarlanabilirlikti**: elle yapılmış bir prosedür bir sonraki cutover'dan önce birebir
tekrarlanamaz, devredilemez ve hangi assertion'ların kontrol edildiği sonradan anlaşılamaz.
`scripts/release/golden-fingerprint.ts` o koşuyu tek komuda çevirir:

```text
kaynak DB → fresh pg_dump → pg_restore --list → fresh restore → ÖNCE parmak izi
          → gerçek pnpm db:migrate → SONRA parmak izi → 14 değişmez → manifest
```

### §8.3 değişmezleri — 14/14

ledger 87 · son sürüm 0087 · bayat operator 0 · finance_manager artışı = önceki operator sayısı ·
aktif admin ≥ 1 · `users_role_check` beş katman · 170 FK hedefsiz 0 · blanket RLS 0 · assistant
arşiv tutarlılık kısıtı · checksum drift 0 · **legacy finansal 6 tablonun veri hash'i değişmedi** ·
dump alındı · `pg_restore --list` okunabilir · öncesi parmak izi (85 tablo).

Ledger sayısı ve son sürüm **diskten türetiliyor**, koda gömülmüyor: 87'yi sabitlemek 0088 geldiği
gün doğru bir veritabanında kırmızı verir ve "düzeltmenin" doğal yolu sayıyı büyütmektir — kapı
böyle formaliteye dönüşür.

### Hash tasarımı

Whole-row `t::text` yerine **migration öncesi kolonlar** üzerinden projeksiyon. Şema eklemesi
whitelist'te olduğu için `t::text` "bütün veri değişti" derdi — hiçbir veri değişmemişken; bunu bir
kez gören operatör uyarıyı yok saymayı öğrenir. Hash ayrıca sıra bağımsız.

### Detektörün gerçekten gördüğü kanıtlandı

`payment_instances` üzerinde: bir satırın `amount` değeri değişince hash `925ced52…` → `cd14951b…`.
**İlk denemem yanlış negatif verdi:** hedef satırın `amount` değeri `NULL`'dı, `NULL + 1 = NULL`,
yani `UPDATE 1` raporlandı ama hiçbir şey değişmedi. Projenin kendi "null bilinmeyendir, sıfır
değildir" kuralı testi yazana çarptı.

### Güvenlik kapıları (doğrulandı)

`CLONE_DB=mas_radar_dev` → `GÜVENLİK DURDURMASI`, exit 1, bağlantı açılmadan. Kaynağa yalnız
`pg_dump` dokunur. Clone her koşuda düşürülüp yeniden yaratılır ("eski clone tekrar kullanılmaz"
zorunluluk, tavsiye değil).

### Sınır — dürüstçe

Sandbox "kaynağı" zaten 0087'de olduğu için `db:migrate` adımı bu koşuda **iş yapmadı**
(`state=LEDGER_MANAGED`). Akışın tamamı, 14 assertion ve manifest üretimi çalıştı; gerçek 0034→0087
geçişi orkestratörün gerçek DB koşusudur ve bu script onu **kodlar**, yerine geçmez. Aynı nedenle
"finance_manager artışı = önceki operator sayısı" değişmezi yalnız boş hâliyle (operator=0)
sınanabildi: 0087'deki `users_role_check` `operator` değerini kabul etmiyor.

### Faz 5 PASS

Plan kriteri "Migration evidence tek komutla yeniden üretilebilir": `pnpm release:golden-fingerprint`
— tek komut, 14/14, manifest üretiliyor. **PASS.**


---

## Faz 6 — Backup / restore readiness

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — izole cluster (`mas-radar-pg-faz6-sandbox`, port 55437) |
| Gerçek DB yazımı | **YOK** |
| Komut | `pnpm release:restore-drill` → **9/9**, beş kapı da YES |

### Faz 6 PASS kapıları

```text
BACKUP EXISTS            = YES   1.380.380 bayt · sha256 90afec4d…
BACKUP READABLE          = YES   pg_restore --list, 1.387 TOC girdisi
BACKUP RESTORABLE        = YES   85 tablo
RESTORED DATA MATCHES    = YES   85 sayı + 6 parasal toplam + 85 satır hash'i birebir
APP CAN START ON RESTORE = YES   /ready = 200 · golden-ui-smoke 36/36
```

### Faz 5'in üzerine kuruldu

Ortak ölçüm `scripts/release/lib/fingerprint.ts`'e çıkarıldı; iki script de onu kullanıyor. Refactor
sonrası Faz 5 regresyonu: `golden-fingerprint` **14/14**, değişmedi. Faz 6'nın eklediği: makbuzlar
(§9.1/§9.2) ve **uygulama fazı** (§9.3).

### Beşinci kapı gerçekten düştü ve bulduğu şey gerçekti

İlk koşu: dört kapı YES, beşinci NO. Veritabanı kusursuzdu (85 tablo, bütün hash'ler birebir), ama
uygulama `permission denied for table users` ile açılmadı. Sebep: restore `--no-acl` ile
yapılıyordu ve GRANT'lar geri gelmemişti. Yan yana ölçüm:

```text
--no-owner            : app SELECT users = true   INSERT users = true   SELECT payments = true
--no-owner --no-acl   : app SELECT users = false  INSERT users = false  SELECT payments = false
```

`golden-fingerprint.ts`'te ACL atmak savunulabilir (clone'a yalnız owner dokunur, eski grant'lar
eksik bir grant'ı maskeleyebilir); bir **restore'da** grant'lar geri gelmesi gerekenin parçasıdır.
İki script farklı bayrak kullanıyor, nedeni ikisinde de yazılı. **Satır sayısına bakan bir restore
kontrolü bunu asla göremezdi** — beşinci kapının varlık sebebi bu.

İkinci bulgu: ilk başarısızlık yalnız "sunucu hazır olmadı" diyordu, gerçek sebep `stdio:"ignore"`
ile atılmıştı. Sunucu çıktısı artık dosyaya yazılıyor ve başarısızlıkta rapora giriyor.

### Kapsanan maddeler

- **§9.1** backup receipt: dokuz alanın tamamı üretiliyor (timestamp, source_db,
  system_identifier, git_sha, schema_ledger, file_size, sha256, pg_version, pg_dump_version).
- **§9.2** restore proof: ayrı DB'ye restore, counts/aggregates/hash karşılaştırması, owner ile
  login gerekmeyen read test, restore receipt.
- **§9.3** tam prova: backup → drop → create → restore → doğrula → **uygulamayı başlat** →
  kritik smoke. Smoke `golden-ui-smoke` (36/36), yani 24 ekran + **12 parasal mutabakat** artık
  restore edilmiş veri üzerinde doğrulanıyor.
- **§9.4** retention: `docs/backup-restore-policy.md` — pre-cutover **immutable** + post-cutover +
  rolling; tek kopya yasağı; en az bir kopya fiziksel olarak farklı depolama hedefinde. Gerçek
  zamanlanmış görev/uzak hedef **kurulmadı**, gereksinim ve yaklaşım belgelendi.

### Sınır

Prova sentetik-ama-gerçekçi kaynak üzerinde koşuldu (`seed:demo`). Gerçek `mas_radar_dev` yedeği bu
harness'ta alınamaz — kimlik bilgisi kasten yok. Script gerçek kaynak için hazır; çalıştırma
kimlik bilgisine sahip operatörün işi.


---

## Faz 7 — Cutover provası

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-24 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — izole cluster (`mas-radar-pg-faz7-sandbox`, port 55438) |
| Gerçek DB yazımı | **YOK** — gerçek cutover Faz 8'dir ve bu çalışmanın kapsamı değildir |

### Prova A — normal success path

| Yol | Komut | Sonuç |
|---|---|---|
| İleri (migration) | `pnpm release:golden-fingerprint` | **14/14**, exit 0 |
| Geri dönüş (restore) | `pnpm release:restore-drill` | **9/9**, beş kapı YES, smoke 36/36 |

Cutover'ın her iki yönü de tek komut ve provalı.

### Prova B — bilinçli failure injection (dördü de gerçekten enjekte edildi)

| # | Enjeksiyon | Gözlenen | Karar |
|---|---|---|---|
| B1 | yanlış DB parolası | `password authentication failed`, exit 1, sunucu **hiç açılmadı** | CONFIG ROLLBACK |
| B2 | migrate kesintisi (SIGKILL) | kesinti `56/0056` → tekrar çalıştır → `87/0087`, exit 0 | **RETRY** |
| B3 | `payments` üzerinde RLS kapatıldı | ALL PASS → **FAIL: "RLS KAPALI: payments"**, exit 1 | STOP + CONFIG ROLLBACK |
| B4 | `alter role mas_radar_app nologin` | `/ready` **200**, `/health` **503** `db:"down"` + nedeni | CONFIG ROLLBACK |

B4 üç şeyi birden kanıtladı: `/health` gerçekten kırmızıya dönüyor, `/ready` 200 kalıyor
(canlılık/bağımlılık ayrımı çalışıyor — restart politikası `/health`'e bağlansaydı sağlıklı
uygulama her DB hıçkırığında yeniden başlatılırdı), ve `dbError` nedeni adıyla söylüyor.

### Prova sırasında çıkan iki bulgu

1. **Marker listesi beş yerde kopyalanmıştı ve kaydı.** `restore-drill.ts` "drill" işaretini
   ekledi; `mas_radar_cutover_rollback_drill` adlı veritabanı test harness'i tarafından
   reddedildi — prova, cutover'la ilgisi olmayan bir nedenle smoke adımında düştü. Artık tek
   kaynak: `scripts/db/owner-url.ts`'in `isDisposableDatabaseName()`'i; harness ve iki release
   script'i onu **import ediyor**, regex kopyası kalmadı.
2. **`migrate.ts` pending varsa zorunlu yedek alıyor** ve veritabanını `MAS_DB_CONTAINER`
   (varsayılan `mas-radar-pg`) içinde arıyor — release script'lerimin kullandığı
   `MAS_PG_CONTAINER`'dan farklı bir değişken. Sandbox'ta `Backup hedefi bulunamadı` ile
   hard-fail verdi. Bu migrate.ts'in **haklı** davranışı (yedekleyemediğini migrate etmez) ama
   provayı imkânsız kılıyordu; `golden-fingerprint.ts` artık değişkeni iletiyor. Önceki
   koşularda hiç pending olmadığı için yedek adımı devreye girmemiş ve boşluk görünmez kalmıştı.

### Faz 7 PASS

Beş kararın (STOP / RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE) beşi de somut sinyallere
bağlandı ve her sinyal provada **gerçekten üretildi**. Karar kuralı:

> Şemaya dokunulmadıysa **CONFIG ROLLBACK**. Kesinti ise önce **RETRY**.
> Şema değişti ve doğrulanamıyorsa **DB RESTORE**. Sınıflandırılamıyorsa **ESCALATE**.

### READY FOR CUTOVER durumu

Planın §20 listesindeki on kalemin **dokuzu karşılandı**. Açık kalan tek kalem **gerçek GitHub
runner CI sonucu** (`gh` authenticate değil) — atlanmış değil, kapsam dışı olduğu belgelendi.
Ayrıntı: `docs/release-evidence/faz7-cutover-rehearsal.md` §5.

**Faz 8 (gerçek DB A–L cutover) bu çalışmanın görevi değildir; burada durulmuştur.**


---

## Faz 1 — GÜNCELLEME: clean-runner CI artık DOĞRULANDI (2026-08-25)

Faz 1 yukarıda "PASS (lokal), clean-runner NOT VERIFIED" olarak kapanmıştı. Bu tur gerçek GitHub
runner'da doğrulandı **ve** clean-runner'ın açığa çıkardığı beş gizli hata (lokalde görünmüyorlardı)
dürüstçe düzeltildi:

1. `static` TS2307 — `.gitignore` `data/` deseni `src/components/data/`'yı yutmuş, bileşen commit'siz.
2. `build` provision `dropdb` socket — `ensure.ts` probu postgres:16 init yarışına takılıyordu → TCP prob.
3. `database-migration` `db:migrate:verify` ENOENT — p0c-checkpoint özel dump'ı CI'da yok → sınıflandı.
4. `database-migration` 7–10. adım — p0b-managed-baseline özel dump'ı → LOCAL_PRIVATE_DATA_GATE'e taşındı.
5. `build` `phase16:verify` süreç asılması — yetim `next` çocuğu → `detached` + `process.exit(0)`.

**Sonuç:** run **32785111779**, HEAD `2709491`, conclusion=**success**, **7/7 job yeşil, failed=0**
(`e2e-authz` + `legacy-semantic-smoke` bu dalın tarihinde ilk kez koştu). Ayrıntı ve tam kanıt
zinciri: `docs/status-notes.md` "Faz 1 kapanış turu". Böylece Faz 1'in tek açık kalemi kapandı.


---

## Faz 12 — Observability (telemetry + fail-closed alert)

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-25 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — `mas_radar_telemetry_verify` (harcanabilir, kendi enjekte ettiği sentetik durum) |
| Gerçek DB yazımı | **YOK** |
| Komutlar | `pnpm ops:telemetry` (canlı anlık görüntü) · `pnpm ops:telemetry:verify` (kapı) |

### Ne teslim edildi

Tek-operatör/tek-makine dağıtımı için Prometheus kurmak izlenenden pahalıya gelirdi. Planın istediği
daha dar ve daha yararlı: her sinyalin NEREDE yaşadığını bilmek ve tehlikeli olan altısını bir grafikte
okunmadan durmak yerine **yüksek sesle başarısız** kılmak.

- `scripts/ops/telemetry-snapshot.ts` — tek komutta runtime/DB/uygulama sinyalleri + **altı fail-closed
  uyarı** (backup yaşı, takılı iş, bayat içe aktarım, mutabakat sapması, runtime kimliği, şema ledger'ı).
  "belirlenemiyor" = **BAŞARISIZ**, "muhtemelen iyi" değil. Exit 0 = ALL CLEAR, exit 1 = ALERT.
- Altı uyarının saf eşik mantığı `src/lib/ops/telemetry-alerts.ts`'e çıkarıldı; snapshot onu import
  ediyor (araç ile kapı tek tanımı paylaşır, birbirinden kayamaz). `MAS_BACKUP_DIR` yapılandırılabilir
  yapıldı (gerçek yedek hedefine ya da doğrulamada kontrollü temp dizinine yönlenir).

### Anti-totoloji kanıtı — iki katman

1. **Birim (`src/lib/ops/telemetry-alerts.test.ts`, 18 test):** her uyarı için sağlıklı değerde
   TEMİZLENİR, eşiği aşınca ATEŞLENİR, ve **veri belirlenemediğinde ("?", Infinity, NaN, null,
   boş) ATEŞLENİR**. Kör iki okumanın uyuşması ledger'ın sağlam olduğunun kanıtı değildir —
   `ledgerAlert("?","?")` de ateşliyor (script'in kendi doktrinine göre kesin fail-closed).
   `pnpm test`'in parçası → CI `static` job'unda koşar.
2. **Entegrasyon (`scripts/ops/telemetry-verify.ts`, 14 kontrol):** GERÇEK snapshot script'ini
   harcanabilir migrate edilmiş DB'ye karşı alt süreç olarak koşturur; enjekte edilebilen her sinyal
   için uyarının kötü durumda **ateşlendiğini** ve düzeltilince **temizlendiğini** iki yönlü kanıtlar:
   takılı iş, sahte ledger satırı, boş backup dizini → ateşler; temizlenince → ok. runtime_user
   gerçek `current_user`'ı okur (owner → 'postgres' → ateşler). latest_import boşken 'İÇE AKTARIM YOK'
   okur (aşağıdaki bulgu), taze içe aktarımda ok'a döner.

### Bulunan gerçek defekt — `latest_import_age_days` her koşuda "?" veriyordu

Entegrasyon doğrulaması gerçek şemaya karşı koşunca yakaladı: telemetri `max(created_at)` sorguluyordu
ama `source_workbooks`'ta o kolon **yok** — kolon `imported_at`. Sorgu her koşu fırlıyor, sinyal "?"
okuyor ve içe aktarım bomboş tazeyken bile uyarı ateşliyordu — fail-closed olduğu için güvenli, ama
**işe yaramaz**. `imported_at`'e düzeltildi; doğrulama artık boş-tablo değerinin tam olarak
'İÇE AKTARIM YOK' olduğunu (yani "?" DEĞİL) iddia ediyor, böylece bir kolon yeniden adlandırması bunu
sessizce geri getiremez.

### CI

`database-migration` job'una "Observability telemetry alerts (Faz 12)" adımı eklendi: taze disposable
DB provision edip `ops:telemetry:verify` koşar (veri-bağımsız, kendini temizler). p0b gate'lerinin
aksine CI'da koşar çünkü özel veri değil, kendi sentetik durumunu enjekte eder.

### Doğrulama — gerçek çıktı (exit code + sayı)

| Kontrol | Komut | Sonuç |
|---|---|---|
| Birim | `pnpm exec vitest run src/lib/ops/telemetry-alerts.test.ts` | **18/18**, exit 0 |
| Tam süit | `pnpm test` | **1129/1129** (1111 + 18), exit 0 |
| Typecheck | `pnpm typecheck` | **exit 0** |
| Lint | `pnpm lint` | **exit 0** (1 önceden var olan uyarı) |
| Entegrasyon | `MIGRATION_DATABASE_URL=…mas_radar_telemetry_verify pnpm ops:telemetry:verify` | **14/14**, exit 0 |

### Sınır — dürüstçe

Entegrasyon iki sinyali TEK yönde kanıtlıyor: `reconciliation` (kötü yolu banka
`bank_transactions`↔`cashflow_months` zinciri gerektirir) ve `runtime_user`'ın "temiz" yolu
(`mas_radar_app` login gerektirir). İkisinin de mantığı birim testte iki yönlü kapatıldı; entegrasyon
onların **wiring**'ini (sorgu gerçekten çalışıyor, gerçek değeri okuyor) kanıtlıyor. Bu ayrım açıkça
belgelendi, gizlenmedi.


---

## Faz 14 — Performance gate (kritik rota SLO + query plan + index audit)

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-25 |
| DB sınıfı | `DISPOSABLE_SYNTHETIC` — `mas_radar_perf_verify` (aritmetik üretilmiş gerçekçi hacim) |
| Gerçek DB yazımı | **YOK** |
| Komut | `pnpm perf:gate` (disposable DB'ye karşı) |

### Ne değişti

Yanındaki Faz 33 araçları (`measure.ts`, `index-audit.ts`, `volume.ts`) **ölçüyor ve sıralıyor**;
hiçbiri başarısız olmaz. `scripts/perf/perf-gate.ts` ölçeklenebilirliği gerçekten yordayan ölçümleri
**pass/fail iddiaya** çevirir — gerçekçi hacim yüklenmiş harcanabilir bir DB'de, planner tek sayfaya
sığan bir tabloyu seq-scan etmek yerine production'daki gibi davranırken.

### Neden ms eşiği değil, plan şekli

Wall-clock SLO runner'la kayar; plan şekli kaymaz. Kapı dört **seçici** sorgu üzerinde (bir rotanın
gerçekten attığı şekil: "vadesi yaklaşan", "açık faturalar") ilgili büyük tablonun **indeks ile**
okunduğunu (Seq Scan DEĞİL) iddia eder. 60.000 satırlık `bank_transactions`'ı "son 7 gün" için
seq-scan etmek her makinede regresyondur. "Hiçbir yerde seq scan olmasın" DEĞİL — bütün tabloyu
döndüren bir view onu taramalıdır; doğru iddia dar olanıdır: seçici-sorgu-indeks-kullanmalı.

### Ampirik temel (ölçüldü, uydurulmadı)

Gerçekçi hacim (bank_transactions=60k, invoices=24k, payment_instances=12k, checks=6k) altında dört
seçici rota sorgusunun dördü de indeks kullanıyor: payment_instances→Index Scan, invoices→Bitmap
Heap Scan (Bitmap Index Scan çocuğuyla), bank_transactions→Index Scan, checks→Bitmap Heap Scan. Not:
`working_capital_trend_reference` 2040 ms ama **Index Only Scan** kullanıyor — eksik indeks değil,
bilinçli "reference" (aylık korelasyonlu, optimize edilmiş varyantla karşılaştırma için yavaş) view;
kritik kümeye alınmadı.

### Kapının dört iddiası

1. **Query plan (deterministik, hard):** dört seçici hot-path sorgusu büyük tablosuna indeks ile
   erişir (Index / Index Only / Bitmap Heap Scan) — Seq Scan yok.
2. **Gereksiz indeks = 0** (deterministik).
3. **İndekssiz FK cırcırı:** sayı ölçülen taban çizgisini (115) aşmaz. Bugün 115 var — dürüstçe
   raporlandı, gizlenmedi — ve düşük öncelikli, çünkü (1) read hot-path'lerin amaca-özel kapsayıcı
   indekslerle beslendiğini kanıtlıyor (bu FK'ler source_*/created_by kolonları, kritik okumaların
   join'lemediği). Cırcırın dar ve gerçek işi: bir migration FK ekleyip indeksini unutursa sayı 116
   olur ve burada düşer — bu sınıf regresyonun en yaygın giriş yolu.
4. **Felaket eşiği (cömert backstop):** seçici sorgular ~1 ms; eşik yalnız toplam bozulmayı yakalar
   (3000 ms), yavaş CI runner'ı asla düşürmez.

### Kapının kendisinde bulunan iki bulgu (çalıştırarak)

1. **İlk plan iddiam yanlıştı — Bitmap Heap Scan'i reddediyordu.** invoices/checks Bitmap Heap Scan
   kullanıyor (indeks-güdümlü; Bitmap Index Scan çocuğu indeksi "Index Name" ile taşır, "Relation
   Name" ile değil, o yüzden tablo düğümlerinde görünmez). `/Index/` testi onu yanlışça reddetti;
   doğru iddiaya çevrildi: "tabloya her erişim indeks-güdümlü (Index/Index Only/Bitmap Heap Scan)".
2. **Anti-totoloji kanıtı (negatif kontrol):** `payment_instances`'ın tüm hizmet indeksleri
   düşürülünce sorgu Seq Scan'e döndü ve kapı **9/10 ile düştü** (`Seq Scan`, exit 1) — kapı gerçek
   bir regresyonu yakalıyor, sadece yeşil basmıyor. Sonra DB temiz yeniden provision edildi.
   Not: tek `payment_instances_due_idx`'i düşürmek yetmedi — planner `status` indeksine düştü (Bitmap
   Heap Scan), kapı haklı olarak yeşil kaldı; seq-scan ancak TÜM hizmet indeksleri gidince oluştu.

### CI

`database-migration` job'una "Performance gate (Faz 14)" adımı eklendi: taze disposable DB provision
edip `perf:gate` koşar. Veri-bağımsız (hacim aritmetik üretiliyor), o yüzden CI'da koşar.
package.json: `perf:gate`.

### Doğrulama — gerçek çıktı (exit code + sayı)

| Kontrol | Komut | Sonuç |
|---|---|---|
| Typecheck | `pnpm typecheck` | **exit 0** |
| Sağlıklı şema | `…mas_radar_perf_verify pnpm perf:gate` | **10/10**, exit 0 |
| Negatif kontrol (indeksler düşürüldü) | aynı, seq-scan zorlandı | **9/10, exit 1** ("Seq Scan") |

### Sınır — dürüstçe

Kapı seçici okuma yollarını ve indeks hijyenini gate'liyor. **Yazma yolu SLO'su** (bulk import/insert
gecikmesi) ve **route-seviyesi uçtan uca HTTP gecikmesi** bu kapının konusu değil; okuma planı +
indeks hijyeni + felaket eşiği kapsanıyor. İndekssiz 115 FK bir cırcırla tutuluyor, hepsi indekslenmedi
(çoğu küçük/soğuk tablolarda; write-maliyeti okuma faydasını aşardı ve read hot-path'ler zaten kapsanmış).


---

## Faz 15 — AI ve entegrasyon sınırı (boundary gate)

| Alan | Değer |
|---|---|
| **Durum** | **PASS** |
| Timestamp (UTC) | 2026-08-25 |
| DB sınıfı | **YOK** — saf statik kaynak taraması (DB yok, ağ yok) |
| Gerçek DB yazımı | **YOK** |
| Komut | `pnpm boundary:verify` |

### Ne teslim edildi

Diğer kapılar "kod çalışınca doğru mu" diye sorar; bu kapı çalıştırmanın güvenilir cevaplayamadığı
**yapısal** soruyu sorar: finansal veri incelenmemiş bir yoldan süreçten çıkabilir mi, bir sır bir
log'a/audit'e/client bundle'a kaçabilir mi? Bunlar kaynağın özellikleri, o yüzden kaynağa karşı —
statik, DB'siz, ağsız — kontrol edilir ve `static` CI job'unda yaşar. `scripts/boundary-verify.ts`.

Kod tabanının yorumlarda zaten savunduğu kararların yazılı hâli: integrations/types.ts "hiçbir
entegrasyon ağa kendi başına ulaşamaz" (ctx.http seam), ai/engine.ts "model yalnız mutationIntent +
AI_FORCE_DETERMINISTIC arkasında ve AI yalnız kendi snapshot log'una yazar", transport/fx-provider
"env tembel okunur, process.env'e yalnız tek seam dokunur". Bir yorum umuttur; bunlar iddiaya çevrildi.

### Ampirik temel — tüm çıkış noktaları sayıldı

Repo-geneli tarama: src'de yalnız **5 `fetch(`** var, hepsi 4 tasarlanmış sınır modülünde:
ai/engine.ts (OpenAI), fx/provider.ts (TCMB), integrations/types.ts (realHttpClient seam),
reminders/transport.ts (Telegram+email). connectors.ts ağa yalnız ctx.http ile ulaşır (doğrudan
fetch yok). process.env yalnız env.ts (doğrulanmış kaynak) + integrations/types.ts readCredential
(isimle-okuma seam)'de. assistant/engine.ts yalnız log tablolarına yazar (assistant_conversations,
ai_response_snapshots) — finansal tabloya değil.

### Sekiz iddia

A. Ağ çıkışı yalnız izinli 4 modülde (dışarı fetch/ws/raw-http; same-origin `/api/...` serbest).
B. Sınır modülleri process.env'e dokunmaz (yalnız env.ts + readCredential seam).
C. ai/engine + reminders/transport env'i **tembel** okur (üst-seviye `@/lib/env` importu yok).
D. AI/asistan/arama alt ağacı finansal tabloları **mutasyona uğratmaz**.
E. env/process.env nesnesi hiçbir yerde `JSON.stringify` ile basılmaz (kayıtlı kural).
F. Sınır modüllerinde `console.*` çağrısı sır (token/apiKey/credential/Bearer) taşımaz.
G. ai/engine kill switch (aiForceDeterministic) + mutationIntent kapısı yerinde (regresyon guard'ı).
H. Muhasebe konnektörü kalıcı reddediyor (vendor seçilmedi; ACCOUNTING_PENDING_REASON + permanent:true).

### Kapının kendisinde bulunan iki şey (çalıştırarak)

1. **Yorum içi false-positive:** B ilk koşuda transport.ts'in KENDİ yorumunu ("this file never
   touches process.env") işaretledi. Naif `//` sıyırma `https://` URL'lerini bozacağı için tam
   yorum satırları (satır-başı `//`, jsdoc `*`, `/* */` bloğu) atlanacak şekilde tarayıcı düzeltildi.
2. **Anti-totoloji (negatif kontrol):** src/lib/ai altına geçici bir dosya kondu (dış fetch +
   process.env + `insert into public.payments` + `JSON.stringify(process.env)` + console'da token).
   Kapı **3/8 ile düştü**, tam beş ihlali (A,B,D,E,F) adıyla bildirdi; dosya silinince **8/8**.

### CI

`static` job'una "AI/integration boundary gate (Faz 15)" adımı eklendi (`pnpm boundary:verify`).
DB/ağ gerektirmez. Davranışsal AI/entegrasyon kanıtı phase verify'larında kalır (phase12a/37/38).
package.json: `boundary:verify`.

### Doğrulama — gerçek çıktı (exit code + sayı)

| Kontrol | Komut | Sonuç |
|---|---|---|
| Typecheck | `pnpm typecheck` | **exit 0** |
| Temiz kaynak | `pnpm boundary:verify` | **8/8**, exit 0 |
| Negatif kontrol (enjekte ihlal) | geçici dosyayla | **3/8, exit 1** (A,B,D,E,F) |

### Sınır — dürüstçe

Statik kapı **yapıyı** kanıtlar: sırların nereden çıkabileceğini ve AI'ın ne yazamayacağını.
Konnektörlerin/transport'ların GERÇEK istek kurulumu ve davranışı (mockHttpClient/mockTransport ile)
phase37/phase6b/phase25/phase38 verify'larında iki yönlü kapatıldı; bu kapı onların yerine geçmez,
üstüne yapısal bir katman koyar. Canlı endpoint'e karşı test hâlâ yok (ortamda ağ yok) — bu, sınır
modüllerinin başından beri belgelediği dürüst limit.

---

## Karar kaydı — branch protection (2026-08-25)

Kullanıcı **Seçenek C**'yi seçti: GitHub Pro'ya yükseltme yok, repo public yapılmayacak, branch
protection **kurulmadan** devam ediliyor. Gerekçe: force-push/history-rewrite bu repoda hiç
kullanılmadı (Faz 0–7 + 11/12/14/15 boyunca) ve CI `on: push` ile her itmede zaten zorunlu
koşuyor; eksik olan yalnız GitHub'ın "required check" zorunluluğu, sinyalin kendisi değil.
Ayrıntı ve kalan risk: `docs/status-notes.md` → "Kullanıcı eylemi bekleniyor (Faz 1)" madde 1.
**`CI yeşil ≠ master korumalı`** ayrımı geçerliliğini koruyor.


---

## Karar kaydı — cutover ertelendi (2026-08-25)

Kullanıcı **Seçenek 1**'i onayladı: çalışan production'ın uyumlu olduğu `ef00970`'te kalınıyor,
tam A→L cutover ayrı ve hazırlıklı bir oturuma ertelendi. Gerekçe: bugün F/G adımları D olmadan
denendi ve üç gerçek hata çıktı (GRANT yok → `permission denied`; eski PowerShell
`$env:DATABASE_URL` `.env.local`'ı sessizce geçersiz kılıyor; kod 0056'yı varsayarken DB 0034'te
→ `users_role_check` ihlali). **Gerçek DB zarar görmedi** (ledger 0034, bütün sayılar değişmedi).
Dört tuzak ve yeni **C2** adımı (kod sürümünü D'den hemen önce hedefe geçir)
`docs/release-evidence/cutover-checklist.md`'ye işlendi.

---

# Gap Closure Rehberi — yürütme kaydı (2026-08-25)

Kaynak: `MAS_SaaS_Production_Readiness_Gap_Closure_Rehberi.md`. Bu bölüm, yukarıdaki fazların
daha önce yazılmış `PASS` etiketlerinin **üstüne geçer**. Rehber §5 (AŞAMA 00) gereği artık
`PASS` yazabilmek için tek başına "script yeşil döndü" yetmiyor: **orijinal kabul kriterinin,
orijinal kriterin istediği VERİ SINIFINDA** kanıtlanmış olması gerekiyor. Bir faz
`DISPOSABLE_SYNTHETIC` üzerinde kanıtlanmış ama orijinal kriter `DISPOSABLE_CLONE` (gerçek
`mas_radar_dev` klonu) istiyorsa, o faz `VERIFIED PASS` olamaz — `CONDITIONAL PASS` olur.
Yukarıdaki faz bölümlerindeki teknik içerik (komutlar, assertion sayıları, bulgular) geçerliliğini
korur; **yalnız statü etiketleri** bu bölümdeki tabloyla değiştirilmiştir. Çelişki hâlinde bu
bölüm bağlayıcıdır.

Kullanılan `evidence_class` değerleri: `REAL_READ_ONLY` / `DISPOSABLE_CLONE` /
`DISPOSABLE_SYNTHETIC` / `CI_EPHEMERAL` / `PRODUCTION_WRITE` / `STATIC_SOURCE` / `NONE`.

## Statü düzeltme tablosu — özet

| Faz | Eski etiket | **Düzeltilmiş statü** | Ana eksik |
|---|---|---|---|
| Faz 0 — Kanıt dondurma | PASS | **VERIFIED PASS** | yok |
| Faz 1 — CI release gate | PASS | **CONDITIONAL PASS** | master promote edilmedi, master CI yeşil değil, branch protection = APPROVED DEVIATION |
| Faz 2 — Legacy harness | PASS | **VERIFIED PASS + P2 debt** | pixel baseline drift, navigation-perf |
| Faz 3 — Golden UI Smoke | PASS | **CONDITIONAL PASS** | synthetic proof green, REAL_CLONE not verified |
| Faz 4 — RBAC/RLS/güvenlik | PASS | **VERIFIED PASS** | cutover sonrası runtime kimliği yeniden doğrulanmalı |
| Faz 5 — Migration prosedürü | PASS | **CONDITIONAL PASS** | final RC real-clone rerun pending |
| Faz 6 — Backup/restore | PASS | **CONDITIONAL PASS** | restore tooling proven, real operational backup incomplete |
| Faz 7 — Cutover provası | PASS | **VERIFIED PASS** | final RC değişirse yeniden koşulmalı |
| Faz 8 — Gerçek DB cutover | (ertelendi) | **PARTIAL** | adım D canlı koştu; A makbuzu + F–L kapanmadı |
| Faz 9 — Hypercare | — | **NOT STARTED** | tamamı |
| Faz 10 — Gerçek kullanım | — | **NOT STARTED** | tamamı |
| Faz 11 — Financial correctness | (dağınık PASS) | **PARTIAL** | distributed correctness coverage strong, unified golden fixture missing |
| Faz 12 — Observability | PASS | **PARTIAL/STRONG** | telemetry gate exists, production operationalization pending |
| Faz 13 — Operational resilience | (örtük) | **PARTIAL** | runbook seti eksik, second-operator drill yok |
| Faz 14 — Performance | PASS | **PARTIAL/STRONG** | query plan/index gate pass, route/write SLO pending |
| Faz 15 — AI/entegrasyon sınırı | PASS | **VERIFIED PASS** (yalnız mevcut sınır) | canlı vendor açılırsa ayrı release gate şart |

## Faz bazlı YAML metadata (rehber §5 kabul kriteri)

### Faz 0 — Kanıt dondurma ve release manifest

```yaml
status: VERIFIED PASS
original_plan_reference: "Aggressive Plan §3 Faz 0 — L216-L260"
evidence_class: STATIC_SOURCE
verified_on: 2026-08-24
verified_commit: 9011398 (+ 0dae59b)
verified_db_class: NONE
remaining_gap: "yok — 87 migration hash manifesti iki kez uretildi ve ayni cikti; ci.yml hash'i o gunden beri degisti, final RC'de yeniden olculecek"
```

### Faz 1 — CI release gate

```yaml
status: CONDITIONAL PASS
original_plan_reference: "Aggressive Plan §4 Faz 1 — L262-L559; PASS kriteri L551-L557; branch protection §4.4 L530-L549"
evidence_class: CI_EPHEMERAL
verified_on: 2026-08-25
verified_commit: 2709491 (GitHub Actions run 32785111779, conclusion=success, 7/7 job, failed=0)
verified_db_class: CI_EPHEMERAL
remaining_gap: "master promote edilmedi; master uzerinde yesil CI kosusu yok; branch protection = APPROVED DEVIATION (docs/release-evidence/governance-waiver.md). Yedi job'un yesil olmasi 'master hazir' anlamina gelmez."
```

### Faz 2 — Legacy Playwright harness

```yaml
status: VERIFIED PASS + P2 debt
original_plan_reference: "Aggressive Plan §5 Faz 2 — L562-L671; PASS L663-L671"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-24
verified_commit: a6524b8
verified_db_class: DISPOSABLE_SYNTHETIC (mas_radar_visual_verify, izole cluster port 55433)
remaining_gap: "P2 — pixel snapshot baseline'lari bilincli olarak GUNCELLENMEDI (21 FAIL kayitli ve kusur olarak belgelendi); navigation-perf P2"
```

### Faz 3 — Golden UI Smoke

```yaml
status: CONDITIONAL PASS — synthetic proof green, REAL_CLONE not verified
original_plan_reference: "Aggressive Plan §6 Faz 3 — L673-L824; test DB §6.1 L679-L697; PASS L817-L824"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-24
verified_commit: 8d580c1
verified_db_class: DISPOSABLE_SYNTHETIC (mas_radar_ui_golden_clone, izole cluster port 55434)
remaining_gap: "orijinal kriter gercek mas_radar_dev'in pg_dump -> restore -> migrate klonunu (DISPOSABLE_CLONE) istiyor; bu kosulmadi. 36/36 sentetik yesil, ama birebir-klon kapisi acik. AŞAMA 05 + AŞAMA 06'da kapatilacak."
```

### Faz 4 — RBAC / RLS / güvenlik

```yaml
status: VERIFIED PASS
original_plan_reference: "Aggressive Plan §7 Faz 4 — L829-L914; PASS L910-L914"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-24
verified_commit: 9066e29 (+ 17de55f)
verified_db_class: DISPOSABLE_SYNTHETIC (mas_radar_security_verify, izole cluster port 55435)
remaining_gap: "90 guvenlik iddiasi gecti (roles 8/8, roles-rls 29/29, export-leakage 36/36, security-matrix 17/17). Bir P2 acik birakildi ve gizlenmedi. Cutover sonrasi gercek runtime kimligi (mas_radar_app) uzerinde yeniden dogrulanmali."
```

### Faz 5 — Migration ve veri bütünlüğü prosedürü

```yaml
status: CONDITIONAL PASS — final RC real-clone rerun pending
original_plan_reference: "Aggressive Plan §8 Faz 5 — L916-L975; invariant set §8.3 L958-L969; PASS L971-L975"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-24
verified_commit: df8674e
verified_db_class: DISPOSABLE_SYNTHETIC (izole cluster port 55436)
remaining_gap: "release:golden-fingerprint 14/14 invariant sentetik hedefte gecti. Orijinal kriter final RC HEAD ile FRESH gercek DB dump'i uzerinde kosum istiyor; bu yapilmadi. AŞAMA 05."
```

### Faz 6 — Backup / restore readiness

```yaml
status: CONDITIONAL PASS — restore tooling proven, real operational backup incomplete
original_plan_reference: "Aggressive Plan §9 Faz 6 — L977-L1043; PASS L1036-L1043"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-24
verified_commit: 6ad8527
verified_db_class: DISPOSABLE_SYNTHETIC (izole cluster port 55437)
remaining_gap: "release:restore-drill 9/9 ve bes kapi da YES — ancak sentetik kaynakta. Eksik: gercek kaynaktan fresh backup receipt, ayri restore target, off-device/ayri fiziksel kopya, retention ve operational schedule, operational target'tan geri yukleme. AŞAMA 07."
```

### Faz 7 — Cutover provası

```yaml
status: VERIFIED PASS
original_plan_reference: "Aggressive Plan §10 Faz 7 — L1048-L1076; PASS L1067-L1076"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-24
verified_commit: 5fdc15a
verified_db_class: DISPOSABLE_SYNTHETIC (izole cluster port 55438)
remaining_gap: "Prova A basari yolu + Prova B'de dort ariza gercekten enjekte edildi ve yakalandi. Final RC degisirse yeniden kosulmasi zorunlu (AŞAMA 11). Gercek DB yazimi yok."
```

### Faz 8 — Gerçek DB cutover A–L

```yaml
status: PARTIAL
original_plan_reference: "Aggressive Plan §11 Faz 8 — L1081-L1320"
evidence_class: PRODUCTION_WRITE
verified_on: 2026-08-25
verified_commit: "685c20b (yalniz checklist kaydi) — adim D repo commit'i olmadan CANLI kosuldu"
verified_db_class: PRODUCTION_WRITE (mas_radar_dev)
remaining_gap: "Adim D (migration) gercek DB'de 2026-08-25 09:43:55.769957+00 - 09:43:57.982695+00 arasinda kosuldu; ledger 0034 -> 0087. Adim A dogrulanmis-yedek MAKBUZU kapatilmadi; F-L adimlari kapatilmadi. P0-DRIFT-01 (verify fixture satirlari gercek DB'de) OPEN. Ayrinti: docs/release-evidence/final-production-readiness/00-real-db-drift-manifest.md"
```

### Faz 9 — Hypercare

```yaml
status: NOT STARTED
original_plan_reference: "Aggressive Plan §12 Faz 9 — L1324-L1367"
evidence_class: NONE
verified_on: null
verified_commit: null
verified_db_class: NONE
remaining_gap: "tamami — hypercare penceresi, shadow accounting, gercek mutabakat"
```

### Faz 10 — Gerçek kullanım

```yaml
status: NOT STARTED
original_plan_reference: "Aggressive Plan §13 Faz 10 — L1371-L1420"
evidence_class: NONE
verified_on: null
verified_commit: null
verified_db_class: NONE
remaining_gap: "tamami — route usage telemetrisi, IA konsolidasyonu, gercek kullanici is dongusu"
```

### Faz 11 — Financial correctness

```yaml
status: PARTIAL — distributed correctness coverage strong, unified golden fixture missing
original_plan_reference: "Aggressive Plan §14 Faz 11 — L1424-L1468"
evidence_class: CI_EPHEMERAL
verified_on: 2026-08-25
verified_commit: 126f44f
verified_db_class: NONE (birim invariant testleri DB'siz kosar) + CI_EPHEMERAL (DB'li phase verify'lar)
remaining_gap: "Tek deterministik golden fixture paketi ve ELLE tanimlanmis expected output seti yok. Mevcut kanit dagitik testlerde; rehber §13 (AŞAMA 08) birlesik kapiyi ve bagimsiz aritmetikle dogrulanmis beklenen degerleri sart kosuyor."
```

### Faz 12 — Observability

```yaml
status: PARTIAL/STRONG — telemetry gate exists, production operationalization pending
original_plan_reference: "Aggressive Plan §15 Faz 12 — L1472-L1516"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-25
verified_commit: 48ef9b5
verified_db_class: DISPOSABLE_SYNTHETIC (mas_radar_telemetry_verify)
remaining_gap: "Fail-closed alert kapisi ve telemetry snapshot var, CI'da kosuyor. Eksik: gercek prod scheduling, alert delivery kanali, runtime/DB/app katmanlarinin operasyonel kullanimi. AŞAMA 09."
```

### Faz 13 — Operational resilience

```yaml
status: PARTIAL
original_plan_reference: "Aggressive Plan §16 Faz 13 — L1520-L1562"
evidence_class: STATIC_SOURCE
verified_on: 2026-08-25
verified_commit: "6ad8527 (docs/backup-restore-policy.md) + 685c20b (docs/release-evidence/cutover-checklist.md) — ayrilmis bir Faz 13 commit'i yok"
verified_db_class: NONE
remaining_gap: "Tam runbook seti eksik; second-operator drill hic yapilmadi; secret rotation prosedurü yok. Rehber §30.6: 'runbook exists' operasyona hazir demek degildir — runbook KOSULMUS olmali. AŞAMA 20."
```

### Faz 14 — Performance

```yaml
status: PARTIAL/STRONG — query plan/index gate pass, route/write SLO pending
original_plan_reference: "Aggressive Plan §17 Faz 14 — L1566-L1601"
evidence_class: DISPOSABLE_SYNTHETIC
verified_on: 2026-08-25
verified_commit: cb5be45
verified_db_class: DISPOSABLE_SYNTHETIC (mas_radar_perf_verify, aritmetik uretilmis hacim)
remaining_gap: "perf:gate plan sekli + index audit uzerinden kosuyor. Eksik: HTTP route SLO, write/import SLO, UI interactive readiness olcumu. AŞAMA 10."
```

### Faz 15 — AI ve entegrasyon sınırı

```yaml
status: VERIFIED PASS (yalniz MEVCUT sinir icin)
original_plan_reference: "Aggressive Plan §18 Faz 15 — L1605-L1641"
evidence_class: STATIC_SOURCE
verified_on: 2026-08-25
verified_commit: 5eb2d84
verified_db_class: NONE (saf statik kaynak taramasi; DB yok, ag yok)
remaining_gap: "Kapi bugunku sinirin yapisini kanitlar. Canli vendor/endpoint acilirsa bu PASS DUSER ve AYRI bir release gate zorunlu olur. Canli endpoint'e karsi test yok — ortamda ag yok, bu limit bastan beri belgeli."
```

## Gap-closure aşama defteri (00–22)

Sıra rehber §4'ten alınmıştır ve **değiştirilemez**.

| Aşama | Ad | Durum | Commit | Test | Tarih |
|---|---|---|---|---|---|
| 00 | Durum iddialarını düzelt | **DONE** | `PENDING-SHA` | 16 faz statüsü düzeltildi, 16/16 YAML metadata bloğu yazıldı | 2026-08-25 |
| 01 | Feature freeze'i yeniden teyit et | **DONE** | `PENDING-SHA` | 22/22 commit denetlendi, violation=0, borderline=2 | 2026-08-25 |
| 02 | Final release candidate'ı sabitle | **SCAFFOLD** | `PENDING-SHA` | manifest 8/9 alan ölçüldü, `rc_sha` PENDING | 2026-08-25 |
| 03 | Governance / master sapması | **DONE** | `PENDING-SHA` | Seçenek C waiver yazıldı, 6/6 compensating control eşlendi | 2026-08-25 |
| 04 | Hardening branch clean CI final doğrulaması | PENDING | — | — | — |
| 05 | Fresh REAL clone: migration + fingerprint | PENDING | — | — | — |
| 06 | Aynı REAL clone üzerinde Golden UI + monetary smoke | PENDING | — | — | — |
| 07 | Gerçek kaynak backup/restore + off-device readiness | PENDING | — | — | — |
| 08 | Consolidated financial correctness gate | PENDING | — | — | — |
| 09 | Observability operationalization | PENDING | — | — | — |
| 10 | Performance gap closure | PENDING | — | — | — |
| 11 | Final RC cutover rehearsal | PENDING | — | — | — |
| 12 | PR → master promotion | PENDING | — | — | — |
| 13 | Master clean-runner CI | PENDING | — | — | — |
| 14 | READY FOR CUTOVER board | PENDING | — | — | — |
| 15 | Gerçek DB A–L (+C2) cutover | PENDING | — | — | — |
| 16 | Immediate post-cutover verification | PENDING | — | — | — |
| 17 | Hypercare + shadow accounting | PENDING | — | — | — |
| 18 | Controlled pilot | PENDING | — | — | — |
| 19 | Real-use telemetry + IA consolidation | PENDING | — | — | — |
| 20 | Operational resilience / second-operator drill | PENDING | — | — | — |
| 21 | Final production scorecard | PENDING | — | — | — |
| 22 | Feature freeze removal | PENDING | — | — | — |

**Not:** Aşama 15, Faz 8'in adım D'si canlı koştuğu için "sıfırdan" değildir; ancak A makbuzu ve
F–L adımları kapanmadığı için aşama `PENDING` kalır. Ayrıntı:
`docs/release-evidence/final-production-readiness/00-real-db-drift-manifest.md`.

## Bu turda üretilen kanıt dosyaları

| Dosya | Aşama | İçerik |
|---|---|---|
| `docs/release-evidence/final-production-readiness/README.md` | 00 | §32'nin 19 slotluk indeksi + gerçek doluluk durumu (1/19) |
| `docs/release-evidence/final-production-readiness/00-real-db-drift-manifest.md` | 05 ön koşulu | Gerçek DB read-only manifest, drift açıklaması, P0-DRIFT-01 |
| `docs/release-evidence/final-production-readiness/00-final-rc-manifest.md` | 02 | RC manifest scaffold, `rc_sha: PENDING` |
| `docs/release-evidence/final-production-readiness/01-feature-freeze-reconfirmation.md` | 01 | 22 commit denetimi |
| `docs/release-evidence/governance-waiver.md` | 03 | Seçenek C waiver |

**Bu turda gerçek DB'ye yazma: YOK.** Yürütülen tek DB işlemi orkestratörün `REAL_READ_ONLY`
sınıfındaki salt-okunur sorguları ve harcanabilir probe DB üzerindeki restore denemesidir; probe DB
ölçümden sonra düşürülmüştür.
