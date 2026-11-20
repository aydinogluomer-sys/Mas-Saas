// Faz 2 — real login, real session cookie, one storageState per role.
//
// THE LOOP THIS REPLACES, STATED PRECISELY BECAUSE IT IS NOT OBVIOUS FROM EITHER SIDE ALONE.
//
// The legacy visual specs ran behind MAS_QA_BYPASS_AUTH=1. That flag is honoured inside
// getCurrentUser() (src/lib/auth.ts), which is a Node-runtime, DB-backed lookup — it returns the
// reserved `testsprite-qa` account WITHOUT any cookie. But src/middleware.ts is Edge-runtime and
// deliberately does no DB work at all: it checks only that the `mas_session` COOKIE is present.
// So under the bypass the two layers disagree, and the disagreement is circular:
//
//   GET /overview   -> middleware sees no cookie          -> 307 /login
//   GET /login      -> page calls getCurrentUser(), which
//                      the bypass answers with a user     -> redirect(next) back to /overview
//   GET /overview   -> middleware still sees no cookie    -> 307 /login   ... forever
//
// Neither layer is wrong on its own; the bypass is simply invisible to the one that guards the
// route. No amount of retrying or waiting fixes it, which is why the legacy suite could not be
// made green by tuning timeouts.
//
// There is a second reason the bypass was never a viable answer here: getQaBypassUser() returns
// null when NODE_ENV === "production". These specs are supposed to run against a PRODUCTION build
// (`pnpm build && pnpm start`), where the flag is inert by construction.
//
// So this file does what the plan asks: it seeds five real accounts into a disposable database,
// logs each one in THROUGH THE REAL /login FORM, and saves the resulting cookie jar. From then on
// the specs carry a genuine `mas_session` cookie, middleware is satisfied, and the tests exercise
// the same auth path a human does.

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { hash as argon2Hash } from "@node-rs/argon2";
import { Pool } from "pg";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { readEnvLocal, swapDatabase } from "../../scripts/db/app-url";

export interface ResolveOwnerSeedUrlOptions {
  env?: NodeJS.ProcessEnv;
  readEnvLocalFn?: () => Record<string, string>;
}

const FORBIDDEN_LOW_PRIVILEGE_SEED_ROLES = new Set([
  "mas_radar_app",
  "mas_radar_viewer",
  "mas_radar_finance_operator",
  "mas_radar_finance_approver",
  "mas_radar_finance_manager",
  "mas_radar_admin",
  "mas_radar_readonly",
]);

function parsePgUrlStrict(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`GÜVENLİK DURDURMASI (F-05): '${label}' geçerli bir PostgreSQL bağlantı dizesi değil.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`GÜVENLİK DURDURMASI (F-05): '${label}' protokolü postgres:// veya postgresql:// olmalı.`);
  }
  return parsed;
}

function normalizeClusterHost(rawHost: string): string {
  const cleaned = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (cleaned === "localhost" || cleaned === "127.0.0.1") {
    return "127.0.0.1";
  }
  return cleaned;
}

/**
 * Elevates an already-verified disposable E2E database URL (`mas_radar_app`) to the database owner
 * (`MAS_E2E_SEED_DATABASE_URL` / `MAS_E2E_VERIFIER_URL` / same-cluster `MIGRATION_DATABASE_URL`)
 * so E2E harnesses can seed `public.users` / `public.sessions` while the Next.js server under test
 * continues running on least-privilege `mas_radar_app`.
 *
 * Fail-closed invariants (`F-05`):
 *   1. Both `rawAppUrl` and the resolved seed URL must target a disposable database.
 *   2. Exact database-name equality (`seedDbName === appDbName`) is enforced.
 *   3. Same PostgreSQL cluster (`host` + `port`, with `localhost <-> 127.0.0.1` loopback equivalence) is enforced.
 *   4. Low-privilege runtime roles (`mas_radar_app`, tier roles) are rejected before hitting `42501`.
 *   5. Never fabricates an implicit `postgres:postgres` credential when seed/migration env is absent.
 */
export function resolveOwnerSeedUrl(rawAppUrl: string, opts?: ResolveOwnerSeedUrlOptions): string {
  const trimmedApp = rawAppUrl.trim();
  if (!trimmedApp) {
    throw new Error("GÜVENLİK DURDURMASI (F-05): MAS_E2E_DATABASE_URL (veya DATABASE_URL) boş olamaz.");
  }
  const appParsed = parsePgUrlStrict(trimmedApp, "MAS_E2E_DATABASE_URL");
  const appDbName = databaseNameFromUrl(trimmedApp);
  if (!appDbName || !isDisposableDatabaseName(appDbName)) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): '${appDbName ?? "(okunamadı)"}' harcanabilir (disposable) bir E2E veritabanı görünmüyor.`,
    );
  }

  const env = opts?.env ?? process.env;
  const readEnvLocalFn = opts?.readEnvLocalFn ?? readEnvLocal;

  const explicitSeed = env.MAS_E2E_SEED_DATABASE_URL?.trim();
  const verifierAlias = env.MAS_E2E_VERIFIER_URL?.trim();

  let seedUrl: string | undefined;
  if (explicitSeed) {
    seedUrl = explicitSeed;
  } else if (verifierAlias) {
    seedUrl = verifierAlias;
  } else {
    const localMig = (() => {
      try {
        return readEnvLocalFn().MIGRATION_DATABASE_URL?.trim();
      } catch {
        return undefined;
      }
    })();
    const migrationBase = env.MIGRATION_DATABASE_URL?.trim() || localMig;
    if (migrationBase) {
      seedUrl = swapDatabase(migrationBase, appDbName);
    }
  }

  if (!seedUrl) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): '${appDbName}' için açık bir owner seed bağlantısı bulunamadı ` +
        "(MAS_E2E_SEED_DATABASE_URL, MAS_E2E_VERIFIER_URL veya MIGRATION_DATABASE_URL tanımlı değil). " +
        "Örtük 'postgres:postgres' geri dönüşü engellendi.",
    );
  }

  const seedParsed = parsePgUrlStrict(seedUrl, "MAS_E2E_SEED_DATABASE_URL");
  const seedDbName = databaseNameFromUrl(seedUrl);
  if (!seedDbName || !isDisposableDatabaseName(seedDbName)) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): Owner seed hedef veritabanı '${seedDbName ?? "(okunamadı)"}' harcanabilir (disposable) değil.`,
    );
  }

  if (seedDbName !== appDbName) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): E2E uygulama veritabanı ('${appDbName}') ile owner seed veritabanı ('${seedDbName}') uyuşmuyor.`,
    );
  }

  const appHost = normalizeClusterHost(appParsed.hostname);
  const seedHost = normalizeClusterHost(seedParsed.hostname);
  const appPort = appParsed.port || "5432";
  const seedPort = seedParsed.port || "5432";
  if (appHost !== seedHost || appPort !== seedPort) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): E2E uygulama kümesi (${appParsed.hostname}:${appPort}) ile owner seed kümesi (${seedParsed.hostname}:${seedPort}) uyuşmuyor.`,
    );
  }

  const seedUser = decodeURIComponent(seedParsed.username ?? "").trim().toLowerCase();
  if (!seedUser) {
    throw new Error("GÜVENLİK DURDURMASI (F-05): Owner seed bağlantısında veritabanı kullanıcı adı eksik.");
  }
  if (FORBIDDEN_LOW_PRIVILEGE_SEED_ROLES.has(seedUser)) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): Owner seed bağlantısı düşük yetkili uygulama rolü ('${seedUser}') kullanamaz ` +
        "(public.users INSERT -> 42501); ayrıcalıklı MAS_E2E_SEED_DATABASE_URL tanımlayın.",
    );
  }

  return seedUrl;
}

interface OwnerSeedIdentityRow {
  db: string;
  usr: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  is_db_owner: boolean;
  can_seed_users: boolean;
}

/**
 * Live SQL pre-seed verification (`F-05`) executed before `globalSetup()` touches `public.users`.
 * Confirms `current_database()` matches `expectedDbName` and the connected role holds owner /
 * superuser / RLS-bypass privileges plus `INSERT, UPDATE` on `public.users`.
 */
export async function verifyOwnerSeedPoolIdentity(
  pool: Pick<Pool, "query">,
  expectedDbName: string,
): Promise<void> {
  const res = await pool.query<OwnerSeedIdentityRow>(`
    select
      current_database() as db,
      current_user as usr,
      r.rolsuper as rolsuper,
      r.rolbypassrls as rolbypassrls,
      pg_catalog.pg_has_role(current_user, d.datdba, 'USAGE') as is_db_owner,
      pg_catalog.has_table_privilege(current_user, 'public.users', 'INSERT, UPDATE') as can_seed_users
    from pg_catalog.pg_roles r
    join pg_catalog.pg_database d on d.datname = current_database()
    where r.rolname = current_user
  `);
  const row = res.rows[0];
  if (!row) {
    throw new Error("GÜVENLİK DURDURMASI (F-05): Owner seed kimlik sorgusu satır döndürmedi.");
  }
  if (!isDisposableDatabaseName(row.db) || row.db !== expectedDbName) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): Owner seed havuzu '${row.db}' veritabanına bağlandı; beklenen harcanabilir hedef '${expectedDbName}' ile uyuşmuyor.`,
    );
  }
  const usrLower = row.usr.trim().toLowerCase();
  if (
    FORBIDDEN_LOW_PRIVILEGE_SEED_ROLES.has(usrLower) ||
    !(row.rolsuper || row.rolbypassrls || row.is_db_owner) ||
    !row.can_seed_users
  ) {
    throw new Error(
      `GÜVENLİK DURDURMASI (F-05): Owner seed rolü '${row.usr}' yeterli owner/superuser/RLS-bypass veya public.users yazma yetkisine sahip değil (42501 önlendi).`,
    );
  }
}

/**
 * Copied from src/lib/auth.ts rather than imported.
 *
 * That module's first import is `next/headers`, which throws outside a Next request scope — this
 * file runs in plain Node before any server exists. argon2Verify() reads its parameters back out
 * of the encoded hash string, so a hash produced here verifies correctly even if these numbers
 * ever drift from the application's; keeping them identical simply means the fixture costs the
 * same to compute as the real thing.
 */
const ARGON2_OPTIONS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

/** The five tiers, mapped to the state filenames the plan names. */
export const ROLE_STATE_FILES = {
  viewer: "viewer.json",
  finance_operator: "operator.json",
  finance_approver: "approver.json",
  finance_manager: "manager.json",
  admin: "admin.json",
} as const;

export type SeededRole = keyof typeof ROLE_STATE_FILES;

export const AUTH_DIR = path.join(process.cwd(), "tests", "visual", ".auth");

/** Never a real credential: this account only ever exists in a disposable test database. */
export const TEST_PASSWORD = "faz2-visual-harness-not-a-secret";

export function statePathFor(role: SeededRole): string {
  return path.join(AUTH_DIR, ROLE_STATE_FILES[role]);
}

export function usernameFor(role: SeededRole): string {
  return `visual_${role}`.slice(0, 32);
}

/** src/lib/rate-limit.ts: RATE_RULES.login = 10 attempts per 60s, keyed by client. */
const LOGIN_RATE_WINDOW_MS = 60_000;

/**
 * Log one role in through the real form, surviving the login rate limiter.
 *
 * WHY THE RETRY IS NOT PAPERING OVER A BUG. Seeding five roles costs five logins, which is under
 * the limit for a single run — but two runs inside a minute are eleven, and the eleventh is refused
 * with `?error=rate`. That is the rate limiter WORKING; it protects password guessing and it should
 * not be relaxed for tests. What must not happen is the suite reporting a login failure that is
 * really a cooldown, so the cooldown is waited out and named explicitly. Observed exactly this way:
 * running the specs back to back produced `/login?error=rate` and a bare 30s navigation timeout
 * whose message said nothing about rate limiting.
 */
async function logInThroughForm(page: import("@playwright/test").Page, role: SeededRole): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto("/login", { waitUntil: "networkidle" });
    await page.fill('input[name="username"]', usernameFor(role));
    await page.fill('input[name="password"]', TEST_PASSWORD);
    // Wait for a predicate that covers EVERY outcome loginAction can produce, because it always
    // redirects: to `next` on success, or back to /login with ?error=rate | ?error=1. Waiting on
    // waitForLoadState("load") instead is a race — the page is already loaded when the click
    // happens, so it can resolve before the form's navigation even starts and then read the
    // pre-submit URL. That misreported a perfectly good login as "seed ile form uyuşmuyor".
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith("/login") || u.searchParams.has("error"), {
        timeout: 30_000,
      }),
      page.click('button[type="submit"]'),
    ]);

    const url = new URL(page.url());
    if (!url.pathname.startsWith("/login")) return;

    if (url.searchParams.get("error") === "rate") {
      if (attempt === 3) {
        throw new Error(
          `${role}: giriş oran sınırına takıldı ve ${attempt} denemede açılmadı. ` +
            "Sunucu tarafı limiti çalışıyor; testler için gevşetilmedi.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOGIN_RATE_WINDOW_MS + 5_000));
      continue;
    }

    throw new Error(
      `${role}: giriş başarısız — ${url.pathname}${url.search}. ` +
        "Kullanıcı seed'i ile form arasında bir uyuşmazlık var (parola/rol/is_active).",
    );
  }
}

/**
 * TEK bir rolün oturumunu TAZELE — uzun koşular için.
 *
 * ═══ NEDEN GEREKTİ (ölçülmüş) ═══
 *
 * `globalSetup` beş rolü koşunun BAŞINDA giriş yaptırır. Kısa paketlerde bu yeter. Ama
 * `8007887`'nin ön yükleme perdesi her tam sayfa yüklemesine ~20 sn eklediği için envanter
 * taraması 75 dakikaya çıktı ve `src/lib/auth.ts`'teki 60 DAKİKALIK BOŞTA KALMA sınırı devreye
 * girdi: sırası en sona gelen `admin`, kendi turuna başladığında oturumu çoktan iptal edilmişti.
 *
 * Sonuç sessiz ve tehlikeliydi — tarama hata vermedi, `admin` için 66 kontrol raporladı (yani
 * yalnız `/login` sayfasındaki tek düğme) ve toplam 2122 yerine 2066 çıktı. Kapsamın sessizce
 * daralmasının bu paket içindeki İKİNCİ örneği.
 *
 * Ürün doğru davranıyor: boşta kalma sınırı bir güvenlik özelliğidir ve testler için
 * gevşetilmez. Doğru düzeltme, her rolün oturumunu KENDİ turundan hemen önce tazelemektir —
 * böylece boşta kalma süresi o turun süresiyle sınırlı kalır.
 */
export async function refreshRoleSession(browser: import("@playwright/test").Browser, role: SeededRole): Promise<void> {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) throw new Error("BASE_URL tanımlı değil — oturum tazelenemez.");
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await logInThroughForm(page, role);
    const session = (await context.cookies()).find((c) => c.name === "mas_session");
    if (!session?.value) {
      throw new Error(`${role}: tazeleme sonrası mas_session çerezi yok — oturum kurulamadı.`);
    }
    await context.storageState({ path: statePathFor(role) });
  } finally {
    await context.close();
  }
}

async function globalSetup(): Promise<void> {
  const baseURL = process.env.BASE_URL;
  if (!baseURL) {
    throw new Error(
      "BASE_URL tanımlı değil. Görsel paket çalışan bir sunucuya ihtiyaç duyar; " +
        "port'u spec'e gömmek Faz 2'de kaldırıldı.",
    );
  }

  const dbUrl = process.env.MAS_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!dbUrl) {
    throw new Error("MAS_E2E_DATABASE_URL (veya DATABASE_URL) gerekli — bu setup users tablosuna YAZAR.");
  }
  // Same fail-closed reflex the phase scripts use: this writes rows, so it refuses a target that
  // has not said it is disposable.
  // The marker vocabulary is IMPORTED from scripts/db/owner-url.ts, not restated here.
  //
  // Five copies of this list existed and they drifted, twice. First a narrower list refused
  // `mas_radar_ui_golden_clone` — a database whose name says "clone" outright. Then restore-drill.ts
  // introduced the marker "drill" and `mas_radar_cutover_rollback_drill` was refused by this
  // harness, which had never heard of it: the Faz 7 rehearsal failed at the smoke step for a reason
  // that had nothing to do with the cutover. A gate that misfires on correct input is a gate people
  // learn to route around, so there is now exactly one list.
  const appDbName = databaseNameFromUrl(dbUrl);
  if (!appDbName || !isDisposableDatabaseName(appDbName)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${appDbName ?? "(okunamadı)"}' disposable görünmüyor. ` +
        "Görsel harness gerçek kullanıcı satırı yazar; hedefin harcanabilir olduğunu adıyla söylemesi gerekir.",
    );
  }

  // The whole point of this phase. If the bypass is on, a green run would prove nothing about the
  // real auth path, so refuse rather than produce a reassuring lie.
  if (process.env.MAS_QA_BYPASS_AUTH) {
    throw new Error(
      "MAS_QA_BYPASS_AUTH ayarlı. Faz 2 bu paketin QA bypass'ına bağımlılığını kaldırdı; " +
        "sunucu ve test süreci bypass OLMADAN çalışmalı.",
    );
  }

  // A stale cookie jar outliving its database is the classic way this harness "passes" against
  // a session row that no longer exists, so the directory is rebuilt from scratch every run.
  rmSync(AUTH_DIR, { recursive: true, force: true });
  mkdirSync(AUTH_DIR, { recursive: true });

  const ownerSeedUrl = resolveOwnerSeedUrl(dbUrl);
  const pool = new Pool({ connectionString: ownerSeedUrl, max: 4 });
  const passwordHash = await argon2Hash(TEST_PASSWORD, ARGON2_OPTIONS);

  try {
    await verifyOwnerSeedPoolIdentity(pool, appDbName);
    for (const role of Object.keys(ROLE_STATE_FILES) as SeededRole[]) {
      // must_change_password is reset with the password for the same reason the lock is: since
      // 0095 /system/security can force a change on any row, and getCurrentUser() reads the flag
      // live. One forced change left on a reused test database would send every session of that
      // role to /change-password and redden suites that have nothing to do with passwords.
      await pool.query(
        `insert into public.users (username, password_hash, display_name, role, is_active, must_change_password)
         values ($1, $2, $3, $4, true, false)
         on conflict (username) do update
           set role = excluded.role,
               is_active = true,
               password_hash = excluded.password_hash,
               failed_login_count = 0,
               locked_until = null,
               must_change_password = false`,
        [usernameFor(role), passwordHash, `Görsel ${role}`, role],
      );
    }
  } finally {
    await pool.end();
  }

  const browser = await chromium.launch();
  try {
    for (const role of Object.keys(ROLE_STATE_FILES) as SeededRole[]) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();

      // The REAL form, not a crafted POST and not a hand-inserted session row. Going through the
      // form is what makes this evidence that login works end to end: server action, argon2
      // verify, session insert, Set-Cookie, and the post-login redirect all have to be correct.
      await logInThroughForm(page, role);

      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === "mas_session");
      if (!session || !session.value) {
        throw new Error(
          `${role}: giriş sonrası mas_session çerezi yok. Gerçek oturum kurulamadı — ` +
            "storageState kaydedilmedi (bypass'a düşmek yerine sert başarısızlık).",
        );
      }

      await context.storageState({ path: statePathFor(role) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export default globalSetup;
