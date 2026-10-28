# MAS Nakit Radar — Kullanım Rehberi

> **WAVE 0 (2026-10-28) — DOCKER KALDIRILDI.** Bu rehberdeki `docker …`, `docker compose …` ve
> `scripts/deploy/*.sh` komutları ARTIK GEÇERSİZ; rehber yeniden yazılacak. Veritabanı (başlat,
> durdur, durum, sorun giderme): [`postgres-service.md`](postgres-service.md).

**Kime:** MAS'ta sistemi günlük işleten kişi. Geliştirici olmanız gerekmiyor.
**Ne değil:** Bu belge kod açıklamaz. Her adım, kopyalayıp yapıştırabileceğiniz komutlardır.
**Ayrıntı gerekirse:** her bölüm ilgili runbook'a bağlanır (`docs/ops/*.md`) — orada
`FAILURE SIGNALS`, `STOP CONDITION`, `ROLLBACK` bölümleri vardır.

> **Tek altın kural:** Bir komutun çıktısı beklediğinizden farklıysa **durun**, tahmin etmeyin,
> ilgili runbook'un `FAILURE SIGNALS` bölümüne bakın. Gerçek finansal verinin üzerinde
> "deneyerek" düzeltme yapılmaz.

---

## 0. Komutları nerede çalıştırırım?

Windows'ta **PowerShell** açın, proje klasörüne gidin:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
```

Bütün `pnpm …` ve `docker …` komutları bu klasörden çalışır.

**Önemli tuzak:** Aynı PowerShell penceresinde daha önce `$env:DATABASE_URL` gibi bir değişken
ayarlandıysa, `.env.local` dosyanız doğru olsa bile o eski değer kazanır ve yanlış veritabanına
bağlanırsınız. Bu **gerçekten oldu** (25 Ağustos). Emin değilseniz:

```powershell
pnpm db:env:source
```

`ENV SOURCE: gölgeleme yok.` görmelisiniz. Görmüyorsanız **yeni bir PowerShell penceresi açın**.

---

## 1. İlk kurulum (tek seferlik)

Runbook: [`start.md`](start.md) · [`docker-restart.md`](docker-restart.md)

| # | Adım | Komut / Kontrol | Beklenen |
|---|---|---|---|
| 1 | Docker Desktop kurulu ve açık | Sistem tepsisinde balina simgesi | "Docker Desktop is running" |
| 2 | Veritabanı konteyneri ayakta | `docker ps --filter "name=mas-radar-pg"` | `mas-radar-pg … Up` |
| 3 | Bağlantı dosyası var | `Test-Path .env.local` | `True` |
| 4 | Ortam doğru | `pnpm exec tsx scripts/deploy/check-env.ts` | hata yok |
| 5 | Uygulamayı derle | `pnpm build` | `Compiled successfully` |
| 6 | Uygulamayı başlat | `pnpm start` | `Ready on http://localhost:3000` |
| 7 | Sağlık kontrolü | tarayıcıda `http://127.0.0.1:3000/health` | `{"status":"ok","db":"up"}` |
| 8 | Hangi sürüm çalışıyor | `http://127.0.0.1:3000/version` | `commit` **40 karakterlik bir kod** — `"unknown"` GÖRÜRSENİZ yanlış derleme, [`start.md`](start.md) |

`pnpm start` penceresini **kapatmayın** — uygulama o pencerede yaşar.

---

## 2. Günlük kullanım

| Yapmak istediğim | Nereye giderim |
|---|---|
| Bugün / yarın / 7 gün ne çıkacak | `/overview` (ana sayfa) |
| Ödeme takvimi, gecikenler | `/payments` · `/payments/calendar` |
| Aylık nakit akışı, ilk eksi ay | `/cashflow` |
| Çekler, krediler, taksitler | `/finance` · `/finance/checks` · `/finance/loans` |
| Eksik/şüpheli veri | `/data/quality` |
| Yeni Excel yükleme | `/data/imports/v2` — önce **önizleme**, sonra onay. Önizlemede "İNCELEME" sayısı sıfır değilse import etmeden önce bakın. |
| Sistem sağlığı | `/system` |

**Sayılar hakkında bilmeniz gerekenler:**

- **Boş** değer "bilinmiyor" demektir, sıfır değil. Ekran `n kalem eksik` diye yazar; o kalemler toplama girmez.
- **0 TL** gerçek sıfırdır.
- Çek/nakit akışında **eksi** tutar çıkış yönüdür, hata değil.
- TL dışı bir kayıt görürseniz (USD/EUR) o kayıt **TL toplamlarına girmez** ve incelemeye düşer. Sistem sessizce kur çevirmez — bu bilinçli bir kuraldır.

---

## 3. Yedek kontrolü (her gün 1 dakika)

Runbook: [`backup.md`](backup.md) · [`backup-schedule.md`](backup-schedule.md)

Yedek her gece **03:00**'te otomatik alınır. Sabah şunu kontrol edin:

```powershell
Get-ChildItem backups\daily-*.dump | Sort-Object LastWriteTime -Descending | Select-Object -First 1 Name, LastWriteTime
```

**Beklenen:** bugünün veya dünün tarihi. **36 saatten eski** bir yedek görürseniz alarm durumudur —
[`backup.md`](backup.md) `FAILURE SIGNALS`.

Yedeğin sağlam olduğunu doğrulamak (dosyanın var olması yetmez):

```powershell
pnpm ops:telemetry
```

`backup_age_hours` satırı `ok` olmalı. `ALERT` görürseniz [`telemetry-alerting.md`](telemetry-alerting.md).

**Harici disk:** Yedeğin tek kopyası bilgisayarda olmamalı. USB diski (D:) takılıyken:

```powershell
pnpm ops:backup:offdevice
```

`OFF_DEVICE PHYSICAL TARGET = OK` görmelisiniz. Disk takılı değilse komut **durur ve söyler** —
sessizce "tamam" demez, bu bilinçlidir.

---

## 4. Sorun anında

Runbook: [`incident.md`](incident.md) · [`incident-recovery-notes.md`](incident-recovery-notes.md)

**Önce kanıt toplayın, sonra müdahale edin.** Sıra:

```powershell
# 1. Uygulama ayakta mı?
curl.exe -s http://127.0.0.1:3000/health
curl.exe -s http://127.0.0.1:3000/version

# 2. Veritabanı ayakta mı?
docker ps --filter "name=mas-radar-pg"
docker exec mas-radar-pg pg_isready -U postgres

# 3. Sistem ne diyor?
pnpm ops:telemetry

# 4. Alarm günlüğünün son satırları
Get-Content logs\alerts.jsonl -Tail 5
```

Bu dört çıktıyı **kaydedin** (kopyalayıp bir dosyaya yapıştırın) — sorunu bildirirken bunlar gerekecek.

| Belirti | Muhtemel sebep | Runbook |
|---|---|---|
| `/health` → `db: "down"` | Veritabanı konteyneri kapalı | [`docker-restart.md`](docker-restart.md) |
| `/version` → `commit: "unknown"` | Yanlış/eski derleme çalışıyor | [`start.md`](start.md) — yeniden derle |
| Sayfa açılmıyor, port 3000 boş | Uygulama düşmüş | [`start.md`](start.md) |
| `git status` 58 migration siliniyor gösteriyor | Yarıda kesilmiş doğrulama — **`git checkout` YAPMAYIN** | [`failed-migration.md`](failed-migration.md) |
| Docker "Reset to factory defaults" öneriyor | **BASMAYIN** — gerçek veritabanını siler | [`docker-restart.md`](docker-restart.md) |
| Disk doldu | | [`db-full.md`](db-full.md) |

---

## 5. Kontrollü kapatma

Runbook: [`stop.md`](stop.md)

Bilgisayarı kapatmadan veya güncelleme yapmadan önce **bu sırayla**:

```powershell
# 1. Uygulamayı durdur (pnpm start penceresinde Ctrl+C, ya da:)
bash scripts/deploy/local-stop.sh

# 2. Veritabanına bağlı kimse kalmadı mı?
docker exec mas-radar-pg psql -U postgres -t -A -c "select count(*) from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
# beklenen: 0

# 3. Veritabanını durdur
docker compose stop
```

**Yanlış sıra** (önce Docker'ı kapatmak) veritabanını yarım işlemle bırakabilir. PostgreSQL bunu
genelde toparlar ama "genelde" finansal veri için yeterli değildir.

---

## 6. Yedekten geri dönme (restore)

Runbook: [`restore.md`](restore.md)

**Asla doğrudan gerçek veritabanının üzerine geri yüklemeyin.** Önce ayrı bir hedefe yükleyip
doğrulayın:

```powershell
# 1. Hangi yedek? (en son sağlam olan)
Get-ChildItem backups\daily-*.dump | Sort-Object LastWriteTime -Descending | Select-Object -First 3

# 2. AYRI bir veritabanına geri yükle (adında "restore" geçmeli — bu bir güvenlik kuralıdır)
bash scripts/deploy/restore-db.sh backups\<dosya-adi>.dump mas_radar_restore_bugun

# 3. Sayılar tutuyor mu? (geri yüklenen ile gerçek karşılaştırılır)
docker exec mas-radar-pg psql -U postgres -d mas_radar_restore_bugun -t -A -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
```

Sayılar makul görünüyorsa ve gerçek veritabanının yerine koymanız gerekiyorsa **durun** — bu
adım [`restore.md`](restore.md) `ROLLBACK` bölümünü ve bir bakım penceresini gerektirir.
Tek başınıza yapmayın; runbook'taki "ikinci göz" kuralı buradadır.

Tam prova (yedek → restore → uygulama açılır mı → ekranlar doğru mu) ayda bir:

```powershell
pnpm release:restore-drill
```

---

## 7. Kullanıcı açma / rol değiştirme / parola

| İş | Runbook |
|---|---|
| Yeni kullanıcı | [`user-creation.md`](user-creation.md) |
| Rol değiştirme (izleyici → onaylayıcı vb.) | [`role-change.md`](role-change.md) |
| Parola yenileme | [`password-rotation.md`](password-rotation.md) — **dikkat:** veritabanı uygulama parolası cluster geneline etki eder, runbook'suz değiştirmeyin |

---

## Kısa özet — her gün

```text
Sabah  : yedek tarihi bugün/dün mü?  →  pnpm ops:telemetry  →  ALERT yoksa devam
Gün içi: /overview → /payments → /cashflow
Akşam  : pnpm start penceresi açık kalsın (yedek 03:00'te otomatik)
Haftada: USB tak → pnpm ops:backup:offdevice
Ayda   : pnpm release:restore-drill
```
