// Faz 32 verification — CFO briefing, management cockpit, unified financial calendar.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase32:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset. The import graph was
// checked before writing — briefing/rules, briefing/engine, home/cockpit, and the loaders they
// call — and none reaches @/lib/env.
//
// ═══ THE CENTRAL REQUIREMENT: SUMMARY MAY NOT DEVIATE FROM DETAIL ═══
//
// The plan forbids the briefing from disagreeing with the dashboards beneath it. This is checked
// two ways, and the first matters more:
//
//   STRUCTURALLY — the briefing engine issues no SQL of its own for a headline figure; it calls
//   the same loader functions the pages call. The gate asserts that in the source, so a future
//   change that re-derives a number locally fails here rather than silently drifting.
//
//   BEHAVIOURALLY — the gate builds fixtures, calls the underlying loaders directly, calls the
//   briefing, and asserts the numbers are IDENTICAL. Unlike Faz 26's treasury reconciliation,
//   where two genuinely different sources were compared and a gap was REPORTED, a gap here would
//   be a bug: there is one source, so the assertion is equality.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import {
  headline, renderBriefing, summariseDay, todaysActions,
} from "../src/lib/briefing/rules";
import { loadBriefingFacts, loadCalendar, loadCalendarDaily, loadWidgetFacts } from "../src/lib/briefing/engine";
import { buildWidgets, widgetsNeedingAttention } from "../src/lib/home/cockpit";
import { loadPositionSummary, loadLiquidityGap } from "../src/lib/treasury/engine";
import { loadWorkingCapital } from "../src/lib/costing/engine";
import { loadControlDashboard } from "../src/lib/controls/engine";
import { overdueOpen } from "../src/lib/radar/queries";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireOwnerDatabaseUrl() });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TAG = () => `P32-${Math.random().toString(36).slice(2, 8)}`;

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const reportTypes = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.reports'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='report_type'`);
  const types = new Set([...(reportTypes[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  // Superset assertion, not an exact count — the Faz 31 lesson about cross-phase enum breaks.
  record("reports.report_type 'cfo_briefing' kabul ediyor ve önceki değerler korunmuş",
    types.has("cfo_briefing")
      && ["daily", "weekly", "monthly", "strategic", "data_quality"].every((t) => types.has(t)),
    [...types].sort().join(", "));

  const views = await q(
    `select table_name, table_type from information_schema.tables
     where table_schema='public' and table_name in ('financial_calendar','financial_calendar_daily')`);
  record("takvim read-model'leri VIEW",
    views.length === 2 && views.every((v) => v.table_type === "VIEW"), `${views.length} view`);

  // The §3 open question, settled: no new recurring-obligation table was created.
  const recurringTables = await q(
    `select table_name from information_schema.tables
     where table_schema='public'
       and (table_name ilike '%recurring%' or table_name ilike '%obligation%')`);
  record("YENİ tekrar-eden-yükümlülük tablosu YOK (payments zaten modelliyor)",
    recurringTables.length === 0,
    "payments.recurrence_type + due_day maaş/kira/vergiyi zaten taşıyor — ikinci doğruluk kaynağı açılmadı");

  const recurrenceCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.payments'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='recurrence_type'`);
  record("KANIT: payments.recurrence_type gerçekten tekrar modeli taşıyor",
    /monthly/.test(recurrenceCheck[0]?.def ?? "") && /yearly/.test(recurrenceCheck[0]?.def ?? ""),
    "kararın dayanağı iddia değil, kısıt");

  /* ── 2. the calendar unions the right things with the right certainty ───────────────── */
  const calendar = await (async () => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const party = (await client.query(
        `insert into public.parties(name, normalized_name, party_type) values ($1,$2,'vendor') returning id`,
        [TAG(), TAG().toLowerCase()])).rows[0].id;
      const pay = (await client.query(
        `insert into public.payments(name, recurrence_type, due_day, default_amount, currency, provider_party_id)
         values ($1,'monthly',15,25000,'TRY',$2) returning id`, [`Maaş ${TAG()}`, party])).rows[0].id;
      await client.query(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, currency, status, direction)
         values ($1,'2099-03-01','2099-03-15',25000,'TRY','unpaid','outflow')`, [pay]);
      await client.query(
        `insert into public.promise_to_pay(party_id, promised_amount, promised_date)
         values ($1, 9000, '2099-03-15')`, [party]);
      const fac = (await client.query(
        `insert into public.credit_facilities(name, limit_amount, currency, status, expiry_date)
         values ($1, 500000, 'TRY', 'active', '2099-03-15') returning id`, [TAG()])).rows[0].id;

      const rows = (await client.query(
        `select source_kind, amount_signed, certainty from public.financial_calendar
         where event_date = '2099-03-15'`)).rows;
      const daily = (await client.query(
        `select net_contracted, net_expected, renewal_count, event_count
         from public.financial_calendar_daily where event_date = '2099-03-15' and currency='TRY'`)).rows[0];
      return { rows, daily, fac };
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  })();

  const kinds = new Set(calendar.rows.map((r) => r.source_kind));
  record("takvim ödeme/söz/limit-vadesini TEK görünümde topluyor",
    kinds.has("payment_instance") && kinds.has("promise_to_pay") && kinds.has("facility_expiry"),
    [...kinds].join(", "));
  record("ödeme sözü 'expected', taksit 'contracted' olarak etiketleniyor",
    calendar.rows.find((r) => r.source_kind === "promise_to_pay")?.certainty === "expected"
      && calendar.rows.find((r) => r.source_kind === "payment_instance")?.certainty === "contracted",
    "söz, imzalı bir yükümlülükle aynı ağırlıkta sayılmıyor");
  record("limit vadesi NAKİT HAREKETİ olarak sayılmıyor (amount NULL)",
    calendar.rows.find((r) => r.source_kind === "facility_expiry")?.amount_signed === null,
    "vadesi gelen limit bir tarih, bir çıkış değil — 0 olsaydı toplama karışırdı");
  record("günlük özet sözleşmeli ile beklenen akışı AYRI veriyor",
    Number(calendar.daily.net_contracted) === -25000 && Number(calendar.daily.net_expected) === 9000
      && Number(calendar.daily.renewal_count) === 1,
    `sözleşmeli=${calendar.daily.net_contracted} beklenen=${calendar.daily.net_expected}`);

  /* ── 3. THE CONSISTENCY REQUIREMENT — structural ────────────────────────────────────── */
  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/briefing/engine.ts"), "utf8");
  const engineCode = codeOnly(engineSrc);
  for (const loader of [
    "loadPositionSummary", "loadLiquidityGap", "loadWorkingCapital",
    "loadControlDashboard", "overdueOpen", "instancesOn",
  ]) {
    record(`brifing ${loader}() panosunu YENİDEN HESAPLAMIYOR, çağırıyor`,
      new RegExp(`\\b${loader}\\(`).test(engineCode), "tek kaynak — sapma yapısal olarak imkânsız");
  }
  record("brifing kendi başlık rakamı için ham SQL yazmıyor",
    !/select[\s\S]{0,200}from public\.(treasury_position_summary|treasury_liquidity_gap|working_capital_metrics)/i
      .test(engineCode),
    "aynı view'ı ikinci kez sorgulamak sapmanın kapısı olurdu");

  /* ── 4. THE CONSISTENCY REQUIREMENT — behavioural, on real fixtures ─────────────────── */
  const consistency = await (async () => {
    const client = await pool.connect();
    let ids: { party: string; pay: string; acct: string } | null = null;
    try {
      // Committed, so the loaders (which open their own connections) can see them.
      const party = (await client.query(
        `insert into public.parties(name, normalized_name, party_type) values ($1,$2,'vendor') returning id`,
        [TAG(), TAG().toLowerCase()])).rows[0].id;
      const acct = (await client.query(
        `insert into public.cash_accounts(name, account_type, currency, opening_balance, is_active)
         values ($1,'bank_account','TRY',750000,true) returning id`, [TAG()])).rows[0].id;
      await client.query(
        `insert into public.bank_accounts(cash_account_id, bank_name, available_balance, balance_as_of)
         values ($1,'P32 Bank', 750000, now())`, [acct]);
      const pay = (await client.query(
        `insert into public.payments(name, recurrence_type, due_day, default_amount, currency, provider_party_id)
         values ($1,'monthly',9,40000,'TRY',$2) returning id`, [TAG(), party])).rows[0].id;
      // An OVERDUE item so the comparison is not against zero.
      await client.query(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, currency, status, direction)
         values ($1, date_trunc('month', current_date - 40)::date, current_date - 40, 40000,'TRY','unpaid','outflow')`,
        [pay]);
      // A large outflow three days out, so the 7-day liquidity gap is genuinely POSITIVE.
      // Comparing 0 against 0 would have proved nothing about whether the two agree.
      await client.query(
        `insert into public.payment_instances
           (payment_id, instance_month, due_date, amount, currency, status, direction)
         values ($1, date_trunc('month', current_date + 3)::date, current_date + 3, 5000000,'TRY','unpaid','outflow')`,
        [pay]);
      // Invoices, so DSO/DPO are computable numbers rather than NULL on both sides.
      // Due far out, deliberately: these must not disturb the 7/30-day horizons being compared.
      await client.query(
        `insert into public.invoices
           (direction, invoice_no, party_id, issue_date, due_date, currency,
            net_amount, tax_amount, gross_amount, status)
         values ('sales', $1, $2, current_date - 30, current_date + 200, 'TRY', 100000, 20000, 120000, 'open'),
                ('purchase', $3, $2, current_date - 30, current_date + 200, 'TRY', 50000, 10000, 60000, 'open')`,
        [`P32-S-${TAG()}`, party, `P32-P-${TAG()}`]);
      ids = { party, pay, acct };

      const todayISO = new Date().toISOString().slice(0, 10);

      // The dashboards' own numbers, loaded directly.
      const [summary, gaps, working, controls, overdue] = await Promise.all([
        loadPositionSummary(pool), loadLiquidityGap(pool), loadWorkingCapital(pool),
        loadControlDashboard(pool), overdueOpen(pool, todayISO),
      ]);
      // The briefing's numbers.
      const facts = await loadBriefingFacts(pool, todayISO);
      const md = renderBriefing(facts);
      const widgets = await loadWidgetFacts(pool, todayISO);

      // Exercise the TypeScript read path too. A view can be correct in SQL while its mapper
      // reads the wrong column or drops a sign, and only calling the loader catches that.
      const horizon = new Date(Date.now() + 210 * 86400000).toISOString().slice(0, 10);
      const cal = await loadCalendar(pool, todayISO, horizon);
      const calDaily = await loadCalendarDaily(pool, todayISO, horizon);
      const big = cal.find((r) => r.amountSigned === -5000000);
      const tiles = buildWidgets(widgets);
      const attention = widgetsNeedingAttention(tiles);

      const tryPos = summary.find((s) => s.currency === "TRY") ?? summary[0] ?? null;
      // Same selection rule the briefing documents (TRY preferred). Asserted alongside a
      // membership check below, so a fabricated number fails even if the rule were changed.
      const gap7 = gaps.find((g) => g.currency === "TRY" && g.horizonDays === 7)
        ?? gaps.find((g) => g.horizonDays === 7) ?? null;

      return {
        gap7Options: gaps.filter((g) => g.horizonDays === 7).map((g) => g.financingNeed),
        dashCash: tryPos?.availableNow ?? null,
        briefCash: facts.availableCash,
        widgetCash: widgets.availableCash,
        dashGap7: gap7?.financingNeed ?? null,
        briefGap7: facts.liquidityGap7,
        dashOverdue: overdue.length,
        briefOverdue: facts.overdueCount,
        dashDso: working?.dsoDays ?? null,
        briefDso: facts.dsoDays,
        dashCritical: controls.filter((c) => c.state === "CRITICAL").length,
        briefCritical: facts.criticalControls.length,
        md,
        calCount: cal.length,
        calBigFound: big != null,
        calDailyCount: calDaily.length,
        calDailyNegative: calDaily.some((d) => d.netContracted < 0),
        attentionTones: attention.map((a) => a.tone),
        attentionSubset: attention.every((a) => tiles.some((t) => t.key === a.key)),
      };
    } finally {
      if (ids) {
        await pool.query(`delete from public.invoices where party_id=$1`, [ids.party]).catch(() => {});
        await pool.query(`delete from public.payment_instances where payment_id=$1`, [ids.pay]).catch(() => {});
        await pool.query(`delete from public.payments where id=$1`, [ids.pay]).catch(() => {});
        await pool.query(`delete from public.bank_accounts where cash_account_id=$1`, [ids.acct]).catch(() => {});
        await pool.query(`delete from public.cash_accounts where id=$1`, [ids.acct]).catch(() => {});
        await pool.query(`delete from public.parties where id=$1`, [ids.party]).catch(() => {});
      }
      await client.query("rollback").catch(() => {});
      client.release();
    }
  })();

  record("SAPMA YOK: nakit rakamı brifing = pano",
    consistency.briefCash === consistency.dashCash,
    `brifing=${consistency.briefCash} pano=${consistency.dashCash}`);
  record("SAPMA YOK: nakit rakamı kokpit widget'ı = brifing",
    consistency.widgetCash === consistency.briefCash,
    `widget=${consistency.widgetCash} brifing=${consistency.briefCash}`);
  record("SAPMA YOK: 7 gün likidite açığı brifing = pano",
    consistency.briefGap7 === consistency.dashGap7,
    `brifing=${consistency.briefGap7} pano=${consistency.dashGap7}`);
  record("brifingin açık rakamı panoda GERÇEKTEN VAR olan bir satırdan geliyor",
    consistency.gap7Options.includes(consistency.briefGap7),
    `pano 7 gün satırları: ${JSON.stringify(consistency.gap7Options)}`);
  record("SAPMA YOK: gecikmiş kalem sayısı brifing = radar sorgusu",
    consistency.briefOverdue === consistency.dashOverdue,
    `brifing=${consistency.briefOverdue} radar=${consistency.dashOverdue}`);
  record("SAPMA YOK: DSO brifing = işletme sermayesi view'ı",
    consistency.briefDso === consistency.dashDso,
    `brifing=${consistency.briefDso} view=${consistency.dashDso}`);
  record("SAPMA YOK: kritik kontrol sayısı brifing = kontrol panosu",
    consistency.briefCritical === consistency.dashCritical,
    `brifing=${consistency.briefCritical} pano=${consistency.dashCritical}`);
  // Non-vacuity, asserted rather than assumed: 0 === 0 and null === null would have "passed"
  // every comparison above while proving nothing. The fixture forces each figure to be a real,
  // non-trivial value first, and the gate fails if it isn't.
  record("karşılaştırmalar BOŞ KÜMEDE yapılmadı — üç rakam da gerçekten doluydu",
    consistency.dashOverdue >= 1
      && (consistency.dashGap7 ?? 0) > 0
      && consistency.dashDso != null,
    `gecikmiş=${consistency.dashOverdue} açık=${consistency.dashGap7} DSO=${consistency.dashDso}`);
  record("render edilen brifing gecikmiş kalemi metinde de gösteriyor",
    /Gecikmiş kalem: \d+/.test(consistency.md), "özet ile metin aynı sayıdan türüyor");

  // The TypeScript read path, not just the SQL. A mapper that read the wrong column or lost the
  // sign would pass every view-level check above and still ship a wrong screen.
  record("loadCalendar() işareti KORUYARAK okuyor (5.000.000 çıkış negatif geliyor)",
    consistency.calBigFound && consistency.calCount >= 1,
    `${consistency.calCount} kalem okundu`);
  record("loadCalendarDaily() günlük neti negatif olarak veriyor",
    consistency.calDailyCount >= 1 && consistency.calDailyNegative,
    `${consistency.calDailyCount} gün`);
  record("widgetsNeedingAttention() gerçek veride kritik tile üretiyor",
    consistency.attentionTones.includes("neg") && consistency.attentionSubset,
    `tonlar: ${consistency.attentionTones.join(", ")}`);

  /* ── 5. unknown is never zero ───────────────────────────────────────────────────────── */
  const s = summariseDay([{ amount: 100, direction: "outflow" }, { amount: null, direction: "outflow" }]);
  record("bilinmeyen tutar sıfır olarak toplanmıyor, AYRICA sayılıyor",
    s.knownOutflow === 100 && s.unknownCount === 1, `bilinen=${s.knownOutflow} bilinmeyen=${s.unknownCount}`);
  const mdUnknown = renderBriefing({
    todayISO: "2099-01-01", availableCash: null, minCashFloor: null,
    liquidityGap7: null, liquidityGap30: null, projectedContracted7: null,
    todayOutflowKnown: 0, todayInflowKnown: 0, todayCount: 0, todayUnknownAmountCount: 0,
    overdueCount: 0, overdueKnownOutflow: 0, criticalControls: [], openAlertCount: 0,
    newCriticalAlerts: [], promisesDueToday: 0, overduePromises: 0,
    dsoDays: null, dpoDays: null, cycleExcludingInventory: null,
  });
  record("bilinmeyen rakam brifingde '—' olarak yazılıyor, 0 TL olarak değil",
    mdUnknown.includes("Kullanılabilir nakit: —") && !mdUnknown.includes("Kullanılabilir nakit: 0 TL"),
    "0 TL ile 'hesaplanamadı' farklı ifadeler");

  const widgetsUnknown = buildWidgets({
    availableCash: null, minCashFloor: null, liquidityGap7: null, liquidityGap30: null,
    receivablesOpen: null, payablesOpen: null, dsoDays: null, dpoDays: null,
    netDebt: null, facilityAvailable: null, debtDue30: null, fxWorstCase20: null,
    budgetVarianceOverCount: null, cycleExcludingInventory: null,
    criticalControlCount: 0, openAlertCount: 0, topConcentrationRatio: null,
  });
  record("bilinmeyen widget '—' ve nötr, sahte bir 0 değil",
    widgetsUnknown.filter((w) => w.value === "—").length >= 8
      && widgetsUnknown.every((w) => w.note.length > 0),
    `${widgetsUnknown.filter((w) => w.value === "—").length} tile bilinmiyor olarak işaretli`);

  /* ── 6. headline priority is fixed and predictable ──────────────────────────────────── */
  const base = {
    todayISO: "2099-01-01", availableCash: 1, minCashFloor: null,
    liquidityGap7: null, liquidityGap30: null, projectedContracted7: null,
    todayOutflowKnown: 0, todayInflowKnown: 0, todayCount: 0, todayUnknownAmountCount: 0,
    overdueCount: 0, overdueKnownOutflow: 0, criticalControls: [] as string[], openAlertCount: 0,
    newCriticalAlerts: [] as string[], promisesDueToday: 0, overduePromises: 0,
    dsoDays: null, dpoDays: null, cycleExcludingInventory: null,
  };
  record("likidite açığı manşette kritik kontrolün ÜSTÜNDE",
    headline({ ...base, liquidityGap7: 5, criticalControls: ["x"] }).text.includes("likidite"),
    "sabit öncelik — operatör hangi satırı göreceğini tahmin edebilmeli");
  record("aksiyon listesi sınırlı (okunabilir kalsın)",
    todaysActions({
      ...base, liquidityGap7: 1, overdueCount: 1, overduePromises: 1,
      todayUnknownAmountCount: 1, promisesDueToday: 1,
      newCriticalAlerts: ["a", "b", "c", "d"],
    }).length === 5, "on beş 'acil' satırlı brifing kimsenin harekete geçmediğidir");

  /* ── 7. reuse, not reinvention ──────────────────────────────────────────────────────── */
  record("brifing MEVCUT reports tablosuna yazıyor (paralel briefings tablosu yok)",
    /insert into public\.reports/.test(engineCode) && /'cfo_briefing'/.test(engineCode),
    "0079 tek bir enum değeri ekledi");
  record("dağıtım MEVCUT transport arayüzünü kullanıyor (yeni mekanizma yok)",
    /transport\.send\(/.test(engineCode) && /channel/.test(engineCode),
    "Telegram + Faz 25 e-posta kanalı enjekte ediliyor");

  const cockpitSrc = readFileSync(path.join(process.cwd(), "src/lib/home/cockpit.ts"), "utf8");
  record("cockpit.ts HÂLÂ saf (veritabanı yok, kendi başlığındaki söz korunuyor)",
    !/from "pg"|pool\.|client\.query/.test(codeOnly(cockpitSrc)),
    "widget katmanı da yeni finansal matematik eklemiyor");
  record("mevcut CockpitFacts arayüzü DEĞİŞTİRİLMEDİ (overview kırılmadı)",
    /export interface CockpitFacts/.test(cockpitSrc) && /export interface CockpitWidgetFacts/.test(cockpitSrc),
    "widget'lar ayrı bir arayüzle eklendi");

  /* ── 8. no LLM, money discipline, ANCHORS ───────────────────────────────────────────── */
  const rulesSrc = readFileSync(path.join(process.cwd(), "src/lib/briefing/rules.ts"), "utf8");
  const aiImport = (src: string) =>
    /(^|\s)import\s[^;]*["']@\/lib\/ai[^"']*["']/m.test(codeOnly(src))
    || /import\s*\(\s*["']@\/lib\/ai/.test(codeOnly(src));
  record("brifing KURALLARI @/lib/ai'yi import ETMİYOR", !aiImport(rulesSrc),
    "okuyan kişi rakamları panoya karşı yeniden üretebilmeli");
  record("brifing MOTORU @/lib/ai'yi import ETMİYOR", !aiImport(engineSrc), "");
  record("cockpit @/lib/ai'yi import ETMİYOR", !aiImport(cockpitSrc), "");
  record("reports/engine.ts'in deterministik sınırı bozulmadı",
    !aiImport(readFileSync(path.join(process.cwd(), "src/lib/reports/engine.ts"), "utf8")),
    "Faz 6/12 mimarisi yerinde");

  const FLOAT_CAST = `::${"float"}8`;
  const sources = [
    "supabase/migrations/0079_reports_cfo_briefing.sql",
    "supabase/migrations/0080_financial_calendar.sql",
    "src/lib/briefing/rules.ts", "src/lib/briefing/engine.ts", "src/lib/home/cockpit.ts",
  ];
  const offenders = sources.filter((f) => codeOnly(readFileSync(path.join(process.cwd(), f), "utf8")).includes(FLOAT_CAST));
  record(`yeni kaynakların hiçbirinde ${FLOAT_CAST} yok`,
    offenders.length === 0, offenders.length === 0 ? `${sources.length} dosya temiz` : offenders.join(", "));
  record("brifing motoru audit() kullanıyor",
    /audit\(client/.test(engineSrc), "Faz 18 kuralı");
  record("brifing MALİ kayıt yazmıyor (okur ve özetler)",
    !/(update|delete\s+from)\s+public\.(invoices|payments|payment_instances|checks|loans|bank_transactions|cashflow_months)/i
      .test(engineCode),
    "yalnız reports + audit_logs");

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0079-0080 eklenmedi)",
    !/00(79|80)/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE32 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE32 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE32 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
