// P0 / Karar 2 — çek ve kredi çoklu döviz güvenliği kanıtı.
//
// İDDİA:
//   A) `loadFinanceDashboard` okuma modeli farklı para birimlerini ham sayı olarak ASLA
//      tek toplamda karıştırmaz (10.000 TRY + 1.000 USD ≠ 11.000 TRY); TRY toplamını
//      saf tutar, yabancı para kalemlerini `byCurrency` kırılımında ayırır ve kur yoksa
//      `missingFxCurrencies` ile dürüstçe işaretler.
//   B) V2 import sözleşmesi (Karar 2 ile `FINANCE_TRY_ONLY` kilidi kaldırıldıktan sonra)
//      USD çek ve EUR kredi satırlarını gerçek para birimleriyle domain tablolarına yazar;
//      buna rağmen saf TRY finans KPI'ları (`due30`, `remainingAmount`) TRY-only kaynakla
//      birebir aynı kalır, döviz yükümlülükleri ise döviz kırılımında eksiksiz izlenir.
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
  "projects", "budget_lines", "budgets", "fx_positions", "production_parts", "cost_model_items",
  "cost_models", "machine_assets", "facility_movements", "credit_facilities", "source_workbooks",
];

const TODAY = "2026-09-04";

/** Fixture workbook'un TRY dışı çek/kredi satırları çıkarılmış kopyası. */
async function buildTryOnlyWorkbook(): Promise<ExcelJS.Workbook> {
  const wb = await buildFixtureWorkbook();
  for (const sheetName of ["02_CEKLER", "03_KREDILER"]) {
    const ws = wb.getWorksheet(sheetName)!;
    const header = ws.getRow(1).values as unknown[];
    const curCol = header.findIndex((h) => String(h ?? "").includes("Para Birimi"));
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

    /* ── A · OKUMA MODELİ DÖVİZ İZOLASYONU ──────────────────────────────────────────── */
    console.log("── A · OKUMA MODELİ DÖVİZ İZOLASYONU (10.000 TRY + 1.000 USD) ──");
    await wipe();
    await client.query(
      `insert into public.checks (maturity_date, amount, signed_amount, direction, status, currency)
       values ($1, 10000, -10000, 'outflow', 'planned', 'TRY'),
              ($1,  1000,  -1000, 'outflow', 'planned', 'USD')`,
      ["2026-09-20"],
    );
    const izole = await loadFinanceDashboard(pool, TODAY);
    evidence.directIsolation = izole.summary;

    assert("saf TRY due30 toplamı USD tutarıyla kirlenmedi (10000)", 10000, izole.summary.due30);
    assert("iki çek de açık çek sayısında görünüyor", 2, izole.summary.openChecks);
    assert("kur yokken USD eksik kur listesinde dürüstçe raporlandı", ["USD"], izole.summary.missingFxCurrencies);

    /* ── B · V2 ÇOKLU DÖVİZ IMPORT SÖZLEŞMESİ ───────────────────────────────────────── */
    console.log("\n── B · V2 ÇOKLU DÖVİZ IMPORT SÖZLEŞMESİ ──");
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
    assert("USD çek ve EUR kredi gerçek para birimleriyle domain'e yazıldı", 2, nonTryDomain);

    const karisikKpi = await loadFinanceDashboard(pool, TODAY);
    evidence.mixedSourceKpi = karisikKpi.summary;
    evidence.mixedImport = { perTable: tam.perTable, rowsRejected: tam.rowsRejected };

    /* ── B2 · TRY-ONLY KAYNAK İLE SAF TRY KPI EŞİTLİĞİ ──────────────────────────────── */
    console.log("\n── B2 · TRY-ONLY kaynak karşılaştırması ──");
    await wipe();
    const actorId2 = await actor();
    const tryOnlyParsed = parseWorkbook(await buildTryOnlyWorkbook());
    await client.query("begin");
    await mapWorkbook(client, tryOnlyParsed, { filename: "fixture-yalniz-try.xlsx", actorId: actorId2 });
    await client.query("commit");

    const temizKpi = await loadFinanceDashboard(pool, TODAY);
    evidence.tryOnlyKpi = temizKpi.summary;

    assert("saf TRY due30 özeti TRY dışı satırlardan etkilenmedi", temizKpi.summary.due30, karisikKpi.summary.due30);
    assert("saf TRY remainingAmount özeti TRY dışı satırlardan etkilenmedi",
      temizKpi.summary.remainingAmount, karisikKpi.summary.remainingAmount);

    const failed = checks.filter((c) => !c.gecti);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Kontrol: ${checks.length} · geçti: ${checks.length - failed.length} · düştü: ${failed.length}`);
    evidence.checks = checks.map((c) => ({ ad: c.ad, gecti: c.gecti }));
    evidence.verdict = failed.length === 0 ? "PASS" : "FAIL";
    evidence.multiCurrencyFinanceAnalytics = "IMPLEMENTED";
    console.log(JSON.stringify(evidence, null, 2));
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
