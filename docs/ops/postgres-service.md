# RUNBOOK — PostgreSQL 16 hizmeti (MAS-PostgreSQL16)

> **Kime:** MAS operatörüne (sahibe). Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Yerine geçtiği belge:** `docs/ops/docker-restart.md` (Docker bu makineden kaldırıldı).

---

## PURPOSE

Tek kanonik veritabanı bu makinedeki yerel PostgreSQL 16 kümesidir:

```text
İKİLİ DOSYALAR : C:\MAS\pgsql16\bin   (pg_ctl, postgres, pg_dump, pg_restore, psql, pg_isready)
VERİ DİZİNİ    : C:\MAS\pgdata16      (UTF8, data checksums, saat dilimi Etc/UTC)
DİNLEME        : yalnız 127.0.0.1 ve ::1, port 5432, scram-sha-256
HİZMET         : MAS-PostgreSQL16 (NT AUTHORITY\NetworkService, otomatik başlar)
GEÇİCİ YOL     : zamanlanmış görev "MAS-PostgreSQL16-Oturum-Baslat" (hizmet kurulana kadar)
```

Bu belge üç şeyi anlatır: hizmeti **bir kez** kurmak, günlük durum kontrolü, ve bir şey ters
giderse ne yapılacağı.

### Önce şunu bilin: veri dizini kutsaldır

`C:\MAS\pgdata16` **silinmez, taşınmaz, yeniden adlandırılmaz, elle düzenlenmez.** Bu belgedeki
hiçbir komut veriyi silmez. Hizmeti kurmak, durdurmak, yeniden başlatmak, hatta kaldırmak veriyi
etkilemez.

---

## 1. Hizmeti BİR KEZ kurun (yönetici)

Bugün küme, siz oturum açtığınızda çalışan `MAS-PostgreSQL16-Oturum-Baslat` görevinden başlıyor.
Bunun üç zayıflığı var: oturum kapanınca veritabanı durur, çökerse kendiliğinden kalkmaz, ve gece
03:00 yedeği oturum açık değilse veritabanı bulamaz. Hizmet bu üçünü de kapatır.

### Nasıl çalıştırılır

1. Başlat menüsüne **PowerShell** yazın.
2. **Windows PowerShell**'e **sağ tıklayın** → **Yönetici olarak çalıştır** → UAC sorusuna **Evet**.
3. Açılan pencerede:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

# a) PROVA — hiçbir şey değişmez, yapılacak her adım listelenir
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\install-postgres-service.ps1 -WhatIf

# b) GERÇEK KURULUM
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\install-postgres-service.ps1
```

Kurulum birkaç saniye veritabanını durdurur (`pg_ctl stop -m fast`: açık işlemler geri alınır,
yarım yazma kalmaz). Uygulama o sırada açıksa bir an hata gösterebilir; isterseniz önce
`docs/ops/stop.md` ile uygulamayı durdurun.

### Script ne yapar (sırasıyla)

| Adım | Ne | Değiştirir mi |
|---|---|---|
| 0 | Ön koşullar: yönetici mi, PostgreSQL 16 ikilileri, veri dizini 16 mı, `listen_addresses` yalnız loopback mi, `pg_hba.conf` yalnız loopback + **scram-sha-256** mi (**`trust` görürse durur**), port 5432 başka bir programda mı | Hayır |
| 1 | Aynı adla hizmet var mı; varsa doğru mu (yanlışsa durur, sessizce yeniden kaydetmez) | Hayır |
| 2 | Oturum açılış görevini **devre dışı** bırakır (ikinci bir sunucu başlatmasın) | Evet |
| 3 | Elle/görevle çalışan sunucuyu `pg_ctl stop -m fast` ile durdurur | Evet |
| 4 | Veri dizini izinleri: miras kapatılır, yalnız SYSTEM, Administrators, NetworkService ve **siz** (SID ile) | Evet |
| 5 | `pg_ctl register -N MAS-PostgreSQL16 -U "NT AUTHORITY\NetworkService" -S auto -D C:\MAS\pgdata16`, hata durumunda otomatik yeniden başlatma, hizmeti başlatır | Evet |
| 6 | Doğrulama: `pg_isready -h 127.0.0.1 -p 5432`, dinleyiciler yalnız 127.0.0.1/::1, hizmet Running + Auto + NetworkService | Hayır |
| 7 | Doğrulama geçtiyse oturum açılış görevini **kaldırır** | Evet |
| 8 | Makbuz: `logs\postgres-service-install-<UTC>.json` (parola içermez) | Yalnız dosya |

Script **asla**: yeni küme oluşturmaz, veri silmez/taşımaz, `postgresql.conf`/`pg_hba.conf`
düzenlemez, hiçbir parolaya dokunmaz ya da yazdırmaz, güvenlik duvarı kuralı eklemez.

Adım 3–6'dan biri başarısız olursa oturum açılış görevi **yeniden etkinleştirilir**: bir sonraki
oturum açılışında veritabanı yine kalkar.

### Beklenen çıktı

```text
KURULUM TAMAM - MAS-PostgreSQL16 otomatik basliyor ve yalniz 127.0.0.1/::1:5432 dinliyor.
```

Scripti **ikinci kez** çalıştırmak güvenlidir; yalnız doğrular:

```text
ZATEN KURULU - hizmet calisiyor ve dogrulandi.
```

Yalnız doğrulamak için: `... install-postgres-service.ps1 -VerifyOnly`

### Çıkış kodları

| Kod | Anlamı | Ne yapılır |
|---|---|---|
| 0 | Tamam / zaten kurulu / prova | — |
| 10 | Yönetici değil | PowerShell'i **Yönetici olarak çalıştır** ile açın |
| 11 | `C:\MAS\pgsql16\bin` eksik ya da sürüm 16 değil | Kurulumu kontrol edin; script hiçbir şey indirmez |
| 12 | `C:\MAS\pgdata16` yok ya da 16 kümesi değil | **DURUN** — script küme oluşturmaz; `docs/ops/incident.md` |
| 13 | `listen_addresses` loopback dışı, port farklı ya da `pg_hba.conf` `trust`/loopback dışı satır içeriyor | Çıktıdaki satırları düzeltin (yönetici), sonra yeniden çalıştırın |
| 14 | Port 5432 başka bir programda | O programı kapatın (çıktı PID'i söyler) |
| 15 | Aynı adla farklı yapılandırılmış hizmet var | Çıktıdaki `pg_ctl unregister` komutu, sonra yeniden çalıştırın |
| 16 | Çalışan sunucu durdurulamadı | `docs/ops/incident.md`; oturum görevi yeniden etkin |
| 17 | Hizmet başlamadı / doğrulanamadı | Application olay günlüğü (aşağıda); oturum görevi yeniden etkin |
| 18 | İzinler doğrulanamadı | Çıktıdaki beklenen/ölçülen SID listesine bakın |

---

## 2. Günlük durum kontrolü (yönetici gerekmez)

```powershell
Get-Service MAS-PostgreSQL16                                   # Running bekleniyor
& C:\MAS\pgsql16\bin\pg_isready.exe -h 127.0.0.1 -p 5432       # "accepting connections"
pnpm db:ensure                                                  # "PostgreSQL hazır (native, 127.0.0.1:5432)."
```

`pnpm dev` ve `pnpm start` ilk halkada `scripts/db/ensure.ts` çalıştırır: veritabanı kapalıysa
uygulama açılmaz ve **ne yapılacağını** yazar (hizmet yok / durdurulmuş / çalışıyor ama cevap yok).
Bu kontrol hiçbir şeyi başlatmaz ve hiçbir küme oluşturmaz.

## 3. Başlatma / durdurma (yönetici PowerShell)

```powershell
Start-Service MAS-PostgreSQL16
Stop-Service MAS-PostgreSQL16      # önce uygulamayı durdurun: docs/ops/stop.md
Restart-Service MAS-PostgreSQL16
```

Hizmet kurulmadan önceki dönemde (yalnız oturum görevi varken), yönetici gerektirmeden:

```powershell
Start-ScheduledTask -TaskName MAS-PostgreSQL16-Oturum-Baslat
```

## 4. Günlükler

- `logging_collector` açıksa: `C:\MAS\pgdata16\log\` altındaki en yeni dosya.
- Hizmet olarak çalışırken diğer her şey **Windows Application olay günlüğüne** gider:

```powershell
Get-EventLog -LogName Application -Source PostgreSQL -Newest 20
```

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO (hizmet yaşam döngüsü verinin içeriğini değiştirmez)
```

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `pnpm db:ensure` → "Windows hizmeti 'MAS-PostgreSQL16' kurulu değil" | Hizmet kurulmamış | §1; o zamana kadar `Start-ScheduledTask` |
| "hizmeti kurulu ama DURDURULMUŞ" | Hizmet duruyor | `Start-Service MAS-PostgreSQL16` (yönetici) |
| "hizmeti ÇALIŞIYOR ama … cevap vermiyor" | Port/dinleme ayarı ya da açılış hatası | §4 günlükler; `.env.local` portu 5432 mi |
| `/health` → `"db":"down"` | Veritabanı kapalı | §2, §3 |
| Olay günlüğünde `could not write to file ... No space left` | **Disk doldu** | `docs/ops/db-full.md` |
| Satır sayıları beklenenden düşük | Yanlış küme ya da veri kaybı | **DURUN** — `docs/ops/incident.md` |

## STOP CONDITION

1. `C:\MAS\pgdata16` yoksa ya da boşsa → **P0**. Hiçbir şey oluşturmayın, hiçbir script
   çalıştırmayın: `docs/ops/incident.md` + `docs/ops/restore.md`.
2. Günlük disk hatası gösteriyorsa → yeniden başlatmayı tekrarlamayın, önce `docs/ops/db-full.md`.

## ROLLBACK (hizmeti kaldırmak — veri etkilenmez)

Yönetici PowerShell:

```powershell
Stop-Service MAS-PostgreSQL16
& C:\MAS\pgsql16\bin\pg_ctl.exe unregister -N MAS-PostgreSQL16

# Oturum açılış görevini (sizin kullanıcınızla, yönetici gerektirmeden) yeniden kaydetmek için,
# NORMAL bir PowerShell'de:
$action = New-ScheduledTaskAction -Execute 'C:\MAS\pgsql16\bin\pg_ctl.exe' `
  -Argument 'start -D C:\MAS\pgdata16 -l C:\MAS\logs\pg_ctl.log -w -t 120'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName 'MAS-PostgreSQL16-Oturum-Baslat' -Action $action -Trigger $trigger
Start-ScheduledTask -TaskName 'MAS-PostgreSQL16-Oturum-Baslat'
```

`Register-ScheduledTask` "Erişim reddedildi" derse aynı komutları yönetici PowerShell'de
çalıştırın; görev yine sizin kullanıcınızla (`-User $env:USERNAME`) çalışır.

Not: script veri dizini izinlerini SYSTEM, Administrators, NetworkService ve sahiple sınırlar;
sahip tam yetkili kaldığı için oturum görevi geri alındıktan sonra da çalışır.

## SECRET HANDLING

- Bu runbook'ta ve kurulum scriptinde parola geçmez. NetworkService hesabının parolası yoktur.
- Yedek ve doğrulama araçları owner parolasını **yalnız kendi süreç ortamında** (PGPASSWORD)
  alır; hiçbir komut satırına yazılmaz. Parola `.env.local`'deki `MIGRATION_DATABASE_URL`'dedir ve
  o dosya paylaşılmaz.
- Kurulum makbuzu (`logs\postgres-service-install-*.json`) parola ya da bağlantı dizesi içermez.
