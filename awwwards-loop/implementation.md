# Awwwards Quality Loop — Iteration 04: Archival Parchment Materiality, 7-Skill Synthesis, Flow Architecture & Enterprise Gap Closure

## Target

- Routes audited: `/`, `/payments`, `/cashflow`, `/finance`, `/finance/ledger`, `/finance/collections`, `/production`, `/production/kiosk`, `/scenarios`, `/insights`, `/data/imports`, `/data/integrations`, `/data/documents`, `/system/controls`, `/system/security`, `/login`
- Passing score: `>= 90/100` (every category `>= 70%`, never self-awarding `100%`)
- Viewports: Desktop `1366×900`, Tablet `768×1024`, Mobile `375×812`

## Research & Baseline Foundations (Iteration 04)

- [x] Synthesize 7 primary GitHub UI/Design skills into `DESIGN.md` and `ui_ux_research_and_flow_architecture_report.md`:
  1. `dominikmartn/hue` (perceptual OKLCH tonal harmony & semantic contrast)
  2. `google-labs-code/stitch-skills/.../extract-design-md` (`DESIGN.md` canonical design contract)
  3. `jakubkrehel/skills/.../better-typography` (optical sizing, `tabular-nums lining-nums`, `60–72ch` measure, `text-wrap: balance`/`pretty`)
  4. `anthropics/skills/.../frontend-design` (anti-AI-slop materiality, editorial commitment, distinctive composition)
  5. `pbakaus/impeccable` (spatial rhythm, hairline alignment, polish critique loop)
  6. `Leonxlnx/taste-skill` (high-taste editorial hierarchy, elimination of generic card clutter)
  7. `Dammyjay93/interface-design` (domain-authentic financial ledger craft, intent-driven navigation, high data-ink ratio)
- [x] Competitor & Inspiration synthesis: Mercury, Ramp, Brex, Agicap, Kyriba, Runway, Fathom, Mosaic, Stripe + Awwwards/Behance/Dribbble archival editorial dashboards
- [x] Bespoke visual asset suite installed (`public/textures/archival-parchment-tile.jpg` + all 9 module copperplate engravings in `public/visuals/*.jpg`)

## Phases (Iteration 04)

1. **Wave 1 — Research, Asset Generation, Schema `0121` & Core Engines:**
   - `DESIGN.md` + `ui_ux_research_and_flow_architecture_report.md`
   - Migration `0121_enterprise_gaps_kiosk_intercompany_reset_comments.sql` (5-tier RLS)
   - `intercompany-elimination.ts`, `smart-extractor.ts`, `password-reset.ts`, `comments.ts`
   - Live Open Banking, ISO 20022 `pain.002` status parser, GİB Special Integrator, POS Settlement connectors & Multi-Channel Email/SMS/WhatsApp transport
2. **Wave 2 — UI/UX Architecture, Tactile Parchment, Wayfinding & Multi-Module Visualizations (`ui-ux-architect` Fleet):**
   - Real cotton-rag parchment background texture (`archival-parchment-tile.jpg`), ruled folio hairlines, corner marks, and 9/9 module copperplate art in `module-framing.ts`
   - Pure-SVG Editorial Visualization Library (`src/components/charts/folio-visuals.tsx`: `FolioArcGauge`, `FolioStackedRibbon`, `FolioFlowStepper`, `FolioBulletBar`, `FolioQrBadge`) deployed across `/`, `/payments`, `/cashflow`, `/finance`, `/production`, `/scenarios`, `/insights`, `/data`, `/system`
   - Flow & Findability Architecture: Grouped Stage Sub-Navigation in `ModuleTabs` (taming 17-tab `/finance` and 11-tab `/data` walls), End-to-End Financial Lifecycle Stepper & Intent-Driven Task Launcher ("Ne yapmak istiyorsunuz?"), Notification Bell + `TR / EN` Executive Language Toggle in header
3. **Wave 3 — Full UI Integration of `eksik_ve_yapilmayanlar_raporu.md` Features:**
   - `/production/kiosk`: Shop-Floor CNC Operator Barcode/QR Kiosk (Start / Downtime / Scrap / Complete work orders, zero financial leakage)
   - `/finance/ledger` & `/finance/collections`: Intercompany `120↔320` / `600↔7xx` Elimination UI + ISO 20022 `pain.002` bank status upload
   - `/data/integrations` & `/data/documents`: Open Banking / Special Integrator / POS Settlement sync controls + Smart Document OCR/Structured Field Extraction & 1-click Draft Invoice/Payment
   - `/login` & `/system/security`: Self-service "Parolamı Unuttum" token flow + Enterprise SSO (Entra ID / Google Workspace OIDC) & Passkey configuration + `@mention` record comments drawer
   - Technical backlog cleanups (`PWA` kill-switch retirement / V2 `2.1.0` deprecation notes / script `::float8` cleanup)
4. **Wave 4 — Live `0121` Migration, Standing Gates, Build, Browser QA (`1366×900`, `768×1024`, `375×812`) & `<= 60 ms` Latency Proof:**
   - Record `awwwards-loop/reports/iteration-04.md` (`>= 90/100`) and update `awwwards-loop/state.json`.
