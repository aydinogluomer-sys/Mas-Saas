// PHASE 4 — /data/imports/v2 ürün akışının çerçevesiz katmanı. Veritabanı YOK: önizleme yalnız
// okuyan sahte bir client ile çalışır; onay yolunda transaction sözleşmesi (begin → … → rollback)
// sahte pool ile kilitlenir. Gerçek yazma kanıtı scripts/import/v2-import-e2e.ts'tedir.
import ExcelJS from "exceljs";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { buildTemplateBuffer } from "./template";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "./fixture";
import {
  UPLOAD_LIMITS, ALLOWED_EXTENSIONS, safeFilename, validateUploadMeta, openWorkbook, countDataRows,
  previewImport, confirmImport, sha256Hex,
} from "./service";
import { APP_ROLES } from "../../authz/matrix";
import { unwrapCell } from "./values";

/** Hiçbir şey döndürmeyen salt-okunur client: `import_external_keys` boş → her kodlu satır "yeni". */
const emptyClient = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PoolClient;

async function fixtureBuffer(): Promise<Buffer> {
  const wb = await buildFixtureWorkbook();
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("4.4 dosya güvenliği — ad, uzantı, boyut", () => {
  it("path traversal ve yol ayraçları REDDEDİLİR (temizlenmez)", () => {
    for (const bad of ["../x.xlsx", "..\\x.xlsx", "a/b.xlsx", "a\\b.xlsx", "..", "x..y.xlsx", "C:\\t.xlsx", "/etc/passwd.xlsx"]) {
      const r = safeFilename(bad);
      expect(r.ok, bad).toBe(false);
      expect(validateUploadMeta({ name: bad, size: 10 })?.code, bad).toBe("UNSAFE_FILENAME");
    }
  });

  it("kontrol karakteri / NUL / boş ad / aşırı uzun ad reddedilir", () => {
    expect(safeFilename("a\u0000b.xlsx").ok).toBe(false);
    expect(safeFilename("a\nb.xlsx").ok).toBe(false);
    expect(safeFilename("   ").ok).toBe(false);
    expect(safeFilename(`${"a".repeat(UPLOAD_LIMITS.maxFilenameLength + 1)}.xlsx`).ok).toBe(false);
  });

  it("normal Türkçe dosya adı kabul edilir ve olduğu gibi korunur", () => {
    const r = safeFilename("  Eylül_Ödemeler (2026).xlsx ");
    expect(r).toEqual({ ok: true, name: "Eylül_Ödemeler (2026).xlsx" });
  });

  it("yalnız .xlsx; .xls/.csv/.xlsm/uzantısız reddedilir", () => {
    expect(ALLOWED_EXTENSIONS).toEqual([".xlsx"]);
    for (const n of ["a.xls", "a.csv", "a.xlsm", "a", "a.XLSX.exe"]) {
      expect(validateUploadMeta({ name: n, size: 10 })?.code, n).toBe("BAD_EXTENSION");
    }
    expect(validateUploadMeta({ name: "A.XLSX", size: 10 })).toBeNull(); // uzantı büyük/küçük duyarsız
  });

  it(">50 MB reddedilir, tam 50 MB kabul; 0 bayt reddedilir", () => {
    expect(UPLOAD_LIMITS.maxBytes).toBe(50 * 1024 * 1024);
    expect(validateUploadMeta({ name: "a.xlsx", size: UPLOAD_LIMITS.maxBytes })).toBeNull();
    expect(validateUploadMeta({ name: "a.xlsx", size: UPLOAD_LIMITS.maxBytes + 1 })?.code).toBe("TOO_LARGE");
    expect(validateUploadMeta({ name: "a.xlsx", size: 0 })?.code).toBe("EMPTY_FILE");
  });
});

describe("4.4 dosya güvenliği — bozuk dosya, satır sınırı, formül", () => {
  it("ZIP olmayan bayt dizisi temiz bir redle döner (istisna yok)", async () => {
    const r = await openWorkbook(Buffer.from("PK yok, bu bir metin dosyası"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("CORRUPT_XLSX");
  });

  it("ZIP imzası olan ama XLSX olmayan/bozuk arşiv temiz redle döner", async () => {
    const buf = await fixtureBuffer();
    const broken = Buffer.concat([buf.subarray(0, 600), Buffer.alloc(200, 0x41)]);
    const r = await openWorkbook(broken);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("CORRUPT_XLSX");
  });

  it("countDataRows yalnız sözleşme veri sayfalarını sayar (README/ÖRNEKLER/META hariç, başlık hariç)", async () => {
    const wb = await buildFixtureWorkbook();
    const expected = Object.values(FIXTURE_ORACLE.sheets).reduce((n, s) => n + s.rowsRead, 0);
    expect(countDataRows(wb)).toBe(expected);
    const tpl = new ExcelJS.Workbook();
    const { buffer } = await buildTemplateBuffer();
    await tpl.xlsx.load(buffer as unknown as ArrayBuffer);
    expect(countDataRows(tpl)).toBe(0);
  });

  it(">100.000 veri satırı parse edilmeden reddedilir", async () => {
    // 100.001 satırı gerçekten yazmak yerine sayacın ölçtüğü alan (actualRowCount) taklit edilir.
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("01_ODEMELER")!;
    Object.defineProperty(ws, "actualRowCount", { get: () => UPLOAD_LIMITS.maxRows + 2 });
    expect(countDataRows(wb)).toBeGreaterThan(UPLOAD_LIMITS.maxRows);
  });

  it("formül ASLA yürütülmez: sonucu olmayan formül = bilinmiyor (null), sonucu olan = önbellek değeri", () => {
    expect(unwrapCell({ formula: "1+1" })).toBeNull();
    expect(unwrapCell({ formula: "1+1", result: 2 })).toBe(2);
    expect(unwrapCell({ formula: "=CMD(\"calc\")", result: "x" })).toBe("x");
    // Formül metni hiçbir yerde değer olarak kullanılmaz.
    expect(unwrapCell({ formula: "1+1" })).not.toBe("1+1");
  });
});

describe("4.2 önizleme — sayaçlar ve listeler (DB'siz, salt-okunur client)", () => {
  it("fixture için sayaçlar oracle ile tutar; hiçbir yazma sorgusu çalışmaz", async () => {
    const buf = await fixtureBuffer();
    const queries: string[] = [];
    const spy = { query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as PoolClient;
    const r = await previewImport(spy, buf, "fixture.xlsx", "00000000-0000-0000-0000-000000000001");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rep = r.report;
    expect(rep.sha256).toBe(sha256Hex(buf));
    expect(rep.schema.name).toBe(FIXTURE_ORACLE.schema.name);
    expect(rep.schema.version).toBe(FIXTURE_ORACLE.schema.version);

    const o = Object.values(FIXTURE_ORACLE.sheets);
    expect(rep.sheets.length).toBe(o.length);
    expect(rep.counters.reject).toBe(o.reduce((n, s) => n + s.rejected, 0));
    expect(rep.counters.review).toBe(o.reduce((n, s) => n + s.needsReview, 0));
    // Boş defter: kodlu hazır satırların hepsi "yaratılacak", hiçbiri "güncellenecek".
    expect(rep.counters.update).toBe(0);
    expect(rep.counters.create).toBeGreaterThan(0);
    // Yalnız SELECT çalıştı (import_external_keys bakışı) — INSERT/UPDATE/DELETE yok.
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q.trim().toLowerCase().startsWith("select")).toBe(true);
    // Listeler dolu ve doğru türde.
    expect(rep.lists.missingRequired.length).toBeGreaterThan(0);
    expect(rep.lists.nonTryFinance.length).toBeGreaterThan(0);
    expect(rep.lists.duplicateSuspects.length).toBeGreaterThan(0);
    for (const x of rep.lists.nonTryFinance) expect(["02_CEKLER", "03_KREDILER"]).toContain(x.sheet);
  });

  it("boş şablon: sıfır satır, sıfır yazma, ama şema tanınır", async () => {
    const { buffer } = await buildTemplateBuffer();
    const r = await previewImport(emptyClient, buffer, "MAS_Nakit_Radar_Standart_Import_v2.xlsx", "actor");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.counters).toMatchObject({ create: 0, update: 0, review: 0, reject: 0, undetermined: 0 });
    expect(r.report.lists.unsupportedFields).toEqual([]);
    expect(r.report.lists.unknownSheets).toEqual([]);
  });

  it("V2 olmayan (META'sız) çalışma kitabı NOT_V2_SCHEMA ile reddedilir", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("01_ODEMELER").addRow(["Tutar"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await previewImport(emptyClient, buf, "legacy.xlsx", "actor");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("NOT_V2_SCHEMA");
  });

  it("bilinmeyen başlık ve bilinmeyen sayfa DESTEKLENMEYEN ALANLAR listesine düşer", async () => {
    const wb = await buildFixtureWorkbook();
    const ws = wb.getWorksheet("01_ODEMELER")!;
    ws.getRow(1).getCell(ws.columnCount + 1).value = "Muhasebe Fişi No";
    wb.addWorksheet("NOTLAR").addRow(["serbest"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await previewImport(emptyClient, buf, "f.xlsx", "actor");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.lists.unsupportedFields).toContainEqual({ sheet: "01_ODEMELER", header: "Muhasebe Fişi No" });
    expect(r.report.lists.unknownSheets).toContain("NOTLAR");
  });
});

describe("4.1/4.5 onay — SHA eşleşmesi ve transaction sözleşmesi", () => {
  it("önizlenen SHA ile gelen dosya farklıysa hiç bağlanmadan SHA_MISMATCH", async () => {
    const buf = await fixtureBuffer();
    let connected = 0;
    const pool = { connect: async () => { connected++; throw new Error("bağlanılmamalıydı"); } } as unknown as Pool;
    const r = await confirmImport(pool, buf, "f.xlsx", "actor", "0".repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("SHA_MISMATCH");
    expect(connected).toBe(0);
    const r2 = await confirmImport(pool, buf, "f.xlsx", "actor", "not-a-sha");
    expect(r2.ok).toBe(false);
  });

  it("yazma sırasında hata: ROLLBACK verilir, bağlantı bırakılır, WRITE_FAILED döner (yarım import yok)", async () => {
    const buf = await fixtureBuffer();
    const log: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        const head = sql.trim().split(/\s+/)[0].toLowerCase();
        log.push(head);
        if (head === "insert") throw new Error("simüle edilen yazma hatası");
        return { rows: [], rowCount: 0 };
      },
      release: () => { released = true; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    const r = await confirmImport(pool, buf, "f.xlsx", "actor", sha256Hex(buf));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("WRITE_FAILED");
    expect(log[0]).toBe("begin");
    expect(log).toContain("insert");
    expect(log[log.length - 1]).toBe("rollback");
    expect(log).not.toContain("commit");
    expect(released).toBe(true);
  });

  it("dosya reddi (uzantı/boyut/bozuk) onay yolunda da aynı kapıdan geçer", async () => {
    const pool = { connect: async () => { throw new Error("bağlanılmamalıydı"); } } as unknown as Pool;
    const r = await confirmImport(pool, Buffer.from("x"), "f.csv", "actor", "0".repeat(64));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.rejection.code).toBe("BAD_EXTENSION");
  });
});

describe("4.4 RBAC — katman × sayfa (referans sınıfı sayfalar yalnız yönetici/finans yöneticisi)", () => {
  it("operator: ürün/proje/hesap/makine sayfaları YETKİ DIŞI listelenir; onay DB'ye gitmeden FORBIDDEN_SHEETS", async () => {
    const buf = await fixtureBuffer();
    const r = await previewImport(emptyClient, buf, "f.xlsx", "actor", { role: "finance_operator" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const forbidden = r.report.lists.forbiddenSheets.map((f) => f.table).sort();
    // reference sınıfı (0058): products, projects, bank_accounts, machine_assets, production_parts …
    expect(forbidden).toContain("products");
    expect(forbidden).toContain("projects");
    expect(forbidden).toContain("bank_accounts");
    expect(forbidden).not.toContain("payments");
    expect(forbidden).not.toContain("checks");
    for (const f of r.report.lists.forbiddenSheets) {
      expect(f.readyRows).toBeGreaterThan(0);
      expect(f.allowedRoles).toEqual(["finans yöneticisi", "yönetici"]);
    }
    let connected = 0;
    const pool = { connect: async () => { connected++; throw new Error("bağlanılmamalıydı"); } } as unknown as Pool;
    const c = await confirmImport(pool, buf, "f.xlsx", "actor", sha256Hex(buf), { role: "finance_operator" });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.rejection.code).toBe("FORBIDDEN_SHEETS");
      expect(c.rejection.detail).toContain("10_URUNLER");
    }
    expect(connected).toBe(0);
  });

  it("finans yöneticisi ve yönetici: yetki dışı sayfa yok; katman verilmezse liste boş (karar çağıranın)", async () => {
    const buf = await fixtureBuffer();
    for (const role of ["finance_manager", "admin"] as const) {
      const r = await previewImport(emptyClient, buf, "f.xlsx", "actor", { role });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.report.lists.forbiddenSheets).toEqual([]);
    }
    const noRole = await previewImport(emptyClient, buf, "f.xlsx", "actor");
    expect(noRole.ok && noRole.report.lists.forbiddenSheets).toEqual([]);
    expect(APP_ROLES).toContain("finance_operator");
  });
});
