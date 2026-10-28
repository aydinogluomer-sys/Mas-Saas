# 09 — Tarama kapsamı

**Neden bu dosya var.** İlk tarama `grep -rlE "insert into|update …"` idi. 133 dosya buldu ve
**`scripts/perf/measure.ts`'i kaçırdı** — depodaki tek gerçek güvensiz yazıcıyı. Sebep basit:
o dosya hiç SQL içermez, yazmayı `generateVolume()` çağırarak yapar. SQL literali içeren
dosyaları saymak bir writer surface değildir; SQL literali içeren dosyaların listesidir.

Bu yüzden tarama yedi bağımsız yetenek sınıfı üzerinden yürütüldü ve sayılar aşağıda.
Üretim: `node --import tsx scripts/qa/writer-surface-manifest.ts` + `09-scan-coverage.json`.

## Alanlar

| alan | dosya |
|---|---|
| `scripts/**` | 128 |
| `src/**` | 337 |
| `tests/**` | 53 |
| `.github/workflows/**` | 1 |
| **toplam taranan** | **519** |

Uzantılar: `.ts .tsx .js .mjs .sh .yml .yaml`.
Hariç: `node_modules`, `.next*`, `.venv`, `__snapshots__`, `.git`.

## Yedi tarama sınıfı ve eşleşen dosya sayıları

| # | sınıf | eşleşen |
|---|---|---|
| 1 | SQL token: `INSERT UPDATE DELETE TRUNCATE ALTER CREATE DROP COPY VACUUM` | 144 |
| 2 | Postgres/süreç: `Pool` `Client` `psql` `createdb` `dropdb` `pg_restore` `pg_dump` | 105 |
| 3 | child process: `exec` `execFile` `spawn` `fork` | 34 |
| 4 | dolaylı yazıcı fonksiyonlar: `seed* ensure* fixture* generate* archive* cancel* mark* refresh* reconcile* import* enqueue* prepare* migrate* restore* dropVolume` | 89 |
| 5 | uygulama pool/env grafiği: `getPool` `getRawPool` `@/lib/db` `@/lib/env` | 126 |
| 6 | ağ mutasyonu: `fetch` + `POST/PUT/PATCH/DELETE` | 5 |
| 7 | dynamic `import()` | 25 |

## Yaşam döngüsü kapsamı

| aranan | sonuç |
|---|---|
| `package.json` script sayısı | 105 |
| `pre*` / `post*` npm lifecycle hook | **0** |
| CI workflow dosyası | 1 (`.github/workflows/ci.yml`) |
| Windows Task Scheduler eşleşmesi | 0 |
| watcher / cron / scheduler | 0 |

`dev` / `start` zincirleri ayrıca elle incelendi: ikisi de `scripts/prebuild`-benzeri bir hook
üzerinden değil, doğrudan `&&` zinciriyle `scripts/prepare-runtime.ts` çalıştırır
(bkz. `08-amplifier-provenance.md`).

## Yakalamanın filtrelenmesi

Bir dosyanın manifest'e girmesi için hem **veritabanına ulaşabilmesi** hem de **mutasyon
yapabilmesi** gerekir. İki ayrım dört dosyanın kaderini belirledi:

- `pg_dump` **okur**; dosya üretir, satır değiştirmez.
- `pg_restore --list` bir arşivin içindekiler tablosunu **yazdırır**; yalnız `pg_restore -d` yükler.

Bu nedenle `scripts/db/backup-docker-postgres.ts` (yalnız `--list` kullanır) ve
`scripts/ops/{backup-lib,offdevice-copy}.ts` (yalnız dosya taşır) writer sayılmaz.
Buna karşılık `scripts/deploy/restore-db.sh` (`pg_restore -d`) sayılır.

Ayrıca yorum satırları sınıf tespitinden önce ayıklanır — bu depodaki script'ler kaçındıkları
yıkıcı fiilleri uzun başlıklarda adlandırır. `scripts/phase18-verify.ts` bu yüzden yazıcı
**değildir**: `TRUNCATE` yalnız 6. satırdaki yorumda geçer ve dosya hiç `pg` istemcisi açmaz.

## Sonuç

```
taranan dosya      519
writer adayı       100
UNKNOWN              0
```

`UNKNOWN = 0` bir varsayılana yaslanarak değil, **catch-all kuralı kaldırılarak** elde edildi.
Üretecin ilk sürümü `else -> SAFE_DISPOSABLE_ENFORCED` ile bitiyordu ve kimsenin bakmadığı
24 dosyayı — `src/app` altındaki her server action dâhil — sessizce güvenli ilan ediyordu.
Şimdi sınıflandırılamayan dosya `UNKNOWN`'a düşer ve script `exit 1` verir.
