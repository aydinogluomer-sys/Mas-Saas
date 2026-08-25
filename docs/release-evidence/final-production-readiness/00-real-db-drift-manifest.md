# Gerçek DB drift manifesti — read-only (2026-08-25)

Bu dosya, gap-closure rehberi §10 (AŞAMA 05) ön koşuludur:

> "Gerçek baseline değişmişse eski sayıyı zorla bekleme. Önce neden değiştiğini açıkla ve
> **yeni read-only manifesti** kullanıcıya göster. **Açıklanmayan drift = STOP.**"

Rehberin beklediği pre-cutover baseline (`ledger 0034 / payments 19 / users 12`) **artık gerçek
DB'nin durumu değildir**. Aşağıda yeni manifest, beklenen-gerçekleşen farkı ve farkın tam
açıklaması vardır.

```yaml
document: real-db-drift-manifest
date: 2026-08-25
evidence_class: REAL_READ_ONLY
target_db_name: mas_radar_dev
target_db_class: REAL_READ_ONLY
write_expected: NO
real_db_write_used: NO
observed_by: orchestrator (read-only SQL)
branch: release/production-readiness-hardening
head_commit: 685c20bc604d3f4c8d2185a04e4ae2044eb344c4
```

## 1. Yeni read-only manifest — gerçek DB'nin ŞU ANKİ durumu

| Ölçüm | Değer |
|---|---|
| `ledger_latest` | **0087** |
| `ledger_count` | **87** |
| `payments` | **20** |
| `checks` | **7** |
| `loans` | **1** |
| `cashflow_months` | **35** |
| `users` | **17** |

Ölçüm yöntemi: orkestratörün `REAL_READ_ONLY` sınıfında koştuğu salt-okunur SQL, 2026-08-25.
Bu belge kapsamında gerçek DB'ye **hiçbir yazma yapılmadı** (migration / seed / fixture /
TRUNCATE / INSERT / UPDATE / DELETE = 0).

## 2. Beklenen (rehber §10) vs gerçekleşen

| Ölçüm | Rehberin beklediği baseline | Gerçek DB şu an | Fark | Açıklandı mı |
|---|---|---|---|---|
| `ledger_latest` | 0034 | **0087** | +53 migration | EVET — cutover adımı D canlı koştu |
| `ledger_count` | 34 | **87** | +53 | EVET — aynı sebep |
| `payments` | 19 | **20** | +1 | EVET — 1 verify fixture satırı |
| `checks` | 7 | **7** | 0 | — değişmedi |
| `loans` | 1 | **1** | 0 | — değişmedi |
| `cashflow_months` | 35 | **35** | 0 | — değişmedi |
| `users` | 12 | **17** | +5 | EVET — 4 verify fixture + 1 gerçek admin |

## 3. Drift'in tam açıklaması

### 3.1 Migration drift (0034 → 0087)

`schema_migrations.applied_at` alanına göre 0035→0087 arası migration'lar gerçek DB'ye

```text
2026-08-25 09:43:55.769957+00  →  2026-08-25 09:43:57.982695+00
```

aralığında uygulandı. Yani **cutover adımı D canlı olarak yürütüldü** — hem son commit
`685c20b`'den hem de rehberin audit snapshot'ından **sonra**. Rehberin §1.4'teki "gerçek DB
ledger 0034" tespiti o anın fotoğrafıdır ve bugün geçerli değildir.

Bu, `PROGRESS.md` → "Karar kaydı — cutover ertelendi (2026-08-25)" kaydıyla birlikte okunmalıdır:
o kayıt F/G adımlarının D olmadan denendiğini ve üç hata verdiğini anlatır; sonrasında D adımı
migration runner ile koşturulmuştur.

### 3.2 Migration runner'ın kendi otomatik yedeği

Runner, migration'dan **önce** kendi yedeğini aldı:

```text
dosya  : backups/migrate-mas_radar_dev-2026-08-25T09-43-53-637Z.dump
sha256 : 70fe1ed4e7083348b24f6c772010afc50b95de5f63719170121c4dc67829ecc1
boyut  : 867701 bayt
```

### 3.3 Elle alınmış pre-cutover yedek A

```text
dosya            : backups/cutover_A_20260825-1211.dump
sha256           : f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d
boyut            : 867701 bayt
archive created  : 2026-08-25 09:11:09 UTC
dbname           : mas_radar_dev
TOC entries      : 395
format           : custom
pg_dump          : 16.14
```

### 3.4 Yedeğin baseline'ı birebir ürettiği kanıtlandı

Orkestratör yedek A'yı **harcanabilir bir probe DB**'ye geri yükledi (`DISPOSABLE_CLONE`) ve
şu sayıları ölçtü:

```text
ledger 0034 / count 34, payments 19, checks 7, loans 1, cashflow_months 35, users 12
```

Bu, rehberin §10'da yazdığı pre-cutover baseline'ın **tam eşleşmesidir**. Probe DB ölçümden
sonra düşürüldü. Gerçek DB'ye dokunulmadı.

### 3.5 Satır drift'i (migration dışı)

| Tablo | Satır | Oluşturma zamanı (UTC) | Sınıf |
|---|---|---|---|
| `users` | `p24b_fixture_a` | 2026-08-25 10:09:08 | verify fixture |
| `users` | `p24b_fixture_b` | 2026-08-25 10:09:08–10:10:38 | verify fixture |
| `users` | `p24b_mk_mujyy6` | 2026-08-25 10:09:08–10:10:38 | verify fixture |
| `users` | `p24b_op_9bcmx5` | 2026-08-25 10:09:08–10:10:38 | verify fixture |
| `users` | `atilla` | 2026-08-25 10:17:33 | **gerçek admin kullanıcısı** |
| `payments` | `7b300bfe-944f-468b-91fa-2de65b7cfee5` | 2026-08-25 10:09:08 | verify fixture |

`checks`, `loans`, `cashflow_months` değişmedi (7 / 1 / 35).

## 4. Bulgu

```text
FINDING P0-DRIFT-01 — verify fixtures written to REAL DB
CLASS: P0 (plan §31 "real DB fixture write")
ROWS: 4 users p24b_*, 1 payment 7b300bfe-944f-468b-91fa-2de65b7cfee5
WHEN: 2026-08-25 10:09-10:10 UTC
STATUS: OPEN — remediation requires a DELETE on the real DB, which is a
        destructive real-DB operation and is DEFERRED to explicit user decision.
IMPACT: financial aggregates — payments count 19->20. checks/loans/cashflow unchanged.
```

Ek notlar:

- `atilla` kullanıcısı **fixture değildir**; gerçek bir operatör hesabıdır ve silinmemelidir.
  Drift açıklamasında ayrı sınıflandırılmıştır.
- Bu belge fixture satırlarını **yalnızca belgeler**. Silme işlemi bu iş paketinin kapsamı
  dışındadır ve kullanıcı kararı olmadan yapılamaz.
- Fixture satırları gerçek DB'de durduğu sürece `payments` sayımı kaynak gerçeğinden 1 fazladır;
  Aşama 05/06'da beklenen değer **20** olarak kullanılmalı, 19 değil — ya da önce temizlik kararı
  alınmalıdır.

## 5. STOP değerlendirmesi

```text
DRIFT EXPLAINED = YES
STOP           = NOT TRIGGERED
```

**Gerekçe:** Rehber §10 "açıklanmayan drift = STOP" der. Buradaki drift'in her kalemi zaman
damgalı kaynağa bağlanmıştır ve en güçlü kanıt şudur: migration öncesi alınan yedek, harcanabilir
bir probe DB'ye geri yüklendiğinde rehberin belgelediği baseline'ı (`0034 / 19 / 7 / 1 / 35 / 12`)
**birebir** üretmektedir. Yani 0034 → 0087 geçişi kayıp veya bozulma değil, tarihi bilinen bir
migration uygulamasıdır.

STOP tetiklenmemesi, P0-DRIFT-01'in kapandığı anlamına **gelmez**. Bulgu OPEN kalır.

## 6. Aşama 05 için bağlayıcı sonuç

1. Aşama 05'in fresh REAL clone'u bu manifesti kaynak alır; `0034` baseline'ı **zorlanmaz**.
2. Aşama 05'te gerçek DB'ye izin verilen tek işlem: **read / fingerprint / `pg_dump`**.
3. Migration acceptance hedefi `latest = 0087` zaten gerçek DB'de sağlanmış durumdadır; clone
   üzerindeki koşum bunu **bağımsız olarak** yeniden kanıtlamalıdır (gerçek DB'nin durumu
   kanıt yerine geçmez).
4. P0-DRIFT-01 kapanmadan final scorecard "temiz" yazılamaz.
