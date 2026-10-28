// Standart Import V2 — uçtan uca import kanıtı (§40, §41, §42).
//
// NE KANITLAR:
//   1. Fixture workbook gerçek bir veritabanına yazılır ve sayımlar oracle ile tutar.
//   2. AYNI dosya ikinci kez yüklendiğinde MÜKERRER OLUŞMAZ — kayıtlar güncellenir (§27).
//   3. Reddedilmiş satırlar domain'e HİÇ yazılmaz ama hazırlık katmanında ham hâliyle DURUR.
//   4. Yazılan her domain kaydı kaynak satırına geri izlenebilir (§26).
//   5. Eşleyicisi olmayan aileler sessizce kaybolmaz; adıyla raporlanır.
//
// GÜVENLİK: yalnız harcanabilir bir veritabanına karşı çalışır. Hedef adı `verify`, `test`,
// `clone` gibi bir işaret taşımıyorsa ya da korunan listedeyse hiç bağlanmadan durur.
import { Pool, type QueryResultRow } from "pg";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "../../src/lib/importers/v2/fixture";
import { parseWorkbook } from "../../src/lib/importers/v2/parser";
import { mapWorkbook, FAMILY_WRITERS } from "../../src/lib/importers/v2/mapper";
import { requireDisposableOwnerDatabaseUrl } from "../db/owner-url";

interface Check { ad: string; beklenen: unknown; gelen: unknown; gecti: boolean }
const checks: Check[] = [];

function assert(ad: string, beklenen: unknown, gelen: unknown): void {
  const gecti = JSON.stringify(beklenen) === JSON.stringify(gelen);
  checks.push({ ad, beklenen, gelen, gecti });
  console.log(`${gecti ? "GEÇTİ " : "DÜŞTÜ "} ${ad}${gecti ? "" : `\n         beklenen: ${JSON.stringify(beklenen)}\n         gelen   : ${JSON.stringify(gelen)}`}`);
}

const TABLES_TO_RESET = [
  "import_external_keys", "mapping_reviews", "import_rows", "source_cells", "source_sheets",
  "payments", "checks", "loan_installments", "loans",
  "cashflow_lines", "cashflow_months",
  "bank_transactions", "bank_accounts", "cash_accounts",
  "invoices", "orders", "products", "projects",
  "budget_lines", "budgets", "fx_positions", "production_parts", "machine_assets",
  "source_workbooks",
];

/** Sözleşmedeki 16 sayfanın hedef tabloları — yazıcısı olanların hepsi burada sayılır. */
const DOMAIN_TABLES = [
  "payments", "checks", "loans", "loan_installments", "cashflow_lines",
  "bank_accounts", "bank_transactions", "invoices", "orders", "products",
  "projects", "budget_lines", "fx_positions", "production_parts", "machine_assets",
];

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("V2 import E2E") });
  const client = await pool.connect();

  try {
    const db = (await client.query<{ d: string }>("select current_database() as d")).rows[0].d;
    console.log(`Hedef (harcanabilir): ${db}\n`);

    // Temiz başlangıç. `cascade` yalnız harcanabilir hedefte kabul edilebilir bir araçtır.
    await client.query(`truncate ${TABLES_TO_RESET.map((t) => `public.${t}`).join(", ")} cascade`);
    await client.query("truncate public.parties, public.categories cascade");

    // Aktör. Bu bir KİMLİK BİLGİSİ DEĞİL: password_hash kasten geçersiz bir işaret; bu
    // kullanıcıyla giriş yapılamaz, yalnız audit ve imported_by alanları dolsun diye var.
    const actor = (await client.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role)
       values ('v2-e2e-fixture', 'DISABLED-NOT-A-CREDENTIAL', 'V2 E2E fixture aktörü', 'admin')
       on conflict (username) do update set display_name = excluded.display_name
       returning id`,
    )).rows[0].id;

    const wb = await buildFixtureWorkbook();
    const parsed = parseWorkbook(wb);

    /* ── 1. geçiş ─────────────────────────────────────────────────────────────────────── */
    console.log("── 1. IMPORT ──");
    await client.query("begin");
    const first = await mapWorkbook(client, parsed, {
      filename: "fixture-v2.xlsx", fileSha256: null, actorId: actor,
    });
    await client.query("commit");

    assert("hazırlığa yazılan satır = oracle rowsRead", FIXTURE_ORACLE.totals.rowsRead, first.rowsStaged);
    assert("reddedilen satır = oracle rejected", FIXTURE_ORACLE.totals.rejected, first.rowsRejected);
    assert("incelemeye düşen satır = oracle needsReview", FIXTURE_ORACLE.totals.needsReview, first.rowsNeedsReview);

    const staged = Number((await client.query<{ c: string }>("select count(*) c from public.import_rows")).rows[0].c);
    assert("import_rows satır sayısı = hazırlığa yazılan", first.rowsStaged, staged);

    const emptyRaw = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_rows where row_json = '{}'::jsonb",
    )).rows[0].c);
    assert("HİÇBİR satır boş ham veriyle yazılmadı", 0, emptyRaw);

    const rejectedStaged = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_rows where mapping_status = 'rejected'",
    )).rows[0].c);
    assert("reddedilen satırlar hazırlıkta DURUYOR", FIXTURE_ORACLE.totals.rejected, rejectedStaged);

    const rejectedMapped = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_rows where mapping_status = 'rejected' and mapped_entity_id is not null",
    )).rows[0].c);
    assert("reddedilen hiçbir satır domain'e yazılmadı", 0, rejectedMapped);

    const counts = async (): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};
      for (const t of DOMAIN_TABLES) {
        out[t] = Number((await client.query<{ c: string }>(`select count(*) c from public.${t}`)).rows[0].c);
      }
      return out;
    };
    const after1 = await counts();
    console.log("   domain: " + DOMAIN_TABLES.map((t) => `${t}=${after1[t]}`).join(" "));
    console.log(`   perTable: ${JSON.stringify(first.perTable)}`);
    console.log(`   yalnız hazırlıkta kalan aileler: ${first.stagedOnlyFamilies.join(", ") || "(yok)"}`);
    console.log(`   yalnız hazırlıkta kalan satır: ${first.rowsStagedOnly}`);

    assert("yazıcısı olan aile sayısı", Object.keys(FAMILY_WRITERS).length, Object.keys(first.perTable).length);

    // Yazılan kayıt sayısı, o sayfanın "hazır" satır sayısına EŞİT olmalı. Az olsaydı sessiz
    // veri kaybı, çok olsaydı uydurma kayıt demekti. Yazıcısı olan HER aile için ölçülür.
    const READY = FIXTURE_ORACLE.sheets as Record<string, { ready: number }>;
    const SHEET_OF_TABLE: Record<string, string> = {
      payments: "01_ODEMELER", checks: "02_CEKLER", loans: "03_KREDILER",
      loan_installments: "04_KREDI_TAKSITLERI", cashflow_lines: "05_NAKIT_AKISI",
      bank_accounts: "06_BANKA_HESAPLARI", bank_transactions: "07_BANKA_HAREKETLERI",
      invoices: "08_FATURALAR", orders: "09_SIPARISLER", products: "10_URUNLER",
      projects: "11_PROJELER", budget_lines: "12_BUTCE", fx_positions: "13_FX_POZISYONU",
      production_parts: "14_KAPASITE", machine_assets: "16_MAKINE_ROI",
    };
    for (const [table, sheet] of Object.entries(SHEET_OF_TABLE)) {
      assert(`${table} = ${sheet} hazır satır sayısı`, READY[sheet].ready, after1[table]);
    }

    const keyCount1 = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_external_keys",
    )).rows[0].c);

    // §26 — her domain kaydı kaynak satırına bağlı.
    for (const t of ["payments", "checks"]) {
      const orphan = Number((await client.query<{ c: string }>(
        `select count(*) c from public.${t} where source_row_id is null`,
      )).rows[0].c);
      assert(`${t}: kaynak satırı olmayan kayıt yok (§26)`, 0, orphan);
    }
    const loanOrphan = Number((await client.query<{ c: string }>(
      "select count(*) c from public.loans where source_sheet_id is null",
    )).rows[0].c);
    assert("loans: kaynak sayfası olmayan kayıt yok (§26)", 0, loanOrphan);

    /* ── DEĞER DÜZEYİ KONTROLLER ──────────────────────────────────────────────────────
     *
     * Sayım kontrolleri "kaç kayıt" sorusuna cevap verir, "DOĞRU DEĞER Mİ" sorusuna değil.
     * İki numeric kolonun yer değiştirmesi tip denetiminden de sayımdan da geçer ve sessizce
     * yanlış finansal veri üretir. Aşağıdakiler o boşluğu kapatır.
     */
    console.log("");
    console.log("── DEĞER KONTROLLERİ ──");
    const one = async <T extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> =>
      (await client.query<T>(sql, params)).rows[0];

    // Banka hareketi: yön İŞARETE dönüşmeli. `bank_transactions.direction` ÜRETİLMİŞ bir
    // kolon ve değerini tutarın işaretinden alıyor; şablon ise işaretsiz tutar + ayrı yön
    // veriyor. Uzlaştırılmasaydı her ÖDEME, veritabanınca TAHSİLAT sayılacaktı.
    const kira = await one<{ amount: string; direction: string }>(
      "select amount, direction from public.bank_transactions where description = $1", ["Kira ödemesi"]);
    assert("çıkış hareketi eksi işaretle yazıldı", -35000, Number(kira.amount));
    assert("çıkış hareketinin yönü 'outflow' hesaplandı", "outflow", kira.direction);

    const tahsilat = await one<{ amount: string; direction: string }>(
      "select amount, direction from public.bank_transactions where description = $1", ["Müşteri tahsilatı"]);
    assert("giriş hareketi artı işaretle yazıldı", 500000, Number(tahsilat.amount));
    assert("giriş hareketinin yönü 'inflow' hesaplandı", "inflow", tahsilat.direction);

    // Çek: işaret korunur, mutlak değer türetilir, para birimi (0090) saklanır.
    const cek = await one<{ signed_amount: string; amount: string; direction: string; currency: string }>(
      "select signed_amount, amount, direction, currency from public.checks order by maturity_date limit 1");
    assert("çekin işareti korundu", true, Number(cek.signed_amount) < 0);
    assert("çekin mutlak tutarı işaretliyle tutarlı", Math.abs(Number(cek.signed_amount)), Number(cek.amount));
    assert("çekin yönü işaretten türetildi", "outflow", cek.direction);
    assert("çekin para birimi saklandı (0090)", "TRY", cek.currency);

    // BOŞ ≠ SIFIR, domain tarafında.
    const bilinmeyen = await one<{ default_amount: string | null; amount_confidence: string }>(
      "select default_amount, amount_confidence from public.payments where name = $1", ["MAS ELEKTRİK"]);
    assert("tutarı bilinmeyen ödeme NULL kaldı", null, bilinmeyen.default_amount);
    assert("tutarı bilinmeyen ödeme 'unknown' işaretlendi", "unknown", bilinmeyen.amount_confidence);

    const gercekSifir = await one<{ default_amount: string | null; amount_confidence: string }>(
      "select default_amount, amount_confidence from public.payments where name = $1",
      ["Bedelsiz servis sözleşmesi"]);
    assert("gerçekten sıfır olan ödeme NULL DEĞİL", true, gercekSifir.default_amount !== null);
    assert("gerçekten sıfır olan ödeme 0 yazıldı", 0, Number(gercekSifir.default_amount));
    assert("gerçek sıfır 'known' işaretlendi", "known", gercekSifir.amount_confidence);

    const sifir = await one<{ amount: string; amount_status: string }>(
      "select amount, amount_status from public.cashflow_lines where label = $1", ["Sıfır etkili düzeltme"]);
    assert("nakit akışı sıfır satırı NULL DEĞİL", true, sifir.amount !== null);
    assert("nakit akışı sıfır satırı 0 olarak yazıldı", 0, Number(sifir.amount));
    assert("nakit akışı sıfır satırı 'known' işaretlendi", "known", sifir.amount_status);

    const parca = await one<{ torna_minutes: string | null; freze_minutes: string | null }>(
      "select torna_minutes, freze_minutes from public.production_parts where part_code = $1", ["MT-200"]);
    // Ölçek (numeric(_,4)) iddiaya karışmasın: değer sayısal, BOŞ/DOLU ayrımı ayrıca.
    assert("yazılmış 0 dakika NULL DEĞİL", true, parca.freze_minutes !== null);
    assert("yazılmış 0 dakika 0 olarak saklandı", 0, Number(parca.freze_minutes));
    assert("ölçülmüş süre korundu", 12, Number(parca.torna_minutes));

    // Ölçülmemiş süre NULL kalmalı — "0 dakika" yazmak, o operasyonun yapılmadığını
    // söylemek olurdu. Bu satır incelemeye düştüğü için domain'e hiç yazılmadı; ölçüm
    // yerine YOKLUĞU doğrulanıyor.
    const olculmemis = Number((await client.query<{ c: string }>(
      "select count(*) c from public.production_parts where part_code = $1", ["MT-300"])).rows[0].c);
    assert("incelemedeki parça domain'e yazılmadı", 0, olculmemis);

    // Fatura: eksik olan bileşen diğer ikisinden ÇIKARILDI (aritmetik, tahmin değil).
    const fatura = await one<{ net_amount: string; tax_amount: string; gross_amount: string }>(
      "select net_amount, tax_amount, gross_amount from public.invoices where invoice_no = $1", ["A-1001"]);
    assert("fatura üçlüsü tutarlı", Number(fatura.gross_amount),
      Number(fatura.net_amount) + Number(fatura.tax_amount));

    // Kredi: para birimi (0090) ve anapara.
    const kredi = await one<{ currency: string; principal: string }>(
      "select currency, principal from public.loans limit 1");
    assert("kredinin para birimi saklandı (0090)", "TRY", kredi.currency);
    assert("kredi anaparası korundu", true, Number(kredi.principal) > 0);

    // Bütçe: senaryo BAŞLIK olarak ayrıldı, satıra yazılmadı.
    const butce = await one<{ name: string; fiscal_year: number }>(
      "select name, fiscal_year from public.budgets limit 1");
    assert("senaryo bütçe başlığı oldu", "base_case", butce.name);
    assert("mali yıl dönemden okundu", 2026, Number(butce.fiscal_year));

    /* ── 2. geçiş — AYNI dosya ────────────────────────────────────────────────────────── */
    console.log("\n── 2. IMPORT (aynı dosya) ──");
    await client.query("begin");
    const second = await mapWorkbook(client, parsed, {
      filename: "fixture-v2.xlsx", fileSha256: null, actorId: actor,
    });
    await client.query("commit");

    const after2 = await counts();
    console.log("   domain: " + DOMAIN_TABLES.map((t) => `${t}=${after2[t]}`).join(" "));
    console.log(`   perTable: ${JSON.stringify(second.perTable)}`);

    for (const t of DOMAIN_TABLES) {
      assert(`İKİNCİ IMPORT MÜKERRER ÜRETMEDİ (${t})`, after1[t], after2[t]);
    }

    const insertedAgain = Object.values(second.perTable).reduce((n, t) => n + t.inserted, 0);
    const updatedAgain = Object.values(second.perTable).reduce((n, t) => n + t.updated, 0);
    assert("ikinci geçişte hiçbir kayıt YARATILMADI", 0, insertedAgain);
    console.log(`   güncellenen kayıt: ${updatedAgain}`);
    if (updatedAgain === 0) {
      checks.push({ ad: "ikinci geçişte kayıtlar güncellendi", beklenen: ">0", gelen: 0, gecti: false });
      console.log("DÜŞTÜ  ikinci geçişte hiçbir kayıt güncellenmedi — defter çalışmıyor olabilir");
    }

    // Hazırlık katmanı BİRİKİR: ikinci dosya ikinci bir iz kaydıdır, bu doğru davranıştır.
    const staged2 = Number((await client.query<{ c: string }>("select count(*) c from public.import_rows")).rows[0].c);
    assert("hazırlık katmanı her import'u ayrı saklar", first.rowsStaged * 2, staged2);

    const keyCount2 = Number((await client.query<{ c: string }>(
      "select count(*) c from public.import_external_keys",
    )).rows[0].c);
    console.log(`   external_id defteri: 1. geçiş ${keyCount1} → 2. geçiş ${keyCount2}`);
    assert("defter ikinci import'ta BÜYÜMEDİ", keyCount1, keyCount2);

    /* ── Özet ─────────────────────────────────────────────────────────────────────────── */
    const failed = checks.filter((c) => !c.gecti);
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Kontrol: ${checks.length} · geçti: ${checks.length - failed.length} · düştü: ${failed.length}`);
    console.log(JSON.stringify({
      db, firstPass: first, secondPass: second,
      domainAfterFirst: after1, domainAfterSecond: after2,
      externalKeys: { afterFirst: keyCount1, afterSecond: keyCount2 },
      checks: checks.map((c) => ({ ad: c.ad, gecti: c.gecti })),
    }, null, 2));

    if (failed.length > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
