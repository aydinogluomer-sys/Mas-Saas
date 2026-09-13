# FINAL — PHASE 7 OPERATIONS RECOVERY & BACKUP/RESTORE ACCEPTANCE (2026-09-13)

```text
ACCEPTED_CODE_SHA    = ceca39a3a60c00358d1aa90f00f9b2864237e4ec   (değişmedi)
RELEASE_EVIDENCE_SHA = af210fd971a126c5aa3281f5a299f60b046d1d8b   (değişmedi)
OPS_BRANCH           = ops/phase7-operations  (af210fd'den; ops/telemetri değişiklikleri + belge + kanıt)
```

## Sonuç tablosu — kanıtlanmayan hiçbir başlık kapatılmadı

| # | Başlık | Durum | Kanıt |
|---|---|---|---|
| 0 | Host preflight (yalnız ölçüm) | DONE — C: 2.19 GB / 237, D: YOK, RAM 7.85/0.50, pagefile 18.76 GB, Docker backend erken çıkış | 00 |
| 1 | Disk güvenlik kapısı | **FAIL** (2.19 < 5) → Docker zorlanmadı; 14 kalemlik `SAFE_REGENERABLE_CLEANUP_CANDIDATES` üretildi (~9.7 GB), **hiçbir şey silinmedi** | 01 |
| 2 | Docker tanı + tersinir kurtarma | **NOT_EXECUTED** — kök neden onarım kurulumu ister (registry anahtarı + WSL CLI ISO + linuxkit eksik); Reset/prune/rm yapılmadı; VHDX 2026-09-05 14:41:36 aynı | 02 |
| 3 | Mevcut Postgres kimliği | kayıttan: mas-radar-pg · PG 16.14 · sysid 7659286466006216743 · mas_radar_dev; canlı ölçüm YOK | 03 |
| 4 | Gerçek DB ilk temas (READ-ONLY) | **BLOCKED** (0 bağlantı; ECONNREFUSED) | 04 |
| 5 | Kanonik yerel yedek | **NOT_TAKEN** (pg_dump Docker'da). En yeni doğrulanmış gerçek yedek: 05.09 dump · 1.415.581 B · sha256 ff66a352… = makbuz · `pg_restore --list` ŞİMDİ PASS · TOC 1391 · **199,8 s = BAYAT** | 05 |
| 6 | Off-device (D:) yedek | **BLOCKED_D_DRIVE_ABSENT** — sahte PASS yok | 06 |
| 7 | Off-device restore tatbikatı + mutabakat + restored-app smoke | **BLOCKED** (D: yok + Docker yok); `mas_radar_restore_verify_*` yaratılmadı | 07 |
| 8 | Günlük yedek işi | görev VAR ve Ready; **elle tetik gerçek test PASS** (koştu, fail-closed exit 1, 0 dosya); `0x800710E0` kök nedeni pil koşulu (kullanıcı kararı, uygulanmadı); koşu kaydına `offDeviceStatus`/`toc_entry_count` eklendi (Docker'sız koşturulamadı: typecheck+lint) | 08 |
| 9 | Tazelik sözleşmesi + alarm + negatif kontrol | **PASS** — unit 17/17 · telemetry-verify 14/14 · alerting-verify 47/47 (+1 dürüst SKIP) · gerçek dizinde ALARM (199,8 s, DRIVE_ABSENT, disk 2.19 CRITICAL) · gerçek zaman damgası değiştirilmedi | 09 |
| 10 | Export/search sızıntı kapısı | **BLOCKED** (Docker) | 10 |
| 11 | Gerçek DB yazma yok / post-ops fingerprint | 0/0/0/0 · VHDX aynı · 895 = 895 dosya · **UNEXPECTED_DELTA = 0** | 11 |
| — | Ops el kitabı | `docs/ops/mas-nakit-radar-operations.md` (Günlük / Haftalık / Arıza / ASLA) | — |
| — | Disk baskısı koruması | `disk_free_gb` sinyali: <10 GB P2, <5 GB P1, ölçülemedi P1; otomatik silme YOK | 09 |

## Bu turda değişen kod (yalnız ops/telemetri; uygulama davranışı değişmedi)

`src/lib/ops/backup-freshness.ts` (+test) · `scripts/ops/backup-freshness-probe.ts` · `scripts/ops/backup-fixture.ts` ·
`scripts/ops/telemetry-snapshot.ts` (backup_age_hours sözleşmeye bağlandı; `backup_offdevice_age_hours`, `disk_free_gb` yeni) ·
`scripts/ops/backup-daily.ts` (koşu kaydı alanları, DRIVE_ABSENT yolu) · `scripts/ops/telemetry-verify.ts`, `telemetry-alerting-verify.ts`
(gerçek pg_dump fixture, negatif kontroller). `src/app`, `src/lib` (ops dışı), `supabase/` dokunulmadı.

## Karar

```text
OPERATIONS_READY   = FAIL      (7.1 günlük yedek Docker'sız alınamıyor; 7.2 off-device restore D: yok; 7.3 alarm PASS)
READY_FOR_M1_M8    = NO        (uygulama Docker/DB olmadan açılamaz; el kabulü çalışan runtime ister)
READY_FOR_PHASE8   = NO
REAL_DB_MIGRATIONS_0088_0094 = NOT_APPLIED · REAL_V2_IMPORT = NOT_EXECUTED · PHASE8_CUTOVER = NOT_EXECUTED
```

## Kalan blokerler (sırayla)

1. **Disk:** C: ≥ 8 GB için `01-disk-safety-gate.json` listesinden onaylanacak kalemler (kullanıcı izni).
2. **Docker:** Docker Desktop 4.86.0 onarım kurulumu (Quit → Installer → Install/Repair; Reset/Clean/Uninstall YASAK).
3. **D: sürücüsü:** takılı olmalı; `MAS_OFFDEVICE_BACKUP_DIR=D:\MAS-Backups\mas_radar_dev`.
4. Sonra bu turun BLOCKED adımları aynı sırayla (04 → 05 → 06 → 07 → 10) koşulur; ancak o zaman `OPERATIONS_READY = PASS` yazılabilir.
5. Kullanıcı kararı: görev pil koşulu (`08-daily-backup-job.json` → `recommended_reversible_fix_NOT_APPLIED`).
