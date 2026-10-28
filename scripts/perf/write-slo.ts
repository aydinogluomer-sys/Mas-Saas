// AŞAMA 10 — yazma / import SLO (rehber §15 "Eksik 4").
//
// ═══ HANGİ BOŞLUĞU KAPATIYOR ═══
//
// `perf:gate` OKUMA yolunu kapılıyor: seçici sorguların planı, indeks hijyeni, felaket tavanı.
// Faz 14'ün kendi "Sınır — dürüstçe" bölümü bunu zaten yazıyor: "Yazma yolu SLO'su (bulk
// import/insert gecikmesi) bu kapının konusu değil." Bu dosya o cümlenin karşılığıdır ve
// planın istediği üç şeyi büyütülmüş sentetik fixture üzerinde ölçer:
//
//   bulk import          → gerçek `importBankStatement()`, 500 satırlık deterministik ekstre
//   background job       → gerçek `generateInstancesForMonth()` (soğuk) + `ensureWindow()` (kararlı hâl)
//   representative write  → gerçek `markInstancePaid()` — tek satır, kilitli, denetim kaydıyla
//
// ═══ NEDEN getPool(), OWNER HAVUZU DEĞİL ═══
//
// Owner bağlantısı RLS'i atlar ve `src/lib/db.ts`'in rol anahtarlamasını hiç çalıştırmaz —
// yani üretimde olmayan bir yolu ölçerdi. Burada uygulamanın KENDİ havuzu kullanılır:
// `runAsSystem()` ile finance_manager kimliğine girilir, her checkout `set role` ile
// anahtarlanır ve sorgular `countingClient` üzerinden sayılır. Ölçülen şey gerçek yol.
//
// ═══ FIXTURE DETERMİNİZMİ ═══
//
// `volume.ts` gibi: `random()` yok, saat okuması yok. Ekstre satırları tamamen aritmetik
// (sabit bir taban tarih + satır indeksi), o yüzden iki koşu bayt-bayt aynı dosyayı üretir.
// Her ölçümden önce bir önceki koşunun yazdıkları TEMİZLENİR; aksi hâlde ikinci koşu 500
// "duplicate" görür ve tamamen başka bir iş ölçülmüş olur.
//
// ═══ EŞİK POLİTİKASI ═══
//
// route-slo.ts ile aynı ayrım: doğruluk (kaç satır yazıldı, kaç sorgu atıldı) SERT kapı;
// wall-clock TREND uyarısıdır. Ölçüm makinesi 4 çekirdekli bir dizüstü ve ölçüm sırasında
// canlı bir production örneği koşuyor — bu sayıyı CI'da sert kapı yapmak yanlış olur.
//
// Kullanım:
//   MIGRATION_DATABASE_URL=postgres://…@127.0.0.1:5432/mas_radar_perf_verify pnpm perf:write-slo

import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { readEnvLocal, swapDatabase } from "../db/app-url";
import { databaseNameFromUrl, requireDisposableOwnerDatabaseUrl } from "../db/owner-url";
import { ensureSystemActor } from "../db/seed-system-actor";
import { generateVolume } from "./volume";

/* ── ayarlar ─────────────────────────────────────────────────────────────────────────── */

const STATEMENT_ROWS = Number(process.env.WRITE_SLO_STATEMENT_ROWS ?? 500);
const HEAVY_SAMPLES = Math.max(3, Number(process.env.WRITE_SLO_HEAVY_SAMPLES ?? 3));
const LIGHT_SAMPLES = Math.max(5, Number(process.env.WRITE_SLO_LIGHT_SAMPLES ?? 9));
const STATEMENT_FILENAME = "stage10-write-slo-statement.csv";
/** Ekstre satırlarının tabanı — SABİT. Saat okumak fixture'ı deterministik olmaktan çıkarır. */
const STATEMENT_BASE_DATE = "2024-01-01";

/** SERT felaket tavanları. Yavaşlık değil, KIRIKLIK yakalar. */
const CATASTROPHE = {
  bulkImportMs: Number(process.env.WRITE_SLO_IMPORT_CATASTROPHE_MS ?? 120_000),
  backgroundJobMs: Number(process.env.WRITE_SLO_JOB_CATASTROPHE_MS ?? 120_000),
  singleWriteMs: Number(process.env.WRITE_SLO_WRITE_CATASTROPHE_MS ?? 5_000),
};
/** TREND bütçeleri — aşılırsa uyarı, exit kodu değişmez. */
const BUDGET = {
  importRowsPerSec: Number(process.env.WRITE_SLO_IMPORT_ROWS_PER_SEC ?? 40),
  backgroundJobMs: Number(process.env.WRITE_SLO_JOB_BUDGET_MS ?? 30_000),
  singleWriteMs: Number(process.env.WRITE_SLO_WRITE_BUDGET_MS ?? 400),
};
/**
 * SERT: tek satırlık "ödendi işaretle" yazımının atabileceği en fazla sorgu.
 *
 * Deterministik ve makineden bağımsız: begin + select…for update + update + denetim yazımı +
 * commit. Bir gün bu yola döngü içinde bir sorgu girerse sayı tavanı kırar — route-slo'daki
 * N+1 cırcırının yazma tarafındaki karşılığı.
 */
const MAX_QUERIES_SINGLE_WRITE = Number(process.env.WRITE_SLO_MAX_WRITE_QUERIES ?? 12);

const JSON_OUT = path.join("test-results", "write-slo.json");

/* ── kayıt defteri ───────────────────────────────────────────────────────────────────── */

interface Check { name: string; pass: boolean; expected: string; actual: string; hard: boolean }
const checks: Check[] = [];
const warnings: string[] = [];

function record(name: string, pass: boolean, expected: string, actual: string): boolean {
  checks.push({ name, pass, expected, actual, hard: true });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — beklenen: ${expected} · gerçek: ${actual}`);
  return pass;
}
function trend(name: string, within: boolean, budget: string, actual: string): void {
  checks.push({ name, pass: within, expected: budget, actual, hard: false });
  if (!within) warnings.push(`${name}: ${actual} (bütçe ${budget})`);
  console.log(`${within ? "OK  " : "WARN"}  [trend] ${name} — bütçe: ${budget} · gerçek: ${actual}`);
}
function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 74 - label.length))}`);
}
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const r1 = (n: number): number => Number(n.toFixed(1));

/* ── deterministik ekstre üreteci ────────────────────────────────────────────────────── */

/**
 * Sabit tabana i gün ekler ve TÜRK bankası biçiminde (GG.AA.YYYY) döndürür.
 *
 * `Date` yalnız aritmetik için; HİÇBİR yerde `now()` okunmaz, fixture deterministik kalır.
 *
 * NEDEN ISO DEĞİL — ÖLÇEREK BULUNDU. İlk sürüm `2024-01-13` gibi ISO tarihler yazıyordu ve
 * 500 satırın yalnız 203'ü içeri girdi; kalanı "tarih okunamadı" ile ATLANDI. Nedeni şu
 * zincir: `xlsx` CSV okurken ISO tarihi bir seri numarasına çevirir ve biçimlenmiş metnini
 * ABD düzeninde ("1/13/24") üretir; `parseStatementDate` ise `w` metnini önce okur ve
 * `G/A/YY` olarak yorumlar, yani ay 13 çıkar ve satır reddedilir. Gün ≤ 12 olan satırlar
 * kurtulur — ilk 11 satırın geçip 13'ten sonrasının düşmesinin sebebi tam olarak buydu.
 *
 * GG.AA.YYYY hem gerçek Türk banka ekstrelerinin biçimi hem de bu zincirden sağ çıkan biçim:
 * gün > 12 satırlar metin olarak kalır ve birebir okunur, gün ≤ 12 satırlar seriye çevrilse
 * bile geri okunduğunda aynı güne döner. Ölçüldü: 20/20 satır, 0 atlanan.
 */
function trDatePlusDays(baseIso: string, days: number): string {
  const [y, m, d] = baseIso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(t.getUTCDate())}.${pad(t.getUTCMonth() + 1)}.${t.getUTCFullYear()}`;
}

/**
 * `STATEMENT_ROWS` satırlık, tamamen aritmetik bir banka ekstresi.
 *
 * Türkçe başlıklar bilerek: `detectStatementColumns` gerçek hayatta gördüğü eş anlamlıları
 * tanımak zorunda, ve bu ölçüm o yolu da koşturur. Ayraç ';' — Türkçe ekstrelerin standardı
 * ve ondalık ayracının ',' olmasıyla çakışmaz.
 */
function buildStatementCsv(rows: number): Buffer {
  const lines = ["Tarih;Açıklama;Karşı Taraf;Tutar"];
  for (let i = 1; i <= rows; i += 1) {
    const date = trDatePlusDays(STATEMENT_BASE_DATE, i % 720);
    const magnitude = ((i * 37) % 5000) + 50;
    const amount = (i % 3 === 0 ? magnitude : -magnitude).toFixed(2);
    lines.push(`${date};STAGE10-IMPORT-${i};PERF Karşı Taraf ${1 + (i % 400)};${amount}`);
  }
  return Buffer.from(lines.join("\r\n"), "utf8");
}

/* ── ana akış ────────────────────────────────────────────────────────────────────────── */

interface OpSample { ms: number; queryCount: number; totalDbTimeMs: number; slowestQueryShape: string | null }
interface OpResult {
  name: string;
  unit: string;
  samples: OpSample[];
  medianMs: number;
  maxMs: number;
  queryCount: number;
  slowestQueryShape: string | null;
  extra: Record<string, unknown>;
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  console.log("=== perf:write-slo — yazma / import SLO (AŞAMA 10) ===\n");

  const ownerUrl = requireDisposableOwnerDatabaseUrl("perf:write-slo");
  const dbName = databaseNameFromUrl(ownerUrl) ?? "(okunamadı)";

  // Uygulamanın kendi havuzu HARCANABİLİR hedefe bağlansın. CI'da bağlantı açıkça verilir
  // (`.env.local` orada yoktur); yerelde canlı runtime kimliğinden YALNIZ veritabanı adı
  // değiştirilerek türetilir. `pnpm db:app-role:password` ASLA çağrılmaz — o komut rolü
  // cluster genelinde değiştirip çalışan production örneğini düşürür. Dize yazdırılmaz.
  process.env.DATABASE_URL = process.env.MAS_APP_DATABASE_URL
    ?? swapDatabase(readEnvLocal().DATABASE_URL ?? "", dbName);
  process.env.MIGRATION_DATABASE_URL = ownerUrl;
  delete process.env.MAS_QA_BYPASS_AUTH;

  const machine = {
    cpu: os.cpus()[0]?.model ?? "bilinmiyor",
    cores: os.cpus().length,
    totalMemGb: r1(os.totalmem() / 1024 ** 3),
    freeMemGbAtStart: r1(os.freemem() / 1024 ** 3),
  };
  console.log(`Makine: ${machine.cpu} · ${machine.cores} çekirdek · RAM ${machine.totalMemGb} GB ` +
    `(boş: ${machine.freeMemGbAtStart} GB)`);
  console.log(`Hedef veritabanı: ${dbName} (HARCANABİLİR)\n`);

  // env doğrulaması modül yüklenirken koştuğu için import'lar DATABASE_URL kurulduktan SONRA.
  const { getPool, runAsSystem } = await import("../../src/lib/db");
  const { measureRequestQueries } = await import("../../src/lib/perf/request-metrics");
  const { importBankStatement } = await import("../../src/lib/bank/engine");
  const { ensureWindow, generateInstancesForMonth, markInstancePaid, markInstanceUnpaid } =
    await import("../../src/lib/radar/engine");
  const { istanbulDateISO } = await import("../../src/lib/reports/rules");

  const owner = new Pool({ connectionString: ownerUrl, max: 4 });
  const pool = getPool();
  const results: OpResult[] = [];

  /** Bir işlemi ölç: duvar saati + o kapsamda atılan sorgular. */
  async function measure(fn: () => Promise<unknown>): Promise<OpSample> {
    const t0 = process.hrtime.bigint();
    const { metrics } = await measureRequestQueries(async () => { await fn(); });
    return {
      ms: Number(process.hrtime.bigint() - t0) / 1e6,
      queryCount: metrics.queryCount,
      totalDbTimeMs: metrics.totalDbTimeMs,
      slowestQueryShape: metrics.slowestQueryShape,
    };
  }
  function summarise(name: string, unit: string, samples: OpSample[], extra: Record<string, unknown>): OpResult {
    const counts = new Set(samples.map((s) => s.queryCount));
    const worst = samples.reduce((a, b) => (b.ms > a.ms ? b : a));
    const out: OpResult = {
      name, unit, samples,
      medianMs: r1(median(samples.map((s) => s.ms))),
      maxMs: r1(Math.max(...samples.map((s) => s.ms))),
      queryCount: Math.max(...samples.map((s) => s.queryCount)),
      slowestQueryShape: worst.slowestQueryShape,
      extra: { ...extra, queryCountsSeen: [...counts].sort((a, b) => a - b) },
    };
    results.push(out);
    return out;
  }

  try {
    /* ── 0) fixture ────────────────────────────────────────────────────────────────── */
    step("0/4 büyütülmüş sentetik fixture");
    await generateVolume(owner);
    const vol = await owner.query<{ t: string; n: number }>(`
      select 'payment_instances' t, count(*)::int n from public.payment_instances
      union all select 'invoices', count(*)::int from public.invoices
      union all select 'bank_transactions', count(*)::int from public.bank_transactions
      union all select 'checks', count(*)::int from public.checks
      order by 1`);
    console.log("hacim: " + vol.rows.map((r) => `${r.t}=${r.n}`).join(" · "));
    const actorId = await ensureSystemActor(owner);

    const acct = await owner.query<{ id: string }>(
      `select id from public.cash_accounts where name = 'PERF Banka Hesabı'`);
    if (acct.rowCount !== 1) throw new Error("PERF banka hesabı bulunamadı — hacim üreteci koşmamış.");
    const bankAccountId = acct.rows[0].id;

    /** Bir önceki import'un HER İZİNİ siler; aksi hâlde ikinci ölçüm 'duplicate' işi ölçer. */
    async function cleanImports(): Promise<void> {
      const wbs = await owner.query<{ id: string }>(
        `select id from public.source_workbooks where original_filename = $1`, [STATEMENT_FILENAME]);
      for (const wb of wbs.rows) {
        await owner.query(`delete from public.bank_transactions where source_workbook_id = $1`, [wb.id]);
        await owner.query(`delete from public.import_rows where workbook_id = $1`, [wb.id]);
        await owner.query(`delete from public.source_cells where workbook_id = $1`, [wb.id]);
        await owner.query(`delete from public.source_sheets where workbook_id = $1`, [wb.id]);
        await owner.query(`delete from public.source_workbooks where id = $1`, [wb.id]);
      }
    }

    /* ── 1) bulk import ────────────────────────────────────────────────────────────── */
    step(`1/4 bulk import — ${STATEMENT_ROWS} satırlık gerçek ekstre, ${HEAVY_SAMPLES} örneklem`);
    const csv = buildStatementCsv(STATEMENT_ROWS);
    const importSamples: OpSample[] = [];
    let insertedLast = -1;
    // Ham sonuç TAMAMEN raporlanır. İlk koşuda 500 satırdan yalnız 203'ü yazıldı ve "inserted"
    // tek başına bunun NEDENİNİ söylemiyordu; rowsSeen/duplicates/skipped olmadan bir import
    // ölçümü "kaç satır yazıldı" sorusunu cevaplayamaz.
    let lastOutcome: Record<string, unknown> = {};
    for (let i = 0; i < HEAVY_SAMPLES; i += 1) {
      await cleanImports(); // her örneklem GERÇEK insert işi ölçsün
      const s = await measure(async () => {
        const res = await runAsSystem(() =>
          importBankStatement(pool, csv, STATEMENT_FILENAME, bankAccountId, actorId));
        if (!res.ok) throw new Error(`import başarısız: ${res.error ?? "bilinmeyen"}`);
        insertedLast = res.inserted;
        lastOutcome = {
          rowsSeen: res.rowsSeen, inserted: res.inserted, duplicates: res.duplicates,
          skipped: res.skipped, skippedReasons: res.skippedReasons, format: res.format,
        };
      });
      importSamples.push(s);
      console.log(`  örneklem ${i + 1}: ${r1(s.ms)} ms · ${s.queryCount} sorgu · ` +
        `${r1(STATEMENT_ROWS / (s.ms / 1000))} satır/sn`);
    }
    console.log(`  import sonucu: ${JSON.stringify(lastOutcome)}`);
    const importRes = summarise("bulk_import_bank_statement", "ms", importSamples, {
      rows: STATEMENT_ROWS,
      insertedRows: insertedLast,
      outcome: lastOutcome,
      rowsPerSecondMedian: r1(STATEMENT_ROWS / (median(importSamples.map((s) => s.ms)) / 1000)),
    });
    record("bulk import: her satır gerçekten yazıldı", insertedLast === STATEMENT_ROWS,
      `${STATEMENT_ROWS} satır eklendi`, `${insertedLast} satır`);
    record(`bulk import: felaket tavanı altında (< ${CATASTROPHE.bulkImportMs} ms)`,
      importRes.maxMs < CATASTROPHE.bulkImportMs, `< ${CATASTROPHE.bulkImportMs} ms`, `${importRes.maxMs} ms`);
    trend("bulk import: verim", Number(importRes.extra.rowsPerSecondMedian) >= BUDGET.importRowsPerSec,
      `≥ ${BUDGET.importRowsPerSec} satır/sn`, `${importRes.extra.rowsPerSecondMedian} satır/sn`);
    await cleanImports();

    /* ── 2) background job ─────────────────────────────────────────────────────────── */
    step(`2/4 background job — soğuk ay üretimi + kararlı hâl pencere yenileme`);
    const today = istanbulDateISO();
    // 30 ay ilerisi: `ensureWindow` 24 aylık ufuk üretir, o yüzden bu ay HİÇ üretilmemiştir —
    // silip yeniden üretmek gerçekten SOĞUK bir iş ölçer, idempotent bir no-op değil.
    const coldMonth = (() => {
      const [y, m] = today.split("-").map(Number);
      const t = new Date(Date.UTC(y, m - 1 + 30, 1));
      return t.toISOString().slice(0, 10);
    })();
    const coldSamples: OpSample[] = [];
    let generatedLast = -1;
    for (let i = 0; i < HEAVY_SAMPLES; i += 1) {
      await owner.query(`delete from public.payment_instances where instance_month = $1`, [coldMonth]);
      const s = await measure(async () => {
        const res = await runAsSystem(() => generateInstancesForMonth(pool, coldMonth, actorId));
        generatedLast = res.created;
      });
      coldSamples.push(s);
      console.log(`  soğuk ay ${coldMonth} örneklem ${i + 1}: ${r1(s.ms)} ms · ${s.queryCount} sorgu · ` +
        `${generatedLast} kalem`);
    }
    const coldJob = summarise("background_job_generate_month_cold", "ms", coldSamples,
      { month: coldMonth, createdInstances: generatedLast });
    record("background job (soğuk): gerçekten kalem üretti", generatedLast > 0,
      "> 0 kalem", `${generatedLast} kalem`);
    record(`background job (soğuk): felaket tavanı altında (< ${CATASTROPHE.backgroundJobMs} ms)`,
      coldJob.maxMs < CATASTROPHE.backgroundJobMs, `< ${CATASTROPHE.backgroundJobMs} ms`, `${coldJob.maxMs} ms`);
    trend("background job (soğuk): süre", coldJob.medianMs <= BUDGET.backgroundJobMs,
      `≤ ${BUDGET.backgroundJobMs} ms`, `${coldJob.medianMs} ms`);
    await owner.query(`delete from public.payment_instances where instance_month = $1`, [coldMonth]);

    // Kararlı hâl: her sunucu açılışında GERÇEKTEN koşan şekil (prepare-runtime.ts → ensureWindow).
    const steadySamples: OpSample[] = [];
    for (let i = 0; i < HEAVY_SAMPLES; i += 1) {
      const s = await measure(() => runAsSystem(() => ensureWindow(pool, today, actorId, 1)));
      steadySamples.push(s);
      console.log(`  kararlı hâl ensureWindow örneklem ${i + 1}: ${r1(s.ms)} ms · ${s.queryCount} sorgu`);
    }
    const steadyJob = summarise("background_job_ensure_window_steady", "ms", steadySamples, { horizonMonths: 1 });
    record(`background job (kararlı hâl): felaket tavanı altında (< ${CATASTROPHE.backgroundJobMs} ms)`,
      steadyJob.maxMs < CATASTROPHE.backgroundJobMs, `< ${CATASTROPHE.backgroundJobMs} ms`, `${steadyJob.maxMs} ms`);
    trend("background job (kararlı hâl): süre", steadyJob.medianMs <= BUDGET.backgroundJobMs,
      `≤ ${BUDGET.backgroundJobMs} ms`, `${steadyJob.medianMs} ms`);

    /* ── 3) temsili tek yazma ──────────────────────────────────────────────────────── */
    step(`3/4 temsili yazma — markInstancePaid, ${LIGHT_SAMPLES} örneklem`);
    const candidates = await owner.query<{ id: string }>(
      `select id from public.payment_instances
       where status = 'unpaid' and amount is not null
       order by id limit $1`, [LIGHT_SAMPLES]);
    if (candidates.rowCount !== LIGHT_SAMPLES) {
      throw new Error(`Yeterli 'unpaid' kalem yok (${candidates.rowCount}/${LIGHT_SAMPLES}).`);
    }
    const writeSamples: OpSample[] = [];
    for (const row of candidates.rows) {
      const s = await measure(() => runAsSystem(() => markInstancePaid(pool, row.id, null, actorId)));
      writeSamples.push(s);
      // Fixture'ı ölçümden önceki hâline döndür: ölçüm ortamı kendi kendini kaydırmasın.
      await runAsSystem(() => markInstanceUnpaid(pool, row.id, actorId));
    }
    const write = summarise("representative_write_mark_paid", "ms", writeSamples, {
      operation: "markInstancePaid + geri alma (geri alma ölçüme dahil DEĞİL)",
    });
    console.log(`  medyan ${write.medianMs} ms · ${write.queryCount} sorgu`);
    record(`temsili yazma: sorgu tavanı aşılmıyor (≤ ${MAX_QUERIES_SINGLE_WRITE})`,
      write.queryCount > 0 && write.queryCount <= MAX_QUERIES_SINGLE_WRITE,
      `1..${MAX_QUERIES_SINGLE_WRITE}`, String(write.queryCount));
    record("temsili yazma: sorgu sayısı örneklemler arasında oynamıyor",
      new Set(writeSamples.map((s) => s.queryCount)).size === 1,
      `${LIGHT_SAMPLES} örneklemde aynı sayı`, (write.extra.queryCountsSeen as number[]).join("/"));
    record(`temsili yazma: felaket tavanı altında (< ${CATASTROPHE.singleWriteMs} ms)`,
      write.maxMs < CATASTROPHE.singleWriteMs, `< ${CATASTROPHE.singleWriteMs} ms`, `${write.maxMs} ms`);
    trend("temsili yazma: süre", write.medianMs <= BUDGET.singleWriteMs,
      `≤ ${BUDGET.singleWriteMs} ms`, `${write.medianMs} ms`);

    /* ── 4) özet ───────────────────────────────────────────────────────────────────── */
    step("4/4 ÖZET");
    console.log("| işlem | medyan ms | en kötü ms | query_count | ek |");
    console.log("|---|---|---|---|---|");
    for (const r of results) {
      console.log(`| ${r.name} | ${r.medianMs} | ${r.maxMs} | ${r.queryCount} | ` +
        `${JSON.stringify(r.extra).slice(0, 90)} |`);
    }

    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({
      startedAt, finishedAt: new Date().toISOString(),
      databaseName: dbName, databaseClass: "DISPOSABLE_SYNTHETIC",
      machine: { ...machine, freeMemGbAtEnd: r1(os.freemem() / 1024 ** 3) },
      statementRows: STATEMENT_ROWS, heavySamples: HEAVY_SAMPLES, lightSamples: LIGHT_SAMPLES,
      thresholds: { hard: { ...CATASTROPHE, maxQueriesSingleWrite: MAX_QUERIES_SINGLE_WRITE }, trend: BUDGET },
      operations: results, checks, warnings,
    }, null, 2), "utf8");

    const hard = checks.filter((c) => c.hard);
    const failed = hard.filter((c) => !c.pass);
    console.log(`\nSERT kapı: ${hard.length - failed.length}/${hard.length} geçti.`);
    console.log(`TREND uyarısı: ${warnings.length} (exit kodunu etkilemez).`);
    console.log(`Kanıt: ${JSON_OUT}`);
    if (failed.length > 0) {
      console.error("WRITE SLO GATE FAIL:");
      for (const f of failed) console.error(`  - ${f.name}: beklenen ${f.expected}, gerçek ${f.actual}`);
      process.exitCode = 1;
    } else {
      console.log("WRITE SLO GATE: SERT KAPININ TAMAMI GEÇTİ");
    }
  } finally {
    await pool.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error("write-slo beklenmedik hata:", e instanceof Error ? e.message : e);
  process.exit(1);
});
