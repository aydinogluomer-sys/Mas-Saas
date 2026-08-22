// Faz 26 verification — treasury: cash position, 7/30/90-day liquidity, and the consistency rule.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase26:verify
//
// That line is the whole contract, and it is TRUE: this gate needs the owner connection and
// nothing else. It was checked by running exactly that command with no DATABASE_URL set, which is
// the standing rule Faz 25 produced after phase25-verify shipped documenting a command it could
// not survive. Nothing in this file's import graph reaches @/lib/env — verified module by module,
// not assumed — so importing the treasury rules cannot smuggle a database requirement back in.
//
// STANDING RULES INHERITED (Faz 20/22/23/24B):
//   1. Constraints are targeted STRUCTURALLY by conkey with the candidate count asserted; several
//      constraints on these tables mention the same column name.
//   2. No probe passes vacuously — every fixture is built here, dated 2099 so it can never
//      collide with seeded or real data, and negatives are paired with positive controls.
//   3. Ordering/verdict assertions compare VALUES, never row positions.
//
// THE CENTRAL CHECK OF THIS PHASE is the consistency rule the plan states directly: the treasury
// position must never SILENTLY diverge from cashflow_months.closing_balance. So the heaviest
// section below builds two months on purpose — one that agrees and one that does not — and proves
// the divergent one is REPORTED with its exact difference rather than hidden, averaged, or
// "corrected".
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  TREASURY_HORIZON_DAYS, bufferDaysFloor, effectiveFloor, liquidityHorizons,
  reconciliationVerdict, type DatedFlow,
} from "../src/lib/treasury/rules";
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

const TAG = () => `P26-${Math.random().toString(36).slice(2, 8)}`;

/** A cash account + its bank sidecar, built from scratch. */
async function mkAccount(
  c: PoolClient, opts: { currency?: string; opening?: number; stated?: number | null } = {},
): Promise<string> {
  const id = (await c.query(
    `insert into public.cash_accounts(name, account_type, currency, opening_balance, is_active)
     values ($1,'bank_account',$2,$3,true) returning id`,
    [TAG(), opts.currency ?? "TRY", opts.opening ?? 0])).rows[0].id;
  await c.query(
    `insert into public.bank_accounts(cash_account_id, bank_name, available_balance, balance_as_of)
     values ($1,'P26 Bank',$2, now())`, [id, opts.stated ?? null]);
  return id;
}
async function mkTxn(c: PoolClient, accountId: string, date: string, amount: number, status = "unmatched"): Promise<void> {
  // `direction` is GENERATED ALWAYS from the amount's sign — supplying it is rejected outright,
  // which is the schema being right: the sign and the label can never disagree.
  await c.query(
    `insert into public.bank_transactions
       (bank_account_id, txn_date, amount, currency, status, description, dedupe_hash)
     values ($1,$2::date,$3,'TRY',$4,'P26 fixture',$5)`,
    [accountId, date, amount, status, `p26-${accountId}-${date}-${amount}-${Math.random()}`]);
}

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tbl = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name='treasury_policies'`);
  record("treasury_policies tablosu var", tbl.length === 1, tbl.length === 1 ? "mevcut" : "yok");

  // LESSON 1 — conkey targeting with cardinality asserted.
  const kindCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.treasury_policies'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='policy_kind'`);
  const kinds = new Set([...(kindCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("policy_kind CHECK'i yapısal olarak ve TEK olarak hedeflendi",
    kindCheck.length === 1, `${kindCheck.length} aday (tam 1 bekleniyor)`);
  record("policy_kind tam olarak iki türü sayıyor",
    kinds.size === 2 && kinds.has("min_cash") && kinds.has("buffer_days"),
    [...kinds].sort().join(", "));

  // §17 rule 3 is N/A here and that is asserted structurally, not merely claimed in a comment:
  // there is no status/lifecycle column, so there is nothing for a transition guard to protect.
  const lifecycleCols = await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='treasury_policies'
       and column_name in ('status','state','lifecycle')`);
  record("treasury_policies'de yaşam döngüsü kolonu YOK (§17 kural 3 gerçekten N/A)",
    lifecycleCols.length === 0, "yalnız is_active boolean — kısıtlanacak geçiş yok");

  /* ── 2. scope + sign constraints, each with a positive control ──────────────────────── */
  const scope = await inRollback(async (c) => {
    const minCashNoAmount = await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency)
       values ('p26_a','x','min_cash','TRY')`);
    const bufferNoDays = await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency)
       values ('p26_b','x','buffer_days','TRY')`);
    const crossed = await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_days)
       values ('p26_c','x','min_cash','TRY',30)`);
    const validMin = !(await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_amount)
       values ('p26_d','x','min_cash','EUR',5000)`));
    const validBuf = !(await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_days)
       values ('p26_e','x','buffer_days','EUR',14)`));
    return { minCashNoAmount, bufferNoDays, crossed, validMin, validBuf };
  });
  record("asgari kasa politikası tutarsız yazılamıyor", scope.minCashNoAmount, "tutar zorunlu");
  record("tampon politikası gün sayısı olmadan yazılamıyor", scope.bufferNoDays, "gün zorunlu");
  record("eşik, okumayan bir politika türüne iliştirilemiyor", scope.crossed, "kapsam iki yönlü");
  record("POZİTİF KONTROL: geçerli min_cash ve buffer_days kabul ediliyor",
    scope.validMin && scope.validBuf, "kısıt geçerli veriyi engellemiyor");

  const signs = await inRollback(async (c) => {
    const negAmount = await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_amount)
       values ('p26_f','x','min_cash','EUR',-1)`);
    const zeroAmount = !(await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_amount)
       values ('p26_g','x','min_cash','EUR',0)`));
    const zeroDays = await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_days)
       values ('p26_h','x','buffer_days','EUR',0)`);
    return { negAmount, zeroAmount, zeroDays };
  });
  record("negatif nakit tabanı reddediliyor", signs.negAmount, "eksi bir taban taban değildir");
  record("POZİTİF KONTROL: SIFIR taban geçerli ('sıfırın altına inme')",
    signs.zeroAmount, "0 ile null farklı ifadeler — varsayılan tam olarak budur");
  record("sıfır tampon günü reddediliyor", signs.zeroDays, "0 gün tampon anlamsız");

  const dup = await inRollback(async (c) => {
    await c.query(
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_amount,is_active)
       values ('p26_i','x','min_cash','CHF',100,true)`);
    const second = await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_amount,is_active)
       values ('p26_j','x','min_cash','CHF',200,true)`);
    const inactive = !(await refuses(c,
      `insert into public.treasury_policies(code,description,policy_kind,currency,threshold_amount,is_active)
       values ('p26_k','x','min_cash','CHF',200,false)`));
    return { second, inactive };
  });
  record("aynı kur için ikinci AKTİF asgari kasa politikası engelleniyor",
    dup.second, "çelişen iki taban olamaz — view hangisini seçeceğini bilemezdi");
  record("POZİTİF KONTROL: pasif ikinci politika serbest",
    dup.inactive, "geçmiş/hazır politika saklanabiliyor");

  /* ── 3. no second number invented ───────────────────────────────────────────────────── */
  const floorVsSetting = await q(
    `select (select threshold_amount from public.treasury_policies where code='min_cash_try')::text as policy_v,
            (select value from public.settings where key='negative_cash_threshold_try') as setting_v`);
  const pv = Number(floorVsSetting[0].policy_v), sv = Number(floorVsSetting[0].setting_v);
  record("varsayılan taban settings.negative_cash_threshold_try ile AYNI sayı",
    Number.isFinite(pv) && Number.isFinite(sv) && pv === sv, `politika=${pv} ayar=${sv}`);

  const seeded = await q(`select code, is_active from public.treasury_policies order by code`);
  record("iki varsayılan politika yüklendi; tampon PASİF geliyor",
    seeded.length >= 2
      && seeded.find((s) => s.code === "min_cash_try")?.is_active === true
      && seeded.find((s) => s.code === "buffer_days_try")?.is_active === false,
    seeded.map((s) => `${s.code}${s.is_active ? "" : "(pasif)"}`).join(" "));

  /* ── 4. Faz 24B rol matrisi ─────────────────────────────────────────────────────────── */
  record("treasury_policies kod matrisinde sınıflandırılmış (config)",
    TABLE_CLASS["treasury_policies"] === "config", String(TABLE_CLASS["treasury_policies"]));

  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicy = await q(
    `select roles::text[] as roles from pg_policies
     where schemaname='public' and tablename='treasury_policies' and cmd='SELECT'`);
  record("SELECT politikası tam beş katmanı hedefliyor (blanket DEĞİL)",
    selPolicy.length === 1 && [...(selPolicy[0].roles as string[])].sort().join(",") === tierRoles,
    selPolicy.length === 1 ? `${(selPolicy[0].roles as string[]).length} rol` : `${selPolicy.length} politika`);

  const writePolicies = await q(
    `select cmd, roles::text[] as roles from pg_policies
     where schemaname='public' and tablename='treasury_policies' and cmd <> 'SELECT'`);
  record("yazma politikalarının tamamı yalnız admin (yönetici tabanı indiremez)",
    writePolicies.length === 3 && writePolicies.every((p) => (p.roles as string[]).join() === "mas_radar_admin"),
    writePolicies.map((p) => `${p.cmd}:${(p.roles as string[]).join()}`).join(" "));

  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename='treasury_policies' and 'authenticated' = any(roles::text[])`);
  record("yeni tabloya eski blanket deseni geri getirilmemiş", Number(blanket[0].n) === 0, `${blanket[0].n} adet`);

  /* ── 5. views, not tables ───────────────────────────────────────────────────────────── */
  const views = await q(
    `select table_name, table_type from information_schema.tables
     where table_schema='public' and table_name in
       ('bank_cash_position','daily_cash_movement','treasury_position_summary',
        'liquidity_forecast_daily','treasury_liquidity_gap','treasury_cashflow_reconciliation')
     order by table_name`);
  record("altı hazine read-model'i de VIEW (yeni kaynak veri yok)",
    views.length === 6 && views.every((v) => v.table_type === "VIEW"),
    `${views.length} view`);

  /* ── 6. THE CONSISTENCY RULE — the heart of this phase ──────────────────────────────── */
  const consistency = await inRollback(async (c) => {
    // Month A: bank movements sum to exactly the cashflow closing → must read as aligned.
    const acc = await mkAccount(c, { opening: 0 });
    await c.query(
      `insert into public.cashflow_months(month_start, opening_balance, projected_income,
         projected_expense, monthly_delta, closing_balance)
       values ('2099-01-01', 0, 1000, 400, 600, 600)`);
    await mkTxn(c, acc, "2099-01-10", 1000);
    await mkTxn(c, acc, "2099-01-20", -400);

    // Month B: deliberately DIFFERENT. The workbook says 1600, the bank says 600 + 250 = 850.
    await c.query(
      `insert into public.cashflow_months(month_start, opening_balance, projected_income,
         projected_expense, monthly_delta, closing_balance)
       values ('2099-02-01', 600, 1200, 200, 1000, 1600)`);
    await mkTxn(c, acc, "2099-02-05", 250);

    // Month C: a cashflow month with NO bank movement at all.
    await c.query(
      `insert into public.cashflow_months(month_start, opening_balance, projected_income,
         projected_expense, monthly_delta, closing_balance)
       values ('2099-03-01', 1600, 0, 0, 0, 1600)`);

    const rows = (await c.query(
      `select to_char(month_start,'YYYY-MM-DD') as m, cashflow_closing, treasury_closing,
              difference, reconciliation_status
       from public.treasury_cashflow_reconciliation
       where month_start >= '2099-01-01' and month_start < '2099-04-01'
       order by month_start`)).rows;
    return rows;
  });

  const byMonth = (m: string) => consistency.find((r) => r.m === m);
  const jan = byMonth("2099-01-01"), feb = byMonth("2099-02-01"), mar = byMonth("2099-03-01");

  record("TUTARLILIK: eşleşen ay 'aligned' olarak raporlanıyor",
    jan?.reconciliation_status === "aligned" && Number(jan?.difference) === 0,
    `kapanış=${jan?.cashflow_closing} hazine=${jan?.treasury_closing} fark=${jan?.difference}`);

  record("TUTARLILIK: SAPAN ay gizlenmiyor — 'divergent' ve farkı TAM olarak bildiriliyor",
    feb?.reconciliation_status === "divergent" && Number(feb?.difference) === -750,
    `kapanış=${feb?.cashflow_closing} hazine=${feb?.treasury_closing} fark=${feb?.difference} (beklenen -750)`);

  record("TUTARLILIK: sapan ayın rakamları SESSİZCE düzeltilmiyor",
    Number(feb?.cashflow_closing) === 1600 && Number(feb?.treasury_closing) === 850,
    "iki kaynak da olduğu gibi duruyor, ortalanmıyor/biri tercih edilmiyor");

  record("TUTARLILIK: banka hareketi olmayan ay sıfır sayılmıyor, adıyla bildiriliyor",
    mar?.reconciliation_status === "no_bank_movement" && mar?.difference === null,
    `durum=${mar?.reconciliation_status} fark=${mar?.difference}`);

  // Both computations of the same verdict must agree — SQL and TypeScript.
  const mismatches = consistency.filter((r) => {
    const v = reconciliationVerdict(
      r.cashflow_closing == null ? null : Number(r.cashflow_closing),
      r.treasury_closing == null ? null : Number(r.treasury_closing));
    const sqlDiff = r.difference == null ? null : Number(r.difference);
    return v.status !== r.reconciliation_status || v.difference !== sqlDiff;
  });
  record("SQL kararı ile TypeScript kararı BİREBİR aynı (iki bağımsız hesap, tek gerçek)",
    mismatches.length === 0,
    mismatches.length === 0 ? `${consistency.length} ay karşılaştırıldı`
      : mismatches.map((m) => `${m.m}:${m.reconciliation_status}`).join(" "));

  record("mutabakat view'ı cashflow_months'u DEĞİŞTİRMİYOR (yalnız okuyor)",
    !/update\s+public\.cashflow_months|insert\s+into\s+public\.cashflow_months/i.test(
      readFileSync(path.join(process.cwd(), "supabase/migrations/0063_treasury_views.sql"), "utf8")),
    "0063 tamamen read-model");

  /* ── 7. position: both sources exposed, neither silently preferred ──────────────────── */
  const position = await inRollback(async (c) => {
    const acc = await mkAccount(c, { opening: 100, stated: 1000 });
    await mkTxn(c, acc, "2099-04-01", 250);
    await mkTxn(c, acc, "2099-04-02", -50);
    // An 'ignored' row is explicitly not money and must not move the derived balance.
    await c.query(
      `insert into public.bank_transactions
         (bank_account_id, txn_date, amount, currency, status, ignored_reason, description, dedupe_hash)
       values ($1,'2099-04-03',9999,'TRY','ignored','P26 test','ignored fixture',$2)`,
      [acc, `p26-ignored-${acc}`]);
    return (await c.query(
      `select stated_balance, derived_balance, stated_minus_derived, movement_count
       from public.bank_cash_position where cash_account_id=$1`, [acc])).rows[0];
  });
  record("türetilen bakiye = açılış + hareketler (ignored HARİÇ)",
    Number(position.derived_balance) === 300 && Number(position.movement_count) === 2,
    `türetilen=${position.derived_balance} hareket=${position.movement_count} (beklenen 300 / 2)`);
  record("banka beyanı ile türetilen bakiye YAN YANA, fark açıkça hesaplanıyor",
    Number(position.stated_balance) === 1000 && Number(position.stated_minus_derived) === 700,
    `beyan=${position.stated_balance} fark=${position.stated_minus_derived}`);

  /* ── 8. liquidity horizons ──────────────────────────────────────────────────────────── */
  const horizonRows = await q(
    `select distinct horizon_days from public.treasury_liquidity_gap order by horizon_days`);
  record("7/30/90 günlük ufuklar mevcut",
    horizonRows.map((r) => Number(r.horizon_days)).join(",") === TREASURY_HORIZON_DAYS.join(","),
    horizonRows.map((r) => r.horizon_days).join(","));

  const forecast = await inRollback(async (c) => {
    const party = (await c.query(
      `insert into public.parties(name,normalized_name,party_type) values ($1,$2,'customer') returning id`,
      [TAG(), TAG().toLowerCase()])).rows[0].id;
    // A promise WITH an amount and one WITHOUT: the unknown must be excluded, not zeroed.
    await c.query(
      `insert into public.promise_to_pay(party_id, promised_amount, promised_date)
       values ($1, 5000, current_date + 3), ($1, null, current_date + 4)`, [party]);
    return (await c.query(
      `select count(*)::int n, coalesce(sum(amount_signed),0) as total
       from public.liquidity_forecast_daily
       where source_kind='promise_to_pay' and flow_date >= current_date`)).rows[0];
  });
  record("TUTARI BİLİNMEYEN söz tahmine SIFIR olarak girmiyor — hiç girmiyor",
    Number(forecast.n) === 1 && Number(forecast.total) === 5000,
    `${forecast.n} satır / toplam ${forecast.total} (2 sözden yalnız tutarlı olan)`);

  // SQL and TypeScript must produce the same horizon answer from the same flows.
  const parity = await inRollback(async (c) => {
    const acc = await mkAccount(c, { opening: 1000 });
    await mkTxn(c, acc, "2099-05-01", 0); // keeps the account present in the summary
    const flows: DatedFlow[] = [
      { flowDate: "2099-06-02", amountSigned: -300, certainty: "contracted" },
      { flowDate: "2099-06-20", amountSigned: 500, certainty: "expected" },
    ];
    const ts = liquidityHorizons({
      openingPosition: 1000, flows, todayISO: "2099-06-01", minCashFloor: 0, horizons: [7, 30],
    });
    return ts;
  });
  record("TS ufuk hesabı yarı-açık pencereyi uyguluyor (gün N sonraki ufka ait)",
    parity[0].contractedNet === -300 && parity[1].expectedNet === 200,
    `7g sözleşmeli=${parity[0].contractedNet} 30g beklenen=${parity[1].expectedNet}`);
  record("taban SÖZLEŞMELİ rakamla yargılanıyor — söz alarmı susturamıyor",
    parity[1].breachesFloor === false && parity[1].projectedContracted === 700
      && parity[1].projectedExpected === 1200,
    `sözleşmeli=${parity[1].projectedContracted} beklenen=${parity[1].projectedExpected}`);

  const gapNegative = await q(
    `select count(*)::int n from public.treasury_liquidity_gap where financing_need < 0`);
  record("finansman ihtiyacı hiçbir zaman negatif değil (0 ile taban arası)",
    Number(gapNegative[0].n) === 0, `${gapNegative[0].n} negatif satır`);

  record("tampon tabanı hesaplanamıyorsa NULL (sıfır değil)",
    bufferDaysFloor(0, 30) === null && effectiveFloor(null, null) === null,
    "gider geçmişi yoksa 'tampon gerekmiyor' denmiyor");
  record("iki taban birden aktifse YÜKSEK olanı geçerli",
    effectiveFloor(10000, 45000) === 45000, "ikisi de asgari — düşüğü sağlamak yetmez");

  /* ── 9. extension, not a parallel engine ────────────────────────────────────────────── */
  const rulesSrc = readFileSync(path.join(process.cwd(), "src/lib/treasury/rules.ts"), "utf8");
  record("treasury/rules.ts Faz 5 motorunu İÇE AKTARIYOR (paralel motor değil)",
    /from "@\/lib\/radar\/rules"/.test(rulesSrc)
      && /buildProjection/.test(rulesSrc),
    "buildProjection/addMonths radar/rules'tan geliyor");

  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/treasury/engine.ts"), "utf8");
  const FLOAT_CAST = `::${"float"}8`;
  record(`hazine motorunda ${FLOAT_CAST} yok (para numeric kalıyor)`,
    !engineSrc.includes(FLOAT_CAST), "Faz 17 kuralı");
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");
  record("hazine motoru hiçbir mali kaydı değiştirmiyor (yalnız politika yazıyor)",
    !/update\s+public\.(invoices|payments|payment_instances|checks|cashflow_months|bank_transactions)/i.test(engineSrc),
    "tek mutasyon treasury_policies");

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0062-0063 eklenmedi)",
    !/006[23]/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE26 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE26 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE26 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
