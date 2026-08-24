// Faz 17-38 denetimi — the fifteen routes this plan added, exercised as a browser exercises them.
//
// WHAT THIS LAYER ADDS THAT THE UNIT TESTS CANNOT.
//
// src/lib/authz/route-access.test.ts proves the 5×15 DECISION table and that every page.tsx calls
// the guard. Neither of those is the same claim as "typing the URL does not render the page". This
// file makes the claim the audit actually cared about: a real browser, a real session cookie, a
// real HTTP round trip, and the page either arrives or is refused in words.
//
// HOW IT AUTHENTICATES, AND WHY NOT THE QA BYPASS.
//
// The existing specs run behind MAS_QA_BYPASS_AUTH=1, which short-circuits getCurrentUser() to one
// fixed account. That is fine for pixels and useless here: this file's whole subject is the
// DIFFERENCE between tiers, so it mints REAL sessions — a random opaque token in the cookie and
// only its SHA-256 in public.sessions, exactly the shape createSessionCookie() writes. The server
// under test must therefore run WITHOUT the bypass.
//
// Usage:
//   1. build a disposable DB and seed it
//   2. pnpm build && DATABASE_URL=…/mas_radar_e2e_verify PORT=3210 pnpm start   (no QA bypass)
//   3. BASE_URL=http://127.0.0.1:3210 MAS_E2E_DATABASE_URL=…/mas_radar_e2e_verify \
//      npx playwright test tests/visual/phase17-38-routes.spec.ts

import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Pool } from "pg";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3210";
const DB_URL = process.env.MAS_E2E_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

test.use({ baseURL: BASE_URL });
test.describe.configure({ mode: "serial", timeout: 180_000 });

const SESSION_COOKIE = "mas_session";

type Role = "viewer" | "finance_operator" | "finance_approver" | "finance_manager" | "admin";
const ROLES: Role[] = ["viewer", "finance_operator", "finance_approver", "finance_manager", "admin"];

/**
 * The same table src/lib/authz/route-access.test.ts asserts, restated here on purpose.
 *
 * Restated rather than imported because this layer must be able to DISAGREE with the unit layer.
 * Importing canAccessRoute() would make the browser assert whatever the module already believes,
 * which is precisely the check that cannot catch a page that forgot to call the guard.
 */
const ROUTES: Array<{ href: string; allowed: Role[] }> = [
  { href: "/finance/bank", allowed: ROLES },
  { href: "/finance/invoices", allowed: ROLES },
  { href: "/finance/receivables", allowed: ROLES },
  { href: "/finance/collections", allowed: ROLES },
  { href: "/finance/treasury", allowed: ROLES },
  { href: "/finance/facilities", allowed: ROLES },
  { href: "/finance/fx", allowed: ROLES },
  { href: "/finance/profitability", allowed: ROLES },
  { href: "/cashflow/budget", allowed: ROLES },
  { href: "/data/approvals", allowed: ["finance_approver", "finance_manager", "admin"] },
  { href: "/data/documents", allowed: ROLES },
  { href: "/insights/analysis", allowed: ROLES },
  { href: "/insights/briefing", allowed: ROLES },
  { href: "/system/controls", allowed: ["finance_manager", "admin"] },
  { href: "/system/jobs", allowed: ["finance_manager", "admin"] },
];

const DENIED = "[data-testid='route-access-denied']";

let pool: Pool;
/** role -> raw session token (the value that goes in the cookie). */
const tokens = new Map<Role, string>();
/** role -> user id, so a test can change a role in the DB mid-flight. */
const userIds = new Map<Role, string>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function mintSession(role: Role): Promise<void> {
  const username = `e2e_${role}`.slice(0, 32);
  const user = await pool.query<{ id: string }>(
    `insert into public.users (username, password_hash, display_name, role, is_active)
     values ($1, 'x', $2, $3, true)
     on conflict (username) do update set role = excluded.role, is_active = true
     returning id`, [username, username, role]);
  const id = user.rows[0].id;
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `insert into public.sessions (user_id, token_hash, expires_at, last_seen_at)
     values ($1, $2, now() + interval '1 day', now())`, [id, tokenHash(token)]);
  tokens.set(role, token);
  userIds.set(role, id);
}

async function useRole(page: Page, role: Role): Promise<void> {
  await page.context().clearCookies();
  await page.context().addCookies([{
    name: SESSION_COOKIE, value: tokens.get(role)!,
    url: BASE_URL, httpOnly: true, sameSite: "Lax",
  }]);
}

/** Attaches error collectors; returns the accumulated problems for assertion. */
function watch(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("response", (r) => { if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`); });
  return { consoleErrors, pageErrors, serverErrors };
}

test.beforeAll(async () => {
  if (!DB_URL) throw new Error("MAS_E2E_DATABASE_URL (veya DATABASE_URL) gerekli — bu paket gerçek oturum satırı yazar.");
  // Marker list kept in step with DISPOSABLE_MARKERS in scripts/db/owner-url.ts. The narrower
  // /verify|test|e2e/ refused `mas_radar_ui_golden_clone` — a database whose name says "clone"
  // outright — and a gate that misfires on correct input teaches people to route around it.
  if (!/verify|test|e2e|tmp|temp|disposable|scratch|sandbox|fixture|clone|restore|snapshot|probe/.test(DB_URL)) {
    // Aynı fail-closed refleks: bu paket users/sessions'a YAZIYOR.
    throw new Error(`GÜVENLİK DURDURMASI: '${DB_URL.replace(/\/\/[^@]*@/, "//***@")}' disposable görünmüyor.`);
  }
  pool = new Pool({ connectionString: DB_URL, max: 4 });
  // En az bir aktif admin — 0031'in değişmezi; admin rolü zaten aşağıda basılıyor.
  for (const role of ROLES) await mintSession(role);
});

test.afterAll(async () => { await pool?.end().catch(() => undefined); });

/* ── 1. oturumsuz istek /login'e gidiyor ─────────────────────────────────────────────── */
test("oturumsuz istek her korunan route'ta /login'e yönleniyor", async ({ page }) => {
  await page.context().clearCookies();
  for (const { href } of ROUTES) {
    const res = await page.goto(href, { waitUntil: "domcontentloaded" });
    expect(res?.status(), `${href} yanıt durumu`).toBeLessThan(400);
    expect(new URL(page.url()).pathname, `${href} oturumsuz`).toBe("/login");
  }
});

/* ── 2. 15 route × 5 katman: izin verilen girer, verilmeyen AÇIKÇA reddedilir ────────── */
for (const { href, allowed } of ROUTES) {
  for (const role of ROLES) {
    const permitted = allowed.includes(role);
    test(`${role} ${permitted ? "girebiliyor" : "AÇIKÇA reddediliyor"}: ${href}`, async ({ page }) => {
      const seen = watch(page);
      await useRole(page, role);
      const res = await page.goto(href, { waitUntil: "domcontentloaded" });

      // Stuck navigation yok: gerçekten bir DOM durumuna ulaşıldı, sonsuz spinner/redirect değil.
      expect(res, `${href} yanıt yok`).not.toBeNull();
      expect(res!.status(), `${href} HTTP durumu`).toBeLessThan(500);
      await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });
      // Yönlendirme döngüsü olmadığı: hâlâ istenen yolda.
      expect(new URL(page.url()).pathname, `${href} yönlendirme döngüsü`).toBe(href);

      if (permitted) {
        await expect(page.locator(DENIED), `${href} ${role} reddedilmemeli`).toHaveCount(0);
      } else {
        // Sessiz boş sayfa DEĞİL: açık bir cümle görünüyor.
        await expect(page.locator(DENIED), `${href} ${role} reddedilmeli`).toBeVisible();
        await expect(page.locator(DENIED)).toContainText("erişim yetkiniz yok");
        // İÇERİK SIZMIYOR: reddedilen sayfanın gövdesi, izinli bir katmanın gördüğü
        // veri panellerini taşımamalı.
        await expect(page.locator("main .panel, main table")).toHaveCount(0);
      }

      expect(seen.serverErrors, `${href} 5xx`).toEqual([]);
      expect(seen.pageErrors, `${href} runtime hatası`).toEqual([]);
      expect(seen.consoleErrors, `${href} console.error`).toEqual([]);
    });
  }
}

/* ── 3. GERÇEK TIKLAMA ile ulaşılabilirlik (page.goto değil) ─────────────────────────── */
//
// Bir sekmenin GÖRÜNMESI ile ÇALIŞMASI ayrı iddialardır; bu denetimi doğuran kusur tam olarak
// ikisinin ayrışmasıydı. Bu yüzden erişimi olan bir katman için yol, sidebar/sekme üzerinden
// gerçek bir .click() ile katediliyor.
const CLICK_PATHS: Array<{ module: string; tab: string; role: Role }> = [
  { module: "/finance", tab: "/finance/bank", role: "viewer" },
  { module: "/finance", tab: "/finance/facilities", role: "viewer" },
  { module: "/finance", tab: "/finance/fx", role: "finance_operator" },
  { module: "/finance", tab: "/finance/treasury", role: "finance_manager" },
  { module: "/finance", tab: "/finance/invoices", role: "admin" },
  { module: "/finance", tab: "/finance/receivables", role: "admin" },
  { module: "/finance", tab: "/finance/collections", role: "admin" },
  { module: "/finance", tab: "/finance/profitability", role: "admin" },
  { module: "/cashflow", tab: "/cashflow/budget", role: "viewer" },
  { module: "/data/quality", tab: "/data/documents", role: "viewer" },
  { module: "/data/quality", tab: "/data/approvals", role: "admin" },
  { module: "/insights/ask", tab: "/insights/analysis", role: "viewer" },
  { module: "/insights/ask", tab: "/insights/briefing", role: "viewer" },
  { module: "/system", tab: "/system/controls", role: "finance_manager" },
  { module: "/system", tab: "/system/jobs", role: "admin" },
];

for (const { module, tab, role } of CLICK_PATHS) {
  test(`gerçek tıklama ile ulaşılıyor (${role}): ${module} → ${tab}`, async ({ page }) => {
    const seen = watch(page);
    await useRole(page, role);
    await page.goto(module, { waitUntil: "domcontentloaded" });
    const link = page.locator(`a[href="${tab}"]`).first();
    await expect(link, `${tab} bağlantısı ${role} için görünmüyor`).toBeVisible({ timeout: 30_000 });
    await link.click();
    await page.waitForURL(`**${tab}`, { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe(tab);
    await expect(page.locator("main")).toBeVisible();
    await expect(page.locator(DENIED)).toHaveCount(0);
    expect(seen.serverErrors, `${tab} 5xx`).toEqual([]);
    expect(seen.pageErrors, `${tab} runtime hatası`).toEqual([]);
    expect(seen.consoleErrors, `${tab} console.error`).toEqual([]);
  });
}

/* ── 4. yetkisiz katmana bağlantı hiç ÇİZİLMİYOR (kapı + navigasyon aynı fikirde) ────── */
test("yetkisiz katman, giremeyeceği sekmenin bağlantısını görmüyor", async ({ page }) => {
  await useRole(page, "viewer");
  await page.goto("/data/quality", { waitUntil: "domcontentloaded" });
  await expect(page.locator('a[href="/data/approvals"]')).toHaveCount(0);
  // /system modülünün kendisi zaten izleyiciye kapalı — kenar çubuğunda da yok.
  await expect(page.locator('.sidebar-link[href="/system"]')).toHaveCount(0);
});

/* ── 5. OTURUM TAZELIĞI — Faz 17-38 denetimi madde 6 ─────────────────────────────────── */
//
// SORU: bir kullanıcının ROLÜ değiştiğinde, o kullanıcının VAR OLAN oturumu eski rolü taşımaya
// devam ediyor mu?
//
// Kaynağı okumak cevabın yarısını veriyor: oturum çerezi yalnız rastgele bir OPAK JETON taşıyor
// (createSessionCookie), public.sessions'ta ROL SÜTUNU YOK, ve getCurrentUser() her çağrıda
// users'a JOIN atıp u.role'ü DB'den taze okuyor. authz/context.ts'teki cache() React'in
// İSTEK-BAŞINA memoizasyonu — istekler ARASINDA değil.
//
// Ama okumak kanıt değil. Bu test ölçüyor: AYNI, önceden basılmış çerezle, rol DB'de
// değiştirildikten SONRA yapılan bir SONRAKİ istek yeni rolü mü kullanıyor?
test("rol DB'de değişince AYNI oturum çerezi bir sonraki istekte YENİ rolü kullanıyor", async ({ page }) => {
  // Bu testin kendi kullanıcısı — diğer testlerin katmanlarını bozmamak için ayrı.
  const username = "e2e_role_flip";
  const created = await pool.query<{ id: string }>(
    `insert into public.users (username, password_hash, display_name, role, is_active)
     values ($1,'x',$1,'viewer',true)
     on conflict (username) do update set role = 'viewer', is_active = true
     returning id`, [username]);
  const userId = created.rows[0].id;
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `insert into public.sessions (user_id, token_hash, expires_at, last_seen_at)
     values ($1,$2, now() + interval '1 day', now())`, [userId, tokenHash(token)]);

  await page.context().clearCookies();
  await page.context().addCookies([{
    name: SESSION_COOKIE, value: token, url: BASE_URL, httpOnly: true, sameSite: "Lax",
  }]);

  // 1) izleyici olarak /system/jobs REDDEDİLİYOR
  await page.goto("/system/jobs", { waitUntil: "domcontentloaded" });
  await expect(page.locator(DENIED), "izleyici reddedilmeliydi").toBeVisible();

  // 2) rol DB'de yükseltiliyor — çereze DOKUNULMUYOR
  await pool.query(`update public.users set role = 'finance_manager' where id = $1`, [userId]);

  // 3) AYNI çerezle bir SONRAKİ istek
  await page.goto("/system/jobs", { waitUntil: "domcontentloaded" });
  await expect(page.locator(DENIED), "yeni rol taze okunmalıydı — eski rol cache'lenmiş").toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/system/jobs");

  // 4) ve ters yön: geri düşürülünce yine ANINDA reddediliyor (tek yönlü bir tesadüf değil)
  await pool.query(`update public.users set role = 'viewer' where id = $1`, [userId]);
  await page.goto("/system/jobs", { waitUntil: "domcontentloaded" });
  await expect(page.locator(DENIED), "düşürülen rol anında etkili olmalıydı").toBeVisible();

  // 5) ve oturumun kendisi hâlâ GEÇERLİ — rol değişimi oturumu düşürmedi, sadece yeniden
  //    değerlendirdi. (Aksi hâlde yukarıdaki "reddedildi" /login yönlendirmesiyle karışırdı.)
  expect(new URL(page.url()).pathname).toBe("/system/jobs");
});

/* ── 6. oturumda rol SAKLANMIYOR — yapısal karşı-kanıt ───────────────────────────────── */
test("sessions tablosunda rol sütunu YOK (eski rol taşınacak bir yer bulamaz)", async () => {
  const cols = await pool.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema='public' and table_name='sessions'`);
  const names = cols.rows.map((r) => r.column_name);
  expect(names).not.toContain("role");
  // Pozitif kontrol: sorgu gerçekten sessions'a bakıyor.
  expect(names).toContain("token_hash");
});
