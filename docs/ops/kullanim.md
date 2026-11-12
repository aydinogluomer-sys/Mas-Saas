# MAS Nakit Radar — Günlük Operatör Kullanım Rehberi

**Kime:** MAS'ta sistemi günlük işleten kişi / CFO iş istasyonu operatörü. Geliştirici olmanız gerekmiyor.
**Ne değil:** Bu belge kod açıklamaz. Her adım, doğrudan Windows PowerShell'e kopyalayıp yapıştırabileceğiniz komutlardır.
**Ayrıntı gerekirse:** her bölüm ilgili runbook'a bağlanır (`docs/ops/*.md`) — orada `FAILURE SIGNALS`, `STOP CONDITION`, `ROLLBACK` bölümleri vardır.

> **Tek altın kural:** Bir komutun çıktısı beklediğinizden farklıysa **durun**, tahmin etmeyin, ilgili runbook'un `FAILURE SIGNALS` bölümüne bakın. Gerçek finansal verinin üzerinde "deneyerek" düzeltme yapılmaz.

---

## 0. Komutları nerede çalıştırırım?

Windows'ta **PowerShell** açın, proje klasörüne gidin:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
```

Bütün `pnpm …` komutları bu klasörden çalışır.

**Önemli tuzak:** Aynı PowerShell penceresinde daha önce `$env:DATABASE_URL` gibi bir değişken ayarlandıysa, `.env.local` dosyanız doğru olsa bile o eski değer kazanır. Emin değilseniz:

```powershell
pnpm db:env:source
```

`ENV SOURCE: gölgeleme yok.` görmelisiniz. Görmüyorsanız **yeni bir PowerShell penceresi açın**.

---

## 1. İlk kurulum ve başlatma kontrolü

Runbook: [postgres-service.md](postgres-service.md) · [start.md](start.md)

| # | Adım | Komut / Kontrol | Beklenen |
|---|---|---|---|
| 1 | Yerel PostgreSQL 16 hizmeti ayakta | `pnpm db:ensure` | `PostgreSQL hazır (native, 127.0.0.1:5432).` |
| 2 | Bağlantı dosyası var | `Test-Path .env.local` | `True` (`MAS_LOCAL_PASSWORDLESS=0`) |
| 3 | Ortam doğru | `pnpm exec tsx scripts/deploy/check-env.ts` | hata yok |
| 4 | Şema kanonik sürümde (`0113`) | `pnpm db:migrate` | `Değişiklik yok — DB zaten güncel.` |
| 5 | Arka plan işçisi kayıtlı | `Get-ScheduledTask -TaskName "MAS-Background-Worker" -ErrorAction SilentlyContinue` | `Ready` (yoksa `pnpm ops:worker:schedule install --apply`) |
| 6 | Uygulamayı derle ve başlat | `pnpm build` ve `pnpm start` | `http://127.0.0.1:3000` |
| 7 | Sağlık kontrolü | `curl.exe -s http://127.0.0.1:3000/health` | `{"status":"ok","app":"up","db":"up",...}` |
| 8 | Sürüm kontrolü | `curl.exe -s http://127.0.0.1:3000/version` | `commit` 40 karakterlik SHA |

`pnpm start` penceresini **kapatmayın** — uygulama sunucusu o pencerede yaşar.

---

## 2. Günlük CFO iş istasyonu ekranları

| Yapmak istediğim | Nereye giderim |
|---|---|
| Sabah brifingi, gece kasa değişim atfı ($\Delta\text{Cash}$), bugün/7 gün ne çıkacak | `/overview` (ana sayfa) |
| Ödeme takvimi, ödeme çalıştırma paketleri (`pain.001` / EFT), onaylar | `/payments` · `/payments/runs` · `/payments/approvals` |
| Aylık nakit akışı ve **13 Haftalık Nakit Tahmini + Varyans Şelalesi** | `/cashflow` · `/cashflow/13-week` |
| Kasa/banka açılış bakiyeleri (`FIN-03` + `500.99`), çek/senet bordrosu, krediler, kovenant & DSCR | `/finance/treasury` · `/finance/checks` · `/finance/loans` · `/finance/facilities` |
| Çift taraflı TDHP Yönetim Defteri, EBITDA ve Mali Müşavir Yasal Mizan Köprüsü | `/finance/ledger` · `/data/trial-balance-bridge` |
| Paraşüt v4 salt-okunur entegrasyon ve banka ekstre (MT940 / `camt.053` / Excel) yükleme | `/data/integrations` · `/finance/bank` · `/data/imports/v2` |
| Veri kalitesi ve sistem sağlığı | `/data/quality` · `/system` |

**Sayılar hakkında bilmeniz gerekenler:**

- **Boş** değer "bilinmiyor" demektir, sıfır değil (`FIN-03`: açılış bakiyesi girilmemiş banka hesabı `0 TL` sayılmaz; `/finance/treasury` ekranından gerçek açılış bakiyesi ve tarihi girildiğinde otomatik `100/102 ↔ 500.99` açılış fişi oluşur).
- **0 TL** gerçek sıfırdır.
- TL dışı kayıtlar (`USD`, `EUR`, `GBP`) TL toplamlarına sessizce karıştırılmaz; kendi döviz kovalarında ve resmi TCMB kuru üzerinden ayrı izlenir.

---

## 3. Yedek ve arka plan işçisi kontrolü (her gün 1 dakika)

Runbook: [backup.md](backup.md) · [backup-schedule.md](backup-schedule.md)

Yedek her gece **03:00**'te otomatik alınır (`MAS-Nakit-Radar-Gunluk-Yedek`). Sabah şunu çalıştırın:

```powershell
pnpm backup:offdevice:verify
pnpm ops:telemetry
```

- `BACKUP_VERIFY_STATUS = PASS` (boyut `> 0`, yaş `<= 48 saat` ve `pg_restore --list` okunabilir) görmelisiniz.
- `TELEMETRY: ALL CLEAR` görmelisiniz. `ALERT` varsa [telemetry-alerting.md](telemetry-alerting.md) adımlarını izleyin.

**Harici disk:** Yedeğin tek kopyası bilgisayarda kalmamalıdır. Harici USB disk veya NAS bağlıyken:

```powershell
pnpm ops:backup:offdevice
pnpm backup:offdevice:verify -- --strict-offdevice
```

---

## 4. Sorun anında

Runbook: [incident.md](incident.md) · [incident-recovery-notes.md](incident-recovery-notes.md)

**Önce kanıt toplayın, sonra müdahale edin:**

```powershell
# 1. Uygulama ayakta mı?
curl.exe -s http://127.0.0.1:3000/health
curl.exe -s http://127.0.0.1:3000/version

# 2. Yerel PostgreSQL 16 ve zamanlanmış görevler ayakta mı?
Get-Service MAS-PostgreSQL16, postgresql-x64-16 -ErrorAction SilentlyContinue
& C:\MAS\pgsql16\bin\pg_isready.exe -h 127.0.0.1 -p 5432
Get-ScheduledTask -TaskName "MAS-Background-Worker", "MAS-Nakit-Radar-Gunluk-Yedek", "MAS-Nakit-Radar-Telemetri-Gozetim" -ErrorAction SilentlyContinue | Select-Object TaskName, State

# 3. Sistem telemetrisi ve yedek durumu ne diyor?
pnpm ops:telemetry
pnpm backup:offdevice:verify

# 4. Alarm günlüğünün son satırları
Get-Content logs\alerts.jsonl -Tail 5 -ErrorAction SilentlyContinue
```

| Belirti | Muhtemel sebep | Runbook |
|---|---|---|
| `/health` → `db: "down"` veya `pg_isready.exe` hata veriyor | Yerel PostgreSQL 16 hizmeti durmuş | [postgres-service.md](postgres-service.md) |
| `/version` → `commit: "unknown"` | Yanlış/eski derleme çalışıyor | [start.md](start.md) (`pnpm build && pnpm start`) |
| Sayfa açılmıyor, port 3000 boş | Uygulama sunucusu düşmüş | [start.md](start.md) |
| `git status` silinmiş migration dosyası gösteriyor | Yarıda kesilmiş doğrulama — **`git checkout` YAPMAYIN** | [failed-migration.md](failed-migration.md) |
| Disk doldu | Eski klonlar veya budanmamış yedekler | [db-full.md](db-full.md) |

---

## 5. Kontrollü kapatma

Runbook: [stop.md](stop.md)

Bilgisayarı kapatmadan veya güncelleme yapmadan önce:

1. `pnpm start` penceresinde **Ctrl-C** yapın (veya [stop.md](stop.md) Yol 2 ile yalnız port 3000 sürecini durdurun).
2. `curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3000/ready` çıktısının `000` olduğunu doğrulayın.
3. Tam makine bakımı yapacaksanız yönetici PowerShell'de `Stop-Service MAS-PostgreSQL16` çalıştırabilirsiniz ([postgres-service.md](postgres-service.md)).

---

## 6. Yedekten geri dönme provası (restore)

Runbook: [restore.md](restore.md)

**Asla doğrudan gerçek veritabanının (`mas_radar_dev`) üzerine geri yüklemeyin.** Ayda bir harcanabilir klon üzerinde tam geri yükleme tatbikatı yapın:

```powershell
$env:SOURCE_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
$env:RESTORE_DB = "mas_radar_restore_drill"
$env:SMOKE_PORT = "3290"
$env:MAS_NEXT_DIST_DIR = ".next-restore-drill"
pnpm release:restore-drill
Remove-Item Env:SOURCE_DATABASE_URL, Env:RESTORE_DB, Env:SMOKE_PORT, Env:MAS_NEXT_DIST_DIR -ErrorAction SilentlyContinue
```

---

## 7. Kullanıcı açma / rol değiştirme / parola

| İş | Runbook |
|---|---|
| Yeni kullanıcı | [user-creation.md](user-creation.md) |
| Rol değiştirme / hesap pasifleştirme / kilit açma | [role-change.md](role-change.md) |
| Parola ve OAuth/entegrasyon anahtarı yenileme | [password-rotation.md](password-rotation.md) |

---

## Kısa özet — rutin takvim

```text
Her sabah : pnpm backup:offdevice:verify  →  pnpm ops:telemetry  →  ALERT yoksa devam
Gün içi   : /overview → /payments → /cashflow/13-week → /finance/treasury
Akşam     : Windows açık/uykuda (gece 03:00 yedeği StartWhenAvailable ile telafili çalışır)
Haftada 1 : Harici USB/NAS tak → pnpm ops:backup:offdevice → pnpm backup:offdevice:verify -- --strict-offdevice
Ayda 1    : pnpm release:restore-drill (veya pnpm release:stage07-backup-gate)
```
