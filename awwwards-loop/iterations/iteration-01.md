# Iteration 01 — Executive Light UI, MasChartEngine v2 & Multi-Entity Cockpit

## Inputs

- Implementation plan: `../implementation.md`
- Master architectural plan: `M-01..M-68`

## Failed criteria from pre-loop audit addressed in Iteration 01

1. **Chart Y-Axis Logic Bug:** Switching period filters (`3A` / `6A` / `12A` / `Tümü`) previously sliced X-axis points without recomputing `niceScale(min, max)` on the visible window, leaving vertical amplitude flat. Resolved in `src/lib/analytics/chart.ts` (`sliceChartWindow` + `niceDomain`) and `src/components/charts/analytics-chart.tsx`.
2. **Dark-Surface Remnants:** Purged all remaining `bg-zinc-900`, `bg-slate-900`, `border-zinc-800`, and `bg-[#12131a]` classes across `/data/imports`, `/system/controls`, `/system/diagnostics`, and import preview components in favor of Warm Cream Executive Light tokens (`var(--surface)`, `var(--surface-2)`, `var(--line)`).
3. **Executive Information Architecture:** Added group-internal `EntitySwitcher` (`Konsolide Grup` / `Tüzel Kişilik` / `Şube`) in the top bar, 3-Step Interactive Column-Mapping Wizard on `/data/imports`, and full BOM/Inventory/Work-Order/OEE surfaces on `/production`.

## Verification Plan

- Capture live Playwright screenshots across `1366×900`, `768×1024`, and `375×812` viewports on `http://localhost:3000`.
- Assert programmatic Y-axis rescaling when toggling period buttons (`3A` vs `12A` / `Tümü`).
- Measure `<= 60 ms` button/tab interaction feedback (`INP`).
- Score against the 7-category 100-point rubric in `../reports/iteration-01.md`.
