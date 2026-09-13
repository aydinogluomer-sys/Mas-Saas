// P0 — çek/kredi para birimi güvenliği kanıtı.
//
// İDDİA: V2.0 import sözleşmesi, TRY dışı çek ve kredi kayıtlarının finans toplamlarına
// karışmasını engeller; ama o kayıtları da sessizce ATMAZ.
//
// Bu script iddiayı iki adımda ölçer:
//
//   A) NEGATİF KONTROL — tehlike gerçek mi?
//      Importer'ı ATLAYARAK doğrudan veritabanına bir TRY ve bir USD çek yazılır. Mevcut
//      finans okuma modeli (`loadFinanceDashboard`) çağrılır. Bu model `sum(amount)` yapıyor
//      ve para birimi boyutu taşımıyor, dolayısıyla iki tutarı TEK bir sayıda toplar.
//      Ölçüm bunu gösterir: sorun varsayımsal değil.
//
//   B) SÖZLEŞME — V2 import bu tehlikeyi engelliyor mu?
//      Kanonik fixture (TRY + USD çek, TRY + EUR kredi) import edilir; sonra AYNI fixture'ın
//      TRY dışı satırları çıkarılmış hâli import edilir. İki koşunun finans KPI'ları BİREBİR
//      aynı olmalı — yani TRY dışı satırlar hiçbir toplama katkı vermemiş olmalı.
//
// B adımı A'sız yeterli olmazdı: KPI'ların eşit çıkması, kısıt işlediği için mi yoksa ortada
// hiç tehlike olmadığı için mi bilinemezdi.
import { Pool } from "pg";
import type ExcelJS from "exceljs";
import { buildFixtureWorkbook } from "../../src/lib/importers/v2/fixture";
import { parseWorkbook } from "../../src/lib/importers/v2/parser";
import { mapWorkbook } from "../../src/lib/importers/v2/mapper";
import { loadFinanceDashboard } from "../../src/lib/financing/engine";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

interface Check { ad: string; beklenen: unknown; gelen: unknown; gecti: boolean }
const checks: Check[] = [];
function assert(ad: string, beklenen: unknown, gelen: unknown): void {
  const gecti = JSON.stringify(beklenen) === JSON.stringify(gelen);
  checks.push({ ad, beklenen, gelen, gecti });
  console.log(`${gecti ? "GEÇTİ " : "DÜŞTÜ "} ${ad}` +
    (gecti ? "" : `\n         beklenen: ${JSON.stringify(beklenen)}\n         gelen   : ${JSON.stringify(gelen)}`));
}

const RESET = [
  "import_external_keys", "mapping_reviews", "import_rows", "source_cells", "source_sheets",
  "payments", "checks", "loan_installments", "loans", "cashflow_lines", "cashflow_months",
  "bank_transactions", "bank_accounts", "cash_accounts", "invoices", "orders", "products",
  "projects", "budget_lines", "budgets", "fx_positions", "production_parts", "machine_assets",
  "source_workbooks",
];

const TODAY = "2026-09-04";

/** Fixture workbook'un TRY dışı çek/kredi satırları çıkarılmış kopyası. */
async function buildTryOnlyWorkbook(): Promise<ExcelJS.Workbook> {
  const wb = await buildFixtureWorkbook();
  for (const sheetName of ["02_CEKLER", "03_KREDILER"]) {
    const ws = wb.getWorksheet(sheetName)!;
    const header = ws.getRow(1).values as unknown[];
    const curCol = header.findIndex((h) => String(h ?? "").includes("Para Birimi"));
    // Sondan başa: satır silmek sonraki satır numaralarını kaydırır.
    for (let r = ws.rowCount; r >= 2; r--) {
      const v = ws.getRow(r).getCell(curCol).value;
      if (typeof v === "string" && v !== "" && v !== "TRY") ws.spliceRows(r, 1);
    }
  }
  return wb;
}

async function main(): Promise<void> {
  const url = requireDisposableOwnerDatabaseUrl("V2 para birimi güvenliği");
  const pool = new Pool({ connectionString: url });
  const client = await pool.connect();
  const evidence: Record<string, unknown> = {};

  try {
    const db = (await client.query<{ d: string }>("select current_database() as d")).rows[0].d;
    console.log(`Hedef (harcanabilir): ${db}\n`);
    evidence.database = db;

    const wipe = async (): Promise<void> => {
      await client.query(`truncate ${RESET.map((t) => `public.${t}`).join(", ")} cascade`);
      await client.query("truncate public.parties, public.categories cascade");
    };

    const actor = async (): Promise<string> => (await client.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role)
       values ('v2-currency-fixture', 'DISABLED-NOT-A-CREDENTIAL', 'V2 para birimi fixture', 'admin')
       on conflict (username) do update set display_name = excluded.display_name
       returning id`)).rows[0].id;

    /* ── A · NEGATİF KONTROL: mevcut okuma modeli para birimi ayırmıyor ──────────────── */
    console.log("── A · NEGATİF KONTROL (importer atlanarak doğrudan yazma) ──");
    await wipe();
    await client.query(
      `insert into public.checks (maturity_date, amount, signed_amount, direction, status, currency)
       values ($1, 10000, -10000, 'outflow', 'planned', 'TRY'),
              ($1,  1000,  -1000, 'outflow', 'planned', 'USD')`,
      ["2026-09-20"],
    );
    const kirli = await loadFinanceDashboard(pool, TODAY);
    console.log(`   due30 = ${kirli.summary.due30}  (10.000 TRY + 1.000 USD)`);
    evidence.negativeControl = { due30: kirli.summary.due30, openChecks: kirli.summary.openChecks };

    // 11000 çıkması, iki FARKLI para biriminin tek sayı gibi toplandığının kanıtı.
    assert("okuma modeli iki para birimini TEK sayıda topluyor (tehlike gerçek)", 11000, kirli.summary.due30);
    assert("iki çek de akışta görünüyor", 2, kirli.summary.openChecks);

    /* ── B · SÖZLEŞME: V2 import TRY dışını domain'e sokmuyor ────────────────────────── */
    console.log("\n── B · V2 IMPORT SÖZLEŞMESİ ──");
    await wipe();
    const actorId = await actor();

    const tamParsed = parseWorkbook(await buildFixtureWorkbook());
    await client.query("begin");
    const tam = await mapWorkbook(client, tamParsed, {
      filename: "fixture-karisik-para.xlsx", actorId,
    });
    await client.query("commit");

    const nonTryDomain = Number((await client.query<{ c: string }>(
      "select count(*) c from public.checks where currency <> 'TRY'")).rows[0].c)
      + Number((await client.query<{ c: string }>(
        "select count(*) c from public.loans where currency <> 'TRY'")).rows[0].c);
    assert("TRY dışı çek/kredi domain'e HİÇ yazılmadı", 0, nonTryDomain);

    // Ama kaybolmadılar: ham hâlleriyle hazırlık katmanında duruyorlar.
    const staged = await client.query<{ row_json: Record<string, unknown> }>(
      `select row_json from public.import_rows
        where row_json->>'para_birimi' is not null and row_json->>'para_birimi' <> 'TRY'
          and detected_entity_type in ('checks','loans')`);
    assert("TRY dışı satırlar kaynakta KORUNDU", 2, staged.rowCount);

    const reviews = await client.query<{ severity: string; message: string }>(
      `select severity, message from public.mapping_reviews
        where issue_type = 'unsupported_currency_for_finance_aggregation'`);
    assert("TRY dışı her satır için inceleme açıldı", 2, reviews.rowCount);
    assert("incelemeler yüksek şiddetli", ["high", "high"], reviews.rows.map((r) => r.severity).sort());
    assert("inceleme mesajı sebebi söylüyor", true,
      reviews.rows.every((r) => r.message.includes("KORUNMUŞTUR") && r.message.includes("TRY")));

    const karisikKpi = await loadFinanceDashboard(pool, TODAY);
    evidence.mixedSourceKpi = karisikKpi.summary;
    evidence.mixedImport = { perTable: tam.perTable, rowsRejected: tam.rowsRejected };

    /* ── B2 · TRY-ONLY kaynak ile birebir aynı sonuç ─────────────────────────────────── */
    console.log("\n── B2 · TRY-ONLY kaynak karşılaştırması ──");
    await wipe();
    const actorId2 = await actor();
    const tryOnlyParsed = parseWorkbook(await buildTryOnlyWorkbook());
    await client.query("begin");
    await mapWorkbook(client, tryOnlyParsed, { filename: "fixture-yalniz-try.xlsx", actorId: actorId2 });
    await client.query("commit");

    const temizKpi = await loadFinanceDashboard(pool, TODAY);
    evidence.tryOnlyKpi = temizKpi.summary;

    console.log(`   karışık kaynak : ${JSON.stringify(karisikKpi.summary)}`);
    console.log(`   TRY-only kaynak: ${JSON.stringify(temizKpi.summary)}`);

    // ASIL İDDİA. TRY dışı satırlar dosyada olsa da olmasa da finans KPI'ları AYNI.
    assert("finans özeti TRY dışı satırlardan etkilenmedi", temizKpi.summary, karisikKpi.summary);
    assert("aylık kırılım da etkilenmedi",
      JSON.stringify(temizKpi.months), JSON.stringify(karisikKpi.months));

    /* ── Özet ────────────────────────────────────────────────────────────────────────── */
    const failed = checks.filter((c) => !c.gecti);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Kontrol: ${checks.length} · geçti: ${checks.length - failed.length} · düştü: ${failed.length}`);
    evidence.checks = checks.map((c) => ({ ad: c.ad, gecti: c.gecti }));
    evidence.verdict = failed.length === 0 ? "PASS" : "FAIL";
    evidence.multiCurrencyFinanceAnalytics = "NOT_IMPLEMENTED";
    console.log(JSON.stringify(evidence, null, 2));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
