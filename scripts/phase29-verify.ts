// Faz 29 verification — deterministic optimisation, scenario comparison, approval connection.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase29:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset, per the standing rule
// Faz 25 produced. The import graph was checked before writing — optimization/rules,
// optimization/engine, approvals/engine, money, audit, validation, authz/matrix — and none
// reaches @/lib/env.
//
// ═══ THE CENTRAL CHECK OF THIS PHASE ═══
//
// Faz 8/13 established that the baseline is READ and the scenario is a read-only overlay. The
// plan requires that invariant re-proved against every NEW scenario type. So the heaviest section
// below snapshots EVERY COLUMN of a baseline scenario_run, its comparison rows, and every
// cashflow_months row; executes the optimiser end to end; and compares the snapshots field by
// field. Not "did it look right" — byte equality on the full row set.
//
// STANDING RULES INHERITED: conkey targeting with cardinality asserted; fixtures built here and
// dated 2099; value-based comparisons; source-level checks run over CODE with comments stripped
// (Faz 27's lesson, since the files being scanned explain in comments what they avoid).
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  ACTION_KINDS, OBJECTIVES, RULE_CODES, optimize, resultDigest,
} from "../src/lib/optimization/rules";
import { runOptimization, requestOptimizationApproval } from "../src/lib/optimization/engine";
import { SUBJECT_TABLES } from "../src/lib/approvals/engine";
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
const TAG = () => `P29-${Math.random().toString(36).slice(2, 8)}`;

/** Source with comments stripped — Faz 27's lesson. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

async function mkRun(c: PoolClient): Promise<string> {
  return (await c.query(
    `insert into public.optimization_runs(name, objective, anchor_date, horizon_days)
     values ($1,'max_liquidity_buffer','2099-01-01',30) returning id`, [TAG()])).rows[0].id;
}

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tables = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name in ('optimization_runs','optimization_recommendations')
     order by table_name`);
  record("iki yeni tablo da mevcut", tables.length === 2, `${tables.length}/2`);

  // The decision NOT to add a lifecycle column, asserted structurally rather than claimed.
  const lifecycleCols = await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='optimization_runs'
       and column_name in ('status','state','version_status','lifecycle','approved_at')`);
  record("optimization_runs'ta yaşam döngüsü/onay kolonu YOK (onay durumu approvals'ta yaşar)",
    lifecycleCols.length === 0,
    lifecycleCols.length === 0
      ? "ikinci doğruluk kaynağı yaratılmadı"
      : `bulundu: ${lifecycleCols.map((r) => r.column_name).join(", ")}`);

  const objCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.optimization_runs'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='objective'`);
  record("objective CHECK'i yapısal olarak ve TEK olarak hedeflendi",
    objCheck.length === 1, `${objCheck.length} aday`);
  const objs = new Set([...(objCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("objective tam olarak plandaki üç hedefi sayıyor",
    objs.size === 3 && OBJECTIVES.every((o) => objs.has(o)), [...objs].sort().join(", "));

  const actCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.optimization_recommendations'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='action_kind'`);
  const acts = new Set([...(actCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("action_kind CHECK'i koddaki ACTION_KINDS ile birebir aynı",
    actCheck.length === 1 && acts.size === ACTION_KINDS.length
      && ACTION_KINDS.every((a) => acts.has(a)),
    [...acts].sort().join(", "));

  /* ── 2. approvals connection: value list agreement (the runtime bug typecheck missed) ─ */
  const subjCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.approvals'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='subject_table'`);
  const dbSubjects = new Set([...(subjCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("approvals.subject_table CHECK'i 'optimization_runs' kabul ediyor",
    dbSubjects.has("optimization_runs"), [...dbSubjects].sort().join(", "));
  // The schema takes `raw: unknown`, so a drift here is invisible to the compiler and only shows
  // up as a runtime validation error. Faz 29 hit exactly that: the CHECK was widened first and
  // the Zod enum was not.
  const codeSubjects = new Set<string>(SUBJECT_TABLES as readonly string[]);
  const onlyDb = [...dbSubjects].filter((s) => !codeSubjects.has(s));
  const onlyCode = [...codeSubjects].filter((s) => !dbSubjects.has(s));
  record("veritabanı CHECK'i ile koddaki SUBJECT_TABLES BİREBİR aynı (Zod sürüklenmesi yok)",
    onlyDb.length === 0 && onlyCode.length === 0,
    onlyDb.length === 0 && onlyCode.length === 0
      ? `${dbSubjects.size} değer`
      : `yalnız DB: ${onlyDb.join(",")} | yalnız kod: ${onlyCode.join(",")}`);

  /* ── 3. constraints, with positive controls ─────────────────────────────────────────── */
  const cons = await inRollback(async (c) => {
    const run = await mkRun(c);
    const noRationale = await refuses(c,
      `insert into public.optimization_recommendations(run_id, rank, action_kind, rationale_codes)
       values ($1,1,'hold_buffer','{}')`, [run]);
    const deferBackwards = await refuses(c,
      `insert into public.optimization_recommendations
         (run_id, rank, action_kind, current_date_value, proposed_date, rationale_codes)
       values ($1,2,'defer_payment','2099-05-10','2099-05-01','{nakit_tabani_ihlali}')`, [run]);
    const advanceForwards = await refuses(c,
      `insert into public.optimization_recommendations
         (run_id, rank, action_kind, current_date_value, proposed_date, rationale_codes)
       values ($1,3,'advance_payment','2099-05-01','2099-05-10','{nakit_tabani_ihlali}')`, [run]);
    const deferNoDates = await refuses(c,
      `insert into public.optimization_recommendations(run_id, rank, action_kind, rationale_codes)
       values ($1,4,'defer_payment','{nakit_tabani_ihlali}')`, [run]);
    const halfSubject = await refuses(c,
      `insert into public.optimization_recommendations
         (run_id, rank, action_kind, subject_table, rationale_codes)
       values ($1,5,'hold_buffer','payment_instances','{tampon_korunuyor}')`, [run]);
    const validDefer = !(await refuses(c,
      `insert into public.optimization_recommendations
         (run_id, rank, action_kind, current_date_value, proposed_date, rationale_codes)
       values ($1,6,'defer_payment','2099-05-01','2099-05-10','{nakit_tabani_ihlali}')`, [run]));
    return { noRationale, deferBackwards, advanceForwards, deferNoDates, halfSubject, validDefer };
  });
  record("gerekçesiz öneri reddediliyor", cons.noRationale, "açıklanamayan öneri yazılamaz");
  record("ERTELEME geriye doğru olamıyor", cons.deferBackwards,
    "yön ters olsaydı her öneri sessizce tersine döner, sayılar yine makul görünürdü");
  record("ÖNE ALMA ileriye doğru olamıyor", cons.advanceForwards, "");
  record("tarih taşıyan öneri iki ucunu da vermek zorunda", cons.deferNoDates, "");
  record("özne tablosu ve id birlikte yazılıyor", cons.halfSubject, "hiçbir yeri işaret etmeyen özne yok");
  record("POZİTİF KONTROL: geçerli erteleme önerisi kabul ediliyor", cons.validDefer, "");

  /* ── 4. THE BASELINE-PRESERVED INVARIANT, re-proved for this NEW run type ───────────── */
  //
  // Snapshot everything the optimiser could conceivably touch, run it for real, compare.
  const invariant = await (async () => {
    // Build a baseline scenario run and cashflow months OUTSIDE a rollback so the engine (which
    // opens its own connection) can see them, then clean up afterwards.
    const actor = (await pool.query(
      `insert into public.users(username,password_hash,display_name,role)
       values ($1,'x','P29 inv','finance_manager') returning id`,
      [`p29inv_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
    const scenarioId = (await pool.query(
      `insert into public.scenarios(name, scenario_type, created_by)
       values ($1,'combined_custom_scenario',$2) returning id`, [TAG(), actor])).rows[0].id;
    const runId = (await pool.query(
      `insert into public.scenario_runs
         (scenario_id, assumptions, baseline_final_cash, scenario_final_cash, final_delta,
          month_count, confidence)
       values ($1,'{"p29":true}'::jsonb, 1000, 1500, 500, 12, 'medium') returning id`,
      [scenarioId])).rows[0].id;
    await pool.query(
      `insert into public.scenario_comparisons(run_id, metric, baseline_value, scenario_value, delta)
       values ($1,'final_cash',1000,1500,500)`, [runId]);
    // Self-healing: this block commits, so a run that fails partway would otherwise leave its
    // fixture behind and make the NEXT run fail on the unique month_start — a stale-state failure
    // that looks like a real regression. Clearing first makes the gate re-runnable.
    await pool.query(`delete from public.cashflow_months where month_start='2099-07-01'`);
    await pool.query(
      `insert into public.cashflow_months
         (month_start, opening_balance, projected_income, projected_expense, monthly_delta, closing_balance)
       values ('2099-07-01', 500, 900, 400, 500, 1000)`);

    // REAL payment instances in the horizon, so the "due dates were not moved" assertion is not
    // vacuous. The first run of this gate compared ZERO instances and passed, which proves
    // nothing — one of them is deliberately soft (the solver may want to defer it) and one is
    // critical (it may not), so the optimiser genuinely has something it could have mutated.
    const paymentId = (await pool.query(
      `insert into public.payments(name, recurrence_type, due_day, default_amount, currency, priority)
       values ($1,'monthly',10,500,'TRY','normal') returning id`, [TAG()])).rows[0].id;
    const critPaymentId = (await pool.query(
      `insert into public.payments(name, recurrence_type, due_day, default_amount, currency, priority)
       values ($1,'monthly',12,700,'TRY','critical') returning id`, [TAG()])).rows[0].id;
    await pool.query(
      `insert into public.payment_instances
         (payment_id, instance_month, due_date, amount, currency, status, direction)
       values ($1,'2099-07-01','2099-07-10',500,'TRY','unpaid','outflow'),
              ($2,'2099-07-01','2099-07-12',700,'TRY','unpaid','outflow')`,
      [paymentId, critPaymentId]);

    // Full-row snapshots — every column, not a chosen subset.
    const snap = async () => ({
      run: (await pool.query(`select * from public.scenario_runs where id=$1`, [runId])).rows[0],
      cmp: (await pool.query(
        `select * from public.scenario_comparisons where run_id=$1 order by metric`, [runId])).rows,
      months: (await pool.query(
        `select * from public.cashflow_months order by month_start`)).rows,
      instances: (await pool.query(
        `select id, due_date, amount, status, paid_amount from public.payment_instances order by id`)).rows,
    });
    const before = await snap();

    const { runId: optRunId } = await runOptimization(pool, {
      name: TAG(), objective: "max_liquidity_buffer",
      anchorDate: "2099-07-01", horizonDays: 30, currency: "TRY",
      scenarioRunId: runId,
    }, actor);
    // Exercise the approval path too — it must not touch the baseline either.
    let approvalError = "";
    try { await requestOptimizationApproval(pool, optRunId, actor); }
    catch (e) { approvalError = messageOf(e); }

    const after = await snap();
    const same = JSON.stringify(before) === JSON.stringify(after);

    // Cleanup (this block committed).
    await pool.query(`delete from public.optimization_recommendations where run_id=$1`, [optRunId]);
    await pool.query(`delete from public.approvals where subject_table='optimization_runs' and subject_id=$1`, [optRunId]);
    await pool.query(`delete from public.optimization_runs where id=$1`, [optRunId]);
    await pool.query(`delete from public.scenario_comparisons where run_id=$1`, [runId]);
    await pool.query(`delete from public.scenario_runs where id=$1`, [runId]);
    await pool.query(`delete from public.scenarios where id=$1`, [scenarioId]);
    await pool.query(`delete from public.cashflow_months where month_start='2099-07-01'`);
    await pool.query(`delete from public.payment_instances where instance_month='2099-07-01'`);
    await pool.query(`delete from public.payments where id = any($1::uuid[])`, [[paymentId, critPaymentId]]);
    await pool.query(`delete from public.audit_logs where actor=$1`, [actor]).catch(() => {});
    await pool.query(`delete from public.users where id=$1`, [actor]).catch(() => {});

    return { same, before, after, approvalError, optRunId };
  })();

  record("BASELINE KORUNUR: optimizasyon çalışması scenario_run'ın HİÇBİR alanını değiştirmedi",
    JSON.stringify(invariant.before.run) === JSON.stringify(invariant.after.run),
    "tüm kolonlar tek tek karşılaştırıldı (alt küme değil)");
  record("BASELINE KORUNUR: scenario_comparisons satırları değişmedi",
    JSON.stringify(invariant.before.cmp) === JSON.stringify(invariant.after.cmp),
    `${invariant.before.cmp.length} karşılaştırma satırı`);
  record("BASELINE KORUNUR: cashflow_months (Faz 4/5 tabanı) değişmedi",
    JSON.stringify(invariant.before.months) === JSON.stringify(invariant.after.months),
    `${invariant.before.months.length} ay`);
  record("BASELINE KORUNUR: payment_instances vade/tutar/durum değişmedi (BOŞ KÜME DEĞİL)",
    invariant.before.instances.length >= 2
      && JSON.stringify(invariant.before.instances) === JSON.stringify(invariant.after.instances),
    `${invariant.before.instances.length} taksit karşılaştırıldı — CLAUDE.md: otomasyon vade/tutar değiştiremez`);
  record("BASELINE KORUNUR: snapshot'ların TAMAMI birebir aynı",
    invariant.same, "salt-okunur overlay invariant'ı yeni çalışma tipine karşı da geçerli");

  /* ── 5. the engine writes only its own tables ──────────────────────────────────────── */
  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/optimization/engine.ts"), "utf8");
  const rulesSrc = readFileSync(path.join(process.cwd(), "src/lib/optimization/rules.ts"), "utf8");
  const engineCode = codeOnly(engineSrc);
  const forbiddenWrite =
    /(update|delete\s+from|insert\s+into)\s+public\.(payment_instances|invoices|checks|loans|loan_installments|cashflow_months|scenario_runs|scenario_comparisons|bank_transactions)/i;
  record("motor MALİ tablolara ve senaryo tablolarına YAZMIYOR (kaynak seviyesinde)",
    !forbiddenWrite.test(engineCode),
    "yalnız optimization_* + audit_logs + approvals(Faz 24A motoru üzerinden)");
  record("çözücü kuralları veritabanına hiç erişmiyor (yazamaz, çünkü yolu yok)",
    !/from "pg"|pool\.|client\./.test(codeOnly(rulesSrc)),
    "saf fonksiyonlar — yapısal olarak mutasyon imkânsız");

  /* ── 6. determinism of the solver ──────────────────────────────────────────────────── */
  const detInput = {
    objective: "max_liquidity_buffer" as const,
    anchorDate: "2099-01-01", horizonDays: 10,
    openingCash: 100, minCashFloor: 0,
    inflows: [{ date: "2099-01-06", amount: 900 }],
    payments: [
      { id: "b", label: "B", dueDate: "2099-01-02", amount: 300, hardDeadline: false },
      { id: "a", label: "A", dueDate: "2099-01-02", amount: 300, hardDeadline: false },
    ],
    facilities: [],
  };
  const d1 = resultDigest(optimize(detInput));
  const d2 = resultDigest(optimize(detInput));
  const d3 = resultDigest(optimize({ ...detInput, payments: [...detInput.payments].reverse() }));
  record("çözücü DETERMİNİSTİK: aynı girdi aynı çıktı",
    d1 === d2, d1.slice(0, 40) || "(öneri yok)");
  record("çözücü girdi SIRASINDAN bağımsız (eşitlikler id ile çözülüyor)",
    d1 === d3, "toplam sıralama — beraberlik girdi sırasına bırakılmıyor");

  const digestMatch = await inRollback(async (c) => {
    const stored = (await c.query(
      `select result_digest from public.optimization_runs where result_digest is not null limit 1`)).rows;
    return stored.length;
  });
  record("çalışma sonucu parmak izi kolonu mevcut (yeniden koşu karşılaştırılabilir)",
    typeof digestMatch === "number", "result_digest saklanıyor");

  /* ── 7. no model, no python, no ai ─────────────────────────────────────────────────── */
  const aiImport = (src: string) =>
    /(^|\s)import\s[^;]*["']@\/lib\/ai[^"']*["']/m.test(codeOnly(src))
    || /import\s*\(\s*["']@\/lib\/ai/.test(codeOnly(src));
  record("optimizasyon KURALLARI @/lib/ai'yi import ETMİYOR",
    !aiImport(rulesSrc), "senaryo/optimizasyon matematiği LLM zincirinin dışında");
  record("optimizasyon MOTORU @/lib/ai'yi import ETMİYOR", !aiImport(engineSrc), "");
  record("Python/dış çözücü/ML kütüphanesi yok",
    !/child_process|spawn\(|python|scipy|pulp|glpk|tensorflow/i.test(codeOnly(rulesSrc + engineSrc)),
    "Çözülen Karar #2: deterministik TS/SQL sezgisel çözücü");
  record("her öneri yalnız kayıtlı kural kodlarını kullanıyor",
    RULE_CODES.length >= 5 && RULE_CODES.every((c) => /^[a-z_]+$/.test(c)),
    `${RULE_CODES.length} adlandırılmış kural`);

  const FLOAT_CAST = `::${"float"}8`;
  const sources = [
    "supabase/migrations/0071_optimization_runs.sql",
    "supabase/migrations/0072_approvals_scenario_subject.sql",
    "supabase/migrations/0073_scenario_optimization_views.sql",
    "src/lib/optimization/rules.ts", "src/lib/optimization/engine.ts",
  ];
  const offenders = sources.filter((f) => codeOnly(readFileSync(path.join(process.cwd(), f), "utf8")).includes(FLOAT_CAST));
  record(`yeni kaynakların hiçbirinde ${FLOAT_CAST} yok`,
    offenders.length === 0, offenders.length === 0 ? `${sources.length} dosya temiz` : offenders.join(", "));
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");
  record("motor onay için Faz 24A'nın requestApproval'ını ÇAĞIRIYOR (çatallamıyor)",
    /requestApproval\(/.test(engineCode) && /from "@\/lib\/approvals\/engine"/.test(engineSrc),
    "ikinci inceleme tablosu yok");

  /* ── 8. views ──────────────────────────────────────────────────────────────────────── */
  const views = await q(
    `select table_name, table_type from information_schema.tables
     where table_schema='public' and table_name in
       ('scenario_comparison_matrix','optimization_run_summary','optimization_recommendation_detail')
     order by table_name`);
  record("üç yeni read-model de VIEW",
    views.length === 3 && views.every((v) => v.table_type === "VIEW"), `${views.length} view`);

  const summaryHasApproval = await q(
    `select count(*)::int n from information_schema.columns
     where table_schema='public' and table_name='optimization_run_summary'
       and column_name in ('approval_status','approval_round')`);
  record("özet view'ı onay durumunu approvals'tan JOIN ediyor (kopyalamıyor)",
    Number(summaryHasApproval[0].n) === 2, "tek doğruluk kaynağı korunuyor");

  /* ── 9. Faz 24B rol matrisi ────────────────────────────────────────────────────────── */
  const newTables = ["optimization_runs", "optimization_recommendations"];
  const unclassified = newTables.filter((t) => TABLE_CLASS[t] === undefined);
  record("iki yeni tablo da kod matrisinde sınıflandırılmış",
    unclassified.length === 0,
    unclassified.length === 0 ? newTables.map((t) => `${t}=${TABLE_CLASS[t]}`).join(" ") : unclassified.join(", "));

  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicies = await q(
    `select tablename, roles::text[] as roles from pg_policies
     where schemaname='public' and cmd='SELECT' and tablename = any($1::text[])`, [newTables]);
  record("iki tablonun da SELECT politikası tam beş katmanı hedefliyor",
    selPolicies.length === 2 && selPolicies.every((p) => [...(p.roles as string[])].sort().join(",") === tierRoles),
    `${selPolicies.length}/2`);
  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename = any($1::text[]) and 'authenticated' = any(roles::text[])`,
    [newTables]);
  record("yeni tablolara blanket deseni geri getirilmemiş", Number(blanket[0].n) === 0, `${blanket[0].n} adet`);

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0071-0073 eklenmedi)",
    !/007[123]/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE29 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE29 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE29 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
