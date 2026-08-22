// Faz 22 verification — allocations, receivables/payables, current account.
//
// STANDING RULES THIS SCRIPT INHERITS:
//
// 1. Catalog queries that can return more than one row have their CARDINALITY ASSERTED before
//    anything is read from them. Faz 20's gate took `[0]` from a `like '%status%'` query that
//    matched three constraints and "proved" a five-state machine with a 1×1 matrix; Faz 21
//    showed the same text search was ambiguous on `invoices` too. Faz 22 has no new status
//    enum, but it DOES widen an existing CHECK — and `like '%matched_entity_table%'` matches
//    two constraints on bank_transactions, so the same discipline applies below.
//
// 2. No probe may pass vacuously. Faz 20's append-only check ran against an empty table (a
//    row-level trigger never fires with no rows) and Faz 21's line check selected `limit 1`
//    from an empty table. Every probe here builds the rows it needs, and negative checks are
//    paired with a positive control so a refusal is attributable to the constraint.
//
// Everything runs inside transactions that are rolled back.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase22:verify
import { Pool, type PoolClient } from "pg";
import {
  collectionBucket, computeDPO, computeDSO, planAllocation, runningBalance, summarizeAgeing,
} from "../src/lib/receivables/rules";
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
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}
async function refuses(c: PoolClient, sql: string, params: unknown[] = []): Promise<boolean> {
  await c.query("savepoint probe");
  try { await c.query(sql, params); await c.query("release savepoint probe"); return false; }
  catch { await c.query("rollback to savepoint probe"); return true; }
}

const NEW_VIEWS = [
  "collection_allocations", "payment_allocations", "receivables_open", "payables_open",
  "settlement_unallocated", "current_account_summary", "current_account_ledger",
  "dso_dpo_components", "counterparty_settlement_speed",
] as const;

async function party(c: PoolClient, tag: string): Promise<string> {
  return (await c.query(
    `insert into public.parties(name, normalized_name, party_type) values ($1,$2,'customer') returning id`,
    [`P22 ${tag}`, `p22 ${tag.toLowerCase()}`])).rows[0].id;
}
async function invoice(
  c: PoolClient, partyId: string, no: string, gross: number,
  opts: { status?: string; direction?: string; due?: string; issue?: string } = {},
): Promise<string> {
  const id = (await c.query(
    `insert into public.invoices(direction, invoice_no, party_id, issue_date, due_date,
                                 net_amount, tax_amount, gross_amount)
     values ($5,$2,$1,coalesce($6::date,'2026-01-01'),$4::date,$3::numeric,0,$3::numeric) returning id`,
    [partyId, no, gross, opts.due ?? null, opts.direction ?? "sales", opts.issue ?? null])).rows[0].id;
  if (opts.status && opts.status !== "draft") {
    await c.query(`update public.invoices set status=$2 where id=$1`, [id, opts.status]);
  }
  return id;
}

async function main(): Promise<void> {
  // ── 1) objects ──────────────────────────────────────────────────────────────────────────
  const missingViews: string[] = [];
  for (const v of NEW_VIEWS) {
    const r = await q(`select to_regclass($1) is not null as ok`, [`public.${v}`]);
    if (!r[0]?.ok) missingViews.push(v);
  }
  record("0050'nin dokuz view'i mevcut", missingViews.length === 0,
    missingViews.length === 0 ? `${NEW_VIEWS.length} view` : `eksik: ${missingViews.join(", ")}`);

  const tbl = await q(`select to_regclass('public.invoice_allocations') is not null as ok`);
  record("invoice_allocations tablosu mevcut", Boolean(tbl[0]?.ok), "0048");

  const rls = await q(
    `select c.relrowsecurity,
            (select count(*) from pg_policies p where p.schemaname='public' and p.tablename='invoice_allocations') as policies
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='invoice_allocations'`);
  record("invoice_allocations'ta RLS açık ve policy var",
    Boolean(rls[0]?.relrowsecurity) && Number(rls[0]?.policies) > 0,
    `rls=${rls[0]?.relrowsecurity} policies=${rls[0]?.policies}`);

  // ── 2) NO new status enum — §17 rule 3 is N/A, provably ─────────────────────────────────
  const statusCols = await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='invoice_allocations'
       and column_name in ('status','state','lifecycle')`);
  record("invoice_allocations'ta status/lifecycle kolonu YOK (transition-guard gerçekten N/A)",
    statusCols.length === 0,
    statusCols.length === 0 ? "yalnız reversed_at zaman damgası" : statusCols.map((r) => r.column_name).join(", "));

  // ── 3) migration 0049 widened the matching CHECK — targeted STRUCTURALLY ────────────────
  //
  // Two CHECKs on bank_transactions mention matched_entity_table, so a text search would be
  // ambiguous exactly as it was in Faz 20/21. The value list is the one whose conkey is that
  // single column; cardinality is asserted before anything is read.
  const matchCons = await q(
    `select c.conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.bank_transactions'::regclass and c.contype = 'c'
       and array_length(c.conkey, 1) = 1 and a.attname = 'matched_entity_table'
     order by c.conname`);
  record("matched_entity_table CHECK'i TEK ve kesin belirlendi (conkey ile)",
    matchCons.length === 1,
    matchCons.length === 1 ? String(matchCons[0].conname) : `BELİRSİZ: ${matchCons.length} aday`);

  const textAmbiguous = await q(
    `select count(*)::int n from pg_constraint
     where conrelid='public.bank_transactions'::regclass and contype='c'
       and pg_get_constraintdef(oid) like '%matched_entity_table%'`);
  record("metin araması burada da belirsiz olurdu (bu yüzden kullanılmadı)",
    Number(textAmbiguous[0].n) > 1,
    `like ile ${textAmbiguous[0].n} constraint, conkey ile ${matchCons.length}`);

  const matchDef = matchCons.length === 1 ? String(matchCons[0].def) : "";
  const targets = [...new Set([...matchDef.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))];
  record("0049: 'invoices' eşleşme hedefi olarak eklendi",
    targets.includes("invoices") && targets.length === 4,
    targets.join(", ") || "OKUNAMADI");
  record("0049: Faz 20'nin üç hedefi KORUNDU (genişletme, daraltma değil)",
    ["payment_instances", "checks", "loan_installments"].every((t) => targets.includes(t)),
    "mevcut satırlar etkilenmedi");

  // The candidate queue must move in step, or the matcher could never PROPOSE what it is now
  // allowed to match — one half widened, the other not, is the 0027 shape.
  const candCons = await q(
    `select pg_get_constraintdef(c.oid) as def from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
     where c.conrelid='public.bank_transaction_match_candidates'::regclass and c.contype='c'
       and array_length(c.conkey,1)=1 and a.attname='target_table'`);
  record("aday kuyruğunun hedef listesi de aynı anda genişletildi",
    candCons.length === 1 && String(candCons[0].def).includes("invoices"),
    candCons.length === 1 ? "iki taraf senkron" : `BELİRSİZ: ${candCons.length}`);

  // ── 4) THE CEILING INVARIANT (§18's first real test) ────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Ceiling");
    const inv = await invoice(c, p, "C-1", 120, { status: "open" });

    record("tek dağıtım fatura tutarını AŞAMAZ",
      await refuses(c, `insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                        values ($1,'manual',120.01)`, [inv]), "0048 trigger");

    // positive control — the refusal above must be attributable to the ceiling, not to the shape
    // of the statement.
    record("tam tutar KABUL EDİLİR (red gerçekten tavandan geliyor)",
      !(await refuses(c, `insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                          values ($1,'manual',120.00)`, [inv])), "pozitif kontrol");

    record("dağıtım TOPLAMI aşamaz (satır-bazlı CHECK yakalayamazdı)",
      await refuses(c, `insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                        values ($1,'manual',0.01)`, [inv]), "trigger, CHECK değil");

    const alloc = await c.query(`select allocated_amount from public.invoices where id=$1`, [inv]);
    record("invoices.allocated_amount trigger tarafından doğru tutuluyor",
      Number(alloc.rows[0].allocated_amount) === 120, `allocated=${alloc.rows[0].allocated_amount}`);

    record("UPDATE ile tavan aşılamaz",
      await refuses(c, `update public.invoice_allocations set allocated_amount=200
                        where invoice_id=$1 and reversed_at is null`, [inv]), "INSERT kadar UPDATE de korunuyor");

    // Moving an allocation to another invoice must recompute BOTH sides.
    const inv2 = await invoice(c, p, "C-2", 500, { status: "open" });
    await c.query(`update public.invoice_allocations set invoice_id=$2 where invoice_id=$1 and reversed_at is null`,
      [inv, inv2]);
    const both = await c.query(
      `select invoice_no, allocated_amount from public.invoices where id in ($1,$2) order by invoice_no`, [inv, inv2]);
    record("dağıtım BAŞKA faturaya taşınınca İKİ taraf da yeniden hesaplanıyor",
      Number(both.rows[0].allocated_amount) === 0 && Number(both.rows[1].allocated_amount) === 120,
      `C-1=${both.rows[0].allocated_amount} C-2=${both.rows[1].allocated_amount}`);

    // Reversal frees room; the total is recomputed from the surviving rows.
    //
    // The probe CREATES the user it needs rather than reading whichever one the database
    // happens to hold. An earlier version did `select id from public.users limit 1` and would
    // have reported a spurious failure on any database without a seeded actor — the same
    // depend-on-ambient-data trap that produced a vacuous pass in Faz 20 and Faz 21.
    const actor = (await c.query(
      `insert into public.users(username, password_hash, display_name, role)
       values ('p22probe','x','P22 Probe','operator') returning id`)).rows[0].id;
    await c.query(
      `update public.invoice_allocations set reversed_at=now(), reversed_by=$2, reversed_reason='sonda'
       where invoice_id=$1 and reversed_at is null`, [inv2, actor]);
    const freed = await c.query(`select allocated_amount from public.invoices where id=$1`, [inv2]);
    record("iptal edilen dağıtım toplamdan düşülüyor",
      Number(freed.rows[0].allocated_amount) === 0, `allocated=${freed.rows[0].allocated_amount}`);
  });

  // ── 5) lifecycle gate on allocations ────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Life");
    const draft = await invoice(c, p, "L-1", 100, { status: "draft" });
    record("taslak faturaya dağıtım yapılamaz",
      await refuses(c, `insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                        values ($1,'manual',10.00)`, [draft]), "yalnız open/partial/paid");

    const cancelled = await invoice(c, p, "L-2", 100, { status: "open" });
    await c.query(`insert into public.invoice_reversals(invoice_id,reversal_type,reason,reversed_amount,snapshot)
                   values ($1,'cancellation','sonda',100.00,'{}'::jsonb)`, [cancelled]);
    await c.query(`update public.invoices set status='cancelled', cancelled_at=now(), cancel_reason='sonda' where id=$1`,
      [cancelled]);
    await c.query("set constraints all immediate");
    record("iptal edilmiş faturaya dağıtım yapılamaz",
      await refuses(c, `insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                        values ($1,'manual',10.00)`, [cancelled]), "yalnız open/partial/paid");
  });

  // ── 6) receivables/payables views ───────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "View");
    const sales = await invoice(c, p, "V-S", 1000, { status: "open", due: "2026-01-01" });
    await invoice(c, p, "V-P", 400, { status: "open", direction: "purchase", due: "2026-01-01" });
    await c.query(`insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                   values ($1,'manual',250.00)`, [sales]);

    const rec = await c.query(`select open_amount, ageing_bucket from public.receivables_open where invoice_id=$1`, [sales]);
    record("receivables_open açık tutarı gross − allocated olarak veriyor",
      rec.rowCount === 1 && Number(rec.rows[0].open_amount) === 750,
      `open=${rec.rows[0]?.open_amount ?? "yok"}`);

    const pay = await c.query(`select count(*)::int n from public.payables_open where party_id=$1`, [p]);
    record("payables_open alış faturasını ayrı raporluyor", Number(pay.rows[0].n) === 1, "yön ayrımı");

    // A fully allocated invoice leaves the open list.
    await c.query(`insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                   values ($1,'manual',750.00)`, [sales]);
    const gone = await c.query(`select count(*)::int n from public.receivables_open where invoice_id=$1`, [sales]);
    record("tamamı dağıtılan fatura açık listeden düşüyor", Number(gone.rows[0].n) === 0, "gross = allocated");
  });

  // ── 7) TS ageing agrees with the SQL view ───────────────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Age");
    const today = (await c.query(`select to_char(current_date,'YYYY-MM-DD') d`)).rows[0].d as string;
    for (const [i, off] of [-5, 3, 20, 45, 200].entries()) {
      await c.query(
        `insert into public.invoices(direction,invoice_no,party_id,issue_date,due_date,net_amount,tax_amount,gross_amount,status)
         values ('sales',$2,$1,current_date - 300, current_date - $3::int, 100.00,0,100.00,'draft')`,
        [p, `AG-${i}`, off]);
      await c.query(`update public.invoices set status='open' where invoice_no=$1`, [`AG-${i}`]);
    }
    const rows = await c.query(
      `select to_char(due_date,'YYYY-MM-DD') as due, ageing_bucket from public.receivables_open where party_id=$1`, [p]);
    const bad = rows.rows.filter((r) => collectionBucket(r.due as string, today) !== r.ageing_bucket);
    record("TS collectionBucket() ile SQL view aynı kovayı veriyor (1-7/8-30/31-60/60+)",
      bad.length === 0,
      bad.length === 0 ? `${rows.rowCount} vade kontrol edildi`
        : bad.map((r) => `${r.due}: view=${r.ageing_bucket} ts=${collectionBucket(r.due as string, today)}`).join(" | "));

    const summary = summarizeAgeing(
      rows.rows.map((r) => ({ dueDate: r.due as string, openAmount: 100 })), today);
    record("summarizeAgeing HER kovayı döndürüyor (boş olanlar dahil)", summary.length === 6,
      summary.map((s) => `${s.bucket}=${s.count}`).join(" "));
  });

  // ── 8) current account ledger + running balance ─────────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Ledger");
    const inv = await invoice(c, p, "LG-1", 300, { status: "open", issue: "2026-01-01" });
    await c.query(`insert into public.invoice_allocations(invoice_id,source_table,allocated_amount,allocated_on)
                   values ($1,'manual',120.00,'2026-02-01')`, [inv]);

    const led = await c.query(
      `select to_char(movement_date,'YYYY-MM-DD') as movement_date, debit_amount, credit_amount
       from public.current_account_ledger where party_id=$1 order by movement_date`, [p]);
    record("current_account_ledger fatura ve tahsilatı ayrı hareket olarak veriyor",
      led.rowCount === 2 && Number(led.rows[0].debit_amount) === 300 && Number(led.rows[1].credit_amount) === 120,
      `${led.rowCount} hareket`);

    const balances = runningBalance(led.rows.map((r) => ({
      movementDate: r.movement_date as string,
      debitAmount: Number(r.debit_amount), creditAmount: Number(r.credit_amount),
    })));
    record("runningBalance() doğru yürüyen bakiye üretiyor",
      balances[balances.length - 1].balance === 180, `son bakiye=${balances[balances.length - 1].balance}`);

    const sum = await c.query(`select receivable_open from public.current_account_summary where party_id=$1`, [p]);
    record("current_account_summary açık alacağı aynı rakamla veriyor",
      Number(sum.rows[0].receivable_open) === 180, `receivable_open=${sum.rows[0].receivable_open}`);
  });

  // ── 9) unallocated settlement (where over-receipt surfaces) ─────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Over");
    const acct = (await c.query(
      `insert into public.cash_accounts(name,account_type) values ('P22 Over','bank_account') returning id`)).rows[0].id;
    await c.query(`insert into public.bank_accounts(cash_account_id) values ($1)`, [acct]);
    const inv = await invoice(c, p, "OV-1", 120, { status: "open" });
    const txn = (await c.query(
      `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash,status,
                                            matched_entity_table,matched_entity_id)
       values ($1,'2026-01-01',130.00,'ov1','matched','invoices',$2) returning id`, [acct, inv])).rows[0].id;

    // The invoice can only absorb 120 of the 130 — the ceiling forbids the rest.
    await c.query(`insert into public.invoice_allocations(invoice_id,source_table,source_id,allocated_amount)
                   values ($1,'bank_transactions',$2,120.00)`, [inv, txn]);
    record("banka hareketi fatura tutarından fazlasını dağıtamıyor",
      await refuses(c, `insert into public.invoice_allocations(invoice_id,source_table,source_id,allocated_amount)
                        values ($1,'bank_transactions',$2,10.00)`, [inv, txn]), "tavan korunuyor");

    const un = await c.query(
      `select unallocated_amount from public.settlement_unallocated where source_id=$1`, [txn]);
    record("fazla tahsilat settlement_unallocated'da GÖRÜNÜYOR (kaybolmuyor)",
      un.rowCount === 1 && Number(un.rows[0].unallocated_amount) === 10,
      `dağıtılmamış=${un.rows[0]?.unallocated_amount ?? "yok"} — para var, o faturaya ait değil`);

    // And migration 0049 really allows an invoice to be the matched entity.
    const matched = await c.query(
      `select matched_entity_table from public.bank_transactions where id=$1`, [txn]);
    record("banka hareketi artık bir FATURAYA eşleşebiliyor (0049)",
      matched.rows[0].matched_entity_table === "invoices", "matched_entity_table='invoices'");
  });

  // ── 10) DSO / DPO ───────────────────────────────────────────────────────────────────────
  const comp = (await q(`select * from public.dso_dpo_components`))[0];
  record("dso_dpo_components bileşenleri veriyor (oranı değil)",
    comp !== undefined && "receivables_open" in comp && "sales_365" in comp,
    "dönem kararı çağırana bırakıldı");
  record("computeDSO() ders kitabı formülünü uyguluyor", computeDSO(100_000, 1_200_000, 365) === 30.4,
    "(açık alacak / dönem satışı) × gün");
  record("satış yokken DSO NULL (0 değil)", computeDSO(100_000, 0, 365) === null,
    "0, 'müşteriler anında ödüyor' derdi");
  record("computeDPO() alış tarafında aynı formül", computeDPO(100_000, 1_200_000, 365) === 30.4, "simetrik");

  // ── 11) allocation planning is a proposal ───────────────────────────────────────────────
  const plan = planAllocation(350, [
    { invoiceId: "b", openAmount: 300, dueDate: "2026-02-01", issueDate: "2026-01-01" },
    { invoiceId: "a", openAmount: 100, dueDate: "2026-01-01", issueDate: "2026-01-01" },
  ]);
  record("planAllocation en eski vadeden başlıyor",
    plan.lines[0].invoiceId === "a" && plan.lines[0].amount === 100, "FIFO");
  const over = planAllocation(1000, [{ invoiceId: "a", openAmount: 100, dueDate: null, issueDate: "2026-01-01" }]);
  record("artan tutar son faturaya ZORLANMIYOR, kalan olarak bildiriliyor",
    over.allocated === 100 && over.unallocated === 900, `kalan=${over.unallocated}`);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE22 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE22 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE22 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
