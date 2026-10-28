# RUNBOOK — backup (yedek al)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Politika ve saklama süreleri:** `docs/backup-restore-policy.md` ·
> **Zamanlanmış görev kurulumu:** `docs/ops/backup-schedule.md`

---

## PURPOSE

Gerçek veritabanının (`mas_radar_dev`) **geri yüklenebilir** bir kopyasını almak.

"Dosya oluştu" bir yedek değildir. Bu runbook her yedek için dört soruyu sorar:

```text
1. dump dosyası oluştu mu?           (BACKUP EXISTS)
2. arşiv okunabiliyor mu?            (BACKUP READABLE  — pg_restore --list)
3. kopyası ikinci bir aygıtta mı?    (OFF-DEVICE)
4. gerçekten geri yüklenebiliyor mu? (RESTORABLE — docs/ops/restore.md)
```

İlk üçü buradadır. Dördüncüsü ayrı bir runbook'tur ve **ayda bir** yapılır.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | PostgreSQL ayakta | `docker exec mas-radar-pg pg_isready -U postgres` |
| 2 | Diskte yer var | `Get-PSDrive C \| Select-Object Used,Free` — **en az 2 GB boş** |
| 3 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` → `gölgeleme yok` |
| 4 | (off-device için) harici disk/NAS takılı | `docs/ops/backup-schedule.md` §1 |

> **Bu makinede disk darlığı var.** C: sürücüsü %95 doluluk seviyesinde ve `backups/` klasörü
> tek başına yaklaşık 1 GB. Yedek almadan önce yer açmanız gerekebilir: `docs/ops/db-full.md`.

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO
```

Yedek alma gerçek veritabanına **tek bir satır yazmaz**. Yapılan iş `pg_dump` ve birkaç
`select` sorgusudur. Uygulamayı durdurmanız gerekmez — ancak cutover öncesi yedekte
(bkz. `docs/ops/cutover.md` adım A) uygulama **durdurulmuş olmalıdır**, çünkü orada istenen şey
"o anın kesin fotoğrafı"dır.

---

## COMMANDS

### Yol A — günlük yedek (önerilen tek komut)

Dump + makbuz + off-device kopya + saklama budaması, tek koşuda:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
pnpm ops:backup:daily
```

Bu, zamanlanmış görevin de çalıştırdığı iştir. Çıkış kodları:

| Kod | Anlamı | Ne yapmalı |
|---|---|---|
| 0 | Yedek + doğrulama + off-device kopya tamam | Bir şey yok |
| 1 | Yedek alınamadı / doğrulama düştü | **P0** — `docs/ops/incident.md` |
| 3 | Yedek tamam ama off-device hedef yok | Diski takın; tek kopya yedek sayılmaz |

### Yol B — elle tek dump (hızlı, makbuzsuz)

```bash
bash scripts/deploy/backup-db.sh mas_radar_dev
```

Çıktı: `backups/mas_radar_dev-YYYYMMDD-HHMMSS.dump`

### Yol C — cutover öncesi makbuzlu yedek (git kanıtı + küme kimliği eşleşmesi)

Bu yol, dump'ı **hangi kod sürümüyle ve hangi PostgreSQL kümesinden** aldığınızı kanıtlar.
Temiz bir git ağacı ister; bu bilinçlidir.

```powershell
# Küme kimliğini okuyun (yalnız okuma)
docker exec mas-radar-pg psql -U postgres -t -A -c "select system_identifier from pg_control_system();"
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD

$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

pnpm exec tsx scripts/db/backup-receipt.ts `
  --expected-database-name mas_radar_dev `
  --expected-system-identifier <yukarıdaki system_identifier> `
  --expected-git-branch <yukarıdaki branch> `
  --expected-git-head <yukarıdaki 40 karakterli SHA> `
  --container mas-radar-pg `
  --label cutover_A `
  --out-dir backups
```

### Off-device kopya (ayrı komut olarak)

```powershell
pnpm exec tsx scripts/ops/offdevice-copy.ts --dry-run   # önce ne yapacağını görün
pnpm ops:backup:offdevice                               # gerçekten kopyalar
```

Hedef `MAS_OFFDEVICE_BACKUP_DIR` ile tanımlanır (kurulum: `docs/ops/backup-schedule.md` §1).
Değişken tanımlı değilse araç **hiçbir şey yapmaz ve exit 2 ile durur** — sessizce yerel bir
klasöre düşüp "off-device tamam" demez.

### Yedeğin okunabilirliğini kanıtlayın (dosya boyutuna güvenmeyin)

```powershell
docker cp "backups\<dump-adi>.dump" mas-radar-pg:/tmp/kontrol.dump
docker exec mas-radar-pg pg_restore --list /tmp/kontrol.dump | Measure-Object -Line
docker exec mas-radar-pg rm /tmp/kontrol.dump
```

### Aylık tam kapı (yedek + iki ayrı restore + uygulama açılışı)

```powershell
pnpm exec tsx scripts/release/stage07-backup-gate.ts
```

**Her cutover'dan önce zorunludur.** Kaynağa yalnız okuma uygular; kendi oluşturduğu iki
harcanabilir veritabanını koşu sonunda düşürür.

---

## EXPECTED

```text
pnpm ops:backup:daily        ->  exit 0 (ya da off-device yoksa 3)
dump boyutu                  ->  0'dan büyük; mas_radar_dev için tipik olarak 3-8 MB
pg_restore --list satır sayısı -> yüzlerce TOC girdisi (0 DEĞİL)
makbuz dosyası               ->  <dump>.stage07.json  ya da  <dump>.receipt.json
koşu kaydı                   ->  backups/daily-runs.jsonl'e yeni satır
```

Yedek sonrası doğrulama (yalnız okuma) — kaynaktaki sayılar beklenen değerlerde mi:

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
```

**Beklenen:** `87`, `20`, `17`.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `pg_restore --list` hata veriyor / 0 girdi | **Dump bozuk** | Yedeği kullanmayın, yeniden alın. İkincisi de bozuksa **P0** |
| dump boyutu birkaç KB | Dump yarıda kesilmiş | Diskte yer var mı? `docs/ops/db-full.md` |
| `no space left on device` | Disk doldu | `docs/ops/db-full.md` |
| exit 3 | Off-device hedef yok | Diski takın / `MAS_OFFDEVICE_BACKUP_DIR` güncelleyin |
| `Hedef sınıfı: LOCAL_STANDIN` | Hedef aynı fiziksel diskte | Off-device sayılmaz; gerçek harici hedef bağlayın |
| `system_identifier` eşleşmiyor | Yanlış PostgreSQL kümesi | **DURUN** — `docs/ops/incident.md` |
| makbuz "git ağacı kirli" diyor | Kaydedilmemiş değişiklik var | Cutover yedeği için ağaç temiz olmalı; `git status` |
| `docker: command not found` | Docker açık değil | `docs/ops/docker-restart.md` |

---

## STOP CONDITION

1. Aynı kaynaktan alınan **iki** dump de `pg_restore --list` ile okunamıyorsa → **P0**, durun.
2. `system_identifier` beklenen kümeyle eşleşmiyorsa → yanlış makineye/kümeye bakıyorsunuz.
3. Satır sayıları beklenenden **düşükse** (örn. `payments` 20 değil) → yedek almaya devam
   etmeyin, önce `docs/ops/incident.md`.
4. Cutover öncesi yedekte `pnpm exec tsx scripts/release/stage07-backup-gate.ts` düşerse →
   **cutover başlamaz.**

---

## ROLLBACK

Yedek almanın geri alınacak bir tarafı yoktur — kaynağa yazmaz.

Yanlış/bozuk bir dump ürettiyseniz: dosyayı **silmeyin**, yanına neden geçersiz olduğunu yazan
bir not bırakın ve yeni bir yedek alın. Silme kararı yalnız saklama budamasıyla verilir
(`docs/ops/db-full.md`). `mas_radar_dev`, `cutover_*` ve `stage*_real` adlarını taşıyan yedekler
**IMMUTABLE**'dır ve budama bunlara asla dokunmaz.

---

## EVIDENCE

Her yedek için:

```text
tarih/saat        :
komut             : ops:backup:daily / backup-db.sh / backup-receipt.ts
dump yolu         :
boyut (bayt)      :
pg_restore --list :  ... TOC girdisi
off-device        : OK / YOK / LOCAL_STANDIN
exit kodu         :
```

Otomatik üretilen kayıtlar:

- `backups/daily-runs.jsonl` — her günlük koşu
- `<dump>.stage07.json` — dokuz alanlı makbuz
- `<dump>.offdevice.json` — hedefte doğrulanmış kopya kaydı
- `docs/release-evidence/final-production-readiness/05-real-backup-restore.md` — aylık kapı çıktısı

---

## SECRET HANDLING

- `pg_dump` çıktısı **gerçek finansal veri içerir**. `backups/` klasörü `.gitignore`'dadır ve
  asla commit edilmez, e-postayla gönderilmez, bulut sohbetine yüklenmez.
- Off-device hedef şirket dışındaysa (bulut/NAS) şifreleme ve erişim kaydı operatörün
  sorumluluğundadır.
- Komutlarda bağlantı dizesi geçmez; hedef yalnız `-U postgres -d mas_radar_dev` biçiminde
  adıyla verilir.
- `.env.local` okunurken kullanılan atama satırı değeri ekrana **yazmaz**.
- Makbuz dosyalarında parola yoktur: yalnız veritabanı adı, `system_identifier`, sha256, git
  bilgisi ve boyut bulunur — bunlar sır değildir.
