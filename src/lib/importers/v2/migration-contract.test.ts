// Sözleşme ile migration'ın aynı 16 tabloyu söylediğini doğrular.
//
// NEDEN VAR. `0088_import_external_keys.sql` içindeki `entity_table` CHECK listesi ile
// `contract.ts` içindeki `domainTable` değerleri iki ayrı yerde yazılı. Biri değişip diğeri
// değişmezse hata sessizdir ve geç fark edilir: sözleşmeye yeni bir sayfa eklenir, import
// çalışır, sonra o sayfanın kayıtları defterine yazılamaz ve idempotency yalnız O aile için
// çöker. Yeniden import ikinci kopyayı üretir — yani sessiz mükerrer.
//
// Bu test SQL'i metin olarak okur. Şık değil ama doğru yeri ölçüyor: çalışan veritabanına
// giden şey o dosya.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA_SHEETS } from "./contract";

const SQL = path.resolve(__dirname, "../../../../supabase/migrations/0088_import_external_keys.sql");

/** CHECK içindeki tırnaklı tablo adları. */
function allowedTablesFromMigration(): string[] {
  const src = readFileSync(SQL, "utf8");
  const m = /entity_table text not null check \(entity_table in \(([\s\S]*?)\)\)/.exec(src);
  if (!m) throw new Error("0088 içinde entity_table CHECK bulunamadı — migration değişmiş olabilir");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

describe("Import V2 sözleşmesi ↔ migration 0088", () => {
  const allowed = allowedTablesFromMigration();
  const contractTables = [...new Set(
    DATA_SHEETS.map((s) => s.domainTable).filter((t): t is string => t !== null),
  )];

  it("migration, sözleşmedeki her domain tablosuna izin verir", () => {
    const eksik = contractTables.filter((t) => !allowed.includes(t));
    expect(eksik, `0088 CHECK listesinde eksik: ${eksik.join(", ")}`).toEqual([]);
  });

  it("migration sözleşmede olmayan bir tabloya izin vermez", () => {
    const fazla = allowed.filter((t) => !contractTables.includes(t));
    expect(fazla, `0088 CHECK listesinde fazladan: ${fazla.join(", ")}`).toEqual([]);
  });

  it("iki liste birebir aynı kümedir", () => {
    expect([...allowed].sort()).toEqual([...contractTables].sort());
  });

  // Defterin işe yaraması eşsizliğe bağlı. Bu iki kısıt olmadan `import_external_keys` yalnız
  // bir günlük olurdu: aynı kod ikinci bir kayıt yaratabilir, ya da iki kod aynı kaydı
  // sahiplenebilirdi. İkisi de idempotency vaadini sessizce bozar.
  it("idempotency'nin dayandığı iki eşsizlik migration'da duruyor", () => {
    const src = readFileSync(SQL, "utf8");
    expect(src).toContain("unique (entity_table, external_id)");
    expect(src).toMatch(/create unique index[\s\S]*?on public\.import_external_keys \(entity_table, entity_id\)/);
  });

  it("RLS açık ve viewer'a yazma izni verilmiyor", () => {
    const src = readFileSync(SQL, "utf8");
    expect(src).toContain("enable row level security");
    // Faz 24B değişmezi: viewer hiçbir tabloya yazmaz.
    const yazmaSatirlari = src.split(/\r?\n/).filter((l) =>
      /^grant .*(insert|update|delete)/i.test(l.trim()) || /for (insert|update|delete) to/i.test(l));
    for (const l of yazmaSatirlari) expect(l).not.toContain("mas_radar_viewer");
  });
});
