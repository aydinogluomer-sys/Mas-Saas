// Sözleşme ile migration'ın aynı 17 tabloyu söylediğini doğrular.
//
// NEDEN VAR. `0088_import_external_keys.sql` (ve onu genişleten `0103`) içindeki `entity_table`
// CHECK listesi ile `contract.ts` içindeki `domainTable` değerleri iki ayrı yerde yazılı.
// Biri değişip diğeri değişmezse hata sessizdir ve geç fark edilir: sözleşmeye yeni bir sayfa
// eklenir, import çalışır, sonra o sayfanın kayıtları defterine yazılamaz ve idempotency yalnız
// O aile için çöker. Yeniden import ikinci kopyayı üretir — yani sessiz mükerrer.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA_SHEETS } from "./contract";

const SQL_0088 = path.resolve(__dirname, "../../../../supabase/migrations/0088_import_external_keys.sql");
const SQL_0103 = path.resolve(
  __dirname,
  "../../../../supabase/migrations/0103_close_operational_loops_and_reconciliation_signoffs.sql",
);

/** Güncel CHECK içindeki tırnaklı tablo adları (0103). */
function allowedTablesFromMigration(): string[] {
  const src = readFileSync(SQL_0103, "utf8");
  const m = /constraint import_external_keys_entity_table_check[\s\S]*?check \(entity_table in \(([\s\S]*?)\)\)/.exec(src);
  if (!m) throw new Error("0103 içinde import_external_keys_entity_table_check bulunamadı — migration değişmiş olabilir");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("Import V2 sözleşmesi ↔ migration 0088 + 0103", () => {
  const allowed = allowedTablesFromMigration();
  const contractTables = [...new Set(
    DATA_SHEETS.map((s) => s.domainTable).filter((t): t is string => t !== null),
  )];

  it("migration, sözleşmedeki her domain tablosuna izin verir", () => {
    const eksik = contractTables.filter((t) => !allowed.includes(t));
    expect(eksik, `0103 CHECK listesinde eksik: ${eksik.join(", ")}`).toEqual([]);
  });

  it("migration sözleşmede olmayan bir tabloya izin vermez", () => {
    const fazla = allowed.filter((t) => !contractTables.includes(t));
    expect(fazla, `0103 CHECK listesinde fazladan: ${fazla.join(", ")}`).toEqual([]);
  });

  it("iki liste birebir aynı kümedir", () => {
    expect([...allowed].sort()).toEqual([...contractTables].sort());
  });

  // Defterin işe yaraması eşsizliğe bağlı. Bu iki kısıt olmadan `import_external_keys` yalnız
  // bir günlük olurdu: aynı kod ikinci bir kayıt yaratabilir, ya da iki kod aynı kaydı
  // sahiplenebilirdi. İkisi de idempotency vaadini sessizce bozar.
  it("idempotency'nin dayandığı iki eşsizlik 0088 migration'ında duruyor", () => {
    const src = readFileSync(SQL_0088, "utf8");
    expect(src).toContain("unique (entity_table, external_id)");
    expect(src).toMatch(/create unique index[\s\S]*?on public\.import_external_keys \(entity_table, entity_id\)/);
  });

  it("RLS açık ve viewer'a yazma izni verilmiyor", () => {
    const src = readFileSync(SQL_0088, "utf8");
    expect(src).toContain("enable row level security");
    // Faz 24B değişmezi: viewer hiçbir tabloya yazmaz.
    const yazmaSatirlari = src.split(/\r?\n/).filter((l) =>
      /^grant .*(insert|update|delete)/i.test(l.trim()) || /for (insert|update|delete) to/i.test(l));
    for (const l of yazmaSatirlari) expect(l).not.toContain("mas_radar_viewer");
  });
});
