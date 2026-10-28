# P24B cleanup v2.3.1 — test tekrarlanabilirliği ve DDL sessizlik sözleşmesi

Temel: `debecacd4f4956c38b84dbf03dea7f79371addea`. İki kabul alanı kapatıldı. Gerçek
`mas_radar_dev` üzerinde **INSERT / UPDATE / DELETE / DDL / DROP yok**.

## 1 — Timeout'un kaynağı ölçüldü, kod değiştirilmedi

Önce kod yolunun doğruluğunu teyit ettim; **runtime güvenlik kodunu timeout yüzünden yeniden
tasarlamadım.**

```
smokeTargetBlockers   satır 64
makbuz okuma          satır 69   (kapıdan sonra)
new Pool              satır 85   (kapıdan sonra)
pool.connect()        satır 86   (kapıdan sonra)
ilk docker çağrısı    satır 124  (kapıdan sonra)
```

Sonra gecikmenin nereden geldiğini ölçtüm:

| | |
|---|---|
| saf politika kararı | **1,40 µs** (50.000 karar / 70 ms) |
| bir subprocess'in tsx modül grafiği | **~1–2 s** (`owner-url`, `pg`, `backup-lib`, `fingerprint`) |

v2.3'te 11 subprocess vardı: **15 µs'lik mantığı sınamak için 11–22 saniye.** Kırılganlık test
harness'ından geliyordu, güvenlik kodundan değil.

Çözüm timeout'u yükseltmek değil, maliyeti kaldırmak oldu:

```
subprocess vakası   11 → 2
test süresi      21,85 s → 3,25 s
```

Parametrik ad vakalarının tamamı artık **aynı process içinde**, saf yüklem üzerinde. Geriye
CLI'nin o yüklemi gerçekten kullandığını kanıtlayan iki entegrasyon vakası kaldı — açık 30 sn
timeout ile, çünkü Windows'ta soğuk bir tsx grafiği saniyelerle ölçülür.

> **Yan etkiler sayılıyor, çıkarsanmıyor.** CASE A'da sahte bir `docker` çağrıları log'luyor ve
> **gerçek bir TCP dinleyici** PostgreSQL yerine geçip soket sayıyor:
> `dbConnections 0 · dockerCalls 0 · destructiveCalls 0`. Duvar saati üzerinde kırılgan bir eşik
> yok.

### Üç ardışık koşu

```
RUN_1  33/33  2,73 s   FAIL 0  TIMEOUT 0
RUN_2  33/33  2,41 s   FAIL 0  TIMEOUT 0
RUN_3  33/33  2,14 s   FAIL 0  TIMEOUT 0
```

## 2 — DDL sessizlik sözleşmesi, dürüst sınırıyla

### Veritabanının zorladığı

```
ALL_BASE_TABLE_DML_FREEZE = ENFORCED_BY_DB_LOCKS
BASE_TABLE_COUNT 86 · LOCKED 86 · UNLOCKED_FINGERPRINT_TABLES []
```

Kilit alındığı anda var olan her base table'da dışarıdan yazma engellenir. Ölçüldü: kilitliyken
hedef **dışı** yazma `55P03`, kilitsizken geçiyor. `lock_timeout=10s`; bir tablo alınamazsa
ROLLBACK — *"bazıları kilitlendi, devam"* yok.

### Veritabanının zorlamadığı

```
CONCURRENT_NEW_TABLE_DDL = OPERATIONALLY_FORBIDDEN
```

Kilitler **katalogu donduramaz**. Eşzamanlı bir migration yeni tablo yaratırsa o tablo hem kilidin
hem parmak izinin dışında kalır. Bu yüzden katalog transaction başında ve **COMMIT'ten hemen
önce** yeniden okunuyor:

| tespit | sonuç |
|---|---|
| `BASE_TABLE_SET_CHANGED_DURING_FREEZE` | kilit sonrası küme değişmiş → ROLLBACK |
| `BASE_TABLE_SET_CHANGED_DURING_CLEANUP` | COMMIT öncesi küme değişmiş → ROLLBACK |
| `LEDGER_CHANGED_DURING_CLEANUP` | `schema_migrations` kaymış → ROLLBACK |

> **Sınırı abartmıyorum:** DDL *engellenmiş* değil, **tespit edilir ve temizliği iptal ettirir**.
> "Bütün DDL veritabanı kilidiyle matematiksel olarak imkânsız" demek yanlış olurdu.

Canlı DDL yarışını kurmak yerine **kararı** doğrudan test ettim: `tests/p24b-table-set.test.ts`,
`tableSetDiff`/`tableSetKey` için 9 test (ekleme, kaldırma, ikisi birden, şema farkı, boş küme,
86 tablodan birinin değişmesi).

Zorunlu ön koşullar (runtime durdurulmuş, `prepare-runtime` yok, bot/worker yok, migration yok,
başka DDL yok, operatör tek yazıcı) `docs/real-db-cutover-runbook.md`'ye eklendi.

## Prova

```
FRESH_REHEARSAL_DB   mas_radar_p24b_v231_drill
DELETE 42 · ORPHANS 0
tableSet T0 == T1: true      ledger 0087/87 → 0087/87
SNAPSHOT 24 → 24 · semantik 2 · teknik 22
AUDIT mevcut değişmedi · INSERT 2/2
PARA payments −1.000 · instances −26.000 · diğerleri 0
ATILLA korundu · hedef dışı 0 · COMMITTED
```

## Dosyalar

`00-gate-order-proof` · `01-timeout-root-cause` · `02-targeted-suite-runs` ·
`03-ddl-quiescence-contract` · `04-rehearsal-receipt`

```
SOFTWARE_BLOCKERS_REMAINING = 0
OFF_DEVICE_BACKUP_REAL      = BLOCKED
P24B_CLEANUP_AUTHORIZED     = NO
```
