# Iteration 06 Report — Analytics Foundation

- Date: 2026-07-13
- Server: `http://127.0.0.1:3103` (local development, isolated PostgreSQL)
- Evidence: `tests/visual/__snapshots__/analytics.spec.ts-snapshots`
- Result: **PASS — 91/100** for the Iteration 06 foundation scope

## Delivered

1. A shared `ChartModel` contract with nullable values, confidence/freshness metadata, annotations and source provenance.
2. A hybrid SVG/React chart surface with line and grouped-bar views, keyboard-focusable marks, series visibility, 3/6/12/24/all period controls, CSV export, print action, zero line, accessible summary and a disclosure table generated from the same model.
3. Pure analytics adapters for cash trend, income/expense/net movement, payment pressure, debt service, capacity utilization, part margin and historical metric series.
4. Adoption on six canonical routes: cashflow overview, monthly cashflow, payments overview, finance overview, capacity and part profitability.
5. `metric_snapshots` migration with a unique daily metric/dimension key, source cutoff, unknown count, confidence and audit trail.
6. Snapshot collection after successful imports and daily reports, plus a manual System action. Local verification produced 15 metrics; a second same-day run remained `15 total / 15 unique`.
7. The central implementation document now contains Iterations 06–12 and a grouped G001–G130 gap register.

## Defects found and fixed during QA

- The first visual pass was unstyled because a stale Next development process was serving obsolete `.next` chunks. The process was replaced and the complete suite re-run.
- React 19 reported arrays inside SVG `<title>` nodes. Mark descriptions now resolve to one template-string child, eliminating the development issue overlay and repeated server warnings.
- Parallel cold compilation made long full-page screenshots time out. Analytics regression is serialized, uses `domcontentloaded`, and has an explicit screenshot timeout.

## Engineering gates

| Gate | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` | PASS — 171/171, 16 files |
| `npx next build` | PASS — all canonical routes generated |
| `npm run build` | BLOCKED by a Windows Turbopack path panic caused by the space-containing workspace path; webpack/default Next build passes |
| Snapshot idempotency | PASS — 15 total / 15 unique after two refreshes |
| Analytics visual regression | PASS — 12/12 at 1440×900 and 390×844 |
| Horizontal body overflow assertion | PASS — 12/12 |
| TestSprite preflight | Authenticated, project found; run intentionally blocked because the saved target is an obsolete public Cloudflare tunnel and the plan prohibits exposing the financial local DB |

## Rubric

| Category | Score | Evidence |
|---|---:|---|
| Composition | 19/20 | Charts preserve the module-first hierarchy and first-view KPI limit. |
| Typography | 14/15 | Shared financial number formatting and compact axis labels. |
| Visual system | 14/15 | Semantic token colors and consistent chart chrome; additional chart families remain Iterations 07–09. |
| Interaction and motion | 14/15 | Periods, series controls, keyboard marks, CSV and print; pointer tooltip and image export remain open. |
| Responsive behavior | 19/20 | Six routes pass desktop/mobile snapshots without body overflow. |
| Accessibility | 9/10 | Shared summary/table, SVG labels and focusable marks; screen-reader matrix still needs external assistive-technology testing. |
| Originality and brand fit | 2/5 | Deliberately restrained finance cockpit; richer Pareto/waterfall/scatter visuals are scheduled next. |
| **Total** | **91/100** | **PASS for Iteration 06; the complete Iterations 06–12 roadmap is not represented as finished.** |

## Next iteration failures converted to work

1. Implement tooltip positioning shared by pointer and focus; add visible annotation rendering.
2. Add SVG export first, then deterministic PNG export without introducing a large chart library.
3. Build heatmap, waterfall, Pareto, bullet and scatter primitives with the same accessible table contract.
4. Wire historical decision-confidence and payment-performance charts after sufficient real snapshot history exists.
5. Move TestSprite to a masked staging database and stable HTTPS preview; never reuse the obsolete tunnel target.
