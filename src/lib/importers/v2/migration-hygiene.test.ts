// Migration hijyeni — kısıt varlık kontrolleri tabloya bağlı mı?
//
// NEDEN VAR. PostgreSQL'de kısıt adları veritabanı genelinde EŞSİZ DEĞİLDİR; yalnız tablo
// içinde eşsizdir. `select 1 from pg_constraint where conname = 'x'` sorgusu BAŞKA bir
// tablonun kısıtını da bulur. Ardından gelen `alter table T drop constraint x` "böyle bir
// kısıt yok" diyerek migration'ı düşürür.
//
// Hata sessiz değil — gürültülü. Ama ortaya çıktığı an, migration'ın hedef veritabanında
// koştuğu andır: yani en kötü zamanda. Bu test onu commit anında yakalar.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DIR = path.resolve(__dirname, "../../../../supabase/migrations");

/** `if exists (select ... from pg_constraint ...)` blokları. */
function constraintExistenceBlocks(sql: string): string[] {
  return [...sql.matchAll(/select\s+1\s+from\s+pg_constraint([\s\S]{0,240}?)\)/gi)].map((m) => m[1]);
}

describe("Kısıt varlık kontrolleri tabloya bağlı", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();

  it("V2 feature migration'larında `conname` tek başına kullanılmıyor", () => {
    const suclu: string[] = [];
    for (const f of files.filter((x) => /^009[0-9]|^008[89]/.test(x))) {
      const sql = readFileSync(path.join(DIR, f), "utf8");
      for (const block of constraintExistenceBlocks(sql)) {
        if (/conname/i.test(block) && !/conrelid/i.test(block)) suclu.push(`${f}: ${block.trim().slice(0, 80)}`);
      }
    }
    expect(suclu, `tabloya bağlanmamış kısıt kontrolü:\n${suclu.join("\n")}`).toEqual([]);
  });

  it("0090 her iki kısıt kontrolünü de gerçek tabloya bağlıyor", () => {
    const sql = readFileSync(path.join(DIR, "0090_check_loan_currency.sql"), "utf8");
    expect(sql).toContain("conrelid = 'public.checks'::regclass");
    expect(sql).toContain("conrelid = 'public.loans'::regclass");
    // Kontrol sayısı ile tabloya bağlama sayısı eşit olmalı — biri eklenip diğeri unutulmasın.
    const blocks = constraintExistenceBlocks(sql).filter((b) => /conname/i.test(b));
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => /conrelid/i.test(b))).toBe(true);
  });
});

describe("0090 geriye dönük uyumluluk", () => {
  const sql = readFileSync(path.join(DIR, "0090_check_loan_currency.sql"), "utf8");

  it("kolon EKLER, kaldırmaz", () => {
    expect(sql).toMatch(/alter table public\.checks\s+add column if not exists currency/);
    expect(sql).toMatch(/alter table public\.loans\s+add column if not exists currency/);
    expect(sql).not.toMatch(/drop column/i);
  });

  // Mevcut satırların para birimi bilinmiyor değil: sistem onları zaten TRY sayıp hesapladı.
  // NULL bırakmak geçmişi olduğundan belirsiz gösterirdi.
  it("mevcut satırlar TRY olarak kalır (not null default)", () => {
    expect(sql).toContain("not null default 'TRY'");
  });
});
