import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_ROLES, type AppRole } from "./matrix";
import {
  PAGE_GUARDED_ROUTES,
  accessDeniedMessage,
  canAccessRoute,
  rolesAllowedOn,
} from "./route-access";

/**
 * Faz 17-38 denetimi — the 5 tier × 15 route decision table, written out in full.
 *
 * WHY THE TABLE IS LITERAL AND NOT DERIVED. Generating the expectations from canAccessRoute()
 * would make this file assert that the code equals itself — a test that passes no matter what
 * the policy becomes. Every cell below is therefore typed by hand from the entitlement its
 * route actually inherits, so that CHANGING the policy breaks this file and forces the change
 * to be stated out loud.
 *
 * WHERE EACH ROW COMES FROM (measured against the live catalogue, not assumed):
 *
 *  - The twelve `ALL` rows: every table behind those pages grants SELECT to all five tiers.
 *    Verified against pg_policies on a database migrated to 0087 — 27 tables, all five tiers
 *    on every one. That is 0058's "wide read, narrow write" shape, and a page gate stricter
 *    than the data layer would withhold numbers a colleague is entitled to read. Writes on
 *    those pages are refused where they must be: getPool() does SET ROLE per request and the
 *    policies decide, which is why a viewer may open /finance/bank and still not save an
 *    account.
 *
 *  - `/data/approvals` (approver, manager, admin): NOT a new rule. ROUTE_MIN_TIER has said this
 *    since Faz 36 — the maker-checker surface, where an operator raises requests but may not
 *    decide them. The database agrees independently: `approval` class gives finance_operator
 *    select+insert and NO update, so an operator could open the queue and fail every button.
 *
 *  - `/system/controls`, `/system/jobs` (manager, admin): inherited from MODULE_MIN_TIER
 *    "/system", also since Faz 24B. That entry's own comment claims "every page inside already
 *    refuses them" — which was the half that was not true, and is what this phase fixed.
 */
const EXPECTED: Record<string, AppRole[]> = {
  "/finance/bank": [...APP_ROLES],
  "/finance/invoices": [...APP_ROLES],
  "/finance/receivables": [...APP_ROLES],
  "/finance/collections": [...APP_ROLES],
  "/finance/treasury": [...APP_ROLES],
  "/finance/facilities": [...APP_ROLES],
  "/finance/fx": [...APP_ROLES],
  "/finance/profitability": [...APP_ROLES],
  "/cashflow/budget": [...APP_ROLES],
  "/data/approvals": ["finance_approver", "finance_manager", "admin"],
  "/data/documents": [...APP_ROLES],
  "/insights/analysis": [...APP_ROLES],
  "/insights/briefing": [...APP_ROLES],
  "/system/controls": ["finance_manager", "admin"],
  "/system/jobs": ["finance_manager", "admin"],
  // PHASE 4: yazma yüzeyi — DB'de source_workbooks INSERT'i olmayan viewer/approver giremez.
  "/data/imports/v2": ["finance_operator", "finance_manager", "admin"],
};

describe("requireRouteAccess — 5 katman × 16 route karar tablosu", () => {
  it("kapı listesi ile karar tablosu birebir aynı route kümesini kapsıyor", () => {
    expect([...PAGE_GUARDED_ROUTES].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(PAGE_GUARDED_ROUTES).toHaveLength(16);
  });

  // 75 kombinasyonun tamamı — her biri ayrı bir test, çünkü tek bir toplu assertion
  // başarısız olduğunda HANGİ hücrenin kaydığını söylemez.
  for (const route of Object.keys(EXPECTED)) {
    for (const role of APP_ROLES) {
      const allowed = EXPECTED[route].includes(role);
      it(`${role} ${allowed ? "GIREBILIR" : "GIREMEZ"}: ${route}`, () => {
        expect(canAccessRoute(role, route)).toBe(allowed);
      });
    }
  }

  it("rolesAllowedOn() karar tablosuyla aynı cevabı veriyor", () => {
    for (const route of Object.keys(EXPECTED)) {
      expect(rolesAllowedOn(route).sort()).toEqual([...EXPECTED[route]].sort());
    }
  });

  /**
   * NEGATIF TARAFIN GERÇEKTEN VAR OLDUĞU. Bütün hücreleri "izin ver" yapan bozuk bir kapı,
   * yukarıdaki 75 testin 67'sini geçerdi. Reddedilen kombinasyonların sayısını sabitlemek,
   * kapının hâlâ bir kapı olduğunu tek satırda kanıtlar.
   */
  it("tabloda gerçekten REDDEDİLEN kombinasyonlar var (kapı her şeye açık değil)", () => {
    const denied = Object.keys(EXPECTED).flatMap((route) =>
      APP_ROLES.filter((role) => !canAccessRoute(role, route)).map((role) => `${role}@${route}`),
    );
    // viewer+operator @ approvals (2) · viewer+operator+approver @ controls,jobs (6)
    // · viewer+approver @ imports/v2 (2) = 10
    expect(denied).toHaveLength(10);
    expect(denied).toContain("viewer@/system/jobs");
    expect(denied).toContain("finance_operator@/data/approvals");
    expect(denied).toContain("finance_approver@/system/controls");
    expect(denied).toContain("viewer@/data/imports/v2");
    expect(denied).toContain("finance_approver@/data/imports/v2");
  });

  it("izleyici finans okuma sayfalarından MEN EDİLMEDİ (veri katmanından katı olmamak)", () => {
    for (const route of ["/finance/bank", "/finance/invoices", "/finance/treasury",
      "/finance/facilities", "/cashflow/budget", "/data/documents", "/insights/analysis"]) {
      expect(canAccessRoute("viewer", route)).toBe(true);
    }
  });

  it("red mesajı hangi katmanda olunduğunu ve kimin girebileceğini SÖYLÜYOR", () => {
    const msg = accessDeniedMessage("viewer", "/system/jobs");
    expect(msg).toContain("erişim yetkiniz yok");
    expect(msg).toContain("izleyici");            // ROLE_LABEL.viewer
    expect(msg).toContain("finans yöneticisi");   // izin verilen katmanlardan biri
    expect(msg).toContain("yönetici");
  });

  it("red mesajı sayfanın İÇERİĞİNİ sızdırmıyor (yalnız yol adı ve katman)", () => {
    // Kapının arkasında ne olduğunu anlatan bir red, red değildir.
    //
    // İLK YAZILIŞI HATALIYDI VE ÜRÜN DEĞİL TEST DÜZELTİLDİ. Sızıntı listesine "onay" konmuştu;
    // mesaj bunu içeriyor, ama sayfa içeriğinden değil ROL ETİKETİNDEN: izin verilen katman
    // "finans ONAYlayıcı". İzin verilen katmanı adıyla söylemek mesajın işi — kullanıcıya
    // kimden erişim isteyeceğini söyleyen tek cümle o. Yani assertion yanlış kurulmuştu, kapı
    // doğruydu. Assertion gevşetilmedi; yanlış kurulan hücre çıkarıldı ve yerine daha güçlü,
    // gerçekten anlamlı bir kontrol kondu: mesajda hiçbir SAYI/VERİ geçmemeli.
    const msg = accessDeniedMessage("finance_operator", "/data/approvals");
    for (const leak of ["kuyruk", "tutar", "fatura", "IBAN", "bekleyen", "TL"]) {
      expect(msg.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
    // Rakam yok: bir red mesajı "3 bekleyen onay var" demeye başlarsa, reddettiği bilgiyi
    // sızdırmış olur.
    expect(msg).not.toMatch(/\d/);
  });
});

/**
 * YAPISAL KONTROL — kapının GERÇEKTEN takılı olduğu.
 *
 * Yukarıdaki 75 test yalnız KARARIN doğru olduğunu kanıtlar; sayfanın o kararı sorduğunu
 * kanıtlamaz. Bu denetimi doğuran kusur tam olarak buydu: karar (canSeeRoute) aylardır doğruydu,
 * sayfa onu hiç sormuyordu. Bu yüzden burada dosyaların kendisi okunuyor.
 *
 * `if (denied) return denied;` yarısı da aranıyor: kapıyı çağırıp dönüşünü yok sayan bir sayfa,
 * hiç çağırmayan bir sayfayla aynı şeydir.
 */
describe("route-access — 16 sayfanın kapıyı gerçekten çağırdığı", () => {
  const ROOT = process.cwd();
  for (const route of PAGE_GUARDED_ROUTES) {
    it(`page.tsx kapıyı çağırıyor ve dönüşüne uyuyor: ${route}`, () => {
      const file = path.join(ROOT, "src", "app", "(dashboard)", ...route.slice(1).split("/"), "page.tsx");
      const src = readFileSync(file, "utf8");
      expect(src).toContain(`requireRouteAccess("${route}")`);
      expect(src).toContain("if (denied) return denied;");
      expect(src).toContain('from "@/lib/authz/route-guard"');
    });
  }

  it("kapı, sayfanın İLK ifadesi (reddedilen katman için hiçbir sorgu çalışmıyor)", () => {
    for (const route of PAGE_GUARDED_ROUTES) {
      const file = path.join(ROOT, "src", "app", "(dashboard)", ...route.slice(1).split("/"), "page.tsx");
      const src = readFileSync(file, "utf8");
      const guardAt = src.indexOf("requireRouteAccess(");
      const poolAt = src.indexOf("getPool()");
      // getPool() kullanmayan sayfa varsa o kontrolü atla; kullananda kapı ÖNCE gelmeli.
      if (poolAt !== -1) expect(guardAt, route).toBeLessThan(poolAt);
    }
  });
});
