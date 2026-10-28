# RUNBOOK — failed migration (migration yarıda kaldı / reddedildi)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Cutover bağlamı:** `docs/ops/cutover.md` · **Kanıt toplama:** `docs/ops/incident.md`

---

## PURPOSE

`pnpm db:migrate` başarısız olduğunda ne yapılacağını söylemek.

### Önce iyi haber: "reddedildi" ile "yarıda kaldı" aynı şey değildir

Migration aracı **kasıtlı olarak korkak**tır ve çoğu başarısızlık aslında korumanın çalışmasıdır:

| Durum | Ne oldu | Ciddiyet |
|---|---|---|
| **REDDEDİLDİ** | Hiçbir SQL çalışmadı; araç baştan durdu | Düşük — güvenli |
| **YARIDA KALDI** | Bir kısım migration uygulandı, sonra durdu | Yüksek — karar gerekir |
| **DOSYA SİSTEMİ BOZUK** | Migration dosyaları eksik/gizli (OPS-01) | Orta — geri dönüşü belli |

Aracın iki temel güvencesi:

1. Bekleyen migration varsa **önce otomatik yedek alır** (`backups/migrate-<db>-<zaman>.dump`)
   ve o yedeğin okunabilirliğini doğrular.
2. Her koşu tek bir **advisory lock** altında çalışır — iki migration aynı anda koşamaz.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Kanıt toplandı | `docs/ops/incident.md` adım 1–10 |
| 2 | Uygulama **durdurulmuş** | `docs/ops/stop.md` |
| 3 | Elde geçerli bir yedek var | `docs/ops/backup.md` |
| 4 | `supabase/migrations/` bütün | aşağıdaki OPS-01 kontrolü |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev  (ya da adı verilen harcanabilir klon)
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — şema değişir. Gerçek veritabanında YALNIZ cutover penceresinde.
```

**Cutover penceresi dışında `mas_radar_dev` üzerinde migration çalıştırılmaz.** Deneme yapmak
istiyorsanız harcanabilir bir klon üzerinde yapın (adında `clone`/`verify`/`drill` geçmeli).

---

## COMMANDS

### 0) Hangi arıza? — üç kontrol

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

# a) Migration dosyaları bütün mü? (OPS-01)
(Get-ChildItem supabase\migrations\*.sql).Count
(Get-ChildItem supabase\migrations\ | Where-Object { $_.Name -like "*hidden-for*" }).Count
git status --porcelain supabase/migrations/

# b) Veritabanı hangi sürümde?
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*), max(version) from public.schema_migrations;"

# c) Kod hangi sürümde?
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
```

Beklenen sağlıklı değerler: `*.sql` = **87**, `hidden-for` = **0**, `git status` **boş**,
ledger = **87 / 0087**.

---

### ARIZA 1 — OPS-01: `git status` 58 SİLİNMİŞ dosya gösteriyor

**Belirti:** diskte 29 `.sql` var, git'te 87; `git status` 58 silinmiş dosya diyor; `db:migrate`
ve CI düşüyor.

**Mekanizma:** `pnpm db:legacy-repair:verify` bazı senaryoları kurmak için migration
dosyalarını geçici olarak yeniden adlandırır:

```text
0087_assistant_conversations.sql
  -> 0087_assistant_conversations.sql.hidden-for-legacy-repair-verify-<pid>-<epoch>
```

ve koşu sonunda geri alır. Süreç bu iki adım **arasında** öldürülürse (Ctrl-C, zaman aşımı,
çöküş) dosyalar gizli kalır.

#### YANLIŞ kurtarma — yapmayın

```bash
git checkout -- supabase/migrations/        # YAPMAYIN
```

Bu 87 dosyayı geri yaratır ama gizlenmiş kopyalar **yerinde kalır**: 87 gerçek + 58 takip
edilmeyen artık. Sonuç, bir sonraki okuyucuyu "fazladan migration var" diye yanlış teşhise
sürükler.

#### DOĞRU kurtarma — eki sıyırın, yeniden yaratmayın

Git Bash ile:

```bash
cd supabase/migrations
for f in *.hidden-for-legacy-repair-verify-*; do
  mv -- "$f" "${f%%.hidden-for-legacy-repair-verify-*}"
done
```

PowerShell ile:

```powershell
Get-ChildItem supabase\migrations\*hidden-for-legacy-repair-verify-* | ForEach-Object {
  $yeni = $_.Name -replace '\.hidden-for-legacy-repair-verify-.*$',''
  Rename-Item -Path $_.FullName -NewName $yeni
}
```

#### Sonra ÜÇ ŞEYİ birden kanıtlayın

```powershell
git status --porcelain supabase/migrations/            # hiçbir şey yazmamalı
(Get-ChildItem supabase\migrations\*.sql).Count        # 87 olmalı
(Get-ChildItem supabase\migrations\ | Where-Object { $_.Name -like "*hidden-for*" }).Count  # 0 olmalı
pnpm exec vitest run tests/financial                   # ağaç hâlâ yükleniyor mu
```

#### En önemli kural

**`supabase/migrations/` kirliyken COMMIT ALMAYIN.** Bu pencerede alınan bir commit 58
migration'ı dalın kendisinden siler; fark edilene kadar geçen her commit geri almayı zorlaştırır.

---

### ARIZA 2 — checksum uyuşmuyor ("hiçbir yeni SQL çalıştırılmadı")

**Belirti:**

```text
LEDGER_MANAGED checksum doğrulaması başarısız, hiçbir yeni SQL çalıştırılmadı:
  00NN: checksum uyuşmuyor — ledger ..., disk ...
```

ya da

```text
00NN: ledger'da var, diskte dosya yok (...)
```

**Anlamı:** veritabanının kaydettiği migration içeriği ile diskteki dosya **artık aynı değil**.
Bu, uygulanmış bir migration dosyasının sonradan düzenlendiği anlamına gelir.

**İyi haber:** hiçbir SQL çalışmadı. Veritabanı olduğu gibi duruyor.

**Ne yapılır:**

1. Önce ARIZA 1 kontrolünü yapın — gizlenmiş dosyalar bu hatayı da üretir.
2. Doğru kod sürümünde misiniz?
   ```powershell
   git rev-parse HEAD
   git status --porcelain
   ```
   Yerel, kaydedilmemiş bir düzenleme varsa kaynağı budur.
3. Hangi dosyanın değiştiği hata mesajında **sürüm numarasıyla** yazar. O dosya
   kasıtlı olarak değiştirildiyse bu bir geliştirme kararıdır ve operatör tarafından
   çözülmez → **ESCALATE**.

**Bu hatayı "çözmek" için ledger'daki checksum'ı elle GÜNCELLEMEYİN.** O kayıt, veritabanının
gerçekten ne çalıştırdığının tek kanıtıdır.

---

### ARIZA 3 — kod ile şema eşleşmiyor

**Belirti:** `permission denied for table users`, "column does not exist", giriş yapılamıyor,
ekranlar boş.

**Kural — ikisi de desteklenmez:**

```text
YENİ kod + ESKİ şema   ->  desteklenmiyor
ESKİ kod + YENİ şema   ->  desteklenmiyor
```

Bu yüzden cutover sırasında **C2 adımı** (kod sürümünü hedef commit'e geçirme) vardır ve **D
adımından (migration) hemen önce** durur. Sıra bozulursa tam bu belirti çıkar.

**Teşhis:**

```powershell
git rev-parse HEAD
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*), max(version) from public.schema_migrations;"
```

**Çözüm:** ikisini aynı sürüme getirin.

- Şema geride ise → cutover penceresinde migration'ı tamamlayın (`docs/ops/cutover.md`).
- Kod geride ise → çalışan sürümü hedef commit'e alın, `pnpm build`, `pnpm start`.
- Hangisinin doğru olduğu belirsizse → **ESCALATE**. Tahminle biri seçilmez.

---

### ARIZA 4 — migration yarıda kaldı (bir kısmı uygulandı)

**Belirti:** rapor `pending uygulandı: 00NN, 00NN+1` diyor ama sonra hata var; ledger sayısı
87'ye ulaşmamış.

**Ne yapılır:**

1. **Tekrar denemeyin** — önce durumu okuyun:
   ```powershell
   docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "select version, name, applied_by, applied_at from public.schema_migrations order by version desc limit 10;"
   ```
2. Aracın koşu başında aldığı otomatik yedeği bulun:
   ```powershell
   Get-ChildItem backups\migrate-mas_radar_dev-*.dump | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, Length, LastWriteTime
   ```
3. Karar:
   - Hata geçiciyse (kilit, bağlantı kopması) → **RETRY**: uygulamayı durdurun, `pnpm db:migrate`.
   - Hata bir SQL hatasıysa → **ESCALATE**. Migration içeriği düzeltilmeden tekrar denemek
     durumu kötüleştirir.
   - Veri bütünlüğü şüpheliyse → **DB RESTORE** (`docs/ops/restore.md` + `docs/ops/cutover.md`).

---

## EXPECTED

Başarılı bir koşu şöyle biter:

```text
=== Migration raporu ===
db=mas_radar_dev user=postgres system_identifier=...
state=LEDGER_MANAGED
Değişiklik yok — DB zaten güncel.
```

ya da bekleyen varsa:

```text
pending uygulandı: 00NN, ...
yedek: backups/migrate-mas_radar_dev-....dump (n bayt, system_identifier=...)
```

Sonrasında:

```text
schema_migrations   ->  87 satır, en son 0087
pnpm db:roles:verify->  Hedef: db=mas_radar_dev user=mas_radar_app   +   8/8 kontrol geçti.
*.sql / hidden-for  ->  87 / 0
git status          ->  temiz
```

---

## FAILURE SIGNALS

| Mesaj / belirti | Anlamı | Nereye |
|---|---|---|
| `checksum uyuşmuyor` | Dosya ile ledger ayrışmış; **hiçbir SQL çalışmadı** | ARIZA 2 |
| `ledger'da var, diskte dosya yok` | Dosya eksik/gizlenmiş | ARIZA 1 → ARIZA 2 |
| `Manifest doğrulaması başarısız (0001-0019 ...)` | Eski temel dosyalar değişmiş | **ESCALATE** |
| `git status` 58 silinmiş dosya | OPS-01 | ARIZA 1 |
| `permission denied for table users` | Kod/şema eşleşmezliği | ARIZA 3 |
| `MIGRATION BAŞARISIZ: <sql hatası>` | SQL düzeyinde hata | ARIZA 4 → ESCALATE |
| Komut yanıt vermiyor, asılı kalıyor | Advisory lock — başka bir koşu var | Diğer koşuyu bekleyin; ikinci pencere açmayın |
| `DATABASE_URL tanımlı değil` | `tsx` `.env.local` okumaz | `docs/ops/incident.md` adım 4/6 |
| Kapı yeşil ama sayılar tuhaf | **Yanlış veritabanı** olabilir | `pnpm db:roles:verify` ilk satırı |

---

## STOP CONDITION

1. `supabase/migrations/` kirli ve `*hidden-for*` dosyalar varsa → **commit almayın**, önce
   ARIZA 1'i çözün.
2. Ledger'daki bir checksum'ı elle düzeltmek üzereyseniz → **durun**, ESCALATE.
3. Migration yarıda kaldı ve hata bir SQL hatasıysa → tekrar denemeyin, ESCALATE.
4. Gerçek veritabanında cutover penceresi **dışında** migration çalıştırmak üzereyseniz →
   durun.
5. Elde geçerli yedek yoksa → hiçbir şey denemeyin; önce `docs/ops/backup.md`.

---

## ROLLBACK

Sırasıyla, en ucuzdan en pahalıya:

| Adım | Ne zaman | Nasıl |
|---|---|---|
| **Dosya kurtarma** | OPS-01 | ARIZA 1'deki ek sıyırma — veritabanına dokunulmaz |
| **Kod geri alma** | Kod/şema eşleşmezliği, şema doğru | Hedef commit'e geçin, `pnpm build`, `pnpm start` |
| **CONFIG ROLLBACK** | Şema sağlam, sorun ayarda | `docs/ops/cutover.md` → "CONFIG ROLLBACK" |
| **DB RESTORE** | Şema/veri bütünlüğü bozuk | `docs/ops/restore.md` + `docs/ops/cutover.md` → "DB RESTORE" |

**Migration'ları "geri alan" bir komut yoktur.** Şema geri dönüşü yalnız yedekten geri
yüklemeyle olur. Bu yüzden araç bekleyen migration'lardan önce otomatik yedek alır ve o
yedeğin okunabilirliğini doğrular.

---

## EVIDENCE

```text
tarih/saat            :
arıza                 :  1 (OPS-01) / 2 (checksum) / 3 (kod-şema) / 4 (yarıda)
git HEAD / branch     :
git status (migrations):
*.sql sayısı          :  ... (87 bekleniyor)
hidden-for sayısı     :  ... (0 bekleniyor)
ledger                :  n / max(version)
tam hata metni        :  (kopyala)
otomatik yedek        :  backups/migrate-...dump  (boyut)
uygulanan kurtarma    :
kurtarma sonrası kanıt:  git status temiz / 87 / 0 / vitest tests/financial
verilen karar         :  RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE
```

Olayı `docs/ops/incident-recovery-notes.md` altına da işleyin.

---

## SECRET HANDLING

- Hata metinlerinde bağlantı dizesi **geçmez**; araç hedefi yalnız `db=<ad> user=<ad>` olarak
  yazar. Yine de yapıştırmadan önce okuyun.
- `.env.local` içeriği kanıt paketine girmez.
- Otomatik alınan `migrate-*.dump` dosyaları **gerçek finansal veri** içerir; `backups/`
  dışına çıkarılmaz, paylaşılmaz.
- Migration SQL dosyalarında parola yoktur ve olmayacaktır — kimlik bilgisi bir migration'a
  yazılmaz, bu yüzden rol parolası ayrı bir araçla verilir
  (`docs/ops/password-rotation.md`).
