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
