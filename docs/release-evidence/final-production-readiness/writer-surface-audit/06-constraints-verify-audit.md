# 06 — `scripts/db/constraints-verify.ts` özel denetimi

**Soru.** Bu dosya `archivePayment`'i `src/lib/payments/engine`'den **statik** import ediyor.
Statik import, modül yüklenirken çalışan yan etkileri de beraberinde getirir. İmport grafiği
`@/lib/env` veya bir pool singleton'a ulaşıyorsa, hedef doğrulanmadan ÖNCE gerçek veritabanına
bir bağlantı kurulmuş olabilir.

**Sonuç: SAFE_DISPOSABLE_ENFORCED.** Statik import kalabilir; stil için değiştirilmedi.

## 1. Hedef env'den GELMİYOR

```ts
const DB = "mas_radar_constraints_verify";                                   // satır 25
function dbUrl(db: string) { return `postgres://postgres:postgres@127.0.0.1:5432/${db}`; }  // satır 64
```

Dosyadaki **tek** `process.env` kullanımları:

| satır | kullanım | değerlendirme |
|---|---|---|
| 22 | `process.env.MAS_DB_CONTAINER ?? "mas-radar-pg"` | container adı, DB hedefi değil |
| 86 | `env: { ...process.env, DATABASE_URL: url, MIGRATION_DATABASE_URL: url }` | **subprocess env shadow** — her iki URL de disposable hedefe pinleniyor |

`DATABASE_URL` / `MIGRATION_DATABASE_URL` hedef seçimi için **hiç okunmuyor**. Ortamda gerçek DB'yi
gösteren bir değişken olsa bile bu dosya ona bağlanamaz. Bu, `requireDisposableOwnerDatabaseUrl`
kapısından daha güçlü bir garanti: kapı env'i doğrular, burada env'in söz hakkı yok.

`mas_radar_constraints_verify` adı `verify` işaretini taşır ve `PROTECTED_DB_NAMES`'te değildir.

## 2. `archivePayment` statik import closure'ı — env'siz ve pool'suz

`src/lib/payments/engine.ts`'den başlayan **statik** import kapanışı (dynamic `import()` hariç),
12 modül:

```
src/lib/payments/engine.ts
src/lib/domain-error.ts
src/lib/time/istanbul.ts
src/lib/radar/rules.ts
src/lib/money.ts
src/lib/audit.ts
src/lib/radar/engine.ts
src/lib/importers/extractors.ts
src/lib/importers/row-utils.ts
src/lib/importers/workbook-parser.ts
src/lib/validation/index.ts
src/lib/authz/matrix.ts
```

Bu 12 modülün tamamında aranan ve **hiçbirinde bulunmayan** semboller:

| aranan | bulundu |
|---|---|
| `process.env` | **0** |
| `new Pool` / `new Client` | **0** |
| `getPool` / `getRawPool` | **0** |
| `from "@/lib/env"` | **0** |
| `from "@/lib/db"` | **0** |
| `connectionString` | **0** |

`engine.ts`'in ilk satırı `import type { Pool } from "pg"` — **tip-only import**, derlemede
tamamen silinir, çalışma zamanında `pg` modülünü bile yüklemez.

Karşılaştırma: pool singleton `src/lib/db.ts`'de yaşıyor (`getRawPool` satır 56, `getPool`
satır 148) ve closure'ın **dışında**.

## 3. İlk olası mutasyon hangi pool üzerinden?

`archivePayment(pool, …)` imzası pool'u **parametre olarak** alır. Dosyadaki tüm `Pool`
örnekleri `dbUrl(DB)` ile kurulur:

| satır | pool |
|---|---|
| 334 | `new Pool({ connectionString: dbUrl(DB), max: 5 })` |
| 538 | `new Pool({ connectionString: dbUrl(DB), max: 1 })` |

Yani ilk olası mutasyon, adı hardcoded disposable olan veritabanına açılmış bir pool üzerinden
gerçekleşir. Import zamanında hiçbir bağlantı kurulmaz.

## Karar

| kriter | sonuç |
|---|---|
| transitive env/db pool initialization | **0** |
| tüm mutasyonlar açık disposable pool parametresi üzerinden | **evet** |
| hedef env'den türetiliyor mu | **hayır** (hardcoded) |
| subprocess env shadow | **var** (her iki URL) |

→ **SAFE_DISPOSABLE_ENFORCED.** Fail-closed dynamic-import modeline geçirmeye gerek yok.

Üretim: `scripts/qa/writer-surface-manifest.ts` closure hesabı + `06` bölümündeki grep'ler.
