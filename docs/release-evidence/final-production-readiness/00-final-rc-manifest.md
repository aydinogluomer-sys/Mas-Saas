# Final Release Candidate manifesti — SCAFFOLD

Kaynak: gap-closure rehberi §7 (AŞAMA 02) "Final Release Candidate'ı sabitle".

**Bu dosya henüz dondurulmuş bir RC'yi tanımlamıyor.** Rehber §7 açıkça şunu söylüyor: gap-closure
değişiklikleri yeni commit'ler üreteceği için mevcut branch HEAD (`685c20b`) final RC **değildir**.
Aşağıdaki alanlar **bugün bilinebilenlerle** doldurulmuştur; `rc_sha` Aşama 10 kapandığında
dondurulacaktır.

```yaml
rc_sha: PENDING — frozen after Stage 10 closes
master_base: 093573e30f451bb8857bed777352e80838e2e80e
migration_latest: "0087"
migration_count: 87
workflow_sha: a53e13996460b6796adea8ed1391175a51119d191d4e5e121ada021a822f8f90
package_lock_hash: 6b5bea20daf0ebedfed498f34507e3fbd8efaa6c515d4171c22cd0e7db93263b
postgres: "16.14 (Debian 16.14-1.pgdg13+1)"
node: v26.3.0
pnpm: 11.10.0
```

## Ölçüm kaynakları (uydurulmadı, çalıştırıldı)

| Alan | Komut | Çıktı |
|---|---|---|
| `master_base` | `git rev-parse master` | `093573e30f451bb8857bed777352e80838e2e80e` |
| `migration_count` | `ls supabase/migrations/*.sql \| wc -l` | `87` |
| `migration_latest` | `ls supabase/migrations/*.sql \| tail -1` | `0087_assistant_conversations.sql` |
| `workflow_sha` | `sha256sum .github/workflows/ci.yml` | `a53e1399…f8f90` |
| `package_lock_hash` | `sha256sum pnpm-lock.yaml` | `6b5bea20…3263b` |
| `postgres` | `docker exec mas-radar-pg postgres --version` | `postgres (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)` |
| `node` | `node --version` | `v26.3.0` |
| `pnpm` | `pnpm --version` | `11.10.0` |

Ölçüm anındaki branch HEAD: `685c20bc604d3f4c8d2185a04e4ae2044eb344c4`
(`release/production-readiness-hardening`, master'dan **22 commit ileri, 0 geri**).

**Not — `workflow_sha` neden Faz 0 baseline'ından farklı:** `docs/release-evidence/2026-08-24-baseline.md`
içindeki `56635813…c8587c` değeri Faz 0 anındaki `ci.yml`'e aittir. CI, Faz 1'de yedi job'lu
release gate'e yükseltildiği ve Faz 12/14/15 kapıları eklendiği için dosya değişti. Yukarıdaki
`a53e1399…` **bugünkü** değerdir. Bu bir tutarsızlık değil, beklenen evrimdir; ancak final RC
dondurulduğunda tekrar ölçülmelidir.

## RC_SHA dondurma kuralı (§7, madde 3)

Aşama 03–10 arasındaki kod/test/runbook düzeltmeleri hardening branch'te ayrı ve anlaşılır
commit'lerle yapılır. Son gap kapandığında:

```text
RC_SHA=<final hardening head>
```

olarak dondurulur ve bu dosyadaki `rc_sha` alanı o değerle güncellenir.

## RC_SHA değişirse yeniden koşulması ZORUNLU olanlar (§7, madde 4)

```text
clone gate      → AŞAMA 05 (fresh REAL clone migration + fingerprint)
restore gate    → AŞAMA 07 (gerçek kaynak backup/restore + off-device)
rehearsal       → AŞAMA 11 (final RC cutover provası)
CI              → AŞAMA 04 (hardening branch clean CI)
```

Bu dördü, RC_SHA'nın herhangi bir nedenle (bir P1 fix, bir runbook düzeltmesi, hatta bir
dokümantasyon commit'i dahil) değişmesi hâlinde **yeniden değerlendirilir**. "Sadece doküman
değişti, gerek yok" istisnası rehberde tanımlı değildir.

## Bu dosya ne zaman SCAFFOLD olmaktan çıkar

Üç koşulun hepsi:

1. `rc_sha` gerçek bir commit SHA'sı ile dolu,
2. yukarıdaki dört kapı o SHA üzerinde koşmuş ve kanıt dosyaları bu klasörde,
3. `migration_latest` / `migration_count` / `workflow_sha` / `package_lock_hash` o SHA'da
   yeniden ölçülmüş.

O ana kadar bu dosya **RC iddiası olarak kullanılamaz**.
