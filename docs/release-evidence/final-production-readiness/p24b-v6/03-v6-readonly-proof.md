# 03 — V6 salt-okunur kanıtı

`DISCOVERY_BASE_SHA = 1675c92a0aea120d200b9b10c2f260e57ad9b051`

V6 keşfi RC worktree'de, pinlenmiş `scripts/db/p24b-readonly-psql.sh` üzerinden koştu.

## Motor düzeyinde zorlama — üç katman

1. bağlantı `PGOPTIONS="-c default_transaction_read_only=on"` ile açılır
2. sarmalayıcı, oturumun gerçekten salt-okunur olduğunu **pozitif kontrolle** kanıtlar:
   `select current_setting('transaction_read_only')` → `on` değilse `exit 9`, sorgu hiç çalışmaz
3. hedef adı sabittir (`mas_radar_dev`); başka hiçbir ad kabul edilmez

Yazma-negatif testi bu turda **gerçek DB'de tekrarlanmadı** — bilerek. Motor zorlaması
writer-surface denetiminde disposable klon üzerinde kanıtlanmıştı
(`../writer-surface-audit/10-perf-measure-fix.md`); gerçek veritabanında yeni bir yazma
denemesi yapmak, kanıt üretmeden risk eklerdi.

## Parmak izi karşılaştırması

| | pre | post |
|---|---|---|
| zaman (UTC) | keşif öncesi | keşif sonrası |
| public/auth base tablo | 86 | 86 |
| `schema_migrations` | 0087/87 | 0087/87 |
| `transaction_read_only` | `on` | `on` |

```
changedTables    = []
changedRows      = 0
fingerprintEqual = true
```

Her tablo için satır sayısı **ve** içerik parmak izi (`md5(string_agg(row::text order by row::text))`)
karşılaştırıldı — fiziksel satır sırasından bağımsız, gerçek içerik denkliği.

`REAL_DB_WRITE_DURING_V6_1 = 0`

Ham veriler: `03-v6-readonly-proof.json`.
