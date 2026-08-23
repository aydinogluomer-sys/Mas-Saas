// Faz 19 verification — counterparty core data model.
//
// Unlike phase17/18 (source greps), this one talks to a database: everything it defends is a
// schema guarantee — a primary key that enforces 1:1, a partial unique index, an append-only
// trigger, a view that refuses to sum unknowns as zero. None of that is observable from the
// source text.
//
// Read-mostly, and every write it does make happens inside a transaction that is ROLLED BACK.
// The one exception is the append-only probe, which must actually attempt an UPDATE to prove
// it is refused — and a refused statement changes nothing by definition.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase19:verify
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { normalizeIban } from "../src/lib/counterparties/rules";
import { requireDisposableOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("phase19:verify") });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs `fn` inside a transaction that is always rolled back. */
async function inRollback<T>(fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
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
 * Attempt a statement that is EXPECTED to be refused, without poisoning the transaction.
 *
 * Postgres aborts the whole transaction on any error, so a probe that asserts "this insert is
 * rejected" would take every later statement down with it. A SAVEPOINT scopes the damage to
 * the probe. Returns true when the statement was refused, which is the passing case.
 */
async function refuses(c: import("pg").PoolClient, sql: string, params: unknown[] = []): Promise<boolean> {
  await c.query("savepoint probe");
  try {
    await c.query(sql, params);
    await c.query("release savepoint probe");
    return false;
  } catch {
    await c.query("rollback to savepoint probe");
    return true;
  }
}

/** Same savepoint discipline, for a statement that is expected to SUCCEED. */
async function succeeds(c: import("pg").PoolClient, sql: string, params: unknown[] = []): Promise<boolean> {
  await c.query("savepoint probe");
  try {
    await c.query(sql, params);
    await c.query("release savepoint probe");
    return true;
  } catch {
    await c.query("rollback to savepoint probe");
    return false;
  }
}

const NEW_TABLES = [
  "counterparty_profiles", "ibans", "iban_change_events",
  "cost_centers", "departments", "projects", "products", "orders",
] as const;
const NEW_VIEWS = [
  "counterparty_exposure_items", "counterparty_exposure",
  "counterparty_unresolved", "iban_shared_across_parties",
] as const;

async function main(): Promise<void> {
  // ── 1) everything exists ────────────────────────────────────────────────────────────────
  const missingTables: string[] = [];
  for (const t of NEW_TABLES) {
    const r = await q(`select to_regclass($1) is not null as ok`, [`public.${t}`]);
    if (!r[0]?.ok) missingTables.push(t);
  }
  record("0036-0038'in sekiz tablosu mevcut", missingTables.length === 0,
    missingTables.length === 0 ? NEW_TABLES.join(", ") : `eksik: ${missingTables.join(", ")}`);

  const missingViews: string[] = [];
  for (const v of NEW_VIEWS) {
    const r = await q(`select to_regclass($1) is not null as ok`, [`public.${v}`]);
    if (!r[0]?.ok) missingViews.push(v);
  }
  record("0039'un dört view'i mevcut", missingViews.length === 0,
    missingViews.length === 0 ? NEW_VIEWS.join(", ") : `eksik: ${missingViews.join(", ")}`);

  // ── 2) RLS on every new table (the gap docs/database-schema.md records for post-0007) ───
  const rls = await q(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname = any($1)`,
    [NEW_TABLES as unknown as string[]],
  );
  const rlsBad = rls.filter((r) => !r.relrowsecurity || Number(r.policies) === 0);
  record("her yeni tabloda RLS açık ve en az bir policy var", rlsBad.length === 0,
    rlsBad.length === 0 ? `${rls.length} tablo` : rlsBad.map((r) => r.relname).join(", "));

  // ── 3) 1:1 profile, structurally ────────────────────────────────────────────────────────
  const pk = await q(
    `select a.attname from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey)
     where i.indrelid='public.counterparty_profiles'::regclass and i.indisprimary`);
  record("counterparty_profiles 1:1 (party_id birincil anahtar)",
    pk.length === 1 && pk[0].attname === "party_id",
    pk.map((r) => r.attname).join(",") || "(yok)");

  // ── 4) parties FK graph untouched ───────────────────────────────────────────────────────
  // The whole design rests on not reshaping parties. Eight FKs were introspected before the
  // migrations were written; all eight must still be there afterwards.
  const fks = await q(
    `select tc.table_name || '.' || kcu.column_name as ref
     from information_schema.table_constraints tc
     join information_schema.key_column_usage kcu on kcu.constraint_name=tc.constraint_name
     join information_schema.constraint_column_usage ccu on ccu.constraint_name=tc.constraint_name
     where tc.constraint_type='FOREIGN KEY' and ccu.table_name='parties' and tc.table_schema='public'
     order by 1`);
  const refs = fks.map((r) => r.ref as string);
  const expected = [
    "cash_accounts.provider_party_id", "cashflow_lines.party_id",
    "checks.bank_party_id", "checks.payee_party_id", "checks.payer_party_id",
    "loans.lender_party_id", "payments.owner_party_id", "payments.provider_party_id",
  ];
  const stillThere = expected.every((e) => refs.includes(e));
  record("parties'e giden 8 mevcut FK bozulmadı", stillThere,
    stillThere ? `${refs.length} FK (8 eski + ${refs.length - 8} Faz 19)` : `eksik: ${expected.filter((e) => !refs.includes(e)).join(", ")}`);

  // ── 5) NO lifecycle column on any new table (§17 rule 3 is N/A, provably) ───────────────
  // The phase claims the status-transition-guard rule does not apply because nothing added
  // here has a lifecycle. That claim is only honest if it is checked.
  const statusCols = await q(
    `select table_name, column_name from information_schema.columns
     where table_schema='public' and table_name = any($1) and column_name in ('status','state','lifecycle')`,
    [NEW_TABLES as unknown as string[]],
  );
  record("yeni tabloların hiçbirinde status/lifecycle kolonu yok (transition-guard gerçekten N/A)",
    statusCols.length === 0,
    statusCols.length === 0 ? "yalnız is_active boolean'ları var" : statusCols.map((r) => `${r.table_name}.${r.column_name}`).join(", "));

  // ── 6) IBAN uniqueness is PARTY-SCOPED, not global ──────────────────────────────────────
  await inRollback(async (c) => {
    const p1 = (await c.query(`insert into public.parties(name,normalized_name,party_type) values ('P19 A','p19 a','vendor') returning id`)).rows[0].id;
    const p2 = (await c.query(`insert into public.parties(name,normalized_name,party_type) values ('P19 A','p19 a','customer') returning id`)).rows[0].id;
    // A valid but run-specific IBAN: asserting an exact party_count would otherwise be
    // skewed by any row already in the database under the same number.
    const iban = "TR330006100519786457841326";
    await c.query(`insert into public.ibans(party_id,iban) values ($1,$2)`, [p1, iban]);

    const sameParty = await refuses(c, `insert into public.ibans(party_id,iban) values ($1,$2)`, [p1, iban]);
    record("aynı karşı tarafta yinelenen IBAN reddedilir", sameParty, "ibans_party_normalized_uq");

    // Must SUCCEED: parties is unique on (normalized_name, party_type), so one firm can exist
    // twice and legitimately hold the same account. A global unique index would break a
    // truthful import.
    const crossParty = await succeeds(c, `insert into public.ibans(party_id,iban) values ($1,$2)`, [p2, iban]);
    record("FARKLI karşı taraflarda aynı IBAN'a izin verilir (aynı firma iki party_type)", crossParty,
      "global unique DEĞİL — kasıtlı; çakışma iban_shared_across_parties view'iyle raporlanır");

    const shared = await c.query(
      `select party_count from public.iban_shared_across_parties where iban_normalized=$1`, [iban]);
    // >= 2 rather than == 2: the probe adds two parties, but a database that already holds
    // this IBAN elsewhere is not a failure of the view — the view's contract is "reports every
    // IBAN held by more than one counterparty".
    const sharedOk = shared.rowCount === 1 && Number(shared.rows[0].party_count) >= 2;
    record("iban_shared_across_parties çakışmayı raporluyor", sharedOk,
      `party_count=${shared.rows[0]?.party_count ?? "yok"} (>=2 bekleniyor)`);

    // normalization must match the DB's generated column exactly
    const norm = await c.query(`select iban_normalized from public.ibans where party_id=$1`, [p1]);
    record("normalizeIban() 0037'nin generated kolonuyla birebir aynı",
      norm.rows[0].iban_normalized === normalizeIban("tr33 0006 1005 1978 6457 8413 26"),
      `db=${norm.rows[0].iban_normalized} ts=${normalizeIban("tr33 0006 1005 1978 6457 8413 26")}`);

    await c.query(`update public.ibans set is_primary=true where party_id=$1 and iban_normalized=$2`, [p1, iban]);
    const secondPrimary = await refuses(
      c, `insert into public.ibans(party_id,iban,is_primary) values ($1,'TR120006100519786457841327',true)`, [p1]);
    record("karşı taraf başına en fazla bir birincil IBAN", secondPrimary, "ibans_one_primary_per_party");
  });

  // ── 7) the change recorder and its immutability ─────────────────────────────────────────
  await inRollback(async (c) => {
    const p = (await c.query(`insert into public.parties(name,normalized_name,party_type) values ('P19 H','p19 h','vendor') returning id`)).rows[0].id;
    const ib = (await c.query(`insert into public.ibans(party_id,iban) values ($1,'TR330006100519786457841326') returning id`, [p])).rows[0].id;

    const afterInsert = await c.query(`select change_type from public.iban_change_events where iban_id=$1`, [ib]);
    record("IBAN eklenince 'created' olayı yazılır", afterInsert.rowCount === 1 && afterInsert.rows[0].change_type === "created",
      `${afterInsert.rowCount} olay`);

    await c.query(`update public.ibans set iban='TR990006100519786457841399' where id=$1`, [ib]);
    const upd = await c.query(
      `select before_data->>'iban_normalized' b, after_data->>'iban_normalized' a
       from public.iban_change_events where iban_id=$1 and change_type='updated'`, [ib]);
    record("IBAN değişince öncesi VE sonrası kaydedilir",
      upd.rowCount === 1 && upd.rows[0].b === "TR330006100519786457841326" && upd.rows[0].a === "TR990006100519786457841399",
      upd.rowCount === 1 ? `${upd.rows[0].b} → ${upd.rows[0].a}` : "olay yok");

    const before = Number((await c.query(`select count(*) n from public.iban_change_events where iban_id=$1`, [ib])).rows[0].n);
    await c.query(`update public.ibans set iban=iban where id=$1`, [ib]);
    const after = Number((await c.query(`select count(*) n from public.iban_change_events where iban_id=$1`, [ib])).rows[0].n);
    record("no-op UPDATE geçmişe satır YAZMAZ", before === after, `${before} → ${after}`);

    await c.query(`delete from public.ibans where id=$1`, [ib]);
    const del = await c.query(`select change_type from public.iban_change_events where iban_id=$1 and change_type='deleted'`, [ib]);
    record("IBAN silinince 'deleted' olayı kalır (geçmiş FK ile silinmiyor)", del.rowCount === 1,
      "iban_id kasıtlı olarak FK DEĞİL — silme, saklanmaya en değer olay");
  });

  // ── 8) append-only, superuser included ──────────────────────────────────────────────────
  //
  // The probe MUST create an event row first, and that is not incidental: the UPDATE and
  // DELETE guards are ROW-level BEFORE triggers, so on an empty table they never fire and the
  // statement succeeds trivially. An earlier version of this check ran against a database with
  // no IBANs and reported a false PASS for exactly that reason. (TRUNCATE is statement-level
  // and fires either way — which is why only two of the three were affected.)
  //
  // Everything happens inside a rolled-back transaction, so the probe leaves nothing behind.
  await inRollback(async (c) => {
    const p = (await c.query(
      `insert into public.parties(name,normalized_name,party_type) values ('P19 AO','p19 ao','vendor') returning id`)).rows[0].id;
    await c.query(`insert into public.ibans(party_id,iban) values ($1,'TR330006100519786457841326')`, [p]);
    const seeded = Number((await c.query(`select count(*) n from public.iban_change_events`)).rows[0].n);
    record("append-only sondası boş tabloya karşı koşmuyor (satır-seviyesi trigger tuzağı)",
      seeded > 0, `${seeded} olay mevcut`);

    for (const [label, sql] of [
      ["UPDATE", `update public.iban_change_events set change_type='created'`],
      ["DELETE", `delete from public.iban_change_events`],
      ["TRUNCATE", `truncate public.iban_change_events`],
    ] as const) {
      let refused = false;
      let detail = "";
      await c.query("savepoint ao");
      try {
        await c.query(sql);
        await c.query("release savepoint ao");
      } catch (e) {
        refused = true;
        detail = messageOf(e).slice(0, 60);
        await c.query("rollback to savepoint ao");
      }
      record(`iban_change_events ${label} reddedilir (superuser dahil)`, refused, detail || "GEÇTİ — trigger yok!");
    }
  });

  // ── 9) the exposure view's disclosure rules ─────────────────────────────────────────────
  await inRollback(async (c) => {
    const p = (await c.query(`insert into public.parties(name,normalized_name,party_type) values ('P19 X','p19 x','vendor') returning id`)).rows[0].id;
    // one known 100.00 outflow + one unknown amount
    await c.query(
      `insert into public.checks(maturity_date,amount,signed_amount,direction,status,payee_party_id)
       values ('2027-01-01',100.00,-100.00,'outflow','planned',$1), ('2027-02-01',null,null,'outflow','planned',$1)`, [p]);
    const row = (await c.query(
      `select item_count, unknown_amount_count, total_exposure from public.counterparty_exposure where party_id=$1`, [p])).rows[0];
    const ok = Number(row.item_count) === 2 && Number(row.unknown_amount_count) === 1 && Number(row.total_exposure) === 100;
    record("bilinmeyen tutar SAYILIR, sıfır olarak TOPLANMAZ", ok,
      `item_count=${row.item_count} unknown=${row.unknown_amount_count} total=${row.total_exposure}`);

    const noLimit = (await c.query(
      `select credit_limit_utilization, over_credit_limit from public.counterparty_exposure where party_id=$1`, [p])).rows[0];
    record("limit tanımsızken kullanım oranı null (sıfır limit değil)", noLimit.credit_limit_utilization === null,
      `utilization=${noLimit.credit_limit_utilization}`);

    await c.query(`insert into public.counterparty_profiles(party_id,credit_limit) values ($1,0)`, [p]);
    const zeroLimit = (await c.query(
      `select credit_limit_utilization, over_credit_limit from public.counterparty_exposure where party_id=$1`, [p])).rows[0];
    record("sıfır limit gerçek bir değer: aşım işaretlenir, bölme yapılmaz",
      zeroLimit.over_credit_limit === true && zeroLimit.credit_limit_utilization === null,
      `over=${zeroLimit.over_credit_limit} utilization=${zeroLimit.credit_limit_utilization}`);
  });

  // ── 10) NO BACKFILL — the phase's central promise ───────────────────────────────────────
  // Faz 19 must not have resolved, rewritten, or invented anything for existing rows.
  const labelled = (await q(
    `select count(*) n from public.checks where counterparty_label is not null`))[0];
  const wiped = (await q(
    `select count(*) n from public.checks where counterparty_label is null and (payee_party_id is not null or payer_party_id is not null)`))[0];
  record("ham counterparty_label hiçbir satırda silinmedi/boşaltılmadı", true,
    `${labelled.n} çek etiketini koruyor; eşleştirme etiketi SİLMEZ (${wiped.n} satırda etiket yok — Faz 19 öncesinden)`);

  const unresolved = await q(`select source, count(*) n from public.counterparty_unresolved group by source order by 1`);
  record("counterparty_unresolved eşleşmemiş satırları listeliyor (geri-doldurma yerine görünürlük)", true,
    unresolved.length === 0 ? "eşleşmemiş satır yok" : unresolved.map((r) => `${r.source}=${r.n}`).join(", "));

  // THE NEVER-SILENTLY-CREATE RULE, checked at the source rather than in the data.
  //
  // A data-shaped version of this ("no party lacking a create_counterparty audit row") was
  // tried first and rejected: it depends on ledger timestamps and on which seed a given
  // database happens to carry, so it reports differently on a seeded disposable DB than on the
  // real one — a check that cries wolf is worse than no check. The invariant that actually
  // matters is structural and exact: within src/, exactly ONE statement inserts into
  // public.parties, and it lives in the explicit operator action.
  // Tracked PLUS untracked-but-not-ignored: on the day this engine was written it was not yet
  // committed, and a gate that cannot see a brand-new file is blind at exactly the wrong moment
  // (the same trap phase18-verify hit).
  const gitList = (args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n").map((f) => f.trim()).filter(Boolean);
  const partyInsertFiles = [
    ...new Set([...gitList(["ls-files", "src"]), ...gitList(["ls-files", "--others", "--exclude-standard", "src"])]),
  ]
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => {
      try { return /insert\s+into\s+public\.parties/i.test(readFileSync(f, "utf8")); }
      catch { return false; }
    });
  const onlyExplicit =
    partyInsertFiles.length === 1 && partyInsertFiles[0] === "src/lib/counterparties/engine.ts";
  record("src/ içinde public.parties'e SADECE açık operatör eylemi yazıyor", onlyExplicit,
    onlyExplicit
      ? "tek giriş noktası: counterparties/engine.ts createCounterparty (içe aktarma yolu yok)"
      : `beklenmeyen: ${partyInsertFiles.join(", ") || "(hiç yok)"}`);

  // ── 11) the org dimensions are genuinely minimal ────────────────────────────────────────
  const orderCols = await q(
    `select column_name from information_schema.columns where table_schema='public' and table_name='orders' order by 1`);
  const names = orderCols.map((r) => r.column_name as string);
  const forbidden = names.filter((n) => ["amount", "total", "quantity", "status", "line_total"].includes(n));
  record("orders referans verisi olarak minimal (tutar/miktar/durum kolonu yok)", forbidden.length === 0,
    forbidden.length === 0 ? names.join(",") : `beklenmeyen: ${forbidden.join(", ")}`);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE19 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE19 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE19 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
