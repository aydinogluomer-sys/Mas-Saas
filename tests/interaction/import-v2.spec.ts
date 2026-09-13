/**
 * PHASE 4 — /data/imports/v2 ürün akışı, GERÇEK UI + harcanabilir veritabanı.
 *
 * Plan §4.6 kabulleri burada ölçülür (kod-yalnız testler service.test.ts'te):
 *   DOWNLOAD_TEMPLATE   şablon route'u 200 + xlsx + X-Template-SHA256; viewer/approver 403
 *   UPLOAD / SCHEMA_DETECTION / PREVIEW   fixture yüklenir, ÖNİZLE sayaçları oracle ile tutar,
 *                       önizleme HİÇBİR ŞEY yazmaz (before/after bağımsız bağlantıyla)
 *   CONFIRM_IMPORT / TRANSACTIONAL_WRITE   ONAYLA → source_workbooks +1, import_rows = okunan
 *                       satır, domain kayıtları var, ikinci onay MÜKERRER ÜRETMEZ
 *   PROVENANCE_VISIBLE  sonuç panelinde workbook id + sha256; DB'de file_sha256 aynı; audit_logs
 *                       import_v2_map satırı actor + fileSha256 ile
 *   RBAC                viewer ve approver sayfada reddedilir (route-access-denied), sekme yok
 *   FILE_SAFETY         .csv seçilirse BAD_EXTENSION; bozuk .xlsx CORRUPT_XLSX; V2 olmayan
 *                       çalışma kitabı NOT_V2_SCHEMA — hiçbiri yazmaz
 *
 * Kullanım (üretim derlemesi, harcanabilir DB):
 *   MAS_NEXT_DIST_DIR=.next-v2-verify pnpm build
 *   DATABASE_URL=…/<disposable-app> PORT=3310 MAS_NEXT_DIST_DIR=.next-v2-verify pnpm start
 *   BASE_URL=http://127.0.0.1:3310 MAS_E2E_DATABASE_URL=…/<disposable> pnpm interaction:test -- import-v2
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "../../src/lib/importers/v2/fixture";
import { db, openAs, scalar, rows, type SeededRole } from "./harness";

const OUT = path.join(process.cwd(), "docs", "interaction-audit");
const ROUTE = "/data/imports/v2";
const evidence: Array<Record<string, unknown>> = [];

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "evidence-import-v2.json"), JSON.stringify({ route: ROUTE, rows: evidence }, null, 2) + "\n", "utf8");
});

async function fixtureBuffer(): Promise<Buffer> {
  const wb = await buildFixtureWorkbook();
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function counts() {
  return {
    workbooks: Number(await scalar<string>("select count(*) from public.source_workbooks where notes like 'Standart Import V2%'")),
    importRows: Number(await scalar<string>("select count(*) from public.import_rows")),
    externalKeys: Number(await scalar<string>("select count(*) from public.import_external_keys")),
    payments: Number(await scalar<string>("select count(*) from public.payments")),
    products: Number(await scalar<string>("select count(*) from public.products")),
    audits: Number(await scalar<string>("select count(*) from public.audit_logs where action = 'import_v2_map'")),
  };
}

const READ_ONLY: SeededRole[] = ["viewer", "finance_approver"];

/**
 * Akış testi "ilk import YARATIR, ikinci import GÜNCELLER" der; bunun için defter boş başlamalı.
 * Aynı harcanabilir DB'de daha önce v2-import-e2e koşmuş olabilir. audit_logs append-only olduğu
 * için dokunulmaz (sayımlar before/after farkıyla yapılır); users dokunulmaz (oturum hesapları).
 */
const IMPORT_STATE_TABLES = [
  "import_external_keys", "mapping_reviews", "import_rows", "source_cells", "source_sheets",
  "payment_instances", "payments", "checks", "loan_installments", "loans",
  "cashflow_lines", "cashflow_months", "bank_transactions", "bank_accounts", "cash_accounts",
  "invoices", "orders", "products", "projects", "budget_lines", "budgets", "fx_positions",
  "production_parts", "machine_assets", "source_workbooks",
];
async function resetImportState(): Promise<void> {
  await db(async (c) => {
    await c.query(`truncate ${IMPORT_STATE_TABLES.map((x) => `public.${x}`).join(", ")} cascade`);
  });
}

test.describe("PHASE 4 — RBAC ve şablon", () => {
  for (const role of READ_ONLY) {
    test(`${role}: sayfa reddedilir, sekme yok, şablon 403`, async ({ browser }) => {
      const s = await openAs(browser, role);
      await s.page.goto(ROUTE, { waitUntil: "networkidle" });
      await expect(s.page.getByTestId("route-access-denied")).toBeVisible();
      await expect(s.page.getByRole("link", { name: "Standart aktarım (V2)" })).toHaveCount(0);
      // Tarayıcı içinden fetch: oturum çerezi `Secure` olduğu için APIRequestContext http://127.0.0.1'e
      // göndermez, tarayıcı ise localhost'u güvenli bağlam sayar — kullanıcının yaşadığı yol budur.
      const status = await s.page.evaluate(async (u) => (await fetch(u)).status, `${ROUTE}/template`);
      expect(status).toBe(403);
      evidence.push({ check: "rbac", role, pageDenied: true, templateStatus: status });
      await s.context.close();
    });
  }

  test("operator: şablon 200, xlsx, sha256 başlığı, deterministik (iki indirme aynı)", async ({ browser }) => {
    const s = await openAs(browser, "finance_operator");
    await s.page.goto(ROUTE, { waitUntil: "networkidle" });
    const grab = async () => s.page.evaluate(async (u) => {
      const r = await fetch(u);
      const buf = new Uint8Array(await r.arrayBuffer());
      let bin = ""; for (const b of buf) bin += String.fromCharCode(b);
      return { status: r.status, type: r.headers.get("content-type"), disp: r.headers.get("content-disposition"), sha: r.headers.get("x-template-sha256"), b64: btoa(bin) };
    }, `${ROUTE}/template`);
    const a = await grab();
    const b = await grab();
    expect(a.status).toBe(200);
    expect(a.type).toContain("spreadsheetml");
    expect(a.disp).toContain("MAS_Nakit_Radar_Standart_Import_v2.xlsx");
    const sha = a.sha ?? "";
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sha).toBe(sha);
    const bodyA = Buffer.from(a.b64, "base64");
    expect(Buffer.compare(bodyA, Buffer.from(b.b64, "base64"))).toBe(0);
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(bodyA).digest("hex")).toBe(sha);
    // Geri okunur ve V2 şablonudur.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bodyA as unknown as ArrayBuffer);
    expect(wb.getWorksheet("_MAS_META")).toBeTruthy();
    evidence.push({ check: "download_template", status: 200, sha256: sha, bytes: bodyA.length });
    await s.context.close();
  });
});

test.describe("PHASE 4 — dosya güvenliği (hiçbiri yazmaz)", () => {
  const cases: Array<{ name: string; file: () => Promise<{ name: string; mimeType: string; buffer: Buffer }>; code: string }> = [
    { name: ".csv uzantısı", code: "BAD_EXTENSION", file: async () => ({ name: "odemeler.csv", mimeType: "text/csv", buffer: Buffer.from("a;b;c\n1;2;3\n") }) },
    { name: "bozuk .xlsx (ZIP değil)", code: "CORRUPT_XLSX", file: async () => ({ name: "bozuk.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("bu bir xlsx değil") }) },
    { name: "V2 olmayan çalışma kitabı", code: "NOT_V2_SCHEMA", file: async () => {
      const wb = new ExcelJS.Workbook(); wb.addWorksheet("01_ODEMELER").addRow(["Tutar"]);
      return { name: "legacy.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
    } },
  ];
  for (const c of cases) {
    test(`operator: ${c.name} → ${c.code}, DB değişmez`, async ({ browser }) => {
      test.setTimeout(120_000);
      const before = await counts();
      const s = await openAs(browser, "finance_operator");
      await s.page.goto(ROUTE, { waitUntil: "networkidle" });
      await s.page.getByTestId("v2-file").setInputFiles(await c.file());
      await s.page.getByRole("button", { name: "ÖNİZLE" }).click();
      const alert = s.page.getByTestId("v2-rejection");
      await expect(alert).toBeVisible({ timeout: 60_000 });
      await expect(alert).toContainText(c.code);
      const after = await counts();
      expect(after).toEqual(before);
      evidence.push({ check: "file_safety", case: c.name, code: c.code, dbUnchanged: true });
      await s.context.close();
    });
  }
});

test.describe("PHASE 4 — katman × sayfa yetkisi (canlı)", () => {
  test("operator: fixture önizlemede YETKİ DIŞI sayfalar listelenir; ONAYLA FORBIDDEN_SHEETS ile reddedilir; DB değişmez", async ({ browser }) => {
    test.setTimeout(240_000);
    const buf = await fixtureBuffer();
    const before = await counts();
    const s = await openAs(browser, "finance_operator");
    await s.page.goto(ROUTE, { waitUntil: "networkidle" });
    await s.page.getByTestId("v2-file").setInputFiles({
      name: "fixture-v2.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf,
    });
    await s.page.getByRole("button", { name: "ÖNİZLE" }).click();
    const warn = s.page.getByTestId("v2-forbidden-sheets");
    await expect(warn).toBeVisible({ timeout: 120_000 });
    await expect(warn).toContainText("10_URUNLER");
    await s.page.getByRole("button", { name: "ONAYLA VE İÇE AKTAR" }).click();
    const alert = s.page.getByTestId("v2-rejection");
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(alert).toContainText("FORBIDDEN_SHEETS");
    expect(await counts()).toEqual(before);
    evidence.push({ check: "rbac_sheets", role: "finance_operator", code: "FORBIDDEN_SHEETS", dbUnchanged: true });
    expect(s.serverErrors).toEqual([]);
    await s.context.close();
  });
});

test.describe("PHASE 4 — önizleme → onay → provenance", () => {
  test("finans yöneticisi: fixture ÖNİZLE yazmaz; ONAYLA tek işlemde yazar; ikinci ONAYLA mükerrer üretmez", async ({ browser }) => {
    test.setTimeout(300_000);
    const buf = await fixtureBuffer();
    const oracle = Object.values(FIXTURE_ORACLE.sheets);
    const rowsRead = oracle.reduce((n, x) => n + x.rowsRead, 0);
    const rejected = oracle.reduce((n, x) => n + x.rejected, 0);

    await resetImportState();
    const s = await openAs(browser, "finance_manager");
    await s.page.goto(ROUTE, { waitUntil: "networkidle" });
    const before = await counts();
    expect(before.externalKeys).toBe(0);

    // ── ÖNİZLE ──
    await s.page.getByTestId("v2-file").setInputFiles({
      name: "fixture-v2.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf,
    });
    await s.page.getByRole("button", { name: "ÖNİZLE" }).click();
    const confirmBtn = s.page.getByRole("button", { name: "ONAYLA VE İÇE AKTAR" });
    await expect(confirmBtn).toBeVisible({ timeout: 120_000 });
    const afterPreview = await counts();
    expect(afterPreview).toEqual(before); // önizleme HİÇBİR ŞEY yazmadı
    const previewText = await s.page.locator("text=REDDEDİLECEK").locator("..").innerText();
    expect(previewText).toContain(String(rejected));

    // ── ONAYLA ──
    await confirmBtn.click();
    const result = s.page.getByTestId("v2-import-result");
    await expect(result).toBeVisible({ timeout: 180_000 });
    const resultText = await result.innerText();
    const sha = (await s.page.getByTestId("v2-result-sha").innerText()).trim();
    expect(sha).toMatch(/^[0-9a-f]{64}$/);

    const after1 = await counts();
    expect(after1.workbooks).toBe(before.workbooks + 1);
    expect(after1.importRows).toBe(before.importRows + rowsRead);
    expect(after1.audits).toBe(before.audits + 1);
    expect(after1.payments).toBeGreaterThan(before.payments);

    // Provenance: DB'deki sha, ekrandaki sha; audit satırında actor + fileSha256.
    const wbRow = (await rows<{ id: string; file_sha256: string; imported_by: string | null }>(
      "select id, file_sha256, imported_by from public.source_workbooks where notes like 'Standart Import V2%' order by imported_at desc limit 1"))[0];
    expect(wbRow.file_sha256).toBe(sha);
    expect(wbRow.imported_by).not.toBeNull();
    expect(resultText).toContain(wbRow.id.slice(0, 8));
    const audit = (await rows<{ actor: string | null; entity_id: string; after_data: { fileSha256?: string; filename?: string } }>(
      "select actor, entity_id, after_data from public.audit_logs where action='import_v2_map' order by created_at desc limit 1"))[0];
    expect(audit.actor).toBe(wbRow.imported_by);
    expect(audit.entity_id).toBe(wbRow.id);
    expect(audit.after_data.fileSha256).toBe(sha);
    // Her domain kaydı kaynak satırına geri izlenir: mapped satırların hepsinin entity id'si var.
    const orphanMapped = Number(await scalar<string>(
      "select count(*) from public.import_rows where workbook_id=$1 and mapping_status='mapped' and mapped_entity_id is null", [wbRow.id]));
    expect(orphanMapped).toBe(0);

    // ── İKİNCİ ONAY (aynı dosya) — mükerrer yok ──
    await s.page.goto(ROUTE, { waitUntil: "networkidle" });
    await s.page.getByTestId("v2-file").setInputFiles({
      name: "fixture-v2.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: buf,
    });
    await s.page.getByRole("button", { name: "ÖNİZLE" }).click();
    await expect(s.page.getByRole("button", { name: "ONAYLA VE İÇE AKTAR" })).toBeVisible({ timeout: 120_000 });
    // İkinci önizleme: kodlu satırlar artık "GÜNCELLENECEK".
    const upd = await s.page.locator("text=GÜNCELLENECEK").locator("..").innerText();
    expect(upd).not.toContain("\n0");
    await s.page.getByRole("button", { name: "ONAYLA VE İÇE AKTAR" }).click();
    await expect(s.page.getByTestId("v2-import-result")).toBeVisible({ timeout: 180_000 });
    const after2 = await counts();
    expect(after2.workbooks).toBe(after1.workbooks + 1);      // hazırlık katmanı her import'u ayrı saklar
    expect(after2.importRows).toBe(after1.importRows + rowsRead);
    expect(after2.externalKeys).toBe(after1.externalKeys);   // defter BÜYÜMEDİ
    expect(after2.payments).toBe(after1.payments);           // domain'de mükerrer yok
    expect(after2.products).toBe(after1.products);

    evidence.push({
      check: "preview_confirm_provenance", sha256: sha, workbookId: wbRow.id,
      before, afterPreview, after1, after2, rowsRead, rejected,
      clientErrors: s.clientErrors, serverErrors: s.serverErrors,
    });
    expect(s.serverErrors).toEqual([]);
    await s.context.close();
  });
});
