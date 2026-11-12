# RUNBOOK — failed migration (migration yarıda kaldı / reddedildi)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Cutover bağlamı:** [cutover.md](cutover.md) · **Kanıt toplama:** [incident.md](incident.md)

---

## PURPOSE

`pnpm db:migrate` başarısız olduğunda ne yapılacağını adım adım belirlemek.

### Önce iyi haber: "reddedildi" ile "yarıda kaldı" aynı şey değildir

Migration aracı kasıtlı olarak muhafazakârdır ve çoğu başarısızlık aslında güvenlik kilidinin çalışmasıdır:

| Durum | Ne oldu | Ciddiyet |
|---|---|---|
| **REDDEDİLDİ** | Hiçbir SQL çalışmadı; araç baştan durdu | Düşük — güvenli |
| **YARIDA KALDI** | Bir kısım migration uygulandı, sonra durdu | Yüksek — karar gerekir |
| **DOSYA SİSTEMİ BOZUK** | Migration dosyaları eksik/gizli (`OPS-01`) | Orta — geri dönüşü belli |

Aracın iki temel güvencesi:

1. Bekleyen migration varsa **önce yerel `pg_dump.exe` ile otomatik yedek alır** (`backups/migrate-<db>-<zaman>.dump`) ve o yedeğin `pg_restore.exe --list` ile okunabilirliğini doğrular.
2. Her koşu tek bir PostgreSQL **advisory lock** altında çalışır — iki migration aynı anda koşamaz.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Kanıt toplandı | [incident.md](incident.md) adım 1–10 |
| 2 | Uygulama **durdurulmuş** | [stop.md](stop.md) |
| 3 | Elde geçerli bir yedek var | `pnpm backup:offdevice:verify` ([backup.md](backup.md)) |
| 4 | `supabase/migrations/` bütün | aşağıdaki `OPS-01` kontrolü |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev  (ya da adı verilen harcanabilir klon)
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — şema değişir. Gerçek veritabanında YALNIZ bakım/cutover penceresinde.
```

---

## COMMANDS

### 0) Hangi arıza? — üç kontrol

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

# a) Migration dosyaları bütün mü? (OPS-01)
(Get-ChildItem supabase\migrations\*.sql).Count
(Get-ChildItem supabase\migrations\ | Where-Object { $_.Name -like "*hidden-for*" }).Count
git status --porcelain supabase/migrations/

# b) Veritabanı hangi sürümde? (yalnız okuma)
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

# c) Kod hangi sürümde?
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
```

Beklenen sağlıklı değerler: `*.sql` = **113**, `hidden-for` = **0**, `git status` **boş**, ledger = **113 / 0113**.

---

### ARIZA 1 — OPS-01: `git status` silinmiş migration dosyaları gösteriyor

**Belirti:** diskte `.sql` sayısı 113'ten az; `git status` silinmiş dosyalar gösteriyor; `db:migrate` ve CI düşüyor.

**Mekanizma:** `pnpm db:legacy-repair:verify` bazı senaryoları kurmak için migration dosyalarını geçici olarak `.hidden-for-legacy-repair-verify-<pid>-<epoch>` adına çevirir ve koşu sonunda geri alır. Süreç arada öldürülürse dosyalar gizli kalır.

#### YANLIŞ kurtarma — yapmayın

```bash
git checkout -- supabase/migrations/        # YAPMAYIN
```

Bu, dosyaları geri yaratır ama gizlenmiş kopyalar **yerinde kalır** ve takip edilmeyen artık dosyalar üretir.

#### DOĞRU kurtarma — eki sıyırın, yeniden yaratmayın

PowerShell ile:

```powershell
Get-ChildItem supabase\migrations\*hidden-for-legacy-repair-verify-* | ForEach-Object {
  $yeni = $_.Name -replace '\.hidden-for-legacy-repair-verify-.*$',''
  Rename-Item -Path $_.FullName -NewName $yeni
}
```

#### Sonra ÜÇ ŞEYİ birden kanıtlayın

```powershell
git status --porcelain supabase/migrations/                                                    # hiçbir şey yazmamalı
(Get-ChildItem supabase\migrations\*.sql).Count                                                # 113 olmalı
(Get-ChildItem supabase\migrations\ | Where-Object { $_.Name -like "*hidden-for*" }).Count     # 0 olmalı
pnpm exec vitest run tests/financial                                                           # ağaç hâlâ yükleniyor mu
```

#### En önemli kural

**`supabase/migrations/` kirliyken COMMIT ALMAYIN.**

---

### ARIZA 2 — checksum uyuşmuyor ("hiçbir yeni SQL çalıştırılmadı")

**Belirti:**

```text
LEDGER_MANAGED checksum doğrulaması başarısız, hiçbir yeni SQL çalıştırılmadı:
  00NN: checksum uyuşmuyor — ledger ..., disk ...
```

**Anlamı:** veritabanının kaydettiği migration içeriği ile diskteki dosya artık aynı değil. Hiçbir SQL çalışmadı; veritabanı olduğu gibi duruyor.

**Ne yapılır:**

1. Önce ARIZA 1 kontrolünü yapın.
2. Doğru kod sürümünde misiniz? (`git rev-parse HEAD`, `git status --porcelain`)
3. Hangi dosyanın değiştiği hata mesajında sürüm numarasıyla yazar. Dosya kasıtlı değiştirildiyse bu bir geliştirme kararıdır → **ESCALATE**.

**Ledger'daki checksum'ı elle GÜNCELLEMEYİN.**

---

### ARIZA 3 — kod ile şema eşleşmiyor

**Belirti:** `permission denied for table users`, `"column does not exist"`, giriş yapılamıyor.

**Teşhis:**

```powershell
git rev-parse HEAD
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

**Çözüm:** ikisini aynı kanonik sürüme (`0113`) getirin:

- Şema geride ise → bakım penceresinde `pnpm db:migrate` çalıştırın ([cutover.md](cutover.md)).
- Kod geride ise → çalışan sürümü hedef commit'e alın, `pnpm build`, `pnpm start`.

---

### ARIZA 4 — migration yarıda kaldı (bir kısmı uygulandı)

**Belirti:** rapor `pending uygulandı: 01NN` diyor ama sonra hata var; ledger sayısı `113`'e ulaşmamış.

**Ne yapılır:**

1. **Tekrar denemeyin** — önce durumu okuyun:
   ```powershell
   $u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
   $env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
   try {
     & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "SET default_transaction_read_only = on; select version, name, applied_by, applied_at from public.schema_migrations order by version desc limit 10;"
   } finally {
     Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
   }
   ```
2. Aracın koşu başında aldığı otomatik yedeği bulun ve doğrulayın:
   ```powershell
   Get-ChildItem backups\migrate-mas_radar_dev-*.dump | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, Length, LastWriteTime
   pnpm backup:offdevice:verify
   ```
3. Karar:
   - Hata geçiciyse (kilit, bağlantı kopması) → **RETRY**: uygulamayı durdurun, `pnpm db:migrate`.
   - Hata bir SQL hatasıysa → **ESCALATE**.
   - Veri bütünlüğü şüpheliyse → **DB RESTORE** ([restore.md](restore.md) + [cutover.md](cutover.md)).

---

## EXPECTED

Başarılı bir koşu şöyle biter:

```text
=== Migration raporu ===
db=mas_radar_dev user=postgres system_identifier=...
state=LEDGER_MANAGED
Değişiklik yok — DB zaten güncel.
```

Sonrasında:

```text
schema_migrations   ->  113 satır, en son 0113
pnpm db:roles:verify->  Hedef: db=mas_radar_dev user=mas_radar_app   +   8/8 kontrol geçti.
*.sql / hidden-for  ->  113 / 0
git status          ->  temiz
```

---

## FAILURE SIGNALS

| Mesaj / belirti | Anlamı | Nereye |
|---|---|---|
| `checksum uyuşmuyor` | Dosya ile ledger ayrışmış; **hiçbir SQL çalışmadı** | ARIZA 2 |
| `ledger'da var, diskte dosya yok` | Dosya eksik/gizlenmiş | ARIZA 1 → ARIZA 2 |
| `git status` silinmiş migration dosyası gösteriyor | `OPS-01` | ARIZA 1 |
| `permission denied for table users` | Kod/şema eşleşmezliği | ARIZA 3 |
| `MIGRATION BAŞARISIZ: <sql hatası>` | SQL düzeyinde hata | ARIZA 4 → ESCALATE |
| Komut yanıt vermiyor, asılı kalıyor | Advisory lock — başka bir koşu var | Diğer koşuyu bekleyin |

---

## STOP CONDITION

1. `supabase/migrations/` kirli ve `*hidden-for*` dosyalar varsa → **commit almayın**, önce ARIZA 1'i çözün.
2. Ledger'daki bir checksum'ı elle düzeltmek üzereyseniz → **durun**, ESCALATE.
3. Migration yarıda kaldı ve hata bir SQL hatasıysa → tekrar denemeyin, ESCALATE.
4. Elde geçerli yedek yoksa → hiçbir şey denemeyin; önce [backup.md](backup.md).

---

## ROLLBACK

| Adım | Ne zaman | Nasıl |
|---|---|---|
| **Dosya kurtarma** | `OPS-01` | ARIZA 1'deki ek sıyırma — veritabanına dokunulmaz |
| **Kod geri alma** | Kod/şema eşleşmezliği, şema doğru | Hedef commit'e geçin, `pnpm build`, `pnpm start` |
| **CONFIG ROLLBACK** | Şema sağlam, sorun ayarda | [cutover.md](cutover.md) → `"CONFIG ROLLBACK"` |
| **DB RESTORE** | Şema/veri bütünlüğü bozuk | [restore.md](restore.md) + [cutover.md](cutover.md) → `"DB RESTORE"` |

---

## EVIDENCE

```text
tarih/saat            :
arıza                 :  1 (OPS-01) / 2 (checksum) / 3 (kod-şema) / 4 (yarıda)
git HEAD / branch     :
*.sql / hidden-for    :  ... (113 / 0 bekleniyor)
ledger                :  113 / 0113
otomatik yedek        :  backups/migrate-...dump (boyut)
verilen karar         :  RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE
```

---

## SECRET HANDLING

- `.env.local` içeriği ve parolalar kanıt paketine girmez.
- Otomatik alınan `migrate-*.dump` dosyaları **gerçek finansal veri** içerir; `backups/` dışına paylaşılmaz.
