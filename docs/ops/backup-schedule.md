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

Önce **ne kaydedileceğini görün** (hiçbir şey kaydedilmez):

```bash
pnpm exec tsx scripts/ops/schedule-windows.ts install
```

Ön koşulların hepsi `OK` ise kaydedin:

```bash
pnpm exec tsx scripts/ops/schedule-windows.ts install --apply --at 03:00
pnpm exec tsx scripts/ops/schedule-windows.ts status      # SCHEDULED TASK = REGISTERED
```

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

**`backups/` çok büyüdü** — §3'teki budamayı çalıştırın; kuru koşu ne kazanacağınızı söyler.
