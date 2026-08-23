// Faz 21 verification — Fatura Merkezi.
//
// Two things this script inherits as non-negotiable:
//
// 1. THE ENUMERATION PROOF. Every (old, new) status pair is attempted against a real row and
//    compared with the declared allow-list. Reading a migration and agreeing with it is what
//    failed in 0027, which left 7/7 checks and 48/48 installments frozen for eight migrations.
//    Six statuses here means 36 pairs, not 25.
//
// 2. THE CARDINALITY RULE, learned the hard way in Faz 20. That phase's gate selected the
//    status CHECK with `pg_get_constraintdef(oid) like '%status%'` and took row [0] with no
//    ORDER BY. Three constraints matched; on the reviewer's machine row [0] was the one whose
//    only literal is 'ignored', so the proof ran a 1×1 matrix and still printed PASS. Here the
//    constraint is targeted STRUCTURALLY (conkey = exactly the status column) and the match
//    count is ASSERTED — one, or the gate fails. Never `[0]` from a query that can return more.
//
// Everything runs inside transactions that are rolled back.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase21:verify
import { Pool, type PoolClient } from "pg";
import { ageingBucket, assessDuplicate, computeLineTotals, sumLineTotals } from "../src/lib/invoices/rules";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("phase21:verify") });

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

/** The DECLARED allow-list, mirroring migration 0044. Disagreement with reality is the finding. */
const DECLARED = new Set([
  "draft>open", "draft>cancelled",
  "open>partial", "open>paid", "open>closed", "open>cancelled",
  "partial>paid", "partial>open", "partial>closed", "partial>cancelled",
  "paid>partial", "paid>open", "paid>closed",
  "closed>open",
]);

const NEW_TABLES = ["invoices", "invoice_lines", "invoice_reversals"] as const;
const NEW_VIEWS = [
  "invoice_open_items", "invoice_duplicate_suspects", "invoice_line_mismatches",
  "invoice_overpaid", "invoice_party_summary",
] as const;

/** Columns that must travel with a status to satisfy 0044's consistency CHECKs. */
function companion(status: string): string {
  if (status === "cancelled") return `cancelled_at=now(), cancel_reason='iptal', closed_at=null, close_reason=null`;
  if (status === "closed") return `closed_at=now(), close_reason='kapatıldı', cancelled_at=null, cancel_reason=null`;
  return `cancelled_at=null, cancel_reason=null, closed_at=null, close_reason=null`;
}

/** A legal route from 'draft' to any status, used to stage each probe. */
const ROUTE: Record<string, string[]> = {
  draft: [], open: ["open"], partial: ["open", "partial"], paid: ["open", "paid"],
  closed: ["open", "closed"], cancelled: ["open", "cancelled"],
};

async function newParty(c: PoolClient, tag: string): Promise<string> {
  return (await c.query(
    `insert into public.parties(name, normalized_name, party_type)
     values ($1,$2,'customer') returning id`, [`P21 ${tag}`, `p21 ${tag.toLowerCase()}`])).rows[0].id;
}

async function newInvoice(c: PoolClient, party: string, no: string): Promise<string> {
  return (await c.query(
    `insert into public.invoices(direction, invoice_no, party_id, issue_date, net_amount, tax_amount, gross_amount)
     values ('sales',$2,$1,'2026-01-01',100.00,20.00,120.00) returning id`, [party, no])).rows[0].id;
}

async function main(): Promise<void> {
  // ── 1) objects + RLS ────────────────────────────────────────────────────────────────────
  const missing: string[] = [];
  for (const t of [...NEW_TABLES, ...NEW_VIEWS]) {
    const r = await q(`select to_regclass($1) is not null as ok`, [`public.${t}`]);
    if (!r[0]?.ok) missing.push(t);
  }
  record("0044-0047'nin üç tablosu ve beş view'i mevcut", missing.length === 0,
    missing.length === 0 ? `${NEW_TABLES.length} tablo + ${NEW_VIEWS.length} view` : `eksik: ${missing.join(", ")}`);

  const rls = await q(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname = any($1)`, [NEW_TABLES as unknown as string[]]);
  const rlsBad = rls.filter((r) => !r.relrowsecurity || Number(r.policies) === 0);
  record("her yeni tabloda RLS açık ve policy var", rlsBad.length === 0,
    rlsBad.length === 0 ? `${rls.length} tablo` : rlsBad.map((r) => r.relname).join(", "));

  // ── 2) the status CHECK, targeted STRUCTURALLY (Faz 20's lesson) ────────────────────────
  const statusCons = await q(
    `select c.conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.invoices'::regclass
       and c.contype = 'c'
       and array_length(c.conkey, 1) = 1
       and a.attname = 'status'
     order by c.conname`);

  record(
    "status enum CHECK'i TEK ve kesin belirlendi (conkey ile; metin araması DEĞİL)",
    statusCons.length === 1,
    statusCons.length === 1
      ? `${statusCons[0].conname}`
      : `BELİRSİZ: ${statusCons.length} aday — ${statusCons.map((r) => r.conname).join(", ") || "hiç"}`,
  );

  // Proof that the ambiguity Faz 20 tripped over is real on THIS table too, and that the
  // structural query is what removes it.
  const textMatches = await q(
    `select count(*)::int n from pg_constraint
     where conrelid='public.invoices'::regclass and contype='c'
       and pg_get_constraintdef(oid) like '%status%'`);
  record(
    "metin araması burada da belirsiz olurdu (bu yüzden kullanılmadı)",
    Number(textMatches[0].n) > 1,
    `like '%status%' ${textMatches[0].n} constraint eşliyor; conkey ile ${statusCons.length} tanesi kalıyor`,
  );

  const conDef = statusCons.length === 1 ? (statusCons[0].def as string) : "";
  const statuses = [...new Set([...conDef.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))];
  record(
    "çıkarılan durum kümesi çok-değerli bir enum (≥6) ve ANY(ARRAY[…]) biçiminde",
    statuses.length >= 6 && /status\s*=\s*ANY\s*\(ARRAY\[/.test(conDef),
    statuses.length ? `${statuses.length} değer: ${statuses.join(", ")}` : "OKUNAMADI",
  );
  if (statuses.length < 6) {
    throw new Error(`status kümesi güvenilir okunamadı (${statuses.length}) — matris eksik kümeyle çalıştırılmaz`);
  }

  // ── 3) THE 36-PAIR ENUMERATION ──────────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Guard");
    const observed = new Map<string, boolean>();
    let attempted = 0;
    for (const from of statuses) {
      for (const to of statuses) {
        attempted++;
        await c.query("savepoint pair");
        const id = await newInvoice(c, party, `G-${from}-${to}`);
        for (const step of ROUTE[from] ?? []) {
          await c.query(`update public.invoices set status=$2, ${companion(step)} where id=$1`, [id, step]);
        }
        await c.query("savepoint attempt");
        let accepted = false;
        try {
          await c.query(`update public.invoices set status=$2, ${companion(to)} where id=$1`, [id, to]);
          accepted = true;
          await c.query("release savepoint attempt");
        } catch { await c.query("rollback to savepoint attempt"); }
        observed.set(`${from}>${to}`, accepted);
        await c.query("rollback to savepoint pair");
      }
    }

    const mismatches: string[] = [];
    for (const [pair, accepted] of observed) {
      const [from, to] = pair.split(">");
      const expected = from === to ? true : DECLARED.has(pair);
      if (accepted !== expected) mismatches.push(`${pair} beklenen=${expected} gözlenen=${accepted}`);
    }
    record(
      `${attempted} durum geçişinin TAMAMI denendi ve beyanla birebir uyuşuyor`,
      mismatches.length === 0,
      mismatches.length === 0
        ? `${statuses.length}×${statuses.length} matris; ${DECLARED.size} izinli + ${statuses.length} aynı-durum no-op`
        : mismatches.join(" | "),
    );

    const sameBad = statuses.filter((s) => observed.get(`${s}>${s}`) !== true);
    record("aynı-durum güncellemesi HER değer için no-op", sameBad.length === 0,
      sameBad.length === 0 ? `${statuses.length}/${statuses.length}` : sameBad.join(", "));

    const reach = new Set(["draft"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of DECLARED) {
        const [from, to] = p.split(">");
        if (reach.has(from) && !reach.has(to)) { reach.add(to); grew = true; }
      }
    }
    const dead = statuses.filter((s) => !reach.has(s));
    record("CHECK'in kabul ettiği HER durum erişilebilir (0027'nin kırdığı özellik)",
      dead.length === 0, dead.length === 0 ? `${reach.size}/${statuses.length}` : `ÖLÜ DURUM: ${dead.join(", ")}`);

    const declaredVals = new Set([...DECLARED].flatMap((p) => p.split(">")));
    const unknown = [...declaredVals].filter((v) => !statuses.includes(v));
    record("guard, CHECK'te olmayan bir duruma atıfta bulunmuyor", unknown.length === 0,
      unknown.length === 0 ? "iki taraf aynı sözlüğü kullanıyor" : unknown.join(", "));
  });

  // ── 4) cancellation must carry a reversal record ────────────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Rev");
    const id = await newInvoice(c, party, "R-1");
    await c.query(`update public.invoices set status='open' where id=$1`, [id]);

    // SET CONSTRAINTS ALL IMMEDIATE forces the DEFERRED trigger to run inside the transaction.
    await c.query("savepoint silent");
    let silentRefused = false;
    try {
      await c.query(`update public.invoices set status='cancelled', cancelled_at=now(), cancel_reason='sessiz' where id=$1`, [id]);
      await c.query("set constraints all immediate");
      await c.query("release savepoint silent");
    } catch { silentRefused = true; await c.query("rollback to savepoint silent"); }
    record("SESSİZ iptal reddedilir (bağlı reversal kaydı yok)", silentRefused,
      "invoices_require_reversal_record — durum bayrağı tek başına yetmiyor");

    await c.query(
      `insert into public.invoice_reversals(invoice_id, reversal_type, reason, reversed_amount, snapshot)
       values ($1,'cancellation','müşteri iptal etti',120.00,'{}'::jsonb)`, [id]);
    await c.query(`update public.invoices set status='cancelled', cancelled_at=now(), cancel_reason='müşteri iptal etti' where id=$1`, [id]);
    await c.query("set constraints all immediate");
    const st = await c.query(`select status from public.invoices where id=$1`, [id]);
    record("reversal kaydıyla iptal GEÇERLİ", st.rows[0].status === "cancelled", `status=${st.rows[0].status}`);

    record("aynı faturaya ikinci bir cancellation reddedilir",
      await refuses(c, `insert into public.invoice_reversals(invoice_id,reversal_type,reason,reversed_amount,snapshot)
                        values ($1,'cancellation','ikinci',1.00,'{}'::jsonb)`, [id]),
      "invoice_reversals_one_cancellation");

    record("reversal kaydı UPDATE edilemez (append-only)",
      await refuses(c, `update public.invoice_reversals set reason='x' where invoice_id=$1`, [id]), "0022 deseni");
    record("reversal kaydı DELETE edilemez (append-only)",
      await refuses(c, `delete from public.invoice_reversals where invoice_id=$1`, [id]), "0022 deseni");
  });

  // ── 5) immutability once issued ─────────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Imm");
    const id = await newInvoice(c, party, "I-1");

    // draft is editable
    await c.query(`update public.invoices set net_amount=200.00, tax_amount=40.00, gross_amount=240.00 where id=$1`, [id]);
    const draftEdited = await c.query(`select gross_amount from public.invoices where id=$1`, [id]);
    record("draft iken içerik DEĞİŞTİRİLEBİLİR", Number(draftEdited.rows[0].gross_amount) === 240, "gross=240.00");

    await c.query(`update public.invoices set status='open' where id=$1`, [id]);
    record("düzenlendikten sonra tutar DEĞİŞTİRİLEMEZ",
      await refuses(c, `update public.invoices set net_amount=1.00, tax_amount=0, gross_amount=1.00 where id=$1`, [id]),
      "invoices_content_immutability_guard");
    record("düzenlendikten sonra karşı taraf DEĞİŞTİRİLEMEZ",
      await refuses(c, `update public.invoices set party_id=$2 where id=$1`, [id, await newParty(c, "Other")]),
      "invoices_content_immutability_guard");

    // but settlement must still work — a guard drawn too wide is the 0027 failure in disguise
    await c.query(`update public.invoices set paid_amount=50.00, status='partial' where id=$1`, [id]);
    const settled = await c.query(`select status, paid_amount from public.invoices where id=$1`, [id]);
    record("guard ÇOK GENİŞ değil: paid_amount ve status hâlâ değişebiliyor",
      settled.rows[0].status === "partial" && Number(settled.rows[0].paid_amount) === 50,
      "tahsilat işlenebiliyor");

    record("düzenlenmiş faturanın KALEMLERİ değiştirilemez",
      await refuses(c, `insert into public.invoice_lines(invoice_id,line_no,description,quantity,unit_price,net_amount,tax_amount,gross_amount)
                        values ($1,1,'sonradan',1,1,1.00,0,1.00)`, [id]),
      "invoice_lines_immutability_guard");

    record("düzenlenmiş fatura SİLİNEMEZ", await refuses(c, `delete from public.invoices where id=$1`, [id]),
      "invoices_block_issued_delete — iptal reversal kaydıyla yapılır");

    const draftId = await newInvoice(c, party, "I-2");
    await c.query("savepoint d");
    let draftDeletable = true;
    try { await c.query(`delete from public.invoices where id=$1`, [draftId]); await c.query("release savepoint d"); }
    catch { draftDeletable = false; await c.query("rollback to savepoint d"); }
    record("draft fatura SİLİNEBİLİR (ticari olarak hiç var olmadı)", draftDeletable, "sadece draft");
  });

  // ── 6) money invariants ─────────────────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Money");
    record("gross <> net + tax REDDEDİLİR",
      await refuses(c, `insert into public.invoices(direction,invoice_no,party_id,issue_date,net_amount,tax_amount,gross_amount)
                        values ('sales','M-1',$1,'2026-01-01',100.00,20.00,999.00)`, [party]),
      "invoices_gross_is_net_plus_tax");
    record("negatif net tutar REDDEDİLİR",
      await refuses(c, `insert into public.invoices(direction,invoice_no,party_id,issue_date,net_amount,tax_amount,gross_amount)
                        values ('sales','M-2',$1,'2026-01-01',-1.00,0,-1.00)`, [party]),
      "net_amount >= 0");
    // The line probe creates its OWN draft invoice and names it explicitly.
    //
    // The first version wrote `select id ... from public.invoices limit 1`, which passed only
    // because the database happened to hold a committed invoice from an earlier manual test.
    // On a freshly rebuilt database it selected zero rows, the INSERT wrote nothing, "refused"
    // came back false — and the check would have reported a constraint failure that was really
    // an empty table. Same family as the Faz 20 bug: a probe that can succeed vacuously proves
    // nothing. Every probe here now constructs the row it needs.
    const lineParent = await newInvoice(c, party, "M-LINE");
    record("kalem gross <> net + tax REDDEDİLİR",
      await refuses(c, `insert into public.invoice_lines(invoice_id,line_no,description,quantity,unit_price,net_amount,tax_amount,gross_amount)
                        values ($1,1,'x',1,1,10.00,2.00,99.00)`, [lineParent]),
      "invoice_lines_gross_is_net_plus_tax");
    // …and prove the same INSERT succeeds when the arithmetic is right, so the refusal above
    // is attributable to the CHECK rather than to anything else about the statement.
    record("doğru aritmetikli kalem KABUL EDİLİR (red gerçekten CHECK'ten geliyor)",
      !(await refuses(c, `insert into public.invoice_lines(invoice_id,line_no,description,quantity,unit_price,net_amount,tax_amount,gross_amount)
                          values ($1,2,'x',1,1,10.00,2.00,12.00)`, [lineParent])),
      "kontrol pozitif kontrolle dengelendi");

    // Overpayment is allowed on purpose and surfaced by a view, not blocked.
    const id = await newInvoice(c, party, "M-3");
    await c.query(`update public.invoices set status='open' where id=$1`, [id]);
    await c.query(`update public.invoices set paid_amount=500.00, status='paid' where id=$1`, [id]);
    const over = await c.query(`select overpaid_by from public.invoice_overpaid where id=$1`, [id]);
    record("fazla ödeme ENGELLENMEZ, view ile raporlanır",
      over.rowCount === 1 && Number(over.rows[0].overpaid_by) === 380,
      `overpaid_by=${over.rows[0]?.overpaid_by ?? "yok"}`);
  });

  // ── 7) duplicate detection ──────────────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Dup");
    await c.query(
      `insert into public.invoices(direction,invoice_no,party_id,issue_date,net_amount,tax_amount,gross_amount)
       values ('purchase','FTR-1',$1,'2026-05-01',1000.00,200.00,1200.00),
              ('purchase','FTR-1',$1,'2026-05-02',1000.00,200.00,1200.00),
              ('purchase','FTR-9',$1,'2026-05-03',1000.00,200.00,1200.00),
              ('purchase','FTR-7',$1,'2026-11-01',1000.00,200.00,1200.00)`, [party]);
    const dups = await c.query(
      `select signal, count(*)::int n from public.invoice_duplicate_suspects
       where party_id=$1 group by signal order by signal`, [party]);
    const bySignal = Object.fromEntries(dups.rows.map((r) => [r.signal, Number(r.n)]));
    record("aynı numara duplicate olarak işaretlenir", (bySignal["same_number"] ?? 0) >= 1,
      `same_number=${bySignal["same_number"] ?? 0}`);
    record("aynı tutar + yakın tarih duplicate olarak işaretlenir", (bySignal["near_match"] ?? 0) >= 1,
      `near_match=${bySignal["near_match"] ?? 0}`);

    // Duplicates are reported, NOT blocked — the contrast with bank_transactions' unique index.
    record("duplicate ENGELLENMEZ (dört satırın dördü de yazıldı)",
      Number((await c.query(`select count(*)::int n from public.invoices where party_id=$1`, [party])).rows[0].n) === 4,
      "tespit var, kısıt yok — 0044'ün notu");

    // A cancelled invoice drops out of the report, so resolving a duplicate actually clears it.
    const first = (await c.query(`select id from public.invoices where party_id=$1 and invoice_no='FTR-1' order by issue_date limit 1`, [party])).rows[0].id;
    await c.query(`update public.invoices set status='open' where id=$1`, [first]);
    await c.query(`insert into public.invoice_reversals(invoice_id,reversal_type,reason,reversed_amount,snapshot) values ($1,'cancellation','duplicate',1200.00,'{}'::jsonb)`, [first]);
    await c.query(`update public.invoices set status='cancelled', cancelled_at=now(), cancel_reason='duplicate' where id=$1`, [first]);
    await c.query("set constraints all immediate");
    const after = await c.query(
      `select count(*)::int n from public.invoice_duplicate_suspects where party_id=$1 and signal='same_number'`, [party]);
    record("iptal edilen fatura duplicate raporundan düşer", Number(after.rows[0].n) === 0,
      "çözülen duplicate raporu kirletmiyor");
  });

  // ── 8) TS ageing bucket agrees with the SQL view ────────────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Age");
    const today = (await c.query(`select to_char(current_date,'YYYY-MM-DD') d`)).rows[0].d as string;
    const offsets = [-10, 5, 45, 75, 200];
    for (const [i, off] of offsets.entries()) {
      const id = (await c.query(
        `insert into public.invoices(direction,invoice_no,party_id,issue_date,due_date,net_amount,tax_amount,gross_amount)
         values ('sales',$2,$1,current_date - 300, current_date - $3::int, 100.00,0,100.00) returning id`,
        [party, `A-${i}`, off])).rows[0].id;
      await c.query(`update public.invoices set status='open' where id=$1`, [id]);
    }
    const rows = await c.query(
      `select to_char(due_date,'YYYY-MM-DD') as due, ageing_bucket
       from public.invoice_open_items where party_id=$1`, [party]);
    const disagreements = rows.rows.filter((r) => ageingBucket(r.due as string, today) !== r.ageing_bucket);
    record("TS ageingBucket() ile SQL view aynı kovayı veriyor", disagreements.length === 0,
      disagreements.length === 0
        ? `${rows.rowCount} vade kontrol edildi`
        : disagreements.map((r) => `${r.due}: view=${r.ageing_bucket} ts=${ageingBucket(r.due as string, today)}`).join(" | "));
  });

  // ── 9) header/line mismatch is reported, not enforced ───────────────────────────────────
  await inRollback(async (c) => {
    const party = await newParty(c, "Mis");
    const id = await newInvoice(c, party, "MM-1");
    await c.query(
      `insert into public.invoice_lines(invoice_id,line_no,description,quantity,unit_price,net_amount,tax_amount,gross_amount)
       values ($1,1,'eksik kalem',1,10,10.00,2.00,12.00)`, [id]);
    const mm = await c.query(`select difference from public.invoice_line_mismatches where invoice_id=$1`, [id]);
    record("başlık/kalem uyuşmazlığı RAPORLANIR (engellenmez)",
      mm.rowCount === 1 && Number(mm.rows[0].difference) === 108,
      `fark=${mm.rows[0]?.difference ?? "yok"} — cashflow identity ile aynı yaklaşım`);
  });

  // ── 10) pure rules agree with the schema's arithmetic ───────────────────────────────────
  const t = computeLineTotals({ quantity: 7, unitPrice: "12.3456", taxRate: 0.2 });
  const sqlT = (await q(
    `select round(7 * 12.3456::numeric, 2) as net,
            round(round(7 * 12.3456::numeric, 2) * 0.2, 2) as tax`))[0];
  record("computeLineTotals() Postgres numeric aritmetiğiyle aynı sonucu veriyor",
    t.netAmount === Number(sqlT.net) && t.taxAmount === Number(sqlT.tax),
    `ts net=${t.netAmount} tax=${t.taxAmount} · sql net=${sqlT.net} tax=${sqlT.tax}`);

  const summed = sumLineTotals([t, t, t]);
  record("sumLineTotals() gross = net + tax değişmezini koruyor",
    summed.grossAmount === Number((await q(
      `select (round($1::numeric,2) + round($2::numeric,2)) g`, [summed.netAmount, summed.taxAmount]))[0].g),
    `gross=${summed.grossAmount}`);

  const dup = assessDuplicate(
    { invoiceNo: "FTR-2026-001", grossAmount: 1200, issueDate: "2026-03-01" },
    { invoiceNo: "ftr 2026 001", grossAmount: 1200, issueDate: "2026-03-01" });
  record("assessDuplicate() aynı numarayı yakalıyor ve gerekçesini adlandırıyor",
    dup.isSuspect && dup.signals.includes("same_number"), dup.signals.join(","));

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE21 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE21 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE21 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
