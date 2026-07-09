# MAS Nakit Radar UI/UX Quality Loop

## Objective

Make the app feel highly polished and easy to use while keeping every module reachable. The interface should be decision-first, calm, dense enough for finance operations, and not visually crowded.

## Baseline Scope

- Primary route: `/`
- Module discovery route: `/admin`
- Decision support routes sampled in QA: `/ask`, `/data-quality`, `/scenarios`
- Viewports: 1366x900, 768x1024, 375x812

## Iteration 01 Plan

1. Reduce visible top-nav crowding without removing modules:
   - keep daily decision routes visible;
   - make admin/module access feel like a grouped command surface;
   - improve wrapping and mobile header behavior.
2. Upgrade the visual system:
   - add calmer page background depth;
   - improve panel/card hover and focus polish;
   - keep restrained operational styling, not a marketing look.
3. Improve dashboard usability:
   - make "20 saniyede cevap" the clear focal element;
   - keep action cards scannable with proof links;
   - prevent dense text from collapsing badly on mobile.
4. Improve admin/module discoverability:
   - show all modules in grouped tiles;
   - make local production/ops status readable without overwhelming the page.

## Acceptance Criteria

- No module route is removed.
- Desktop, tablet, and mobile screenshots show no horizontal overflow or text collision.
- Primary actions and nav links have visible focus styles.
- Build, typecheck, lint, and unit tests pass.
- Visual score target: at least 90/100 with no category below 70%.

## Browser Tool Note

In-app Browser MCP setup failed in this session with a sandbox metadata error. Iteration 01 will use standalone Playwright screenshot evidence and record that limitation in the report.

## Iteration 02 Plan

Driven by visual evidence from `iteration-01b-*`:

1. Fix admin desktop rhythm:
   - avoid equal-height grid rows that make small module groups look like empty oversized cards;
   - use independent column stacks so every module remains visible without visual dead space.
2. Compress local production status:
   - keep health/version/backup/import/confidence/runbook visible;
   - turn nested cards into a compact status rail that scans in one row on desktop and clean rows on mobile.
3. Preserve mobile quality:
   - keep single-row top nav;
   - keep module groups readable in one column;
   - verify no overflow or text collision after the layout change.
4. Complete quality-loop reporting:
   - write a scored iteration report with screenshots, hard gates, defects, next actions, and tool limitation.

## Iteration 03 Plan

Driven by Iteration 02 report:

1. Inspect the remaining high-value modules:
   - `/ask`, `/data-quality`, `/cashflow`, `/scenarios`, `/production`;
   - capture desktop/tablet/mobile viewport screenshots route-by-route to avoid Windows pagefile pressure.
2. Improve dense operational surfaces:
   - standardize form controls, buttons, and table rows through shared CSS classes;
   - reduce card-in-card feeling on analysis routes;
   - raise contrast for meaningful descriptions currently using very muted text.
3. Strengthen decision-product signature:
   - make question/scenario/action entry points feel like compact command bars;
   - keep technical detail in disclosure/table regions instead of first-glance panels.
4. Verify:
   - `typecheck`, `lint`, `test`, `build`, `git diff --check`;
   - `/health`;
   - screenshot/overflow evidence for the newly inspected modules.
