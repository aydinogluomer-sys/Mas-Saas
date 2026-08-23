// Faz 23 verification — collection risk, prioritisation, and the manual bad-debt flag.
//
// STANDING RULES INHERITED (all three learned the hard way in Faz 20-22):
//   1. Catalog queries that can return more than one row have their CARDINALITY ASSERTED before
//      anything is read. `like '%column%'` is not a targeting method.
//   2. No probe passes vacuously: every probe builds the rows it needs, and negative checks are
//      paired with a positive control.
//   3. Turkish text in a raised exception is matched as Turkish, not as an ASCII approximation.
//
// THE CENTRAL CHECK OF THIS PHASE is that nothing automates the bad-debt flag. CLAUDE.md
// reserves that judgement for a human, so the gate greps src/ and fails if the columns are
// written from anywhere except the audited operator action.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase23:verify
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  assessRisk, collectionProbability, expectedCollectionDate, scheduleWithinCash,
  type CollectionSignals,
} from "../src/lib/collections/rules";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("phase23:verify") });

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

const NEW_VIEWS = [
  "receivable_collection_signals", "payment_priority_queue",
  "payment_calendar_extended", "counterparty_collection_profile",
] as const;

async function party(c: PoolClient, tag: string): Promise<string> {
  return (await c.query(
    `insert into public.parties(name, normalized_name, party_type) values ($1,$2,'customer') returning id`,
    [`P23 ${tag}`, `p23 ${tag.toLowerCase()}`])).rows[0].id;
}
async function user(c: PoolClient, name: string): Promise<string> {
  return (await c.query(
    `insert into public.users(username, password_hash, display_name, role)
     values ($1,'x',$2,'finance_manager') returning id`, [name, name])).rows[0].id;
}
async function invoice(
  c: PoolClient, p: string, no: string, gross: number,
  opts: { status?: string; due?: string } = {},
): Promise<string> {
  const id = (await c.query(
    `insert into public.invoices(direction,invoice_no,party_id,issue_date,due_date,net_amount,tax_amount,gross_amount)
     values ('sales',$2,$1,'2026-01-01',$4::date,$3::numeric,0,$3::numeric) returning id`,
    [p, no, gross, opts.due ?? null])).rows[0].id;
  if (opts.status && opts.status !== "draft") {
    await c.query(`update public.invoices set status=$2 where id=$1`, [id, opts.status]);
  }
  return id;
}

async function main(): Promise<void> {
  // ── 1) objects ──────────────────────────────────────────────────────────────────────────
  const missing: string[] = [];
  for (const v of NEW_VIEWS) {
    const r = await q(`select to_regclass($1) is not null as ok`, [`public.${v}`]);
    if (!r[0]?.ok) missing.push(v);
  }
  record("0052'nin dört view'i mevcut", missing.length === 0,
    missing.length === 0 ? NEW_VIEWS.join(", ") : `eksik: ${missing.join(", ")}`);

  const cols = (await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='invoices'
       and column_name in ('bad_debt_at','bad_debt_reason','bad_debt_by')`)).map((r) => r.column_name);
  record("0051'in üç bad-debt kolonu eklendi", cols.length === 3, cols.join(", "));

  // ── 2) NO new lifecycle — §17 rule 3 provably N/A ───────────────────────────────────────
  //
  // The bad-debt flag is a nullable timestamp, not a status enum. Asserted structurally with
  // the conkey discipline: if a future edit turns it into a multi-valued column, this notices.
  const statusLike = await q(
    `select c.conname
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid='public.invoices'::regclass and c.contype='c'
       and array_length(c.conkey,1)=1 and a.attname in ('bad_debt_at','bad_debt_reason')`);
  record("bad-debt bir DURUM ENUM'u değil (tek kolonluk değer-listesi CHECK'i yok)",
    statusLike.length === 0,
    statusLike.length === 0 ? "nullable timestamp — kısıtlanacak geçiş yok"
      : statusLike.map((r) => r.conname).join(", "));

  const invStatusCons = await q(
    `select c.conname from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
     where c.conrelid='public.invoices'::regclass and c.contype='c'
       and array_length(c.conkey,1)=1 and a.attname='status'`);
  record("invoices.status enum'u TEK ve değişmemiş (Faz 21 gerilemedi)",
    invStatusCons.length === 1, invStatusCons.length === 1 ? String(invStatusCons[0].conname) : `${invStatusCons.length} aday`);

  // ── 3) THE CENTRAL CHECK: nothing automates the flag ────────────────────────────────────
  const gitList = (args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n").map((f) => f.trim()).filter(Boolean);
  const srcFiles = [
    ...new Set([...gitList(["ls-files", "src"]), ...gitList(["ls-files", "--others", "--exclude-standard", "src"])]),
  ].filter((f) => /\.(ts|tsx)$/.test(f));

  const writers = srcFiles.filter((f) => {
    try {
      // A write is an assignment in SQL: `set ... bad_debt_at=`. Comment lines are stripped
      // first so a file that merely DESCRIBES the column (as several do) is not accused of
      // writing it.
      const text = readFileSync(path.join(process.cwd(), f), "utf8")
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");
      return /bad_debt_at\s*=/.test(text);
    } catch { return false; }
  });
  const allowed = ["src/lib/collections/engine.ts"];
  const rogue = writers.filter((f) => !allowed.includes(f));
  record(
    "bad-debt kolonlarını SADECE denetlenen operatör eylemi yazıyor (otomasyon YOK)",
    rogue.length === 0,
    rogue.length === 0
      ? `tek yazar: ${allowed[0]} (markBadDebt/clearBadDebt)`
      : `beklenmeyen yazar: ${rogue.join(", ")}`,
  );

  // And no trigger sets it either — SQL-side automation would bypass the grep above.
  // prokind='f' restricts this to plain functions: pg_get_functiondef() raises on aggregates
  // and window functions, and public schema can contain them.
  const trig = await q(
    `select p.proname from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%bad_debt_at%'
       and pg_get_functiondef(p.oid) ilike '%update%public.invoices%'`);
  record("hiçbir trigger/fonksiyon bad-debt bayrağını kendiliğinden yazmıyor",
    trig.length === 0, trig.length === 0 ? "SQL tarafında da otomasyon yok" : trig.map((r) => r.proname).join(", "));

  // ── 4) bad-debt constraints ─────────────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Bad");
    const u = await user(c, "p23badprobe");
    const inv = await invoice(c, p, "BD-1", 1000, { status: "open", due: "2026-01-15" });

    record("gerekçesiz bad-debt REDDEDİLİR",
      await refuses(c, `update public.invoices set bad_debt_at=now(), bad_debt_by=$2 where id=$1`, [inv, u]),
      "invoices_bad_debt_consistency");
    record("yazarı olmayan bad-debt REDDEDİLİR",
      await refuses(c, `update public.invoices set bad_debt_at=now(), bad_debt_reason='x' where id=$1`, [inv]),
      "imzasız bir suçlama olmaz");
    record("boş gerekçe REDDEDİLİR",
      await refuses(c, `update public.invoices set bad_debt_at=now(), bad_debt_reason='   ', bad_debt_by=$2 where id=$1`, [inv, u]),
      "btrim kontrolü");

    // positive control — the refusals above must come from the constraint, not the statement shape
    record("eksiksiz bad-debt KABUL EDİLİR (red gerçekten constraint'ten geliyor)",
      !(await refuses(c,
        `update public.invoices set bad_debt_at=now(), bad_debt_reason='müşteri konkordato ilan etti', bad_debt_by=$2 where id=$1`,
        [inv, u])), "pozitif kontrol");

    // The flag must NOT have moved the invoice's status.
    const after = await c.query(`select status, bad_debt_at from public.invoices where id=$1`, [inv]);
    record("bad-debt işareti faturanın DURUMUNU değiştirmiyor",
      after.rows[0].status === "open" && after.rows[0].bad_debt_at !== null,
      `status=${after.rows[0].status} — işaretli fatura hâlâ tahsil edilebilir`);

    // Still visible as an open receivable — flagging is an opinion, not a write-off.
    const stillOpen = await c.query(
      `select bad_debt_flagged from public.receivable_collection_signals where invoice_id=$1`, [inv]);
    record("işaretli fatura açık alacak listesinden DÜŞMÜYOR",
      stillOpen.rowCount === 1 && stillOpen.rows[0].bad_debt_flagged === true,
      "işaret bir görüştür, silme değil");

    // A cancelled invoice cannot carry the flag.
    const cancelled = await invoice(c, p, "BD-2", 500, { status: "open" });
    await c.query(`insert into public.invoice_reversals(invoice_id,reversal_type,reason,reversed_amount,snapshot)
                   values ($1,'cancellation','sonda',500.00,'{}'::jsonb)`, [cancelled]);
    await c.query(`update public.invoices set status='cancelled', cancelled_at=now(), cancel_reason='sonda' where id=$1`,
      [cancelled]);
    await c.query("set constraints all immediate");
    record("iptal edilmiş faturaya bad-debt konulamaz",
      await refuses(c, `update public.invoices set bad_debt_at=now(), bad_debt_reason='olmaz', bad_debt_by=$2 where id=$1`,
        [cancelled, u]), "invoices_bad_debt_not_cancelled — ortada borç yok");
  });

  // ── 5) risk signals view reflects reality ───────────────────────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Signals");
    const inv = await invoice(c, p, "SG-1", 1000, { status: "open", due: "2026-01-01" });
    await c.query(`insert into public.invoice_allocations(invoice_id,source_table,allocated_amount,allocated_on)
                   values ($1,'manual',400.00,'2026-02-01')`, [inv]);

    const s = await c.query(
      `select open_amount, partially_settled, days_overdue from public.receivable_collection_signals
       where invoice_id=$1`, [inv]);
    record("sinyal view'i açık tutarı ve kısmi tahsilatı doğru veriyor",
      s.rowCount === 1 && Number(s.rows[0].open_amount) === 600 && s.rows[0].partially_settled === true,
      `open=${s.rows[0]?.open_amount} partial=${s.rows[0]?.partially_settled}`);

    // Fully allocated invoices leave the signal set — nothing to collect.
    await c.query(`insert into public.invoice_allocations(invoice_id,source_table,allocated_amount)
                   values ($1,'manual',600.00)`, [inv]);
    const gone = await c.query(
      `select count(*)::int n from public.receivable_collection_signals where invoice_id=$1`, [inv]);
    record("tamamı tahsil edilen fatura sinyal listesinden düşüyor", Number(gone.rows[0].n) === 0,
      "tahsil edilecek bir şey kalmadı");
  });

  // ── 6) payment priority queue draws from every obligation kind ──────────────────────────
  //
  // WHY THIS BLOCK USES 2099 DATES AND COMPARES RANKS INSTEAD OF ROW ORDER.
  //
  // The first version queried the whole queue over a 2026-03 window and asserted that row [0]
  // was the check. It passed here and failed on the reviewer's machine, three runs out of
  // three, with `loan_installment:-30 check:-30 invoice:90`. Two independent defects, both in
  // the probe rather than in the view:
  //
  //   a) AMBIENT DATA. The window caught whatever the database already held. A full gate-chain
  //      run leaves the real loan's 48 instalments behind (2024-10 → 2028-09), one of which is
  //      due 2026-03-18. The probe was silently measuring production fixtures.
  //   b) AN UNDEFINED TIE. Checks and loan instalments are BOTH critical/critical, so both
  //      score the same rank, and `order by priority_rank` gives no defined order among equal
  //      keys. Which one landed at [0] was luck. The tie itself is CORRECT — two critical
  //      obligations genuinely have equal priority — so asserting an order between them was
  //      asserting something the design never promised.
  //
  // The date-relative term makes (b) worse rather than rarer: priority_rank contains
  // `least(greatest(due_date - current_date, -30), 60)`, so every item more than 30 days past
  // due clamps to the same -30 and ties become the normal case, not the exception.
  //
  // Fixed by removing both dependencies: the probe now builds obligations on a far-future date
  // no real or seeded row can occupy, and asserts the INVARIANT — for the same due date a
  // critical obligation ranks strictly before a flexible one — rather than a position in a list
  // it does not control.
  await inRollback(async (c) => {
    const p = await party(c, "Queue");
    // 2099: outside every real, seeded and fixture date in this repo.
    await invoice(c, p, "Q-1", 300, { status: "open", due: "2099-03-01" });
    await c.query(
      `insert into public.invoices(direction,invoice_no,party_id,issue_date,due_date,net_amount,tax_amount,gross_amount)
       values ('purchase','Q-2',$1,'2099-01-01','2099-03-02',200.00,0,200.00)`, [p]);
    await c.query(`update public.invoices set status='open' where invoice_no='Q-2'`);
    await c.query(
      `insert into public.checks(maturity_date, amount, signed_amount, direction, status, counterparty_label)
       values ('2099-03-02', 900.00, -900.00, 'outflow', 'planned', 'Q çek')`);

    const kinds = await c.query(
      `select distinct kind from public.payment_priority_queue
       where due_date between '2099-03-01' and '2099-03-31' order by kind`);
    const found = kinds.rows.map((r) => r.kind as string);
    record("öncelik kuyruğu alış faturasını ve çeki birlikte listeliyor",
      found.includes("invoice") && found.includes("check"), found.join(", "));

    // A SALES invoice is not a payable — it must not appear.
    const sales = await c.query(
      `select count(*)::int n from public.payment_priority_queue q
       join public.invoices i on i.id = q.entity_id and q.kind='invoice'
       where i.invoice_no='Q-1'`);
    record("satış faturası ödeme kuyruğuna GİRMİYOR", Number(sales.rows[0].n) === 0,
      "yalnız alış tarafı");

    // THE INVARIANT: same due date, critical ranks strictly before flexible. Both rows are the
    // probe's own, and the comparison is between ranks rather than between list positions.
    const pair = await c.query(
      `select kind, priority_rank from public.payment_priority_queue
       where due_date = '2099-03-02' and kind in ('check','invoice')`);
    const checkRank = pair.rows.find((r) => r.kind === "check")?.priority_rank;
    const invoiceRank = pair.rows.find((r) => r.kind === "invoice")?.priority_rank;
    record(
      "AYNI vadede kritik yükümlülüğün sırası esnek olanınkinden KESİN küçük",
      checkRank != null && invoiceRank != null && Number(checkRank) < Number(invoiceRank),
      `check=${checkRank} < invoice=${invoiceRank} (satır sırası değil, sıra DEĞERİ karşılaştırılıyor)`,
    );

    // Two critical obligations on one date SHOULD tie — that is the design, not a defect, and
    // pinning an order between them is what made the first version of this check flaky.
    await c.query(
      `insert into public.loans(name, principal, status) values ('Q kredi', 100000, 'active')`);
    await c.query(
      `insert into public.loan_installments(loan_id, installment_no, due_date, amount, status)
       select id, 1, '2099-03-02', 5000, 'planned' from public.loans where name='Q kredi'`);
    const criticals = await c.query(
      `select distinct priority_rank from public.payment_priority_queue
       where due_date = '2099-03-02' and flexibility_class = 'critical'`);
    record("iki kritik yükümlülük AYNI sırayı paylaşır (beraberlik tasarım gereği)",
      criticals.rowCount === 1,
      `${criticals.rowCount} farklı sıra değeri — çek ve kredi taksiti eşit öncelikte`);

    const cal = await c.query(
      `select item_count, known_total from public.payment_calendar_extended where due_date='2099-03-02'`);
    record("genişletilmiş takvim gün toplamını veriyor",
      cal.rowCount === 1 && Number(cal.rows[0].known_total) === 6100,
      `2099-03-02: ${cal.rows[0]?.item_count} kalem / ${cal.rows[0]?.known_total} TL (900 çek + 200 fatura + 5000 taksit)`);
  });

  // ── 7) unknown amounts are disclosed, never summed as zero ──────────────────────────────
  await inRollback(async (c) => {
    const p = await party(c, "Unknown");
    const pay = (await c.query(
      `insert into public.payments(name, recurrence_type, due_day, direction, status, provider_party_id)
       values ('P23 tutarsız','monthly',10,'outflow','active',$1) returning id`, [p])).rows[0].id;
    await c.query(
      `insert into public.payment_instances(payment_id, due_date, instance_month, amount, amount_status, status)
       values ($1,'2099-04-10','2099-04-01',null,'missing','unpaid')`, [pay]);

    const cal = await c.query(
      `select item_count, unknown_amount_count, known_total
       from public.payment_calendar_extended where due_date='2099-04-10'`);
    record("tutarı bilinmeyen yükümlülük SAYILIYOR, sıfır olarak toplanmıyor",
      cal.rowCount === 1 && Number(cal.rows[0].unknown_amount_count) === 1 && Number(cal.rows[0].known_total) === 0,
      `${cal.rows[0]?.item_count} kalem, ${cal.rows[0]?.unknown_amount_count} tutarsız — dört tutarsız yükümlülüğü olan gün ucuz bir gün değildir`);
  });

  // ── 8) the deterministic scorers ────────────────────────────────────────────────────────
  const base: CollectionSignals = {
    dueDate: "2026-03-01", issueDate: "2026-02-01", daysOverdue: 0, openAmount: 1000,
    badDebtFlagged: false, partyAvgDaysToSettle: null, partySettledCount: 0,
    partyLateRatio: null, partyInvoiceCount: 0, partiallySettled: false,
  };

  const prob = collectionProbability({ ...base, daysOverdue: 45 });
  record("collectionProbability her zaman gerekçe döndürüyor (model değil, kural)",
    prob.signals.length > 0 && prob.signals.includes("overdue_31_60"),
    `${prob.probability} · ${prob.signals.join(",")}`);

  const flagged = collectionProbability({ ...base, badDebtFlagged: true });
  record("şüpheli alacakta olasılık düşüyor ama SIFIR olmuyor",
    flagged.probability > 0 && flagged.probability < 0.2,
    `${flagged.probability} — işaretli alacak da tahsil edilebilir`);

  const thin = expectedCollectionDate({ ...base, partyAvgDaysToSettle: 90, partySettledCount: 2 }, "2026-02-05");
  record("iki faturalık geçmişten TAHMİN ÜRETİLMİYOR (vadeye düşüyor)",
    thin.basis === "due_date", `basis=${thin.basis}`);

  const rich = expectedCollectionDate({ ...base, partyAvgDaysToSettle: 45, partySettledCount: 5 }, "2026-02-05");
  record("üç+ faturalık geçmiş varsa gerçekleşmiş ortalama kullanılıyor",
    rich.basis === "party_history" && rich.expectedDate === "2026-03-18", `${rich.expectedDate}`);

  const risk = assessRisk({ ...base, daysOverdue: 90 }, 0.5);
  record("assessRisk yoğunlaşmada aynı 0.40 eşiğini kullanıyor",
    risk.flags.includes("yoğunlaşma") && risk.severity === "kritik", risk.flags.join(","));

  const sched = scheduleWithinCash([
    { kind: "check", entityId: "1", dueDate: "2026-03-01", label: "Çek", amount: 500, flexibilityClass: "critical", priorityRank: 0 },
    { kind: "invoice", entityId: "2", dueDate: "2026-03-02", label: "Fatura", amount: 400, flexibilityClass: "flexible", priorityRank: 100 },
  ], 800);
  record("cash-aware sıralama nakdin bittiği yeri işaretliyor ama kalemi GİZLEMİYOR",
    sched.items.length === 2 && sched.firstUncoveredLabel === "Fatura" && sched.shortfall === 100,
    `açık=${sched.shortfall}`);

  const withUnknown = scheduleWithinCash([
    { kind: "x", entityId: "1", dueDate: "2026-03-01", label: "Bilinmeyen", amount: null, flexibilityClass: "critical", priorityRank: 0 },
  ], 1000);
  record("tutarı bilinmeyen kalem 'karşılanıyor' sayılmıyor",
    withUnknown.items[0].covered === false && withUnknown.unknownCount === 1,
    "bilinmeyen bir yükümlülük sessizce sürprize dönüşmez");

  // ── 9) Faz 4/5 regression surface untouched ─────────────────────────────────────────────
  // This phase EXTENDS the due/overdue logic; it must not have altered the tables the payment
  // and cash-flow radars read. Structural check; the gates themselves run in the chain.
  const radarCols = await q(
    `select count(*)::int n from information_schema.columns
     where table_schema='public' and table_name='payment_instances'
       and column_name in ('due_date','amount','status','instance_month')`);
  record("payment_instances'ın radar kolonları değişmedi (Faz 4/5 yüzeyi)",
    Number(radarCols[0].n) === 4, "due_date/amount/status/instance_month yerinde");

  const cashCols = await q(
    `select count(*)::int n from information_schema.columns
     where table_schema='public' and table_name='cashflow_months'
       and column_name in ('opening_balance','projected_income','projected_expense','closing_balance')`);
  record("cashflow_months'un devir/gelir/gider/kasa kolonları değişmedi",
    Number(cashCols[0].n) === 4, "nakit akış radarı yüzeyi korunuyor");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE23 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE23 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE23 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
