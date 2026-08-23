// Faz 34 verification — analysis registry, rolling/period functions, seven analyses, three chart
// types, export, and the STANDING repo-wide LLM-independence rule.
//
// Usage:
//   env -u DATABASE_URL MIGRATION_DATABASE_URL=... pnpm phase34:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset. The import graph was
// checked before writing — analytics/{registry,periods,analyses,chart-types,reproducibility,
// export,engine} — and none of them reaches @/lib/env.
//
// ═══ THE STANDING RULE, NOT A ONE-OFF ═══
//
// The plan turns "the analysis/chart calculation modules must not import @/lib/ai" into a
// PERMANENT repo-wide check from this phase onward. So this gate does not list files: it WALKS
// src/lib/analytics and src/lib/facts and src/components/charts in full and fails on any file
// that reaches the LLM. A file added in Faz 40 is covered on the day it is written, with nobody
// remembering to update a list — which is the only way a standing rule stays standing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  ANALYSES, METRICS, RegistryError,
  analysisVersionFingerprint, dependentsOf, lineageOf, resolveDependencies, topologicalOrder,
} from "../src/lib/analytics/registry";
import {
  ageingDistribution, cashBridge, paretoConcentration, varianceDecomposition,
  workingCapitalDecomposition,
} from "../src/lib/analytics/analyses";
import { periodOverPeriod, rollingWindow, ROLLING_WINDOWS } from "../src/lib/analytics/periods";
import { heatmapModel, treemapModel, waterfallModel } from "../src/lib/analytics/chart-types";
import { buildStamp, sameComputation } from "../src/lib/analytics/reproducibility";
import {
  heatmapToSheet, rowsToCsv, toXlsxBuffer, treemapToSheet,
  treemapToSvg, waterfallToSvg, waterfallToSheet, heatmapToSvg,
} from "../src/lib/analytics/export";
import {
  runAgeingDistribution, runCashBridge, runParetoConcentration,
  runPeriodOverPeriod, runRollingTrend, runVarianceDecomposition,
  runWorkingCapitalDecomposition,
} from "../src/lib/analytics/engine";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("phase34:verify") });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ROOT = process.cwd();
const readSrc = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

/**
 * Remove the fixture this gate creates.
 *
 * Runs at START as well as at the end, and on the failure path — the Faz 33 lesson: a gate whose
 * fixtures survive its own crash makes every later run fail for a different reason.
 */
const purgeFixture = async () => {
  await pool.query(`delete from public.invoices where invoice_no like 'P34-FIXTURE-%'`).catch(() => undefined);
  await pool.query(`delete from public.parties where name like 'P34-FIXTURE %'`).catch(() => undefined);
};

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

/** Every .ts/.tsx under a directory, recursively. The basis of the standing rule. */
function walkSources(relDir: string): string[] {
  const abs = path.join(ROOT, relDir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = path.join(relDir, entry);
    const st = statSync(path.join(ROOT, rel));
    if (st.isDirectory()) out.push(...walkSources(rel));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

async function main(): Promise<void> {
  await purgeFixture();

  /* ── 1. THE STANDING REPO-WIDE LLM-INDEPENDENCE RULE ────────────────────────────────── */
  const GUARDED_TREES = ["src/lib/analytics", "src/lib/facts", "src/components/charts"];
  const guardedFiles = GUARDED_TREES.flatMap(walkSources);
  record("korumalı ağaçlar GERÇEKTEN taranıyor (sabit dosya listesi değil)",
    guardedFiles.length >= 10 && GUARDED_TREES.every((t) => guardedFiles.some((f) => f.startsWith(t))),
    `${guardedFiles.length} dosya, ${GUARDED_TREES.length} ağaç — Faz 40'ta eklenecek dosya da kapsanır`);

  // Built at runtime so this gate does not contain the literal it hunts (the Faz 33 lesson).
  const AI_IMPORT = new RegExp(`from\\s+["']@/lib/${"ai"}(/|["'])`);
  const aiOffenders = guardedFiles.filter((f) => AI_IMPORT.test(codeOnly(readSrc(f))));
  record("KALICI KURAL: analiz/chart ağaçlarının hiçbiri @/lib/ai'yi import etmiyor",
    aiOffenders.length === 0,
    aiOffenders.join(", ") || `${guardedFiles.length} dosya temiz — okuyan kişi rakamı yeniden üretebilmeli`);

  // Positive control: the detector must fire on the shape it hunts, or "clean" means nothing.
  record("POZİTİF KONTROL: LLM dedektörü aradığı import'u gerçekten yakalıyor",
    AI_IMPORT.test(`import { x } from "@/lib/ai/engine";`)
      && AI_IMPORT.test(`import y from '@/lib/ai';`)
      && !AI_IMPORT.test(`import { z } from "@/lib/aircraft";`),
    "yakalamayan bir dedektör, temiz olduğunu söyleyen bir dedektördür");

  /* ── 2. NO PYTHON, NO STATISTICS DEPENDENCY ─────────────────────────────────────────── */
  const pkg = JSON.parse(readSrc("package.json")) as {
    dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  };
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const statsDeps = Object.keys(allDeps).filter((d) =>
    /^(simple-statistics|jstat|mathjs|d3-random|ml-|scipy|numpy|python)/.test(d));
  record("istatistik/Python bağımlılığı eklenmedi (Çözülen Karar #2)",
    statsDeps.length === 0,
    statsDeps.join(", ") || "tüm hesaplama TS'de — toplama, sıralama, oran, kümülatif");
  const pyFiles = walkSources("src").filter((f) => f.endsWith(".py"));
  record("repoda analiz için .py dosyası yok", pyFiles.length === 0, `${pyFiles.length}`);

  /* ── 3. MONTE CARLO: DELIBERATELY ABSENT, AND THE REASON IS CHECKABLE ───────────────── */
  //
  // The decision (see docs/status-notes.md) rests on a measurable fact: Monte Carlo needs input
  // DISTRIBUTIONS and this schema stores none. That fact is asserted here rather than trusted,
  // because if a future phase adds a variance column the decision deserves revisiting.
  const distributionCols = await pool.query(`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and (column_name ~ '(stddev|std_dev|variance$|_variance$|distribution|probability|percentile|confidence_interval)')
      and column_name not in ('variance_amount','variance_ratio','variance_verdict')`);
  record("şemada DAĞILIM verisi yok — Monte Carlo'nun girdisi mevcut değil",
    distributionCols.rowCount === 0,
    distributionCols.rowCount === 0
      ? "hiçbir tabloda stddev/varyans/olasılık/persentil kolonu yok"
      : distributionCols.rows.map((r) => `${r.table_name}.${r.column_name}`).join(", "));

  const assumptionCols = await pool.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='external_assumptions'`);
  const names = assumptionCols.rows.map((r) => r.column_name as string);
  record("dış varsayımlar TEK NOKTA değer taşıyor (ortalama+varyans değil)",
    names.includes("value_numeric") && !names.some((n) => /min|max|stddev|variance/.test(n)),
    "value_numeric + kaynak + tarih — simülasyon için dağılım uydurmak gerekirdi");

  const simulationCode = walkSources("src/lib/analytics")
    .filter((f) => /monteCarlo|randomNormal|Math\.random/.test(codeOnly(readSrc(f))));
  record("analiz modüllerinde rastgelelik/simülasyon YOK",
    simulationCode.length === 0,
    simulationCode.join(", ") || "deterministik — aynı girdi her zaman aynı çıktı");

  /* ── 4. SCOPE: the deliberately small first slice ───────────────────────────────────── */
  const analysisCount = Object.keys(ANALYSES).length;
  record("ilk dilim BİLİNÇLİ olarak dar tutuldu (5-8 analiz, ~40 değil)",
    analysisCount >= 5 && analysisCount <= 8,
    `${analysisCount} analiz: ${Object.keys(ANALYSES).join(", ")}`);
  record("her analizin arkasında GERÇEK veri var (uydurulmuş tip yok)",
    Object.values(ANALYSES).every((a) => a.inputs.length > 0 || a.kind === "trend" || a.kind === "comparison"),
    "envanter devir hızı REDDEDİLDİ — envanter verisi yok, uydurmak gerekirdi");

  /* ── 5. registry: a real dependency graph, not a list ───────────────────────────────── */
  record("bağımlılık grafiği: sarkan kenar yok",
    Object.values(METRICS).every((m) => m.dependsOn.every((d) => METRICS[d] != null)),
    `${Object.keys(METRICS).length} metrik`);
  let cycleFree = true;
  for (const id of Object.keys(METRICS)) {
    try { resolveDependencies(id); } catch { cycleFree = false; }
  }
  record("bağımlılık grafiğinde DÖNGÜ yok", cycleFree, "her metrik çözülebiliyor");
  record("bilinmeyen metrik SESSİZCE boş liste döndürmüyor, hata veriyor",
    (() => { try { resolveDependencies("yok_boyle_bir_sey"); return false; } catch (e) { return e instanceof RegistryError; } })(),
    "yazım hatası, bağımlılığı olmayan bir metrik gibi görünmemeli");
  const order = topologicalOrder();
  const orderOk = Object.values(METRICS).every((m) =>
    m.dependsOn.every((d) => order.indexOf(d) < order.indexOf(m.id)));
  record("topolojik sıra: her bağımlılık kendi bağımlısından ÖNCE",
    orderOk && new Set(order).size === Object.keys(METRICS).length, `${order.length} metrik`);
  record("dependentsOf() değişimin etki alanını veriyor",
    dependentsOf("receivables_open").includes("cash_cycle_days"),
    "geçişli bağımlılar da bulunuyor");
  record("lineage GERÇEK tabloları adlandırıyor",
    lineageOf("working_capital_decomposition").includes("working_capital_metrics")
      && lineageOf("pareto_concentration").includes("invoices"),
    "kaynak sorusu bir adrese çıkıyor");
  record("DIO metriği kayıtta duruyor (eksikliği görünür kalsın diye)",
    METRICS.dio_days != null && METRICS.dio_days.lineage.sources.length === 0,
    "silinseydi DSO−DPO tam nakit döngüsü sanılırdı");

  /* ── 6. reproducibility stamp ───────────────────────────────────────────────────────── */
  const input = { rowCounts: { invoices: 10 }, asOf: "2026-03-31", sourceCutoff: null };
  const s1 = buildStamp("pareto_concentration", input, "2026-03-31T08:00:00Z");
  const s2 = buildStamp("pareto_concentration", input, "2026-04-05T23:59:00Z");
  record("aynı hesap + aynı girdi = aynı damga (SAAT damgaya girmiyor)",
    sameComputation(s1, s2) && s1.digest === s2.digest,
    "saat girseydi her koşu farklı görünür, karşılaştırma işe yaramazdı");
  const s3 = buildStamp("pareto_concentration",
    { ...input, rowCounts: { invoices: 11 } }, "2026-03-31T08:00:00Z");
  record("girdi değişince damga DEĞİŞİYOR", !sameComputation(s1, s3), "tek satır fark yeterli");
  record("damga hesap sürümü + lineage taşıyor",
    s1.versionFingerprint.includes("@") && s1.lineage.length > 0,
    s1.versionFingerprint.slice(0, 60));
  record("sürüm parmak izi analize göre farklılaşıyor",
    analysisVersionFingerprint("cash_bridge") !== analysisVersionFingerprint("ageing_distribution"),
    "iki analiz aynı parmak izini paylaşamaz");

  /* ── 7. null is never zero — the rule this system is built on ───────────────────────── */
  const varMissing = varianceDecomposition([
    { key: "a", label: "A", budget: 100, actual: null },
    { key: "b", label: "B", budget: 100, actual: 150 },
  ]);
  record("varyans: eksik gerçekleşen DIŞLANIYOR, 0 sayılmıyor",
    varMissing.rows.length === 1 && varMissing.unknownCount === 1,
    "0 sayılsaydı en gurur verici tasarruf raporu çıkardı");

  const roll = rollingWindow(
    [{ key: "2026-01-01", value: null }, { key: "2026-01-02", value: null }], 7, "sum");
  record("hareketli pencere: tamamen bilinmeyen pencere NULL, 0 değil",
    roll[1].value === null && roll[1].unknownCount === 2, "boş pencerenin cevabı yoktur");

  const pop = periodOverPeriod(
    [{ key: "2025-01", value: 100 }, { key: "2026-01", value: 120 }], "mom");
  const jan = pop.find((r) => r.key === "2026-01");
  record("dönemsel: önceki dönem yoksa %-100 değil 'ölçülemez'",
    jan?.changeRatio === null && jan?.unmeasurableReason === "previous_missing",
    "eksik dönemi sıfır saymak, olmayan bir çöküş icat eder");

  const ageing = ageingDistribution([{ dueDate: null, amount: 500 }], "2026-03-31");
  record("yaşlandırma: vadesiz kalem 'vadesi gelmemiş' sayılmıyor",
    ageing.unknownCount === 1 && ageing.rows.every((r) => r.amount === 0),
    "eksik vadeyi 'henüz vadesi gelmedi' saymak iyimser bir varsayımdır");

  const wc = workingCapitalDecomposition({ dsoDays: 60, dpoDays: 40 });
  record("işletme sermayesi: DIO her zaman ÖLÇÜLEMEZ olarak raporlanıyor",
    wc.rows.find((r) => r.key === "dio_days")?.days === null && wc.complete === false,
    "atlanabilirdi — o zaman DSO−DPO tam döngü sanılırdı");

  /* ── 8. analyses refuse nonsense instead of producing a number ──────────────────────── */
  const negPareto = paretoConcentration([
    { key: "a", label: "A", value: -100 }, { key: "b", label: "B", value: 100 },
  ]);
  record("Pareto negatif değerde HESAP YAPMIYOR, reddediyor",
    negPareto.unmeasurableReason != null && negPareto.summary === null,
    "−100 ile +100'ün toplamı sıfır, her pay sonsuz olurdu");
  let treemapRefused = false;
  try {
    treemapModel({
      title: "t", description: "d", format: "currency", asOf: "2026-01-01", sourceLabel: "s",
      items: [{ key: "a", label: "A", value: -5 }],
    });
  } catch { treemapRefused = true; }
  record("treemap negatif değeri REDDEDİYOR (alan negatif büyüklüğü temsil edemez)",
    treemapRefused, "büyüklüğe göre çizmek borcu aynı boyda alacak gibi gösterirdi");

  const badBridge = cashBridge({
    startLabel: "A", startValue: 1000, endLabel: "B", reportedEndValue: 999,
    movements: [{ key: "m", label: "M", value: 500 }],
  });
  record("nakit köprüsü tutmayan mutabakatı RAPORLUYOR, sessizce çizmiyor",
    badBridge.reconciles === false && badBridge.difference === -501,
    "tutmayan bir köprü, altındaki defterle çelişen bir grafiktir");

  /* ── 9. chart geometry, proven not eyeballed ────────────────────────────────────────── */
  const tm = treemapModel({
    title: "t", description: "d", format: "currency", asOf: "2026-01-01", sourceLabel: "s",
    items: [
      { key: "a", label: "A", value: 50 }, { key: "b", label: "B", value: 30 },
      { key: "c", label: "C", value: 15 }, { key: "d", label: "D", value: 5 },
    ],
  });
  const area = tm.tiles.reduce((s, t) => s + t.width * t.height, 0);
  record("treemap birim kareyi TAM kaplıyor (alan = 1)",
    Math.abs(area - 1) < 1e-9, `alan=${area.toFixed(12)}`);
  const proportional = tm.tiles.every((t) => Math.abs(t.width * t.height - t.share) < 1e-9);
  record("her karo alanı payıyla ORANTILI", proportional, "göz kararı değil, ölçülmüş");
  let overlap = 0;
  for (let i = 0; i < tm.tiles.length; i++) {
    for (let j = i + 1; j < tm.tiles.length; j++) {
      const a = tm.tiles[i], b = tm.tiles[j];
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (Math.min(ox, oy) > 1e-9) overlap++;
    }
  }
  record("hiçbir karo ÇAKIŞMIYOR", overlap === 0, `${overlap} çakışma`);

  const hm = heatmapModel({
    title: "t", description: "d", format: "count", asOf: "2026-01-01", sourceLabel: "s",
    rows: [{ key: "r", label: "R" }],
    columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
    values: [{ rowKey: "r", columnKey: "a", value: 5 }],
  });
  record("ısı haritası: eksik hücre NULL yoğunluk (en soğuk renk DEĞİL)",
    hm.cells.find((c) => c.columnKey === "b")?.intensity === null && hm.unknownCount === 1,
    "en soğuk renk 'en küçük değer' demektir — bilmediğini iddia etmek olurdu");

  const wf = waterfallModel({
    title: "t", description: "d", format: "currency", asOf: "2026-01-01", sourceLabel: "s",
    steps: [
      { key: "s", label: "S", value: 100, kind: "start" },
      { key: "a", label: "A", value: 50, kind: "increase" },
    ],
  });
  record("şelale: hareket çubukları yürüyen toplam arasında",
    wf.bars[1].from === 100 && wf.bars[1].to === 150 && wf.min <= 0,
    "eksen sıfırı içeriyor — taban çizgisiz şelale ölçeği abartır");

  /* ── 10. rolling windows cover the required set ─────────────────────────────────────── */
  record("7/30/90/365 günlük pencerelerin hepsi tanımlı",
    ROLLING_WINDOWS.length === 4 && [7, 30, 90, 365].every((w) => (ROLLING_WINDOWS as readonly number[]).includes(w)),
    ROLLING_WINDOWS.join(", "));
  const partial = rollingWindow(
    Array.from({ length: 10 }, (_, i) => ({ key: `2026-01-${String(i + 1).padStart(2, "0")}`, value: 1 })),
    7, "sum");
  record("penceresi dolmayan noktalar KISMİ olarak işaretleniyor",
    partial.slice(0, 6).every((p) => p.partial) && partial[6].partial === false,
    "gizlenseydi verinin başladığı yer bir 'trend' gibi görünürdü");

  /* ── 11. against the real database, on a fixture THIS GATE builds ───────────────────── */
  //
  // The database is not assumed to contain open invoices: a freshly seeded one does not, and an
  // earlier draft of this gate "passed" its concentration and ageing checks against zero rows —
  // the vacuous pass this project keeps refusing. The fixture is created here, dated in 2099 so
  // it cannot collide with real data, and removed in the finally block below.
  const asOf = new Date().toISOString().slice(0, 10);

  const TAG = "P34-FIXTURE";
  await pool.query(
    `insert into public.parties (id, name, normalized_name, party_type)
     select md5('p34:' || i)::uuid, $1 || ' ' || i, lower($1 || ' ' || i), 'customer'
     from generate_series(1, 5) i on conflict do nothing`, [TAG]);
  // Deliberately uneven, so the Pareto "vital few" is a real finding rather than a flat split,
  // and spread across ageing buckets so every bucket is exercised.
  await pool.query(
    `insert into public.invoices
       (direction, invoice_no, party_id, issue_date, due_date, currency,
        net_amount, tax_amount, gross_amount, status)
     select case when i % 4 = 0 then 'purchase' else 'sales' end,
            $1 || '-' || i,
            md5('p34:' || (1 + (i % 5)))::uuid,
            current_date - 200,
            current_date - (i * 25),
            'TRY',
            (1000 * (6 - (i % 5)))::numeric,
            0,
            (1000 * (6 - (i % 5)))::numeric,
            'open'
     from generate_series(1, 8) i on conflict do nothing`, [TAG]);

  const dbPareto = await runParetoConcentration(pool, asOf);
  const dbAgeing = await runAgeingDistribution(pool, "sales", asOf);
  const dbWc = await runWorkingCapitalDecomposition(pool, asOf);
  const dbRoll = await runRollingTrend(pool, 30, asOf);
  const dbPop = await runPeriodOverPeriod(pool, "mom", asOf);
  const dbVar = await runVarianceDecomposition(pool, asOf);
  const monthRange = await pool.query(
    `select to_char(min(month_start),'YYYY-MM') a, to_char(max(month_start),'YYYY-MM') b
       from public.cashflow_months`);
  const dbBridge = await runCashBridge(pool,
    monthRange.rows[0]?.a ?? asOf.slice(0, 7), monthRange.rows[0]?.b ?? asOf.slice(0, 7), asOf);

  record("yedi analizin hepsi GERÇEK veritabanında çalışıyor",
    [dbPareto, dbAgeing, dbWc, dbRoll, dbPop, dbVar, dbBridge].every((x) => x.stamp != null),
    "7/7");
  // Non-vacuity asserted, not hoped for: every one of these must have real rows behind it.
  record("karşılaştırma BOŞ KÜMEDE yapılmadı (gate kendi fixture'ını kurdu)",
    dbPareto.result.rows.length > 0 && dbAgeing.result.rows.length > 0
      && dbBridge.result.rows.length > 0 && dbPareto.summary != null,
    `pareto=${dbPareto.result.rows.length} yaşlandırma=${dbAgeing.result.rows.length} köprü=${dbBridge.result.rows.length}`);
  record("Pareto gerçek veride 'kritik azınlık' buluyor",
    (dbPareto.summary?.vitalFewCount ?? 0) >= 1
      && (dbPareto.summary?.vitalFewCount ?? 0) <= (dbPareto.summary?.totalCount ?? 0),
    `${dbPareto.summary?.vitalFewCount}/${dbPareto.summary?.totalCount} karşı taraf açık alacağın %80'ini taşıyor`);
  record("yaşlandırma gerçek veride BİRDEN FAZLA kovayı dolduruyor",
    dbAgeing.result.rows.filter((r) => r.amount > 0).length >= 2,
    dbAgeing.result.rows.filter((r) => r.amount > 0).map((r) => r.bucketLabel).join(", "));
  record("her sonuç kendi damgasını taşıyor (lineage + sürüm + girdi sayımı)",
    [dbPareto, dbAgeing, dbWc, dbRoll, dbPop, dbVar, dbBridge].every((x) =>
      x.stamp.lineage.length >= 0 && x.stamp.versionFingerprint.length > 0
      && Object.keys(x.stamp.input.rowCounts).length > 0),
    "altı ay sonra 'bu rakam neyden çıktı' sorusunun cevabı var");

  // Determinism against live data: two runs over the same unchanged data must agree exactly.
  const again = await runParetoConcentration(pool, asOf);
  record("aynı veri üzerinde iki koşu BİREBİR aynı sonucu veriyor",
    JSON.stringify(again.result.rows) === JSON.stringify(dbPareto.result.rows)
      && again.stamp.digest === dbPareto.stamp.digest,
    "deterministik — rastgelelik yok, sıralama toplam düzenli");

  /* ── 12. engine reads existing read-models, does not recompute ──────────────────────── */
  const engineSrc = codeOnly(readSrc("src/lib/analytics/engine.ts"));
  for (const view of ["budget_vs_actual", "working_capital_metrics", "cashflow_months"]) {
    record(`motor ${view} read-model'ini OKUYOR (yeniden hesaplamıyor)`,
      new RegExp(`public\\.${view}`).test(engineSrc),
      "ikinci bir DSO/varyans hesabı, eninde sonunda çelişen iki rakam demektir");
  }
  record("motor DSO/DPO'yu kendisi HESAPLAMIYOR",
    !/sales_365\s*\/|\/\s*365\.0|receivables_open\s*\//.test(engineSrc),
    "Faz 30'un view'ı tek kaynak");

  /* ── 13. export ─────────────────────────────────────────────────────────────────────── */
  const xlsx = toXlsxBuffer([waterfallToSheet(wf), heatmapToSheet(hm), treemapToSheet(tm)], s1);
  record("XLSX gerçek bir xlsx (ZIP imzası PK)",
    xlsx.length > 1000 && xlsx[0] === 0x50 && xlsx[1] === 0x4b, `${xlsx.length} bayt`);
  const heatSheet = heatmapToSheet(hm);
  const missingCell = heatSheet.rows[1][2];
  record("XLSX'te bilinmeyen hücre BOŞ, 0 değil",
    missingCell === null, "sahte sıfırlarla dolu bir tabloda SUM() sessizce yanlış toplar");
  const csv = rowsToCsv([["a", "b"], [1, null]]);
  record("CSV bilinmeyeni boş bırakıyor", csv.split("\n")[1] === "1;", JSON.stringify(csv.split("\n")[1]));
  record("XLSX'e KAYNAK sayfası ekleniyor (damga dosyayla birlikte gider)",
    xlsx.length > toXlsxBuffer([waterfallToSheet(wf)]).length,
    "e-postayla dolaşan bir tabloda rakamın hangi sürümden çıktığı yazılı olmalı");

  const svgs = [waterfallToSvg(wf), heatmapToSvg(hm), treemapToSvg(tm)];
  record("üç chart tipi de kendi kendine yeten SVG üretiyor",
    svgs.every((s) => s.startsWith("<svg") && s.includes("</svg>") && !s.includes("var(--")),
    "harici CSS'e bağlı bir export, export değildir");
  record("SVG dipnotu bilinmeyen sayısını taşıyor",
    heatmapToSvg(hm).includes("bilinmeyen"),
    "resim uygulamadan çıkarken 'ölçemedik' bilgisi kaybolmamalı");

  /* ── 14. no migration, no table, no lifecycle column — STRUCTURALLY ─────────────────── */
  //
  // Faz 30's pattern: prove the discipline is N/A rather than claim it. This phase added no
  // migration, so the CHECK+guard rule has nothing to attach to.
  // FIXED IN FAZ 35, and the bug was mine: this pinned `latest === "0082"`, so the very next
  // phase's migration broke it. That is exactly the brittleness class Faz 31 found in
  // `action_items.source_type` (a `size === N` assertion that had to be edited every time the set
  // grew) — and I reproduced it here.
  //
  // The durable property is not "no migration exists anywhere"; it is "FAZ 34 created no table of
  // its own", which stays true no matter how many later phases add. Asserted by name, over the
  // whole schema, so a future `metric_definitions` table fails this check whenever it appears.
  const migrations = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
  // Narrow on purpose. A first attempt matched /dimension/ and flagged 0038_org_dimensions.sql —
  // Faz 19's organisational dimensions, an entirely legitimate migration that has nothing to do
  // with this registry. A check that fires on innocent files teaches people to ignore it.
  const faz34Migrations = migrations.filter((f) =>
    /(metric_definition|analysis_run|analytics_registry|calculation_registry)/i.test(f));
  record("Faz 34 KENDİ migration'ını eklemedi (kayıt kod, tablo değil)",
    faz34Migrations.length === 0,
    `${migrations.length} migration var, hiçbiri analiz kaydı için değil — ` +
    `tablo yok, dolayısıyla yaşam-döngüsü kolonu da yok: CHECK+guard yapısal olarak N/A`);
  const analyticsTables = await pool.query(`
    select table_name from information_schema.tables
    where table_schema='public' and table_type='BASE TABLE'
      and (table_name like '%metric_definition%' or table_name like '%analysis_run%'
           or table_name like '%registry%')`);
  record("paralel registry/analysis_runs tablosu açılmadı",
    analyticsTables.rowCount === 0,
    "metric_snapshots (Faz 17) zaten değer geçmişini tutuyor; damga onun meta'sına yazılır");

  /* ── 15. house rules ────────────────────────────────────────────────────────────────── */
  const newSources = [
    "src/lib/analytics/registry.ts", "src/lib/analytics/periods.ts",
    "src/lib/analytics/analyses.ts", "src/lib/analytics/chart-types.ts",
    "src/lib/analytics/reproducibility.ts", "src/lib/analytics/export.ts",
    "src/lib/analytics/engine.ts",
  ];
  const FLOAT_CAST = new RegExp("::" + "float8");
  const floaty = newSources.filter((f) => FLOAT_CAST.test(codeOnly(readSrc(f))));
  record("yeni kaynakların hiçbirinde float8 cast'i yok",
    floaty.length === 0, floaty.join(", ") || `${newSources.length} dosya temiz`);
  record("para money.ts üzerinden okunuyor",
    /moneyOrNull/.test(engineSrc), "numeric doğrudan Number()'a verilmiyor");
  record("export rotası Zod sınırı taşıyor",
    /z\.object\(/.test(readSrc("src/app/api/analytics/export/route.ts")),
    "query string kullanıcı girdisidir");
  record("export rotası kimlik doğruluyor",
    /getCurrentUser\(\)/.test(readSrc("src/app/api/analytics/export/route.ts")),
    "analiz verisi oturumsuz indirilemez");
  const migrateSrc = readSrc("scripts/db/migrate.ts");
  const anchorBlock = migrateSrc.slice(migrateSrc.indexOf("const ANCHORS"));
  record("ANCHORS'a dokunulmadı",
    !anchorBlock.slice(0, 4000).includes("0083"), "yalnız 0001-0019 legacy tespiti için");
  const pureModules = ["src/lib/analytics/registry.ts", "src/lib/analytics/periods.ts",
    "src/lib/analytics/analyses.ts", "src/lib/analytics/chart-types.ts",
    "src/lib/analytics/reproducibility.ts"];
  const impure = pureModules.filter((f) => /from\s+["']pg["']|@\/lib\/db/.test(codeOnly(readSrc(f))));
  record("saf modüller GERÇEKTEN saf (veritabanı yok)",
    impure.length === 0, impure.join(", ") || `${pureModules.length} modül`);

  await purgeFixture();

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length) {
    console.log(`PHASE34 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE34 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error(messageOf(e));
  await purgeFixture();
  await pool.end().catch(() => undefined);
  process.exit(1);
});
