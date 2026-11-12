// Standart Import V2 — eşleyicinin veritabanı gerektirmeyen sözleşmeleri.
//
// Uçtan uca kanıt `scripts/import/v2-import-e2e.ts` içinde ve harcanabilir bir veritabanına
// karşı koşuyor. Burada ölçülen şey farklı: eşleyicinin YAZMADAN ÖNCE verdiği kararlar.
// Bunlar sahte bir istemciyle ölçülebilir ve ölçülmeli — çünkü en pahalı hatalar
// (önizlemenin sessizce yazması, bir ailenin sessizce atlanması) tam burada olur.
import { describe, expect, it, beforeAll } from "vitest";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "./fixture";
import { parseWorkbook, type WorkbookParseResult } from "./parser";
import { mapWorkbook, FAMILY_WRITERS, type MapperResult } from "./mapper";
import { DATA_SHEETS, sheetByName } from "./contract";

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

class RecordingFakeClient {
  readonly queries: Array<{ text: string; values: unknown[] }> = [];
  readonly ledger = new Map<string, string>();
  readonly mappingStatuses = new Map<string, string>();
  private seq = 0;

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.ledger.set(k, v);
  }

  async query<T>(text: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push({ text, values });
    const t = text.trim().toLowerCase();
    const row = (r: unknown): { rows: T[]; rowCount: number } => ({ rows: [r as T], rowCount: 1 });
    const none = { rows: [] as T[], rowCount: 0 };

    if (t.startsWith("select entity_id from public.import_external_keys")) {
      const id = this.ledger.get(`${String(values[0])}/${String(values[1])}`);
      return id ? row({ entity_id: id }) : none;
    }
    if (t.startsWith("insert into public.import_external_keys")) {
      const key = `${String(values[0])}/${String(values[1])}`;
      const bound = this.ledger.get(key) ?? String(values[2]);
      this.ledger.set(key, bound);
      return row({ entity_id: bound });
    }
    if (t.startsWith("update public.import_rows")) {
      this.mappingStatuses.set(String(values[0]), String(values[1]));
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith("select 1 from public.bank_accounts where cash_account_id")) return none;
    if (t.startsWith("select 1 from public.")) return row({ "?column?": 1 });
    if (t.startsWith("select")) return none;
    if (t.startsWith("insert") && /returning\s+id\b/.test(t)) return row({ id: `id-${++this.seq}` });
    if (t.startsWith("insert") || t.startsWith("update")) return { rows: [], rowCount: 1 };
    return none;
  }

  inserts(table: string): unknown[][] {
    return this.queries
      .filter((q) => q.text.trim().toLowerCase().startsWith(`insert into public.${table}`))
      .map((q) => q.values);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asWriter = (c: RecordingFakeClient): any => c;

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
  it("kanonik 17 sayfanın tamamı yazıcıya sahiptir; yazıcısı olmayan sentetik aile ise ADIYLA raporlanır", async () => {
    const fake = new ReadOnlyFakeClient();
    const r = await mapWorkbook(asClient(fake), parsed, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    });

    const hedefiOlan = DATA_SHEETS.filter((s) => s.domainTable !== null);
    const yaziciOlmayan = hedefiOlan
      .filter((s) => !(s.family in FAMILY_WRITERS))
      .map((s) => s.family)
      .sort();

    expect(yaziciOlmayan).toEqual([]);
    expect(r.stagedOnlyFamilies).toEqual([]);
    expect(r.rowsStagedOnly).toBe(0);
    expect(r.rowsMapped + r.rowsNeedsReview + r.rowsRejected + r.rowsBlockedByParent + r.rowsStagedOnly)
      .toBe(r.rowsStaged);

    // Gelecekte yazıcısı henüz eklenmemiş bir sayfa gelirse sessizce kaybolmamalı:
    const sentetik: WorkbookParseResult = {
      ...parsed,
      sheets: [
        ...parsed.sheets,
        {
          sheet: "98_SENTETIK",
          family: "synthetic_unmapped",
          domainTable: null,
          present: true,
          headerRow: ["Kayıt Kodu (external_id)"],
          missingColumns: [],
          unknownHeaders: [],
          rowsRead: 2,
          ready: 2,
          needsReview: 0,
          rejected: 0,
          blockedByParent: 0,
          rows: [
            { rowIndex: 2, status: "ready", externalId: "SYN-1", values: { external_id: "SYN-1" }, raw: { external_id: "SYN-1" }, issues: [] },
            { rowIndex: 3, status: "ready", externalId: "SYN-2", values: { external_id: "SYN-2" }, raw: { external_id: "SYN-2" }, issues: [] },
          ],
          issues: [],
        },
      ],
    };
    const rSentetik = await mapWorkbook(asClient(new ReadOnlyFakeClient()), sentetik, {
      filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true,
    });
    expect(rSentetik.unorderedSheets).toEqual(["98_SENTETIK"]);
    const unmappedContractSheet: WorkbookParseResult = { ...parsed, sheets: parsed.sheets.map((s) => (s.sheet === "15_MALIYET" ? { ...s, family: "synthetic_unmapped" } : s)) };
    const rUnmapped = await mapWorkbook(asClient(new ReadOnlyFakeClient()), unmappedContractSheet, { filename: "f.xlsx", actorId: "00000000-0000-0000-0000-000000000001", dryRun: true });
    expect(rUnmapped.stagedOnlyFamilies).toEqual(["synthetic_unmapped"]);
    expect(rSentetik.rowsStagedOnly).toBe(2);
    expect(
      rSentetik.rowsMapped +
      rSentetik.rowsNeedsReview +
      rSentetik.rowsRejected +
      rSentetik.rowsBlockedByParent +
      rSentetik.rowsStagedOnly,
    ).toBe(rSentetik.rowsStaged);
  });

  it("yazıcı listesi yalnız sözleşmede tanımlı aileleri içerir", () => {
    const aileler = new Set(DATA_SHEETS.map((s) => s.family));
    for (const f of Object.keys(FAMILY_WRITERS)) expect(aileler.has(f)).toBe(true);
  });
});

describe("Reddedilen kredinin taksitleri: yazılmaz, blocked_by_parent, önizleme = yazma", () => {
  const REJECTED_LOAN = "KREDI-EUR-01";
  const OLD_LOAN_ID = "loan-old-eur-from-previous-import";
  const ACTOR = "00000000-0000-0000-0000-000000000001";

  async function parseWithOrphanedInstallments(): Promise<WorkbookParseResult> {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("04_KREDI_TAKSITLERI")!;
    const spec = sheetByName("04_KREDI_TAKSITLERI")!;
    for (const n of [1, 2, 3]) {
      const t: Record<string, unknown> = {
        loan_external_id: REJECTED_LOAN, taksit_no: n, vade_tarihi: `2026-0${n}-15`,
        toplam_tutar: 230, durum: "planned",
      };
      ws.addRow(spec.columns.map((c) => (c.key in t ? t[c.key] : null)));
    }
    return parseWorkbook(wb);
  }

  const counts = (r: MapperResult) => ({
    rowsStaged: r.rowsStaged, rowsMapped: r.rowsMapped, rowsNeedsReview: r.rowsNeedsReview,
    rowsRejected: r.rowsRejected, rowsBlockedByParent: r.rowsBlockedByParent,
    rowsStagedOnly: r.rowsStagedOnly, reviewsOpened: r.reviewsOpened,
  });

  it("gerçek yazma: 0 engellenen taksit yazılır, 3 satır blocked_by_parent işlenir", async () => {
    const p = await parseWithOrphanedInstallments();
    const fake = new RecordingFakeClient({ [`loans/${REJECTED_LOAN}`]: OLD_LOAN_ID });
    const r = await mapWorkbook(asWriter(fake), p, { filename: "f.xlsx", actorId: ACTOR });

    expect(r.rowsBlockedByParent).toBe(3);

    const taksitYazimlari = fake.inserts("loan_installments");
    expect(taksitYazimlari.filter((v) => v[0] === OLD_LOAN_ID)).toEqual([]);
    const vakifId = fake.ledger.get("loans/KREDI-VAKIF-01");
    expect(vakifId).toBeDefined();
    expect(taksitYazimlari.filter((v) => v[0] === vakifId)).toHaveLength(2);
    expect(taksitYazimlari).toHaveLength(2);

    const statuses = [...fake.mappingStatuses.values()];
    expect(statuses.filter((x) => x === "blocked_by_parent")).toHaveLength(3);
    expect(statuses.filter((x) => x === "rejected")).toHaveLength(FIXTURE_ORACLE.totals.rejected);
    expect(statuses).toHaveLength(r.rowsStaged);

    const sebepler = fake.inserts("mapping_reviews").filter((v) => v[3] === "blocked_by_parent");
    expect(sebepler).toHaveLength(3);
    expect(sebepler.every((v) => typeof v[2] === "string")).toBe(true);
  });

  it("önizleme ile gerçek yazma AYNI sayıları verir (bulgu 7 gerilemez)", async () => {
    const p = await parseWithOrphanedInstallments();
    const seed = { [`loans/${REJECTED_LOAN}`]: OLD_LOAN_ID };

    const onizleme = await mapWorkbook(asClient(new ReadOnlyFakeClient()), p,
      { filename: "f.xlsx", actorId: ACTOR, dryRun: true });
    const yazma = await mapWorkbook(asWriter(new RecordingFakeClient(seed)), p,
      { filename: "f.xlsx", actorId: ACTOR });

    expect(counts(onizleme)).toEqual(counts(yazma));
    expect(onizleme.rowsBlockedByParent).toBe(3);
    expect(onizleme.rowsMapped + onizleme.rowsNeedsReview + onizleme.rowsRejected
      + onizleme.rowsBlockedByParent + onizleme.rowsStagedOnly).toBe(onizleme.rowsStaged);
  });

  it("kanonik fixture'ın yazma yolu da engellenen satır üretmez ve önizlemeyle örtüşür", async () => {
    const onizleme = await mapWorkbook(asClient(new ReadOnlyFakeClient()), parsed,
      { filename: "f.xlsx", actorId: ACTOR, dryRun: true });
    const yazma = await mapWorkbook(asWriter(new RecordingFakeClient()), parsed,
      { filename: "f.xlsx", actorId: ACTOR });
    expect(counts(onizleme)).toEqual(counts(yazma));
    expect(yazma.rowsBlockedByParent).toBe(0);
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
