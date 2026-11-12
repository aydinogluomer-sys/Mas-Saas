// Faz 39 (A1) — Statik görünüm güvenliği (security_invoker = true) ve RLS sertleştirme testi.
//
// Bu test PostgreSQL bağlantısı olmadan her derleme/test turunda çalışır ve şunları kanıtlar:
//   1. Migration dosya kümesi (0001..0098+) migration-lib kurallarına (%100 ardışık, üst-seviye
//      BEGIN/COMMIT yok, CONCURRENTLY yok) tam uyar.
//   2. 0098_view_security_invoker_and_rls_hardening.sql tüm public görünümlerinde
//      `alter view public.%I set (security_invoker = true)` ve yazma yetkisi iptalini uygular,
//      approval_queue görünümünü `with (security_invoker = true)` ve `user_display_label()` ile
//      yeniler, sessions_admin_read + sessions_admin_revoke politikalarını ve
//      enforce_planning_approval_role() tetikleyicisini kurar.
//   3. 0098 ve SONRASINDAKİ (version >= 0098) her migration içindeki her `CREATE [OR REPLACE] VIEW`
//      tanımı açıkça `with (security_invoker = true)` taşımak zorundadır; böylece 0099+ içinde
//      eklenecek veya yenilenecek hiçbir görünüm kazara varsayılan (definer) moduna dönemez.

import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, validateFileSet } from "../../scripts/db/migration-lib";
import { can, canApprovePlanningLines } from "@/lib/authz/matrix";

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ");
}

describe("Faz 39 (A1) — PostgreSQL görünüm security_invoker kalkanı ve RLS matrisi", () => {
  const fileSet = validateFileSet(MIGRATIONS_DIR);

  it("migration dosya kümesi 0098 dahil eksiksiz ve geçerlidir", () => {
    expect(fileSet.errors).toEqual([]);
    expect(fileSet.files.some((f) => f.version === "0098")).toBe(true);
  });

  it("0001..0097 arasındaki tüm görünümler 0098 dinamik kalkanı ile security_invoker=true yapılır", () => {
    const pre0098Views = new Set<string>();
    for (const f of fileSet.files) {
      if (Number(f.version) >= 98) continue;
      const clean = stripSqlComments(f.content);
      for (const m of clean.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z0-9_]+)/gi)) {
        pre0098Views.add(m[1].toLowerCase());
      }
    }
    expect(pre0098Views.size).toBeGreaterThanOrEqual(81);

    const m0098 = fileSet.files.find((f) => f.version === "0098");
    expect(m0098).toBeDefined();
    const sql0098 = stripSqlComments(m0098!.content);

    expect(sql0098).toMatch(/alter\s+view\s+public\.%I\s+set\s*\(\s*security_invoker\s*=\s*true\s*\)/i);
    expect(sql0098).toMatch(/revoke\s+insert,\s*update,\s*delete,\s*truncate\s+on\s+table\s+public\.%I/i);
    expect(sql0098).toMatch(/alter\s+default\s+privileges\s+in\s+schema\s+public[\s\S]*?revoke\s+insert,\s*update,\s*delete\s+on\s+tables\s+from\s+authenticated/i);
    expect(sql0098).toMatch(/alter\s+role\s+mas_radar_app\s+noinherit/i);
    expect(sql0098).toMatch(/create\s+policy\s+sessions_admin_read\s+on\s+public\.sessions/i);
    expect(sql0098).toMatch(/create\s+policy\s+sessions_admin_revoke\s+on\s+public\.sessions/i);
    expect(sql0098).toMatch(/create\s+or\s+replace\s+function\s+public\.enforce_planning_approval_role\(\)/i);
  });

  it("0098 ve sonrası (0098+) her CREATE [OR REPLACE] VIEW tanımı açıkça WITH (security_invoker = true) taşır", () => {
    const violations: string[] = [];

    for (const f of fileSet.files) {
      if (Number(f.version) < 98) continue;
      const clean = stripSqlComments(f.content);
      const regex = /create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z0-9_]+)([\s\S]{0,160}?)\bas\b/gi;
      for (const m of clean.matchAll(regex)) {
        const viewName = m[1];
        const header = m[2];
        if (!/with\s*\([^)]*security_invoker\s*=\s*true[^)]*\)/i.test(header)) {
          violations.push(`${f.name}: ${viewName}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("kod yetki matrisi (matrix.ts) planlama satırı onayını ve admin oturum iptalini doğru modeller", () => {
    expect(canApprovePlanningLines("viewer")).toBe(false);
    expect(canApprovePlanningLines("finance_operator")).toBe(false);
    expect(canApprovePlanningLines("finance_approver")).toBe(true);
    expect(canApprovePlanningLines("finance_manager")).toBe(true);
    expect(canApprovePlanningLines("admin")).toBe(true);

    expect(can("finance_approver", "budget_lines", "insert")).toBe(false);
    expect(can("finance_approver", "budget_lines", "update")).toBe(true);
    expect(can("finance_approver", "forecast_lines", "insert")).toBe(false);
    expect(can("finance_approver", "forecast_lines", "update")).toBe(true);

    // Oturum yaratma hiçbir katmana açık değildir (yalnız login hattı); yalnız admin iptal (update) yapabilir.
    for (const role of ["viewer", "finance_operator", "finance_approver", "finance_manager", "admin"] as const) {
      expect(can(role, "sessions", "insert")).toBe(false);
    }
    expect(can("admin", "sessions", "update")).toBe(true);
    expect(can("finance_manager", "sessions", "update")).toBe(false);
  });
});
