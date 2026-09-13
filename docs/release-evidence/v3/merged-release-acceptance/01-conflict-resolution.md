# 01 — Conflict resolution

```text
CONFLICTS = 0
```

İki dalın da dokunduğu yalnız üç dosya vardı ve üçü de git tarafından otomatik, semantik olarak doğru birleşti:

| Dosya | Release tarafı | V2 tarafı | Sonuç |
|---|---|---|---|
| `.gitignore` | `/.next-*/` (Phase 1) | `/.next-*/` (Phase 4) | iki satır (aynı desen, iki blokta) — davranış aynı, kozmetik tekrar |
| `next.config.ts` | 7.4 provenance (`generateBuildId`, `env.APP_COMMIT_SHA/APP_BUILD_TIME`) | `experimental.serverActions.bodySizeLimit = 52mb` (+ `cpus`) | ikisi de mevcut (satır 40 / 75–81) |
| `package.json` | `packageManager: pnpm@11.10.0` | `import:*:v2` script'leri | ikisi de mevcut |

Kod dosyalarında (`src/`, `supabase/`, `scripts/`, `tests/`) örtüşme yok; final ağaç iki tarafın tamamını taşır.
