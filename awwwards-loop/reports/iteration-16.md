# Iteration 16 — Sub-50 ms Navigation Feedback & Payment Read Performance

Date: 2026-07-14

## Outcome

The navigation click path now paints its active state and loading shell before starting the expensive Next.js route transition. The Payments overview uses two database round trips instead of seven, and the chart no longer serializes zero-valued duplicate points for every status/date combination.

## Measured evidence

### Database

- Cold payment overview read: 79–141 ms depending on local process pressure.
- Warm payment overview read: 8.6–22.2 ms.
- Overview query count: one payment read plus one settings read.

### Browser — second warm nine-route run

| Route | Click feedback | Route completion |
| --- | ---: | ---: |
| `/payments` | 2.9 ms | 820.8 ms |
| `/cashflow` | 4.7 ms | 655.8 ms |
| `/finance` | 1.0 ms | 693.9 ms |
| `/production` | 2.6 ms | 530.5 ms |
| `/scenarios` | 2.9 ms | 474.8 ms |
| `/insights/ask` | 1.1 ms | 567.7 ms |
| `/data/quality` | 0.8 ms | 340.1 ms |
| `/system` | 0.7 ms | 364.3 ms |
| `/overview` | 1.1 ms | 350.3 ms |

The click-feedback hard gate is met on every primary route. Development cold compilation is reported separately and is not presented as application latency.

## Changes

- Immediate DOM pending state remains synchronous.
- Router work begins on the next animation frame, allowing the pending shell to paint first.
- Query-parameter changes now clear pending state through `useSearchParams` as well as pathname changes.
- The command palette uses the same navigation behavior.
- Payments derives today, tomorrow, week, overdue and risk buckets from one read model.
- Payment chart points with no matching record are implicit rather than serialized as fake zero points.
- Old local Next servers on ports 3103–3108 were stopped after verification; the current server remains on 3110.

## Engineering checks

- TypeScript: pass.
- ESLint: pass.
- Changed analytics suites: 13/13 pass.
- Earlier full suite: 180/180 pass. A later resource-constrained parallel rerun completed 157 tests but five worker processes could not start; this was an environment worker timeout, not an assertion failure.
- In-app browser connection was unavailable in this session; project-local Playwright produced the timing evidence above.
- TestSprite authentication passes, but its configured temporary Cloudflare target is stale and cannot validate the current localhost build.

## Score

| Category | Score | Evidence |
| --- | ---: | --- |
| Interaction and feedback | 15/15 | Every primary click acknowledges in under 5 ms. |
| Performance architecture | 18/20 | Payments route under 1 s warm; dev cold compilation remains expensive. |
| Financial integrity | 20/20 | No source mutation or unknown-to-zero conversion. |
| Accessibility | 9/10 | Busy state and reduced-motion path retained; in-app browser gate unavailable. |
| Reliability | 16/20 | Type/lint/targeted tests pass; production build/TestSprite remain environment-gated. |
| Overall | 78/85 normalized to 91.8/100 | PASS for local navigation performance; external gates remain documented. |

## Remaining environment gates

- Run production build with no concurrent dev process and a stable Turbopack worker environment.
- Point TestSprite at a persistent masked-data HTTPS staging deployment.
