# PHASE 3 — Import V2 Core Closure (2026-09-13)

Dal: `feature/standard-import-v2` (worktree `C:\Users\Trade Bilisim\Mas-Saas-Import-V2`), HEAD `c6b16d0`.
Veritabanı: harcanabilir PostgreSQL 16.14 `127.0.0.1:54329` (bkz. phase2-tier1-closure.md), `mas_radar_verify_fresh_v2`
(0001–0091 + 0092 + 0093). Gerçek `mas_radar_dev`'e bağlanılmadı.

## 3.8 Kabul tablosu

| Kabul | Kanıt | Sonuç |
|---|---|---|
| PARSER | `src/lib/importers/v2/parser.test.ts` + values/domain-map/mapper/migration-contract testleri; importers/v2 toplam **300/300** (authz dahil) | PASS |
| NORMALIZATION | aynı; 2.4 raw uyumluluğu (`88247d6`, `141403b`, `9f1e96b`) | PASS |
| NULL_ZERO | fixture golden values: 01_ODEMELER satır 3 `tutar=null` (boş=bilinmiyor), satır 4 `tutar=0` (gerçek sıfır) — e2e "kaynak → parse" zinciri | PASS |
| IDEMPOTENCY_SINGLE | `scripts/import/v2-import-e2e.ts` **69/69 GEÇTİ**: aynı dosya ikinci kez → 15 domain tablosunda MÜKERRER YOK, "ikinci geçişte hiçbir kayıt yaratılmadı", "defter büyümedi", hazırlık katmanı her import'u ayrı saklar | PASS |
| IDEMPOTENCY_CONCURRENT | `scripts/import/v2-concurrency-proof.ts` **18/18, verdict PASS**: iki bağımsız bağlantı aynı external_id → DOMAIN_ROWS=1, LEDGER_ROWS=1, ORPHAN_DUPLICATES=0 (advisory xact lock, kilit altında yeniden arama) | PASS |
| STALE_BINDING | aynı script: `STALE_EXTERNAL_KEY_BINDING` hard fail, auto-heal yok, "hata işlemi düşürdü" | PASS |
| BINDING_CONFLICT | aynı script: `EXTERNAL_KEY_BINDING_CONFLICT` hard fail | PASS |
| ROLLBACK | aynı script: "hatadan ÖNCEKİ kısmi domain güncellemesi geri alındı", "yarım kalan workbook kaydı yazılmadı"; service.test "begin → insert hata → rollback, commit yok" | PASS |
| LEGACY_REGRESSION | release worktree, `mas_radar_verify_fresh_release` (0001–0087+0092+0093+seed.sql), **gerçek TEMİZ.xlsx**: `phase3-verify` ALL PASS (payments 19 = kabul edilmiş baseline, idempotent, Şubat-27 clamp, day-9 cluster=3, critical=2, audit +2) · `phase4-verify` ALL PASS (**35 ay**, 1968 satır, B1/D1/F1/J1 mutabakat 35/35, final kasa 2029-03 = −3.064.607,57 bilinen doğru değer, süreklilik kırığı 0) · `phase5-verify` ALL PASS (çekler 7/7 yapısal, kredi toplam 3.443.717,58 = kaynak B10 **exact**, taksit Σ 3.443.717,76 **rounding-only** Δ0,18, 48 taksit) | PASS |

Ek DB kapıları (aynı cluster): `db:roles-rls:verify` **29/29** (hem V2 hem release şeması, `mas_radar_app` kimliğiyle),
`db:security-matrix:verify` V2 **17/17**; `v2-currency-safety` **9/9 PASS**; `v2-enum-parity` uyuşmazlık yok.

## 3.5 Migration hygiene

- Fresh DB'de sıfırdan: `local-bootstrap.sql` → `pnpm db:migrate` (EMPTY flow) 0001–0091 **hatasız**, ardından 0092/0093 psql ile.
- 0090/0091/0092/0093 constraint existence check'leri `conrelid = 'public.<tablo>'::regclass` ile tablo kimliğine bağlı.
- Yayımlanmış migration yeniden yazılmadı; düzeltmeler forward-only (0092, 0093).
- Açık nokta: 0092/0093 release dalında, 0088–0091 V2 dalında → birleşmeden önce release dalında tek başına
  `pnpm db:migrate` "sırada boşluk" der. **Birleşme kararı** (aşağıda).

## 3.6 Legacy regression — script düzeltmesi

`scripts/phase3-verify.ts` sahip rol (postgres) ile `ensureWindow/generateInstancesForMonth/refreshRiskFlags`
çağırıyordu; Faz 24B'den beri motor bu bakımı yalnız INSERT+UPDATE yetkili katman rollerinde yapar
(`tierMayMaintainInstances`) ve sahip rolde sessizce 0 üretir → "no day-30 instance for Şubat 2027" ile düşüyordu.
Betik, üretim adımlarını `mas_radar_admin` katmanı olarak koşacak şekilde düzeltildi (`options: -c role=mas_radar_admin`);
motor kodu değişmedi.

## 3.7 Template determinism

`070c00e`: ZIP girdi zaman damgaları 2026-01-01T00:00:00Z'ye sabitlendi (bağımlılıksız `zip-canonical.ts`).
İki ardışık üretim aynı sha256 **`f965a1ba745264497a425c180b9bf3d21445ae66cf0e418019666f16035770ee`**; `cmp` farksız;
`unzip -t` hatasız; 84/84 girdi sabit damgalı. Test ≥2 sn arayla iki üretim (7/7). Şablon `templates/…v2.xlsx` bu sha ile
yeniden üretildi; `/data/imports/v2/template` route'u aynı kodu çalışma zamanında koşturur → indirilen dosya = depodaki dosya.

## Gate

`IMPORT_V2_CORE = PASS` — koşullu tek not: dal birleşmesi.

## Dal birleşme kararı (önerilen, UYGULANMADI — kullanıcı onayı gerekir)

İki dal ayrık dosya kümelerine dokunuyor (release: radar/approvals/counterparties/controls + 0092/0093 + docs;
V2: importers/v2, data/imports/v2, authz route + next.config). Tek kesişme: `src/lib/authz/matrix.ts`/`route-access*`
(V2'de 16. route) ve `next.config.ts` (release: 7.4 provenance; V2: bodySizeLimit) — her ikisi de ayrı bölgelerde,
çakışma beklenmiyor. Önerilen sıra: `release/production-readiness-hardening` ← `feature/standard-import-v2`
(merge --no-ff), ardından birleşik dalda `pnpm db:migrate` fresh DB ve `tests/interaction/import-v2.spec.ts`.
Bu birleşme `git merge` gerektirdiği için yapılmadı ("otomatik merge yapma"); Phase 8 öncesi ayrı plan maddesi.
