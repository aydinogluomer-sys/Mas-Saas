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
const TEST_PASSWORD = "faz2-visual-harness-not-a-secret";

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
    await page.goto("/login", { waitUntil: "domcontentloaded" });
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
  // Kept in step with DISPOSABLE_MARKERS in scripts/db/owner-url.ts. The first version of this list
  // was narrower and refused `mas_radar_ui_golden_clone` — a database whose name says "clone" quite
  // clearly — which would have taught the next person to weaken the check rather than name their
  // database properly. A gate that misfires on correct input is a gate people route around.
  if (!/verify|test|e2e|tmp|temp|disposable|scratch|sandbox|fixture|clone|restore|snapshot|probe/.test(dbUrl)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${dbUrl.replace(/\/\/[^@]*@/, "//***@")}' disposable görünmüyor. ` +
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

  const pool = new Pool({ connectionString: dbUrl, max: 4 });
  const passwordHash = await argon2Hash(TEST_PASSWORD, ARGON2_OPTIONS);

  try {
    for (const role of Object.keys(ROLE_STATE_FILES) as SeededRole[]) {
      await pool.query(
        `insert into public.users (username, password_hash, display_name, role, is_active)
         values ($1, $2, $3, $4, true)
         on conflict (username) do update
           set role = excluded.role,
               is_active = true,
               password_hash = excluded.password_hash,
               failed_login_count = 0,
               locked_until = null`,
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
