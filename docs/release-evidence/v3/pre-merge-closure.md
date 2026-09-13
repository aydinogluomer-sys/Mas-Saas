# PRE-MERGE CLOSURE — 2026-09-13

Amaç: Phase 2 provenance'ını remote'a bağlamak, Phase 5 release kapsamını karara indirmek, Telegram bulgusunun
release'i etkileyip etkilemediğini belirlemek. **Merge yapılmadı. Gerçek DB'ye dokunulmadı.**

## Repository

| | |
|---|---|
| readiness branch | `release/production-readiness-hardening` (main worktree) |
| HEAD_BEFORE (tur başı) | `135acf9` — **geçersiz kılındı**: bu commit `-a` ile kullanıcının commit'lenmemiş 5 dosyasını (`.env.example`, `env.ts`, `middleware.ts`, `module-tabs.tsx`, `08-performance-trend.jsonl`) yanlışlıkla içine almıştı; push edilmeden önce `reset --soft` ile açıldı, yalnız belge yeniden commit'lendi (`49a0186`, aynı mesaj), kullanıcı dosyaları çalışma ağacına **değişmeden** geri döndü (5 dosya, +31/−6, hâlâ uncommitted) |
| Phase 2 commit'leri | `e248f98` (Tier 2+3 kodu, 30 dosya) → `dbb96ce` (closure belgesi) → `49a0186` (sayı düzeltmesi) — hepsi HEAD'in atası |
| push (fast-forward, force yok) | `16c6d6c..49a0186` → origin; sonra `93cddfc` (Phase 5 belgesi) |
| import-v2 branch | `feature/standard-import-v2`: `12d322f..aa61115` push (8 commit: 3.7 determinizm, Phase 4 akışı+canlı kanıt, 6.2 prova) → sonra `4ca2b42` |
| master | `093573e` = origin/master, dokunulmadı |

## Phase 2 provenance hard gate (HEAD ağacında)

`src/lib/currency-policy.ts` YES · 0092 YES · 0093 YES · 0094 YES (21 view) · `liquidity_forecast_daily` fatura ayağı `v.currency` YES ·
Tier 2 TS izleri 21 dosya `PHASE 2.2 (#n)` · `tests/financial/currency-policy-tier2.test.ts` YES · `scripts/db/tier2-loaders-smoke.ts` YES ·
kanıt belgeleri (scan, tier1, tier2-tier3) YES. Migration sırası 0087 → 0092 → 0093 → 0094 (0088–0091 import-v2 dalında).

## Phase 5 — bkz. `phase5-product-decisions.md` (canonical)

TRY-only CLOSED · multi-currency DEFERRED · AKR/Çağdaş USER_DECISION_REQUIRED · checks total PROVISIONAL (590.000, karara göre 345.000) ·
opening balance CLOSED · 49 kolon CLASSIFIED (40/9/0/0, UNCLASSIFIED 0) · 15_MALIYET DEFERRED_TO_V1_1.
Kod: `4ca2b42` (V2) — para birimi kolonu olmayan 7 tabloya TRY-dışı satır örtük TRY olarak yazılmaz; önizleme metni politikayı söyler.

## Telegram

`src/app/api/telegram/assistant/route.ts` + `src/lib/telegram/*`: `git ls-files` 0, `git log --all` 0 commit, hiçbir dalda (local/remote) yok →
**kullanıcının ayrı, commit'lenmemiş çalışması**. `TELEGRAM_RELEASE_SCOPE = OUT`, dosyaya dokunulmadı. Handler'ın kendi açıklaması:
makine-makine rota, çerez yok, sabit-zamanlı paylaşılan-sır + Chat ID kontrolü — `checkOrigin()` sözleşmesinin dışında olabilir; karar
o çalışmanın sahibine ait. Security matrix: committed ağaçta (V2 worktree) **17/17**; ana worktree'de untracked dosya yüzünden 16/17.

## Quality gates (bu turun HEAD'leri)

| Gate | Release `93cddfc` | Import V2 `4ca2b42` |
|---|---|---|
| typecheck | PASS | PASS |
| lint | PASS (0) | PASS (değişen dosyalar) |
| unit serial | 72 dosya / **1477** | 76 dosya / **1636** |
| build | PASS (`Compiled successfully in 108s`, BUILD_ID = HEAD SHA `93cddfc…`) | PASS |
| financial targeted | 202/202 (tests/financial + radar + approvals + counterparties) | — |
| legacy regression (TEMİZ, disposable DB 0001–0087+0092–0094+seed) | phase3/4/5 **ALL PASS** | — |
| import V2 core (fresh DB, `db:migrate` 0001–0091) | — | e2e 69/69 · concurrency 18/18 · currency 9/9 |
| import V2 product flow (canlı, üretim derlemesi) | — | **8/8** (39,8 s) |
| security matrix | 16/17 (untracked telegram) | **17/17** |
| roles-rls | 29/29 | — |

Gözlem (kapatılmadı, kapsam dışı): canlı akış spec'inin ilk tam koşusunda onay adımı bir kez 180 s'de sonuç paneli göstermedi —
import DB'de **commit edilmişti** (54 satır, 34 anahtar); tekrar koşuda 10,8 s ve 8/8. Aynı koşuda `refreshMetricSnapshots`
`metric_snapshots_check` ihlali logladı (`part_margin_average/min`: üretim parçası yokken value null + unknown 0) — eylem bunu yutuyor,
import etkilenmiyor; backlog: sparse veri setinde snapshot toplayıcı.

## Gerçek DB

Docker DOWN (`docker info` başarısız) → `mas_radar_dev`'e bu turda hiçbir bağlantı kurulamadı; `docker_data.vhdx` son yazım
**2026-09-05 14:41:36** (değişmedi). INSERT/UPDATE/DELETE/DDL/MIGRATION/IMPORT = 0. Parmak izi: NOT_MEASURABLE (erişilemez) — VHDX
mtime makine düzeyinde "değişmedi" kanıtıdır. Tüm doğrulamalar taşınabilir PostgreSQL 16.14'te (`C:\Users\Trade Bilisim\mas-verify-pg`,
oturum sonunda durduruldu; TEMİZ verisi taşıyan DB'ler silindi).

## Karar

`MERGE_TO_RELEASE = NO` · **`READY_FOR_MERGE_GATE = YES`** — koşullar: Phase 2 remote provenance tamam, iki dal temiz ve remote ile eş,
Phase 5 kapsamı sınıflandırılmış (2 kullanıcı kararı bloke etmiyor: kod güvenli davranıyor), Telegram kapsam dışı kanıtlı, gate'ler yeşil.

Sonraki tur: `IMPORT V2 → RELEASE MERGE + ONE ACCEPTED SHA + FULL MERGED GATE` (0088–0091 + 0092–0094 birleşik sıra fresh DB,
`counterparty_exposure_items` gerçek kolon yolu, `/version` provenance, interaction spec birleşik dalda).
