# MAS Nexus — Public Repository Exposure Review, Secret Scan & Disclosure Containment (`F-01`)

- **Document Classification:** Security Audit, Redacted Disclosure Inventory & Containment Plan (`V2 Hardening — Agent 13`)
- **Audit Reference Commit:** `39c780f668011c52fd7e9ba2b7343009b88e1dde`
- **Repository Parent `HEAD`:** `65f29251ad9a98b4a87d50b25a807c5f00da631a` (branch `remediation/v2-hardening`)
- **Target Repository:** `aydinogluomer-sys/Mas-Saas` (`https://github.com/aydinogluomer-sys/Mas-Saas`)
- **Measured Visibility Baseline (`gh repo view`):** **`PUBLIC` (`isPrivate: false`)** — **P0 Finding `F-01` Confirmed (`DIRECT`)**
- **Measured Public Blast Radius (`gh api repos/aydinogluomer-sys/Mas-Saas`):** `forks_count = 0`, `stargazers_count = 0`, `subscribers_count = 0`, `has_pages = false`
- **Live Database / Remote Settings Mutations Executed by Audit:** **`0`** (`prod_db_writes = 0`; repository visibility and Git history untouched pending explicit owner approval)

> **STRICT REDACTION INVARIANT:** This document intentionally omits all raw credentials, tokens, full IBANs, real counterparty/vendor/customer/person/cardholder names, operational workbook filenames, host OS usernames, and full operational database row UUIDs. Every sensitive identifier is replaced by a deterministic placeholder (`[REDACTED_*]`, `TR** **** **** **** **** **26`, `<file>:<line>`).

---

## 1. Executive Summary & Baseline Reproduction

### 1.1 Failing Baseline Verification (`F-01`)
Read-only GitHub CLI verification confirmed that the canonical MAS Nexus repository has been publicly readable since `2026-08-17T09:25:54Z`:

```json
{
  "createdAt": "2026-08-17T09:25:54Z",
  "isPrivate": false,
  "nameWithOwner": "aydinogluomer-sys/Mas-Saas",
  "pushedAt": "2026-11-19T13:12:45Z",
  "url": "https://github.com/aydinogluomer-sys/Mas-Saas",
  "visibility": "PUBLIC"
}
```

### 1.2 Full-Scope Scan Coverage & Category Summary
A deterministic scan was executed across **`1,637` tracked working-tree files**, **`2` untracked V2 baseline files**, and **all `290` commits (`1,856` unique historical paths)** in `git log --all` from root commit `b325476cfed2e3f5338cf071aed6485d4fa23d73` through `65f29251ad9a98b4a87d50b25a807c5f00da631a`:

| Category | Scope Audited | Verdict | Finding Count & Summary |
| :--- | :--- | :---: | :--- |
| **Category A** | Real/hardcoded credentials, API keys, Telegram bot tokens, JWTs, private keys, DB passwords (working tree + `290` commits) | **`CLEAN` (`0` Live Secrets)** | **`0` real secrets committed** in working tree or Git history. All credential-shaped literals (`ci-only-not-a-secret-0123456789`, `faz2-visual-harness-not-a-secret`, `postgres:postgres`, `CHANGE_ME`, `[PASSWORD]`, and unit-test redaction fixtures) are verified disposable/synthetic placeholders. |
| **Category B** | Real financial counterparty names, cardholder/person names, transaction amounts, check maturity dates, IBANs, and internal operational UUIDs | **`P0 EXPOSED` (Public Repo)** | **High/Critical confidentiality exposure while repo is `PUBLIC`:** V1 forensic reports (`docs/remediation/*.md`), Phase-0 parse/mapping docs (`docs/data-map.md`, `docs/import-mapping.md`, `docs/phase0-parse-report.md`), release-evidence JSON/MD dossiers (`docs/release-evidence/**`), `supabase/seed.sql`, and live-DB verification tests/scripts disclose real company counterparties, named cardholder/telecom obligations, check amounts & maturity dates, workbook forecasts, and live `mas_radar_dev` row UUIDs. **`0` real IBANs exposed** (`16` working-tree / `24` historical `TR...` strings are all synthetic test/UI fixtures). |
| **Category C** | Operational topology, internal Windows file paths, OS/app usernames, hardware IDs, PostgreSQL cluster IDs, QA tunnel hostnames | **`P2 EXPOSED` (Public Repo)** | **`183` lines across `86` files** disclose local workstation path `C:\Users\[REDACTED_OS_USER]\...`, native PG16/backup paths (`C:\MAS\pgsql16`, `D:\MAS-Backups\mas_radar_dev`), USB SSD hardware model (`[REDACTED_USB_HARDWARE_ID]`), PG16 `system_identifier` (`[REDACTED_PG_SYSTEM_ID]`), active admin username (`[REDACTED_APP_USER_A]`), TestSprite project UUID, and offline Quick Tunnel hostname. |
| **Category D** | `.gitignore` protection of `.env.local`, `.env*.bak*`, `backups/*.dump`, `logs/`, `data/`, Playwright `.auth/` | **`PASS` (`0` Tracked)** | `git check-ignore -v`, `git ls-files`, and `git log --all --name-only` confirm **`.env.local`, `.env*.bak*`, `backups/`, `*.dump`, `*.sql.gz`, `logs/`, `data/`, `*.pem`, and `tests/visual/.auth/` are 100% ignored** and have **`0` commits** across all `290` commits. |

---

## 2. Redacted Exposure Inventory (`Working Tree` & `Git History`)

| Category | Severity | File Path & Line Range | Introduced Commit SHA | Redacted Description | Remediation Action |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **Cat. B (`B-01`)** | **`CRITICAL` (`P0`)** | `docs/remediation/security-report.md:17-22, 29, 56-57, 67` | `399f110bae86d1f20f2d6dc3f7b11f0b8b46b0fc` | Discloses named cardholder obligation `[REDACTED_CARDHOLDER_CC_A]`, exact high-value TRY settlement amount, due/import dates (`2026-06-09` / `2026-07-17`), source workbook `[REDACTED_WORKBOOK_A]`, active admin handle `[REDACTED_APP_USER_A]`, and `5` live `mas_radar_dev` row UUIDs (`payment_instances`, `payments`, `audit_logs`, `control_alerts`). | Immediately switch repo visibility `PUBLIC -> PRIVATE` (owner approval); replace names/UUIDs with `[REDACTED_*]` and synthetic UUIDs if docs are ever shared externally. |
| **Cat. B (`B-01`)** | **`CRITICAL` (`P0`)** | `docs/remediation/financial-reconciliation-report.md:13-16, 45-60, 64-77, 103-116, 131, 182-187` | `399f110bae86d1f20f2d6dc3f7b11f0b8b46b0fc` | Discloses `6` real monthly obligation labels (`[REDACTED_CARDHOLDER_CC_A]`, `[REDACTED_CARDHOLDER_CC_B]`, `[REDACTED_PERSON_TELECOM_A]`, `[REDACTED_LOAN_OBLIGATION_A]`, `[REDACTED_VENDOR_ALARM_A]`), monthly TRY totals (`2026-06..2026-12`), partial loan payment figures, `6` cash/card account names (`[REDACTED_CASH_ACCOUNTS_SET]`), negative `35`-month forecast balances, `4` check rows for `[REDACTED_COUNTERPARTY_CHECK_A]` with maturity dates (`2026-08-31`, `2026-10-31`) and amounts, and `12` live `mas_radar_dev` UUIDs. | Switch repo visibility `PUBLIC -> PRIVATE`; adopt public-safe redaction policy (`[REDACTED_COUNTERPARTY_*]`, synthetic UUIDs) for future reports. |
| **Cat. B (`B-01`)** | **`HIGH` (`P0`)** | `docs/remediation/architecture-baseline.md:22, 31`<br>`docs/remediation/incident-matrix.md:11, 15, 17-18, 21`<br>`docs/remediation/database-report.md:16, 38, 93-96`<br>`docs/remediation/qa-release-gates.md:56-58, 154-161`<br>`docs/remediation/integration-report.md:19, 21, 26` | `399f110bae86d1f20f2d6dc3f7b11f0b8b46b0fc` | Cross-references `[REDACTED_LOAN_OBLIGATION_A]` partial payment amounts, `[REDACTED_COUNTERPARTY_CHECK_A]` duplicate check count/maturity/amount, `[REDACTED_VENDOR_ALARM_A]`, `[REDACTED_WORKBOOK_A]` (`1,601` rows), live `mas_radar_dev` table monetary aggregates, and `7` operational UUIDs/prefixes. | Switch repo visibility `PUBLIC -> PRIVATE`; keep future gate evidence restricted to synthetic disposable DBs or redacted tokens. |
| **Cat. B (`B-02`)** | **`HIGH` (`P0`)** | `docs/data-map.md:9-11, 19-38`<br>`docs/import-mapping.md:14-24, 31-40, 57-60`<br>`docs/phase0-parse-report.md:8-120` | `b325476cfed2e3f5338cf071aed6485d4fa23d73` | Phase-0 audit of operational Excel workbooks (`[REDACTED_WORKBOOK_ORIGINAL]` & `[REDACTED_WORKBOOK_A]`) exposing real customer, vendor, bank, and employee/family person labels (`[REDACTED_CUSTOMERS_SET]`, `[REDACTED_VENDORS_SET]`, `[REDACTED_PERSONS_SET]`), 48-month loan principal/interest schedule parameters, capacity revenue figures, and workbook SHA-256 prefixes. | Switch repo visibility `PUBLIC -> PRIVATE`; if repository is ever re-published externally, purge historical Phase-0 PII via owner-approved `git filter-repo`. |
| **Cat. B (`B-02`)** | **`HIGH` (`P0`)** | `supabase/seed.sql:11-27` | `d8682ec0d6fa45dfa06478f93dca541e6fc51306` | Seeds `public.parties` (`customer`, `vendor`, `bank`, `provider`, `person`) and `public.cash_accounts` with `16` real company counterparty/person names and `6` operational account labels from Phase-0 discovery. | Switch repo visibility `PUBLIC -> PRIVATE`; replace seed labels with generic synthetic tenant names before any external/SaaS distribution. |
| **Cat. B (`B-02`)** | **`HIGH` (`P0`)** | `docs/release-evidence/final-production-readiness/00-real-db-drift-manifest.md:75-124`<br>`docs/release-evidence/final-production-readiness/p24b-discovery/10-metin.json:1-950`<br>`docs/release-evidence/final-production-readiness/p24b-discovery/11-uuid.json:1-950`<br>`docs/release-evidence/final-production-readiness/p24b-discovery/12-zaman.json:1-950` | `d5012dab9bdd5d43719275e93abb286987d4f2fe`<br>`7d5f038905fac1f9a2c6aebbc512681818f174f9` | Read-only cutover & fixture-cleanup forensic snapshots containing live `mas_radar_dev` row UUIDs (`20` UUID groups), text metadata (`12` findings), timestamp windows (`50` findings), admin username `[REDACTED_APP_USER_A]`, and local backup SHA-256 digests. | Switch repo visibility `PUBLIC -> PRIVATE`; prohibit committing raw live-DB JSON discovery dumps under `docs/release-evidence/`. |
| **Cat. B (`B-03`)** | **`MEDIUM` (`P1`)** | `scripts/qa/verify-rg-15-gates.ts:634-659, 1078-1143, 1295-1305`<br>`tests/remediation/agent04-financial-reconciliation.test.ts:212-549`<br>`tests/remediation/agent08-cfo-reporting.test.ts:41-654`<br>`tests/remediation/agent09-security-isolation.test.ts:298-403`<br>`tests/remediation/agent10-data-quality.test.ts:153-879`<br>`tests/remediation/mandatory-16-scenarios.test.ts:946-1593` | `399f110bae86d1f20f2d6dc3f7b11f0b8b46b0fc` | Live read-only DB assertions and synthetic regression fixtures referencing operational obligation/check names (`[REDACTED_LOAN_OBLIGATION_A]`, `[REDACTED_COUNTERPARTY_CHECK_A]`, `[REDACTED_WORKBOOK_A]`) and live `mas_radar_dev` row UUIDs. | Contained once repo is `PRIVATE`; migrate disposable CI gates (`Agent 11` / `Agent 12`) to 100% synthetic seeded fixtures. |
| **Cat. B (`B-03`)** | **`MEDIUM` (`P1`)** | `scripts/seed-demo.ts:73-109`<br>`scripts/phase3-verify.ts:70-168`<br>`scripts/phase13b-verify.ts:47-56`<br>`scripts/qa/p24b-cleanup-dryrun.ts:28-51`<br>`src/app/(dashboard)/scenarios/page.tsx:1126-1142`<br>`src/lib/data-quality/remediation-metrics.ts:88` | `24ff9277aebdaaf6ab4a9abbc349af5522da92c7`<br>`a2c791147327c58c460ac4378477145939202a64`<br>`7d5f038905fac1f9a2c6aebbc512681818f174f9` | Legacy review filters (`%[REDACTED_PERSON]%`), scenario preset labels (`[REDACTED_COUNTERPARTY_CHECK_A]`, `[REDACTED_COUNTERPARTY_B]`), and `15` historical fixture-cleanup UUIDs. | Contained once repo is `PRIVATE`; parameterize scenario UI presets with neutral Turkish business examples in future UI pass. |
| **Cat. B (`B-04`)** | **`INFO` (`SAFE`)** | `scripts/phase19-verify.ts:160-234`, `scripts/db/constraints-verify.ts:157-178`, `scripts/qa/verify-rg-15-gates.ts:933, 1318-1319`, `src/app/(dashboard)/finance/bank/page.tsx:279`, `src/app/(dashboard)/finance/counterparties/page.tsx:710`, `tests/**/*.test.ts` (`16` working-tree / `24` historical `TR...` strings) | `80716fd2` .. `399f110b` | **Zero real IBANs committed** (`mas_radar_dev` `public.ibans` = `0` rows). All occurrences are ISO 13616 / TCMB published example `TR** **** **** **** **** **26` (`45` test hits), `phase19` synthetic `TR** **** **** **** **** **99` (`2` hits), UI mask `TR00 0000 ... 00` (`2` hits), or invalid-MOD-97 negative test probes. | Enforced continuously via `.gitleaks.toml` rule `mas-turkish-iban` (blocks any `TR` IBAN outside allowlisted test fixtures and `TR00...00` mask). |
| **Cat. C (`C-01`)** | **`MEDIUM` (`P2`)** | `docs/remediation/*.md`, `docs/ops/*.md`, `docs/MAS_360_SYNTHESIS_REPORT.md`, `docs/release-evidence/**`, `scripts/**`, `src/**`, `tests/**` (`183` lines across `86` files) | `b325476c` .. `399f110b` | Absolute Windows workstation paths (`C:\Users\[REDACTED_OS_USER]\Mas Saas\...`), local PG16 binary/data paths (`C:\MAS\pgsql16\bin`, `C:\MAS\pgdata16`), and off-device backup path (`D:\MAS-Backups\mas_radar_dev`). | Switch repo visibility `PUBLIC -> PRIVATE`; use repository-relative links (`../../src/...`) instead of `file:///c:/Users/...` in future docs. |
| **Cat. C (`C-02`)** | **`LOW` (`P2`)** | `docs/remediation/database-report.md:4`<br>`docs/remediation/backup-restore-report.md:12, 21`<br>`docs/backup-restore-policy.md:139`<br>`.testsprite/config.json:2-3`<br>`docs/remediation/qa-release-gates.md:141` | `94cc002c1da4fe2911694519da549de3503fae71`<br>`399f110bae86d1f20f2d6dc3f7b11f0b8b46b0fc` | Discloses USB SSD vendor/model string (`[REDACTED_USB_HARDWARE_ID]`), PG16 `system_identifier` (`[REDACTED_PG_SYSTEM_ID]`), canonical DB/role names (`mas_radar_dev`, `mas_radar_app`), TestSprite project UUID (`[REDACTED_UUID_TESTSPRITE]`), and offline ephemeral tunnel (`https://[REDACTED_TUNNEL_SUBDOMAIN].trycloudflare.com`). | Contained once repo is `PRIVATE`; ephemeral Quick Tunnel is offline (`TUNNEL_DOWN`) and carries zero active ingress. |
| **Cat. A (`A-01`)** | **`INFO` (`CLEAN`)** | `.github/workflows/ci.yml:19, 69-100, 176-332`<br>`scripts/ci/run-phase-verifies.sh:36`<br>`tests/visual/global-setup.ts:88`<br>`.env.example:8-10`<br>`tests/**/*.test.ts`, `scripts/qa/verify-rg-15-gates.ts:935` | `62f2de5459e85cfb5679aa0b4bcaa30f2612b661`<br>`dcb3c4c9c80e7630f499af7ae3adfe997c951579`<br>`a6524b8d4a7c3e46b36ffce6846cdb30fb591c0f` | **`0` real secrets in working tree or `290`-commit Git history.** Committed credential-shaped values are strictly disposable CI/test markers (`ci-only-not-a-secret-0123456789`, `faz2-visual-harness-not-a-secret`, `postgres:postgres`, `CHANGE_ME`, `[PASSWORD]`) and synthetic redaction unit-test strings. | Locked by `.gitleaks.toml` (`8` MAS-specific rules + Gitleaks default ruleset, `0` working-tree violations, `11/11` positive/negative controls `PASS`). |
| **Cat. D (`D-01`)** | **`INFO` (`PASS`)** | `.gitignore:25, 34-36, 50, 53-55, 87, 93, 124` | `b325476cfed2e3f5338cf071aed6485d4fa23d73` (updated `7d5f038905fac1f9a2c6aebbc512681818f174f9`) | Verified `.env*` (`!.env.example`), `.env*.bak*`, `/backups/`, `*.dump`, `*.sql.gz`, `/logs/`, `/data/`, `*.pem`, `/tests/visual/.auth/`, and `/.runtime/` are ignored (`0` tracked files, `0` historical commits; `0` `.env*.bak*` files present on host). | Maintain `.gitignore` rules; optionally append `*.key`, `*.p12`, `*.pfx`, `*.enc` in a future `.gitignore`-owner wave as defense-in-depth. |

---

## 3. Category A Disambiguation: Why Committed Placeholders Are Not Live Secrets

Every credential-shaped match across all `290` commits and `1,637` tracked files was audited and verified to belong exclusively to one of five non-secret classes:

1. **Disposable GitHub Actions Ephemeral Runner Password (`ci-only-not-a-secret-0123456789`):**
   - Present in `.github/workflows/ci.yml:19, 100, 176, 192, 202, 263, 316` and `scripts/ci/run-phase-verifies.sh:36`.
   - Used solely inside ephemeral `ubuntu-latest` CI containers created from scratch and destroyed at job teardown; rejected on production/local `.env.local` by `scripts/check-env.ts`.
2. **Disposable Playwright Visual/Authz Harness Marker (`faz2-visual-harness-not-a-secret`):**
   - Present in `tests/visual/global-setup.ts:88` for seeding disposable E2E verification users (`mas_radar_*_verify`); guarded against `mas_radar_dev`.
3. **Template & Documentation Placeholders (`CHANGE_ME`, `<PAROLA>`, `<POSTGRES_PAROLASI>`, `[PASSWORD]`, `postgres:postgres`):**
   - Present in `.env.example:8, 10`, cutover runbooks (`docs/real-db-cutover-runbook.md`, `docs/release-evidence/env-local-cutover-steps.md`), CI loopback owner URLs, and deleted historical script `46541d8b:scripts/db/migrate-supabase.ts:17` (`postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres`).
   - Mention of `supabase.co` / `pooler.supabase.com` in `docs/MAS_360_SYNTHESIS_REPORT.md:406`, `docs/release-evidence/wave0/02-wave0-kod-karantinasi.md:50`, `docs/status-notes.md:4594`, and `docs/todo.md:371` refers only to generic domain names in Wave-0 quarantine audit notes (zero project ref IDs, zero service-role JWTs, zero DB passwords).
4. **Non-Connecting Unit-Test Sentinel (`unit_test_no_connect` / `nouser:nopass`):**
   - `src/lib/env.ts:102` (`postgres://unit_test_no_connect:x@127.0.0.1:5432/unit_test_no_connect`) and `scripts/db/migrate-verify.ts:169` (`postgres://nouser:nopass@127.0.0.1:1/nonexistent_db_for_preflight_test`) never authenticate against any database.
5. **Redaction Self-Test Fixtures (`redactSecrets` / `looksLikeSecret` / `redactBotToken`):**
   - Synthetic test inputs inside `tests/**/*.test.ts`, `src/lib/ops/alert-delivery.test.ts`, `scripts/ops/telemetry-alerting-verify.ts`, and `scripts/qa/verify-rg-15-gates.ts:935` verify that MAS Nexus strips credentials before writing logs or sending alerts.

---

## 4. Category D Verification: `.gitignore` & Untracked Secret Hygiene

Verified via `git check-ignore -v`, `git ls-files`, and `git log --all --name-only`:

| Target Path / Pattern | `.gitignore` Rule | `git check-ignore` | Tracked in `HEAD` | Ever Committed (`290` Commits) |
| :--- | :--- | :---: | :---: | :---: |
| `.env`, `.env.local`, `.env.production` | `.gitignore:34` (`.env*`, `!.env.example` at `:35`) | **`IGNORED`** | `0` | `0` |
| `.env.local.bak*` | `.gitignore:36` (`.env*.bak*`) | **`IGNORED`** (`0` on disk) | `0` | `0` |
| `backups/` & `*.dump` & `*.sql.gz` | `.gitignore:53-55` (`/backups/`, `*.dump`, `*.sql.gz`) | **`IGNORED`** | `0` | `0` |
| `logs/` (`alerts.jsonl`, `ops-incident-state.json`) | `.gitignore:93` (`/logs/`) | **`IGNORED`** | `0` | `0` |
| `data/` (local financial `.xlsx` workbooks) | `.gitignore:50` (`/data/`) | **`IGNORED`** | `0` | `0` |
| `tests/visual/.auth/` (Playwright session cookies) | `.gitignore:87` (`/tests/visual/.auth/`) | **`IGNORED`** | `0` | `0` |
| `*.pem` (TLS/key files) | `.gitignore:25` (`*.pem`) | **`IGNORED`** | `0` | `0` |

---

## 5. Containment & Remediation Plan

### Step 1 — Immediate Containment (Requires Explicit Repository Owner Approval)
> **CRITICAL GOVERNANCE GATE:** Per strict safety rules, no automated agent may change GitHub repository visibility without explicit owner authorization. Once approved by the user, execute the following command immediately in an authenticated terminal:

```powershell
# 1. Switch repository visibility from PUBLIC to PRIVATE
gh repo edit aydinogluomer-sys/Mas-Saas --visibility private --accept-visibility-change-consequences

# 2. Verify repository is now strictly PRIVATE (must report "visibility":"PRIVATE", "isPrivate":true)
gh repo view aydinogluomer-sys/Mas-Saas --json nameWithOwner,visibility,isPrivate

# 3. Re-confirm zero public forks existed prior to lock-down
gh api repos/aydinogluomer-sys/Mas-Saas --jq "{visibility,private,forks_count,stargazers_count,subscribers_count}"
```

- **Operational Consequence Note (`GitHub Actions`):** Switching a personal GitHub repository from `PUBLIC` to `PRIVATE` moves `ubuntu-latest` CI minutes from unlimited public-repo minutes to the account's private Actions quota (`2,000` free minutes/month on GitHub Free, or Pro/Team quota). Verify Actions billing/quota remains active so the 8-job CI gate (`Agent 12`) runs uninterrupted after privatization.

### Step 2 — Credential Verification & Preventive Rotation Checklist

- **Emergency Compromised-Secret Rotation Required:** **`NONE` (`0` real credentials or tokens were ever committed to the repository or Git history).**
- **Recommended Preventive Defense-in-Depth Checklist (Local Workstation `.env.local`):**
  - [ ] **Local File ACL & Backup Sweep:** Confirm `.env.local` on the Windows host restricts read permissions to the local operator/service account (`icacls .env.local`) and confirm zero plaintext `.env*.bak*` copies exist anywhere outside the repo (e.g., Desktop/Downloads).
  - [ ] **Telegram Bot Token (`TELEGRAM_BOT_TOKEN`):** Although never committed to Git, if `TELEGRAM_BOT_TOKEN` was ever pasted into external chat/support transcripts during earlier debugging, issue `/revoke` via `@BotFather`, update `.env.local`, and restart `pnpm ops:worker` & `pnpm ops:telegram:worker`.
  - [ ] **OpenAI / Email / Internal Keys (`OPENAI_API_KEY`, `EMAIL_API_KEY`, `TELEGRAM_INTERNAL_API_KEY`):** Confirm `AI_FORCE_DETERMINISTIC=1` in closed-circuit mode unless cloud LLM egress is explicitly desired; rotate `OPENAI_API_KEY` in the OpenAI dashboard on standard quarterly hygiene schedule.
  - [ ] **Local PostgreSQL 16 Passwords (`MAS_RADAR_APP_DB_PASSWORD`, `postgres`):** Bound strictly to `127.0.0.1:5432` (`pg_hba.conf` loopback `scram-sha-256`) and never committed to Git; rotate on routine operational schedule via `pnpm db:app-role:password` (`docs/ops/password-rotation.md`).
  - [ ] **Named Admin Account (`[REDACTED_APP_USER_A]` & `admin`):** Enforce strong password (`>= 12` chars, Argon2id) and review active sessions in `/system/security` given username disclosure in `docs/remediation/security-report.md:29`.

### Step 3 — Redaction & Public-Safe Documentation Policy (Mandatory Going Forward)

All documentation, release-evidence artifacts, SQL seeds, and verification tests committed after `65f29251ad9a98b4a87d50b25a807c5f00da631a` must obey five rules:
1. **Zero Real Counterparty or Person Names:** Always use `[REDACTED_COUNTERPARTY_A]`, `[REDACTED_CARDHOLDER_A]`, `[REDACTED_PERSON_A]`, or clearly synthetic names (`Sentetik Tedarikçi A.Ş.`, `Ornek Müşteri Ltd.`).
2. **Synthetic UUIDs Only in Docs & Tests:** Never paste live `mas_radar_dev` row UUIDs into Markdown reports or committed JSON artifacts; use deterministic synthetic UUIDs (`00000000-0000-4000-8000-000000000001`).
3. **Masked IBANs Outside Approved Test Fixtures:** Always render IBANs in documentation and operational logs as `TR** **** **** **** **** **26`. Unmasked `26`-character `TR` IBANs outside allowlisted unit-test fixtures fail `.gitleaks.toml` (`mas-turkish-iban`).
4. **Repository-Relative Links Only:** Never commit `file:///c:/Users/...` workstation paths; use relative Markdown paths (`../../src/lib/...`).
5. **Automated CI Gate Enforcement:** `.gitleaks.toml` (authored by `Agent 13`) and `scripts/ci/verify-secret-exposure.ts` (wired into `.github/workflows/ci.yml` by `Agent 12`) block any pull request or push introducing credentials, tokens, private keys, or unapproved IBANs.

### Step 4 — Optional Post-Approval Git History Purge Plan (`git filter-repo`)

> **CRITICAL WARNING — NEVER RUN AUTOMATICALLY:** Rewriting Git history (`git filter-repo`, `git rebase`, `git push --force`) invalidates every commit SHA referenced across release verdicts, audit logs, and open branches. **Do NOT execute history rewriting unless (a) the repository owner gives explicit written consent AND (b) the repository must be shared with external third parties or returned to `PUBLIC` visibility.** Once `aydinogluomer-sys/Mas-Saas` is set to `PRIVATE` (`forks_count = 0`), history rewriting is **not required** for internal single-tenant operation.

If the owner explicitly authorizes a future history sanitization for external/SaaS distribution:
1. **Create an Offline Bare Mirror Backup First:**
   ```powershell
   git clone --mirror https://github.com/aydinogluomer-sys/Mas-Saas.git C:\MAS-Safe-Mirror\Mas-Saas-pre-purge.git
   ```
2. **Freeze All Active Branches & Prepare a Local Expressions File (Outside Repo, Never Committed):**
   Create `C:\MAS-Safe-Mirror\replace-expressions.txt` mapping each real counterparty/person/workbook/username literal and live UUID to `[REDACTED_COUNTERPARTY_A]`, `[REDACTED_PERSON_A]`, `[REDACTED_WORKBOOK_A]`, `[REDACTED_OS_USER]`, etc., and list `docs/release-evidence/final-production-readiness/p24b-discovery/` for path removal if desired.
3. **Run `git filter-repo` on a Fresh Clone Only (Never on Live Production Checkout):**
   ```powershell
   git clone https://github.com/aydinogluomer-sys/Mas-Saas.git C:\MAS-Safe-Mirror\Mas-Saas-sanitized
   cd C:\MAS-Safe-Mirror\Mas-Saas-sanitized
   git filter-repo --replace-text C:\MAS-Safe-Mirror\replace-expressions.txt
   ```
4. **Verify Clean History with Gitleaks Before Any Owner-Approved Force Push:**
   ```powershell
   gitleaks git --config .gitleaks.toml --verbose
   ```
   Only after `0` leaks and full `8/8` CI verification on the sanitized clone may the repository owner decide whether to force-update remote refs.
