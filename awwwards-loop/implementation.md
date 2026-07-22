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

## Iteration 04 Plan — Module-Oriented Information Architecture

### Scope

- Replace the crowded top navigation with a desktop-first collapsible sidebar and compact workspace header.
- Group all existing capabilities into nine workspaces: Overview, Payments, Cash Flow, Finance, Production, Scenarios, Insights, Data Center, and System.
- Add module tabs, command palette, breadcrumbs, freshness/task indicators, and consistent decision-first page hierarchy.
- Preserve every server action, calculation engine, database table, audit behavior, and existing deep link through redirects or compatibility routes.

### Phases

1. Build the application shell and shared module-navigation primitives.
2. Add the new route hierarchy and compatibility redirects.
3. Recompose daily finance workspaces (overview, payments, cash flow, finance).
4. Recompose analytics and support workspaces (production, scenarios, insights, data, system).
5. Run engineering gates, then browser QA and responsive iteration.

### Acceptance Criteria

- All 33 documented capabilities remain reachable within three interactions.
- No financial calculation, mutation, schema, or API contract changes.
- Required viewports: 1366x900, 768x1024, 375x812 with no clipping or horizontal page overflow.
- Keyboard focus, accessible names, reduced motion, primary interactions, and Turkish labels pass the hard gates.
- `typecheck`, `lint`, `test`, `build`, and `git diff --check` pass.
- Visual quality score reaches at least 90/100 with no category below 70%.

### Baseline Evidence

- Current shell uses a horizontally scrolling seven-item abbreviation nav and a link-dense `/admin` module directory.
- Existing module pages already expose the underlying functions; this iteration changes information architecture and presentation, not business logic.
- Existing visual evidence remains in `awwwards-loop/iterations/`; Iteration 04 will capture the new shell and representative workspaces at all required viewports.

## Iteration 05 Plan — Awwwards-Grade Polish (Single Token System, Typography, Motion)

### Scope

- Fix user-visible defects: mojibake em-dash on the overview hero stat; UTC-vs-Istanbul "today" mismatch on radar, calendar, cashflow, and financing page reads.
- Add Geist Sans + Geist Mono via the locally bundled `geist` npm package (no Google Fonts egress; `next/font/local` under the hood), wired through Tailwind v4 `@theme` `--font-sans` / `--font-mono`.
- Migrate all ~248 hardcoded Tailwind palette classes (zinc/emerald/sky/red/amber) across 25 files onto token utilities defined in `globals.css` with `@utility` (`text-tone-*`, `text-pos/neg/warn/info`, `border-line*`, `bg-surface-*`, `bg-pos/neg/warn/info`, `border-pos/neg/warn/info`, `tint-*`, `decoration-line-strong`).
- Wire the previously dead entrance-motion system: `.animate-rise` on the workspace main, `.stagger` on hero stat grids, fade/rise on the command palette. Frozen under `prefers-reduced-motion` and `[data-vr="1"]`.
- Unify buttons on `.button-accent` / `.button-ghost` / new `.button-primary` (tokenized inverted chip); unify corner radii on a 3-step scale (`--radius-sm/md/lg`); add `.row-hover` to payment/risky-day list rows.
- Tokenize all SVG chart colors (`var(--pos/--neg/--info/--warn/--text-4)`), add mid gridlines, month x-axis labels, and edge-safe annotation anchoring; tokenize Badge tone colors via `color-mix`.
- Complete the iteration-03 empty-state punch list: `ModuleEmptyState` for empty `/financing`; `EmptyState` panels for `/imports`, `/reports`, `/reminders`, `/assumptions`.

### Acceptance Criteria

- Zero remaining raw palette classes or hex colors in `src/**/*.tsx`.
- No financial calculation, mutation, schema, or API contract changes (server-action UTC dates intentionally untouched).
- `typecheck`, `lint`, `test`, `build`, `git diff --check` pass; visual snapshots re-baselined intentionally.
- 9 routes x 3 viewports captured with zero horizontal overflow; accessibility probe passes on all 9 workspaces.
- Visual score >= 90/100 on the 7-category rubric and an Awwwards-axes estimate of >= 90.

## Iteration 06 — Analytics & Product Completion

### Objective

Turn the current three static SVG charts into a reusable, evidence-backed analytics system without moving financial calculations into the UI. Unknown values remain null, source records remain immutable, and every chart has an accessible data equivalent.

### P0 Deliverables

1. Define `ChartModel`, `ChartSeries`, `ChartPoint`, `ChartAnnotation`, shared financial formatters, period filters, and deterministic tick/scale helpers.
2. Build dependency-free SVG primitives for time series, grouped/stacked bars, waterfall, bullet, Pareto, scatter, heatmap and variance views.
3. Add keyboard-addressable marks, SVG `<title>` tooltips, series patterns, critical annotations, accessible summaries/tables, CSV export and print-safe output.
4. Replace cashflow and scenario legacy SVG internals with the common model while keeping their public component contracts compatible.
5. Add high-value charts to overview, payments, finance, production, scenarios and data quality. A chart must answer a decision question; decorative charts are prohibited.
6. Add `metric_snapshots` with idempotent daily keys, confidence, unknown count, source cutoff, JSON context, audit logging and read-only source behavior.

### Data Integrity Rules

- A chart accepts a `ChartModel`, never a raw database row.
- Null is a gap, never zero. CSV exports use an empty cell for null.
- Snapshot generation may write only `metric_snapshots` and `audit_logs`.
- Scenario sensitivity runs are ephemeral unless the user explicitly saves a scenario.
- No probability band or forecast fan is drawn without a real probability model.
- Europe/Istanbul is the date boundary for day/week/month grouping.

### Route Rollout

- Overview: 12-month closing trend and 30-day payment pressure.
- Payments: pressure bars, ageing buckets and calendar intensity.
- Cashflow: closing/opening trend, income/expense/net and debt overlay; month waterfall.
- Finance: debt-service stack, maturity ladder, exposure Pareto and loan amortization.
- Production: capacity bullet, break-even comparison, profitability scatter and ROI/payback.
- Scenarios: baseline/scenario/delta, A/B comparison and optimization frontier.
- Data: confidence history, review backlog, reconciliation variance and workbook coverage.
- Insights/System: task, reminder, audit, import and backup operational trends only where real history exists.

### Gap Register

| Range | Priority | Area | Required outcome | Verification |
|---|---|---|---|---|
| G001-G010 | P1 | IA/routes | Canonical detail routes, breadcrumb, real freshness/task state, common URL filters and broader command search | route map + keyboard navigation |
| G011-G020 | P1 | Tables | Shared sortable/paged/sticky table, mobile alternative, totals and CSV | component + viewport tests |
| G021-G030 | P1 | Actions | Pending/success/error/duplicate feedback, validation, undo, loading/error boundaries | server-action integration tests |
| G031-G040 | P0 | Evidence | Evidence drawer, formula/input/source cutoff/confidence/freshness/unknown disclosure | source-trace tests |
| G041-G052 | P1 | AI | Timeout, structured sections, safe errors, audit version, data classification, model disable and feedback | deterministic/fallback/security tests |
| G053-G064 | P1 | Scenarios | Search/archive/copy/templates/baseline freshness/sensitivity/export/task/report | scenario integrity tests |
| G065-G078 | P0/P1 | Data quality/import | History, ageing, bulk review, diff/coverage/result summary, test DB guard and rollback | import + destructive-test isolation |
| G079-G088 | P1 | Assumptions | Versioning, expiry, overlap, provenance, usage links and re-review | approval-gate tests |
| G089-G100 | P1 | Tasks/reports/reminders | Comments, recurrence, ageing, scheduling, delivery health and decision timeline | workflow tests |
| G101-G116 | P1/P2 | Security/ops | Rate limit, headers, external timeouts, structured logs, backup verification, indexes, retention, safe staging | security/ops checks |
| G117-G130 | P0 | A11y/responsive | Keyboard tooltip, accessible tables, adaptive axes, non-color semantics, print and all viewport evidence | browser matrix |

The detailed G001-G130 descriptions and acceptance intent are the user-approved Analytics & Product Completion plan for this iteration and are treated as normative requirements. Implementation status is tracked in iteration reports rather than duplicated into competing planning files.

### Engineering Gates

- `typecheck`, `lint`, unit tests, production build and `git diff --check` pass.
- Destructive phase scripts refuse to run against the ordinary development database.
- Financial fingerprints are unchanged before/after chart and snapshot generation.
- Canonical routes return expected HTTP status and legacy routes preserve redirects.
- Chart marks have accessible names; visual and tabular values match.

### Browser Matrix and Hard Gates

- 1920x1080, 1440x900, 1366x900, 1024x768, 768x1024, 390x844 and 375x812.
- No page overflow, tooltip clipping, unreadable functional text, missing focus, broken primary action or attention-seeking reduced-motion animation.
- Score >= 90/100; every rubric category >= 70%; browser evidence is mandatory.

## Iteration 07 — Daily Finance Analytics

Deliver payment heatmap/ageing, cashflow debt pressure, finance maturity/exposure and overview compact trends. Add point-to-detail navigation and URL period persistence.

## Iteration 08 — Production and Scenario Analytics

Deliver capacity/break-even/profitability/ROI charts plus scenario delta, sensitivity, frontier and A/B views. Keep all outputs labelled analytical estimates and source-immutable.

## Iteration 09 — Historical Quality Analytics

Activate daily snapshots on import/report/manual refresh; display confidence, backlog, payment completion, task and freshness trends. Never fabricate pre-migration history.

## Iteration 10 — Shared Operational UX

Deliver DataTable, FilterBar, EvidenceDrawer, inline results, loading/error/not-found boundaries, export and canonical shared screens. Remove direct page SQL where a domain loader is appropriate.

## Iteration 11 — Security, Operations and Performance

Require isolated test DBs for destructive verification, add external-call timeout/retry, password throttling, security-header tests, snapshot indexes, backup verification and structured operational logging.

## Iteration 12 — Final Quality Loop

Inspect all nine workspaces at every required viewport, score the rubric, turn every failure into the next iteration and stop only on PASS or a documented repeated external blocker.

## Iteration 06B — Instant Navigation Performance

## Iteration 13 — Financial Visibility, Chart Exploration & Record Lifecycle

### Baseline

- Payment charts group by raw database status, so overdue open instances remain under `unpaid`; the demo set has no lifecycle variety.
- Forward-looking finance charts slice the last array entries instead of anchoring 3/6/12/24-month windows to `asOf`; checks can disappear behind later installments.
- The shared SVG chart has period and series toggles but no focus mode, range zoom, keyboard point navigation, or useful pointer tooltip.
- Payment history only reads currently paid instances. Archive visibility is limited to hidden payment templates and has no restore/central search path.
- Overview repeats the same risk across headline, KPI, decision signals, action cards, evidence links, and open proof disclosures.

### Phases

1. **Semantic repair:** derive mutually exclusive overdue/partial/planned payment series, remaining balances, forward chart ranges, visible empty-series explanations, and Turkish copy.
2. **Chart exploration:** add zoom/reset, range pan, focus dialog, series focus, keyboard/pointer tooltip, visible-range CSV, responsive height, and URL-backed state.
3. **Lifecycle history:** build an audit-backed payment timeline with status/date/search filters and representative demo lifecycle records.
4. **Record lifecycle:** standardize archive/restore metadata, audit events, safe permanent-delete eligibility, and module actions for editable financial records.
5. **Archive surfaces:** expose module archive tabs plus `/system/archive` central search without deleting source/audit/history records.
6. **Overview redesign:** retain four decision KPIs, five actions, two compact trends, one contextual evidence drawer, and a compact operational strip.
7. **Quality loop:** unit/integration tests, production build, responsive browser evidence, accessibility/reduced-motion checks, and masked-staging TestSprite.

### Gap register

| ID | Priority | Gap | Target | Dependency | Acceptance |
| --- | --- | --- | --- | --- | --- |
| FV-01 | P0 | Overdue/planned payment series absent | Date-derived mutually exclusive series | Payment read model | Past open rows appear only in overdue; future open rows appear in planned |
| FV-02 | P0 | Checks disappear from finance chart | `asOf`-anchored forward window | Chart period contract | Every in-window check is visible or has an explicit exclusion reason |
| FV-03 | P0 | Small series cannot be inspected | Zoom, focus, pan, tooltip, series focus | Shared chart client | Mouse, touch, and keyboard inspection pass |
| FV-04 | P0 | Payment history appears broken | Audit-backed lifecycle timeline | Audit + instance loaders | Paid, partial, reopened, cancelled filters return correct events |
| FV-05 | P0 | Archived records are hidden | Module and central archive with restore | Schema lifecycle metadata | Archive/restore is audited and source records remain intact |
| FV-06 | P1 | CRUD is inconsistent | Contextual add/edit/archive menus | Shared action result | Editable entities expose safe actions; immutable evidence does not |
| FV-07 | P0 | Overview repeats technical evidence | Compact decision cockpit + evidence drawer | Decision facts | 1440×900 first viewport answers today/risk/action questions |
| FV-08 | P0 | Unknown values can look like empty zero bars | Explicit null/exclusion presentation | Chart models | Unknown values never render or export as zero |

### Acceptance and evidence

- TypeScript, ESLint, unit tests, production build, and affected Playwright flows pass.
- Browser evidence covers 1920×1080, 1440×900, 1366×900, 1024×768, 768×1024, 390×844, and 375×812.
- Hard gates: no broken primary action, overflow, inaccessible name/focus, fabricated zero, or reduced-motion violation.
- Awwwards score is at least 90/100 with every category at or above 70%; failures become the next iteration.

### Objective and baseline

Remove silent route waits without weakening financial freshness. Warm local measurements before implementation are approximately 3.2s for Overview, 1.7s for Payments and 0.8–1.3s for the other primary workspaces. Every internal navigation must acknowledge the click in at most 50ms and reveal a route skeleton in at most 200ms while server data streams.

### Deliverables

1. Add a dashboard navigation state provider with synchronous `pendingHref`, an accessible busy announcement, an optimistic active sidebar/tab state and a reduced-motion-safe progress indicator.
2. Add shared and module-shaped loading skeletons that never invent financial values and leave the persistent application shell mounted.
3. Prefetch the nine primary workspaces during browser idle time and prefetch module tabs on pointer/focus, while excluding large record/workbook detail collections.
4. Remove recurring-payment materialization from ordinary page GETs; refresh it at startup/import/payment mutations and retain idempotency.
5. Consolidate and parallelize repeated dashboard reads, tune the database pool through a bounded environment setting and measure production navigation latency.

### Acceptance criteria

- Click-to-active-navigation and click-to-progress are <=50ms in Playwright using `performance.now()`.
- Click-to-skeleton is <=200ms under an intentionally delayed route response.
- Prefetched p75/p95 module transitions are <=600ms/1000ms; warm Overview <=1200ms and other primary workspaces <=800ms in production.
- Back/forward, same-route, modifier-click, external links, downloads and form submissions retain correct behavior.
- Keyboard, screen-reader announcement, reduced motion and the responsive viewport matrix pass with no overflow.
- Typecheck, lint, unit tests, production build, navigation performance tests and visual regression pass.

## Iteration 14 — Strategic Daily Payment Pressure

### Baseline and objective

- `/payments` loads only thirty future days, therefore its 3/6/12/24-month controls cannot expose the promised horizons.
- Payment bars are grouped rather than stacked and do not adapt daily density for long horizons.
- The supplied 13 July 2026 strategic pressure report defines a useful validation shape: overdue ageing, 0–3/4–6/7–12/13–24 month horizons, flexibility classes and a critical watch list. Its figures are test fixtures, never production constants.
- Deliver one deterministic read model covering all overdue open items plus twenty-four forward calendar months, with unknown amounts preserved as unknown.

### Phases

1. Extend the payment read model with category, priority, currency and direction context; load the complete 24-month window.
2. Add pure day/week/month aggregation, exact calendar-month horizon filtering, ageing, horizon, flexibility and watch-list analytics.
3. Upgrade the shared chart with stacked payment bars, adaptive/manual granularity, richer tooltip metadata, unknown markers, critical annotations and visible-range CSV/table parity.
4. Add strategic horizon cards, ageing, flexibility and critical-payment panels to the Payments overview without hard-coding PDF values.
5. Run unit/type/lint/build gates, then inspect 1920, 1440, 1024 and 390 widths in-browser; score and report the iteration.

### Integrity and acceptance

- Status is mutually exclusive: past open → overdue; future partial → partial; other future open → planned; paid/cancelled excluded.
- Partial value is remaining balance. Unknown is never zero and is disclosed at bucket, summary, table and CSV levels.
- Partial is purple, overdue red and planned blue, with non-color identifiers.
- 3A defaults daily, 6A weekly, 12A/24A/all monthly; manual day/week/month selection remains available.
- The PDF fixture reconciles to 120 records and 61,687,568.10 TL, including 8 overdue records and 2,116,476.80 TL, without entering live code paths.
- No flexibility class is inferred without explicit source evidence. Existing critical/high/low priority may map to critical/optional; all ambiguous records remain unclassified.
- TypeScript, lint, unit tests and production build pass; browser hard gates and TestSprite are required before completion.

## Iteration 15 — Payment Horizon, Calendar and Lifecycle Repair

### Verified root causes

- Runtime materializes only previous/current/next month; the overview therefore has no rows for 4–24 months and 12A/24A collapse to the same dataset.
- Today/tomorrow have no due records. The correct empty financial state is “Ödeme yok”, never an invented amount.
- Calendar supports arbitrary months in the engine but exposes only previous/next arrows and legacy `/calendar` URLs.
- All 19 current payment definitions have null flexibility; 46 unclassified items are repeated monthly instances, not 46 distinct definitions.
- Empty ageing/flexibility groups are rendered as misleading zero rows; history empty copy is technical and archive/history flows lack regression coverage.

### Deliverables

1. Materialize 24 future months at runtime and retain arbitrary on-demand calendar month generation; add month picker, ±1 year and today navigation on the canonical route.
2. Make horizon filtering/data labels distinct for 12A/24A, use red/orange/blue/green lifecycle colors, and add lazy Excel export beside CSV.
3. Replace false `0 TL` empty KPIs with “Ödeme yok”; hide zero analysis buckets and explain unclassified template/instance counts with a direct classification action.
4. Centralize priority selection: open overdue first, then today/tomorrow, ordered by overdue age, explicit criticality/risk and remaining amount; disclose the rule in UI.
5. Repair history event classification, status tabs, contextual empty states and canonical detail links; verify payment archive and restore end to end.

### Acceptance

- Runtime data reaches at least today +24 calendar months; 12A and 24A expose different key ranges when recurring payments exist.
- Calendar accepts any valid `YYYY-MM`, provides year jumps and never applies an artificial min/max year.
- Empty days say “Ödeme yok”; null amounts remain “Tutar eksik”. Zero-value analysis groups are omitted.
- History paid/partial/reopened/cancelled filters return only their event type and useful empty copy; archive then restore preserves instances and audit history.
- Typecheck, lint, unit tests, build and responsive browser checks pass at 1440, 1024 and 390 widths.

## Iteration 16 — Sub-50 ms Navigation Feedback & Payment Read Performance

### Measured baseline

- Development cold compile for `/payments`: approximately 10–15 seconds.
- Warm `/payments` responses: approximately 0.5–2.1 seconds under the current local process load.
- The Payments overview performs six parallel reads, then a seventh payment read for risky days.
- Client navigation defers `router.push` through a zero-delay timer even though visual feedback is synchronous.

### Changes

1. Replace seven payment-instance reads with one bounded 24-month overview read and derive today, tomorrow, seven-day, overdue and risky-day collections in memory.
2. Keep thresholds as the only independent settings read and execute it in parallel with the overview read.
3. Remove the navigation timer and dispatch `router.push` in the same click task after synchronous pending-state feedback.
4. Measure cold compile separately from warm application navigation; the 50 ms gate applies to active-state/progress feedback, not database completion.
5. Verify query count, click-to-feedback, warm route timing, TypeScript, lint, unit tests and production build without sharing `.next` between dev and build.

### Acceptance

- Payment overview performs at most two database round trips.
- Click-to-active/progress p95 is at most 50 ms.
- Warm prefetched payment navigation p95 is at most 1,000 ms and never leaves the old screen without feedback.
- Derived totals and unknown-amount semantics remain identical to the deterministic payment model.

## Iteration 17 — 100 ms Perceived Module Switching

### Problem

- Development mode compiles routes on demand and cannot be used as the 50–100 ms content-performance target.
- Immediate active state is below 10 ms, but a full server-component route commit is typically 340–821 ms after warm-up.
- Full reloads include HTML generation and are not representative of in-app switching.

### Plan

1. Measure click-to-feedback, click-to-shell, URL commit and target-heading commit separately on the new local target.
2. Stop duplicate MAS development servers and build once with no process sharing `.next`.
3. Run a production local server on a new port and warm/prefetch all nine primary routes.
4. Keep the destination-shaped shell visible within one frame; never present the old page as unresponsive.
5. If full dynamic content cannot physically commit in 100 ms, enforce 100 ms for destination shell and report content p75/p95 separately rather than falsifying the metric.

### Acceptance

- Click-to-active and click-to-destination-shell: 50–100 ms maximum, target below 50 ms.
- No cold compiler appears in the user-facing server.
- Warm production module switch p75 at most 300 ms and p95 at most 600 ms.
- Financial reads remain fresh; unknown values are not cached as zero.
