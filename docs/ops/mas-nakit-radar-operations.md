# MAS Nakit Radar — Operasyon El Kitabı (PHASE 7)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Kabul edilen kod:** `ACCEPTED_CODE_SHA = ceca39a3a60c00358d1aa90f00f9b2864237e4ec` — yeni her derleme bu SHA ile yapılır (`APP_COMMIT_SHA`).
> **Ayrıntılı runbook'lar:** `docs/ops/backup.md`, `docs/ops/restore.md`, `docs/ops/docker-restart.md`, `docs/ops/backup-schedule.md`, `docs/ops/telemetry-alerting.md`, `docs/backup-restore-policy.md`. Bu belge onların **günlük özeti ve karar tablosudur**; onların yerine geçmez.

---

## 0. Bir bakışta: neyin "sağlıklı" olduğu

| Sinyal | Sağlıklı | Nereden okunur |
|---|---|---|
| Docker Desktop + `mas-radar-pg` konteyneri | `docker ps` listede, `pg_isready` cevap veriyor | `docker ps`, `docs/ops/docker-restart.md` §1 |
| Günlük yedek (yerel) | **≤ 36 saat** içinde **doğrulanmış** yedek var | `pnpm ops:telemetry` → `backup_age_hours` |
| Günlük yedek (off-device, D:) | **≤ 36 saat** içinde D: üzerinde doğrulanmış kopya var | `pnpm ops:telemetry` → `backup_offdevice_age_hours` |
| Disk boş alanı (C:) | **≥ 10 GB** | `pnpm ops:telemetry` → `disk_free_gb` |
| Zamanlanmış görev | `MAS-Nakit-Radar-Gunluk-Yedek` Ready, son sonuç `0` | `schtasks /Query /TN MAS-Nakit-Radar-Gunluk-Yedek /V /FO LIST` |
| Uygulama | `/ready` 200, `/health` 200, `/version.commit = ceca39a3…` | tarayıcı ya da `pnpm ops:telemetry` (MAS_APP_BASE_URL verilince) |

**"Doğrulanmış yedek" ne demek (7.3 sözleşmesi).** Bir `.dump` dosyasının varlığı yetmez. Beşi birden gerekir:
dump (>0 bayt, `PGDMP` başlığı) **+** yanında `*.stage07.json` makbuzu **+** sha256'sı ŞİMDİ hesaplanıp makbuzla eşleşiyor
**+** boyut makbuzla eşleşiyor **+** `pg_restore --list` kanıtı (şimdi koşuldu ya da yedek anında koşulup sha256 ile o dosyaya
bağlanmış). Beşinden biri eksikse telemetri o dosyayı **saymaz** ve "DOĞRULANMIŞ YEDEK YOK" der. Yerel ve off-device tazelik
**ayrı ayrı** ölçülür; biri diğerini örtmez.

---

## 1. GÜNLÜK (5 dakika)

1. **Docker ayakta mı?** Görev çubuğunda balina simgesi yeşil; değilse `docs/ops/docker-restart.md`.
2. **Dünkü yedek alındı mı?** Komut:
   ```powershell
   pnpm ops:telemetry
   ```
   Beklenen: `backup_age_hours` **ok** (≤ 36) ve `backup_offdevice_age_hours` **ok**. `ALERT` görürseniz §3'e gidin.
   Aynı çıktıda `disk_free_gb` **ok** olmalı (≥ 10 GB).
3. **Görev günlüğüne bakın** (isteğe bağlı ama iyi alışkanlık): `backups\daily-backup-task.log` dosyasının son satırı
   `MAS daily backup END exit=0` olmalı. `exit=1` = yedek ALINAMADI; `exit=3` = yedek alındı ama **tek kopya** (off-device yok).
4. **D: takılı mı?** Off-device hedef `D:\MAS-Backups\mas_radar_dev` (USB disk, C:'den ayrı fiziksel disk — ölçüldü 2026-09-13).
   Takılı değilse gece görevi `OFF_DEVICE_COPY = DRIVE_ABSENT` yazar ve **exit 3** ile biter — bu bir hata değil, "diski tak" uyarısıdır.

## 2. HAFTALIK (15 dakika)

1. **Tam telemetri + JSON çıktı:** `pnpm ops:telemetry --json logs\telemetry-latest.json` → `verdict` `ALL_CLEAR` olmalı.
2. **Yedek dizini büyüklüğü:** `backups\` altında 800+ eski dump birikmiş olabilir. Retention **kuru koşuda** ne budayacağını
   gösterir: `pnpm ops:backup:prune` (uygulamak için `MAS_BACKUP_PRUNE_APPLY=1` — `docs/ops/backup-schedule.md` §3'ü okumadan
   uygulamayın; IMMUTABLE etiketli dosyalara dokunulmaz).
3. **Aylık tatbikat gününü kontrol edin** (her ayın ilk haftası): `pnpm release:restore-drill` — yedeği harcanabilir bir
   `mas_radar_restore_verify_*` veritabanına geri yükler, satır sayılarını kaynakla karşılaştırır, uygulamayı o veritabanıyla
   açar. Beklenen: `BACKUP EXISTS / READABLE / RESTORABLE / DATA MATCHES / APP STARTS`. Ayrıntı: `docs/ops/restore.md` Yol A.
4. **Zamanlanmış görev sağlığı:**
   ```powershell
   schtasks /Query /TN MAS-Nakit-Radar-Gunluk-Yedek /V /FO LIST
   ```
   `Last Result` `0` olmalı. `0x800710E0` görürseniz görev **hiç koşmamıştır** (bkz. §3.4).

## 3. ARIZA — ne görürsünüz, ne yaparsınız

### 3.1 `backup_age_hours = ALERT` (yerel yedek bayat ya da yok)

| Neden | Nasıl anlaşılır | Ne yapılır |
|---|---|---|
| Docker kapalı | `backups\daily-backup-task.log` son koşu: `YEDEK BAŞARISIZ: connect ECONNREFUSED 127.0.0.1:5432`, `exit=1` | Docker'ı başlatın (`docs/ops/docker-restart.md`), sonra görevi elle tetikleyin: `schtasks /Run /TN MAS-Nakit-Radar-Gunluk-Yedek`; 1 dk sonra log'da `exit=0` ya da `exit=3` görün |
| Görev hiç koşmamış | Log'da o gece için `START` satırı yok; `Last Result 0x800710E0` | Makine gece kapalı/uykuda ya da pil gücündeydi (bkz. §3.4). Görevi elle tetikleyin |
| Dump var ama makbuz/sha uyuşmuyor | Telemetri notu: `sha256 makbuzla EŞLEŞMİYOR` / `stage07 makbuzu yok` | O dosyaya **güvenmeyin**; görevi elle tetikleyip yeni bir yedek alın. Eski dosyayı silmeyin — inceleme için kalsın |

### 3.2 `backup_offdevice_age_hours = ALERT`

| Değer | Anlamı | Ne yapılır |
|---|---|---|
| `(MAS_OFFDEVICE_BACKUP_DIR yok)` | Off-device hedef hiç tanımlanmamış — **tek kopya yedek değildir** | `docs/ops/backup-schedule.md` §1: `MAS_OFFDEVICE_BACKUP_DIR` tanımlayın (örn. `D:\MAS-Backups\mas_radar_dev`) |
| `HEDEF YOK — DRIVE_ABSENT` | D: takılı değil | Diski takın, `schtasks /Run /TN MAS-Nakit-Radar-Gunluk-Yedek` |
| sayı > 36 | D: takılı ama kopya bayat | Görevi elle tetikleyin; log'da `Off-device: … hedefte sha256 doğrulaması: EŞLEŞTİ` görün |
| `DOĞRULANMIŞ YEDEK YOK` (D: takılı) | D: üzerindeki dosyaların makbuzu/sha'sı yok | Görevi elle tetikleyin; sonuç yine aynıysa `docs/ops/backup.md` ile elle kopya |

### 3.3 `disk_free_gb = ALERT`

- **< 10 GB (WARNING, P2):** Yer açma zamanı. Telemetri **hiçbir şeyi otomatik silmez**; siz karar verirsiniz.
- **< 5 GB (CRITICAL, P1):** Gece yedeği büyük ihtimalle `exit=1` ile düşecek; Docker Desktop de bu eşiğin altında başlamayı
  reddedebilir. Önce yer açın, sonra Docker.
- **Güvenle silinebilecekler (yeniden üretilebilir):** derleme çıktıları (`.next`, `.next-*` klasörleri — `pnpm build` yeniden
  üretir), Playwright tarayıcı önbelleği (`%LOCALAPPDATA%\ms-playwright` — `pnpm exec playwright install` yeniden indirir),
  `%TEMP%` altındaki eski oturum kalıntıları, eski RC worktree'leri (`git worktree remove`).
- **ASLA silinmeyecekler:** `backups\` altındaki dump'lar ve makbuzlar, `%LOCALAPPDATA%\Docker\wsl\disk\docker_data.vhdx`
  (**gerçek veritabanı buradadır**), `.env.local`, D:/USB yedekleri, git nesneleri, kullanıcı belgeleri.

### 3.4 `Last Result = 0x800710E0` (görev "reddedildi")

Task Scheduler'ın "operatör ya da yönetici isteği reddetti" kodu; dizüstü **pil gücündeyken** tetiğin reddedilmesi.
**2026-09-13'te kullanıcı kararıyla kapatıldı:** görev artık `DisallowStartIfOnBatteries=false` ve
`StopIfGoingOnBatteries=false` (pilde başlar, fiş çekilince yarıda kesilmez; yalnız bu göreve uygulandı — kanıt
`docs/release-evidence/v3/phase7-operations/final-closure/11-daily-job.json`). Kaçırılan koşu hâlâ telafi edilmez
(`StartWhenAvailable` kapalı): makine 03:00'te kapalıysa o gece yedek yoktur → sabah §1 adım 2'de `backup_age_hours`
alarm verir; `schtasks /Run` ile elle alın.

### 3.5 Docker Desktop açılmıyor

Bu makinede 2026-09-13'te ölçülen kök neden: Docker Desktop 4.86.0'ın `HKLM\SOFTWARE\Docker Inc.\Docker Desktop` kayıt
anahtarı ve `resources\wsl\docker-wsl-cli.iso` / `resources\linuxkit\` dosyaları **eksik** (backend günlüğü: "cannot find
registry key … getting linuxkit iso path"). Bu, yeniden başlatmayla düzelmez; **onarım kurulumu** gerekir:
1. Docker Desktop → sağ tık → **Quit Docker Desktop**.
2. `Docker Desktop Installer.exe` (aynı sürüm 4.86.0 ya da üstü) indirip **Install/Repair** ile üzerine kurun.
3. **ASLA** "Reset to factory defaults" / "Clean / Purge data" / "Uninstall" seçmeyin — `docker_data.vhdx` (23,8 GB, gerçek
   veritabanı) silinir. Onarım kurulumu VHDX'e dokunmaz; kurulum sonrası `docker ps` → `mas-radar-pg` görünmeli
   (görünmüyorsa `docs/ops/docker-restart.md` §3c: compose konteyneri yeniden yaratır, **veri volume'da durur**).
4. Onarımdan önce C: üzerinde **≥ 8 GB** boş alan olsun (§3.3).

### 3.6 Uygulama açılmıyor / `/health` 503

`docs/ops/incident.md`. Kısa yol: DB kopuksa `/health` 503 verir → önce Docker (§3.5), sonra `pnpm start`.

## 4. ASLA YAPMAYIN

- Docker Desktop **Reset to factory defaults**, **Clean/Purge data**, `docker system prune -a`, `docker volume prune`,
  `docker volume rm`, `docker container rm -f mas-radar-pg`, WSL `--unregister docker-desktop`, `docker_data.vhdx` silme/yeniden
  yaratma. Hepsi gerçek veritabanını yok eder.
- `mas_radar_dev` üzerinde `DROP DATABASE`, elle SQL değişikliği, migration'ı elle koşmak. Migration yalnız `pnpm db:migrate`
  ile, cutover runbook'u (`docs/real-db-cutover-runbook.md`) içinde, önce doğrulanmış yedekle.
- Yedek dizininden dosya silmek (retention `pnpm ops:backup:prune` dışında).
- `.env.local`'i, dump dosyalarını ya da bağlantı dizelerini e-posta/Telegram/git'e göndermek.
- Tek kopya yedekle yetinmek: `exit=3` görüp "yedek alındı" deyip geçmek. Off-device kopya olmadan yedek **tamamlanmamıştır**.
- Telemetri alarmını "zaten biliyorum" diye sessize almak: alarm, kanıt dosyasıdır.

## 5. Komut özeti

| Amaç | Komut |
|---|---|
| Sağlık anlık görüntüsü | `pnpm ops:telemetry` (`--json logs\telemetry-latest.json` ile yapısal çıktı) |
| Yedeği hemen al | `schtasks /Run /TN MAS-Nakit-Radar-Gunluk-Yedek` (ya da `pnpm ops:backup:daily`) |
| Off-device kopya (elle) | `MAS_OFFDEVICE_BACKUP_DIR=D:\MAS-Backups\mas_radar_dev` ile `pnpm ops:backup:offdevice` |
| Restore tatbikatı (aylık) | `pnpm release:restore-drill` |
| Retention (kuru koşu) | `pnpm ops:backup:prune` |
| Görev durumu | `schtasks /Query /TN MAS-Nakit-Radar-Gunluk-Yedek /V /FO LIST` |
| Alarm mantığını kanıtla (harcanabilir DB) | `pnpm ops:telemetry:alerting:verify` |

Çıktılarda **sır yoktur**: makbuzlar yalnız dosya adı, boyut, sha256, ledger ve sürüm taşır; bağlantı dizesi hiçbir yere yazılmaz.
