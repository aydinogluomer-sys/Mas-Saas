# MAS Nakit Radar — Local Private Production Deploy (Option A)

Single-operator, single-machine, loopback-only. **Not** a public SaaS deployment.
Vercel / remote Supabase / multi-user auth are intentionally **out of scope** (see bottom).

## 0. Prerequisites

- Docker Desktop (for PostgreSQL 16)
- Node.js + `pnpm` (`npm i -g pnpm`)
- The private workbook at `data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx` (gitignored)

## 1. Environment

```bash
cp .env.example .env.local     # then edit .env.local
pnpm exec tsx scripts/deploy/check-env.ts   # validates presence, never prints secrets
```

Required / optional vars:

| Var | Req | Purpose |
|---|---|---|
| `DATABASE_URL` | ✅ | App + scripts DB connection (loopback Postgres) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | – | docker-compose Postgres credentials (change password for real use) |
| `SEED_ADMIN_PASSWORD` | – | Non-interactive password for `scripts/db/seed-admin.ts`. Server-only, never logged. Omit to be prompted (masked). |
| `MAS_QA_BYPASS_AUTH` | – | TestSprite QA harness only. Never set in production (ignored when `NODE_ENV=production`). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | – | Reminder delivery. Server-only. Unset → reminders log `failed` (no send). |
| `APP_COMMIT_SHA` / `APP_BUILD_TIME` | – | Shown on `/version` |

`.env.local`, `data/`, and `backups/` are gitignored — never committed.

## 2. Start (first run initializes the DB, then serves)

```bash
bash scripts/deploy/local-start.sh
```

This brings up Postgres (persistent volume `mas_radar_pgdata`), creates + migrates + seeds
the app DB **only on first run** (never wipes existing data), runs the env check, builds,
and serves on `http://127.0.0.1:3000`.

Windows PowerShell equivalent (if not using Git Bash):

```powershell
docker compose up -d
# first run only: create DB + migrations (see local-start.sh for the psql loop)
pnpm exec tsx scripts/deploy/check-env.ts
pnpm build
pnpm start
```

Stop: `bash scripts/deploy/local-stop.sh` (Ctrl-C the Next.js terminal; Postgres keeps data).

## 3. Import the real workbook

1. Place the file at `data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx`.
2. In the app: **İÇE AKTARIM → dosya yükle** (or `pnpm import:real` for the staging verifier).
3. On the workbook detail page, use the transfer buttons in order:
   - "kabul edilenleri radar'a aktar" (payments)
   - "nakit akışını aktar" (cashflow)
   - "çek/kredi aktar" (financing)
   - "üretim analitiğini aktar" (capacity/cost)
   Ambiguous rows wait in **incelemeler** (reviews); accept/resolve them, then re-transfer (idempotent).

## 4. Daily use

- **Reports** (`/reports`): "Günlük / Haftalık / Aylık üret". Read-only; no financial mutation.
- **Reminders** (`/reminders`): "bugünü planla" then "bekleyenleri gönder". Telegram is server-only;
  unset token → deliveries log `failed` honestly. Duplicate sends are prevented at the DB.
- **Scenarios** (`/scenarios`): fill assumptions, run. Read-only overlay; baseline never changes.

## 5. Health & version

- `GET /health` → `{ status, app, db, latencyMs, time }`. `db:"up"` = Postgres reachable. No secrets.
- `GET /version` → `{ name, version, commit, buildTime, node, env }`. No secrets.

## 6. Backup & restore

```bash
# Backup (custom-format dump → ./backups, gitignored — contains private financial data)
bash scripts/deploy/backup-db.sh mas_radar_dev

# Restore a dump into a FRESH database (refuses to overwrite unless FORCE=1)
bash scripts/deploy/restore-db.sh backups/mas_radar_dev-YYYYMMDD-HHMMSS.dump mas_radar_restored

# Serve the app from the restored DB by pointing DATABASE_URL at it, then /health.
```

Proven: a restored DB carries identical row counts (workbooks/cells/rows), all 33 public
tables, RLS enabled on every table, and seed data intact.

## 7. Verify (full gate)

```bash
pnpm lint && pnpm typecheck && pnpm test        # 138 tests
pnpm db:verify                                   # schema/constraints/RLS + 13 assertion groups
pnpm import:real
pnpm phase3:verify && pnpm phase4:verify && pnpm phase5:verify
pnpm phase6:verify && pnpm phase6b:verify && pnpm phase7:verify && pnpm phase8:verify
pnpm build
```

## 8. Security posture (local private)

- DB bound to `127.0.0.1` only (docker-compose); not reachable from the network.
- Real multi-user auth (P0-A): named accounts in `public.users`, argon2id password hashes,
  admin/operator roles, DB-backed sessions (random opaque token; only its SHA-256 is stored).
  A default-deny middleware matcher covers every route except `/login`, `/health`, `/version`.
  Bootstrap the first admin with `tsx scripts/db/seed-admin.ts --username <ad> --display-name "<Ad>"`;
  after that, manage accounts in the app at `/system/security` (admin only).
- Brute-force lockout: 5 failed logins lock the account for 15 minutes.
- At least one active admin must always exist — enforced by a DB constraint trigger (0031),
  not by the UI, so an admin script or a race between two sessions cannot bypass it.
- No service-role key or Telegram token in the client bundle (token read only inside
  `src/lib/reminders/transport.ts`, server-side).
- No `.xlsx` bundled to the client; workbook parsing is server-only.
- `/health` and `/version` expose no financial data and no secrets.
- Reminder dispatch never writes the token/chat id into payloads, logs, or messages.

**Limitations (accepted for MVP local use):**
- The access gate is a single shared password, not per-user auth or RBAC.
- Server actions run server-side but are not individually re-authenticated beyond the UI gate;
  acceptable on a trusted single machine. Do not expose this deployment to a public network.
- `.env.local` protects secrets by staying off git; there is no secrets manager.

## 9. Why not Vercel / remote Supabase yet?

- The workbook holds **private financial data**; the user's standing instruction is to keep it
  local and **not migrate to any remote Supabase project**. Verification is done entirely on
  local PostgreSQL. Moving to a hosted DB/edge would require a chosen target project, secrets
  management, and a data-egress review that are out of this MVP's scope.
- The app is deliberately DB-URL-portable (same migrations run anywhere), so a future hosted
  deploy is a config change, not a rewrite — but it stays a conscious, separate decision.
