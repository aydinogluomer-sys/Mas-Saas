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
çağırıyordu → Linux runner'da "Permission denied". `git update-index --chmod=+x` uygulandı ve
çağrılar `bash …` önekine çevrildi (iki bağımsız koruma). Ayrıca `.gitattributes`'a `*.sh text
eol=lf` eklendi: CRLF'li bir `.sh` Linux'ta "bad interpreter" ile ölür.

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
