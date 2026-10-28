# RUNBOOK — restore (yedekten geri yükle)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Politika:** `docs/backup-restore-policy.md` · **Yedek alma:** `docs/ops/backup.md`

---

## PURPOSE

Bir dump dosyasını **harcanabilir (disposable) bir hedefe** geri yükleyip verinin gerçekten
kurtarılabilir olduğunu kanıtlamak.

Bu runbook'un kapsadığı tek senaryo budur. **Gerçek veritabanının üzerine geri yükleme
(`mas_radar_dev`) bu runbook'ta YOKTUR.** O işlem bir felaket kurtarma kararıdır, ayrı bir
onay gerektirir ve `docs/ops/cutover.md` → "DB RESTORE" kararı üzerinden yürütülür.

İki kullanım vardır:

| Amaç | Sıklık | Yol |
|---|---|---|
| "Yedeğim geri yükleniyor mu?" tatbikatı | **Ayda bir** | Yol A (tam kapı) |
| "Şu eski kayda bakmam lazım" | İhtiyaç oldukça | Yol B (elle restore) |

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | PostgreSQL ayakta | `docker exec mas-radar-pg pg_isready -U postgres` |
| 2 | Geri yüklenecek dump dosyası var ve **okunabilir** | `docs/ops/backup.md` → "okunabilirliği kanıtlayın" |
| 3 | Hedef adı **harcanabilir** bir ad | aşağıdaki adlandırma kuralı |
| 4 | Diskte yer var | `docker exec mas-radar-pg psql -U postgres -t -A -c "select pg_size_pretty(sum(pg_database_size(datname))) from pg_database;"` |
| 5 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` |

### Hedef adlandırma kuralı — atlanamaz

Araçlar, hedefin **adında** harcanabilir olduğunu söylemesini şart koşar. Kabul edilen
işaretlerden en az biri geçmelidir:

```text
verify  test  tmp  temp  disposable  scratch  sandbox
fixture clone restore snapshot probe drill
```

Şu adlar **korunmuştur ve hiçbir koşulda hedef olarak verilemez:**

```text
mas_radar_dev   postgres   template0   template1
```

Önerilen ad kalıbı:

```text
mas_radar_restore_20260826
```

---

## DATA CLASS

```text
KAYNAK  DB NAME  : mas_radar_dev (yalnız dump dosyası üzerinden)
KAYNAK  DB CLASS : REAL_READ_ONLY
HEDEF   DB NAME  : mas_radar_restore_<tarih>
HEDEF   DB CLASS : DISPOSABLE_CLONE
WRITE EXPECTED?  : YES — YALNIZ harcanabilir hedefe. Gerçek veritabanına HAYIR.
```

---

## COMMANDS

### Yol A — tam tatbikat (yedek → restore → karşılaştırma → uygulama açılışı)

Bu kapı "geri yüklendi" demekle yetinmez: satır sayılarını ve parasal toplamları kaynakla
karşılaştırır, sonra uygulamayı geri yüklenen kopyaya karşı gerçekten başlatır.

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

$env:SOURCE_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
$env:RESTORE_DB = "mas_radar_restore_drill"
$env:SMOKE_PORT = "3290"
$env:MAS_NEXT_DIST_DIR = ".next-restore-drill"

pnpm release:restore-drill
```

**Neden `SMOKE_PORT` ve `MAS_NEXT_DIST_DIR` veriliyor:** canlı sunucu port 3000'i ve `.next`
dizinini kullanıyor. Bu iki değişken olmadan tatbikat canlı derlemeyi ezebilir. Tatbikat dolu
bir portta **durur**, kimsenin sürecini öldürmez.

### Yol B — tek bir dump'ı elle geri yükle (Git Bash gerektirir)

```bash
bash scripts/deploy/restore-db.sh backups/<dump-adi>.dump mas_radar_restore_20260826
```

Betik var olan bir veritabanının üzerine yazmayı **reddeder** (`FORCE=1` verilmedikçe).
`FORCE=1` kullanmayın — bunun yerine yeni bir ad seçin.

### Geri yüklenen kopyayı doğrulayın (kaynakla karşılaştırma)

```powershell
# HEDEF
docker exec mas-radar-pg psql -U postgres -d mas_radar_restore_20260826 -t -A -c "select count(*) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"

# KAYNAK (yalnız okuma)
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
```

### Uygulamayı geri yüklenen kopyaya karşı açmak (isteğe bağlı, canlıyı bozmadan)

```powershell
# ÖNCE canlı sunucu durdurulmalı ya da AYRI bir port + AYRI derleme dizini kullanılmalı.
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','') -replace 'mas_radar_dev','mas_radar_restore_20260826'
$env:PORT = "3290"
$env:MAS_NEXT_DIST_DIR = ".next-restore-drill"
pnpm start
```

Bu satır `.env.local`'deki gerçek kimliği alır ve **yalnız veritabanı adını** değiştirir; parola
hiçbir yerde görünmez ve değiştirilmez.

### Tatbikattan sonra temizlik — hedefi düşürün

```powershell
docker exec mas-radar-pg dropdb -U postgres mas_radar_restore_20260826
docker exec mas-radar-pg psql -U postgres -t -A -c "select datname from pg_database order by datname;"
```

Bu makinede yer darlığı var; artakalan klonlar diski doldurur (`docs/ops/db-full.md`).

---

## EXPECTED

```text
restore-db.sh             ->  "Restore complete." (exit 0)
pnpm release:restore-drill->  BACKUP EXISTS / READABLE / RESTORABLE / DATA MATCHES / APP STARTS
                              beşi de YES; exit 0
hedef sayıları            ->  schema_migrations 87 · payments 20 · users 17
                              (kaynakla BİREBİR aynı olmalı)
/health (3290 portunda)   ->  {"status":"ok","app":"up","db":"up",...}
```

> **Zamanlama tuzağı:** uygulama açılışı `prepare-runtime` üzerinden hedefe **yazar**. Bu
> yüzden sayı karşılaştırması uygulama başlatılmadan **ÖNCE** yapılır. Tersi sırada
> "restore veriyi bozdu" gibi görünen fark aslında uygulamanın kendi yazdığı satırlardır.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `GÜVENLİK DURDURMASI: '<ad>' korunan bir veritabanı` | Hedef olarak gerçek DB verildi | **Doğru davranış.** Harcanabilir bir ad seçin |
| `'<ad>' disposable işaretlerinden hiçbirini taşımıyor` | Ad kuralı sağlanmadı | Adın içine `restore`/`clone`/`drill` ekleyin |
| `target DB '<ad>' already exists` | Aynı adla eski bir kopya var | Yeni bir ad seçin (`FORCE=1` kullanmayın) |
| `pg_restore: error: could not read from input file` | **Dump bozuk** | Başka bir yedeği deneyin; hepsi bozuksa **P0** |
| Satır sayıları kaynaktan **az** | Restore eksik | **P0** — `docs/ops/incident.md` |
| `permission denied for table users` | GRANT'lar geri gelmedi | Roller küme genelindedir ve dump'ın içinde **yoktur**; aynı kümeye geri yüklüyorsanız zaten dururlar. Başka bir kümeye taşıdıysanız bu beklenen bir eksiktir — `docs/ops/incident.md` |
| Port doluluk uyarısı | 3290 kullanımda | Başka bir port verin (3291, 3292…) |
| `no space left on device` | Disk doldu | `docs/ops/db-full.md` |

---

## STOP CONDITION

1. Hedef adı harcanabilir değilse — araç zaten durur, **zorlamayın**.
2. Elinizdeki **son iki** yedek de geri yüklenemiyorsa → **P0**, hemen `docs/ops/incident.md`.
3. Geri yüklenen kopyanın satır sayıları kaynaktan **düşükse** → tatbikatı sonlandırın ve
   olayı kaydedin; bu, yedeklerin güvenilmez olduğu anlamına gelir.
4. `mas_radar_dev` üzerine geri yükleme düşünüyorsanız → **DURUN.** Bu karar bu runbook'ta
   verilmez; `docs/ops/cutover.md` → "DB RESTORE" kararı.

---

## ROLLBACK

Bu runbook gerçek veritabanına dokunmadığı için "geri alma" yalnız temizliktir:

```powershell
docker exec mas-radar-pg dropdb -U postgres <harcanabilir-hedef-adı>
Remove-Item -Recurse -Force .next-restore-drill -ErrorAction SilentlyContinue
```

Ayrı portta açtığınız sunucuyu kapatın (`docs/ops/stop.md` — port numarasını 3290 olarak okuyun).

---

## EVIDENCE

```text
tarih/saat            :
kullanılan dump       :
hedef veritabanı      :  (harcanabilir ad)
BACKUP EXISTS         :
BACKUP READABLE       :
BACKUP RESTORABLE     :
DATA MATCHES          :  kaynak 87/20/17  hedef ...
APP STARTS            :
exit kodu             :
hedef düşürüldü mü    :  EVET/HAYIR
```

Otomatik üretilen kanıt:

- `docs/release-evidence/final-production-readiness/05-real-backup-restore.md`
- `docs/release-evidence/faz6-restore-drill.md`

---

## SECRET HANDLING

- Dump dosyası **gerçek finansal veri içerir**. Geri yüklenen kopya da öyledir — tatbikat
  bittiğinde hedefi düşürün, ortada bırakmayın.
- Hiçbir komutta bağlantı dizesi elle yazılmaz; kimlik `.env.local`'den okunur ve **yalnız
  veritabanı adı** değiştirilir.
- `pnpm db:app-role:password` bu runbook'ta **yoktur ve çağrılmaz**: roller küme genelindedir,
  o komut canlı uygulamanın parolasını da geçersiz kılar (bkz. `docs/ops/password-rotation.md`).
- Ekran görüntüsü paylaşırken satır sayıları sorun değildir; bağlantı dizesi görünen bir kare
  paylaşılmaz.
