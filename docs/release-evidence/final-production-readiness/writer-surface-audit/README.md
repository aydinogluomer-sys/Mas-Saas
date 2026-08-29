# DB writer surface audit — kanıt paketi

`P24B-DRIFT` soruşturmasının **writer surface** aşaması. Bu klasör, "hangi kod gerçek
veritabanına yazabilir ve onu ne durduruyor?" sorusunun yeniden üretilebilir cevabıdır.

> **Bu klasör `p24b-discovery/` ile karıştırılmamalıdır.** O klasör v5 turunda, ikinci olay
> sürerken üretildi; `STALE_EVIDENCE` sayılır ve buradaki hiçbir sonuç ondan türetilmemiştir.

## Beyan edilen sayılar

Aşağıdaki değerler `scripts/qa/writer-audit-evidence-check.ts` tarafından artifact'lerden
**yeniden türetilir** ve uyuşmazlık `exit 1` ile sonuçlanır. Elle yazılan bir sayının
üreticinin ürettiği sayıdan kayması bu paketin ilk turunda dört yerde oldu; blok bu yüzden var.

    writerCandidates      = 102
    artifactFiles         = 18
    quiescenceSnapshots   = 5
    unknownWriters        = 0
    unsafeEnvTargeted     = 0

Sınıf dağılımı (`05-writer-surface-manifest.json` → `counts`):

| sınıf | adet |
|---|---|
| SAFE_DISPOSABLE_ENFORCED | 72 |
| INTENTIONAL_REAL_WRITE | 27 |
| SAFE_ROLLBACK_ONLY | 2 |
| LIBRARY_REQUIRES_CALLER_GUARD | 1 |
| UNSAFE_ENV_TARGETED | 0 |
| UNKNOWN | 0 |

## Dosyalar

| dosya | ne kanıtlar |
|---|---|
| `00-runtime-freeze.md` | Ölçüm öncesi durdurulan canlı yazıcılar; dondurma doğrulaması |
| `01-quiescence-m1.json` | Salt-okunur snapshot #1 — 86 tablo, satır sayısı + içerik parmak izi |
| `02-quiescence-m2.json` | Snapshot #2 — perf guard testlerinden önce |
| `03-quiescence-m3.json` | Snapshot #3 — perf guard testlerinden sonra |
| `03b-quiescence-m4-postcommit.json` | Snapshot #4 — ilk düzeltme commit'lerinden sonra |
| `03c-quiescence-m5-final.json` | Snapshot #5 — dev-reset sertleştirmesi ve testlerinden sonra |
| `04-quiescence-summary.json` | Beş snapshot'ın ikili karşılaştırması, ledger durumu, verdict |
| `05-writer-surface-manifest.json` | 102 writer adayının tam makine-okunur manifesti |
| `05-writer-surface-manifest.md` | Aynı manifest, sınıfa göre sıralı tablo |
| `06-constraints-verify-audit.md` | `constraints-verify.ts` statik import closure denetimi |
| `07-invocation-path.md` | `db:roles-rls:verify` iki olayı kimin/nasıl tetiklediği |
| `08-amplifier-provenance.md` | `prepare-runtime` amplifikasyonu — 26 döngü = 26 satır |
| `09-scan-coverage.json` / `.md` | Yedi tarama sınıfının kapsam sayıları |
| `10-perf-measure-fix.md` | P0: `perf:measure --seed` kapısı, negatif/pozitif testlerle |
| `11-runbook-contract-fix.md` | P0: cutover runbook ↔ kod sözleşmesinin onarımı |
| `12-dev-reset-safety.md` | P1: `dev-reset.sh` fail-closed yıkım kapısı |
| `README.md` | bu dosya |

## Commit geçmişi

| commit | ne değiştirdi |
|---|---|
| `2825909` | **Kod + doküman.** `scripts/perf/measure.ts`'e disposable kapısı; cutover runbook Bölüm I'nin yeniden yazımı; `quiescence-snapshot.ts`, `writer-surface-manifest.ts`, `writer-surface.test.ts` eklendi; `00`–`11` kanıt dosyaları. |
| `04b864d` | **Kod + doküman** — `docs(audit):` etiketi yanıltıcı. `scripts/qa/writer-surface-manifest.ts`'teki CURATED tablosunu düzeltir (`measure.ts` artık `UNSAFE_ENV_TARGETED` değil `SAFE_DISPOSABLE_ENFORCED`), manifest'i yeniden üretir ve README pin notunu düzeltir. Etiket sırf conventional-commit uyumu için yeniden yazılmadı; doğru tanım burada. |
| *(bu README'yi getiren commit)* | `dev-reset.sh` fail-closed kapısı + 9 güvenlik testi; `writer-audit-evidence-check.ts`; m4/m5 snapshot'ları; dört sayı tutarsızlığının kapatılması. |

## Pin durumu

**Denetim tabanı:** `2f2fe548b6d5db7657a7c9dec671ad6832526648`

`9844dd3` denetim tabanının **atasıdır**, HEAD değildir — eski v5 prompt'u onu RC_SHA
sanıyordu. `640f853` büsbütün eskidir.

Ana çalışma klasörü kirlidir (Telegram özelliği + üretilmiş derleme çıktıları) ve **öyle
kalacaktır**. RC pin'i ana klasörün temizliğine bağlamak yerine V6, düzeltme commit'lerinin
tam SHA'sına açılmış **ayrı bir worktree** üzerinde çalışır; `RC_SOURCE_TREE = CLEAN` kanıtı
oradan gelir.

## Yeniden üretim

```bash
# Quiescence snapshot (salt-okunur; BEGIN READ ONLY + ROLLBACK, motor zorlamalı)
MIGRATION_DATABASE_URL=… node --import tsx scripts/db/quiescence-snapshot.ts out.json etiket

# Writer manifest (UNKNOWN > 0 ise exit 1)
node --import tsx scripts/qa/writer-surface-manifest.ts out.json out.md

# Kanıt bütünlüğü (README beyanları ile artifact'leri karşılaştırır)
node --import tsx scripts/qa/writer-audit-evidence-check.ts

# Regresyon testleri
npx vitest run tests/writer-surface.test.ts tests/dev-reset-safety.test.ts tests/disposable-target.test.ts
```

## Bu turlarda YAPILMAYANLAR

- `mas_radar_dev` üzerinde hiçbir yazma — beş snapshot birebir aynı
- P24B fixture temizliği (yetki bekliyor; mevcut script eksik)
- v6 footprint discovery
- master merge
- `p24b-discovery/` çıktılarının yeniden kullanımı
- Telegram / kullanıcı özellik dosyalarına dokunulması
