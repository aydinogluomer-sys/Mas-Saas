# Yedek zamanlaması — operatör el kitabı

**Kime:** MAS operatörüne. **Ne zaman:** kurulumda bir kez, sonra ayda bir doğrulama.

Bu belge iki şeyi ayırır: **kurulu olan** (kod, doğrulanmış araçlar) ve **sizin yapmanız
gereken** (fiziksel hedef takmak, görevi kaydetmek). İkincisi bilinçli olarak otomatikleştirilmedi
— tekrarlayan bir görev kaydetmek ve bir diski yedek hedefi ilan etmek makinenizde kalıcı
kararlardır.

---

## 0. Bir bakışta durum

```text
BACKUP EXISTS / READABLE / RESTORABLE / DATA MATCHES / APP STARTS   = kurulu ve doğrulandı
OFF_DEVICE TOOLING                                                  = kurulu ve doğrulandı
OFF_DEVICE PHYSICAL TARGET                                          = SİZDE — hedef takılmalı
OPERATIONAL SCHEDULE (kod)                                          = kurulu ve doğrulandı
OPERATIONAL SCHEDULE (kayıt)                                        = SİZDE — kaydedilmeli
RETENTION (kod)                                                     = kurulu ve doğrulandı
RETENTION (ilk gerçek budama)                                       = SİZDE — bir kez onaylayın
```

---

## 1. Off-device hedefi tanımlayın (ÖNCE bu)

Yerel diskteki ikinci bir klasör yedek değildir: diski, makineyi ya da şifreleyen bir yazılımı
kaybeden senaryo ikisini birden kaybeder.

1. Harici diski takın **veya** NAS paylaşımını bağlayın.
2. Hedefi tanımlayın (kalıcı olması için `setx`):

```powershell
setx MAS_OFFDEVICE_BACKUP_DIR "E:\mas-yedek"
# NAS için:
setx MAS_OFFDEVICE_BACKUP_DIR "\\nas\mas-yedek"
```

3. Yeni bir terminal açın ve hedefin **sınıfını** doğrulayın:

```bash
pnpm exec tsx scripts/ops/offdevice-copy.ts --dry-run
```

Görmek istediğiniz:

```text
Hedef sınıfı     : REMOVABLE_VOLUME   (ya da NETWORK_DRIVE / UNC_NETWORK_SHARE)
OFF_DEVICE PHYSICAL TARGET = OK
```

`LOCAL_STANDIN` ya da `FIXED_SEPARATE_VOLUME` görüyorsanız hedef kabul edilmemiştir; araç bunu
"tamam" diye raporlamaz. Şifreli nesne depolamasının yerel eşitleme klasörü gibi otomatik
tespit edilemeyen bir hedef kullanıyorsanız beyanla kabul ettirebilirsiniz — beyan ölçüm
değildir ve makbuzda öyle etiketlenir:

```powershell
setx MAS_OFFDEVICE_DECLARED_KIND "encrypted-object-storage-sync"
setx MAS_OFFDEVICE_OPERATOR_ATTESTATION "Omer Aydinoglu, 2026-08-25, sifreli kova mas-backups"
```

> Gerçek finansal veri hiçbir dış servise otomatik gönderilmez. Şirket dışı bir hedef
> seçiyorsanız şifreleme ve erişim kaydı sizin sorumluluğunuzdadır.

---

## 2. Günlük görevi kaydedin

### Ön koşul: native PostgreSQL 16 araçları

Docker bu makineden kaldırıldı. Görev artık yerel PostgreSQL 16 araçlarını (`pg_dump`,
`pg_restore`, `psql`) kullanır; nerede olduklarını `.env.local`'e (ya da `setx` ile ortama)
yazın:

```text
MAS_PG_BIN_DIR=C:\MAS\pgsql16\bin
```

`MIGRATION_DATABASE_URL` `127.0.0.1:5432/mas_radar_dev`'i göstermeli. Görev başka bir host'u ya
da başka bir veritabanını **hiçbir bağlantı açmadan** reddeder (exit 1). Parola hiçbir aracın komut
satırına yazılmaz; araçlar onu yalnız kendi süreç ortamında alır. Kümenin kendisi için:
`docs/ops/postgres-service.md`.

Önce **ne kaydedileceğini görün** (hiçbir şey kaydedilmez):

```bash
pnpm exec tsx scripts/ops/schedule-windows.ts install
```

Ön koşulların hepsi `OK` ise kaydedin:

```bash
pnpm exec tsx scripts/ops/schedule-windows.ts install --apply --at 03:00
pnpm exec tsx scripts/ops/schedule-windows.ts status      # SCHEDULED TASK = REGISTERED
```

`install --apply` kayıttan hemen sonra görev ayarlarını **sertleştirir** ve `SETTINGS HARDENED`
yazar: `StartWhenAvailable` (makine 03:00'te uykudaysa ya da kapalıysa yedek açılışta telafi
edilir), 2 saatlik süre sınırı (takılan bir koşu sonraki geceleri bloke etmez) ve aynı anda tek
koşu. `status` bu ayarları ve son sonucu (`LastTaskResult`) gösterir; görev daha önce kaydedildiyse
`install --apply`'ı bir kez daha çalıştırmak ayarları yerinde uygular (`/F` ile üzerine yazar).

Elle bir kez tetikleyip gerçekten çalıştığını görün:

```bash
pnpm exec tsx scripts/ops/schedule-windows.ts run-once --apply
```

Sonra `backups/daily-backup-task.log` ve `backups/daily-runs.jsonl` dosyalarına bakın.

Kaldırma:

```bash
pnpm exec tsx scripts/ops/schedule-windows.ts uninstall --apply
```

### Görev ne yapıyor

`scripts/ops/mas-daily-backup.cmd` → `scripts/ops/backup-daily.ts`:

1. `mas_radar_dev`den `pg_dump` (yalnız okuma) — dayanıklı zincir: fsync → temp doğrulama →
   atomik rename → final dosyada yeniden doğrulama.
2. Dokuz alanlı makbuz (`<dump>.stage07.json`).
3. Off-device kopya + **hedefte** sha256 doğrulaması + hedefteki kopyanın `pg_restore --list` ile
   okunabilirliği.
4. Retention kuru koşusu (silme için `MAS_BACKUP_PRUNE_APPLY=1` gerekir).
5. `backups/daily-runs.jsonl`e koşu kaydı.

Çıkış kodları (Görev Zamanlayıcı "Last Result" sütununda görünür):

| Kod | Anlamı | Ne yapmalı |
|---|---|---|
| 0 | yedek + off-device kopya tamam | bir şey yok |
| 1 | yedek alınamadı / doğrulama düştü | **P0** — hemen bakın, geri dönülecek nokta yok |
| 3 | yedek alındı ama off-device hedef yok/geçersiz | diski takın ya da paylaşımı bağlayın |

Kod 3'ü bilinçli olarak kabul ediyorsanız (`MAS_OFFDEVICE_ACKNOWLEDGED_MISSING=1`) uyarı yine
günlüğe yazılır — ama artık kırmızı görünmez. Bunu yalnız geçici bir dönem için yapın.

Başarısız koşular da `backups/daily-runs.jsonl`'e bir satır yazar:
`{"ok":false,"exitCode":1,"stage":"config|identity|versions|dump|receipt", "error":"…"}` (hata
metni parolalardan arındırılmış). Son başarısız gecenin hangi aşamada düştüğü buradan okunur.

### Başarısız bir geceyi kim görür: telemetri gözetim görevi

Yedek-yaşı alarmı (`backup_age_hours`, eşik 36 saat, P1) telemetri gözetim görevindedir ve
**yalnız `daily-*.dump` dosyalarını sayar** — her `db:migrate`'in bıraktığı ön-migrasyon dump'ları
günlük işin düştüğünü gizleyemez. Görev kayıtlı değilse başarısız bir gece kimseye ulaşmaz:

```bash
pnpm ops:telemetry:schedule install            # what-if, ön koşulları gösterir
pnpm ops:telemetry:schedule install --apply    # 07:00'den itibaren 6 saatte bir + sertleştirilmiş ayarlar
pnpm ops:telemetry:schedule status
```

Alarm her zaman `logs/alerts.jsonl`'e yazılır. Sahibin Telegram sohbetine de gitmesi için
`.env.local`'e `MAS_ALERT_CHANNELS=telegram` ile `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID`
yazın (`install` ön koşulları bunların varlığını — değerlerini değil — gösterir). Gecikme: başarısız
bir 03:00 koşusu, son iyi yedekten 36 saat sonra ilk telemetri koşusunda (en geç ~18 saat sonra)
alarm üretir.

---

## 3. Retention'ı bir kez onaylayın

```bash
pnpm exec tsx scripts/ops/backup-prune.ts --verbose | less   # ne silineceğini OKUYUN
pnpm exec tsx scripts/ops/backup-prune.ts --apply
```

Politika: **daily 7 · weekly 4 · monthly 3**, 24 saatten genç hiçbir dosyaya dokunulmaz.
IMMUTABLE sınıfı (cutover yedekleri, `stage07_real*`, `mas_radar_dev` adını taşıyan her dump,
`<dump>.immutable` işaretli dosyalar) **hiçbir koşulda** silinmez.

Bir yedeği elle kalıcı korumak isterseniz yanına boş bir işaret dosyası koyun:

```bash
echo "2026 yil sonu kapanis" > backups/<dump-adi>.dump.immutable
```

Görevin her gece budama da yapmasını istiyorsanız ortam değişkenini kalıcı yapın:

```powershell
setx MAS_BACKUP_PRUNE_APPLY "1"
```

---

## 4. Ayda bir: tam kapı

Yedek almak ile yedeğin geri yüklenebildiğini bilmek aynı şey değildir.

```bash
MAS_OFFDEVICE_BACKUP_DIR=E:\mas-yedek pnpm exec tsx scripts/release/stage07-backup-gate.ts
```

Kapı yedi başlığın tamamını sorar, iki harcanabilir veritabanına restore eder, saklanan
kopyanın **kendisinden** de restore eder, uygulamayı restore edilen kopyaya karşı başlatır ve
`docs/release-evidence/final-production-readiness/05-real-backup-restore.md` dosyasını yeniden
yazar. Kaynağa yalnız okuma uygular; iki hedefi de koşu sonunda düşürür.

**Her cutover'dan önce mutlaka** koşturun.

---

## 5. Sık karşılaşılanlar

**"Görev çalıştı ama Last Result = 3"** — off-device hedef yok. Disk takılı mı? `E:` harfi
değişmiş olabilir (`MAS_OFFDEVICE_BACKUP_DIR`i güncelleyin).

**"schtasks: erişim reddedildi"** — terminali yönetici olarak açın; görevin kendisi `/RL LIMITED`
ile çalışır, yükseltme yalnız kayıt anında gerekir.

**"pnpm bulunamadı"** — Görev Zamanlayıcı sizin PATH'inizi almayabilir. `install` ön koşulları
`pnpm`in tam yolunu gösterir; gerekirse `mas-daily-backup.cmd` içinde `pnpm` yerine tam yolu yazın.

**"pg_dump bulunamadı — MAS_PG_BIN_DIR ayarlayın"** — `.env.local`'e
`MAS_PG_BIN_DIR=C:\MAS\pgsql16\bin` yazın. `install` ön koşulu bunu kayıttan ÖNCE yakalar.

**"pg_dump ana sürümü … sunucunun ana sürümüyle aynı değil"** — `MAS_PG_BIN_DIR` başka bir
PostgreSQL kurulumunu gösteriyor; sunucuyla aynı (16) kurulumun `bin` dizinini verin.

**"SETTINGS NOT HARDENED"** — görev kayıtlı ama Windows varsayılanlarıyla. Terminali yeniden açıp
`install --apply`'ı tekrar çalıştırın; sürerse `status` çıktısını saklayın.

**`backups/` çok büyüdü** — §3'teki budamayı çalıştırın; kuru koşu ne kazanacağınızı söyler.
