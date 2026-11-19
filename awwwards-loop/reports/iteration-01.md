# Iteration 01 — Scored Visual & Engineering QA Report

## Summary

- **Iteration:** `01`
- **Hard Gates Passed:** `NO` (2 defects detected in live browser run)
- **Total Score:** `84 / 100` (Blocked by hard gate -> advancing to Iteration 02)

## Hard Gates Checklist

- [x] Build, TypeScript (`tsc --noEmit`), ESLint, Vitest unit suite, and disposable PostgreSQL gates (`0001..0119`) passed
- [x] Browser screenshots captured at `1366×900`, `768×1024`, and `375×812` (`24` route×viewport checks)
- [x] Dark-mode card remnants: `0` across all 24 checks
- [x] Chart Y-Axis Dynamic Rescaling verified (`3A`: `["218,5 B","163,9 B","109,2 B","54,6 B","0"]` -> `Tümü`: `["586,5 B","439,9 B","293,3 B","146,6 B","0"]`)
- [ ] **FAILED HARD GATE 1 — Runtime Console/Render Error:** `/cashflow/13-week` logged a Server Component error (`column jl.debit does not exist` in TDHP `190` Devreden KDV query; schema column is `jl.debit_try` / `jl.credit_try`).
- [ ] **FAILED HARD GATE 2 — Horizontal Overflow:** `/finance/ledger` at `768×1024` (Tablet) produced `3px` horizontal overflow (`sm:grid-cols-5` squeezed 5 KPI cards into 768px).

## Rubric Breakdown (Iteration 01)

| Category | Score | Max | Pct | Notes |
| --- | ---: | ---: | ---: | --- |
| 1. Concept, Art Direction, Brand Fit | 14 | 15 | 93% | Cohesive Warm Cream Executive Light (`#FCFCF9` / `#FFFFFF`), multi-entity header, zero dark remnants. |
| 2. Typography and Hierarchy | 13 | 15 | 87% | `Geist Sans` + `Geist Mono` `tabular-nums`; tablet KPI values clipped on `/finance/ledger`. |
| 3. Layout, Rhythm, Responsive Craft | 11 | 15 | 73% | `3px` overflow on `/finance/ledger` at `768×1024`; all other 23 checks `0px` overflow. |
| 4. Surfaces, Color, Polish | 14 | 15 | 93% | Crisp 1px warm borders, semantic status badges, clean empty states. |
| 5. Motion and Interaction | 14 | 15 | 93% | Dynamic Y-axis rescaling + scale-mode toggle + multi-currency tabs responsive. |
| 6. Content, UX Clarity, Accessibility | 13 | 15 | 87% | Honest R10 unknown-value handling (`Açılış Belirsiz`, `—`); `/cashflow/13-week` error boundary tripped. |
| 7. Engineering Quality and Performance | 5 | 10 | 50% | Penalized for `jl.debit` runtime SQL column mismatch on `/cashflow/13-week`. |
| **Total** | **84** | **100** | **84%** | **Must fix both defects in Iteration 02** |

