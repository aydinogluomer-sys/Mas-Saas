# PHASE 1 — Repository & Environment Recovery

**Plan:** `implementation(20260912-211920).md` §PHASE 1
**Tarih:** 2026-09-13
**Dal:** `release/production-readiness-hardening`
**Gerçek DB:** dokunulmadı (Docker bu fazda hiç başlatılmadı)

---

## 1.1 Envanter — ölçüldü

| Ölçüt | Başlangıç (2026-09-13 00:40 UTC) |
|---|---|
| HEAD | `2e07b3c` |
| master'dan fark | 81 ileri, 0 geride |
| `feature/standard-import-v2` farkı | release 0 ileri / V2 6 ileri |
| Worktree sayısı | 10 (**6'sı ana projenin İÇİNDE**, 2'si kopuk Temp kaydı) |
| Takipli değişiklik | 5 (Telegram/env — kullanıcıya ait) |
| Takipsiz | 24 |
| C: boş alan | 11 GB / 238 GB |
| RAM boş | 0,38 GB / 7,9 GB |
| Docker | çalışmıyor |
| D: (yedek hedefi) | takılı değil |

## 1.2 Yerel işler — korundu

| İş | Bulunduğu yer | Aksiyon |
|---|---|---|
| **Import V2 P0/P1 düzeltmeleri** (para birimi, eşzamanlılık, migration hygiene; 8 dosya 385+/23−, 3 yeni script, 3 kanıt dosyası) | `Mas-Saas-Import-V2` VE `Mas-Saas-Readiness-20260912` — iki kopya, diff sha256 **birebir aynı** (`70c294dc…`) | **`feature/standard-import-v2` @ `f8eede7` olarak commit'lendi.** Readiness kopyası hâlâ commit'lenmemiş duruyor (dış worktree, sorun çıkarmıyor; içeriği artık git'te güvende). |
| Telegram/env çalışması (`src/app/api/telegram/`, `src/lib/telegram/`, `bot.py`, `src/middleware.ts`, `src/lib/env.ts`, `.env.example`) | ana worktree, takipli+takipsiz | **Dokunulmadı** — başka oturumun devam eden işi |
| `phase5a-wip-financing.patch` (31 KB) | repo kökü, takipsiz | `git apply --check` **başarısız** — Temmuz tabanlı, dokunduğu 15 dosya o zamandan beri Faz 38/auth ile değişmiş. `docs/release-evidence/archive/`'e taşındı, README ile açıklandı. **Silinmedi, uygulanmadı.** |
| `değildir`, `patch`, `yetkisi` | repo kökü | 0 bayt kabuk artığı — doğrulanıp silindi |
| `Mas-Saas-RC/…/p24b-v6/` (2 kanıt dosyası) | nested worktree içinde takipsiz | worktree ile birlikte taşındı, korundu |

## 1.3 Nested worktree'ler — dışarı çıkarıldı

`git worktree move` (aynı disk, rename, geri alınabilir). Tam kayıt: `phase1-worktree-move.log`.

| Worktree | SHA | Kaynak → Hedef |
|---|---|---|
| Mas-Saas-RC-9e23ad7 | 9e23ad7 | `Mas Saas/` içi → `C:\Users\Trade Bilisim\` |
| Mas-Saas-RC-c71366a | c71366a | aynı |
| Mas-Saas-RC-f076431 | f076431 | aynı |
| Mas-Saas-RC | 1675c92 | aynı |
| Mas-Saas-P1-Audit-Fix | 9e23ad7 | aynı |
| Mas-Saas-Import-V2 | f8eede7 | aynı (ilk deneme "Permission denied" — arka plandaki `du` kilitliyordu; durdurulup tekrar denendi) |

Kopuk Temp kayıtları (`audit-baseline-worktree`, `preflight-baseline-worktree`): dizinlerin yokluğu doğrulandı, `git worktree prune` ile temizlendi.

**Sonuç: 8 worktree, hepsi ana projenin dışında.**

## 1.4 TypeScript kapsamı — savunmalı

Önce: `"include": ["**/*.ts", "**/*.tsx"]`, yalnız `node_modules` hariç → 7 adet `.next-*` build dizini (her biri ~100 üretilmiş `.ts`) + 6 nested worktree (1138 dosya) taranıyordu.

Sonra:
```json
"include": ["next-env.d.ts", "*.config.ts", "src/**/*.ts", "src/**/*.tsx",
            "scripts/**/*.ts", "tests/**/*.ts", ".next/types/**/*.ts"]
```
`tsc --listFilesOnly`: **640 proje dosyası, `.next-*` dizinlerinden 0.**

`.gitignore`'a `/.next-*/` genel kalıbı eklendi (eslint.config.mjs zaten aynı kalıbı kullanıyor).
`package.json`'a `"packageManager": "pnpm@11.10.0"` eklendi.

## 1.5 Kabul — ölçüldü

| Kriter | Sonuç | Kanıt |
|---|---|---|
| `NESTED_WORKTREES` | **0** | `git worktree list` |
| `DIRTY_UNKNOWN_FILES` | **0** | her takipsiz dosya sınıflandırıldı (yukarıdaki tablo) |
| `LOCAL_IMPORT_V2_FIXES_LOST` | **0** | `f8eede7` |
| `TYPECHECK` | **PASS** | `pnpm typecheck` exit 0, 9,7 sn (önce OOM ile düşüyordu) |
| `LINT` | **PASS** | `pnpm lint` exit 0, 1 dk 20 sn (önce >5 dk zaman aşımı) |
| `UNIT_SERIAL` | **PASS** | `vitest run --maxWorkers=1 --no-file-parallelism` → **1442/1442**, 70 dosya, 90 sn |
| `BOUNDARY` | **PASS** | `pnpm boundary:verify` → 8/8 |

7 Eylül denetiminin **artık geçerli olmayan** bulguları: "typecheck 15 yinelenen tanım hatası" (nested worktree'lerdendi — gitti), "lint eslint-plugin-react-hooks bulunamadı" (store'da mevcut, lint çalışıyor), "7 test bash yüzünden FAIL" (1442/1442 geçiyor).

**Hâlâ geçerli:** RAM 0,38 GB (makine kısıtı — Defender + 2 Claude + 5 VS Code + Chrome), Docker kapalı, D: takılı değil. Bunlar Phase 7'nin konusu.

---

## GATE

```text
REPO_ENVIRONMENT_READY = PASS
ONE_CLEAN_TRUTH_SHA    = bu commit (release dalı)
```

**Not:** `feature/standard-import-v2` @ `f8eede7` release'ten 7 commit ileride. Phase 3 (Import V2 core) o dalın release'e alınmasını gerektirecek — ayrı karar.
