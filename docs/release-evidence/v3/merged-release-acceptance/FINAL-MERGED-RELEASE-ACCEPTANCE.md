# FINAL — MERGED RELEASE ACCEPTANCE (2026-09-13)

```text
TESTED_SHA   = ceca39a3a60c00358d1aa90f00f9b2864237e4ec
BUILD_SHA    = ceca39a3a60c00358d1aa90f00f9b2864237e4ec   (BUILD_ID, /version.commit, /version.buildId)
ACCEPTED_SHA = ceca39a3a60c00358d1aa90f00f9b2864237e4ec
```

Merge: `ffb111d` (release, Phase 2 CLOSED) + `4ca2b42` (import V2) → `ceca39a` (`--no-ff`, 0 conflict). Bu belge ve yanındaki
JSON'lar **evidence-only** bir commit'tir; davranış SHA'sı `ceca39a`'dır. Evidence commit'in kod ağacı `ceca39a` ile birebir aynıdır
(`git diff ceca39a <evidence> --stat -- . ':(exclude)docs'` boş).

## Gate tablosu (hepsi MERGE_SHA üzerinde, tek seferde)

| Gate | Sonuç | Kanıt |
|---|---|---|
| MIGRATION_GRAPH | PASS — 94 dosya, 0001…0094 bitişik, MISSING 0, DUPLICATE 0, `validateFileSet` ok | 02 |
| MIGRATION_FRESH_DB | PASS — `pnpm db:migrate` EMPTY → ledger 94/0094 (checksum'lı), 81 view | 02 |
| TYPECHECK / LINT | PASS / PASS (0/0) | 03 |
| UNIT_SERIAL | 78 dosya · **1671/1671** · 0 skip | 03 |
| BUILD | PASS 111 s · BUILD_ID = SHA · APP_COMMIT_SHA/APP_BUILD_TIME gömülü | 03 |
| FINANCIAL_CORRECTNESS | PASS — 502/502 hedefli · 0093/0094 karışık-para-birimi SQL senaryoları · `liquidity_forecast_daily` = `financial_calendar` (USD 5000 / TRY 600) · loader smoke gerçek klonda 13/13 | 04 |
| IMPORT_V2_CORE | PASS — 180/180 · e2e 69/69 · concurrency 18/18 (DOMAIN_ROWS 1, ORPHAN 0) · currency 9/9 · enum parity | 05 |
| IMPORT_V2_PRODUCT_FLOW | PASS — canlı 8/8 ×2 ardışık (57 s, 1,5 dk); FLAKY = NO | 06 |
| LEGACY_REGRESSION | PASS — phase3/4/5 ALL PASS (35 ay, B10 exact, 19 ödeme, 7 çek) | 07 |
| SECURITY | 17/17 · RLS 29/29 · route-access 123/123 · export-leakage **BLOCKED (Docker)** | 08 |
| RUNTIME_SMOKE | /ready 200 · /login 200 · /version commit = SHA · 13 anonim korumalı rota 307, 200 sızıntısı 0, 5xx 0 | 09 |
| REAL_CLONE | 7/7 — 0088–0094 gerçek şema+veri, legacy 6 tablo birebir, V2 fixture yanına; klon silindi | 10 |
| REAL_DB | 0 attempted (Docker DOWN; VHDX 2026-09-05 14:41:36 değişmedi) | 11 |

## Bilinen açıklar (kabulü bloke etmiyor)

- `export-leakage-verify` Docker'a bağlı script; Docker onarımı sonrası koşulacak (kod bu turda değişmedi).
- `refreshMetricSnapshots` sparse fixture verisinde `metric_snapshots_check` ihlali (P2 backlog): import commit'ini, iş verisini ve
  kullanıcıya dönen sonucu etkilemiyor; gerçek veride (70 üretim parçası) tekrar etmiyor.
- `.gitignore` `/.next-*/` deseni iki kez (iki dal aynı satırı eklemiş) — kozmetik.

## Sonraki adımlar

`READY_FOR_PHASE6_MANUAL_ACCEPTANCE = YES` · `READY_FOR_DOCKER_OPS = YES` · `READY_FOR_PHASE8 = NO`
(Docker/yedek operasyon kapısı 7.1/7.3, off-device restore, M1–M8 el kabulü ve AKR/Çağdaş kullanıcı kararı bekliyor).
