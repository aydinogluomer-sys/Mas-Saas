# 07 — Observability operasyonelleştirme (AŞAMA 09)

**WORKING COMMIT (çalışmanın başladığı HEAD):** `58c2eeb`
**BRANCH:** `release/production-readiness-hardening`
**TARİH (UTC):** 2026-08-25

**TARGET DATABASE CLASS:** `DISPOSABLE_SYNTHETIC`
**TARGET DATABASE NAME:** `mas_radar_telemetry_verify` (yerel kapı koşuları) · `mas_radar_alerting_verify` (CI)
**REAL DB WRITE USED:** **NO** — `mas_radar_dev`'e tek bir yazma yok. Tek dokunuş: `.env.local`'deki
`mas_radar_app` kimlik bilgisi okundu ve **veritabanı adı harcanabilir hedefle DEĞİŞTİRİLEREK**
kullanıldı; gerçek veritabanına bağlantı bile açılmadı.

**ORIGINAL PLAN REFERENCE**
- section: Gap Closure Rehberi **§14 — AŞAMA 09 "Observability'yi gerçekten operasyonel yap"** (L1311–L1402)
- upstream: Aggressive Plan §15 Faz 12 — L1472–L1516
- acceptance criterion (birebir):
  - Sağlıklı durumda alarm yok.
  - Her yüksek risk sinyal kontrollü enjekte edildiğinde alarm görülüyor.
  - Alarm delivery başarısızlığı ayrıca görünür.
  - Alert çıktısında secret yok.

**CURRENT STATUS:** **VERIFIED PASS** (yerel, tam kimlikli koşu) · CI'da aynı kapı koşar; CI'da
`mas_radar_app` kimliği çalışmazsa "sağlıklı durumda alarm yok" kontrolü **ATLANIR ve atlandığı
raporlanır** (sessizce geçmiş sayılmaz).

---

## CHANGES

| Dosya | Ne |
|---|---|
| `src/lib/ops/alert-delivery.ts` | **YENİ.** Teslimat katmanı: JSONL kalıcı alert log (birincil), `transportFor()` üzerinden Telegram/e-posta (isteğe bağlı), iki katmanlı sır maskeleme, teslimat sonucunun kendisinin log'a yazılması. `process.env`'e dokunmaz, ağa çıkmaz (Faz 15 sınır kapısı gereği). |
| `src/lib/ops/alert-delivery.test.ts` | **YENİ.** 26 birim testi — maskeleme/tespit çifti, kanal ayrıştırma, heartbeat, düşen kanal, yazılamayan log, sır sızmama, append davranışı. |
| `scripts/ops/telemetry-snapshot.ts` | Teslimat + `--json` yapısal çıktı + genişletilmiş sinyal seti + `NOT_OBTAINABLE` listesi + çıkış kodu 2. **stdout satır biçimi DEĞİŞMEDİ.** |
| `scripts/ops/telemetry-alerting-verify.ts` | **YENİ.** 33 kontrollük kabul kapısı (aşağıda). |
| `scripts/ops/telemetry-watch.ts` | **YENİ.** Zamanlanmış işin çalıştırdığı şey: dört §14 kontrolü + `logs/telemetry-runs.jsonl` koşu kaydı + fail-closed çıkış kodları. |
| `scripts/ops/mas-telemetry-watch.cmd` | **YENİ.** Task Scheduler sarmalayıcısı (`mas-daily-backup.cmd` deseni). |
| `scripts/ops/schedule-windows.ts` | `--job backup\|telemetry` ile parametrelendi. **Varsayılan `backup` KALDI** (Aşama 07 kanıtı ve `release:stage07-backup-gate` bayraksız çağırıyor). Eylem artık pozisyonel okunuyor. |
| `scripts/ops/telemetry-verify.ts` | Alert log'u tek kullanımlık yola yönlendirildi (depoyu kirletmesin). Assertion'ları değişmedi. |
| `src/app/version/route.ts` | `uptimeSeconds` eklendi (§14 RUNTIME "uptime"). Sır değil, finansal veri değil. |
| `.github/workflows/ci.yml` | `database-migration` job'una "Observability alert delivery + schedule (AŞAMA 09)" adımı. |
| `.gitignore` | `/logs/` — operasyonel veri depoya girmez. |
| `package.json` | `ops:telemetry:alerting:verify`, `ops:telemetry:watch`, `ops:telemetry:schedule`. |
| `docs/ops/telemetry-alerting.md` | **YENİ.** Operatör runbook'u: kanallar, log biçimi, çıkış kodları, zamanlama, sır politikası. |

---

## SIGNAL COVERAGE AUDIT — rehber §14 listesi

**Toplam sinyal: 21** (öncesi 17). Uyaran (fail-closed) sinyal sayısı **6**, rehber §14'ün
"Alert delivery" listesiyle birebir aynı.

### RUNTIME

| §14 sinyali | Kapsandı? | Nasıl / neden değil |
|---|---|---|
| uptime | **KISMEN — evet** | `db_uptime` (`pg_postmaster_start_time()`, gerçek) + `app_uptime_seconds` (`/version` → `uptimeSeconds`, yeni eklendi). App tarafı **yalnız `MAS_APP_BASE_URL` verildiğinde** ölçülür; verilmezse "(ölçülmedi)" yazar — sağlıklı SAYILMAZ. |
| restart count | **HAYIR** | Süreci yeniden başlatan bir süpervizör yok; `next start` elle/Task Scheduler'dan koşuyor. Gerekecek: NSSM/Windows Service/pm2 gibi bir süpervizör ya da yeniden başlatmaları sayan sarmalayıcı + kalıcı sayaç dosyası. |
| health | **EVET (yeni)** | `probe_dependency` artık GERÇEKTEN `/health` çağırıyor (4 sn zaman aşımı); 2xx dışı → **ALERT (P1)**. Önceden yalnız `"/health"` metni basılıyordu — ölçüm yoktu. |
| ready | **EVET (yeni)** | `probe_liveness` → `/ready`, aynı şekilde. |
| commit SHA | EVET (önceden) | `commit_sha` (`APP_COMMIT_SHA`; canlıda `/version`). |

### DB

| §14 sinyali | Kapsandı? | Nasıl / neden değil |
|---|---|---|
| connections | EVET (önceden) | `db_connections` — `pg_stat_activity`. |
| slow queries | **KISMEN** | `db_longest_active_query_s` — O ANDA koşan en uzun sorgu, gerçek ve nokta-zamanlı. **GEÇMİŞ yavaş sorgu şekilleri ÖLÇÜLEMEZ:** `src/lib/perf/slow-query.ts` süreç-içi halka tamponu ve bir CLI süreci sunucunun belleğini okuyamaz; `pg_stat_statements` bu kümede kurulu değil. Gerekecek: `shared_preload_libraries` ile `pg_stat_statements`, ya da tamponu veren kimliği doğrulanmış bir uç. |
| failed transactions | EVET (önceden) | `db_failed_transactions` — `pg_stat_database.xact_rollback`. |
| lock waits | EVET (önceden) | `db_lock_waits` — `pg_locks where not granted`. |
| DB size | EVET (önceden) | `db_size`. |
| backup age | EVET (önceden) | `backup_age_hours` — **ALERT (P1)**, eşik 36 saat. |

### APP

| §14 sinyali | Kapsandı? | Nasıl / neden değil |
|---|---|---|
| 5xx | **HAYIR (uygulama geneli)** | `src/lib/api-response.ts` 5xx'i `log.error("unhandled_route_error")` ile **stderr'e** yazıyor; dağıtım stderr'i bir dosyaya yönlendirmiyor, sayacak toplayıcı yok. `probe_dependency` yalnız probe uçlarındaki 5xx'i görür. Gerekecek: stderr'i dosyaya yönlendiren sarmalayıcı + satır sayan okuyucu. |
| pageerror | **HAYIR** | Tarayıcı tarafı sinyal; client-side hata toplayıcı yok (yalnız Playwright koşarken yakalanıyor). Gerekecek: `/api/client-error` benzeri uç + tablo — yeni bir egress/veri yüzeyi, Faz 15 sınır kapısı gereği ayrı inceleme ister. |
| background failures | **EVET (yeni)** | `jobs_failed_24h` (`background_jobs` `failed`/`dead_letter`, 24 saat) + mevcut `jobs_stuck` (**ALERT P1**) + `jobs_dead_lettered`. |
| failed import | **EVET (yeni)** | `import_failures_24h` — yalnız `excel_import`/`bank_statement_import` tipleri. |
| reconciliation mismatch | EVET (önceden) | `reconciliation_mismatch` — **ALERT (P0)**. |
| stale source | EVET (önceden) | `latest_import_age_days` — **ALERT (P2)**, eşik 45 gün. |
| auth failures | **EVET (yeni, DEFEKT DÜZELTİLDİ)** | `auth_failed_logins` (`sum(users.failed_login_count)`) + `auth_locked_accounts` (`locked_until > now()`). |
| rate-limit failures | **HAYIR** | `src/lib/rate-limit.ts` bilerek süreç-içi (`globalThis` Map); tek örnekli dağıtımda paylaşılan sayaç okuyucusu olmayan altyapı olurdu. CLI süreci sunucunun belleğini göremez. Bugünkü tek kalıcı iz `log.warn("login_rate_limited")` — o da yönlendirilmemiş stderr'de. |

### Bulunan gerçek defekt — `auth_failures_24h` YAPISAL OLARAK ÖLÜ bir metrikti

Eski sorgu: `select count(*) from audit_logs where action ilike '%login%fail%'`.
Ölçüldü: `src/app/login/actions.ts` başarısız girişte `audit_logs`'a **hiçbir satır yazmıyor** —
ve bu bilinçli (kullanıcı adını loglamak, yanlış kutuya yazılmış parolayı loglamak demektir).
Yani sorgu her koşuda **0** döndürüyordu; "auth failures kapsanıyor" iddiası yanlıştı.
Gerçek ve kalıcı kaynak `public.users`: `failed_login_count` (başarılı girişte sıfırlanır) ve
`locked_until` (0031'deki 5 deneme / 15 dakika kilidi). Sinyal o kaynağa taşındı.

---

## ALERT DELIVERY

- **channels wired:** `log` (birincil, her zaman açık, kapatılamaz) · `telegram` ve `email`
  (`MAS_ALERT_CHANNELS` ile açılır, mevcut `src/lib/reminders/transport.ts` seam'i kullanılır —
  yeni HTTP kodu YAZILMADI).
- **persistent log path:** `logs/alerts.jsonl` (varsayılan; `MAS_ALERT_LOG` ile değiştirilebilir).
  `/logs/` **gitignore'da** — içerik operasyonel veridir.
- **delivery-failure visible?** **EVET, üç ayrı yoldan kanıtlandı** (aşağıdaki S7/S8/S9/S10):
  her kanal denemesinin sonucu log'a `kind:"delivery"` satırı olarak yazılır **ve** çıkış kodu
  ayrı olur (**2**, "uyarı var"ın 1'inden ayrışır).
- **secret leak check:** üç tarama — (a) tam DSN hiçbir çıktıda yok, (b) parolalı DSN / `Bearer` /
  `token=…` şekilleri yok, (c) app rolünün 18 karakterlik parolası yok. Tarayıcının kör olmadığı
  pozitif kontrolle kanıtlandı. `pnpm boundary:verify` **8/8 PASS**.

**Owner parolası literal olarak taranmaz ve bu ölçülmüş bir karardır:** yerel kümede owner
parolası düpedüz `postgres` — rol adının, veritabanı adının ve `runtime_user postgres` satırının
kendisiyle aynı dizge. Literal taransaydı kapı her koşuda kırmızı yanardı ve yakaladığı şey bir
sızıntı değil bir kelime olurdu (ilk koşuda tam olarak bu oldu). DSN ve şekil taramaları o
parolayı **taşıyan her biçimi** yakalıyor.

---

## SCHEDULE

- **implemented?** EVET — `scripts/ops/telemetry-watch.ts` + `scripts/ops/mas-telemetry-watch.cmd`,
  `schedule-windows.ts --job telemetry` ile kurulur. Periyot: **07:00'den itibaren 6 saatte bir**.
- **kapsanan dört §14 kontrolü:** telemetry snapshot · backup-age check · stale-data check ·
  queue check — hepsi tek koşuda, tek eşik tanımından (ikinci bir sorgu kopyası yazılmadı).
- **dry-run result:** GERÇEK koşu yapıldı (harcanabilir DB'ye karşı):

```text
── ZAMANLANMIŞ KONTROLLER (rehber §14) ────────────────────────────────
  ALERT                telemetry snapshot   1 uyarı
  OK                   backup-age check     0.6
  ALERT                stale-data check     İÇE AKTARIM YOK
  OK                   queue check          0
TELEMETRY WATCH: 1 UYARI teslim edildi.     → exit 1
```

  Koşu kaydı `logs/telemetry-runs.jsonl`'e eklendi; alarm `logs/alerts.jsonl`'e teslim edildi.
- **registered?** **NOT REGISTERED.** `schtasks /Query` exit 1; what-if üç kez koşuldu ve
  sonrasında hâlâ kayıtlı değil. Zamanlanmış görev kalıcı ve dışa dönük bir sistem
  değişikliğidir — kaydı operatör açıkça ister (Aşama 07 ile aynı politika).

Kaydedilecek komut (birebir üretildi, çalıştırılmadı):

```text
schtasks /Create /TN MAS-Nakit-Radar-Telemetri-Gozetim
  /TR "…\scripts\ops\mas-telemetry-watch.cmd" /SC HOURLY /MO 6 /ST 07:00 /RL LIMITED /F
```

---

## COMMANDS ACTUALLY RUN / EXIT CODES

| Komut | Veri sınıfı | Sonuç | Exit |
|---|---|---|---|
| `pnpm typecheck` | NONE | temiz | **0** |
| `pnpm lint` | NONE | 0 hata, 1 önceden var olan uyarı | **0** |
| `pnpm boundary:verify` | NONE | **8/8** | **0** |
| `pnpm test` | NONE | **1251/1251** (öncesi 1225 + 26 yeni) | **0** |
| `pnpm exec vitest run tests/financial` | NONE | **96/96** | **0** |
| `pnpm exec vitest run src/lib/ops/alert-delivery.test.ts` | NONE | **26/26** | **0** |
| `MIGRATION_DATABASE_URL=…mas_radar_telemetry_verify pnpm ops:telemetry:verify` | DISPOSABLE_SYNTHETIC | **14/14** (regresyon: stdout sözleşmesi bozulmadı) | **0** |
| `MIGRATION_DATABASE_URL=…mas_radar_telemetry_verify pnpm ops:telemetry:alerting:verify` | DISPOSABLE_SYNTHETIC | **33/33**, 0 atlanan | **0** |
| aynı kapı, app kimliği kasten bozuk (CI degrade simülasyonu) | DISPOSABLE_SYNTHETIC | **30/30**, **3 ATLANDI** (raporlandı) | **0** |
| `pnpm ops:telemetry --json …` (harcanabilir hedef) | DISPOSABLE_SYNTHETIC | 3 uyarı, teslimat OK | **1** |
| `pnpm ops:telemetry:watch` (harcanabilir hedef) | DISPOSABLE_SYNTHETIC | 1 uyarı, teslim edildi | **1** |
| `pnpm ops:telemetry:schedule status` | NONE | `SCHEDULED TASK = NOT REGISTERED` | 0 |
| `pnpm ops:telemetry:schedule install` (what-if) | NONE | komut üretildi, **kayıt yok** | 0 |
| `pnpm ops:backup:schedule status` / `install` (regresyon) | NONE | Aşama 07 davranışı değişmedi | 0 |

## ASSERTION COUNTS

| Katman | Sayı |
|---|---|
| Birim — `src/lib/ops/alert-delivery.test.ts` | **26** |
| Birim — `src/lib/ops/telemetry-alerts.test.ts` (mevcut) | 18 |
| Entegrasyon — `ops:telemetry:verify` (mevcut) | **14** |
| Entegrasyon — `ops:telemetry:alerting:verify` (yeni) | **33** |
| **AŞAMA 09 toplam yeni** | **59** |

---

## EXPECTED vs ACTUAL — rehber §14 kabul kriteri, madde madde

| # | EXPECTED (rehber §14) | ACTUAL | Sonuç |
|---|---|---|---|
| 1 | Sağlıklı durumda alarm yok | Taze dump + taze içe aktarım + temiz kuyruk + head ledger + `mas_radar_app` runtime kimliği → `alertCount=0`, `TELEMETRY: ALL CLEAR`, exit **0**, alert log'da **0** ALERT satırı (yalnız heartbeat + delivery) | **PASS** |
| 2 | Her yüksek risk sinyal enjekte edilince alarm görülüyor | **6/6** — `backup_age_hours` (P1) · `jobs_stuck` (P1) · `latest_import_age_days` (P2) · `reconciliation_mismatch` (P0) · `runtime_user` (P0) · `schema_ledger` (P0). Her biri için: stdout ALERT **+** kalıcı log'da doğru severity'li satır **+** `delivery ok=true` **+** exit 1 | **PASS** |
| 2b | (§30.1 anti-vacuum) enjeksiyon geri alınınca temizleniyor | **6/6 temizlendi** — altısı da ayrı bir koşuda `ok`'a döndü | **PASS** |
| 3 | Alarm delivery başarısızlığı ayrıca görünür | 4 farklı arıza: yerel log yazılamaz → exit **2** + `TELEMETRY DELIVERY: FAILED`; `MAS_ALERT_CHANNELS` yazım hatası → exit **2**; yapılandırılmamış Telegram → exit **2** + log'da `ok:false`; `mockTransport` reddi → `allDelivered=false` + log'da `ok:false`. Uyarı-varken (1) ile ayrışıyor | **PASS** |
| 4 | Alert çıktısında secret yok | 54.923 karakterlik birleşik transcript (tüm stdout + tüm alert log'ları): 0 DSN eşleşmesi, 0 şekil eşleşmesi, app parolası yok. Tarayıcı pozitif kontrolle kör olmadığı kanıtlandı | **PASS** |

### `reconciliation_mismatch` — tautoloji YOK

Sapma uydurulmadı: `treasury_cashflow_reconciliation` bir GÖRÜNÜM, bu yüzden zincirin tamamı
kuruldu (`cash_accounts` → `bank_accounts` → `bank_transactions` ↔ `cashflow_months`) ve
değerler bilinçli olarak çelişkili verildi (banka hareketi 12.345,67 ↔ nakit akış kapanışı 1,00
→ `difference = 12.344,67`). Görünüm bunu kendisi hesapladı; script bir sayı yazmadı.

---

## PASS

- Rehber §14'ün dört kabul kriteri de **ölçülerek** karşılandı (yukarıdaki tablo).
- Altı fail-closed sinyalin **hepsi** iki yönlü (ateşle **ve** temizle) kanıtlandı.
- Teslimat başarısızlığı dört ayrı arıza tipinde görünür ve **ayrı çıkış kodu** üretiyor.
- `runtime_user` sinyalinin **TEMİZ yönü ilk kez kanıtlandı** — gerçek `mas_radar_app`
  bağlantısıyla (mevcut `telemetry-verify.ts` bunu yapamıyordu ve dürüstçe böyle yazıyordu).
- Aşama 07 zamanlama davranışı **regresyona uğramadı** (bayraksız çağrı hâlâ backup işi).
- Yapısal (`--json`) çıktı üretiliyor ve **ölçülemeyen sinyalleri birinci sınıf alan olarak**
  taşıyor (`notObtainable`).

## FAIL

Yok.

## NOT VERIFIED

| Konu | Neden | Ne gerekir |
|---|---|---|
| `restart_count`, `pageerror`, uygulama geneli `5xx`, rate-limit reddi, **geçmiş** yavaş sorgu | Bu mimaride toplayıcısı **yok** — uydurulmadı, `NOT_OBTAINABLE` listesinde adı/sebebi/gereği yazılı ve JSON çıktısında da var | Yukarıdaki "SIGNAL COVERAGE AUDIT" tablosundaki "Gerekecek" sütunu |
| `probe_liveness` / `probe_dependency` canlı sunucuya karşı | Port 3000'deki canlı sunucu bu turda **kasten** rahatsız edilmedi; probe'lar yalnız `MAS_APP_BASE_URL` verildiğinde koşar. Kod yolu kapıda değil, elle doğrulanmadı | Cutover penceresinde `MAS_APP_BASE_URL=http://127.0.0.1:3000 pnpm ops:telemetry` |
| `/version → uptimeSeconds` canlıda | Alan bu commit'te eklendi; port 3000'de koşan derleme ondan ÖNCEKİ. Yeniden başlatılmadı | Sunucu bir sonraki yeniden başlatmada alanı yayınlar |
| Telegram/e-posta kanalının **başarılı** gönderimi | Ortamda kimlik bilgisi yok ve dışa ağ yok; gerçek bir uca istek atmak bu turun kapsamı değil (ve yasaklandı) | Kimlik bilgisi tanımlandığında `MAS_ALERT_CHANNELS=log,telegram` ile tek koşu |
| Zamanlanmış görevin **gerçekten** tetiklenmesi | Görev **kaydedilmedi** (operatör kararı) | `install --job telemetry --apply`, sonra `run-once --apply` |
| CI'da "sağlıklı durumda alarm yok" | CI adımı app rolüne CI parolasını veriyor; kimlik çalışmazsa kontrol **ATLANIR** ve atlandığı yazılır. Bu commit'te CI koşusu **henüz gözlenmedi** | Bir sonraki CI koşusunun `database-migration` job çıktısı |

## P0 / P1 / P2

- **P0:** yok.
- **P1:** yok.
- **P2 (borç, bu aşamanın kapsamı dışında):**
  1. Uygulama geneli `5xx` ve rate-limit reddi sayacı — stderr'i dosyaya yönlendiren bir
     sarmalayıcı gerekiyor. Aşama 19 (real-use telemetry) doğal yeri.
  2. `pageerror` toplayıcısı — yeni bir egress yüzeyi, Faz 15 sınır incelemesi ister.
  3. `pg_stat_statements` kurulmadıkça geçmiş yavaş sorgu görünmüyor.

---

## EVIDENCE FILES

- `docs/release-evidence/final-production-readiness/07-observability.md` (bu dosya)
- `docs/ops/telemetry-alerting.md` — operatör runbook'u
- `logs/alerts.jsonl`, `logs/telemetry-runs.jsonl`, `logs/telemetry-latest.json` — **gitignore'da**
  (operasyonel veri; depoya girmez). Örnek satırlar bu dosyada alıntılı.
- Kapı kaynakları: `scripts/ops/telemetry-alerting-verify.ts`, `scripts/ops/telemetry-watch.ts`,
  `src/lib/ops/alert-delivery.ts`, `src/lib/ops/alert-delivery.test.ts`

Örnek alert log satırları (gerçek koşudan, olduğu gibi):

```json
{"ts":"2026-08-25T15:37:29.196Z","runId":"tel-2026-08-25T15-37-28-783Z","kind":"alert","signal":"latest_import_age_days","section":"APP","severity":"P2","value":"İÇE AKTARIM YOK","threshold":"eşik 45 gün","message":"latest_import_age_days = İÇE AKTARIM YOK (eşik 45 gün)"}
{"ts":"2026-08-25T15:37:29.196Z","runId":"tel-2026-08-25T15-37-28-783Z","kind":"delivery","channel":"log","ok":true,"message":"kanal log: iletildi"}
```

## NEXT GATE

**AŞAMA 10 — Performance gap closure** (rehber §15): HTTP route SLO, DB query count,
interactive readiness, write/import SLO.

## FINAL

**PASS** — rehber §14'ün dört kabul kriteri de harcanabilir hedefe karşı, gerçek enjeksiyonla ve
iki yönlü olarak kanıtlandı. Kapsam iddiası abartılmadı: ölçülemeyen beş sinyal adıyla,
sebebiyle ve gereğiyle kayıtlı ve JSON çıktısının birinci sınıf alanı.
