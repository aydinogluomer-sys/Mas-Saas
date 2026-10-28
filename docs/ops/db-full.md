# RUNBOOK — db full (disk doldu / veritabanı yer sıkıntısı)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Saklama politikası:** `docs/backup-restore-policy.md`

---

## PURPOSE

Disk dolduğunda ya da dolmaya yaklaştığında **veri kaybetmeden** yer açmak.

### Bu makinede durum bugün böyle (ölçüldü)

```text
C: sürücüsü      : 238 GB toplam, ~13 GB boş  (%95 dolu)
backups/         : 874 dosya, ~981 MB
docker images    : 19.8 GB (16.3 GB geri kazanılabilir)
docker volumes   : 2.5 GB (1.86 GB geri kazanılabilir)
PostgreSQL verisi: 20 veritabanı, toplam ~346 MB — mas_radar_dev bunun 21 MB'ı
```

**Okunması gereken sonuç:** darlık veritabanından değil, **etraftaki artıklardan** geliyor.
Yer açarken önce artıklara bakılır; veritabanına en son dokunulur.

### Yanıltıcı ölçüm — buna dikkat

Konteynerin içinden bakınca disk bol görünür:

```text
/var/lib/postgresql/data   ->  1007G toplam, 934G boş  (%3)
```

Bu **yanıltıcıdır**. O alan Docker'ın sanal diskidir ve o sanal disk **C: sürücüsünde** bir
dosya olarak büyür. Gerçek sınır C:'nin boş alanıdır. Kararı her zaman C:'ye bakarak verin.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Sorunun gerçekten disk olduğu ölçüldü | aşağıdaki 1. adım |
| 2 | Neyin silineceği **okundu** (kuru koşu) | `pnpm ops:backup:prune` |
| 3 | En az bir geçerli yedek elde | `docs/ops/backup.md` |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO — veritabanına yazılmaz; silinen şeyler DOSYALAR (eski dump'lar,
                  kullanılmayan docker imajları) ve HARCANABİLİR klon veritabanlarıdır.
```

---

## COMMANDS

### 1) Ölçün — nereden geliyor

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

Get-PSDrive C | Select-Object Used, Free
docker system df
(Get-ChildItem backups -File | Measure-Object Length -Sum).Sum / 1MB
(Get-ChildItem backups -File).Count
docker exec mas-radar-pg psql -U postgres -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database order by pg_database_size(datname) desc;"
```

### 2) Yer açma — güvenli sıra

Bu sıra bilinçlidir: en güvenliden en dikkat isteyene doğru.

#### Adım A — artık klon veritabanlarını düşürün (en güvenli, en çok kazandıran)

Doğrulama koşuları harcanabilir klonlar bırakır. `mas_radar_dev` **düşürülmez**; adı
`verify`, `clone`, `restore`, `drill`, `probe`, `test` gibi işaretler taşıyanlar
harcanabilirdir.

```powershell
# ÖNCE listeyi okuyun
docker exec mas-radar-pg psql -U postgres -c "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datname not in ('postgres','template0','template1','mas_radar_dev') order by pg_database_size(datname) desc;"

# Sonra TEK TEK düşürün — adı okuyarak
docker exec mas-radar-pg dropdb -U postgres mas_radar_perf_verify
```

> Her `dropdb` komutunu ayrı ayrı, adı gözünüzle okuyarak yazın. Toplu/otomatik silme yok.

#### Adım B — eski yedekleri budayın (politikayla)

Önce **ne silineceğini okuyun** — bu adım atlanmaz:

```powershell
pnpm ops:backup:prune
pnpm exec tsx scripts/ops/backup-prune.ts --verbose
```

Politika: **günlük 7 · haftalık 4 · aylık 3**, 24 saatten genç hiçbir dosyaya dokunulmaz.

**IMMUTABLE (hiçbir koşulda silinmez):** adında `mas_radar_dev` geçen dump'lar, `cutover_*`,
`stage<N>_real*` ve yanında `<dump>.immutable` işaret dosyası olanlar.

Okuduktan sonra uygulayın:

```powershell
pnpm exec tsx scripts/ops/backup-prune.ts --apply
```

Bir yedeği kalıcı korumak isterseniz:

```powershell
"2026 yil sonu kapanis" | Out-File -Encoding utf8 "backups\<dump-adi>.dump.immutable"
```

#### Adım C — kullanılmayan Docker imajlarını temizleyin

```powershell
docker image ls
docker image prune          # yalnız hiçbir konteynerin kullanmadığı "dangling" imajlar
```

> `docker system prune -a` **kullanmayın**: kullanımda olmayan ama başka projelerin ihtiyaç
> duyduğu imajları da siler ve o projeleri saatlerce yeniden indirmeye mahkûm eder.

#### Adım D — geçici derleme dizinleri

```powershell
Get-ChildItem -Directory -Filter ".next-*" | Select-Object Name, FullName
Remove-Item -Recurse -Force .next-restore-drill -ErrorAction SilentlyContinue
```

> Canlı sunucunun kullandığı `.next` dizinini **silmeyin** — uygulama düşer.

#### Adım E — PostgreSQL tarafında ölü alan (yalnız gerekiyorsa)

Bu adım nadiren gerekir ve **uygulama durdurulmuşken** yapılır (`docs/ops/stop.md`).

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "vacuum (verbose, analyze);"
```

`vacuum full` **bu runbook'ta yoktur**: tabloyu kilitler ve geçici olarak iki katı yer ister —
disk zaten doluyken tam ters etki yapar.

### 3) Tekrar ölçün

```powershell
Get-PSDrive C | Select-Object Used, Free
docker system df
```

---

## EXPECTED

```text
prune kuru koşu   ->  "Budanacak: n (x MB)" + "KURU KOŞU — hiçbir dosya silinmedi."
prune --apply     ->  aynı sayı kadar dosya silindi, IMMUTABLE sayısı DEĞİŞMEDİ
dropdb            ->  çıktı yok (sessiz başarı)
C: boş alan       ->  işlemden sonra ARTMIŞ olmalı
mas_radar_dev     ->  hâlâ listede, boyutu ~21 MB
ledger/payments/users -> 87 / 20 / 17  (DEĞİŞMEMİŞ olmalı)
```

Son doğrulama — veriye dokunulmadığının kanıtı:

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
```

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `could not extend file ... No space left on device` | PostgreSQL yazamıyor | Adım A + B'yi hemen uygulayın; uygulamayı durdurun |
| `PANIC: could not write to file` | Kritik | Uygulamayı durdurun, yer açın, `docs/ops/docker-restart.md` |
| Konteyner `Restarting` döngüsünde | Açılışta disk hatası | `docker logs --tail 100 mas-radar-pg` |
| `dropdb: database "..." is being accessed by other users` | Bağlantı var | Uygulamayı/gate'i durdurun, tekrar deneyin |
| `dropdb` `mas_radar_dev` için denendi | **YANLIŞ HEDEF** | **DURDURUN.** O veritabanı düşürülmez |
| prune "Budanacak: 0" ama disk hâlâ dolu | Yer başka yerde | `docker system df`, Adım C/D |
| `--apply` sonrası IMMUTABLE sayısı değişti | Beklenmedik | **DURUN** — `docs/ops/incident.md` |
| Windows "disk dolu" uyarısı sürüyor | C: darlığı Docker sanal diskinden | Docker Desktop → Settings → Resources; ya da Adım C |

---

## STOP CONDITION

1. `mas_radar_dev` üzerinde `dropdb` / `truncate` / `delete` düşünüyorsanız → **DURUN.**
   Bu runbook o işlemleri içermez ve içermeyecektir.
2. Geçerli bir yedeğiniz yokken silme yapacaksanız → önce `docs/ops/backup.md`.
3. `--apply` sonrası satır sayıları değiştiyse → **P0**, `docs/ops/incident.md`.
4. `docker system prune -a` yazmak üzereyseniz → yazmayın.

---

## ROLLBACK

**Silme geri alınamaz.** Koruma bu yüzden silme anına değil, öncesine konmuştur:

- Budama **varsayılan olarak kuru koşudur**; `--apply` olmadan hiçbir dosya silinmez.
- IMMUTABLE sınıfı hem planlama hem silme anında **iki kez** kontrol edilir.
- Harcanabilir klonlar tek tek, adı okunarak düşürülür.

Yanlışlıkla bir yedek silindiyse: off-device kopyaya bakın
(`MAS_OFFDEVICE_BACKUP_DIR`, `docs/ops/backup-schedule.md` §1). Orada da yoksa dosya gitmiştir;
**yeni bir yedek alın** (`docs/ops/backup.md`) ve olayı kaydedin.

Yanlışlıkla bir veritabanı düşürüldüyse: harcanabilir bir klonsa kaybı yoktur;
`mas_radar_dev` ise bu bir **P0 felaket kurtarma olayıdır** → `docs/ops/incident.md` +
`docs/ops/restore.md`.

---

## EVIDENCE

```text
tarih/saat            :
tetikleyen belirti    :
C: boş (önce)         :
docker system df (önce):
backups sayısı/boyut  :
uygulanan adımlar     :  A / B / C / D / E
düşürülen klonlar     :  (adları)
prune kuru koşu       :  budanacak n dosya, x MB
prune --apply         :  silinen n dosya
IMMUTABLE sayısı      :  önce ... sonra ...   (AYNI olmalı)
C: boş (sonra)        :
ledger/payments/users :  87 / 20 / 17
```

---

## SECRET HANDLING

- Dump dosyaları **gerçek finansal veri** içerir. Yer açmak için bir yedeği "geçici olarak"
  başka bir yere kopyalıyorsanız o hedef de korunmalıdır — masaüstüne, `Downloads`'a ya da
  paylaşılan bir klasöre çıkarmayın.
- Silinen dosya adları sır değildir; kanıt paketine yazılabilir.
- `docker system df` ve `Get-PSDrive` çıktıları sır içermez.
- Bu runbook'ta parola ya da bağlantı dizesi geçmez.
