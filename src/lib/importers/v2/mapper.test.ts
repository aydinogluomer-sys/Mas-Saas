// Standart Import V2 — eşleyicinin veritabanı gerektirmeyen sözleşmeleri.
//
// Uçtan uca kanıt `scripts/import/v2-import-e2e.ts` içinde ve harcanabilir bir veritabanına
// karşı koşuyor. Burada ölçülen şey farklı: eşleyicinin YAZMADAN ÖNCE verdiği kararlar.
// Bunlar sahte bir istemciyle ölçülebilir ve ölçülmeli — çünkü en pahalı hatalar
// (önizlemenin sessizce yazması, bir ailenin sessizce atlanması) tam burada olur.
import { describe, expect, it, beforeAll } from "vitest";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "./fixture";
import { parseWorkbook, type WorkbookParseResult } from "./parser";
import { mapWorkbook, FAMILY_WRITERS } from "./mapper";
import { DATA_SHEETS } from "./contract";

/**
 * Her sorguyu kaydeden, yazma denemesinde PATLAYAN sahte istemci.
 *
 * Önizlemenin yazmadığını "yazma sayısı 0" diye ölçmek yetmez — o ölçüm, yazma kodunun
 * çalışıp sessizce başarısız olduğu durumu da yeşil gösterirdi. Burada yazma denemesi
 * doğrudan hata fırlatır.
 */
class ReadOnlyFakeClient {
  readonly queries: string[] = [];

  async query<T>(text: string, _values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    void _values;
    this.queries.push(text);
    if (/^\s*(insert|update|delete|truncate|begin|commit)\b/i.test(text)) {
      throw new Error(`ÖNİZLEME YAZDI: ${text.slice(0, 80)}`);
    }
    return { rows: [], rowCount: 0 };
  }
}

let parsed: WorkbookParseResult;

beforeAll(async () => {
  parsed = parseWorkbook(await buildFixtureWorkbook());
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asClient = (c: ReadOnlyFakeClient): any => c;

describe("Önizleme kipi (§30) — hesaplar, yazmaz", () => {
  it("dryRun hiçbir yazma sorgusu çalıştırmaz", async () => {
    const fake = new ReadOnlyFakeClient();
    await expect(mapWorkbook(asClient(fake), parsed, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    })).resolves.toBeDefined();

    const yazma = fake.queries.filter((q) => /^\s*(insert|update|delete|truncate)\b/i.test(q));
    expect(yazma).toEqual([]);
  });

  it("dryRun bir workbook kaydı YARATMAZ", async () => {
    const fake = new ReadOnlyFakeClient();
    const r = await mapWorkbook(asClient(fake), parsed, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    });
    expect(r.workbookId).toBeNull();
    expect(r.dryRun).toBe(true);
  });

  it("önizleme sayımları gerçek sonuçla aynı sözleşmeyi kullanır", async () => {
    const fake = new ReadOnlyFakeClient();
    const r = await mapWorkbook(asClient(fake), parsed, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    });
    expect(r.rowsStaged).toBe(FIXTURE_ORACLE.totals.rowsRead);
    expect(r.rowsRejected).toBe(FIXTURE_ORACLE.totals.rejected);
    expect(r.rowsNeedsReview).toBe(FIXTURE_ORACLE.totals.needsReview);
  });
});

describe("Eşleyicisi olmayan aileler sessizce kaybolmaz", () => {
  it("yazıcısı olmayan her aile ADIYLA raporlanır", async () => {
    const fake = new ReadOnlyFakeClient();
    const r = await mapWorkbook(asClient(fake), parsed, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    });

    const hedefiOlan = DATA_SHEETS.filter((s) => s.domainTable !== null);
    const yaziciOlmayan = hedefiOlan
      .filter((s) => !(s.family in FAMILY_WRITERS))
      .map((s) => s.family)
      .sort();

    expect(r.stagedOnlyFamilies).toEqual(yaziciOlmayan);
    expect(r.stagedOnlyFamilies.length).toBeGreaterThan(0); // bugünkü gerçek: 13 aile bekliyor
  });

  it("yalnız hazırlıkta kalan satır sayısı sıfır değildir ve sayılır", async () => {
    const fake = new ReadOnlyFakeClient();
    const r = await mapWorkbook(asClient(fake), parsed, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    });
    expect(r.rowsStagedOnly).toBeGreaterThan(0);

    // Hiçbir satır kaybolmaz: okunan = yazılan + incelemede + reddedilen + hazırlıkta kalan.
    expect(r.rowsMapped + r.rowsNeedsReview + r.rowsRejected + r.rowsStagedOnly)
      .toBe(r.rowsStaged);
  });

  it("yazıcı listesi yalnız sözleşmede tanımlı aileleri içerir", () => {
    const aileler = new Set(DATA_SHEETS.map((s) => s.family));
    for (const f of Object.keys(FAMILY_WRITERS)) expect(aileler.has(f)).toBe(true);
  });
});

describe("V2 olmayan dosya", () => {
  it("şema tanınmazsa yazmaya HİÇ başlanmaz", async () => {
    const fake = new ReadOnlyFakeClient();
    const sahte = { ...parsed, schemaDetected: false, rejectionReason: "META yok" };
    await expect(mapWorkbook(asClient(fake), sahte, {
      filename: "legacy.xlsx", actorId: "00000000-0000-0000-0000-000000000001",
    })).rejects.toThrow(/Standart Import V2 değil/);
    expect(fake.queries).toEqual([]);
  });
});
