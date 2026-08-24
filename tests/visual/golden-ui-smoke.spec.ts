// Faz 3 — Golden UI Smoke over the 24 critical screens, on a data-carrying clone.
//
// WHAT THIS ADDS OVER FAZ 1 AND FAZ 2.
//
//   legacy-semantic-smoke.spec.ts  10 legacy screens, EMPTY database — "does the screen render?"
//   phase17-38-routes.spec.ts      15 new routes, per-role authorization decision table
//   THIS FILE                      24 critical screens on a clone that actually HAS money in it,
//                                  plus ten DB↔UI reconciliations
//
// The empty-database gates can prove a screen is not broken. They cannot prove it shows the RIGHT
// NUMBER, because there is no number to show. That is the gap this file closes, and it is the one
// that matters for a finance panel: a page that renders beautifully and reports the wrong total is
// worse than a page that crashes.
//
// DATA CLASS — READ THIS BEFORE TRUSTING THE WORD "GOLDEN".
//
// The plan asks for `pg_dump mas_radar_dev → restore → pnpm db:migrate → 0087`. That is NOT what
// this runs against, because the real database's credentials are deliberately not available to this
// harness. The clone here is `DISPOSABLE_SYNTHETIC`: built by `pnpm seed:demo`, which maps the same
// source workbook the real import uses and therefore lands on the same headline counts
// (payments=19, checks=7, loans=1, cashflow_months=35). Close enough to exercise real arithmetic;
// NOT a substitute for the exact-clone gate, which still has to be run by someone holding the real
// credentials. Labelled honestly so nobody reads a pass here as that gate having been met.
//
// Usage:
//   pnpm build && DATABASE_URL=…/mas_radar_ui_golden_clone PORT=3230 pnpm start   (no QA bypass)
//   BASE_URL=http://127.0.0.1:3230 MAS_E2E_DATABASE_URL=…/mas_radar_ui_golden_clone \
//     pnpm exec playwright test tests/visual/golden-ui-smoke.spec.ts

import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";
import { statePathFor, type SeededRole } from "./global-setup";
import { assertScreenReady, enableVisualRegressionMode, watchScreen } from "./helpers/screen-ready";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3230";
const DB_URL = process.env.MAS_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

/**
 * GROUND TRUTH MUST NOT COME THROUGH THE LAYER BEING VERIFIED.
 *
 * The first version of this file computed its expected numbers over MAS_E2E_DATABASE_URL — the
 * `mas_radar_app` connection. That role is subject to RLS, and with no tier context set it sees
 * NOTHING. Measured side by side on the same database:
 *
 *   owner (postgres):  checks = 7   overdue payment_instances = 29
 *   mas_radar_app:     checks = 0   payment_instances        = 0
 *
 * Three spot-checks still reported PASS, because sum-over-no-rows is 0, fmtTL(0) is "0 TL", and
 * "0 TL" appears somewhere on nearly every screen. A reconciliation that compares zero to zero and
 * calls it agreement is worse than no reconciliation: it is a green light with nothing behind it.
 *
 * So the expected side is read with the OWNER connection, which is also the only way it is
 * genuinely independent of the application's own query path.
 */
const OWNER_DB_URL = process.env.MAS_E2E_OWNER_DATABASE_URL ?? "";

test.use({ baseURL: BASE_URL });
test.describe.configure({ timeout: 180_000 });

/**
 * The plan's critical route set (§6.3), with the destination each one actually ends on.
 *
 * All 24 exist as pages — none had to be substituted. Four are permanent 301s introduced by the
 * nine-module restructure (next.config.ts), so `expected` names the destination: asserting the
 * requested path would fail four correct redirects, and omitting the check would let a redirect to
 * /login pass. Writing the destination down keeps both failures visible.
 */
const CRITICAL_ROUTES: Array<{ href: string; expected: string }> = [
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
  { href: "/finance/bank", expected: "/finance/bank" },
  { href: "/finance/checks", expected: "/finance/checks" },
  { href: "/finance/loans", expected: "/finance/loans" },
  { href: "/finance/invoices", expected: "/finance/invoices" },
  { href: "/finance/receivables", expected: "/finance/receivables" },
  { href: "/finance/collections", expected: "/finance/collections" },
  { href: "/finance/treasury", expected: "/finance/treasury" },
  { href: "/finance/fx", expected: "/finance/fx" },
  { href: "/cashflow/budget", expected: "/cashflow/budget" },
  { href: "/data/quality", expected: "/data/quality" },
  { href: "/data/reconciliation", expected: "/data/reconciliation" },
  { href: "/data/documents", expected: "/data/documents" },
  { href: "/insights/briefing", expected: "/insights/briefing" },
  { href: "/system/controls", expected: "/system/controls" },
];

/**
 * The one route in this set that is not open to every tier.
 *
 * Restated here rather than imported from @/lib/authz/route-access on purpose: importing
 * canAccessRoute() would make the browser assert whatever the module already believes, which is
 * exactly the check that cannot catch a page that forgot to call the guard. Measured once against
 * rolesAllowedOn() and written down.
 */
const RESTRICTED = { href: "/system/controls", allowed: ["finance_manager", "admin"] as SeededRole[] };
const ALL_ROLES: SeededRole[] = ["viewer", "finance_operator", "finance_approver", "finance_manager", "admin"];
const DENIED = "[data-testid='route-access-denied']";

/** The documented display rule: src/components/ui/panel.tsx fmtTL(). */
function fmtTL(n: number): string {
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";
}

let pool: Pool;
let ownerPool: Pool;

test.beforeAll(async () => {
  if (!DB_URL) throw new Error("MAS_E2E_DATABASE_URL (veya DATABASE_URL) gerekli.");
  // Marker list kept in step with DISPOSABLE_MARKERS in scripts/db/owner-url.ts. The narrower
  // /verify|test|e2e/ refused `mas_radar_ui_golden_clone` — a database whose name says "clone"
  // outright — and a gate that misfires on correct input teaches people to route around it.
  if (!/verify|test|e2e|tmp|temp|disposable|scratch|sandbox|fixture|clone|restore|snapshot|probe/.test(DB_URL)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${DB_URL.replace(/\/\/[^@]*@/, "//***@")}' disposable görünmüyor.`,
    );
  }
  pool = new Pool({ connectionString: DB_URL, max: 4 });

  if (!OWNER_DB_URL) {
    throw new Error(
      "MAS_E2E_OWNER_DATABASE_URL gerekli — parasal spot-check'in beklenen tarafı RLS'e tabi " +
        "uygulama rolüyle DEĞİL, owner ile okunmalı (yoksa sıfırı sıfırla karşılaştırır).",
    );
  }
  ownerPool = new Pool({ connectionString: OWNER_DB_URL, max: 4 });

  // Fail loudly if the ground-truth connection cannot see the fixture. Without this the whole
  // reconciliation degrades silently into comparing zeros, which is exactly how it broke once.
  const seen = await num(`select count(*) v from payment_instances`);
  const checks = await num(`select count(*) v from checks`);
  const months = await num(`select count(*) v from cashflow_months`);
  if (seen === 0 || checks === 0 || months === 0) {
    throw new Error(
      `GROUND TRUTH BOŞ (payment_instances=${seen} checks=${checks} cashflow_months=${months}). ` +
        "Owner bağlantısı fixture'ı göremiyor; spot-check'ler sıfırı sıfırla karşılaştırmaya düşerdi.",
    );
  }
});

test.afterAll(async () => {
  await pool?.end();
  await ownerPool?.end();
});

/** Ground-truth read: OWNER connection, never the RLS-filtered application role. */
async function num(sql: string): Promise<number> {
  const res = await ownerPool.query<{ v: string }>(sql);
  return Number(res.rows[0].v);
}

/* ── 6.4 — every critical route, every assertion class ───────────────────────────────────── */

test.describe("kritik rota golden smoke (admin)", () => {
  for (const route of CRITICAL_ROUTES) {
    test(`golden ${route.href}`, async ({ page }, testInfo) => {
      await enableVisualRegressionMode(page);
      const watch = watchScreen(page);

      // HTTP/runtime + auth + content, in the §5.3 order.
      const response = await page.goto(route.href, { waitUntil: "domcontentloaded" });
      expect(response, `${route.href}: yanıt yok`).not.toBeNull();
      expect(response!.status(), `${route.href}: HTTP durumu`).toBe(200);
      await assertScreenReady(page, { expected: route.expected, watch });

      // Hydration errors are console errors with a distinctive shape. assertScreenReady already
      // fails on ANY console error, so this only exists to name the cause when it is that one.
      const hydration = watch.consoleErrors.filter((m) => /hydrat|did not match|Minified React error #(418|423|425)/i.test(m));
      expect(hydration, `${route.href}: hydration hatası`).toEqual([]);

      // "stuck navigation": the router must have settled, not still be showing a pending shell.
      //
      // NOT toHaveCount(0). The skeleton is a PERSISTENT node toggled with CSS — measured on a
      // settled page: count=1, display:none, visible=false. Asserting absence therefore failed on
      // all 24 healthy routes. What "stuck" actually means is that the shell is still being SHOWN.
      await expect(page.locator(".instant-navigation-skeleton"), `${route.href}: navigasyon takılı kaldı`)
        .not.toBeVisible();

      // ── Görsel ───────────────────────────────────────────────────────────────────────────
      const metrics = await page.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      // A page shorter than the header+nav it must contain is a collapsed render; an absurdly tall
      // one is usually a runaway list. Both are "looks wrong" without needing a baseline.
      expect(metrics.scrollHeight, `${route.href}: sayfa yüksekliği mantıksız (${metrics.scrollHeight}px)`)
        .toBeGreaterThan(400);
      expect(metrics.scrollHeight, `${route.href}: sayfa aşırı uzun (${metrics.scrollHeight}px)`)
        .toBeLessThan(60_000);
      // Table overflow / broken card both surface as the DOCUMENT scrolling sideways: every table in
      // this app is meant to scroll inside its own container, never to widen the page.
      expect(metrics.overflowX, `${route.href}: yatay taşma (${metrics.overflowX}px) — tablo/kart kırılmış`)
        .toBeLessThanOrEqual(2);

      // Screenshot RECORDED, not compared. §5.4 forbids creating baselines without human review, so
      // this attaches evidence to the run instead of minting 24 new baselines that nobody has looked
      // at and that would then have to be maintained.
      await testInfo.attach(`golden${route.expected.replace(/\//g, "-")}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    });
  }
});

/* ── 6.4 Auth — doğru rol görür, yanlış rol reddedilir, nav rol bazlı, rol değişimi yansır ── */

test.describe("yetkilendirme", () => {
  for (const role of ALL_ROLES) {
    const shouldSee = RESTRICTED.allowed.includes(role);

    test(`${role} → ${RESTRICTED.href} ${shouldSee ? "görebiliyor" : "reddediliyor"}`, async ({ browser }) => {
      const context = await browser.newContext({ baseURL: BASE_URL, storageState: statePathFor(role) });
      const page = await context.newPage();
      try {
        // Direct URL, not a click: the guard has to hold for someone who types the address.
        const response = await page.goto(RESTRICTED.href, { waitUntil: "domcontentloaded" });
        expect(response!.status(), `${role}: HTTP durumu`).toBe(200);
        expect(new URL(page.url()).pathname, `${role}: /login'e düştü`).not.toBe("/login");

        const denied = await page.locator(DENIED).count();
        if (shouldSee) {
          expect(denied, `${role} ${RESTRICTED.href} görebilmeli ama reddedildi`).toBe(0);
          await expect(page.locator("h1").first()).toBeVisible();
        } else {
          // Refused IN WORDS with a 200, not a redirect — the product's documented choice.
          expect(denied, `${role} ${RESTRICTED.href}'i GÖRMEMELİ ama içeri girdi`).toBe(1);
        }

        // Navigation link is role-based: a tier that may not enter must not be offered the door.
        const navLink = await page.locator(`a[href="${RESTRICTED.href}"]`).count();
        if (!shouldSee) {
          expect(navLink, `${role}: giremeyeceği rotanın navigasyon bağlantısını görüyor`).toBe(0);
        }
      } finally {
        await context.close();
      }
    });
  }

  test("rol DB'de değişince AYNI oturum bir sonraki istekte yeni rolü kullanıyor", async ({ browser }) => {
    // A session that keeps yesterday's privileges after a demotion is the failure this catches.
    const username = "golden_roleflip";
    const created = await pool.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role, is_active)
       values ($1, 'x', $1, 'finance_manager', true)
       on conflict (username) do update set role = 'finance_manager', is_active = true
       returning id`,
      [username],
    );
    const userId = created.rows[0].id;
    const token = randomBytes(32).toString("base64url");
    await pool.query(
      `insert into public.sessions (user_id, token_hash, expires_at, last_seen_at)
       values ($1, $2, now() + interval '1 day', now())`,
      [userId, createHash("sha256").update(token).digest("hex")],
    );

    const context = await browser.newContext({ baseURL: BASE_URL });
    await context.addCookies([
      { name: "mas_session", value: token, url: BASE_URL, httpOnly: true, sameSite: "Lax" },
    ]);
    const page = await context.newPage();
    try {
      await page.goto(RESTRICTED.href, { waitUntil: "domcontentloaded" });
      expect(await page.locator(DENIED).count(), "finance_manager girebilmeliydi").toBe(0);

      // Demote in the database only. The cookie is untouched.
      await pool.query(`update public.users set role = 'viewer' where id = $1`, [userId]);

      await page.goto(RESTRICTED.href, { waitUntil: "domcontentloaded" });
      expect(await page.locator(DENIED).count(), "viewer'a düşürüldü ama ESKİ rolüyle girmeye devam ediyor")
        .toBe(1);
    } finally {
      await pool.query(`update public.users set role = 'finance_manager' where id = $1`, [userId]);
      await context.close();
    }
  });
});

/* ── 6.5 — DB ↔ UI spot-check, exact equality, no float tolerance ────────────────────────── */

/**
 * Ten numbers, each computed from SQL that does NOT go through the application's query layer, then
 * compared to what the screen prints.
 *
 * EXACT EQUALITY, and the comparison is done on STRINGS produced by the documented formatter
 * (fmtTL = tr-TR, 0 fraction digits, " TL"). Comparing parsed floats would reintroduce exactly the
 * tolerance the plan forbids for monetary values; comparing the raw integer through the documented
 * display rule keeps both halves honest.
 *
 * One of these was wrong on the first attempt and the UI was right: "BUGÜN" prints the OUTSTANDING
 * amount, not the gross. The only instance due today is 50.000 with 20.000 already paid, and the
 * screen shows 30.000. The independent query below therefore subtracts paid_amount — which is the
 * correct definition of what is still owed, and is written down here so the next reader does not
 * have to rediscover it.
 */
test.describe("DB ↔ UI parasal spot-check", () => {
  async function textOf(page: Page, href: string): Promise<string> {
    await page.goto(href, { waitUntil: "networkidle" });
    return page.locator("main").innerText();
  }

  const TODAY = "(now() at time zone 'Europe/Istanbul')::date";
  const OPEN = "status <> 'paid' and cancelled_at is null and direction = 'outflow'";
  const OUTSTANDING = "coalesce(sum(amount - coalesce(paid_amount, 0)), 0)::bigint";

  test("1-3 · ödeme yükü: bugün, 7 gün, gecikmiş portföy", async ({ page }) => {
    const today = await num(`select ${OUTSTANDING} v from payment_instances where due_date = ${TODAY} and ${OPEN}`);
    const next7 = await num(`select ${OUTSTANDING} v from payment_instances where due_date >= ${TODAY} and due_date <= ${TODAY} + 6 and ${OPEN}`);
    const overdue = await num(`select ${OUTSTANDING} v from payment_instances where due_date < ${TODAY} and ${OPEN}`);

    const text = await textOf(page, "/payments");
    expect(text, `bugünkü açık yük ${fmtTL(today)}`).toContain(fmtTL(today));
    expect(text, `7 günlük çıkış ${fmtTL(next7)}`).toContain(fmtTL(next7));
    expect(text, `gecikmiş portföy ${fmtTL(overdue)}`).toContain(fmtTL(overdue));
  });

  test("4 · gecikmiş kayıt adedi", async ({ page }) => {
    const count = await num(`select count(*) v from payment_instances where due_date < ${TODAY} and ${OPEN}`);
    const text = await textOf(page, "/payments");
    expect(text, `gecikmiş kayıt adedi ${count}`).toMatch(new RegExp(`\\b${count}\\s+kayıt`));
  });

  test("5 · nakit akışı: runway ayı, en kötü ay tutarı, negatif ay adedi", async ({ page }) => {
    // The first attempt anchored on the ROW COUNT (35 months) and failed — that number is never
    // printed anywhere. /cashflow reports the three things an operator actually acts on, so those
    // are what get reconciled. A spot-check has to follow the product's vocabulary, not the
    // schema's; asserting a number the screen has no reason to show tests nothing but the test.
    const worst = await num(`select min(closing_balance)::bigint v from cashflow_months`);
    const negMonths = await num(`select count(*) v from cashflow_months where closing_balance < 0`);
    const runway = (
      await ownerPool.query<{ v: string }>(
        `select to_char(min(month_start), 'YYYY-MM') v from cashflow_months where closing_balance < 0`,
      )
    ).rows[0].v;

    const text = await textOf(page, "/cashflow");
    expect(text, `en kötü ay ${fmtTL(worst)}`).toContain(fmtTL(worst));
    expect(text, `negatif ay adedi ${negMonths}`).toContain(String(negMonths));
    expect(text, `runway ayı ${runway}`).toContain(runway);
  });

  test("6 · aktif çek adedi (arşivlenen HARİÇ)", async ({ page }) => {
    // 7 rows exist, 1 is archived. The screen must show 6 — and if it ever shows 7, an archived
    // instrument has re-entered the live portfolio, which is a financial defect, not a cosmetic one.
    const active = await num(`select count(*) v from checks where archived_at is null and cancelled_at is null`);
    const total = await num(`select count(*) v from checks`);
    expect(total, "fixture beklendiği gibi bir arşivli çek taşımıyor").toBeGreaterThan(active);
    const text = await textOf(page, "/finance/checks");
    expect(text.toUpperCase(), `aktif çek adedi ${active}`).toContain(`${active} ÇEK`);
  });

  test("7-9 · kredi: anapara, toplam taksit, finansman maliyeti", async ({ page }) => {
    const principal = await num(`select coalesce(sum(principal), 0)::bigint v from loans`);
    const installments = await num(`select coalesce(sum(amount), 0)::bigint v from loan_installments`);
    const financeCost = installments - principal;

    const text = await textOf(page, "/finance/loans");
    expect(text, `anapara ${fmtTL(principal)}`).toContain(fmtTL(principal));
    expect(text, `toplam taksit ${fmtTL(installments)}`).toContain(fmtTL(installments));
    expect(text, `finansman maliyeti ${fmtTL(financeCost)}`).toContain(fmtTL(financeCost));
  });

  test("10 · açık alacak sıfır VE sıfır olmasının nedeni doğru", async ({ page }) => {
    // The plan's "beklenmedik 0 yok" rule. A zero is only allowed when the data says zero, so the
    // zero is asserted TOGETHER with its justification: there are no invoices to be owed on.
    const openReceivable = await num(`select coalesce(sum(remaining), 0)::bigint v from invoice_open_items`);
    const invoices = await num(`select count(*) v from invoices`);
    expect(openReceivable, "bu fixture'da açık alacak sıfır olmalı").toBe(0);
    expect(invoices, "sıfır alacağın nedeni: hiç fatura yok").toBe(0);

    const text = await textOf(page, "/finance/receivables");
    expect(text, "açık alacak 0 TL göstermeli").toContain(fmtTL(0));
    // …and it must say so as a real empty state, not by rendering nothing at all.
    expect(text.length, "alacak ekranı boş kabuk").toBeGreaterThan(80);
  });
});
