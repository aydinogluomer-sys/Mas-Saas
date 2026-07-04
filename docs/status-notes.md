# Status Notes

## Phase 0 — DONE
- Next.js 15 + TS strict + Tailwind + ESLint scaffold (pnpm), src-dir, App Router.
- Parser spike (`src/lib/importers/workbook-parser.ts` + `scripts/parse-spike.ts`): signature-guarded safe open; TR-normalized ad tabanlı sınıflandırıcı, DB enum'larıyla birebir.
- Evidence: `docs/phase0-parse-report.md` — orijinal 42 sekme / TEMİZ 43 sekme tam sınıflı, sıfır sessiz atlama; bozuk TEMİZ-4 imza hatasıyla belgeli.
- Docs: import-mapping.md + calculation-rules.md yazıldı; data-map.md v3 kanıt-tabanlı yeniden yazıldı; risk-register ortam riskleri eklendi.
- QA gate: typecheck ✓ · lint ✓ · vitest 23/23 ✓.
- Not: todo.md'deki "source_* migrations" maddesi implementation.md §20'ye göre Faz 1 teslimatıdır; Faz 1'e taşındı (kaynak-of-truth: implementation.md).
- Not: exceljs kuruldu, Faz 2'de formül/stil çıkarımı için ayrılmıştır; spike xlsx ile yeterli.
