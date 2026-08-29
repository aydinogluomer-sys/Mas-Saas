# DB writer surface audit — kanıt paketi

`P24B-DRIFT` soruşturmasının **writer surface** aşaması. Bu klasör, "hangi kod gerçek
veritabanına yazabilir ve onu ne durduruyor?" sorusunun yeniden üretilebilir cevabıdır.

**Denetim tabanı:** `2f2fe548b6d5db7657a7c9dec671ad6832526648`
**Düzeltmeler:** `2825909` (`perf:measure --seed` kapısı + runbook sözleşmesi)

`9844dd3` denetim tabanının **atasıdır**, HEAD değildir — eski v5 prompt'u onu RC_SHA
sanıyordu. `640f853` büsbütün eskidir.

> **RC_PIN henüz İLAN EDİLMEDİ.** Çalışma ağacı kirli (Telegram özelliği ve üretilmiş
> derleme çıktıları). Writer audit tamamlanabilir ve tamamlandı; RC pin ayrı bir karardır.

> **Bu klasör `p24b-discovery/` ile karıştırılmamalıdır.** O klasör v5 turunda, ikinci olay
> sürerken üretildi; `STALE_EVIDENCE` sayılır ve buradaki hiçbir sonuç ondan türetilmemiştir.

## Dosyalar

| dosya | ne kanıtlar |
|---|---|
| `00-runtime-freeze.md` | Ölçüm öncesi durdurulan canlı yazıcılar; dondurma doğrulaması |
| `01-quiescence-m1.json` | Salt-okunur snapshot #1 — 86 tablo, satır sayısı + içerik parmak izi |
| `02-quiescence-m2.json` | Snapshot #2 |
| `03-quiescence-m3.json` | Snapshot #3 (tüm testlerden sonra) |
| `04-quiescence-summary.json` | m1==m2==m3 karşılaştırması, ledger durumu, verdict |
| `05-writer-surface-manifest.json` | 100 writer adayının tam makine-okunur manifesti |
| `05-writer-surface-manifest.md` | Aynı manifest, sınıfa göre sıralı tablo |
| `06-constraints-verify-audit.md` | `constraints-verify.ts` statik import closure denetimi |
| `07-invocation-path.md` | `db:roles-rls:verify` iki olayı kimin/nasıl tetiklediği |
| `08-amplifier-provenance.md` | `prepare-runtime` amplifikasyonu — 26 döngü = 26 satır |
| `09-scan-coverage.json/.md` | Yedi tarama sınıfının kapsam sayıları |
| `10-perf-measure-fix.md` | P0: `perf:measure --seed` kapısı, negatif/pozitif testlerle |
| `11-runbook-contract-fix.md` | P0: cutover runbook ↔ kod sözleşmesinin onarımı |

## Yeniden üretim

```bash
# Quiescence snapshot (salt-okunur; BEGIN READ ONLY + ROLLBACK, motor zorlamalı)
MIGRATION_DATABASE_URL=… node --import tsx scripts/db/quiescence-snapshot.ts out.json etiket

# Writer manifest (UNKNOWN > 0 ise exit 1)
node --import tsx scripts/qa/writer-surface-manifest.ts out.json out.md

# Regresyon testleri
npx vitest run tests/writer-surface.test.ts tests/disposable-target.test.ts
```

## Bu turda YAPILMAYANLAR

- `mas_radar_dev` üzerinde hiçbir yazma (m2 == m3 bunu kanıtlar)
- P24B fixture temizliği (yetki bekliyor; mevcut script eksik)
- v6 footprint discovery
- master merge
- `p24b-discovery/` çıktılarının yeniden kullanımı
