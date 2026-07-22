# Iteration 14 — Strategic Daily Payment Pressure

## Result: PASS (91/100)

The payment-pressure experience now reads all overdue open instances plus the next 24 calendar months, renders mutually exclusive stacked overdue/partial/planned balances, and adapts day/week/month density by horizon. The supplied strategic PDF is represented only by a deterministic 120-record test fixture.

## Engineering evidence

- TypeScript: PASS.
- ESLint: PASS with zero warnings in the affected scope and full run.
- Vitest: PASS, 17 files / 178 tests.
- Production build: PASS; `/payments` included as a dynamic route.
- PDF reconciliation: 120 records, 61,687,568.10 TL, 8 overdue records, 2,116,476.80 TL and 5/3/0 ageing buckets pass.
- Browser interaction script: 3A/6A/12A/24A/all URL state, adaptive granularity, zoom, focus/Escape, reset, purple partial series and no page overflow pass at 1920, 1440, 1024 and 390 widths.
- TestSprite: BLOCKED externally. Authentication succeeds, but the configured temporary Cloudflare hostname no longer resolves; no stale deployment was tested.

## Visual score

| Category | Score | Evidence and remaining uncertainty |
| --- | ---: | --- |
| Composition | 18/20 | Strategic horizon leads into chart, then ageing/flexibility/watch list. Long payment pages remain intentionally information-dense. |
| Typography | 13/15 | Clear hierarchy and tabular figures; small operational labels remain compact on 390 px. |
| Visual system | 14/15 | Overdue red, partial purple and planned blue are visibly distinct; partial also uses a circular legend marker and white segment edge. |
| Interaction and motion | 14/15 | Period, granularity, zoom, range, focus/Escape, legend and CSV operate. Pointer tooltip timing was not visually recorded by the fallback runner. |
| Responsive behavior | 19/20 | 1920/1440/1024/390 report zero document overflow. Dense tables use contained horizontal scrolling. |
| Accessibility | 9/10 | Accessible chart summary/table, focusable marks, non-color labels and reduced-motion visual mode are present. Full screen-reader software was not available. |
| Originality and brand fit | 4/5 | Strategic horizon and honest unknown-value treatment fit the financial-operations product language. |

## Rendered evidence

- `awwwards-loop/iterations/iteration-14-1920-payments.png`
- `awwwards-loop/iterations/iteration-14-1440-payments.png`
- `awwwards-loop/iterations/iteration-14-1024-payments.png`
- `awwwards-loop/iterations/iteration-14-390-payments.png`

The browser-plugin connection was unavailable because its sandbox metadata was rejected. The project-local Chromium fallback rendered and inspected the actual production build rather than substituting build success for visual evidence.

## Hard gates

- Build/tests: PASS.
- Primary interactions: PASS.
- Overflow/clipping: PASS for the requested viewport widths.
- Accessible names/focus: PASS in Playwright locators.
- Reduced motion: PASS under deterministic `data-vr` mode; no chart animation was introduced.
- Financial integrity: PASS; null amounts remain null and source records are not mutated by analytics.

No category is below 70% and the total exceeds 90. The iteration passes locally; TestSprite remains an external staging-host blocker rather than a product-code failure.
