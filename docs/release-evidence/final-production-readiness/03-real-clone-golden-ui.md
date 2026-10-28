# 03 — Gerçek veri klonu üzerinde migration + Golden UI kapısı (AŞAMA 05 + AŞAMA 06)

```text
WORKING COMMIT: ec95de0 (ec95de0893ae350654039477f7ac89df8da2a3ec)
TARGET DATABASE CLASS: DISPOSABLE_CLONE (gerçek üretim verisinin restore'u)
TARGET DATABASE NAME: mas_radar_real_snapshot_0034 → mas_radar_final_rc_clone
REAL DB WRITE USED: NO — mas_radar_dev'e hiç bağlanılmadı
EVIDENCE CLASS: real production data snapshot, restored to DISPOSABLE_CLONE

ORIGINAL PLAN REFERENCE:
- section: Gap Closure Rehberi §10 (AŞAMA 05) + §11 (AŞAMA 06)
- lines: L854-L968 (05), L970-L1100 (06); orijinal plan Faz 3 L673-L824, Faz 5 L916-L975
- acceptance criterion: fresh REAL clone → pnpm db:migrate → 0087 → fingerprint → aynı klonda 24 kritik rota + parasal mutabakat

CURRENT STATUS: VERIFIED PASS
RUN STARTED: 2026-08-25T12:13:12.011Z
RUN FINISHED: 2026-08-25T12:23:47.858Z
```

## Çalışma ortamı — canlı örneğe dokunulmadı

```text
LIVE PRODUCTION INSTANCE: port 3000 — untouched
  kapı öncesi /health: 200 {"status":"ok","app":"up","db":"up","latencyMs":1343,"time":"2026-08-25T12:13:15.876Z"}
  kapı sonrası /health: 200 {"status":"ok","app":"up","db":"up","latencyMs":131,"time":"2026-08-25T12:23:47.828Z"}
GATE BUILD OUTPUT: .next-real-clone-gate (ayrı distDir — canlı .next ezilmedi)
GATE SERVER PORT: 3260
APP ROLE PASSWORD RESET: NO — 'mas_radar_app' kimliği .env.local'den alındı, yalnız DB adı değiştirildi
```

## Kaynak — neden canlı DB değil

Canlı `mas_radar_dev` 2026-08-25 09:43 UTC'de zaten 0087'ye migrate edildi. Onu klonlamak
0035→0087 geçişini yeniden üretemez; klon migrate edilecek hiçbir şey bulamaz ve kapı boş bir
"pending yok" cevabıyla yeşile döner. Bu yüzden kaynak, cutover ÖNCESİ alınmış gerçek
snapshot'tır ve arşiv hash'i doğrulanır:

```text
dump: backups/cutover_A_20260825-1211.dump
sha256 (beklenen = ölçülen): f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d
```

## Komut zinciri (gerçekten koşanlar)

```text
docker cp backups/cutover_A_20260825-1211.dump mas-radar-pg:/tmp/mas_real_clone_gate.dump
docker exec mas-radar-pg pg_restore --list /tmp/mas_real_clone_gate.dump
docker exec mas-radar-pg dropdb -U postgres --force --if-exists mas_radar_real_snapshot_0034
docker exec mas-radar-pg createdb -U postgres mas_radar_real_snapshot_0034
docker exec mas-radar-pg pg_restore --no-owner -U postgres -d mas_radar_real_snapshot_0034 /tmp/mas_real_clone_gate.dump
pnpm release:golden-fingerprint
pnpm exec tsx scripts/db/seed-system-actor.ts
pnpm build
pnpm start (PORT=3260, MAS_NEXT_DIST_DIR=.next-real-clone-gate)
pnpm exec playwright test tests/visual/golden-ui-smoke.spec.ts --reporter=list,json
```

## Exit kodları

```text
pnpm release:golden-fingerprint = 0
tsx scripts/db/seed-system-actor.ts = 0
pnpm build = 0
pnpm exec playwright test tests/visual/golden-ui-smoke.spec.ts = 0
```

## Assertion sayıları

```text
AŞAMA 05 baseline (adım 1)        : 9/9
AŞAMA 05 fingerprint + ledger     : 7/7   (golden-fingerprint kendi içinde: 14/14)
AŞAMA 06 kritik rota              : 24/24
AŞAMA 06 parasal spot-check       : 6/6
AŞAMA 06 yetkilendirme            : 6/6
AŞAMA 06 kapı kontrolleri (adım 3): 8/8
Playwright özeti                  : 36/36 spec geçti (JSON reporter)
```

## Beklenen ↔ gerçek

| Aşama | Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|---|
| step1 | app rolü parolası SIFIRLANMADI (mevcut runtime kimliği yeniden kullanıldı) | pnpm db:app-role:password çağrılmaz | mas_radar_app kimliği .env.local'den, yalnız DB adı 'mas_radar_final_rc_clone' ile değiştirildi | PASS |
| step1 | snapshot sha256 beklenen değerde | f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d | f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d (867701 bayt) | PASS |
| step1 | pg_restore --list arşivi okuyabiliyor | > 0 TOC girdisi | 391 TOC girdisi | PASS |
| step1 | restore edilen ledger = 0034 / 34 satır | 0034 / 34 | 0034 / 34 | PASS |
| step1 | baseline payments | 19 | 19 | PASS |
| step1 | baseline checks | 7 | 7 | PASS |
| step1 | baseline loans | 1 | 1 | PASS |
| step1 | baseline cashflow_months | 35 | 35 | PASS |
| step1 | baseline users | 12 | 12 | PASS |
| step2 | golden-fingerprint (11 değişmez, migration exit_code dahil) exit = 0 | 0 | 0 | PASS |
| step2 | ledger son sürüm = 0087 | 0087 | 0087 | PASS |
| step2 | ledger satır sayısı = diskteki migration dosya sayısı | 87 (diskten ÖLÇÜLDÜ) | 87 | PASS |
| step2 | ledger sürüm kümesi = disk dosya kümesi (elle eklenmiş satır yok) | fazladan 0, eksik 0 | fazladan 0, eksik 0 | PASS |
| step2 | 0035–0087 satırları YALNIZ `pnpm db:migrate` tarafından yazıldı | 53 satır, hepsi applied_by='migrate-script' | 53 satır, farklı applied_by: yok | PASS |
| step2 | checksum override = 0 (uygulanan aralıkta boş checksum yok) | 0 | 0 | PASS |
| step2 | 0035–0087 BU koşuda uygulandı (restore edilmiş satır değil) | hepsi kapı başlangıcından sonra | 0 satır daha eski | PASS |
| step3 | system aktörü klona seed edildi | exit 0 | exit 0 | PASS |
| step3 | production build (ayrı distDir '.next-real-clone-gate' — canlı .next ezilmedi) | exit 0 | exit 0 | PASS |
| step3 | uygulama gerçek veri klonuyla ayağa kalktı (QA bypass KAPALI) | /ready = 200 | http://127.0.0.1:3260/ready = 200 | PASS |
| step3 | kritik rotalar | 24/24 | 24/24 | PASS |
| step3 | DB ↔ UI parasal spot-check (owner SQL bağımsız referans) | 6/6 test (10 parasal büyüklük) | 6/6 | PASS |
| step3 | yetkilendirme matrisi (5 katman + rol değişimi) | 6/6 | 6/6 | PASS |
| step3 | playwright exit = 0 | 0 | 0 | PASS |
| step3 | sunucu gerçekten KLONA bağlandı (gerçek /login oturumları klonda) | 5 test hesabı, >= 5 oturum klonda | 5 hesap, 5 oturum | PASS |

## Migration sonrası gerçek veri hacimleri

Kabul kriteri değil, kanıt. Boş tablolar gerçek bir bulgudur ve gizlenmez: bu şirket henüz
fatura ve banka hareketi modülünü kullanmıyor, dolayısıyla ilgili ekranlar gerçek veride
boş-durum gösterir.

| Tablo | Satır |
|---|---:|
| payments | 19 |
| payment_instances | 485 |
| checks | 7 |
| loans | 1 |
| loan_installments | 48 |
| cashflow_months | 35 |
| parties | 16 |
| cash_accounts | 6 |
| invoices | 0 |
| bank_transactions | 0 |
| users | 12 |

## Kapsam ayrımı — hangi iddia nerede kanıtlandı

Aynı iddianın iki kez sayılmaması için:

- `release:golden-fingerprint` kapsıyor: ledger satır sayısı + son sürüm, bayat `operator` = 0,
  `finance_manager` artışı = önceki `operator` sayısı (**migration 0056 senaryosu, artık gerçek
  veride**), en az bir aktif admin, `users_role_check` beş katman, FK bütünlüğü, blanket
  `authenticated_all` RLS yok, assistant arşiv kısıtı, **checksum drift = 0**, legacy finansal
  tablo hash'leri değişmedi.
- Bu kapı ek olarak kanıtlıyor: ledger sürüm kümesi = disk dosya kümesi (fazladan satır yok),
  0035–0087 satırlarının `applied_by = 'migrate-script'` (tek entrypoint `pnpm db:migrate`,
  elle `schema_migrations` INSERT'i yok), aynı satırlarda boş checksum yok (checksum override = 0),
  ve bu satırların `applied_at`'i bu koşunun içinde (restore edilmiş satır değil).

## Yan etkiler

- **`tsconfig.json`** — `next build` bu dosyayı kendiliğinden yeniden yazar: dizileri çok
  satıra açar, `include`a `<distDir>/types/**/*.ts` ekler ve `next-env.d.ts`i sona taşır. Kapı
  ayrı bir distDir kullandığı için eklenen satır gitignore'lu, yalnız kapı koşarken var olan bir
  dizini gösterir; feature freeze altındaki bir release commit'ine girmemelidir. Kapı dosyayı
  derlemeden sonra birebir eski hâline döndürür (kapı dışından koşulduysa:
  `git checkout -- tsconfig.json`).
- **Canlı production örneği (port 3000)** kapı boyunca ayakta kaldı. Kapının kendi ölçümü
  yukarıdaki "Çalışma ortamı" bloğunda (kapı öncesi/sonrası `/health`); orkestratör ayrıca kapı
  ÖNCESİ, SIRASINDA ve SONRASINDA `/ready = 200` doğruladı.
- **`.next-real-clone-gate`** dizini gitignore'ludur ve commit edilmez.

## Kontaminasyon kontrolü

Pozitif kontrol kapının içindedir ve yukarıdaki tabloda yer alır: `visual_*` hesaplarının
**oturumları** klonda olmalıdır. Kullanıcı satırlarını test süreci yazar, ama `sessions`
satırını gerçek `/login` akışında **sunucu** yazar — klonda oturum varsa sunucu klondaydı.

Negatif kontrol kapının DIŞINDADIR ve bilinçli olarak öyledir: bir release script'inin gerçek
veritabanına bağlanmasını normalleştirmek istemiyoruz. Elle, salt-okunur koşulur:

```bash
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -At \
  -c "select count(*) from users where username like 'visual\_%'" \
  -c "select count(*) from users where username = 'golden_roleflip'" \
  -c "select count(*) from sessions"
```

Beklenen: ilk iki sayı **0** (harness hesapları gerçek veritabanına hiç ulaşmadı) ve oturum
sayısı kapı öncesiyle **aynı**.

## Başarısızlıklar

Yok.

## Notlar

- `next build` tsconfig.json'ı özel distDir için yeniden yazdı; dosya kapı tarafından eski hâline döndürüldü.

## Yeniden üretim

```bash
pnpm release:real-clone-gate
```

Kanıt dosyaları: `docs/release-evidence/final-production-readiness/02-real-clone-migration.md` (AŞAMA 05 manifesti) · `docs/release-evidence/final-production-readiness/03-real-clone-golden-ui.md` (bu dosya) ·
`test-results\real-clone-gate-server.log` (sunucu logu) · `test-results\real-clone-gate-playwright.json` (Playwright JSON raporu).

FINAL: PASS
