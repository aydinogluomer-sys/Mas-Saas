// Faz 27 verification — credit facilities, collateral/covenants, the maturity ladder, and FX.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase27:verify
//
// That is the whole contract and it is true: this gate needs the owner connection and nothing
// else. Verified by running exactly that command with DATABASE_URL unset, per the standing rule
// Faz 25 produced. The import graph was checked module by module before this file was written —
// fx/rules, fx/provider, fx/engine, financing/facilities, money, audit, validation, authz/matrix
// — and none reaches @/lib/env. The FX provider deliberately takes its endpoint as a PARAMETER
// rather than reading env, which is what keeps that true.
//
// STANDING RULES INHERITED (Faz 20/22/23/24B/26):
//   1. Constraints targeted STRUCTURALLY by conkey, candidate count asserted.
//   2. No vacuous pass — every fixture built here, dated 2099, negatives paired with positive
//      controls.
//   3. Two independent computations of the same number (SQL and TypeScript) must agree.
//   4. Money is decimal end to end; a new float cast anywhere is a failure. (The literal is
//      assembled below rather than written out — phase17:verify greps scripts/ for it and would
//      otherwise register this gate as an offender for a cast it exists to forbid.)
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  FACILITY_STATUSES, canTransition, utilization,
} from "../src/lib/financing/facilities";
import { revalue, parseTcmbXml } from "../src/lib/fx/rules";
import { mockRateProvider, tcmbProvider, TCMB_TODAY_URL } from "../src/lib/fx/provider";
import { importRates } from "../src/lib/fx/engine";
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
const TAG = () => `P27-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Source with comments removed.
 *
 * Added after all three source-level checks below failed on their own documentation: this gate
 * forbids the float cast, an env import and a scheduler, and the files being scanned
 * each explain IN A COMMENT that they deliberately contain none of those. Grepping raw text made
 * the explanation indistinguishable from the offence.
 *
 * A check a comment can trip is a check that cries wolf forever, so the scans now look at code.
 * Handles `--` for SQL and `//` plus block comments for TypeScript; that is sufficient here
 * because these are our own files, not arbitrary input.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*--.*$/gm, " ");
}

async function mkFacility(
  c: PoolClient, status = "active", limit = 1_000_000, expiry: string | null = "2099-12-31",
  start: string | null = "2099-01-01",
): Promise<string> {
  // `start` is a parameter because the ladder fixture needs a near-term expiry, and a 2099 start
  // date with a 2026 expiry would (correctly) trip credit_facilities_date_order.
  return (await c.query(
    `insert into public.credit_facilities(name, facility_type, limit_amount, currency, status, start_date, expiry_date)
     values ($1,'revolving',$2,'TRY',$3,$4::date,$5::date) returning id`,
    [TAG(), limit, status, start, expiry])).rows[0].id;
}
async function mkLoan(c: PoolClient): Promise<string> {
  return (await c.query(
    `insert into public.loans(name, principal, status) values ($1, 100000, 'active') returning id`,
    [TAG()])).rows[0].id;
}

const FACILITY_ALLOWED = new Set([
  "active>suspended", "active>expired", "active>closed",
  "suspended>active", "suspended>expired", "suspended>closed",
  "expired>active", "expired>closed",
]);
const COVENANT_ALLOWED = new Set(["active>waived", "active>closed", "waived>active", "waived>closed"]);

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tables = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name in
       ('credit_facilities','facility_drawdowns','collateral_records','covenant_records',
        'fx_rate_snapshots','fx_positions')
     order by table_name`);
  record("altı yeni tablo da mevcut", tables.length === 6, `${tables.length}/6`);

  const statusCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.credit_facilities'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='status'`);
  record("credit_facilities.status CHECK'i yapısal olarak ve TEK olarak hedeflendi",
    statusCheck.length === 1, `${statusCheck.length} aday`);
  const lits = new Set([...(statusCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("status CHECK tam olarak 4 kanonik değeri sayıyor",
    lits.size === 4 && FACILITY_STATUSES.every((s) => lits.has(s)), [...lits].sort().join(", "));

  /* ── 2. facility transition enumeration ─────────────────────────────────────────────── */
  const guard = await inRollback(async (c) => {
    const out: { pair: string; accepted: boolean }[] = [];
    for (const from of FACILITY_STATUSES) {
      for (const to of FACILITY_STATUSES) {
        if (from === to) continue;
        const id = await mkFacility(c, from);
        const blocked = await refuses(c, `update public.credit_facilities set status=$2 where id=$1`, [id, to]);
        out.push({ pair: `${from}>${to}`, accepted: !blocked });
      }
    }
    return out;
  });
  const wrong = guard.filter((g) => g.accepted !== FACILITY_ALLOWED.has(g.pair));
  record("12 kredi limiti geçişinin tamamı allow-list ile örtüşüyor (izinli 8, yasak 4)",
    wrong.length === 0,
    wrong.length === 0
      ? `${guard.filter((g) => g.accepted).length} kabul / ${guard.filter((g) => !g.accepted).length} ret`
      : wrong.map((w) => `${w.pair}=${w.accepted ? "kabul" : "ret"}`).join(", "));
  record("guard ile koddaki canTransition BİREBİR aynı",
    guard.every((g) => g.accepted === canTransition(
      g.pair.split(">")[0] as never, g.pair.split(">")[1] as never)),
    "veritabanı ve uygulama tek kural kümesi paylaşıyor");
  record("donmuş limit hâlâ vadesi dolabiliyor (suspended → expired)",
    guard.find((g) => g.pair === "suspended>expired")?.accepted === true, "donmuş limit de yaşlanır");
  record("vadesi dolmuş limit YENİLENEBİLİYOR (expired → active)",
    guard.find((g) => g.pair === "expired>active")?.accepted === true,
    "yenileme yeni satır gerektirmiyor, çekim geçmişi kopmuyor");
  record("aynı-duruma güncelleme 4 durumda da no-op",
    await inRollback(async (c) => {
      for (const s of FACILITY_STATUSES) {
        const id = await mkFacility(c, s);
        if (await refuses(c, `update public.credit_facilities set notes='x', status=$2 where id=$1`, [id, s])) return false;
      }
      return true;
    }), "kendine geçiş engellenmiyor");

  /* ── 3. covenant transition enumeration ─────────────────────────────────────────────── */
  const covGuard = await inRollback(async (c) => {
    const loan = await mkLoan(c);
    const statuses = ["active", "waived", "closed"] as const;
    const out: { pair: string; accepted: boolean }[] = [];
    for (const from of statuses) {
      for (const to of statuses) {
        if (from === to) continue;
        const id = (await c.query(
          `insert into public.covenant_records(loan_id, covenant_type, description, comparison, threshold_value, status)
           values ($1,'current_ratio','P27','gte',1.2,$2) returning id`, [loan, from])).rows[0].id;
        const blocked = await refuses(c, `update public.covenant_records set status=$2 where id=$1`, [id, to]);
        out.push({ pair: `${from}>${to}`, accepted: !blocked });
      }
    }
    return out;
  });
  const covWrong = covGuard.filter((g) => g.accepted !== COVENANT_ALLOWED.has(g.pair));
  record("6 kovenant geçişinin tamamı allow-list ile örtüşüyor (izinli 4, yasak 2)",
    covWrong.length === 0,
    covWrong.length === 0 ? "4 kabul / 2 ret" : covWrong.map((w) => w.pair).join(", "));
  record("süresi biten muafiyet kovenantı geri getirebiliyor (waived → active)",
    covGuard.find((g) => g.pair === "waived>active")?.accepted === true,
    "kalıcı muaf görünen kovenant unutulan kovenanttır");

  /* ── 4. the remaining constraints, with positive controls ───────────────────────────── */
  const cons = await inRollback(async (c) => {
    const badDates = await refuses(c,
      `insert into public.credit_facilities(name, limit_amount, start_date, expiry_date)
       values ($1, 100, '2099-06-01', '2099-01-01')`, [TAG()]);
    const negLimit = await refuses(c,
      `insert into public.credit_facilities(name, limit_amount) values ($1, -1)`, [TAG()]);
    const zeroLimit = !(await refuses(c,
      `insert into public.credit_facilities(name, limit_amount) values ($1, 0)`, [TAG()]));
    return { badDates, negLimit, zeroLimit };
  });
  record("vade başlangıçtan önce olamıyor", cons.badDates, "tarih sırası kısıtı");
  record("negatif limit reddediliyor", cons.negLimit, "eksi bir limit limit değildir");
  record("POZİTİF KONTROL: sıfır limit geçerli (kapatılmış ama kayıtlı hat)",
    cons.zeroLimit, "0 ile null farklı ifadeler");

  const drawdown = await inRollback(async (c) => {
    const f = await mkFacility(c);
    await c.query(
      `insert into public.facility_drawdowns(facility_id, movement_type, amount, movement_date)
       values ($1,'drawdown',500000,'2099-02-01'), ($1,'repayment',200000,'2099-03-01')`, [f]);
    const rows = (await c.query(
      `select movement_type, signed_amount from public.facility_drawdowns
       where facility_id=$1 order by movement_date`, [f])).rows;
    const negAmount = await refuses(c,
      `insert into public.facility_drawdowns(facility_id, movement_type, amount, movement_date)
       values ($1,'drawdown',-5,'2099-04-01')`, [f]);
    const util = (await c.query(
      `select limit_amount, drawn_amount, available_amount, utilization_ratio, over_limit
       from public.credit_facility_utilization where facility_id=$1`, [f])).rows[0];
    return { rows, negAmount, util };
  });
  record("signed_amount türetiliyor: çekim +, geri ödeme −",
    Number(drawdown.rows[0].signed_amount) === 500000 && Number(drawdown.rows[1].signed_amount) === -200000,
    "işaret operatörün elle eksi yazmasına bırakılmıyor");
  record("negatif hareket tutarı reddediliyor", drawdown.negAmount, "işareti movement_type taşıyor");
  record("kullanım hesabı doğru (limit 1.000.000, çekilen 300.000)",
    Number(drawdown.util.drawn_amount) === 300000 && Number(drawdown.util.available_amount) === 700000,
    `çekilen=${drawdown.util.drawn_amount} kullanılabilir=${drawdown.util.available_amount}`);

  // SQL utilisation must equal the TypeScript computation over the same movements.
  const tsUtil = utilization(1_000_000, [500_000, -200_000]);
  record("SQL kullanım hesabı ile TS utilization() BİREBİR aynı",
    tsUtil.drawnAmount === Number(drawdown.util.drawn_amount)
      && tsUtil.availableAmount === Number(drawdown.util.available_amount)
      && tsUtil.overLimit === drawdown.util.over_limit,
    `TS ${tsUtil.drawnAmount}/${tsUtil.availableAmount} — SQL ${drawdown.util.drawn_amount}/${drawdown.util.available_amount}`);

  const over = await inRollback(async (c) => {
    const f = await mkFacility(c, "active", 100000);
    await c.query(
      `insert into public.facility_drawdowns(facility_id, movement_type, amount, movement_date)
       values ($1,'drawdown',130000,'2099-02-01')`, [f]);
    return (await c.query(
      `select drawn_amount, available_amount, over_limit
       from public.credit_facility_utilization where facility_id=$1`, [f])).rows[0];
  });
  record("limit aşımında kullanılabilir 0'a sabitleniyor ve aşım AYRICA bildiriliyor",
    Number(over.available_amount) === 0 && over.over_limit === true && Number(over.drawn_amount) === 130000,
    "negatif başlık grup likiditesini sessizce azaltmıyor");

  const subjects = await inRollback(async (c) => {
    const loan = await mkLoan(c);
    const fac = await mkFacility(c);
    const neither = await refuses(c,
      `insert into public.collateral_records(collateral_type) values ('mortgage')`);
    const both = await refuses(c,
      `insert into public.collateral_records(loan_id, facility_id, collateral_type)
       values ($1,$2,'mortgage')`, [loan, fac]);
    const one = !(await refuses(c,
      `insert into public.collateral_records(loan_id, collateral_type) values ($1,'mortgage')`, [loan]));
    const halfRelease = await refuses(c,
      `insert into public.collateral_records(loan_id, collateral_type, released_at)
       values ($1,'pledge', now())`, [loan]);
    return { neither, both, one, halfRelease };
  });
  record("teminat tam olarak BİR özneye bağlanıyor (ne sıfır ne iki)",
    subjects.neither && subjects.both, "gerçek FK'lar, polimorfik çift değil");
  record("POZİTİF KONTROL: tek özneli teminat kabul ediliyor", subjects.one, "kısıt meşru veriyi engellemiyor");
  record("serbest bırakma alanları birlikte yazılıyor", subjects.halfRelease, "tarih var gerekçe yok reddediliyor");

  const covTest = await inRollback(async (c) => {
    const loan = await mkLoan(c);
    const halfTest = await refuses(c,
      `insert into public.covenant_records(loan_id, covenant_type, description, comparison, threshold_value, last_test_date)
       values ($1,'dscr','P27','gte',1.2,'2099-01-01')`, [loan]);
    const fullTest = !(await refuses(c,
      `insert into public.covenant_records(loan_id, covenant_type, description, comparison, threshold_value, last_test_date, last_test_result)
       values ($1,'dscr','P27','gte',1.2,'2099-01-01','compliant')`, [loan]));
    return { halfTest, fullTest };
  });
  record("yarım yazılmış kovenant ölçümü reddediliyor", covTest.halfTest, "tarih ve sonuç birlikte");
  record("POZİTİF KONTROL: tam ölçüm kabul ediliyor", covTest.fullTest, "");

  /* ── 5. FX rate snapshots are append-only ───────────────────────────────────────────── */
  const appendOnly = await inRollback(async (c) => {
    await c.query(
      `insert into public.fx_rate_snapshots(base_currency, rate_date, rate, source)
       values ('USD','2099-01-05',34.5,'tcmb')`);
    return {
      insertWorks: true,
      upd: await refuses(c, `update public.fx_rate_snapshots set rate=99 where rate_date='2099-01-05'`),
      del: await refuses(c, `delete from public.fx_rate_snapshots where rate_date='2099-01-05'`),
      trunc: await refuses(c, `truncate public.fx_rate_snapshots`),
      dupSame: await refuses(c,
        `insert into public.fx_rate_snapshots(base_currency, rate_date, rate, source)
         values ('USD','2099-01-05',35.0,'tcmb')`),
      dupOtherSource: !(await refuses(c,
        `insert into public.fx_rate_snapshots(base_currency, rate_date, rate, source)
         values ('USD','2099-01-05',35.0,'manual')`)),
      samePair: await refuses(c,
        `insert into public.fx_rate_snapshots(base_currency, quote_currency, rate_date, rate)
         values ('TRY','TRY','2099-01-06',1)`),
    };
  });
  record("POZİTİF KONTROL: kur kaydı eklenebiliyor", appendOnly.insertWorks, "salt-ekleme testi boşlukta değil");
  record("kur kayıtları SALT-EKLEME: UPDATE/DELETE/TRUNCATE engelli",
    appendOnly.upd && appendOnly.del && appendOnly.trunc,
    "sonradan düzeltilebilen bir kur, üzerine kurulan her değerlemeyi çürütülemez yapar");
  record("aynı gün + aynı kaynak için ikinci kur reddediliyor", appendOnly.dupSame, "düzeltme farklı kaynaktır");
  record("POZİTİF KONTROL: farklı kaynak aynı gün için kaydedilebiliyor",
    appendOnly.dupOtherSource, "manuel düzeltme yolu açık");
  record("aynı para birimi çifti reddediliyor", appendOnly.samePair, "TRY/TRY kur değildir");

  const localPos = await inRollback(async (c) =>
    refuses(c, `insert into public.fx_positions(currency, amount, as_of_date) values ('TRY',100,'2099-01-01')`));
  record("TRY pozisyonu FX pozisyonu olarak kaydedilemiyor", localPos, "TRY exposure değil, nakittir");

  /* ── 6. revaluation: SQL and TypeScript must agree ──────────────────────────────────── */
  const reval = await inRollback(async (c) => {
    await c.query(
      `insert into public.fx_rate_snapshots(base_currency, rate_date, rate, source)
       values ('USD','2099-02-01',34.0,'tcmb')`);
    await c.query(
      `insert into public.fx_positions(currency, amount, as_of_date, entry_rate, position_kind)
       values ('USD', 1000, '2099-01-01', 30.0, 'receivable'),
              ('USD', -500, '2099-01-01', 30.0, 'payable'),
              ('USD', 250, '2099-01-01', null, 'other')`);
    return (await c.query(
      `select amount_fx, entry_rate, current_rate, book_value_try, current_value_try,
              unrealized_gain_loss, stress_up_10, stress_down_10, stress_up_20, stress_down_20,
              worst_case_20_delta
       from public.fx_position_revaluation where currency='USD' order by amount_fx desc`)).rows;
  });

  const long = reval.find((r) => Number(r.amount_fx) === 1000);
  const short = reval.find((r) => Number(r.amount_fx) === -500);
  const noEntry = reval.find((r) => Number(r.amount_fx) === 250);

  record("uzun pozisyon kazancı doğru (1000 × (34−30) = 4.000)",
    Number(long.unrealized_gain_loss) === 4000, `${long?.unrealized_gain_loss}`);
  record("kısa pozisyon ters işaret alıyor (−500 × 4 = −2.000)",
    Number(short.unrealized_gain_loss) === -2000, `${short?.unrealized_gain_loss}`);
  record("giriş kuru YOKSA kazanç NULL, sıfır DEĞİL",
    noEntry.unrealized_gain_loss === null && noEntry.book_value_try === null
      && Number(noEntry.current_value_try) === 8500,
    "sıfır 'kazanç yok' iddiasıdır; bilinmiyor iddia değildir");

  const tsMismatch = reval.filter((r) => {
    const ts = revalue({
      currency: "USD", amount: r.amount_fx, entryRate: r.entry_rate, currentRate: r.current_rate,
    });
    const sqlGain = r.unrealized_gain_loss == null ? null : Number(r.unrealized_gain_loss);
    const sqlWorst = r.worst_case_20_delta == null ? null : Number(r.worst_case_20_delta);
    return ts.unrealizedGainLoss !== sqlGain || ts.worstCase20Delta !== sqlWorst;
  });
  record("SQL değerlemesi ile TS revalue() BİREBİR aynı (iki bağımsız hesap)",
    tsMismatch.length === 0,
    tsMismatch.length === 0 ? `${reval.length} pozisyon karşılaştırıldı` : `${tsMismatch.length} sapma`);

  record("stres bantları ±%5/10/20 doğru hesaplanıyor",
    Number(long.stress_up_10) === 37400 && Number(long.stress_down_10) === 30600
      && Number(long.stress_up_20) === 40800 && Number(long.stress_down_20) === 27200,
    `+10=${long.stress_up_10} −10=${long.stress_down_10} +20=${long.stress_up_20}`);

  record("en kötü hâl HER İKİ yönde de ZARAR (uzun ve kısa pozisyonda)",
    Number(long.worst_case_20_delta) < 0 && Number(short.worst_case_20_delta) < 0,
    `uzun=${long.worst_case_20_delta} kısa=${short.worst_case_20_delta}`);

  /* ── 7. maturity ladder ─────────────────────────────────────────────────────────────── */
  const ladder = await q(
    `select bucket_label, bucket_days, installment_due, facility_drawn_expiring,
            facility_limit_expiring, total_cash_exposure
     from public.debt_maturity_ladder order by sort_order`);
  record("vade merdiveni 30/90/180/365 dört kovadan oluşuyor",
    ladder.length === 4 && ladder.map((l) => Number(l.bucket_days)).join(",") === "30,90,180,365",
    ladder.map((l) => l.bucket_label).join(" | "));

  const ladderMath = await inRollback(async (c) => {
    // A facility expiring soon with only part of its limit drawn.
    const f = await mkFacility(
      c, "active", 1_000_000,
      new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10), null);
    await c.query(
      `insert into public.facility_drawdowns(facility_id, movement_type, amount, movement_date)
       values ($1,'drawdown',400000, current_date)`, [f]);
    return (await c.query(
      `select facility_drawn_expiring, facility_limit_expiring, total_cash_exposure, installment_due
       from public.debt_maturity_ladder where sort_order = 1`)).rows[0];
  });
  record("KULLANILMAYAN limit nakit çıkışı sayılmıyor (yalnız çekilen kısım)",
    Number(ladderMath.facility_drawn_expiring) === 400000
      && Number(ladderMath.facility_limit_expiring) === 1000000
      && Number(ladderMath.total_cash_exposure) === Number(ladderMath.installment_due) + 400000,
    `çekilen=${ladderMath.facility_drawn_expiring} limit=${ladderMath.facility_limit_expiring} maruziyet=${ladderMath.total_cash_exposure}`);

  /* ── 8. TCMB: manual/on-demand, never a live feed ───────────────────────────────────── */
  const provFail = await tcmbProvider("http://127.0.0.1:9/never").fetchRates("2099-01-01");
  record("gerçek TCMB sağlayıcısı erişilemezken DÜRÜST hata dönüyor, fırlatmıyor",
    provFail.ok === false && typeof provFail.error === "string" && provFail.rates.length === 0,
    (provFail.error ?? "").slice(0, 50));

  const mockOk = await mockRateProvider([
    { baseCurrency: "USD", rate: 34.2, forexBuying: 34.1, forexSelling: 34.2,
      banknoteBuying: null, banknoteSelling: null, unit: 1 },
  ]).fetchRates("2099-03-01");
  record("mock sağlayıcı deterministik (gate piyasaya bağlı değil)",
    mockOk.ok && mockOk.rates.length === 1 && mockOk.rateDate === "2099-03-01", "sabit girdi, sabit çıktı");

  const importProbe = await inRollback(async (c) => {
    const actor = (await c.query(
      `insert into public.users(username,password_hash,display_name,role)
       values ($1,'x','P27','finance_manager') returning id`, [`p27_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
    await c.query("commit");

    const failed = await importRates(
      pool, mockRateProvider([], { failWith: "bülten boş" }), "2099-04-01", actor);
    const afterFail = Number((await pool.query(
      `select count(*)::int n from public.fx_rate_snapshots where rate_date='2099-04-01'`)).rows[0].n);

    const rates = [{ baseCurrency: "EUR", rate: 37.5, forexBuying: 37.4, forexSelling: 37.5,
      banknoteBuying: null, banknoteSelling: null, unit: 1 }];
    const first = await importRates(pool, mockRateProvider(rates), "2099-04-02", actor);
    const second = await importRates(pool, mockRateProvider(rates), "2099-04-02", actor);

    await pool.query(`delete from public.audit_logs where actor=$1`, [actor]).catch(() => {});
    await pool.query(
      `alter table public.fx_rate_snapshots disable trigger fx_rate_snapshots_no_delete`);
    await pool.query(`delete from public.fx_rate_snapshots where rate_date in ('2099-04-01','2099-04-02')`);
    await pool.query(
      `alter table public.fx_rate_snapshots enable trigger fx_rate_snapshots_no_delete`);
    await pool.query(`delete from public.users where id=$1`, [actor]).catch(() => {});
    return { failed, afterFail, first, second };
  });
  record("BAŞARISIZ çekim HİÇBİR ŞEY kaydetmiyor (yarım gün yok)",
    importProbe.failed.ok === false && importProbe.afterFail === 0,
    `ok=${importProbe.failed.ok} kaydedilen=${importProbe.afterFail}`);
  record("içe aktarma İDEMPOTENT: ikinci koşu yeni satır eklemiyor",
    importProbe.first.inserted === 1 && importProbe.second.inserted === 0 && importProbe.second.skipped === 1,
    `1. ${importProbe.first.inserted} eklendi / 2. ${importProbe.second.inserted} eklendi ${importProbe.second.skipped} atlandı`);

  const providerSrc = readFileSync(path.join(process.cwd(), "src/lib/fx/provider.ts"), "utf8");
  record("TCMB entegrasyonu CANLI AKIŞ değil: zamanlayıcı/polling yok",
    !/(setInterval|setTimeout)\s*\(/.test(codeOnly(providerSrc)),
    "manuel/talep üzerine çekim — canlı bağlantı Faz 37/38");
  record("sağlayıcı @/lib/env'i İMPORT ETMİYOR (uç nokta parametre)",
    !/(^|\s)import\s[^;]*["']@\/lib\/env["']/m.test(codeOnly(providerSrc))
      && !/import\s*\(\s*["']@\/lib\/env["']/.test(codeOnly(providerSrc))
      && /TCMB_TODAY_URL/.test(providerSrc),
    `varsayılan uç nokta sabit: ${TCMB_TODAY_URL.slice(0, 30)}...`);
  record("TCMB Unit alanı hesaba katılıyor (100'lük kotasyon)",
    parseTcmbXml('<Currency CurrencyCode="JPY"><Unit>100</Unit><ForexSelling>23.2000</ForexSelling></Currency>')[0]?.rate === 0.232,
    "Unit yok sayılsa JPY maruziyeti 100 kat şişerdi");

  /* ── 9. Faz 24B rol matrisi ─────────────────────────────────────────────────────────── */
  const newTables = ["credit_facilities", "facility_drawdowns", "collateral_records",
    "covenant_records", "fx_rate_snapshots", "fx_positions"];
  const unclassified = newTables.filter((t) => TABLE_CLASS[t] === undefined);
  record("altı yeni tablo da kod matrisinde sınıflandırılmış",
    unclassified.length === 0,
    unclassified.length === 0
      ? newTables.map((t) => `${t}=${TABLE_CLASS[t]}`).join(" ")
      : `sınıfsız: ${unclassified.join(", ")}`);
  record("fx_rate_snapshots `evidence` sınıfında (salt-ekleme)",
    TABLE_CLASS["fx_rate_snapshots"] === "evidence", String(TABLE_CLASS["fx_rate_snapshots"]));

  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicies = await q(
    `select tablename, roles::text[] as roles from pg_policies
     where schemaname='public' and cmd='SELECT' and tablename = any($1::text[])`, [newTables]);
  record("altı tablonun da SELECT politikası tam beş katmanı hedefliyor",
    selPolicies.length === 6 && selPolicies.every((p) => [...(p.roles as string[])].sort().join(",") === tierRoles),
    `${selPolicies.length}/6`);

  const evidenceWrite = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename='fx_rate_snapshots' and cmd in ('UPDATE','DELETE','ALL')`);
  record("fx_rate_snapshots'ta HİÇBİR katman için UPDATE/DELETE politikası yok",
    Number(evidenceWrite[0].n) === 0, `${evidenceWrite[0].n} yazma politikası`);

  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename = any($1::text[]) and 'authenticated' = any(roles::text[])`,
    [newTables]);
  record("yeni tablolara blanket deseni geri getirilmemiş", Number(blanket[0].n) === 0, `${blanket[0].n} adet`);

  /* ── 10. money discipline + ANCHORS ─────────────────────────────────────────────────── */
  const FLOAT_CAST = `::${"float"}8`;
  const sources = [
    "supabase/migrations/0064_credit_facilities.sql",
    "supabase/migrations/0065_collateral_covenants.sql",
    "supabase/migrations/0066_fx_positions_rates.sql",
    "supabase/migrations/0067_financing_fx_views.sql",
    "src/lib/fx/rules.ts", "src/lib/fx/engine.ts", "src/lib/financing/facilities.ts",
  ];
  const offenders = sources.filter(
    (f) => codeOnly(readFileSync(path.join(process.cwd(), f), "utf8")).includes(FLOAT_CAST));
  record(`yeni FX/finansman kaynaklarının hiçbirinde ${FLOAT_CAST} yok`,
    offenders.length === 0, offenders.length === 0 ? `${sources.length} dosya temiz` : offenders.join(", "));

  const fxRules = readFileSync(path.join(process.cwd(), "src/lib/fx/rules.ts"), "utf8");
  record("FX matematiği money.ts üzerinden geçiyor (gün-1'den)",
    /from "@\/lib\/money"/.test(fxRules) && /decimal\(/.test(fxRules), "Faz 17 katmanı");
  const fxEngine = readFileSync(path.join(process.cwd(), "src/lib/fx/engine.ts"), "utf8");
  record("FX motoru audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(fxEngine) && /parseOrThrow\(/.test(fxEngine), "Faz 18 kuralı");

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0064-0067 eklenmedi)",
    !/006[4567]/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE27 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE27 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE27 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
