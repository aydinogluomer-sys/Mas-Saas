// Domain eşlemesinin sözleşmeyle örtüştüğünü ve kararların anlamlı olduğunu doğrular.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA_SHEETS } from "./contract";
import { COLUMN_TARGETS, assertComplete, targetFor, domainColumnsFor } from "./domain-map";
import { FAMILY_WRITERS } from "./mapper";

describe("Eşleme bütünlüğü", () => {
  // Bu testin tek işi şu: bir kolon eklenip kararı yazılmadığında süit KIRMIZI olsun.
  // Sessiz atlama, kullanıcının doldurduğu bir alanın çöpe gitmesi demek.
  it("her sözleşme kolonunun tam olarak bir kararı var", () => {
    expect(() => assertComplete()).not.toThrow();
    expect(assertComplete().checked).toBe(
      DATA_SHEETS.reduce((n, s) => n + s.columns.length, 0),
    );
  });

  it("eşlemede sözleşmede olmayan kayıt yok", () => {
    const gecerli = new Set(DATA_SHEETS.flatMap((s) => s.columns.map((c) => `${s.name}.${c.key}`)));
    const fazla = Object.keys(COLUMN_TARGETS).filter((k) => !gecerli.has(k));
    expect(fazla).toEqual([]);
  });

  it("her `external_id` kolonu deftere gider, domain kaydına değil", () => {
    for (const sheet of DATA_SHEETS) {
      if (!sheet.columns.some((c) => c.key === "external_id")) continue;
      expect(targetFor(sheet.name, "external_id")?.kind, sheet.name).toBe("ledger");
    }
  });
});

describe("Kararların anlamı", () => {
  it("hedef alanlar `tablo.kolon` biçiminde", () => {
    for (const [k, t] of Object.entries(COLUMN_TARGETS)) {
      if (t.kind !== "domain" && t.kind !== "parent") continue;
      expect(t.field, k).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  // Gerekçesiz bir "karşılığı yok" kararı, kararı hiç vermemekle aynı: okuyan kişi bunun
  // bilinçli mi yoksa unutulmuş mu olduğunu ayırt edemez.
  it("her `karşılığı yok` kararının okunabilir bir gerekçesi var", () => {
    for (const [k, t] of Object.entries(COLUMN_TARGETS)) {
      if (t.kind !== "not_persisted") continue;
      expect(t.reason.length, k).toBeGreaterThan(20);
      expect(t.reason, k).toMatch(/\.$/);
    }
  });

  it("domain hedefleri, ait oldukları sayfanın hedef tablosuyla ya da bilinen bir üst tabloyla tutarlı", () => {
    // Üst kayıtlar sayfanın kendi tablosu değildir ama keyfi de değildir: yalnız bu üçü.
    const UST_TABLOLAR = new Set(["cash_accounts", "budgets", "cashflow_months"]);

    for (const sheet of DATA_SHEETS) {
      for (const col of sheet.columns) {
        const t = targetFor(sheet.name, col.key);
        if (!t || (t.kind !== "domain" && t.kind !== "parent")) continue;
        const tablo = t.field.split(".")[0];
        const beklenen = sheet.domainTable;
        expect(
          tablo === beklenen || UST_TABLOLAR.has(tablo),
          `${sheet.name}.${col.key} → ${t.field} (sayfanın hedefi: ${beklenen})`,
        ).toBe(true);
      }
    }
  });
});

describe("Yazıcılar ile eşleme birbirini tutuyor", () => {
  it("domain hedefi olan her ailenin yazıcısı var — ya da yokluğu gerekçeli", () => {
    for (const sheet of DATA_SHEETS) {
      const domainHedefi = Object.keys(domainColumnsFor(sheet.name)).length > 0;
      if (!domainHedefi) continue;
      expect(
        sheet.family in FAMILY_WRITERS,
        `${sheet.name} ailesinin domain hedefi var ama yazıcısı yok`,
      ).toBe(true);
    }
  });

  // 15_MALIYET'in yazıcısı BİLEREK yok: şablon uzun biçimde, `cost_models` geniş biçimde.
  // Bu testin işi, o kararın gerekçesiz sessiz bir boşluğa dönüşmemesini sağlamak.
  it("yazıcısı olmayan tek aile `cost` ve tüm kolonları gerekçeli", () => {
    const yazicisiz = DATA_SHEETS
      .filter((s) => s.domainTable !== null && !(s.family in FAMILY_WRITERS))
      .map((s) => s.family);
    expect(yazicisiz).toEqual(["cost"]);

    const maliyet = DATA_SHEETS.find((s) => s.family === "cost")!;
    for (const col of maliyet.columns) {
      const t = targetFor(maliyet.name, col.key)!;
      expect(["not_persisted", "ledger"], `${maliyet.name}.${col.key}`).toContain(t.kind);
    }
  });
});

describe("Migration 0088 ile aynı tablolardan bahsediyoruz", () => {
  it("eşlemedeki her domain tablosu deftere de kayıt yazabilir", () => {
    const sql = readFileSync(
      path.resolve(__dirname, "../../../../supabase/migrations/0088_import_external_keys.sql"), "utf8");
    const izinli = new Set([...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    const hedefTablolar = new Set(
      DATA_SHEETS.map((s) => s.domainTable).filter((t): t is string => t !== null));
    for (const t of hedefTablolar) expect(izinli.has(t), `0088 CHECK listesinde yok: ${t}`).toBe(true);
  });
});
