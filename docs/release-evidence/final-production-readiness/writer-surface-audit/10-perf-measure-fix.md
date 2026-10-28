# 10 — P0 düzeltmesi: `perf:measure --seed`

## Kusur

`scripts/perf/measure.ts`, düzeltmeden önce:

```ts
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
const pool = new Pool({ connectionString: url });

async function main() {
  if (process.argv.includes("--seed")) {
    await generateVolume(pool);
  }
```

Hedef doğrudan env'den okunuyordu — `ownerDatabaseUrl()` üzerinden bile değil — ve **hiçbir
disposable kontrolü yoktu**.

`generateVolume` dokuz tabloya INSERT eder:
`parties · invoices · cash_accounts · bank_accounts · bank_transactions · payments ·
payment_instances · checks · audit_logs`.

## Neden teorik değil

- `.env.local` **her iki** URL'yi `mas_radar_dev`'e (gerçek DB) işaret ettirir.
- PSReadLine geçmişi, operatörün bu değişkenleri rutin olarak kabuğa yüklediğini gösteriyor
  (`07-invocation-path.md`, satır 614-618 ve 623-627).
- `perf:measure` `package.json`'da kayıtlı bir komuttur (satır 84).

Bu ortamda `pnpm perf:measure --seed`, gerçek finans veritabanına sentetik hacim yazardı.
Ölçülen büyüklük (disposable klonda, aynı komutla): **20.040 `payment_instances`,
60.000 `bank_transactions`, 41.029 `audit_logs`, 24.000 `invoices`, 6.000 `checks`.**

Bu, `9844dd3`'te düzeltilen `roles-rls-verify` kusuruyla **aynı sınıftır** ve ilk taramada
gözden kaçmıştır: dosya **hiç SQL içermez**, yazmayı başka bir modülü çağırarak yapar.

## Düzeltme

```ts
const SEEDING = process.argv.includes("--seed");

const url = SEEDING ? requireDisposableOwnerDatabaseUrl("perf:measure --seed") : ownerDatabaseUrl();
if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }

const pool = new Pool({
  connectionString: url,
  ...(SEEDING ? {} : { options: "-c default_transaction_read_only=on" }),
});
```

### Davranış kararının gerekçesi

**Kapı neden `--seed` üzerinde, tüm script üzerinde değil?**

`--seed` olmadan bu dosya yalnız `select count(*)` ve `select * from <view>` çalıştırır: okur.
Read model'leri **gerçek veri şekli** üzerinde ölçmek, bir performans incelemesinde bu araca
başvurmanın meşru sebebidir. Tüm script'i disposable-only yapmak bu yeteneği silerdi ve
operatörü elle `psql`'e iterdi — kesinlikle daha kötü. Kapı bu yüzden tam olarak yıkıcı
yeteneğin üzerinde durur; `owner-url.ts`'in `migrate.ts` için zaten yaptığı ayrımın aynısı.

**İki ek sertleştirme:**

1. Kapı, `new Pool` **yaratılmadan önce** çalışır. Bağlantı açıldıktan sonra kontrol eden bir
   kapı, sonraki bir düzenlemenin araya yazma sokmasına izin verir.
2. `--seed` yokken bağlantı `default_transaction_read_only=on` ile açılır; ölçüm modu artık
   niyetle değil **motorla** salt-okunurdur.

## Doğrulama

### Negatif — gerçek hedef reddedilir

```
$ MIGRATION_DATABASE_URL=…/mas_radar_dev  node --import tsx scripts/perf/measure.ts --seed
GÜVENLİK DURDURMASI (perf:measure --seed): 'mas_radar_dev' korunan bir veritabanı — …
EXIT=1
```

`DATABASE_URL` fallback yolu üzerinden de aynı sonuç (EXIT=1). Kapı `Pool`'dan önce çalıştığı
için **hiçbir bağlantı açılmaz**; gerçek veritabanında tek bir INSERT denemesi bile olmaz.

### Pozitif — disposable hedef geçer

Aynı kimlik bilgileri, yalnız veritabanı adı farklı:

```
$ MIGRATION_DATABASE_URL=…/mas_radar_perf_verify  node --import tsx scripts/perf/measure.ts --seed
hacim yükleniyor…
yüklendi.
VERİ HACMİ: audit_logs=41029 · bank_transactions=60000 · checks=6000 · invoices=24000 · payment_instances=20040
```

### Kontrol — aynı kimlik, gerçek hedef

```
$ MIGRATION_DATABASE_URL=…/mas_radar_dev  node --import tsx scripts/perf/measure.ts --seed
GÜVENLİK DURDURMASI (perf:measure --seed): 'mas_radar_dev' korunan bir veritabanı — …
```

Tek değişken veritabanı adıdır: biri 150.000'den fazla satır yazar, diğeri sıfır yazar.

## Regresyon koruması

`tests/writer-surface.test.ts` — pozisyonel iddialar (metinsel değil):

- kapı satırı < `new Pool` satırı
- kapı satırı < `generateVolume(` satırı
- `--seed` yokken `default_transaction_read_only=on` mevcut
- alt süreç negatif kontrolü: gerçek DB adı → exit 1 + `GÜVENLİK DURDURMASI`
- **her** `generateVolume`/`dropVolume` caller'ı için kapı çağrıdan önce

## Tüm caller'lar

| caller | kapı satırı | çağrı satırı | sonuç |
|---|---|---|---|
| `scripts/perf/measure.ts` | 8 | 47 | GUARDED |
| `scripts/perf/perf-gate.ts` | 38 | 97 | GUARDED |
| `scripts/perf/route-slo.ts` | 67 | 441 | GUARDED |
| `scripts/perf/write-slo.ts` | 42 | 228 | GUARDED |
| `scripts/phase33-verify.ts` | 42 | 122 | GUARDED |

**5/5 korumalı, kapı her birinde çağrıdan önce.**
