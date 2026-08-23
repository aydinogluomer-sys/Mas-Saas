// Faz 20 verification — Bank Center.
//
// The centrepiece is the status-transition proof, and it is written the way it is because of
// what migration 0027 cost this repository. 0027 shipped guards whose allow-lists did not cover
// the values their own CHECK constraints accepted; 7/7 checks and 48/48 loan installments were
// frozen in 'planned' for eight migrations while a KPI reported 0 paid. Reading a migration and
// agreeing with it is exactly what failed then.
//
// So this script does not read the allow-list. It DERIVES the set of legal statuses from the
// live CHECK constraint, attempts every (old, new) pair against a real row, and compares the
// observed accept/reject matrix against the declared one. A status added to the CHECK without
// transitions becomes an unreachable dead letter — and that is a FAILURE here, by name.
//
// Everything runs inside transactions that are rolled back.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase20:verify
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  classifyTransaction, dedupeKey, detectStatementColumns, parseStatementAmount,
  parseStatementDate, rankCandidates, resolveSignedAmount, SUGGESTION_THRESHOLD,
} from "../src/lib/bank/rules";
import { safeParseStatementBuffer } from "../src/lib/importers/statement-parser";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("phase20:verify") });

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

/**
 * The DECLARED allow-list, mirroring migration 0042's guard.
 *
 * This is the specification the observed behaviour is checked against. It is duplicated here
 * on purpose: if the migration and this table ever disagree, the disagreement is the finding.
 */
const DECLARED_TRANSITIONS = new Set([
  "unmatched>suggested", "unmatched>matched", "unmatched>ignored",
  "suggested>matched", "suggested>unmatched", "suggested>ignored",
  "matched>reconciled", "matched>unmatched", "matched>ignored",
  "reconciled>matched",
  "ignored>unmatched",
]);

const NEW_TABLES = ["bank_accounts", "bank_transactions", "bank_transaction_match_candidates"] as const;
const NEW_VIEWS = ["bank_unmatched_queue", "bank_reconciliation_summary", "bank_match_conflicts"] as const;

/** Columns that must travel with a status to satisfy 0042's consistency CHECKs. */
function companionFields(status: string): string {
  if (status === "matched" || status === "reconciled") {
    return `matched_entity_table='checks', matched_entity_id='11111111-1111-1111-1111-111111111111', ignored_reason=null`;
  }
  if (status === "ignored") {
    return `matched_entity_table=null, matched_entity_id=null, ignored_reason='banka masrafı'`;
  }
  return `matched_entity_table=null, matched_entity_id=null, ignored_reason=null`;
}

/** A legal route from 'unmatched' to any status, used to stage each probe. */
const ROUTE: Record<string, string[]> = {
  unmatched: [],
  suggested: ["suggested"],
  matched: ["matched"],
  ignored: ["ignored"],
  reconciled: ["matched", "reconciled"],
};

async function main(): Promise<void> {
  // ── 1) objects exist, with RLS ──────────────────────────────────────────────────────────
  const missing: string[] = [];
  for (const t of [...NEW_TABLES, ...NEW_VIEWS]) {
    const r = await q(`select to_regclass($1) is not null as ok`, [`public.${t}`]);
    if (!r[0]?.ok) missing.push(t);
  }
  record("0040-0043'ün üç tablosu ve üç view'i mevcut", missing.length === 0,
    missing.length === 0 ? [...NEW_TABLES, ...NEW_VIEWS].join(", ") : `eksik: ${missing.join(", ")}`);

  const rls = await q(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname = any($1)`, [NEW_TABLES as unknown as string[]]);
  const rlsBad = rls.filter((r) => !r.relrowsecurity || Number(r.policies) === 0);
  record("her yeni tabloda RLS açık ve policy var", rlsBad.length === 0,
    rlsBad.length === 0 ? `${rls.length} tablo` : rlsBad.map((r) => r.relname).join(", "));

  // ── 2) cash_accounts was NOT reshaped ───────────────────────────────────────────────────
  // The architecture decision was "sidecar, do not widen". If a later edit quietly adds IBAN to
  // cash_accounts the two models start disagreeing about where the truth lives.
  const caCols = (await q(
    `select column_name from information_schema.columns
     where table_schema='public' and table_name='cash_accounts'`)).map((r) => r.column_name as string);
  const leaked = caCols.filter((c) => ["iban", "branch_code", "branch_name", "swift_bic", "overdraft_limit", "blocked_balance"].includes(c));
  record("cash_accounts genişletilmedi (banka detayı sidecar'da kaldı)", leaked.length === 0,
    leaked.length === 0 ? `${caCols.length} kolon, banka-özel kolon yok` : `sızan: ${leaked.join(", ")}`);

  const fkOk = await q(
    `select count(*)::int n from information_schema.constraint_column_usage ccu
     join information_schema.table_constraints tc on tc.constraint_name=ccu.constraint_name
     where ccu.table_name='cash_accounts' and tc.constraint_type='FOREIGN KEY'`);
  record("cash_accounts'a giden mevcut FK'lar duruyor", Number(fkOk[0].n) >= 4,
    `${fkOk[0].n} FK (payments, payment_instances, cashflow_lines, checks + Faz 20)`);

  // ── 3) THE TRANSITION PROOF ─────────────────────────────────────────────────────────────
  //
  // Statuses are read from the live CHECK constraint, not from this file, so a value added
  // there without transitions is caught rather than assumed away.
  //
  // HOW THIS WENT WRONG ONCE, AND WHY THE QUERY LOOKS LIKE THIS NOW.
  // The first version selected `pg_get_constraintdef(oid) like '%status%'` and took row [0]
  // with no ORDER BY. THREE constraints on this table mention `status`:
  //
  //   bank_transactions_ignore_reason      CHECK (status <> 'ignored' OR ...)          1 value
  //   bank_transactions_match_consistency  CHECK ((status = ANY (ARRAY['matched',
  //                                                'reconciled'])) = ...)              2 values
  //   bank_transactions_status_check       CHECK (status = ANY (ARRAY[...5 values]))   <- wanted
  //
  // Postgres does not guarantee row order without ORDER BY. On the author's machine row [0]
  // happened to be the right one and the gate reported 30/30; on the reviewer's machine it was
  // `ignore_reason`, whose only quoted literal is 'ignored' — so the value regex produced a
  // SINGLE status, the proof ran a 1×1 matrix, and the gate still printed PASS. A gate that
  // can silently "prove" a five-state machine by testing one state is worse than no gate.
  //
  // That is a micro-version of the very failure this phase exists to prevent: 0027 was
  // "I read the migration and assumed it was right"; this was "I read one query row and
  // assumed it was the right one".
  //
  // The fix targets the constraint STRUCTURALLY rather than by text search: the status enum is
  // the only CHECK on this table whose `conkey` is exactly the single `status` column (the
  // other two span 2 and 3 columns). Cardinality is then ASSERTED — exactly one match, or the
  // gate fails loudly instead of picking one. Same discipline phase3-verify.ts already used
  // for its PRONET lookup (`if (pronet.length !== 1) fail(...)`).
  const statusEnumCons = await q(
    `select c.conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a
       on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.conrelid = 'public.bank_transactions'::regclass
       and c.contype = 'c'
       and array_length(c.conkey, 1) = 1
       and a.attname = 'status'
     order by c.conname`);

  record(
    "status enum CHECK'i TEK ve kesin olarak belirlendi (metin araması değil, conkey ile)",
    statusEnumCons.length === 1,
    statusEnumCons.length === 1
      ? `${statusEnumCons[0].conname} (yalnız status kolonuna bağlı tek CHECK)`
      : `BELİRSİZ: ${statusEnumCons.length} aday — ${statusEnumCons.map((r) => r.conname).join(", ") || "hiç"}`,
  );

  const conDef = statusEnumCons.length === 1 ? (statusEnumCons[0].def as string) : "";
  const statuses = [...new Set([...conDef.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]))];

  // A second, independent guard on the same mistake: whatever we extracted must actually look
  // like a multi-value enum. If a future refactor makes the query ambiguous again, a 1- or
  // 2-value result fails here even if the cardinality check above were somehow satisfied.
  record(
    "çıkarılan durum kümesi gerçekten çok-değerli bir enum (≥3) ve ANY(ARRAY[…]) biçiminde",
    statuses.length >= 3 && /status\s*=\s*ANY\s*\(ARRAY\[/.test(conDef),
    statuses.length > 0 ? `${statuses.length} değer: ${statuses.join(", ")}` : "OKUNAMADI",
  );

  if (statuses.length < 3) {
    // Refusing to continue is the point: the matrix below would otherwise "pass" on a subset.
    throw new Error(
      `status kümesi güvenilir şekilde okunamadı (${statuses.length} değer) — geçiş matrisi eksik bir kümeyle çalıştırılmaz`,
    );
  }

  await inRollback(async (c) => {
    const acct = (await c.query(
      `insert into public.cash_accounts(name, account_type) values ('P20 Guard Probe','bank_account') returning id`)).rows[0].id;
    await c.query(`insert into public.bank_accounts(cash_account_id) values ($1)`, [acct]);

    const observed = new Map<string, boolean>();
    let attempted = 0;
    for (const from of statuses) {
      for (const to of statuses) {
        attempted++;
        await c.query("savepoint pair");
        const id = (await c.query(
          `insert into public.bank_transactions(bank_account_id, txn_date, amount, dedupe_hash)
           values ($1,'2026-01-01',-100.00,$2) returning id`, [acct, `probe-${from}-${to}`])).rows[0].id;
        for (const step of ROUTE[from] ?? []) {
          await c.query(`update public.bank_transactions set status=$2, ${companionFields(step)} where id=$1`, [id, step]);
        }
        await c.query("savepoint attempt");
        let accepted = false;
        try {
          await c.query(`update public.bank_transactions set status=$2, ${companionFields(to)} where id=$1`, [id, to]);
          accepted = true;
          await c.query("release savepoint attempt");
        } catch {
          await c.query("rollback to savepoint attempt");
        }
        observed.set(`${from}>${to}`, accepted);
        await c.query("rollback to savepoint pair");
      }
    }

    const mismatches: string[] = [];
    for (const [pair, accepted] of observed) {
      const [from, to] = pair.split(">");
      const expected = from === to ? true : DECLARED_TRANSITIONS.has(pair);
      if (accepted !== expected) mismatches.push(`${pair} beklenen=${expected} gözlenen=${accepted}`);
    }
    record(
      `${attempted} durum geçişinin TAMAMI denendi ve beyanla birebir uyuşuyor`,
      mismatches.length === 0,
      mismatches.length === 0
        ? `${statuses.length}×${statuses.length} matris; ${DECLARED_TRANSITIONS.size} izinli + ${statuses.length} aynı-durum no-op`
        : mismatches.join(" | "),
    );

    // Same-status must be a no-op for EVERY value, not just the convenient ones.
    const sameStatusBad = statuses.filter((s) => observed.get(`${s}>${s}`) !== true);
    record("aynı-durum güncellemesi HER değer için no-op", sameStatusBad.length === 0,
      sameStatusBad.length === 0 ? `${statuses.length}/${statuses.length}` : sameStatusBad.join(", "));

    // ── reachability: the exact property 0027 broke ──────────────────────────────────────
    const reachable = new Set(["unmatched"]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const pair of DECLARED_TRANSITIONS) {
        const [from, to] = pair.split(">");
        if (reachable.has(from) && !reachable.has(to)) { reachable.add(to); grew = true; }
      }
    }
    const dead = statuses.filter((s) => !reachable.has(s));
    record(
      "CHECK'in kabul ettiği HER durum başlangıçtan erişilebilir (0027'nin kırdığı özellik)",
      dead.length === 0,
      dead.length === 0 ? `${reachable.size}/${statuses.length} erişilebilir` : `ÖLÜ DURUM: ${dead.join(", ")}`,
    );

    // And the converse: the guard must not name a status the CHECK would reject.
    const declaredValues = new Set([...DECLARED_TRANSITIONS].flatMap((p) => p.split(">")));
    const unknownInGuard = [...declaredValues].filter((v) => !statuses.includes(v));
    record("guard, CHECK'te olmayan bir duruma atıfta bulunmuyor", unknownInGuard.length === 0,
      unknownInGuard.length === 0 ? "iki taraf aynı sözlüğü kullanıyor" : unknownInGuard.join(", "));
  });

  // ── 4) consistency CHECKs ───────────────────────────────────────────────────────────────
  await inRollback(async (c) => {
    const acct = (await c.query(
      `insert into public.cash_accounts(name, account_type) values ('P20 Consistency','bank_account') returning id`)).rows[0].id;
    await c.query(`insert into public.bank_accounts(cash_account_id) values ($1)`, [acct]);
    const mk = async (extra: string, hash: string) => {
      await c.query("savepoint x");
      try {
        await c.query(
          `insert into public.bank_transactions(bank_account_id, txn_date, amount, dedupe_hash ${extra ? "," + extra.split("=")[0] : ""})
           values ($1,'2026-01-01',-1.00,$2 ${extra ? ",'" + extra.split("=")[1] + "'" : ""})`, [acct, hash]);
        await c.query("release savepoint x");
        return true;
      } catch { await c.query("rollback to savepoint x"); return false; }
    };
    void mk;

    const refuses = async (sql: string, params: unknown[]) => {
      await c.query("savepoint y");
      try { await c.query(sql, params); await c.query("release savepoint y"); return false; }
      catch { await c.query("rollback to savepoint y"); return true; }
    };

    record("matched, eşleşilen kaydı adlandırmadan olamaz",
      await refuses(
        `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash,status)
         values ($1,'2026-01-01',-1.00,'c1','matched')`, [acct]),
      "bank_transactions_match_consistency");

    record("ignored, gerekçesiz olamaz",
      await refuses(
        `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash,status)
         values ($1,'2026-01-01',-1.00,'c2','ignored')`, [acct]),
      "bank_transactions_ignore_reason");

    record("unmatched, eşleşme alanı taşıyamaz",
      await refuses(
        `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash,status,matched_entity_table,matched_entity_id)
         values ($1,'2026-01-01',-1.00,'c3','unmatched','checks','11111111-1111-1111-1111-111111111111')`, [acct]),
      "bank_transactions_match_consistency (ters yön)");

    record("match_confidence 0..1 dışına çıkamaz",
      await refuses(
        `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash,match_confidence)
         values ($1,'2026-01-01',-1.00,'c4',1.5)`, [acct]),
      "match_confidence check");

    // duplicate detection
    await c.query(
      `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash)
       values ($1,'2026-01-01',-1.00,'dup')`, [acct]);
    record("aynı hesapta yinelenen dedupe_hash reddedilir",
      await refuses(
        `insert into public.bank_transactions(bank_account_id,txn_date,amount,dedupe_hash)
         values ($1,'2026-01-01',-1.00,'dup')`, [acct]),
      "bank_transactions_dedupe_uq");

    // direction is generated, never hand-set
    const dir = await c.query(
      `select direction from public.bank_transactions where bank_account_id=$1 and dedupe_hash='dup'`, [acct]);
    record("direction tutardan TÜRETİLİR (negatif = outflow)", dir.rows[0].direction === "outflow",
      `amount=-1.00 → ${dir.rows[0].direction}`);
  });

  // ── 5) our own IBAN is GLOBALLY unique (contrast with 0037's counterparty IBANs) ─────────
  await inRollback(async (c) => {
    const a1 = (await c.query(`insert into public.cash_accounts(name,account_type) values ('P20 IB1','bank_account') returning id`)).rows[0].id;
    const a2 = (await c.query(`insert into public.cash_accounts(name,account_type) values ('P20 IB2','bank_account') returning id`)).rows[0].id;
    const iban = "TR330006100519786457841326";
    await c.query(`insert into public.bank_accounts(cash_account_id,iban) values ($1,$2)`, [a1, iban]);
    await c.query("savepoint z");
    let refused = false;
    try { await c.query(`insert into public.bank_accounts(cash_account_id,iban) values ($1,$2)`, [a2, iban]); await c.query("release savepoint z"); }
    catch { refused = true; await c.query("rollback to savepoint z"); }
    record("kendi IBAN'ımız GLOBAL unique (0037'nin parti-kapsamlı kuralının tersi)", refused,
      "iki kasa hesabı aynı IBAN'ı iddia edemez — ekstre ikiye bölünürdü");
  });

  // ── 6) statement parsing: CSV supported, corrupt still refused ───────────────────────────
  const csv = Buffer.from(
    "İşlem Tarihi;Açıklama;Borç;Alacak;Bakiye\n01.03.2026;EFT ÜCRETİ;15,00;;1.000,00\n", "utf8");
  const csvParsed = safeParseStatementBuffer(csv, "ekstre.csv");
  record("CSV ekstre ayrıştırılıyor", csvParsed.ok, csvParsed.ok ? "format=csv" : csvParsed.error);

  const zeros = Buffer.alloc(64);
  const zerosCsv = safeParseStatementBuffer(zeros, "ekstre.csv");
  record("all-zero dosya CSV adı taşısa bile REDDEDİLİR (§1.1 korunuyor)", !zerosCsv.ok,
    zerosCsv.ok ? "KABUL EDİLDİ — regresyon" : "NUL bayt tespiti");

  const zerosXlsx = safeParseStatementBuffer(zeros, "ekstre.xlsx");
  record("all-zero dosya xlsx adıyla da reddedilir", !zerosXlsx.ok, zerosXlsx.ok ? "KABUL EDİLDİ" : "imza kontrolü");

  const noDelim = safeParseStatementBuffer(Buffer.from("tekbirsutun\nveri\n", "utf8"), "x.csv");
  record("ayırıcısız CSV reddedilir", !noDelim.ok, noDelim.ok ? "KABUL EDİLDİ" : "ayırıcı bulunamadı");

  // BOM must not corrupt the first header cell
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), csv]);
  const bomParsed = safeParseStatementBuffer(bom, "ekstre.csv");
  let bomHeaderOk = false;
  if (bomParsed.ok) {
    const ws = bomParsed.workbook.Sheets[bomParsed.workbook.SheetNames[0]];
    const first = String((ws["A1"] as { v?: unknown } | undefined)?.v ?? "");
    bomHeaderOk = detectStatementColumns({ A: first }).txn_date === "A";
  }
  record("UTF-8 BOM başlık hücresini bozmuyor", bomHeaderOk, "BOM stripleniyor");

  // ── 7) rules behave as specified ────────────────────────────────────────────────────────
  record("TR ve EN sayı biçimleri doğru ayrışıyor",
    parseStatementAmount("1.234,56") === "1234.56" && parseStatementAmount("1,234.56") === "1234.56",
    "1.234,56 ve 1,234.56 → 1234.56");

  record("imkânsız tarih yuvarlanmıyor, REDDEDİLİYOR",
    parseStatementDate("31.02.2026") === null && parseStatementDate("31.01.2026") === "2026-01-31",
    "31.02.2026 → null (3 Mart'a kaymıyor)");

  record("borç sütunu negatife, alacak pozitife çevriliyor",
    resolveSignedAmount({ debit: "1.000,00" }) === "-1000" && resolveSignedAmount({ credit: "1.000,00" }) === "1000",
    "işaret sözleşmesi checks.signed_amount ile aynı");

  const cls = classifyTransaction({ description: "EFT ÜCRETİ", amount: "-15" });
  record("sınıflandırma kural ADI döndürüyor (açıklanabilir)", cls.rule === "eft_havale_fee" && cls.category === "bank_fee",
    `${cls.category} / ${cls.rule}`);

  const unknownCls = classifyTransaction({ description: "ZZZ", amount: "-1" });
  record("eşleşmeyen açıklama 'unknown' + null kural (tahmin yok)",
    unknownCls.category === "unknown" && unknownCls.rule === null, "en iyi tahmin üretilmiyor");

  const lone = rankCandidates(
    { amount: -10000, txnDate: "2026-03-10", description: "x", counterparty: null },
    [{ table: "checks", id: "c", amount: 10000, dueDate: null, label: null }]);
  record("TEK sinyal (yalnız tutar) öneri eşiğini geçmiyor", lone.length === 0,
    `eşik=${SUGGESTION_THRESHOLD}; yuvarlak tutar tesadüfü öneriye dönüşmüyor`);

  const two = rankCandidates(
    { amount: -10000, txnDate: "2026-03-10", description: "x", counterparty: null },
    [{ table: "checks", id: "c", amount: 10000, dueDate: "2026-03-10", label: null }]);
  record("iki sinyal (tutar + tarih) öneri üretiyor", two.length === 1,
    two.length === 1 ? `confidence=${two[0].confidence}` : "öneri yok");

  record("dedupe anahtarı tutar yazımından bağımsız",
    dedupeKey({ txnDate: "2026-01-01", amount: "-100", description: "a" })
      === dedupeKey({ txnDate: "2026-01-01", amount: "-100.00", description: "a" }),
    "-100 ve -100.00 aynı satır");

  // ── 8) no bank API in this phase ────────────────────────────────────────────────────────
  // implementation.md defers live connections to Faz 37. A fetch() to a bank hiding in this
  // module would be a scope breach that no other gate would catch.
  const engineSrc = readFileSync(path.join(process.cwd(), "src", "lib", "bank", "engine.ts"), "utf8");
  const hasNetwork = /\bfetch\s*\(|axios|node-fetch|https?:\/\/(?!\S*(example|schema))/.test(engineSrc);
  record("banka API çağrısı YOK (Faz 37'ye ertelendi)", !hasNetwork,
    hasNetwork ? "ağ çağrısı bulundu" : "yalnız dosya-importu");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE20 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE20 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE20 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
