// Faz 17-38 & V2 F-07 denetimi — "does an export/search hand a tier or cross-entity session rows RLS hides from it?"
//
// WHY THIS GATE EXISTS, AND WHAT IT REFUSES TO ACCEPT AS AN ANSWER.
//
// /api/analytics/export and /api/search both READ code that says they use getPool() — the
// role-scoped pool — and requireApiSession(). Reading source text with a regex is NOT evidence:
//   1) A denied SELECT and an empty table look identical unless paired with a POSITIVE CONTROL.
//   2) Regex-sniffing source text for function names fails on valid refactors (getCurrentUser ->
//      requireApiSession) and falsely passes on commented-out or bypassed handlers.
//
// Every negative check below therefore executes behaviorally against disposable PostgreSQL RLS
// AND the real route handlers (/api/search and /api/analytics/export), paired with positive
// controls AND a mandatory negative-control self-test proving a broken 200 handler is rejected.
//
// Usage:
//   pnpm db:export-leakage:verify

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { APP_ROLES, DB_ROLE, type AppRole } from "../../src/lib/authz/matrix";
import { readEnvLocal, swapDatabase } from "./app-url";
import {
  assertLocalPgReachable,
  createDisposableLocalDb,
  dropDisposableLocalDb,
  psqlLocalFile,
  resolveLocalOwnerUrl,
} from "./pg-local-admin";

const ROOT = process.cwd();
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATE_SCRIPT = path.join(ROOT, "scripts", "db", "migrate.ts");
const BOOTSTRAP_SQL = path.join(ROOT, "scripts", "db", "local-bootstrap.sql");

const DB = "mas_radar_export_leakage_verify";
const DISPOSABLE_PREFIX = "mas_radar_export_leakage_verify";
const FORBIDDEN_DB_NAME = "mas_radar_dev";

export interface RouteBehavioralVerifyOptions {
  routeLabel: string;
  handler: (request: Request) => Promise<Response>;
  buildUnauthenticatedRequest: () => Request;
  buildMustChangePasswordRequest?: () => Request;
  buildEntityARequest?: () => Request;
  buildEntityBRequest?: () => Request;
  entityASecretMarker: string;
  wrapRequestExecution?: <T>(request: Request, fn: () => Promise<T>) => Promise<T>;
}

export interface RouteBehavioralVerifyOutcome {
  routeLabel: string;
  pass: boolean;
  rejected: boolean;
  unauthenticatedStatus: number;
  mustChangePasswordStatus: number | null;
  entityAStatus: number | null;
  entityBStatus: number | null;
  entityASawMarker: boolean | null;
  entityBLeakedMarker: boolean | null;
  failureReasons: string[];
}

interface NextRequestStorageAdapters {
  workAsyncStorage: { run: <T>(store: Record<string, unknown>, fn: () => T) => T };
  workUnitAsyncStorage: { run: <T>(store: Record<string, unknown>, fn: () => T) => T };
  RequestCookies: new (headers: Headers) => unknown;
  RequestCookiesAdapter: { seal: (cookies: unknown) => unknown };
  HeadersAdapter: { seal: (headers: Headers) => unknown };
}

let cachedNextAdapters: NextRequestStorageAdapters | null = null;

function getNextRequestStorageAdapters(): NextRequestStorageAdapters {
  if (cachedNextAdapters) return cachedNextAdapters;
  (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;
  const req = createRequire(import.meta.url);
  const { workAsyncStorage } = req(
    "next/dist/server/app-render/work-async-storage.external",
  ) as Pick<NextRequestStorageAdapters, "workAsyncStorage">;
  const { workUnitAsyncStorage } = req(
    "next/dist/server/app-render/work-unit-async-storage.external",
  ) as Pick<NextRequestStorageAdapters, "workUnitAsyncStorage">;
  const { RequestCookies } = req(
    "next/dist/server/web/spec-extension/cookies",
  ) as Pick<NextRequestStorageAdapters, "RequestCookies">;
  const { RequestCookiesAdapter } = req(
    "next/dist/server/web/spec-extension/adapters/request-cookies",
  ) as Pick<NextRequestStorageAdapters, "RequestCookiesAdapter">;
  const { HeadersAdapter } = req(
    "next/dist/server/web/spec-extension/adapters/headers",
  ) as Pick<NextRequestStorageAdapters, "HeadersAdapter">;

  cachedNextAdapters = {
    workAsyncStorage,
    workUnitAsyncStorage,
    RequestCookies,
    RequestCookiesAdapter,
    HeadersAdapter,
  };
  return cachedNextAdapters;
}

/**
 * Binds Next.js 15 App Router request headers & cookies AsyncLocalStorage stores so real route
 * handlers calling `cookies()` / `headers()` from `next/headers` execute deterministically in CLI
 * verification scripts without a mocking framework.
 */
export async function invokeWithNextRequestContext<T>(
  request: Request,
  fn: () => Promise<T>,
): Promise<T> {
  const adapters = getNextRequestStorageAdapters();
  const route = new URL(request.url).pathname;
  const sealedCookies = adapters.RequestCookiesAdapter.seal(
    new adapters.RequestCookies(request.headers),
  );
  const sealedHeaders = adapters.HeadersAdapter.seal(request.headers);

  return adapters.workAsyncStorage.run(
    { route, forceStatic: false, dynamicShouldError: false },
    () =>
      adapters.workUnitAsyncStorage.run(
        {
          type: "request",
          phase: "action",
          cookies: sealedCookies,
          userspaceMutableCookies: sealedCookies,
          headers: sealedHeaders,
        },
        fn,
      ),
  );
}

/**
 * Behavioral route authorization & multi-entity isolation verifier (`F-07`).
 *
 * Replaces brittle source-regex checks with actual HTTP `Request -> Response` probes:
 *   1. Unauthenticated request MUST return 401/403 with zero secret markers.
 *   2. Optional `must_change_password = true` session request MUST return 401/403 with zero secret markers.
 *   3. Optional Entity A positive-control request MUST return 200 and include `entityASecretMarker`.
 *   4. Optional Entity B cross-entity request MUST return 200 and contain ZERO occurrences of `entityASecretMarker`.
 */
export async function verifyRouteAuthAndIsolationBehavior(
  options: RouteBehavioralVerifyOptions,
): Promise<RouteBehavioralVerifyOutcome> {
  const failureReasons: string[] = [];
  const execReq =
    options.wrapRequestExecution ??
    (async <T>(_req: Request, fn: () => Promise<T>): Promise<T> => fn());

  const runHandler = async (req: Request): Promise<{ status: number; bodyText: string }> => {
    const res = await execReq(req, () => options.handler(req));
    const bodyText = await res.text();
    return { status: res.status, bodyText };
  };

  const unauth = await runHandler(options.buildUnauthenticatedRequest());
  if (unauth.status !== 401 && unauth.status !== 403) {
    failureReasons.push(
      `unauthenticated request expected 401/403, got ${unauth.status}`,
    );
  }
  if (options.entityASecretMarker && unauth.bodyText.includes(options.entityASecretMarker)) {
    failureReasons.push("unauthenticated response leaked entityASecretMarker");
  }

  let mustChangePasswordStatus: number | null = null;
  if (options.buildMustChangePasswordRequest) {
    const mcp = await runHandler(options.buildMustChangePasswordRequest());
    mustChangePasswordStatus = mcp.status;
    if (mcp.status !== 401 && mcp.status !== 403) {
      failureReasons.push(
        `must_change_password=true session expected 401/403, got ${mcp.status}`,
      );
    }
    if (options.entityASecretMarker && mcp.bodyText.includes(options.entityASecretMarker)) {
      failureReasons.push("must_change_password=true response leaked entityASecretMarker");
    }
  }

  let entityAStatus: number | null = null;
  let entityASawMarker: boolean | null = null;
  if (options.buildEntityARequest) {
    const entA = await runHandler(options.buildEntityARequest());
    entityAStatus = entA.status;
    entityASawMarker = entA.bodyText.includes(options.entityASecretMarker);
    if (entA.status !== 200) {
      failureReasons.push(`Entity A positive-control expected 200, got ${entA.status}`);
    }
    if (!entityASawMarker) {
      failureReasons.push(
        `Entity A positive-control response missing '${options.entityASecretMarker}'`,
      );
    }
  }

  let entityBStatus: number | null = null;
  let entityBLeakedMarker: boolean | null = null;
  if (options.buildEntityBRequest) {
    const entB = await runHandler(options.buildEntityBRequest());
    entityBStatus = entB.status;
    entityBLeakedMarker = entB.bodyText.includes(options.entityASecretMarker);
    if (entB.status !== 200) {
      failureReasons.push(`Entity B scoped request expected 200, got ${entB.status}`);
    }
    if (entityBLeakedMarker) {
      failureReasons.push(
        `Entity B cross-entity response LEAKED '${options.entityASecretMarker}'`,
      );
    }
  }

  return {
    routeLabel: options.routeLabel,
    pass: failureReasons.length === 0,
    rejected: failureReasons.length > 0,
    unauthenticatedStatus: unauth.status,
    mustChangePasswordStatus,
    entityAStatus,
    entityBStatus,
    entityASawMarker,
    entityBLeakedMarker,
    failureReasons,
  };
}

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail = ""): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fail-closed identity gate — same shape as legacy-repair-verify.ts. */
function assertSafeDisposableName(name: string, context: string): void {
  if (name === FORBIDDEN_DB_NAME) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${FORBIDDEN_DB_NAME}' — gerçek veritabanına asla dokunulmaz.`);
    process.exit(1);
  }
  if (!name.startsWith(DISPOSABLE_PREFIX)) {
    console.error(`GÜVENLİK DURDURMASI (${context}): hedef DB adı '${name}', beklenen disposable önek '${DISPOSABLE_PREFIX}' ile başlamıyor.`);
    process.exit(1);
  }
}

function dbUrl(db: string): string { return resolveLocalOwnerUrl(db); }

function resolveDisposableAppUrl(db: string): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  const fromFile = (() => {
    try {
      return readEnvLocal().DATABASE_URL?.trim();
    } catch {
      return undefined;
    }
  })();
  for (const candidate of [fromEnv, fromFile]) {
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.username === "mas_radar_app") {
        return swapDatabase(candidate, db);
      }
    } catch {
      // ignore malformed candidate
    }
  }
  const ciPass = process.env.MAS_RADAR_APP_DB_PASSWORD?.trim() || process.env.CI_APP_DB_PASSWORD?.trim();
  if (ciPass) {
    const u = new URL(dbUrl(db));
    u.username = "mas_radar_app";
    u.password = ciPass;
    return u.toString();
  }
  return dbUrl(db);
}

function assertContainerReachable(): void {
  assertLocalPgReachable();
}

function buildDatabase(): void {
  assertSafeDisposableName(DB, "kurulum");
  dropDisposableLocalDb(DB);
  createDisposableLocalDb(DB);
  psqlLocalFile(DB, BOOTSTRAP_SQL);
  execFileSync(process.execPath, [TSX_CLI, MIGRATE_SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl(DB), MIGRATION_DATABASE_URL: dbUrl(DB) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A Pool that behaves like production's getPool() for one fixed identity (+ optional legalEntityId).
 */
function tierPool(
  base: Pool,
  tier: AppRole,
  userId: string | null,
  legalEntityId: string | null = null,
): Pool {
  const prepare = async (client: PoolClient) => {
    await client.query(
      "select set_config('app.user_id', $1, false), set_config('app.current_legal_entity_id', $2, false)",
      [userId ?? "", legalEntityId ?? ""],
    );
    await client.query(`set role ${DB_ROLE[tier]}`);
  };
  const cleanup = async (client: PoolClient) => {
    await client.query("reset role").catch(() => undefined);
    await client
      .query(
        "select set_config('app.user_id', '', false), set_config('app.current_legal_entity_id', '', false)",
      )
      .catch(() => undefined);
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return async (...args: unknown[]): Promise<QueryResult<QueryResultRow>> => {
          const client = await base.connect();
          try {
            await prepare(client);
            // @ts-expect-error — pg's query() overloads are wider than this passthrough expresses.
            return await client.query(...args);
          } finally {
            await cleanup(client);
            client.release();
          }
        };
      }
      if (prop === "connect") {
        return async (): Promise<PoolClient> => {
          const client = await base.connect();
          try { await prepare(client); } catch (e) { client.release(); throw e; }
          const release = client.release.bind(client);
          (client as PoolClient).release = ((...a: unknown[]) => {
            void cleanup(client).finally(() => release(...(a as [])));
          }) as PoolClient["release"];
          return client;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function main(): Promise<void> {
  console.log("=== export-leakage-verify: rol bazlı sızıntı sondası (disposable DB) ===\n");
  assertContainerReachable();
  buildDatabase();

  // Ensure Next.js AsyncLocalStorage is registered before dynamically importing Next route modules.
  (globalThis as Record<string, unknown>).AsyncLocalStorage ??= AsyncLocalStorage;

  // Enforce strict production-equivalent session gates (no local passwordless / QA / autologin bypass)
  // BEFORE @/lib/env and @/lib/auth are loaded.
  process.env.DATABASE_URL = resolveDisposableAppUrl(DB);
  process.env.MIGRATION_DATABASE_URL = dbUrl(DB);
  process.env.MAS_LOCAL_PASSWORDLESS = "0";
  process.env.MAS_ALLOW_PASSWORDLESS_IN_TEST = "0";
  process.env.MAS_QA_BYPASS_AUTH = "0";
  process.env.MAS_LOCAL_WORKSTATION_AUTOLOGIN = "0";

  const { listSavedViews } = await import("../../src/lib/ui/saved-views");
  const { runSearch } = await import("../../src/lib/search/engine");
  const { parseSearchQuery } = await import("../../src/lib/search/nl");
  const { runParetoConcentration, runRollingTrend } = await import("../../src/lib/analytics/engine");
  const { getPool } = await import("../../src/lib/db");
  const { clearRequestSessionCache, requireApiSession, withRequestSessionScope } = await import(
    "../../src/lib/auth"
  );
  const { getDbContext } = await import("../../src/lib/authz/context");
  const { GET: getSearchRoute } = await import("../../src/app/api/search/route");
  const { GET: getExportRoute, POST: postExportRoute } = await import(
    "../../src/app/api/analytics/export/route"
  );

  const owner = new Pool({ connectionString: dbUrl(DB), max: 4 });
  const base = new Pool({ connectionString: dbUrl(DB), max: 6 });

  try {
    /* ── 0. fixtures, on the owner connection ─────────────────────────────────────────── */
    const mkUser = async (username: string, role: AppRole, mustChangePassword = false) =>
      (await owner.query<{ id: string }>(
        `insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
         values ($1,'x',$2,$3,true,$4) returning id`,
        [username, username, role, mustChangePassword],
      )).rows[0].id;

    const userA = await mkUser("leak_owner_a", "finance_operator");
    const userB = await mkUser("leak_other_b", "finance_operator");
    const adminUser = await mkUser("leak_admin_c", "admin"); // en az bir aktif admin — 0031'in değişmezi
    const mustChangeUser = await mkUser("leak_forced_pwd_d", "admin", true);

    const mkSessionToken = async (userId: string): Promise<string> => {
      const rawToken = randomBytes(24).toString("base64url");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      await owner.query(
        `insert into public.sessions (user_id, token_hash, expires_at, last_seen_at)
         values ($1, $2, now() + interval '1 day', now())`,
        [userId, tokenHash],
      );
      return rawToken;
    };

    const activeAdminToken = await mkSessionToken(adminUser);
    const mustChangeToken = await mkSessionToken(mustChangeUser);

    // A'ya ait, B'nin görmemesi gereken satırlar.
    const viewA = (await owner.query<{ id: string }>(
      `insert into public.saved_views (name, module_key, filters, is_shared, is_default, created_by)
       values ('A-OZEL-GORUNUM','finance','{}'::jsonb,false,false,$1) returning id`, [userA])).rows[0].id;
    const itemA = (await owner.query<{ id: string }>(
      `insert into public.action_items (title, status, created_by)
       values ('A-OZEL-GOREV','open',$1) returning id`, [userA])).rows[0].id;
    const convoA = (await owner.query<{ id: string }>(
      `insert into public.assistant_conversations (title, created_by)
       values ('A-OZEL-KONUSMA',$1) returning id`, [userA])).rows[0].id;

    // FİNANSAL FIXTURE — "sessizce boş" kontrolünün ölçecek bir şeyi olması için ZORUNLU.
    const party = (await owner.query<{ id: string }>(
      `insert into public.parties (name, normalized_name, party_type)
       values ('LEAK-MUSTERI','leak-musteri','customer') returning id`)).rows[0].id;
    await owner.query(
      `insert into public.invoices (direction, invoice_no, party_id, issue_date,
                                    net_amount, tax_amount, gross_amount, status)
       values ('sales','LEAK-INV-1',$1, current_date - 10, 1000, 200, 1200, 'open')`, [party]);
    const pay = (await owner.query<{ id: string }>(
      `insert into public.payments (name, recurrence_type, due_day, status)
       values ('LEAK-ODEME','monthly',15,'active') returning id`)).rows[0].id;
    for (const monthsAgo of [1, 2, 3, 4]) {
      await owner.query(
        `insert into public.payment_instances (payment_id, instance_month, due_date, amount, status)
         values ($1,
                 (date_trunc('month', current_date) - ($2::int || ' month')::interval)::date,
                 (date_trunc('month', current_date) - ($2::int || ' month')::interval)::date + 14,
                 500, 'unpaid')`,
        [pay, monthsAgo]);
    }
    record("finansal fixture kuruldu (export analizlerinin ölçecek verisi var)",
      Number((await owner.query<{ n: string }>(
        `select count(*)::text n from public.payment_instances`)).rows[0].n) === 4,
      "1 açık satış faturası + 4 ödeme kalemi");

    record("fixture kuruldu (A'ya ait kayıtlar owner bağlantısında görünüyor)",
      (await owner.query(`select 1 from public.saved_views where id=$1`, [viewA])).rowCount === 1
      && (await owner.query(`select 1 from public.action_items where id=$1`, [itemA])).rowCount === 1
      && (await owner.query(`select 1 from public.assistant_conversations where id=$1`, [convoA])).rowCount === 1,
      "üç owner-scoped satır");

    /* ── 1. the mechanism itself, before any verdict rests on it ──────────────────────── */
    for (const tier of APP_ROLES) {
      const p = tierPool(base, tier, userB);
      const who = await p.query<{ u: string; s: boolean }>(
        `select current_user as u, (select rolsuper from pg_roles where rolname=current_user) as s`);
      record(`SET ROLE gerçekten uygulandı: ${tier}`,
        who.rows[0].u === DB_ROLE[tier] && who.rows[0].s === false,
        `current_user=${who.rows[0].u} superuser=${who.rows[0].s}`);
    }

    /* ── 2. ledger class: no tier may read schema_migrations at all ───────────────────── */
    const ownerLedger = Number((await owner.query<{ n: string }>(
      `select count(*)::text n from public.schema_migrations`)).rows[0].n);
    record("POZİTİF KONTROL: ledger owner'a GÖRÜNÜYOR (boş tabloyla karıştırılmıyor)",
      ownerLedger > 0, `${ownerLedger} satır`);
    for (const tier of APP_ROLES) {
      const p = tierPool(base, tier, userB);
      let denied = false;
      try { await p.query(`select count(*) from public.schema_migrations`); }
      catch (e) { denied = /permission denied/i.test(messageOf(e)); }
      record(`ledger ${tier} katmanına KAPALI`, denied, "schema_migrations hiçbir katmana açık değil");
    }

    /* ── 3. owner-scoped rows, addressed BY ID — the "direct-id" attack ───────────────── */
    const asOfToday = new Date().toISOString().slice(0, 10);
    const asA = tierPool(base, "finance_operator", userA);
    const asB = tierPool(base, "finance_operator", userB);

    for (const probe of [
      { table: "saved_views", id: viewA, label: "kayıtlı görünüm" },
      { table: "assistant_conversations", id: convoA, label: "asistan konuşması" },
    ]) {
      const seenByA = (await asA.query(`select id from public.${probe.table} where id = $1`, [probe.id])).rowCount ?? 0;
      const seenByB = (await asB.query(`select id from public.${probe.table} where id = $1`, [probe.id])).rowCount ?? 0;
      record(`POZİTİF KONTROL: sahibi (A) kendi ${probe.label} satırını KİMLİKLE görüyor`,
        seenByA === 1, `${seenByA} satır`);
      record(`DOĞRUDAN-KİMLİK: başkası (B) A'nın ${probe.label} satırını GÖREMİYOR`,
        seenByB === 0, `${seenByB} satır`);
      const upd = await asB.query(
        `update public.${probe.table} set updated_at = now() where id = $1`, [probe.id]).catch(() => ({ rowCount: 0 }));
      record(`DOĞRUDAN-KİMLİK: B, A'nın ${probe.label} satırını DEĞİŞTİREMİYOR`,
        (upd.rowCount ?? 0) === 0, `${upd.rowCount ?? 0} satır etkilendi`);
    }

    {
      const seenByB = (await asB.query(`select id from public.action_items where id = $1`, [itemA])).rowCount ?? 0;
      record("action_items TASARIM GEREĞİ okunabilir (ortak iş kaydı, gizli değil)",
        seenByB === 1, `B ${seenByB} satır görüyor — SELECT qual = true`);
      const upd = await asB.query(
        `update public.action_items set title = 'B-ELE-GECIRDI' where id = $1`, [itemA]).catch(() => ({ rowCount: 0 }));
      record("DOĞRUDAN-KİMLİK: B, A'nın aksiyon kaydını DEĞİŞTİREMİYOR (yazma sahipliğe dar)",
        (upd.rowCount ?? 0) === 0, `${upd.rowCount ?? 0} satır etkilendi`);
      const title = (await owner.query<{ title: string }>(
        `select title from public.action_items where id = $1`, [itemA])).rows[0].title;
      record("A'nın aksiyon kaydının başlığı DEĞİŞMEDİ (owner bağlantısıyla doğrulandı)",
        title === "A-OZEL-GOREV", `title=${title}`);
    }

    const sharedA = (await owner.query<{ id: string }>(
      `insert into public.saved_views (name, module_key, filters, is_shared, is_default, created_by)
       values ('A-PAYLASILAN-GORUNUM','finance','{}'::jsonb,true,false,$1) returning id`, [userA])).rows[0].id;
    record("POZİTİF KONTROL: A'nın PAYLAŞILAN görünümü B'ye GÖRÜNÜYOR (politika ayrım yapıyor)",
      ((await asB.query(`select id from public.saved_views where id = $1`, [sharedA])).rowCount ?? 0) === 1,
      "is_shared OR created_by — 'her şeyi reddet' değil");

    /* ── 4. the saved-view READ PATH, through the real engine ─────────────────────────── */
    const aViews = await listSavedViews(asA, "finance", userA);
    const bViews = await listSavedViews(asB, "finance", userB);
    record("POZİTİF KONTROL: listSavedViews A'ya kendi görünümünü veriyor",
      aViews.some((v) => v.name === "A-OZEL-GORUNUM"), `${aViews.length} görünüm`);
    record("KAYITLI GÖRÜNÜM OKUMA YOLU: B, A'nın görünümünü listede GÖRMÜYOR",
      !bViews.some((v) => v.name === "A-OZEL-GORUNUM"), `${bViews.length} görünüm`);

    /* ── 5. SEARCH — the same rows, through the universal search path ─────────────────── */
    const intent = parseSearchQuery("A-OZEL", asOfToday);
    const aHits = await runSearch(asA, intent, 8);
    const bHits = await runSearch(asB, intent, 8);
    const leakedInSearch = bHits.hits.filter((h) => /A-OZEL-GORUNUM|A-OZEL-KONUSMA/.test(JSON.stringify(h)));
    record("ARAMA: B'nin arama sonuçlarında A'ya ait SAHİPLİK KAPSAMLI hiçbir kayıt yok",
      leakedInSearch.length === 0,
      leakedInSearch.length ? JSON.stringify(leakedInSearch).slice(0, 200) : `${bHits.hits.length} isabet, sızıntı yok`);
    record("POZİTİF KONTROL: arama yolu ÇALIŞIYOR (A kendi kaydını arayabiliyor ya da entity kapsam dışı)",
      aHits.searchedEntities.length > 0, `${aHits.searchedEntities.length} varlık tarandı, ${aHits.hits.length} isabet`);

    /* ── 6. EXPORT — the analyses the route actually runs, under a tier ───────────────── */
    const asOf = asOfToday;
    const viewerPool = tierPool(base, "viewer", userB);
    const adminPool = tierPool(base, "admin", userB);
    for (const [label, run] of [
      ["pareto_concentration", runParetoConcentration],
      ["rolling_trend", (p: Pool, d: string) => runRollingTrend(p, 30, d)],
    ] as const) {
      const v = await (run as (p: Pool, d: string) => Promise<{ result: { rows: unknown[] } }>)(viewerPool, asOf);
      const a = await (run as (p: Pool, d: string) => Promise<{ result: { rows: unknown[] } }>)(adminPool, asOf);
      record(`EXPORT ${label}: izleyici çıktısı SESSİZCE BOŞ değil`,
        v.result.rows.length > 0, `${v.result.rows.length} satır`);
      record(`EXPORT ${label}: izleyici ve yönetici çıktısı BİREBİR aynı (ne eksik ne fazla)`,
        JSON.stringify(v.result.rows) === JSON.stringify(a.result.rows),
        `izleyici=${v.result.rows.length} yönetici=${a.result.rows.length}`);
    }

    /* ── 7. V2 F-07: Multi-Legal-Entity Isolation + Behavioral HTTP Auth & Negative Control ── */
    // 7a) Seed Entity A and Entity B (both non-default so RESTRICTIVE matches_active_legal_entity
    //     strictly isolates Entity A vs Entity B at SQL, engine, and HTTP route layers).
    const entityA = (
      await owner.query<{ id: string }>(
        `insert into public.legal_entities (code, name, is_default, is_active)
         values ('LEAK-ENT-A', 'Leak Entity A', false, true) returning id`,
      )
    ).rows[0].id;
    const entityB = (
      await owner.query<{ id: string }>(
        `insert into public.legal_entities (code, name, is_default, is_active)
         values ('LEAK-ENT-B', 'Leak Entity B', false, true) returning id`,
      )
    ).rows[0].id;

    // `public.parties` grup genelinde ortak cari kart rehberidir; `RESTRICTIVE` tüzel kişilik RLS
    // politikası işlemsel finans tablolarını (`invoices`, `payments`, `payment_instances`, vb.)
    // izole eder. Cari adıyla finansal işlem etiketini ayırarak her iki katman da net ölçülür.
    const partyEntA = (
      await owner.query<{ id: string }>(
        `insert into public.parties (name, normalized_name, party_type)
         values ('PARETO-ENT-A-TARAF', 'pareto-ent-a-taraf', 'customer') returning id`,
      )
    ).rows[0].id;
    const partyEntB = (
      await owner.query<{ id: string }>(
        `insert into public.parties (name, normalized_name, party_type)
         values ('PARETO-ENT-B-TARAF', 'pareto-ent-b-taraf', 'customer') returning id`,
      )
    ).rows[0].id;

    const invEntA = (
      await owner.query<{ id: string }>(
        `insert into public.invoices (direction, invoice_no, party_id, issue_date,
                                      net_amount, tax_amount, gross_amount, status, currency, legal_entity_id)
         values ('sales', 'ENTITY-A-GIZLI-INV', $1, current_date - 5, 6000, 1200, 7200, 'open', 'TRY', $2)
         returning id`,
        [partyEntA, entityA],
      )
    ).rows[0].id;
    await owner.query(
      `insert into public.invoices (direction, invoice_no, party_id, issue_date,
                                    net_amount, tax_amount, gross_amount, status, currency, legal_entity_id)
       values ('sales', 'ENTITY-B-ACIK-INV', $1, current_date - 5, 3000, 600, 3600, 'open', 'TRY', $2)`,
      [partyEntB, entityB],
    );

    const payEntA = (
      await owner.query<{ id: string }>(
        `insert into public.payments (name, recurrence_type, due_day, status, legal_entity_id)
         values ('ENTITY-A-GIZLI-ODEME', 'monthly', 18, 'active', $1) returning id`,
        [entityA],
      )
    ).rows[0].id;
    const instEntA = (
      await owner.query<{ id: string }>(
        `insert into public.payment_instances (payment_id, instance_month, due_date, amount, status, note, legal_entity_id)
         values ($1, date_trunc('month', current_date)::date, current_date + 5, 4200, 'unpaid', 'ENTITY-A-GIZLI-ODEME', $2)
         returning id`,
        [payEntA, entityA],
      )
    ).rows[0].id;

    // 7b) Multi-entity RLS + Engine (runSearch & runParetoConcentration) verification
    const poolEntAViewer = tierPool(base, "viewer", adminUser, entityA);
    const poolEntBViewer = tierPool(base, "viewer", adminUser, entityB);
    const poolEntBAdmin = tierPool(base, "admin", adminUser, entityB);

    const sqlSeenEntA =
      ((await poolEntAViewer.query(`select id from public.payments where id = $1`, [payEntA])).rowCount ?? 0) +
      ((await poolEntAViewer.query(`select id from public.payment_instances where id = $1`, [instEntA])).rowCount ?? 0) +
      ((await poolEntAViewer.query(`select id from public.invoices where id = $1`, [invEntA])).rowCount ?? 0);
    record(
      "POZİTİF KONTROL (Entity A): kendi tüzel kişiliği altında fatura + ödeme + kalem görünüyor",
      sqlSeenEntA === 3,
      `seen=${sqlSeenEntA}/3`,
    );

    const sqlLeakEntBViewer =
      ((await poolEntBViewer.query(`select id from public.payments where id = $1`, [payEntA])).rowCount ?? 0) +
      ((await poolEntBViewer.query(`select id from public.payment_instances where id = $1`, [instEntA])).rowCount ?? 0) +
      ((await poolEntBViewer.query(`select id from public.invoices where id = $1`, [invEntA])).rowCount ?? 0);
    const sqlLeakEntBAdmin =
      ((await poolEntBAdmin.query(`select id from public.payments where id = $1`, [payEntA])).rowCount ?? 0) +
      ((await poolEntBAdmin.query(`select id from public.payment_instances where id = $1`, [instEntA])).rowCount ?? 0) +
      ((await poolEntBAdmin.query(`select id from public.invoices where id = $1`, [invEntA])).rowCount ?? 0);
    record(
      "ÇAPRAZ TÜZEL KİŞİLİK SQL RLS: Entity B (viewer ve admin) Entity A kayıtlarından 0 satır görüyor",
      sqlLeakEntBViewer === 0 && sqlLeakEntBAdmin === 0,
      `viewerLeak=${sqlLeakEntBViewer} adminLeak=${sqlLeakEntBAdmin}`,
    );

    const entASearchIntent = parseSearchQuery("ENTITY-A-GIZLI", asOfToday);
    const entASearchHits = await runSearch(poolEntAViewer, entASearchIntent, 10);
    const entBSearchHits = await runSearch(poolEntBAdmin, entASearchIntent, 10);
    record(
      "ÇAPRAZ TÜZEL KİŞİLİK ARAMA (runSearch): Entity A buluyor (>=1), Entity B 0 sızıntı alıyor",
      entASearchHits.hits.some((h) => JSON.stringify(h).includes("ENTITY-A-GIZLI")) &&
        !entBSearchHits.hits.some((h) => JSON.stringify(h).includes("ENTITY-A-GIZLI")),
      `entAHits=${entASearchHits.hits.length} entBHits=${entBSearchHits.hits.length}`,
    );

    const entAPareto = await runParetoConcentration(poolEntAViewer, asOfToday);
    const entBPareto = await runParetoConcentration(poolEntBAdmin, asOfToday);
    record(
      "ÇAPRAZ TÜZEL KİŞİLİK EXPORT ANALİZİ (runParetoConcentration): Entity A kendi tarafını görüyor, Entity B 0 sızıntı alıyor",
      entAPareto.result.rows.some((r) => r.label === "PARETO-ENT-A-TARAF") &&
        entBPareto.result.rows.some((r) => r.label === "PARETO-ENT-B-TARAF") &&
        !entBPareto.result.rows.some((r) => r.label === "PARETO-ENT-A-TARAF"),
      `entARows=${entAPareto.result.rows.length} entBRows=${entBPareto.result.rows.length}`,
    );

    // 7c) Structural scoped-pool check (kept alongside behavioral auth check)
    const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
    for (const route of ["src/app/api/analytics/export/route.ts", "src/app/api/search/route.ts"]) {
      const src = readSrc(route);
      record(`${route}: rol-kapsamlı getPool() kullanıyor, getRawPool() KULLANMIYOR`,
        /getPool\(\)/.test(src) && !/getRawPool/.test(src),
        "ham havuz oturum arama yolunun kimliğidir; bir dışa aktarım onu asla almamalı");
    }

    // 7d) Direct forced-password-change session gate verification on requireApiSession() + getDbContext()
    const mcpGateProbe = await invokeWithNextRequestContext(
      new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
        headers: { host: "127.0.0.1:3000", cookie: `mas_session=${mustChangeToken}` },
      }),
      () =>
        withRequestSessionScope(async () => {
          clearRequestSessionCache();
          const apiUser = await requireApiSession();
          const dbCtx = await getDbContext();
          return { apiUser, dbCtx };
        }),
    );
    record(
      "ZORUNLU ŞİFRE DEĞİŞİMİ KAPISI: must_change_password=true oturumu requireApiSession=null ve dbRole=null döndürüyor",
      mcpGateProbe.apiUser === null && mcpGateProbe.dbCtx.dbRole === null,
      `apiUser=${String(mcpGateProbe.apiUser)} dbRole=${String(mcpGateProbe.dbCtx.dbRole)}`,
    );

    // 7e) Real behavioral HTTP route handler verification on /api/search & /api/analytics/export
    const wrapNextReq = async <T>(req: Request, fn: () => Promise<T>): Promise<T> =>
      invokeWithNextRequestContext(req, () =>
        withRequestSessionScope(async () => {
          clearRequestSessionCache();
          return fn();
        }),
      );

    const searchRouteOutcome = await verifyRouteAuthAndIsolationBehavior({
      routeLabel: "GET /api/search",
      handler: getSearchRoute,
      wrapRequestExecution: wrapNextReq,
      buildUnauthenticatedRequest: () =>
        new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
          headers: { host: "127.0.0.1:3000" },
        }),
      buildMustChangePasswordRequest: () =>
        new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
          headers: { host: "127.0.0.1:3000", cookie: `mas_session=${mustChangeToken}` },
        }),
      buildEntityARequest: () =>
        new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
          headers: {
            host: "127.0.0.1:3000",
            cookie: `mas_session=${activeAdminToken}; mas_active_legal_entity=${entityA}`,
          },
        }),
      buildEntityBRequest: () =>
        new Request("http://127.0.0.1:3000/api/search?q=ENTITY-A-GIZLI", {
          headers: {
            host: "127.0.0.1:3000",
            cookie: `mas_session=${activeAdminToken}; mas_active_legal_entity=${entityB}`,
          },
        }),
      entityASecretMarker: "ENTITY-A-GIZLI-ODEME",
    });
    record(
      "DAVRANIŞSAL ROTA KAPISI (GET /api/search): oturumsuz=401, must_change_password=401, Entity A pozitif=200, Entity B sızıntı=0",
      searchRouteOutcome.pass,
      searchRouteOutcome.pass
        ? `unauth=${searchRouteOutcome.unauthenticatedStatus} mcp=${searchRouteOutcome.mustChangePasswordStatus} entA=${searchRouteOutcome.entityAStatus} entB=${searchRouteOutcome.entityBStatus}`
        : searchRouteOutcome.failureReasons.join("; "),
    );

    const exportRouteOutcome = await verifyRouteAuthAndIsolationBehavior({
      routeLabel: "GET /api/analytics/export",
      handler: getExportRoute,
      wrapRequestExecution: wrapNextReq,
      buildUnauthenticatedRequest: () =>
        new Request(
          "http://127.0.0.1:3000/api/analytics/export?analysis=pareto_concentration&format=csv",
          { headers: { host: "127.0.0.1:3000" } },
        ),
      buildMustChangePasswordRequest: () =>
        new Request(
          "http://127.0.0.1:3000/api/analytics/export?analysis=pareto_concentration&format=csv",
          { headers: { host: "127.0.0.1:3000", cookie: `mas_session=${mustChangeToken}` } },
        ),
      buildEntityARequest: () =>
        new Request(
          "http://127.0.0.1:3000/api/analytics/export?analysis=pareto_concentration&format=csv",
          {
            headers: {
              host: "127.0.0.1:3000",
              cookie: `mas_session=${activeAdminToken}; mas_active_legal_entity=${entityA}`,
            },
          },
        ),
      buildEntityBRequest: () =>
        new Request(
          "http://127.0.0.1:3000/api/analytics/export?analysis=pareto_concentration&format=csv",
          {
            headers: {
              host: "127.0.0.1:3000",
              cookie: `mas_session=${activeAdminToken}; mas_active_legal_entity=${entityB}`,
            },
          },
        ),
      entityASecretMarker: "PARETO-ENT-A-TARAF",
    });
    record(
      "DAVRANIŞSAL ROTA KAPISI (GET /api/analytics/export): oturumsuz=401, must_change_password=401, Entity A pozitif=200, Entity B sızıntı=0",
      exportRouteOutcome.pass,
      exportRouteOutcome.pass
        ? `unauth=${exportRouteOutcome.unauthenticatedStatus} mcp=${exportRouteOutcome.mustChangePasswordStatus} entA=${exportRouteOutcome.entityAStatus} entB=${exportRouteOutcome.entityBStatus}`
        : exportRouteOutcome.failureReasons.join("; "),
    );

    const exportPostUnauthRes = await wrapNextReq(
      new Request("http://127.0.0.1:3000/api/analytics/export", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ filename: "probe", sheets: [{ name: "S1", rows: [["a"]] }] }),
      }),
      () =>
        postExportRoute(
          new Request("http://127.0.0.1:3000/api/analytics/export", {
            method: "POST",
            headers: {
              host: "127.0.0.1:3000",
              origin: "http://127.0.0.1:3000",
              "content-type": "application/json",
            },
            body: JSON.stringify({ filename: "probe", sheets: [{ name: "S1", rows: [["a"]] }] }),
          }),
        ),
    );
    record(
      "DAVRANIŞSAL ROTA KAPISI (POST /api/analytics/export): geçerli Origin taşısa bile oturumsuz POST 401 ile reddediliyor",
      exportPostUnauthRes.status === 401,
      `status=${exportPostUnauthRes.status}`,
    );

    // 7f) Mandatory Negative Control (Self-Test): prove the behavioral verifier catches a broken 200 handler!
    const brokenHandler = async () =>
      new Response(JSON.stringify({ leaked: true, rows: [{ secret: "ENTITY-A-GIZLI" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const brokenResult = await verifyRouteAuthAndIsolationBehavior({
      routeLabel: "negative-control-broken-200-handler",
      handler: brokenHandler,
      buildUnauthenticatedRequest: () =>
        new Request("http://127.0.0.1:3000/api/analytics/export?analysis=pareto_concentration&format=csv"),
      entityASecretMarker: "ENTITY-A-GIZLI",
    });
    record(
      "NEGATİF KONTROL: oturumsuz 200 dönen bozuk handler yakalanıp reddediliyor",
      brokenResult.rejected === true && brokenResult.pass === false,
      `rejected=${brokenResult.rejected} status=${brokenResult.unauthenticatedStatus} reasons=${brokenResult.failureReasons.join(", ")}`,
    );

    /* ── 8. ledger sızıntısının export yüzeyinde de olmadığı ──────────────────────────── */
    const exportSrc = readSrc("src/app/api/analytics/export/route.ts");
    record("export rotası ledger/oturum tablolarına hiç dokunmuyor",
      !/schema_migrations|public\.sessions|password_hash|token_hash/.test(exportSrc),
      "dışa aktarım yüzeyi finansal analizle sınırlı");
  } finally {
    await getPool().end().catch(() => undefined);
    await base.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
    assertSafeDisposableName(DB, "temizlik");
    dropDisposableLocalDb(DB);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log(`EXPORT LEAKAGE VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log("EXPORT LEAKAGE VERIFY: ALL PASS");
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((e) => {
    console.error("export-leakage-verify beklenmedik hata ile durdu:", messageOf(e));
    try {
      assertSafeDisposableName(DB, "hata temizliği");
      dropDisposableLocalDb(DB);
    } catch {
      /* temizlik en iyi çaba */
    }
    process.exit(1);
  });
}
