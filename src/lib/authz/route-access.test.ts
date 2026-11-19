import { readdirSync, readFileSync } from "node:fs";
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
 * Wave 1 (F-09..F-11) — 5 tier × 80 route decision table + 100% filesystem coverage gate.
 *
 * Every cell is written out literally (not derived from `canAccessRoute`) so any policy drift in
 * `MODULE_MIN_TIER` or `ROUTE_MIN_TIER` fails loudly here.
 */
const EXPECTED: Record<string, AppRole[]> = {
  "/": [...APP_ROLES],

  // Nakit Akışı (8)
  "/cashflow": [...APP_ROLES],
  "/cashflow/13-week": [...APP_ROLES],
  "/cashflow/[monthId]": [...APP_ROLES],
  "/cashflow/budget": [...APP_ROLES],
  "/cashflow/close": [...APP_ROLES],
  "/cashflow/concentration": [...APP_ROLES],
  "/cashflow/controls": [...APP_ROLES],
  "/cashflow/monthly": [...APP_ROLES],

  // Veri Merkezi (15)
  "/data": [...APP_ROLES],
  "/data/approvals": ["finance_approver", "finance_manager", "admin"],
  "/data/assumptions": [...APP_ROLES],
  "/data/documents": [...APP_ROLES],
  "/data/imports": [...APP_ROLES],
  "/data/imports/[workbookId]": [...APP_ROLES],
  "/data/imports/[workbookId]/reviews": [...APP_ROLES],
  "/data/imports/[workbookId]/sheets/[sheetId]": [...APP_ROLES],
  "/data/imports/v2": ["finance_operator", "finance_manager", "admin"],
  "/data/integrations": ["finance_operator", "finance_manager", "admin"],
  "/data/quality": [...APP_ROLES],
  "/data/reconciliation": [...APP_ROLES],
  "/data/reviews": [...APP_ROLES],
  "/data/sources": [...APP_ROLES],
  "/data/trial-balance-bridge": ["finance_operator", "finance_approver", "finance_manager", "admin"],

  // Finansman (21)
  "/finance": [...APP_ROLES],
  "/finance/archive": [...APP_ROLES],
  "/finance/bank": [...APP_ROLES],
  "/finance/calendar": [...APP_ROLES],
  "/finance/checks": [...APP_ROLES],
  "/finance/checks/new": [...APP_ROLES],
  "/finance/collections": [...APP_ROLES],
  "/finance/counterparties": [...APP_ROLES],
  "/finance/exposure": [...APP_ROLES],
  "/finance/facilities": [...APP_ROLES],
  "/finance/fx": [...APP_ROLES],
  "/finance/invoices": [...APP_ROLES],
  "/finance/ledger": [...APP_ROLES],
  "/finance/loans": [...APP_ROLES],
  "/finance/loans/[loanId]": [...APP_ROLES],
  "/finance/loans/new": [...APP_ROLES],
  "/finance/maturities": [...APP_ROLES],
  "/finance/profitability": [...APP_ROLES],
  "/finance/promises": [...APP_ROLES],
  "/finance/receivables": [...APP_ROLES],
  "/finance/treasury": [...APP_ROLES],

  // İçgörüler (9)
  "/insights": [...APP_ROLES],
  "/insights/analysis": [...APP_ROLES],
  "/insights/ask": [...APP_ROLES],
  "/insights/ask/[responseId]": [...APP_ROLES],
  "/insights/briefing": [...APP_ROLES],
  "/insights/reminders": [...APP_ROLES],
  "/insights/reports": [...APP_ROLES],
  "/insights/reports/[reportId]": [...APP_ROLES],
  "/insights/tasks": [...APP_ROLES],

  // Ödemeler (8)
  "/payments": [...APP_ROLES],
  "/payments/[paymentId]/edit": [...APP_ROLES],
  "/payments/archive": [...APP_ROLES],
  "/payments/calendar": [...APP_ROLES],
  "/payments/history": [...APP_ROLES],
  "/payments/items": [...APP_ROLES],
  "/payments/missing": [...APP_ROLES],
  "/payments/new": [...APP_ROLES],

  // Üretim (6)
  "/production": [...APP_ROLES],
  "/production/capacity": [...APP_ROLES],
  "/production/costs": [...APP_ROLES],
  "/production/kiosk": [...APP_ROLES],
  "/production/profitability": [...APP_ROLES],
  "/production/roi": [...APP_ROLES],

  // Senaryolar (5)
  "/scenarios": [...APP_ROLES],
  "/scenarios/[runId]": [...APP_ROLES],
  "/scenarios/compare": [...APP_ROLES],
  "/scenarios/history": [...APP_ROLES],
  "/scenarios/optimization": [...APP_ROLES],

  // Sistem (9)
  "/system": ["finance_manager", "admin"],
  "/system/archive": ["finance_manager", "admin"],
  "/system/audit": ["finance_manager", "admin"],
  "/system/backup": ["admin"],
  "/system/controls": ["finance_manager", "admin"],
  "/system/diagnostics": ["admin"],
  "/system/features": ["finance_manager", "admin"],
  "/system/jobs": ["finance_manager", "admin"],
  "/system/security": ["admin"],
};

const ROOT = process.cwd();
const DASHBOARD_DIR = path.join(ROOT, "src", "app", "(dashboard)");

function pageFileForRoute(route: string): string {
  return route === "/"
    ? path.join(DASHBOARD_DIR, "page.tsx")
    : path.join(DASHBOARD_DIR, ...route.slice(1).split("/"), "page.tsx");
}

function discoverDashboardPages(): Array<{ relFile: string; route: string; absFile: string }> {
  return (readdirSync(DASHBOARD_DIR, { recursive: true }) as string[])
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((rel) => rel === "page.tsx" || rel.endsWith("/page.tsx"))
    .sort()
    .map((relFile) => ({
      relFile,
      route: relFile === "page.tsx" ? "/" : `/${relFile.slice(0, -"/page.tsx".length)}`,
      absFile: path.join(DASHBOARD_DIR, relFile),
    }));
}

describe("requireRouteAccess — 5 katman × 82 route karar tablosu", () => {
  it("kapı listesi ile karar tablosu birebir aynı route kümesini kapsıyor", () => {
    expect([...PAGE_GUARDED_ROUTES].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(PAGE_GUARDED_ROUTES).toHaveLength(82);
  });

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

  it("tabloda gerçekten REDDEDİLEN kombinasyonlar var (kapı her şeye açık değil)", () => {
    const denied = Object.keys(EXPECTED).flatMap((route) =>
      APP_ROLES.filter((role) => !canAccessRoute(role, route)).map((role) => `${role}@${route}`),
    );
    // admin-only (backup, security, diagnostics): 3 × 4 = 12
    // system manager+admin (system, archive, audit, controls, features, jobs): 6 × 3 = 18
    // approvals (viewer, operator): 2
    // imports/v2 (viewer, approver): 2
    // integrations (viewer, approver): 2
    // trial-balance-bridge (viewer): 1
    // Total = 37
    expect(denied).toHaveLength(37);
    expect(denied).toContain("viewer@/system/jobs");
    expect(denied).toContain("finance_operator@/system/audit");
    expect(denied).toContain("finance_approver@/system/controls");
    expect(denied).toContain("finance_manager@/system/backup");
    expect(denied).toContain("finance_manager@/system/security");
    expect(denied).toContain("finance_manager@/system/diagnostics");
    expect(denied).toContain("finance_operator@/data/approvals");
    expect(denied).toContain("viewer@/data/imports/v2");
    expect(denied).toContain("finance_approver@/data/imports/v2");
    expect(denied).toContain("viewer@/data/integrations");
    expect(denied).toContain("finance_approver@/data/integrations");
    expect(denied).toContain("viewer@/data/trial-balance-bridge");
  });

  it("izleyici finans okuma sayfalarından MEN EDİLMEDİ (veri katmanından katı olmamak)", () => {
    for (const route of [
      "/",
      "/finance/bank",
      "/finance/invoices",
      "/finance/treasury",
      "/finance/facilities",
      "/cashflow/budget",
      "/data/documents",
      "/insights/analysis",
    ]) {
      expect(canAccessRoute("viewer", route)).toBe(true);
    }
  });

  it("red mesajı hangi katmanda olunduğunu ve kimin girebileceğini SÖYLÜYOR", () => {
    const msg = accessDeniedMessage("viewer", "/system/jobs");
    expect(msg).toContain("erişim yetkiniz yok");
    expect(msg).toContain("izleyici");
    expect(msg).toContain("finans yöneticisi");
    expect(msg).toContain("yönetici");
  });

  it("red mesajı sayfanın İÇERİĞİNİ sızdırmıyor (yalnız yol adı ve katman)", () => {
    const msg = accessDeniedMessage("finance_operator", "/data/approvals");
    for (const leak of ["kuyruk", "tutar", "fatura", "IBAN", "bekleyen", "TL"]) {
      expect(msg.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
    expect(msg).not.toMatch(/\d/);
  });
});

describe("route-access — dosya sistemi keşfi ve %100 kapı kapsamı (F-09..F-11)", () => {
  const discovered = discoverDashboardPages();

  it("src/app/(dashboard) altındaki TÜM page.tsx dosyaları PAGE_GUARDED_ROUTES içinde kayıtlıdır", () => {
    expect(discovered.map((d) => d.route).sort()).toEqual([...PAGE_GUARDED_ROUTES].sort());
  });

  for (const route of PAGE_GUARDED_ROUTES) {
    it(`page.tsx kapıyı çağırıyor ve dönüşüne uyuyor: ${route}`, () => {
      const file = pageFileForRoute(route);
      const src = readFileSync(file, "utf8");
      expect(src).toContain('from "@/lib/authz/route-guard"');
      expect(src).toContain(`const denied = await requireRouteAccess("${route}");`);
      expect(src).toContain("if (denied) return denied;");
    });
  }

  it("keşfedilen her page.tsx dosyasında kapı getPool() çağrısından ÖNCE gelir", () => {
    for (const { route, absFile } of discovered) {
      const src = readFileSync(absFile, "utf8");
      expect(src, `${route}: import eksik`).toContain('from "@/lib/authz/route-guard"');
      expect(src, `${route}: const denied ataması eksik`).toContain(
        `const denied = await requireRouteAccess("${route}");`,
      );
      expect(src, `${route}: if (denied) return denied; eksik`).toContain("if (denied) return denied;");
      const guardAt = src.indexOf(`const denied = await requireRouteAccess("${route}");`);
      const poolAt = src.indexOf("getPool()");
      expect(guardAt, route).toBeGreaterThan(-1);
      if (poolAt !== -1) {
        expect(guardAt, route).toBeLessThan(poolAt);
      }
    }
  });
});
