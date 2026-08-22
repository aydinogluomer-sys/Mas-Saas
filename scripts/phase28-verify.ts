// Faz 28 verification — budgets, variance, rolling forecast and the 13-week horizon.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase28:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset, per the standing rule
// Faz 25 produced. The import graph was checked before writing — budget/rules, budget/engine,
// money, audit, validation, authz/matrix — and none reaches @/lib/env.
//
// STANDING RULES INHERITED (Faz 20/22/23/24B/26/27):
//   1. Constraints targeted STRUCTURALLY by conkey, candidate count asserted — several
//      constraints on these tables mention the same column name.
//   2. No vacuous pass: every fixture built here, dated 2099, negatives paired with positive
//      controls.
//   3. Comparisons are value-based, never row positions.
//   4. Source-level checks run over CODE, not raw text. Faz 27's lesson: the files being scanned
//      explain in comments that they avoid the very things these checks forbid, and grepping raw
//      text cannot tell the explanation from the offence.
//
// THE REINFORCEMENT THIS PHASE OWES: forecast mathematics stays in TS/SQL and the LLM stays
// entirely outside the chain. That is asserted structurally below — the budget/forecast modules
// must not import @/lib/ai at all.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  FORECAST_WEEKS, SOURCE_CONFIDENCE, SOURCE_KINDS, VERSION_STATUSES,
  accuracy, canTransition, variance, weekBuckets,
} from "../src/lib/budget/rules";
import { TABLE_CLASS } from "../src/lib/authz/matrix";
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

async function inRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("begin"); return await fn(client); }
  finally { await client.query("rollback").catch(() => {}); client.release(); }
}
async function refuses(c: PoolClient, sql: string, params: unknown[] = []): Promise<boolean> {
  await c.query("savepoint probe");
  try { await c.query(sql, params); await c.query("release savepoint probe"); return false; }
  catch { await c.query("rollback to savepoint probe"); return true; }
}
const TAG = () => `P28-${Math.random().toString(36).slice(2, 8)}`;

/** Source with comments stripped — see rule 4 in the header. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

async function mkBudget(c: PoolClient, year = 2099): Promise<string> {
  return (await c.query(
    `insert into public.budgets(name, fiscal_year, period_kind) values ($1,$2,'monthly') returning id`,
    [TAG(), year])).rows[0].id;
}
async function mkUser(c: PoolClient): Promise<string> {
  return (await c.query(
    `insert into public.users(username,password_hash,display_name,role)
     values ($1,'x','P28','finance_manager') returning id`,
    [`p28_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
}
/** A budget line already in a chosen version state, built from scratch. */
async function mkBudgetLine(
  c: PoolClient, budget: string, status: string, actor: string,
  period = "2099-01-01", direction = "expense", amount = 1000,
): Promise<string> {
  return (await c.query(
    `insert into public.budget_lines
       (budget_id, period_start, direction, amount, version_status, approved_at, approved_by, superseded_at)
     values ($1,$2::date,$3,$4,$5,
             case when $5='approved' then now() when $5='superseded' then null else null end,
             case when $5='approved' then $6::uuid else null end,
             case when $5='superseded' then now() else null end)
     returning id`,
    [budget, period, direction, amount, status, actor])).rows[0].id;
}
async function mkForecast(c: PoolClient, anchor = "2099-01-05"): Promise<string> {
  return (await c.query(
    `insert into public.forecasts(name, horizon_kind, anchor_date) values ($1,'weekly_13',$2::date) returning id`,
    [TAG(), anchor])).rows[0].id;
}
async function mkForecastLine(
  c: PoolClient, forecast: string, status: string, actor: string,
  period = "2099-01-06", direction = "inflow", amount = 500, source = "contracted",
): Promise<string> {
  return (await c.query(
    `insert into public.forecast_lines
       (forecast_id, period_start, period_end, direction, amount, source_kind, confidence,
        version_status, approved_at, approved_by, superseded_at)
     values ($1,$2::date,$2::date,$3,$4,$5,0.9,$6,
             case when $6='approved' then now() else null end,
             case when $6='approved' then $7::uuid else null end,
             case when $6='superseded' then now() else null end)
     returning id`,
    [forecast, period, direction, amount, source, status, actor])).rows[0].id;
}

const ALLOWED = new Set(["draft>approved", "draft>superseded", "approved>superseded"]);

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tables = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name in ('budgets','budget_lines','forecasts','forecast_lines')
     order by table_name`);
  record("dört yeni tablo da mevcut", tables.length === 4, `${tables.length}/4`);

  // LESSON: conkey targeting with cardinality asserted — for BOTH lifecycle tables.
  for (const t of ["budget_lines", "forecast_lines"]) {
    const vc = await q(
      `select pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
       where c.conrelid = ('public.'||$1)::regclass and c.contype='c'
         and cardinality(c.conkey)=1 and a.attname='version_status'`, [t]);
    record(`${t}.version_status CHECK'i yapısal olarak ve TEK olarak hedeflendi`,
      vc.length === 1, `${vc.length} aday (tam 1 bekleniyor)`);
    const lits = new Set([...(vc[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    record(`${t}.version_status tam olarak 3 kanonik değeri sayıyor`,
      lits.size === 3 && VERSION_STATUSES.every((s) => lits.has(s)), [...lits].sort().join(", "));
  }

  /* ── 2. transition enumeration on BOTH tables ───────────────────────────────────────── */
  for (const t of ["budget_lines", "forecast_lines"] as const) {
    const guard = await inRollback(async (c) => {
      const actor = await mkUser(c);
      const parent = t === "budget_lines" ? await mkBudget(c) : await mkForecast(c);
      const out: { pair: string; accepted: boolean }[] = [];
      let n = 0;
      for (const from of VERSION_STATUSES) {
        for (const to of VERSION_STATUSES) {
          if (from === to) continue;
          n += 1;
          const period = `2099-0${(n % 9) + 1}-01`;
          const id = t === "budget_lines"
            ? await mkBudgetLine(c, parent, from, actor, period, "expense", 1000 + n)
            : await mkForecastLine(c, parent, from, actor, period, "inflow", 500 + n);
          const sql = `update public.${t}
                         set version_status=$2,
                             approved_at = case when $2='approved' then now()
                                                when $2='draft' then null else approved_at end,
                             approved_by = case when $2='approved' then $3::uuid
                                                when $2='draft' then null else approved_by end,
                             superseded_at = case when $2='superseded' then now() else null end
                       where id=$1`;
          const blocked = await refuses(c, sql, [id, to, actor]);
          out.push({ pair: `${from}>${to}`, accepted: !blocked });
        }
      }
      return out;
    });
    const wrong = guard.filter((g) => g.accepted !== ALLOWED.has(g.pair));
    record(`${t}: 6 geçişin tamamı allow-list ile örtüşüyor (izinli 3, yasak 3)`,
      wrong.length === 0,
      wrong.length === 0
        ? `${guard.filter((g) => g.accepted).length} kabul / ${guard.filter((g) => !g.accepted).length} ret`
        : wrong.map((w) => `${w.pair}=${w.accepted ? "kabul" : "ret"}`).join(", "));
    record(`${t}: onaylanmış satır taslağa GERİ ALINAMIYOR`,
      guard.find((g) => g.pair === "approved>draft")?.accepted === false,
      "imzalanmış rakam sessizce yeniden yazılamaz");
    record(`${t}: guard ile koddaki canTransition BİREBİR aynı`,
      guard.every((g) => g.accepted === canTransition(
        g.pair.split(">")[0] as never, g.pair.split(">")[1] as never)),
      "veritabanı ve uygulama tek kural kümesi");
  }

  record("aynı-duruma güncelleme 3 durumda da no-op",
    await inRollback(async (c) => {
      const actor = await mkUser(c);
      const b = await mkBudget(c);
      let n = 0;
      for (const s of VERSION_STATUSES) {
        n += 1;
        // Distinct months so the live-unique index cannot collide; padded so month 13 is
        // impossible (an earlier version built "2099-13-01" and PostgreSQL rightly refused it).
        const period = `2099-${String(n).padStart(2, "0")}-01`;
        const id = await mkBudgetLine(c, b, s, actor, period, "expense", 500 + n);
        if (await refuses(c, `update public.budget_lines set notes='x', version_status=$2 where id=$1`, [id, s])) {
          return false;
        }
      }
      return true;
    }), "kendine geçiş engellenmiyor");

  /* ── 3. version/timestamp consistency, with positive controls ───────────────────────── */
  const cons = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const b = await mkBudget(c);
    const draftWithApproval = await refuses(c,
      `insert into public.budget_lines(budget_id, period_start, direction, amount, version_status, approved_at, approved_by)
       values ($1,'2099-02-01','expense',100,'draft',now(),$2)`, [b, actor]);
    const approvedNoStamp = await refuses(c,
      `insert into public.budget_lines(budget_id, period_start, direction, amount, version_status)
       values ($1,'2099-03-01','expense',100,'approved')`, [b]);
    const stampNoActor = await refuses(c,
      `insert into public.budget_lines(budget_id, period_start, direction, amount, version_status, approved_at)
       values ($1,'2099-04-01','expense',100,'approved',now())`, [b]);
    const validApproved = !(await refuses(c,
      `insert into public.budget_lines(budget_id, period_start, direction, amount, version_status, approved_at, approved_by)
       values ($1,'2099-05-01','expense',100,'approved',now(),$2)`, [b, actor]));
    const negAmount = await refuses(c,
      `insert into public.budget_lines(budget_id, period_start, direction, amount)
       values ($1,'2099-06-01','expense',-1)`, [b]);
    const zeroAmount = !(await refuses(c,
      `insert into public.budget_lines(budget_id, period_start, direction, amount)
       values ($1,'2099-07-01','expense',0)`, [b]));
    return { draftWithApproval, approvedNoStamp, stampNoActor, validApproved, negAmount, zeroAmount };
  });
  record("taslak satır onay damgası taşıyamıyor", cons.draftWithApproval, "durum ile damga tutarlı");
  record("onaylı satır damgasız olamıyor", cons.approvedNoStamp, "onay anı zorunlu");
  record("onay anı, onaylayan olmadan yazılamıyor", cons.stampNoActor, "aktör uydurulmuyor, zorunlu tutuluyor");
  record("POZİTİF KONTROL: tutarlı onaylı satır kabul ediliyor", cons.validApproved, "kısıt meşru veriyi engellemiyor");
  record("negatif bütçe tutarı reddediliyor", cons.negAmount, "");
  record("POZİTİF KONTROL: SIFIR bütçe geçerli ('bu kalem için ödenek yok')",
    cons.zeroAmount, "0 ile null farklı ifadeler");

  const fcCons = await inRollback(async (c) => {
    const f = await mkForecast(c);
    const badPeriod = await refuses(c,
      `insert into public.forecast_lines(forecast_id, period_start, period_end, direction, amount, source_kind)
       values ($1,'2099-02-10','2099-02-01','inflow',100,'manual')`, [f]);
    const badConfidence = await refuses(c,
      `insert into public.forecast_lines(forecast_id, period_start, period_end, direction, amount, source_kind, confidence)
       values ($1,'2099-02-01','2099-02-07','inflow',100,'manual',1.5)`, [f]);
    const halfActual = await refuses(c,
      `insert into public.forecast_lines(forecast_id, period_start, period_end, direction, amount, source_kind, actual_amount)
       values ($1,'2099-02-01','2099-02-07','inflow',100,'manual',90)`, [f]);
    const fullActual = !(await refuses(c,
      `insert into public.forecast_lines(forecast_id, period_start, period_end, direction, amount, source_kind, actual_amount, actual_recorded_at)
       values ($1,'2099-03-01','2099-03-07','inflow',100,'manual',90,now())`, [f]));
    return { badPeriod, badConfidence, halfActual, fullActual };
  });
  record("dönem sonu başlangıçtan önce olamıyor", fcCons.badPeriod, "");
  record("güven skoru 0..1 dışına çıkamıyor", fcCons.badConfidence, "");
  record("yarım yazılmış gerçekleşme reddediliyor", fcCons.halfActual, "tutar ve kayıt anı birlikte");
  record("POZİTİF KONTROL: tam gerçekleşme kabul ediliyor", fcCons.fullActual, "");

  /* ── 4. variance: SQL and TypeScript must agree ─────────────────────────────────────── */
  const varianceProbe = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const b = await mkBudget(c);
    const cc = (await c.query(
      `insert into public.cost_centers(code,name) values ($1,$2) returning id`,
      [TAG(), TAG()])).rows[0].id;
    const party = (await c.query(
      `insert into public.parties(name,normalized_name,party_type) values ($1,$2,'vendor') returning id`,
      [TAG(), TAG().toLowerCase()])).rows[0].id;

    // Approved expense budget of 1.000 for 2099-01, with 1.200 of purchase invoices against it.
    await c.query(
      `insert into public.budget_lines
         (budget_id, period_start, direction, amount, currency, cost_center_id,
          version_status, approved_at, approved_by)
       values ($1,'2099-01-01','expense',1000,'TRY',$2,'approved',now(),$3)`, [b, cc, actor]);
    await c.query(
      `insert into public.invoices
         (party_id, direction, issue_date, due_date, net_amount, gross_amount, currency, status,
          cost_center_id, invoice_no)
       values ($1,'purchase','2099-01-10','2099-02-10',1200,1200,'TRY','open',$2,$3)`,
      [party, cc, TAG()]);
    // A DRAFT line must not be measured at all.
    await c.query(
      `insert into public.budget_lines(budget_id, period_start, direction, amount, currency, cost_center_id)
       values ($1,'2099-02-01','expense',500,'TRY',$2)`, [b, cc]);

    const rows = (await c.query(
      `select budget_line_id, direction, budget_amount, actual_amount, variance_amount,
              variance_ratio, variance_verdict
       from public.budget_vs_actual where budget_id=$1`, [b])).rows;
    return rows;
  });
  record("yalnız ONAYLI satırlar ölçülüyor (taslak varyans raporuna girmiyor)",
    varianceProbe.length === 1,
    `${varianceProbe.length} satır (1 onaylı + 1 taslak yazıldı)`);
  const vrow = varianceProbe[0];
  record("bütçe aşımı doğru hesaplanıyor (1.000 bütçe, 1.200 gerçekleşen)",
    Number(vrow.budget_amount) === 1000 && Number(vrow.actual_amount) === 1200
      && Number(vrow.variance_amount) === 200 && vrow.variance_verdict === "over_budget",
    `bütçe=${vrow.budget_amount} gerçek=${vrow.actual_amount} fark=${vrow.variance_amount} → ${vrow.variance_verdict}`);
  const tsVar = variance(vrow.direction, vrow.budget_amount, vrow.actual_amount);
  record("SQL varyansı ile TS variance() BİREBİR aynı",
    tsVar.varianceAmount === Number(vrow.variance_amount) && tsVar.verdict === vrow.variance_verdict,
    `TS ${tsVar.varianceAmount}/${tsVar.verdict} — SQL ${vrow.variance_amount}/${vrow.variance_verdict}`);

  const incomeVerdict = variance("income", 1000, 1200).verdict;
  record("YÖN duyarlı: aynı +200 fark gelirde 'hedefte veya üzerinde'",
    incomeVerdict === "on_or_above_target" && tsVar.verdict === "over_budget",
    "işaretsiz tek bir varyans iyi bir ayı kırmızıya boyardı");

  const unmeasured = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const b = await mkBudget(c);
    await c.query(
      `insert into public.budget_lines
         (budget_id, period_start, direction, amount, version_status, approved_at, approved_by)
       values ($1,'2099-09-01','expense',750,'approved',now(),$2)`, [b, actor]);
    return (await c.query(
      `select actual_amount, variance_amount, variance_verdict
       from public.budget_vs_actual where budget_id=$1`, [b])).rows[0];
  });
  record("gerçekleşen YOKSA sıfır değil NULL, karar 'not_measured'",
    unmeasured.actual_amount === null && unmeasured.variance_amount === null
      && unmeasured.variance_verdict === "not_measured",
    "sıfır 'hiç harcanmadı' iddiasıdır");

  /* ── 5. the 13-week horizon ─────────────────────────────────────────────────────────── */
  const horizon = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const f = await mkForecast(c, "2099-01-05");
    // One approved line in week 1 and one in week 13; the other 11 weeks stay empty.
    await mkForecastLine(c, f, "approved", actor, "2099-01-06", "inflow", 1000, "contracted");
    await mkForecastLine(c, f, "approved", actor, "2099-03-30", "outflow", 400, "estimated");
    // A DRAFT line must not appear in the horizon.
    await mkForecastLine(c, f, "draft", actor, "2099-01-07", "inflow", 9999, "manual");
    return (await c.query(
      `select week_no, to_char(week_start,'YYYY-MM-DD') as week_start,
              to_char(week_end,'YYYY-MM-DD') as week_end,
              inflow, outflow, net_flow, net_flow_contracted, line_count
       from public.cash_forecast_13w where forecast_id=$1 order by week_no`, [f])).rows;
  });
  record("13 haftalık ufuk HER ZAMAN tam 13 kova (boş haftalar dahil)",
    horizon.length === FORECAST_WEEKS,
    `${horizon.length} hafta — boş hafta sessizce düşmüyor`);
  const tsWeeks = weekBuckets("2099-01-05");
  record("SQL hafta sınırları ile TS weekBuckets() BİREBİR aynı",
    horizon.every((h, i) => h.week_start === tsWeeks[i].weekStart && h.week_end === tsWeeks[i].weekEnd),
    `hafta 1: ${horizon[0]?.week_start}..${horizon[0]?.week_end}`);
  record("taslak tahmin satırı ufka GİRMİYOR",
    Number(horizon[0].inflow) === 1000 && Number(horizon[0].line_count) === 1,
    `hafta 1 giriş=${horizon[0]?.inflow} satır=${horizon[0]?.line_count} (9999'luk taslak hariç)`);
  record("sözleşmeli-yalnız net akış ayrıca veriliyor",
    Number(horizon[0].net_flow_contracted) === 1000 && Number(horizon[12].net_flow_contracted) === 0,
    `hafta1=${horizon[0]?.net_flow_contracted} hafta13=${horizon[12]?.net_flow_contracted} (13. hafta tahmini)`);

  /* ── 6. accuracy ────────────────────────────────────────────────────────────────────── */
  const acc = await inRollback(async (c) => {
    const actor = await mkUser(c);
    const f = await mkForecast(c, "2099-06-01");
    const l1 = await mkForecastLine(c, f, "approved", actor, "2099-06-02", "inflow", 100, "contracted");
    const l2 = await mkForecastLine(c, f, "approved", actor, "2099-06-09", "inflow", 200, "contracted");
    // Third line stays UNMEASURED — must be excluded, not scored as perfect.
    await mkForecastLine(c, f, "approved", actor, "2099-06-16", "inflow", 300, "contracted");
    await c.query(
      `update public.forecast_lines set actual_amount=150, actual_recorded_at=now() where id=$1`, [l1]);
    await c.query(
      `update public.forecast_lines set actual_amount=180, actual_recorded_at=now() where id=$1`, [l2]);
    const sql = (await c.query(
      `select measured_line_count, bias_total, absolute_error_total, mape
       from public.forecast_accuracy where forecast_id=$1`, [f])).rows[0];
    const raw = (await c.query(
      `select amount, actual_amount from public.forecast_lines
       where forecast_id=$1 and actual_amount is not null`, [f])).rows;
    return { sql, ts: accuracy(raw.map((r) => ({ forecast: r.amount, actual: r.actual_amount }))) };
  });
  record("ÖLÇÜLMEMİŞ satır doğruluk KPI'sına girmiyor (mükemmel sayılmıyor)",
    Number(acc.sql.measured_line_count) === 2,
    `${acc.sql.measured_line_count} ölçülmüş satır (3 satırdan)`);
  record("SQL doğruluk KPI'ları ile TS accuracy() BİREBİR aynı",
    Number(acc.sql.bias_total) === acc.ts.biasTotal
      && Number(acc.sql.absolute_error_total) === acc.ts.absoluteErrorTotal
      && Number(acc.sql.mape) === acc.ts.mape,
    `SQL bias=${acc.sql.bias_total} mape=${acc.sql.mape} — TS bias=${acc.ts.biasTotal} mape=${acc.ts.mape}`);

  /* ── 7. source classification ───────────────────────────────────────────────────────── */
  const sourceCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.forecast_lines'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='source_kind'`);
  const kinds = new Set([...(sourceCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("source_kind tam olarak plandaki beş sınıfı sayıyor",
    sourceCheck.length === 1 && kinds.size === 5 && SOURCE_KINDS.every((k) => kinds.has(k)),
    [...kinds].sort().join(", "));
  record("varsayılan güven skorları kaynak güvenilirliğine göre sıralı",
    SOURCE_CONFIDENCE.contracted > SOURCE_CONFIDENCE.scheduled
      && SOURCE_CONFIDENCE.scheduled > SOURCE_CONFIDENCE.historical
      && SOURCE_CONFIDENCE.historical > SOURCE_CONFIDENCE.manual
      && SOURCE_CONFIDENCE.manual > SOURCE_CONFIDENCE.estimated,
    `contracted=${SOURCE_CONFIDENCE.contracted} ... estimated=${SOURCE_CONFIDENCE.estimated}`);

  /* ── 8. THE REINFORCEMENT: the LLM stays out of the forecast chain ──────────────────── */
  const rulesSrc = readFileSync(path.join(process.cwd(), "src/lib/budget/rules.ts"), "utf8");
  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/budget/engine.ts"), "utf8");
  const aiImport = (src: string) =>
    /(^|\s)import\s[^;]*["']@\/lib\/ai[^"']*["']/m.test(codeOnly(src))
    || /import\s*\(\s*["']@\/lib\/ai/.test(codeOnly(src));
  record("bütçe/tahmin KURALLARI @/lib/ai'yi import ETMİYOR",
    !aiImport(rulesSrc), "forecast matematiği LLM zincirinin tamamen dışında");
  record("bütçe/tahmin MOTORU @/lib/ai'yi import ETMİYOR",
    !aiImport(engineSrc), "tek yönlü bağımlılık: AI katmanı çıktıyı okuyabilir, tersi değil");
  record("ai/engine.ts'in 'önce deterministik' sınırı bozulmadı",
    /buildDeterministicAnswer/.test(readFileSync(path.join(process.cwd(), "src/lib/ai/engine.ts"), "utf8")),
    "Faz 12 mimarisi yerinde");
  record("forecast matematiğinde Python/dış çözücü yok",
    !/child_process|spawn\(|exec\(|python/i.test(codeOnly(rulesSrc + engineSrc)),
    "Çözülen Karar #2: hesaplama TS/SQL'de kalır");

  const FLOAT_CAST = `::${"float"}8`;
  const sources = [
    "supabase/migrations/0068_budgets.sql", "supabase/migrations/0069_forecasts.sql",
    "supabase/migrations/0070_budget_forecast_views.sql",
    "src/lib/budget/rules.ts", "src/lib/budget/engine.ts",
  ];
  const offenders = sources.filter((f) => codeOnly(readFileSync(path.join(process.cwd(), f), "utf8")).includes(FLOAT_CAST));
  record(`yeni bütçe/tahmin kaynaklarının hiçbirinde ${FLOAT_CAST} yok`,
    offenders.length === 0, offenders.length === 0 ? `${sources.length} dosya temiz` : offenders.join(", "));
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");

  /* ── 9. Faz 24B rol matrisi ─────────────────────────────────────────────────────────── */
  const newTables = ["budgets", "budget_lines", "forecasts", "forecast_lines"];
  const unclassified = newTables.filter((t) => TABLE_CLASS[t] === undefined);
  record("dört yeni tablo da kod matrisinde sınıflandırılmış",
    unclassified.length === 0,
    unclassified.length === 0 ? newTables.map((t) => `${t}=${TABLE_CLASS[t]}`).join(" ") : unclassified.join(", "));

  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicies = await q(
    `select tablename, roles::text[] as roles from pg_policies
     where schemaname='public' and cmd='SELECT' and tablename = any($1::text[])`, [newTables]);
  record("dört tablonun da SELECT politikası tam beş katmanı hedefliyor",
    selPolicies.length === 4 && selPolicies.every((p) => [...(p.roles as string[])].sort().join(",") === tierRoles),
    `${selPolicies.length}/4`);
  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename = any($1::text[]) and 'authenticated' = any(roles::text[])`,
    [newTables]);
  record("yeni tablolara blanket deseni geri getirilmemiş", Number(blanket[0].n) === 0, `${blanket[0].n} adet`);

  /* ── 10. the department gap, recorded rather than hidden ────────────────────────────── */
  const deptLink = await q(
    `select count(*)::int n from information_schema.columns
     where table_schema='public' and column_name='department_id'
       and table_name in ('invoices','invoice_lines','payments','payment_instances','bank_transactions')`);
  record("ÖLÇÜLDÜ: hiçbir işlem tablosunda department_id yok — departman gerçekleşeni UYDURULMUYOR",
    Number(deptLink[0].n) === 0,
    "0070 departman bütçesini yazdırıyor ama gerçekleşeni NULL bırakıyor, tahsis kuralı icat etmiyor");

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0068-0070 eklenmedi)",
    !/00(68|69|70)/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE28 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE28 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE28 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
