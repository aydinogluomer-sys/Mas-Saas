# MAS Nakit Radar — Frontend Polish Guidelines

Design direction: **premium internal finance-operations cockpit** — calm, precise,
trustworthy, dense, executive-grade. Not a marketing page. No neon/glass/parallax/3D.
Single dark theme by design (terminal-crisp, monospace).

This is a UI/UX contract. It never changes financial logic. Two invariants echo the
product rules: **null is disclosed, never shown as 0**, and **critical/overdue items are
visually dominant**.

## Design tokens (`src/app/globals.css`)

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--surface-0..3` | page → panel → raised cell → control/hover |
| Lines | `--line`, `--line-strong`, `--line-faint` | borders, headers, row dividers |
| Text | `--text-1..4` | primary → faint |
| Financial | `--pos` `--neg` `--warn` `--info` `--accent` | inflow/paid, outflow/critical, missing/stale, info/bank, scenario/financing |
| System | `--focus`, `--radius` | focus ring, 3px corner |

Always reference tokens (`style={{ color: "var(--neg)" }}`) rather than ad-hoc hex or
`text-red-400`, so a palette change is one file. Legacy `zinc-*` classes are being phased
toward tokens; new code uses tokens.

## Primitives (`src/components/ui/`)

- **`Panel`** (`panel.tsx`) — section container: `title`, optional `subtitle`, `right`,
  `accent` (left rule in a financial tone). Backward-compatible.
- **`Badge`** (`badge.tsx`) — 6 tones (neutral/blue/green/amber/red/violet), AA text
  contrast, optional `dot`. Children render as text (tests depend on this).
- **`PageHeader`** (`shell.tsx`) — every route opens with title + subtitle + meta badges
  + optional primary action.
- **`KpiCard`** — label · value · tone (pos/neg/warn/info) · badge · note. Financial sign
  is color-coded but not noisy.
- **`StatBox`** — denser key/value cell for grouped stats.
- **`ChartShell`** — `<figure>` with title, hint, source note, `sr-only` summary (a11y
  fallback for the SVG), and an empty state.
- **`TableShell`** — horizontal-scroll region (`role="region"`, `tabIndex=0`) with a
  clear scroll affordance for wide finance tables.
- **`EmptyState`**, **`Disclaimer`** — consistent calm empty/analytics-warning banners.
- **`Nav`** (`nav.tsx`) — client nav with active-route state (prefix match, `aria-current`).

## Patterns

- **Page**: `<PageHeader/>` → summary KPI grid → panels/charts/tables. Layout wraps
  content in `.stagger` for a calm entrance cascade.
- **KPI grid**: `grid grid-cols-2 sm:grid-cols-4/5 gap-2` of `KpiCard`.
- **Chart**: wrap in `ChartShell` with a `summary` describing the data in words
  (screen-reader + honesty). SVG keeps `role="img"` + `aria-label`. Null values leave a
  gap — never drawn as 0. No misleading truncated scales.
- **Table**: numeric columns `text-right tabular-nums`; currency via `fmtTL`
  (null → "TUTAR EKSİK"); status/needs_review via `Badge`; source-trace link per row;
  wide tables in `TableShell`.
- **Empty/loading/error**: `EmptyState` for empty; module pages guard `length === 0`;
  `/health` reports DB down; forms echo errors without leaking secrets.

## Motion (CSS only, `prefers-reduced-motion` respected)

- `.animate-rise` / `.stagger` — subtle entrance (translateY 6px, 0.3s). `.card-hover` —
  border/transform micro-interaction. No background/parallax/decorative animation.
- All motion collapses to instant under `@media (prefers-reduced-motion: reduce)`.

## Accessibility (WCAG 2.2 AA target)

- Global `:focus-visible` ring (`--focus`), keyboard-only (not on mouse click).
- Semantic headings: `PageHeader` = `h1`, `Panel` = `h2`.
- Charts: `role="img"` + `aria-label` + `ChartShell` `sr-only` text summary.
- `Nav` uses `aria-current="page"`; `TableShell` is a labeled focusable region.
- Badge/KPI color is reinforced by text (never color-only meaning).

## Responsive

- Desktop-first; laptop/tablet usable; mobile read-only/stacked.
- KPI grids collapse 4/5 → 2 cols; nav wraps; wide tables scroll inside `TableShell`.
- Page body never scrolls horizontally — only intentional table regions do.

## Visual regression (Playwright)

Snapshots for the 7 core routes live in `tests/visual/`. Determinism:
`?vr=1` sets `data-vr="1"` on `<html>`, hiding `[data-volatile]` (timestamps, "bugün"
badges) via CSS. Seed the DB with `pnpm seed:demo` (or the phase seeds) first.

```bash
pnpm test:visual            # run visual smoke against a running prod server
pnpm test:visual:update     # update snapshots after an intentional UI change
```

## Information architecture (decision-first)

- **Default screens explain; detail screens prove.** `/` is a real **Ana Ekran** cockpit
  (not a redirect): 3–5 big `KeyStat` cards, a one-line headline risk, a deterministic
  **"Ne yapmalıyım?"** list (max 5, `src/lib/home/cockpit.ts`), and a status strip (son
  rapor / hatırlatma / üretim). It answers the 7 operator questions in ~20s.
- **Primary nav = 6**: Ana Ekran, Ödemeler (`/radar`), Nakit Akış, Finansman, Senaryolar,
  Yönetim. Secondary routes (Takvim, Ödeme kalemleri, İçe Aktarım, Raporlar, Hatırlatmalar,
  Üretim, İncelemeler) live under **Yönetim** (`/admin`) — reachable, not deleted.
- **Order per route**: summary → insight → action → chart → details/table last. Wrap
  technical detail (long tables, source-trace links, review internals) in
  `DetailsDisclosure` ("Detayları göster" / "Kaynak kayıt"), collapsed by default.
- **Presets over forms**: `/scenarios` offers 3 one-click presets the engine supports
  **exactly**; the custom form is collapsed under "Gelişmiş senaryo". A preset's name must
  do exactly what the engine does — no approximate/mislabeled quick presets.
- **Body font is sans; numbers/codes/section labels are mono** (`font-mono`/`.tnum`).

## Do / Don't

- ✅ Use tokens, primitives, tabular numerals, disclosed nulls, dominant critical items.
- ✅ Keep it dense, calm, monospace, executive.
- ❌ No new features or logic in a polish PR. ❌ No color-only meaning. ❌ No animation that
  distracts from financial data. ❌ No misleading chart scales. ❌ Never render null as 0.
