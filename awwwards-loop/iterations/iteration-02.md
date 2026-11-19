# Iteration 02 — Defect Closure & Final Polish

## Inputs

- Previous report: `../reports/iteration-01.md` (`84/100`, Hard Gates failed on 2 defects)

## Failed criteria from Iteration 01 converted into fixes

1. **`/cashflow/13-week` SQL Column Mismatch (`jl.debit` -> `jl.debit_try`):**
   - Fixed TDHP `190` carryforward query in `src/lib/cashflow/rolling-13w-engine.ts` (`coalesce(jl.debit_try, 0) - coalesce(jl.credit_try, 0)`).
   - Audited entire repo for any sibling `jl.debit` reference and fixed `src/app/(dashboard)/finance/profitability/page.tsx` (`management_accounts` + `jl.debit_try` / `jl.credit_try`).
2. **`/finance/ledger` Tablet (`768×1024`) `3px` Horizontal Overflow:**
   - Updated the 5-card KPI row in `src/app/(dashboard)/finance/ledger/page.tsx` from `grid-cols-2 sm:grid-cols-5` to `grid-cols-1 sm:grid-cols-2 xl:grid-cols-5` so tablet (`768px`) renders a spacious 2-column grid with `0px` overflow.
3. **Chart Y-Axis Visual Proof Framing:**
   - Updated `scripts/qa/live-awwwards-qa.ts` to scroll the SVG canvas into center frame before capturing `3A` vs `Tümü` comparison screenshots and enforce `consoleErrorCount === 0` as a hard gate.

## Verification

- Stop stale port 3000 server, run `pnpm typecheck` + `pnpm build`, restart `pnpm start`, re-run `live-awwwards-qa.ts` (`ITERATION=02`) and `benchmark-60ms-buttons.ts`.

