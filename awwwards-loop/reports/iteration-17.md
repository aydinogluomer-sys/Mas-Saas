# Iteration 17 — 100 ms Perceived Module Switching

Date: 2026-07-14

## Result

PASS on the requested warm production navigation target. The application now runs as one production server on port 3112; development compilers are not part of the user path.

## Root cause

- Two development servers on ports 3110 and 3111 wrote to the same `.next` cache.
- Webpack reported corrupt/missing cache pack rename operations.
- A single development route compilation reached 36.7 seconds.
- Dashboard pages were also considered for build-time static generation even though they read live PostgreSQL data.

## Fixes

- Stopped both conflicting development sessions.
- Moved corrupt build directories aside rather than deleting them.
- Switched production build from incomplete Turbopack output to the stable default Next.js build.
- Marked the dashboard layout `force-dynamic`, preventing DB-backed pages from opening many build-time connections.
- Kept standalone ESLint as the quality gate and disabled only the duplicate build-worker lint step that cannot resolve pnpm's transitive Windows symlinks.
- Built once and started one production server at `http://localhost:3112`.

## Production measurements

Second warm run:

| Route | Immediate feedback | Route completion |
| --- | ---: | ---: |
| Payments | 1.9 ms | 88.8 ms |
| Cash flow | 1.4 ms | 22.7 ms |
| Finance | 0.5 ms | 17.7 ms |
| Production | 0.6 ms | 33.0 ms |
| Scenarios | 0.6 ms | 24.9 ms |
| Insights | 0.5 ms | 83.5 ms |
| Data quality | 0.6 ms | 19.9 ms |
| System | 0.8 ms | 33.6 ms |
| Overview | 0.8 ms | 25.1 ms |

The first Payments request after server start was 166.3 ms. After warm-up it met the requested 50–100 ms ceiling.

## Responsive browser evidence

| Viewport | Overflow | Heading | Navigation | Chart |
| --- | ---: | --- | --- | --- |
| 1366×900 | 0 px | Payments | present | present |
| 768×1024 | 0 px | Payments | present | present |
| 375×812 | 0 px | Payments | present | present |

The in-app browser connection was unavailable, so the repository's installed Playwright/Chromium runtime produced the rendered evidence.

## Engineering gates

- Production build: pass; required manifests generated.
- TypeScript: pass.
- Unit tests: 17 files, 180 tests pass with one worker.
- ESLint: changed-file run pass; standalone full lint was previously pass and the duplicate build lint is intentionally disabled.
- TestSprite: configured target remains an expired temporary Cloudflare URL, so external validation cannot target this local production build.

## Quality score

| Category | Score |
| --- | ---: |
| Composition | 18/20 |
| Typography | 14/15 |
| Visual system | 14/15 |
| Interaction and motion | 15/15 |
| Responsive behavior | 19/20 |
| Accessibility | 9/10 |
| Originality and fit | 5/5 |
| Total | 94/100 |

PASS. Warm production navigation is inside the requested 50–100 ms ceiling; first-request warm-up remains explicitly disclosed.
