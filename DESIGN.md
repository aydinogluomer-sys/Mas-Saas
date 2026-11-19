---
name: MAS Nakit Radar — Archival Cotton-Ledger & Editorial Financial OS
colors:
  background: '#F3EBDC'
  on-background: '#1D1813'
  surface: '#F3EBDC'
  surface-dim: '#DED2BA'
  surface-bright: '#FCF9F2'
  surface-container-lowest: '#FCF9F2'
  surface-container-low: '#FBF7EE'
  surface-container: '#F4ECDD'
  surface-container-high: '#EAE0CC'
  surface-container-highest: '#DED2BA'
  on-surface: '#1D1813'
  on-surface-variant: '#443B31'
  outline: '#B8A589'
  outline-variant: '#D4C5AC'
  outline-faint: '#E5DAC6'
  primary: '#1E478A'
  on-primary: '#FCF9F2'
  primary-container: '#E7ECF4'
  on-primary-container: '#143163'
  secondary: '#193A73'
  on-secondary: '#FCF9F2'
  secondary-container: '#EAEFF7'
  on-secondary-container: '#132B57'
  tertiary: '#5A4F43'
  on-tertiary: '#FBF7EE'
  success: '#11694E'
  on-success: '#FCF9F2'
  success-container: '#E5EFE8'
  on-success-container: '#0B4A36'
  warning: '#A84608'
  on-warning: '#FCF9F2'
  warning-container: '#F6E8D8'
  on-warning-container: '#7A3104'
  error: '#A92419'
  on-error: '#FCF9F2'
  error-container: '#F6E3DE'
  on-error-container: '#7D1810'
  inverse-surface: '#1D1813'
  inverse-on-surface: '#FBF7EE'
  scrim: 'rgba(26, 20, 14, 0.44)'
typography:
  display:
    fontFamily: Geist Sans
    fontSize: 28px
    fontWeight: '700'
    lineHeight: '1.10'
    letterSpacing: -0.025em
  heading:
    fontFamily: Geist Sans
    fontSize: 22px
    fontWeight: '700'
    lineHeight: '1.18'
    letterSpacing: -0.02em
  subheading:
    fontFamily: Geist Sans
    fontSize: 15px
    fontWeight: '600'
    lineHeight: '1.30'
    letterSpacing: -0.01em
  body:
    fontFamily: Geist Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: '1.50'
    letterSpacing: '0em'
  body-sm:
    fontFamily: Geist Sans
    fontSize: 13px
    fontWeight: '400'
    lineHeight: '1.45'
    letterSpacing: '0em'
  caption:
    fontFamily: Geist Sans
    fontSize: 12px
    fontWeight: '500'
    lineHeight: '1.40'
    letterSpacing: '0em'
  label:
    fontFamily: Geist Sans
    fontSize: 11px
    fontWeight: '600'
    lineHeight: '1.25'
    letterSpacing: 0.06em
  mono-code:
    fontFamily: Geist Mono
    fontSize: 11.5px
    fontWeight: '500'
    lineHeight: '1.35'
    letterSpacing: '0em'
rounded:
  element: 4px
  sm: 5px
  control: 6px
  md: 8px
  lg: 12px
  pill: 999px
spacing:
  unit: 4px
  2xs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
  max-width: 1580px
  sidebar-expanded: 252px
  sidebar-collapsed: 72px
---

# Design System: MAS Nakit Radar
**System Codename:** Warm Archival Cotton-Ledger & Editorial Financial OS  
**Surface Mode (`impeccable`):** `Operate` (Primary) + `Read` (Evidence Drawers & CFO Briefings)  
**Stack:** Next.js App Router · Tailwind CSS v4 (`@theme` + `@utility`) · Geist Sans & Geist Mono (`next/font/local`) · Pure Server-Rendered SVG Data Graphics

---

## 1. Overview & Visual Atmosphere

MAS Nakit Radar rejects both sterile clinical-white SaaS templates (`#FFFFFF` + `#F8FAFC`) and neon-on-obsidian crypto/AI-slop dark modes. Its visual world draws from **nineteenth-century Ottoman/European shipping & treasury ledgers, Financial Times (Origami) broadsheet discipline, and Swiss typographic tabular craft**, engineered for a modern multi-entity CFO, treasurer, and manufacturing controller working 8+ hours a day under high cognitive stakes. Every screen feels like **crisp iron-gall sepia ink printed onto heavy 300gsm unbleached cotton-rag ledger vellum**: calm under fluorescent or daylight glare, physically grounded, and mathematically uncompromising.

Following the **`Operate` mode law** (`pbakaus/impeccable`), the visual world contributes **four things and only four things**: **typography, warm cotton-parchment palette, workbench-tight density, and one signature material/evidence move** (cell-level audit proof drawers + Tufte high-data-ink pure-SVG micro-visualizations). The world never turns the software into a theatrical costume: controls remain instant, standard, keyboard-first web primitives (`<= 40ms` GPU-composited response budget), and **primary tension** lives in the contrast between **warm, tactile archival paper materiality** and **razor-sharp, deterministic financial engineering** (`tabular-nums`, 4-way TDHP subledger reconciliation, zero silent `0 TL` coercion for missing data).

---

## 2. Color System & Perceptual Harmony (Hue/OKLCH & Warm Parchment Scale)

All neutral and surface ramps are perceptually locked to a **single warm flax / unbleached cotton-rag hue angle (`H ≈ 78°–82°` in OKLCH)** with low chroma (`C: 0.016–0.034`). Surfaces step strictly by lightness (`ΔL` of `2.5%–4.5%` per tier) rather than shifting hue, preventing the muddy greenish-gray or sterile pure-white (`#FFFFFF`) bleed that breaks warm editorial interfaces (`taste-skill`, `interface-design`, `hue`).

### Primary Foundation (Canvas, Vellum & Linen Surfaces)

| Descriptive Name | CSS Token | Hex | OKLCH Approximation | Functional Role |
| :--- | :--- | :--- | :--- | :--- |
| **Unbleached Cotton Parchment** | `--bg` / `--surface-0` | `#F3EBDC` | `oklch(0.941 0.022 81)` | Root application canvas (`body`, `.workspace-shell`), `<meta name="theme-color">`. Covers >= 55% of viewport area. |
| **Fine Archival Vellum** | `--surface-1` | `#FBF7EE` | `oklch(0.976 0.013 82)` | Primary elevated card, `Panel`, `KpiCard`, `ActionSubBar`, active sidebar pill, and table sheet surface. Replaces `#FFFFFF` everywhere. |
| **Aged Flax Linen** | `--surface-2` | `#EAE0CC` | `oklch(0.908 0.027 80)` | Left navigation rail (`.app-sidebar`), chart header strips, secondary grouped wells, and inset filter bars. |
| **Pressed Rag Tertiary** | `--surface-3` | `#DED2BA` | `oklch(0.868 0.033 79)` | Pressed control backgrounds, skeleton shimmer peaks, active chip wells, and inset input focus wells. |
| **Warm Folio Hover** | `--surface-hover` | `#EFE6D5` | `oklch(0.926 0.023 81)` | Table row hover (`tbody tr:hover`) and interactive list-item hover state. |
| **Illuminated Vellum Sheet** | `--surface-overlay` | `#FCF9F2` | `oklch(0.984 0.010 83)` | Command palette (`⌘K`), `EvidenceDrawer`, and `.chart-tooltip` (never cold `rgba(255,255,255,0.96)`). |

### Structural Hairlines & Borders

| Descriptive Name | CSS Token | Value | Functional Role |
| :--- | :--- | :--- | :--- |
| **Sepia Ledger Rule** | `--line` | `#D4C5AC` | Standard structural divider, sidebar right rule, table header bottom border (`th`), tab strip baseline. |
| **Architectural Vellum Edge** | `--line-card` | `rgba(58, 42, 24, 0.13)` | Translucent warm-umber card perimeter that adapts organically over grain and linen textures (`interface-design` border rule). |
| **Engraved Brass-Sepia Rule** | `--line-strong` | `#B8A589` | Form input borders (`.field-control`), active segmented-control borders, modal/drawer edges, and scrollbar thumbs. |
| **Ruled Folio Hairline** | `--line-faint` | `#E5DAC6` | Quiet 1px ledger row dividers (`td`), internal card footers, and background folio ruling lines. |

### Typography & Sepia-Ink Hierarchy (4-Tier Ramp)

Every text token is calibrated against both `--bg` (`#F3EBDC`) and `--surface-1` (`#FBF7EE`) to exceed WCAG AA/AAA contrast floors without using harsh `#000000` pure black:

| Tier | Descriptive Name | CSS Token | Hex | Contrast on `#FBF7EE` / `#F3EBDC` | Functional Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | **Deep Iron-Gall Sepia** | `--text-1` | `#1D1813` | `16.1:1` / `14.6:1` (AAA) | Page/panel titles, primary KPI figures, table primary cells, primary CTA fill. |
| **Tier 2** | **Warm Umber Charcoal** | `--text-2` | `#443B31` | `9.6:1` / `8.7:1` (AAA) | Card titles, prose descriptions, inactive nav labels, secondary button labels. |
| **Tier 3** | **Editorial Bistre** | `--text-3` | `#5A4F43` | `6.9:1` / `6.2:1` (AA+) | Table `th` headers, KPI currency/unit suffixes (`TL`, `gün`), sublabels, chart axis labels. |
| **Tier 4** | **Archival Marginalia** | `--text-4` | `#6B5F51` | `5.4:1` / `4.88:1` (AA) | Timestamps, keyboard shortcut `<kbd>` hints, empty-state captions, input placeholders. |

### Semantic Financial Palette & Warm-Paper Tints

Color is scarce (`~90%` warm neutral structure, `~10%` semantic signal). Violet/lavender (`OKLCH H 270°–330°`) is strictly banned (`taste-skill`, `hue`). Status backgrounds MUST mix with `--surface-1` (`#FBF7EE`), **never `#FFFFFF`**, so badges sit inside the paper rather than floating like plastic stickers:

| Role | Descriptive Name | Foreground Token | Foreground Hex | Warm Paper Tint (`bg`) | Functional Meaning |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Primary Analytical / Active** | **Prussian Ledger Blue** | `--info` / `--focus` | `#1E478A` | `color-mix(in srgb, var(--info) 9%, var(--surface-1))` (`#E7ECF4`) | Active tab bar, focus ring, primary analytical chart line, link accents, module folio code. |
| **Scenario / Deep Accent** | **Indigo Registrars Ink** | `--accent` | `#193A73` | `color-mix(in srgb, var(--accent) 9%, var(--surface-1))` (`#EAEFF7`) | Entity scope pill, scenario simulation badges, currency toggle active pill, endorsed checks. |
| **Positive / Inflow / Aligned** | **Archival Banknote Emerald** | `--pos` / `--green` | `#11694E` | `color-mix(in srgb, var(--pos) 9%, var(--surface-1))` (`#E5EFE8`) | Cash inflows, positive runway, reconciled TDHP pillars, cleared checks, healthy OEE (`>= 80%`). |
| **Caution / Approaching / Missing** | **Burnt Raw Ochre** | `--warn` / `--amber` | `#A84608` | `color-mix(in srgb, var(--warn) 10%, var(--surface-1))` (`#F6E8D8`) | `TUTAR EKSİK` disclosures, due-today/7d pressure, approaching covenants, pending maker-checker reviews. |
| **Negative / Breach / Overdue** | **Vermilion Wax Seal** | `--neg` / `--red` | `#A92419` | `color-mix(in srgb, var(--neg) 9%, var(--surface-1))` (`#F6E3DE`) | Overdue payables, bounced checks (`karşılıksız`), negative 13W cash trough, breached covenants. |

---

## 3. Typography & Numeric Discipline (`better-typography` Rules)

MAS Nakit Radar ships two locally bundled variable typefaces (`GeistSans` and `GeistMono` via `next/font/local` — zero external Google Fonts latency) governed by Jakub Krehel's `better-typography` invariants and `dominikmartn/hue`'s dual-flag discipline (`mono_for_code: true`, `mono_for_metrics: false`).

### Font Role Separation (No "Technical Costume" Monospace)
1. **Geist Sans (`--font-sans`) — Primary Editorial & Financial Metric Workhorse:** Used for all headings, navigation, prose, table text, **and all currency/KPI numbers** with `font-variant-numeric: tabular-nums`. Keeping hero KPIs (`28px`) and table currency columns (`13px`) in Geist Sans `tabular-nums` preserves clean typographic cohesion while guaranteeing exact vertical digit alignment.
2. **Geist Mono (`--font-mono`) — Strict Code, Identifier & Coordinate Voice:** Reserved **exclusively** for TDHP account codes (`102`, `120/320`, `710`), Tax IDs (`VKN 1234567890`), ISO dates/timestamps (`2026-11-15`), workbook cell coordinates (`Sayfa1!D14`), keyboard shortcuts (`Ctrl K`), and formula expressions. Never set full sentences or Turkish prose labels in monospace.

### Semantic 7-Step Type Scale

Every role pairs size, **unitless** `line-height`, `em`-based `letter-spacing`, and `font-weight` as a single atomic token (`weight >= 400` mandatory below `18px`; standard CSS properties `font-weight` and `font-variant-numeric: tabular-nums` used instead of raw `font-variation-settings` or `font-feature-settings`):

| Semantic Role | Size (`rem` / `px`) | Weight | Unitless Line-Height | Tracking (`em`) | Wrapping & Numeric Rules | Canonical Usage |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`--type-kpi-hero`** | `1.75rem` (`28px`) | `700` | `1.08` | `-0.025em` | `tabular-nums`, `nowrap` | Top-of-page 4 Hero Bento KPI values; currency unit rendered at `0.46em` (`12.5px`, weight `600`, `--text-3`). |
| **`--type-kpi-card`** | `1.375rem` (`22px`) | `700` | `1.12` | `-0.02em` | `tabular-nums`, `nowrap` | Standard `KpiCard` figures and secondary cockpit metrics. |
| **`--type-h1-module`** | `clamp(1.1875rem, 2vw, 1.5rem)` (`19–24px`) | `700` | `1.15` | `-0.025em` | `text-wrap: balance` | `ModuleFrame` masthead `<h1>`. |
| **`--type-h2-section`** | `0.875rem` (`14px`) | `600` | `1.30` | `-0.01em` | `text-wrap: balance` | `Panel` header `<h2>`, `ActionSubBar` contextual title, modal titles. |
| **`--type-body`** | `0.875rem` (`14px`) | `400` | `1.50` | `0em` | `text-wrap: pretty`, `max-w-[68ch]` | Empty-state guidance, CFO briefing narratives, audit notes, disclaimers. |
| **`--type-table-cell`** | `0.8125rem` (`13px`) | `400` / `500` | `1.42` | `0em` | `tabular-nums` on numbers | Data table cells (`td`), sidebar links, action queue items, compact descriptions. |
| **`--type-caption`** | `0.75rem` (`12px`) | `500` | `1.40` | `0em` | `text-wrap: pretty` | Card sublabels, chart axis ticks, filter pills, secondary buttons. |
| **`--type-table-head`** | `0.6875rem` (`11px`) | `600` | `1.25` | `0.055em` | `uppercase` via CSS `text-transform` | **Strictly** for table `<th>` column headers and sidebar group headers. Store source strings in natural Turkish case (`"Operasyonel Bakiye"`, never hardcoded `"OPERASYONEL BAKİYE"`). |

### Mandatory Typographic Hygiene (`better-typography` Checklist)
- **Unitless Line-Height Everywhere:** Multi-line descriptions or wrapping card subtitles MUST hold `line-height >= 1.40` (`1.45`–`1.50` preferred); never apply `leading-none` or `leading-tight` to text that can wrap to 2+ lines.
- **Measure Cap (`60–72ch`):** All explanatory copy (`ModuleFrame` subtitle, `ModuleEmptyState`, CFO AI answers, `Disclaimer`) is capped at `max-width: 68ch` (`~680px–720px`) so eyes never track across a `1580px` wide monitor.
- **Unit & Sign Decoupling (`renderValueWithUnit`):** Numbers never break across lines from their unit (`1.250.000 TL` uses non-breaking coupling; `TL`, `USD`, `EUR`, `gün`, `puan` step down to `12px` `--text-3` so the numeric magnitude dominates). Null/unknown amounts render explicitly as `TUTAR EKSİK` in `--warn`, never `0 TL`.
- **Mobile `16px` Input Floor:** Form controls (`.field-control`, `<input>`, `<select>`, `<textarea>`) MUST render at `font-size: 16px` below `640px` (`text-base sm:text-[13.5px]`) to prevent iOS Safari forced viewport zoom on tap.
- **Truncation With a Way Back:** Any cell or title using `truncate` or `line-clamp-2` MUST expose full content via native `title`, `EvidenceDrawer`, or expandable row detail.
- **Turkish Typographic Punctuation:** Use real en-dashes (`–`) for ranges (`1–30 gün`), real ellipsis (`…`) for loading states, middle dots (`·`) sparingly for compact metadata pairs, and `<html lang="tr">` on the root document with root-only `-webkit-font-smoothing: antialiased`.

---

## 4. Surface Materiality, Elevation & Hairlines

### Physical Cotton-Rag & Ruled Folio Canvas Recipe
Flat beige (`#F3EBDC` alone) reads as an aged browser window rather than archival stationery. MAS Nakit Radar achieves authentic **cotton-rag materiality** with zero WebGL overhead and zero layout shift through a **three-layer static CSS composite** on `body` and `.module-heading`:

1. **Layer 1 — Laid Cotton-Linen Weave (`/textures/editorial-linen-cream.webp` + `--parchment-grain`):** Pair the existing `44 KB` `/textures/editorial-linen-cream.webp` tile (`280px × 280px`, `mix-blend-mode: multiply`, effective alpha `0.055`) with the inline SVG `feTurbulence` `--parchment-grain` (`180px × 180px`, `baseFrequency="0.82"`), never over text or charts directly, giving subtle organic fiber variation up close while staying calm from arm's length.
2. **Layer 2 — Faint Archival Ledger Ruling (`.folio-ruled-canvas`):** On the outer workspace margin and empty/header stages, a whisper-quiet `24px` horizontal hairline rule (`rgba(166, 145, 114, 0.07)`) masked cleanly toward edges (`mask-image: radial-gradient(...)`) evokes ruled accounting folios without competing with table borders.
3. **Layer 3 — Corner Registration Marks (`.folio-corner-mark`):** Major focal containers (`OverviewHeroHeader`, `ModuleFrame` masthead, and formal CFO Report/Reconciliation sign-off sheets) carry 6px × 6px `1px` sepia L-shaped corner ticks (`--line-strong` at `55%` opacity) instead of thick `2.5px–3px` colored `border-left` stripes (`impeccable/craft-floor` ban).

### Whisper-Quiet Warm-Umber Elevation Strategy
We commit to **one unified depth system**: `1px` warm translucent perimeter (`--line-card`) + low-offset warm-umber ambient shadow + `1px` top inner vellum highlight:
- **Resting Card (`--shadow-card`):** `0 1px 2px rgba(48, 34, 18, 0.06), 0 1px 0 rgba(255, 252, 245, 0.65) inset`
- **Interactive Hover Lift (`--shadow-elevated`):** `0 6px 18px -10px rgba(48, 34, 18, 0.14), 0 1px 2px rgba(48, 34, 18, 0.05)` paired with `border-color: var(--line-strong)`
- **Floating Sheet / `⌘K` / Drawer (`--shadow-overlay`):** `0 18px 44px -14px rgba(38, 27, 14, 0.20), 0 4px 12px -4px rgba(38, 27, 14, 0.09)` over `--scrim` (`rgba(26, 20, 14, 0.44)`)

### Concentric Border-Radius Law (`outerRadius = innerRadius + padding`)
Never nest identical radii (`interface-design` static polish rule):
- **Badges, `<kbd>`, inline status chips (`--radius-sm`):** `5px`
- **Buttons, form inputs, segmented inner pills (`--radius-control`):** `6px`
- **Standard Cards, `Panel`, `KpiCard`, `ActionSubBar`, grouped pill track (`--radius-md`):** `8px` (e.g., `6px` inner button + `2px` track padding = `8px` outer track)
- **Modals, `CommandDialog`, `OverviewCashChart` stage, Hero Folio (`--radius-lg`):** `12px` (with `4px` inner header/toolbar inset → `8px` inner sub-panels)

### Browser Surface Theming (`craft-floor` Requirement)
Every native browser surface is themed to the parchment palette:
- `<meta name="theme-color" content="#F3EBDC">` (replacing legacy `#0284c7` sky-blue)
- `::selection` in Prussian Blue wash (`color-mix(in srgb, var(--info) 16%, transparent)`) + `--text-1`
- Thin warm-sepia scrollbars (`scrollbar-color: var(--line-strong) transparent`)
- `2px solid var(--focus)` keyboard focus ring with `2px` offset (`:focus-visible`)

---

## 5. Component & Micro-Visualization Grammar

### Core Interface Primitives
1. **Buttons (4 Canonical Variants, 34px compact / 40px mobile touch):**
   - `.button-primary`: Solid Deep Sepia-Ink (`#1D1813`) fill, `#FBF7EE` text, `6px` radius, `600` weight. **At most ONE `.button-primary` per viewport region** for the primary commit action.
   - `.button-accent`: Tinted Prussian Blue (`9%` `--info` on `--surface-1`), `1px` `36%` `--info` border, `#1E478A` label. Used for analytical drill-downs and secondary workflow triggers.
   - `.button-ghost`: `--surface-1` fill, `1px solid var(--line)`, `--text-2` label; steps to `--surface-2` + `--line-strong` on hover.
   - `.button-danger`: Tinted Vermilion (`8%` `--neg` on `--surface-1`), `#A92419` label; reserved for destructive reversals or rejection actions.
   - **Tactile Press Feedback:** `transform: scale(0.98) translate3d(0, 0.5px, 0)` in `80ms` `cubic-bezier(0.23, 1, 0.32, 1)`.
2. **Ledger Vellum Panels & KPI Cards (`Panel`, `KpiCard`, `KeyStat`):**
   - Standardize all data cards on `--surface-1` (`#FBF7EE`), `1px solid var(--line-card)`, `--radius-md` (`8px`), `14px` (`p-3.5`) workbench padding, and `--shadow-card`.
   - Replace thick `2.5px` colored left borders with a subtle top header status dot or `1px` semantic border tint (`border-pos` / `border-warn` / `border-neg`) so cards never look like generic Notion callouts.
3. **Contextual 44px `ActionSubBar` (`PageHeader`):**
   - Sits directly beneath module navigation (`min-height: 44px`, `padding: 7px 14px`), uniting the sub-route `<h2>` (`14px` SemiBold), concise 1-line scope summary, volatile entity/confidence badges, and right-aligned route CTAs without duplicating the `ModuleFrame` masthead.
4. **Inputs & Maker-Checker Forms (`.field-control`):**
   - Inset feel: `--surface-1` resting fill (or `--surface-0` inside a `--surface-1` modal so inputs sit *into* the sheet), `1px solid var(--line-strong)`, visible `<label for>` above every field (`12px` weight `600` `--text-2`), inline field-level error message underneath (`aria-invalid` + `aria-describedby`), and `16px` mobile text floor.

### The 5 Canonical Pure-SVG Editorial Micro-Visualizations (Zero-JS RSC Primitives)
To eliminate "walls of identical KPI boxes" (`interface-design/design-deslop`) across MAS Nakit Radar's 77+ routes, every module pairs tabular truth with **pure server-rendered SVG micro-graphics** inspired by Edward Tufte and Financial Times *Visual Vocabulary*:

| Primitive | SVG Geometry & Specs | Semantic Color Rules | Mandatory Module Placements |
| :--- | :--- | :--- | :--- |
| **1. `RadialMeterSvg`** *(Archival Open-Arc Gauge)* | `240°` open arc (`viewBox="0 0 88 64"`), `5px` `--surface-3` track, `5px` rounded value arc, `1px` target threshold tick at `80%`, central `tabular-nums` % readout. | `>= 80%` `--pos`, `55–79%` `--warn`, `< 55%` `--neg`. | **Overview & Data (`/data/quality`):** Karar Güveni % · **Production (`/production`):** Tesis Canlı OEE % · **System (`/system/controls`):** İç Kontrol Uyum Skoru. |
| **2. `StackedRibbonSvg`** *(100% Proportional Bar)* | `8px`–`12px` tall horizontal segmented bar (`rx="3"`), `1.5px` `--surface-1` crisp segment gaps, compact legend row with `tabular-nums` shares & TRY values below. | `--info` (TRY / Current), `--accent` (USD / 1–30d), `--pos` (EUR / Headroom), `--warn` (31–60d), `--neg` (60d+ / Breached). | **Overview & Finance (`/finance/treasury`):** TRY / USD / EUR Kasa Dağılımı · **Receivables & Payables:** Yaşlandırma Dağılımı · **Facilities:** Kredi Limiti Kullanım vs Boşluk. |
| **3. `BulletBarSvg`** *(Tufte Inline Cell Meter)* | `72px–110px × 14px` inline table/card SVG: qualitative background range (`--surface-2`), `6px` actual bar, `2px` vertical target/ledger benchmark marker (`--text-1`). | Bar in `--info` when aligned, `--warn` / `--neg` when variance exceeds tolerance. | **Data (`/data/quality` & `/data/reconciliation`):** 4-Yönlü Alt-Defter vs TDHP Yönetim Defteri Farkı · **Cashflow (`/cashflow/budget`):** Bütçe vs Gerçekleşen · **Production:** Parça Başabaş vs Satış Marjı. |
| **4. `CccTimelineBridgeSvg`** *(Working Capital Span)* | Horizontal proportional span diagram (`viewBox="0 0 320 52"`) plotting `DIO` (stok) + `DSO` (tahsilat) top bar against `DPO` (tedarikçi vadesi) bottom offset to reveal net `CCC` cash gap in days. | `DIO` `--surface-3`, `DSO` `--info`, `DPO` `--pos`, Net `CCC` gap `--warn` (if `> 45g`) or `--pos`. | **Overview (`HeroBentoRow` Card 3)** · **Finance (`/finance` & `/finance/profitability`)** · **Production (`Stok & DIO/CCC`)**. |
| **5. `SparklineDeltaSvg`** *(12-Point Horizon Line)* | Uniform 12-point `viewBox="0 0 140 36"` polyline (`strokeWidth="1.8"`, `strokeLinecap="round"`), `14%` vertical gradient wash, `1px` zero/min-cash dashed reference line, terminal `3px` dot. | `--info` neutral trajectory, `--pos` improving, `--neg` dipping below zero line. | **Overview** (promoted out of hidden `<details>` into primary cash cards!) · **Payments** (7G çıkış ritmi) · **Cashflow** (13H haftalık kapanış) · **Scenarios** (Baz vs Stres karşılaştırma). |

---

## 6. Information Architecture & User Flow Principles

Enterprise financial tools fail when sub-navigation mirrors database tables instead of **user jobs-to-be-done** (`Stripe`, `Mercury`, `Ramp`, `Agicap`). Currently, `/finance` exposes **18 sub-routes** in an always-expanded 4-box grid and `/data` exposes **11 flat tabs**, while `⌘K` indexes only **12 top-level links** out of 77+ routes. All module navigation and user flows MUST obey four structural laws:

### Law 1 — The `5 ± 2` Stage-Segmented Sub-Nav Rule (Eliminating Tab Walls)
- ** <= 6 sub-routes** (`/payments`, `/production`, `/scenarios`, `/insights`, `/cashflow`): Render a single clean horizontal `.module-tabs` strip with **zero duplicate internal `?tab=` bars** (consolidate `/production`'s 6 internal `?tab=` views into clean stage sub-routes or a secondary segmented pill bar inside the workspace).
- ** > 7 sub-routes** (`/finance` 18 routes, `/data` 11 routes, `/system` 9 routes): Never render all 18 links simultaneously in a tall 4-card grid. Use a **Two-Tier Progressive Stage Bar**:
  - **Row 1 (Lifecycle Stage Segmented Pills — 4 stages max):** e.g. in `/finance`: `1. Hazine & Kasa (5)` · `2. Alacak & Tahsilat (5)` · `3. Çek & Kredi Portföyü (5)` · `4. Yönetim Defteri & Kârlılık (3)`.
  - **Row 2 (Focused Contextual Sub-Tabs — 3 to 5 links max):** Shows **only** the sub-tabs belonging to the currently active stage, keeping above-the-fold chrome under `84px` total height while offering hover/click popover preview for sibling stages!

### Law 2 — Intent-Driven Task Compass (*"Ne yapmak istiyorsunuz?"*)
Users think in operational verbs (*"Banka ekstresi yükle"*, *"Karşılıksız çeki işle"*, *"13 haftalık nakit açığını simüle et"*), not schema nouns (*"Standart aktarım V2"*, *"Maruziyet"*).
- The **Ana Ekran (`/`)** and **`⌘K` Command Palette** organize entry points around **4 Operational Intents**:
  1. **Veri Yükle & Doğrula** *(Ingest & Reconcile)*
  2. **Bugünkü Nakit & Ödemeyi Yönet** *(Execute Daily Cash & Payables)*
  3. **Risk, Çek & Kredi İzle** *(Monitor Portfolio, FX & Covenants)*
  4. **Geleceği Simüle Et & Raporla** *(Forecast, Stress-Test & Brief)*

### Law 3 — Universal 77-Route Semantic `⌘K` Index (Turkish Synonym Matching)
The canonical `CommandPalette` (`Ctrl+K` / `⌘K`) MUST index **all 77+ dashboard routes, quick actions, and Turkish domain synonyms** (e.g. typing `"mizan"` → `/data/trial-balance-bridge`; `"karşılıksız"` or `"çek"` → `/finance/checks`; `"kovenant"` → `/finance/facilities`; `"oee"` or `"reçete"` → `/production`; `"mutabakat"` → `/data/reconciliation`), grouped by Module + Lifecycle Stage with keyboard-instant (`0ms`) filtering.

### Law 4 — 5-Stage End-to-End Financial Lifecycle Stepper & Contextual Handoffs
Every screen declares where the operator stands in the **MAS Closed-Loop Financial Pipeline** and provides a 1-click forward/backward handoff (`ActionSubBar` right slot + `EvidenceDrawer` provenance link):
`[1. Veri Girişi & İçe Aktarım] → [2. Mutabakat & Karar Güveni] → [3. Günlük Nakit & Ödeme İcrası] → [4. 13H Projeksiyon & Stres Senaryosu] → [5. CFO Raporu & Dönem Kapanışı]`

---

## 7. Anti-Patterns / Forbidden Slop

Synthesized from `dominikmartn/hue`, `anthropics/frontend-design`, `pbakaus/impeccable` (`craft-floor.md`), `Leonxlnx/taste-skill`, and `Dammyjay93/interface-design` (`design-deslop.md`), these 14 rules are **hard release gates**:

1. **No Pure-White (`#FFFFFF`) Surfaces or Mixes on Parchment:** Never use `#FFFFFF` backgrounds on cards, tooltips (`.chart-tooltip`), or `color-mix(..., #FFFFFF)` inside `Badge` tones; always mix against `--surface-1` (`#FBF7EE`) or `--surface-overlay` (`#FCF9F2`).
2. **No Violet, Lavender, or Neon AI-Slop Accents:** Any color in OKLCH hue `270°–330°` (purple/violet/indigo-glow) or legacy sky-blue `#0284c7` (`themeColor`) is banned. Use `--accent` (`#193A73` Indigo Ink) or `--info` (`#1E478A` Prussian Blue).
3. **No Unchunked Multi-Row Tab Walls (`> 7` Flat Links):** Never render 11–18 flat sub-navigation links or 4 simultaneous multi-row link boxes above page content. Group into `<= 4` lifecycle stages with progressive disclosure.
4. **No Double Tab Bars on One Screen:** Never stack a `?tab=` query-param tab bar directly underneath `ModuleFrame`'s route tab bar (as seen in `/production`).
5. **No Grid-of-Identical-Boxes (`> 4` Uniform KPI Tiles in a Row):** Never drop 8 identical `KpiCard` rectangles of the same size/weight (`data/quality`). Promote 1–2 primary metrics with `RadialMeterSvg` / `StackedRibbonSvg` and demote secondary counts into a compact `StatStrip` or table summary.
6. **No Thick Colored `border-left` Callout Stripes (`> 1.5px`) on Standard Panels:** Reserve left accent bars exclusively for critical `Disclaimer` / `UrgentExceptionsStrip` alerts; standard `Panel`s use subtle header status dots or corner registration marks.
7. **No Proportional Digits on Changing or Tabular Numbers:** Missing `font-variant-numeric: tabular-nums` on any currency, percentage, day count, date, or table column is a `HIGH` severity defect.
8. **No Silent Zero Coercion (`0 TL` for `null`):** Missing or unparsed amounts MUST render as `TUTAR EKSİK` (`--warn`) with a direct link to `/payments/missing` or `/data/reviews`.
9. **No Monospace Costume on Turkish Prose:** Never apply `font-mono` to sentences, card titles, or currency words; `Geist Mono` is strictly for codes (`102.01`), dates, VKNs, and cell coordinates.
10. **No Uncapped Long-Form Line Lengths (`> 75ch`):** Never let paragraphs, disclaimers, or AI answers stretch full-width across `1580px` containers.
11. **No `< 16px` Inputs on Mobile Viewports:** Never allow `<input>` or `<select>` below `16px` under `640px` width (prevents iOS Safari auto-zoom).
12. **No Nested Cards or Mismatched Concentric Radii:** Never put a bordered shadowed card inside another bordered shadowed card (`taste-skill` max 2-box nesting rule), and enforce `outerRadius = innerRadius + padding`.
13. **No Heavy Unoptimized Hero JPEGs (`> 100 KB`) in App Chrome:** Module header vignettes MUST use compressed `.webp` plates (`30–55 KB`, e.g. `/modules/*-cream.webp`), never `500 KB–1 MB` raw `.jpg` files with `loading="eager"`.
14. **No Sluggish (`> 160ms`), `ease-in`, or `transition: all` Motion:** Never animate keyboard-repeated actions (`⌘K`, tab switches > `40ms`), never use `transition: all`, and honor `prefers-reduced-motion: reduce`.

---

## 8. Design System Notes for Stitch & Agent Generation

### Language to Use in Prompts
- **Atmosphere & Material:** *"Warm unbleached cotton-parchment canvas (`#F3EBDC`), elevated fine archival vellum cards (`#FBF7EE`), crisp deep iron-gall sepia typography (`#1D1813`), delicate 1px sepia ledger hairlines (`#D4C5AC`), subtle laid-linen paper grain, Financial Times & Mercury treasury discipline."*
- **Avoid in Prompts:** *"Glassmorphism"*, *"frosted neon"*, *"modern SaaS white cards"*, *"floating drop shadows"*, *"purple AI gradient"*.

### Component Generation Prompts
- **Prompt 1 — Executive Treasury Bento Row:** *"Design a 4-column responsive treasury metric row on warm cotton parchment (`#F3EBDC`) using fine vellum cards (`#FBF7EE`, `8px` radius, `1px` `rgba(58,42,24,0.13)` border). Card 1 shows Consolidated Free Cash (`28px` Geist Sans Bold `tabular-nums` in `#1D1813`, decoupled `TL` unit in `12.5px` `#5A4F43`) with an embedded `8px` tall pure-SVG TRY/USD/EUR stacked liquidity ribbon (`#1E478A`, `#193A73`, `#11694E`). Card 2 shows 13-Week Minimum Cash with a 12-point SVG horizon sparkline and dashed zero-line. Card 3 shows Net Working Capital with a mini SVG DIO+DSO−DPO cash conversion bridge. Card 4 shows Covenant & Facility Headroom with a proportional utilization bar."*
- **Prompt 2 — Two-Tier Stage Sub-Navigation (`/finance` & `/data`):** *"Design a compact two-tier module navigation bar below an archival masthead on `#F3EBDC`. Tier 1 is a segmented stage pill track (`#EAE0CC` background, `8px` outer radius, `2px` padding) containing 4 workflow stage pills (active stage in `#FBF7EE` with `6px` radius, `#1D1813` bold label, and subtle item count badge). Tier 2 is a clean 36px horizontal ledger tab strip showing only the 3–5 sub-routes of the active stage, with a `2px` Prussian Blue (`#1E478A`) active bottom indicator."*
- **Prompt 3 — 4-Way TDHP Reconciliation Table with Inline Tufte Bullet Bars:** *"Design a dense financial reconciliation table inside a `#FBF7EE` vellum panel (`11px` uppercase tracked `#5A4F43` headers, `13px` `#1D1813` rows separated by `1px` `#E5DAC6` hairlines). Include columns for Subledger Name, TDHP Account Code (`Geist Mono` `11.5px`), Operational Balance (`tabular-nums` right-aligned), GL Balance (`tabular-nums`), Inline SVG Variance Bullet Bar (`96px × 14px` Tufte bullet graph comparing subledger vs GL), Delta Amount, and Warm Paper Status Badge (`Mutabık` in `#E5EFE8`/`#11694E` or `Fark İncele` in `#F6E8D8`/`#A84608`)."*

### Incremental Iteration & Verification Gate
Every UI change against `DESIGN.md` must pass the **4-Point Craft Gate** (`interface-design` + `awwwards-quality-loop`) at `1366×900`, `768×1024`, and `375×812`:
1. **Squint Test:** Blur the screen — one focal metric/chart leads immediately; hierarchy steps cleanly across 4 sepia-ink tiers; no harsh borders jump out.
2. **Token Purity Check:** Zero `#FFFFFF` card/badge fills, zero violet hues, `<meta name="theme-color" content="#F3EBDC">`.
3. **Typography & Numeric Check:** Every changing/tabular figure has `tabular-nums`; prose stays `<= 72ch`; mobile inputs hold `16px`.
4. **Wayfinding Check:** Any of the 77+ sub-routes is reachable in `<= 2` clicks via Stage-Grouped Sub-Nav or `1` keystroke (`⌘K`) via Turkish task synonyms.
