# 01 — Native PostgreSQL kurulumu ve kanonik verinin geri yüklenmesi

```text
commit        : (kod değişikliği yok — operasyon kanıtı; wave0/stabilize dalı)
date          : 2026-10-28
DB class      : REAL (kanonik)
DB target     : 127.0.0.1:5432 / mas_radar_dev (native PostgreSQL 16.14, C:\MAS\pgdata16)
final status  : PASS — 87/87 tablo bit düzeyinde aynı, defter 94/0094
```

## 1. Neden

- Docker Desktop kaldırılmıştı (exe yok, `docker-desktop` WSL dağıtımı durmuş).
- `.env.local` duraklatılmış bir Supabase projesini gösteriyordu.
- Günlük yedek 2026-09-16'dan beri her gece başarısızdı.
- Sahibin kararı 1: kanonik veritabanı yerel native PostgreSQL olacak.

## 2. İkili dosyalar

| Alan | Değer |
|---|---|
| Paket | `postgresql-16.14-1-windows-x64-binaries.zip` (EDB) |
| SHA-256 | `98af1417ba6a8dc30543e560e5407833a3b9e7cc7ed20e73b2006f3aa2f04663` — 2026-09-13 kaydıyla (BLOCKER-docker-desktop) **birebir** |
| Hedef | `C:\MAS\pgsql16` — yalnız `bin`, `lib`, `share` (1.635 dosya, 120,5 MB; pgAdmin alınmadı) |

## 3. Küme

| Ayar | Değer | Gerekçe |
|---|---|---|
| initdb | `-U postgres -A scram-sha-256 -E UTF8 --locale-provider=icu --icu-locale=en-US --locale=en-US --data-checksums` | Kaynak `en_US.utf8` (libc); Windows'ta ICU en-US en yakın ve taşınabilir eşdeğer. tr-TR seçilmedi: `lower('I')='ı'` giriş eşleştirmesini bozabilir. |
| `listen_addresses` | `127.0.0.1,::1` | Yalnız loopback. |
| `timezone` | `Etc/UTC` | Docker kümesiyle aynı davranış (uygulama `at time zone` ile açık dönüşüm yapıyor). |
| `max_connections` | 50 | Havuz 10 + betikler. |
| Süper kullanıcı parolası | 31 karakter rastgele | `C:\MAS\secrets\pg-superuser.txt` (miras kaldırıldı; yalnız sahip, SYSTEM, Administrators). Hiçbir çıktıya yazılmadı. |
| Başlatma | Kullanıcı düzeyi zamanlanmış görev `MAS-PostgreSQL16-Oturum-Baslat` (oturum açılışında `pg_ctl start`) | Windows servisi yönetici yetkisi ister. Sahip `install-postgres-service.ps1`'i çalıştırınca servis `MAS-PostgreSQL16` devralır, görev kaldırılır. |

## 4. Kaynak seçimi

Dört aday döküm karşılaştırıldı. Her tablo için satır sayısı ve **sıraya bağlı olmayan** içerik özeti (satırlar sıralanıp SHA-256) hesaplandı. Hiçbir satır içeriği yazdırılmadı.

| Döküm | Küme | Defter | Not |
|---|---|---|---|
| `daily-2026-09-05…` | 7659286466006216743 (gerçek) | 87/0087 | — |
| `daily-2026-09-15…` | 7659286466006216743 (gerçek) | 87/0087 | Makbuz SHA-256 `edf70833…dbceac` **eşleşti** |
| `migrate-…-2026-10-15T20-09…` | 7696975748673884199 (2026-10-15 ~19:00Z'de yeniden kurulmuş, PG 16.15) | 87/0087 | — |
| `migrate-…-2026-10-16T02-06…` | aynı | 94/0094 | **seçildi** |

Bulgular:

- 5 Eylül = 15 Eylül, bütün tablolarda.
- **İş tabloları dört dökümde de aynı:**
  - ödemeler 19, çekler 7, krediler 1, kredi taksitleri 48
  - nakit akış satırı 1.968, nakit ayları 35
  - kaynak hücreleri 9.817, içe aktarma satırları 1.601
  - maliyet ve üretim tabloları
- **15 Eylül → 15 Ekim farkları yalnız sistemin ürettiği satırlar:**
  - `payment_instances` +17
  - `audit_logs` +1 — `generate_instances`, 2026-10-15 19:20:10Z
  - `sessions` +3
  - `users`: `admin` ve `atilla` parola özetleri değişmiş; `admin` için ayrıca hatalı giriş sayacı ve kilit alanları
- **15 Ekim → 16 Ekim:**
  - migration 0088–0094 uygulanmış
  - çekler ve kredilerde satır metni yeni kolonlar yüzünden değişmiş; sayılar aynı
  - `import_external_keys` boş olarak eklenmiş
  - `sessions` +2

Seçim gerekçesi: 16 Ekim dökümü, gerçek veriyi koruyan en güncel durum. Güncel parola özetleri ve uygulanmış migration'lar bunda var. 15 Eylül'e dönmek, sahibin 15 Ekim'de değiştirilen parolalarını geri alırdı.

Bilinen boşluk: 16 Ekim 02:06 ile 20 Ekim arasında yerel Docker'a yazılmış bir değişiklik varsa bu dökümde yoktur. Eski `docker_data.vhdx` (16,1 GB, son yazım 20 Ekim) silinmeden saklanıyor; gerekirse yönetici yetkisiyle bağlanıp okunabilir.

Seçilen döküm:

```text
backups/migrate-mas_radar_dev-2026-10-16T02-06-02-654Z.dump
sha256 09e14fecbff24903d2c9c06ec29007c58c35a24abfaccde9b9fed609febb5a35   1.439.246 bayt
pg_dump 16.15, TOC 1408 girdi, 87 tablo verisi
```

## 5. Roller

`pg_dump` küme düzeyindeki rolleri ve üyelikleri taşımaz. Bunlar `scripts/db/local-bootstrap.sql`, 0035 ve 0057 ile birebir aynı biçimde, idempotent olarak kuruldu.

| Kontrol | Sonuç |
|---|---|
| `mas_radar_app` | LOGIN; süper kullanıcı değil; BYPASSRLS yok. Parola `scripts/db/set-app-role-password.ts` ile `.env.local`'deki `MAS_RADAR_APP_DB_PASSWORD`'den atandı; doğrulama bağlantısı başarılı. |
| Üyelik `authenticated` | inherit=t, set=t |
| Beş katman rolü | Hepsinde inherit=f, set=t (0057 tasarımı) |
| RLS | 86 tablo, 322 politika |

## 6. Geri yükleme ve doğrulama

```text
pg_restore -w --single-transaction --exit-on-error -d mas_radar_dev <döküm>   → exit 0, stderr boş
pg_dump -Fc mas_radar_dev (gidiş-dönüş, 1406 KB)                             → exit 0
tablo bazında karşılaştırma (sayı + sıradan bağımsız SHA-256)                 → 0 / 87 fark
defter                                                                         → 94/0094 (iki tarafta da)
```

**Assertion sayısı:** 87 tablo × 2 (sayı, özet) + defter + 6 üyelik + rol öznitelikleri.
**Beklenen = gerçekleşen.** Hata yok.

## 7. Ortam notu

İşlem sırasında makinede boş RAM 0,07–0,2 GB'tı. PostgreSQL süreçleri diske sayfalandı ve geri yükleme bağlantısı yaklaşık 15 dakika bekledi. Bu bir veri sorunu değil, kapasite sorunu (bkz. sahibin donanım kararı 6).

## 8. Kesinti ve kurtarma (2026-10-29)

- **Ne oldu:** Küme 2026-10-29 ~04:54 UTC'de kapanma kaydı bırakmadan durdu. Son satırlar bellek uyarıları; aynı saatlerde işletim sisteminde `VirtualAlloc failed` görüldü.
- **Kurtarma:** Oturum görevi ile yeniden başlatıldı. Günlükteki sıra:
  - `database system was not properly shut down; automatic recovery in progress`
  - `redo 0/2D189A8 → 0/2D18A58`
  - `database system is ready`
- **Sonuç:** Sağlama toplamı hatası yok, veri kaybı yok.
- **Ders:** Hata durumunda kendini yeniden başlatan Windows servisi gerekli; kurulum sahipte (`docs/ops/postgres-service.md`).

## 9. Kod dalgası sonrası adımlar (2026-10-29, wave0/stabilize `0ae0231` üzerinde)

| Adım | Komut / yöntem | Sonuç |
|---|---|---|
| `.env.local` sabitleme | Değer yazdırmayan betik; `.env.local.bak-20261029-092503` yedeği | `DATABASE_URL` → `mas_radar_app@127.0.0.1:5432/mas_radar_dev`, `MIGRATION_DATABASE_URL` → `postgres@…/mas_radar_dev`, `POSTGRES_*`, `MAS_PG_BIN_DIR` eklendi, `SUPABASE_DB_URL` yorum satırı. Diğer anahtarlara dokunulmadı. |
| Yoklama | `pnpm db:ensure` | `PostgreSQL hazır (native, 127.0.0.1:5432).` |
| Şema kayması | 0001–0094 (değişmez etiketten) tek kullanımlık `mas_radar_drift_verify`'a kuruldu; iki `pg_dump --schema-only` karşılaştırıldı | 6.037 / 6.037 satır. Tek fark bir görünümde UNION dallarındaki `AS text` yazımı (16.15 ↔ 16.14 ifade biçimi). Politika, yetki ve rol kayması yok; Supabase betikleri kanonik DB'ye uygulanmamış. |
| Sahip salt-okunur kontrolleri | `begin transaction read only` | Aşağıdaki tablo. |
| İlk native günlük yedek | `pnpm ops:backup:daily` | `daily-2026-10-29T06-26-54-018Z.dump`; sha256 `20fc69f9…`; defter 94/0094; TOC 1408; `pg_dump` 16.14 = sunucu 16.14; kaynak `native:127.0.0.1:5432`; makbuz yazıldı. **Çıkış 3** (D: yok → tek kopya; beklenen dürüst sinyal). |
| Migration | `pnpm db:migrate` (sahip URL'si yalnız süreç ortamında) | Zorunlu ön yedek `migrate-mas_radar_dev-2026-10-29T06-27-46-500Z.dump`. 0095 ve 0096 uygulandı; defter 0096/96; politika 322 → 323. |
| Zamanlanmış görevler | `pnpm ops:backup:schedule install --apply`, `pnpm ops:telemetry:schedule install --apply` | Günlük yedek 03:00 (StartWhenAvailable, 2 sa sınır). Gözetim 07:00'den itibaren 6 saatte bir (yeni kayıt). `MAS_ALERT_CHANNELS=telegram`: alarmlar sahibin sohbetine de gider. |
| Telegram | `telegram-ops.ts info` | Webhook kayıtlı değil (polling, beklenen), bekleyen güncelleme 0. |

Salt-okunur kontroller:

| Kontrol | Sonuç |
|---|---|
| ERP örnek faturaları (`dedupe_hash like 'erp:%'`) / ERP denetim satırları | 0 / 0 |
| Mini-app tarzı yazma (viewer/approver aktörlü `mark_paid`/`mark_unpaid`/`mark_check_cleared`) | 0 |
| 15 Eylül'den beri denetim eylemleri | yalnız `generate_instances` |
| `sessions` politikaları | `sessions_app_runtime`, `sessions_deny_all`, `sessions_self_read` (beklenen) |
| Katman rolü üyeleri | yalnız `mas_radar_app` |
| Defter: boş sağlama toplamı / `supabase-runner` | 0/96 / 0 |
| Canlı oturum | 0 |
| P24B fixture satırları | 0 (temizlik daha önce yapılmış) |
| Açılışı bilinmeyen aktif kasa/banka hesabı (FIN-03) | **6 / 6** |
