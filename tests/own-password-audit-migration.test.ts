// Migration 0096 — the viewer tier's one write path, pinned at commit time.
//
// WHY A STATIC TEST AS WELL. What PostgreSQL actually does with this policy is proved by
// db:roles-rls:verify, section H (five tiers allowed their own change, five viewer deviations
// refused, and this the only viewer write policy in the schema) — but that needs a database and
// runs only in CI. A migration is also the one artefact that cannot be quietly fixed later: once
// it has run on the canonical database it is history (0001–0095 are never edited). So this file
// fails locally, before any database sees the SQL, if 0096 stops being exactly what
// docs/database-schema.md says it is:
//
//   - the runner accepts it (numbering, no transaction control of its own — the `begin` inside
//     its DO block is PL/pgSQL, which the runner's scan must and does ignore)
//   - ONE policy, INSERT only, for mas_radar_viewer only
//   - its check is the four predicates and nothing looser: this action, this table, actor and
//     entity both the connection's own user
//   - idempotent: dropped by name before it is created
//   - no grant, no other command, no SECURITY DEFINER, nothing earlier altered
//   - it verifies itself (five tiers with an INSERT path, the viewer with exactly this one)
//
// The code matrix deliberately does NOT learn about this row-level exception — viewer stays
// READ on the evidence class, which is what keeps db:roles-rls:verify's generic `default values`
// probe (section B) expecting, and getting, a refusal. That divergence is pinned here too.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MIGRATIONS_DIR, validateFileSet } from "../scripts/db/migration-lib";
import { can } from "@/lib/authz/matrix";

const FILE = "0096_audit_own_password_change.sql";
const sql = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
/** The SQL that runs: `--` comments removed (the header explains in prose what is NOT allowed). */
const code = sql.replace(/--.*$/gm, "");
const POLICY = "audit_logs_insert_own_password_change";
const TIERS = [
  "mas_radar_viewer",
  "mas_radar_finance_operator",
  "mas_radar_finance_approver",
  "mas_radar_finance_manager",
  "mas_radar_admin",
];

describe("migration 0096 — izleyicinin tek yazma yolu", () => {
  it("koşucu dosya kümesini kabul ediyor (DO bloğundaki begin PL/pgSQL; işlem denetimi değil)", () => {
    const result = validateFileSet(MIGRATIONS_DIR);
    expect(result.errors).toEqual([]);
    expect(result.files.map((f) => f.name)).toContain(FILE);
  });

  it("tam olarak BİR politika yaratır: audit_logs üzerinde, yalnız INSERT, yalnız izleyici", () => {
    const creates = [...code.matchAll(/create\s+policy\s+(\w+)\s+on\s+public\.(\w+)\s+for\s+(\w+)\s+to\s+([\w\s,]+?)\s+with\s+check\b/gi)];
    expect(creates).toHaveLength(1);
    const [, name, table, command, roles] = creates[0];
    expect({ name, table, command: command.toLowerCase(), roles: roles.trim() }).toEqual({
      name: POLICY,
      table: "audit_logs",
      command: "insert",
      roles: "mas_radar_viewer",
    });
    // No second policy hiding in a form the pattern above would not match.
    expect(code.match(/create\s+policy/gi)).toHaveLength(1);
  });

  it("denetim yalnız KENDİ change_own_password satırına izin verir — dört koşulun hepsi, gevşeği yok", () => {
    const check = /with\s+check\s*\(([\s\S]*?)\)\s*;/i.exec(code)?.[1] ?? "";
    const predicates = check
      .split(/\band\b/i)
      .map((p) => p.replace(/\s+/g, " ").trim())
      .sort();
    expect(predicates).toEqual(
      [
        "action = 'change_own_password'",
        "entity_table = 'users'",
        "actor = public.current_app_user()",
        "entity_id = public.current_app_user()",
      ].sort(),
    );
    // `or`, a literal `true`, or `is null` would each widen it; none may appear in the check.
    expect(check).not.toMatch(/\bor\b|\btrue\b|\bis\s+(not\s+)?null\b/i);
  });

  it("idempotent: politika adıyla düşürülüp sonra yaratılır", () => {
    const drop = code.search(new RegExp(`drop\\s+policy\\s+if\\s+exists\\s+${POLICY}\\s+on\\s+public\\.audit_logs`, "i"));
    const create = code.search(new RegExp(`create\\s+policy\\s+${POLICY}\\b`, "i"));
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(create);
  });

  it("grant vermez; UPDATE/DELETE/ALL yolu, SECURITY DEFINER ya da önceki bir nesnede değişiklik yok", () => {
    expect(code).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(code).not.toMatch(/\bfor\s+(update|delete|all|select)\b/i);
    expect(code).not.toMatch(/security\s+definer/i);
    expect(code).not.toMatch(/\balter\s+(table|policy|role|function)\b/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|trigger|role)\b/i);
  });

  it("kendini doğrular: beş katmanın INSERT yolu var, izleyicinin bu tablodaki tek yazma politikası bu", () => {
    const doBlock = /do\s+\$\$([\s\S]*?)\$\$/i.exec(code)?.[1] ?? "";
    for (const tier of TIERS) expect(doBlock, tier).toContain(`'${tier}'`);
    expect(doBlock).toMatch(/cmd\s+in\s+\('INSERT',\s*'ALL'\)/);
    expect(doBlock).toContain(`is distinct from '${POLICY}'`);
    expect(doBlock.match(/raise\s+exception/gi)).toHaveLength(2);
  });

  it("kod matrisi istisnayı ÖĞRENMEZ: izleyici evidence sınıfında yine yalnız okur", () => {
    // Section B of db:roles-rls:verify compares this matrix with RLS using an all-NULL row; with
    // viewer still READ here, that probe keeps expecting (and getting) a refusal for viewer.
    expect(can("viewer", "audit_logs", "insert")).toBe(false);
    expect(can("viewer", "audit_logs", "update")).toBe(false);
    expect(can("viewer", "audit_logs", "delete")).toBe(false);
    for (const tier of ["finance_operator", "finance_approver", "finance_manager", "admin"] as const) {
      expect(can(tier, "audit_logs", "insert"), tier).toBe(true);
    }
  });
});
