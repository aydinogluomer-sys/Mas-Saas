// Faz 1 — semantic smoke for the ten critical legacy screens.
//
// WHAT THIS IS NOT. It is not a pixel snapshot. `dashboard.spec.ts` and friends compare images
// against baselines in tests/visual/__snapshots__, which answers "does this look like it did
// last week?" and cannot answer "did this screen render anything real at all?". A page that
// redirects to /login, renders the access-denied shell, or paints `NaN` into every KPI can be
// pixel-stable for months. This file asks the other question, and it asks it FIRST — the plan's
// ordering (auth → route → heading → content → no error → only then screenshot) exists because
// a green screenshot suite has been mistaken for a working application before.
//
// HOW IT AUTHENTICATES, AND WHY THAT MATTERS HERE. It mints REAL sessions the same way
// phase17-38-routes.spec.ts does: a random opaque token in the `mas_session` cookie, only its
// SHA-256 in public.sessions — the exact shape createSessionCookie() writes. It does NOT use
// MAS_QA_BYPASS_AUTH. That is deliberate and it is the whole reason this file can be trusted:
// the QA bypass makes getCurrentUser() return a fixed account while the middleware still looks
// for a cookie that was never set, and the two disagree into a /login redirect loop. A smoke
// test that depends on the bypass would be asserting the harness, not the product. The server
// under test must therefore run WITHOUT the bypass.
//
// Usage:
//   1. provision a disposable DB migrated to head
//   2. pnpm build && DATABASE_URL=…/mas_radar_e2e_verify PORT=3210 pnpm start   (no QA bypass)
//   3. BASE_URL=http://127.0.0.1:3210 MAS_E2E_DATABASE_URL=…/mas_radar_e2e_verify \
//      npx playwright test tests/visual/legacy-semantic-smoke.spec.ts

import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3210";
const DB_URL = process.env.MAS_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

test.use({ baseURL: BASE_URL });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const SESSION_COOKIE = "mas_session";

/**
 * The ten critical legacy screens, from the hardening plan's Job 7 list.
 *
 * Exercised as `admin` because this file's subject is "does the screen work", not "who may see
 * it" — the per-role decision table is phase17-38-routes.spec.ts's job, and duplicating it here
 * would mean two files failing for one cause. Admin is the role that should be able to reach
 * every one of these, so a denial here is unambiguously a defect rather than a policy.
 *
 * FOUR OF THESE TEN ARE PERMANENT REDIRECTS, AND THAT IS THE PRODUCT BEING CORRECT.
 *
 * The plan's route list was written before the information-architecture consolidation. Measured
 * against next.config.ts, these entries are 301s:
 *
 *     /radar      -> /payments
 *     /financing  -> /finance
 *     /reports    -> /insights/reports
 *     /reminders  -> /insights/reminders
 *
 * So `expected` is the URL the browser must END on, not the one it was given. Asserting the
 * request path would have failed on four correct redirects; dropping the check would have let a
 * redirect to /login pass. Naming the destination explicitly keeps both failures visible — an
 * unplanned redirect still fails, because the destination is written down here rather than
 * read back from wherever the browser happened to land.
 */
const ROUTES: Array<{ href: string; expected: string }> = [
  { href: "/overview", expected: "/overview" },
  { href: "/radar", expected: "/payments" },
  { href: "/cashflow", expected: "/cashflow" },
  { href: "/financing", expected: "/finance" },
  { href: "/reports", expected: "/insights/reports" },
  { href: "/reminders", expected: "/insights/reminders" },
  { href: "/production", expected: "/production" },
  { href: "/scenarios", expected: "/scenarios" },
  { href: "/payments", expected: "/payments" },
  { href: "/finance", expected: "/finance" },
];

const DENIED = "[data-testid='route-access-denied']";

/**
 * Strings that mean the framework gave up.
 *
 * Next has no custom error.tsx in this app, so a server or hydration failure renders one of
 * its stock shells rather than anything MAS wrote. Matching the stock text is therefore the
 * only way to catch it from the browser side.
 */
const ERROR_SHELL_MARKERS = [
  "Application error",
  "Internal Server Error",
  "This page could not be found",
  "500",
];

let pool: Pool;
let adminToken = "";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

test.beforeAll(async () => {
  if (!DB_URL) {
    throw new Error("MAS_E2E_DATABASE_URL (veya DATABASE_URL) gerekli — bu paket users/sessions'a YAZAR.");
  }
  // Same fail-closed reflex as phase17-38-routes.spec.ts: this file inserts rows, so it refuses
  // to run against a target that has not said it is disposable. The pattern is checked against
  // the whole URL rather than the parsed database name because a malformed URL must fail here,
  // not be treated as "no name and therefore fine".
  if (!/verify|test|e2e/.test(DB_URL)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${DB_URL.replace(/\/\/[^@]*@/, "//***@")}' disposable görünmüyor.`,
    );
  }
  pool = new Pool({ connectionString: DB_URL, max: 4 });

  const user = await pool.query<{ id: string }>(
    `insert into public.users (username, password_hash, display_name, role, is_active)
     values ($1, 'x', $2, 'admin', true)
     on conflict (username) do update set role = excluded.role, is_active = true
     returning id`,
    ["smoke_admin", "smoke_admin"],
  );
  adminToken = randomBytes(32).toString("base64url");
  await pool.query(
    `insert into public.sessions (user_id, token_hash, expires_at, last_seen_at)
     values ($1, $2, now() + interval '1 day', now())`,
    [user.rows[0].id, tokenHash(adminToken)],
  );
});

test.afterAll(async () => {
  await pool?.end();
});

async function signIn(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: SESSION_COOKIE, value: adminToken, url: BASE_URL, httpOnly: true, sameSite: "Lax" },
  ]);
}

for (const { href, expected } of ROUTES) {
  test(`legacy semantic smoke ${href}`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const serverErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
    });

    await signIn(page);

    // ── status 200 ─────────────────────────────────────────────────────────────────────
    const response = await page.goto(href, { waitUntil: "domcontentloaded" });
    expect(response, `${href}: navigasyon yanıtı yok`).not.toBeNull();
    expect(response!.status(), `${href}: HTTP durumu`).toBe(200);

    // ── final URL is the requested one, and is not /login ───────────────────────────────
    // Checked as a pathname rather than a substring: "/finance" is a prefix of "/financing",
    // and a substring check would call a redirect between them a pass.
    const finalPath = new URL(page.url()).pathname.replace(/\/$/, "") || "/";
    expect(finalPath, `${href}: son URL beklenenden farklı (beklenen ${expected})`).toBe(expected);
    expect(finalPath, `${href}: /login'e yönlendirildi`).not.toBe("/login");

    // ── not the unauthorized shell ─────────────────────────────────────────────────────
    expect(await page.locator(DENIED).count(), `${href}: yetkisiz kabuğu render edildi`).toBe(0);

    // ── main heading visible and non-empty ─────────────────────────────────────────────
    const h1 = page.locator("h1").first();
    await expect(h1, `${href}: ana başlık görünmüyor`).toBeVisible({ timeout: 20_000 });
    expect((await h1.innerText()).trim().length, `${href}: ana başlık boş`).toBeGreaterThan(0);

    // ── the screen rendered something, and not by accident ─────────────────────────────
    //
    // WHY THIS IS TWO ASSERTIONS AND NOT "at least one KPI is visible".
    //
    // The first version of this file required a data surface outright (`.tabular-nums, table`).
    // Run against a CI database it failed on /overview — and inspecting the failure, the page was
    // completely correct: heading "Ana Ekran", full navigation, and a deliberate onboarding panel
    // reading "Henüz veri yok." with a link to /imports. A CI database is migrated but carries no
    // financial rows (supabase/seed.sql is reference data only — accounts, categories, parties,
    // settings), so an empty state is the RIGHT rendering, not a defect. Asserting KPIs there
    // would have meant either a permanently red gate or seeding fake money to satisfy it, and
    // fake money in a financial fixture is how a test starts lying.
    //
    // So the property actually asserted is: the screen either SHOWS DATA or SAYS WHY IT CANNOT —
    // and never renders silence. A blank shell with only a title fails both branches, which is
    // the failure this job exists to catch.
    //
    // The stricter "real KPI numbers must be on screen" claim is not abandoned; it belongs to the
    // golden-clone gate, which runs against a clone of the real database where data exists. Set
    // MAS_SMOKE_REQUIRE_DATA=1 there to demand it.
    const main = page.locator("main");
    const mainText = (await main.innerText()).trim();
    expect(mainText.length, `${href}: <main> neredeyse boş (${mainText.length} karakter)`)
      .toBeGreaterThan(80);

    const dataSurface = page.locator(".tabular-nums, table");
    const emptyState = page.locator(".command-surface, .border-dashed");
    const dataCount = await dataSurface.count();
    const emptyCount = await emptyState.count();

    if (process.env.MAS_SMOKE_REQUIRE_DATA === "1") {
      expect(dataCount, `${href}: veri bekleniyordu (MAS_SMOKE_REQUIRE_DATA=1) ama yüzey yok`)
        .toBeGreaterThan(0);
    } else {
      expect(
        dataCount + emptyCount,
        `${href}: ne veri/KPI yüzeyi ne de açık "veri yok" durumu var — sessiz boş kabuk`,
      ).toBeGreaterThan(0);
    }

    // ── no NaN / undefined / error shell in rendered text ──────────────────────────────
    const bodyText = await page.locator("body").innerText();
    expect(bodyText, `${href}: ekranda NaN var`).not.toMatch(/\bNaN\b/);
    expect(bodyText, `${href}: ekranda undefined var`).not.toMatch(/\bundefined\b/);
    expect(bodyText, `${href}: ekranda Infinity var`).not.toMatch(/\bInfinity\b/);
    for (const marker of ERROR_SHELL_MARKERS) {
      expect(bodyText, `${href}: genel hata kabuğu ("${marker}")`).not.toContain(marker);
    }

    // ── no console.error, no pageerror, no 5xx subrequest ──────────────────────────────
    expect(pageErrors, `${href}: pageerror`).toEqual([]);
    expect(serverErrors, `${href}: 5xx alt istek`).toEqual([]);
    expect(consoleErrors, `${href}: console.error`).toEqual([]);
  });
}
