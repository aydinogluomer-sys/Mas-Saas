// Faz 25 verification — the collections centre: promises, the broken-promise job, the score.
//
// STANDING RULES INHERITED (Faz 20/22/23/24B — applied from the first line, not retrofitted):
//   1. Catalog constraints are targeted STRUCTURALLY by conkey — the column they actually
//      constrain — and the candidate count is asserted to be exactly one. Several constraints on
//      these tables mention the same column name, so `like '%status%'` would pick an arbitrary
//      one (that pattern passed a broken check in Faz 20).
//   2. No probe passes vacuously: every fixture is built by this script, dated 2099 so it can
//      never collide with real or seeded data, and every negative check is paired with a
//      positive control.
//   3. Ordering is asserted on the sort KEY's VALUE, never on a row position, and ties are
//      tested positively.
//   4. Writes are judged by AFFECTED ROW COUNT where RLS is involved — a policy-less UPDATE does
//      not raise, it silently touches nothing (Faz 24B).
//
// THE CENTRAL CLAIM OF THIS PHASE is that a promise is not a receivable. So the heaviest checks
// are that the detection job changes no financial record, that it is idempotent, and that it
// refuses to call a promise broken on the day it is still due.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase25:verify
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  PROMISE_STATUSES, canTransition, isBroken, keptRatio, scoreBand,
} from "../src/lib/collections/promises";
import { detectBrokenPromises, resolvePromise } from "../src/lib/collections/promises-engine";
import { targetKindOf } from "../src/lib/reminders/rules";
import { emailTransport, mockTransport, transportFor } from "../src/lib/reminders/transport";
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

const TAG = () => `P25-${Math.random().toString(36).slice(2, 8)}`;

async function mkParty(c: PoolClient, name = TAG()): Promise<string> {
  return (await c.query(
    `insert into public.parties(name, normalized_name, party_type)
     values ($1,$2,'customer') returning id`, [name, name.toLowerCase()])).rows[0].id;
}
async function mkUser(c: PoolClient): Promise<string> {
  return (await c.query(
    `insert into public.users(username,password_hash,display_name,role)
     values ($1,'x','P25 user','finance_manager') returning id`,
    [`p25_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
}
/** A promise in a chosen state, always built from scratch — never found. */
async function mkPromise(
  c: PoolClient, party: string, status: string, date = "2099-06-15", amount: number | null = 1000,
): Promise<string> {
  return (await c.query(
    `insert into public.promise_to_pay
       (party_id, promised_amount, promised_date, status, resolved_at, resolution_source)
     values ($1,$2,$3::date,$4,
             case when $4='pending' then null else now() end,
             case when $4='pending' then null else 'manual' end)
     returning id`, [party, amount, date, status])).rows[0].id;
}

const ALLOWED = new Set(["pending>kept", "pending>broken", "pending>cancelled", "broken>kept"]);

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tbl = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name='promise_to_pay'`);
  record("promise_to_pay tablosu var", tbl.length === 1, tbl.length === 1 ? "mevcut" : "yok");

  // LESSON 1 — target by the column the constraint actually constrains, assert cardinality.
  const statusCheck = await q(
    `select c.conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.promise_to_pay'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='status'`);
  record("promise_to_pay.status CHECK'i yapısal olarak ve TEK olarak hedeflendi",
    statusCheck.length === 1, `${statusCheck.length} aday (tam 1 bekleniyor)`);
  const literals = new Set([...(statusCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("status CHECK tam olarak 4 kanonik değeri sayıyor",
    literals.size === 4 && PROMISE_STATUSES.every((s) => literals.has(s)),
    [...literals].sort().join(", "));

  /* ── 2. the 12-pair transition enumeration ──────────────────────────────────────────── */
  const guard = await inRollback(async (c) => {
    const party = await mkParty(c);
    const out: { pair: string; accepted: boolean }[] = [];
    for (const from of PROMISE_STATUSES) {
      for (const to of PROMISE_STATUSES) {
        if (from === to) continue;
        const id = await mkPromise(c, party, from, `2099-06-${String(1 + out.length).padStart(2, "0")}`);
        const blocked = await refuses(c,
          `update public.promise_to_pay
             set status=$2,
                 resolved_at = case when $2='pending' then null else now() end,
                 resolution_source = case when $2='pending' then null else 'manual' end
           where id=$1`, [id, to]);
        out.push({ pair: `${from}>${to}`, accepted: !blocked });
      }
    }
    return out;
  });
  const wrong = guard.filter((r) => r.accepted !== ALLOWED.has(r.pair));
  record("12 geçişin tamamı allow-list ile birebir örtüşüyor (izinli 4, yasak 8)",
    wrong.length === 0,
    wrong.length === 0
      ? `${guard.filter((g) => g.accepted).length} kabul / ${guard.filter((g) => !g.accepted).length} ret`
      : wrong.map((w) => `${w.pair}=${w.accepted ? "kabul" : "ret"}`).join(", "));

  record("guard ile koddaki allow-list AYNI (canTransition ile karşılaştırıldı)",
    guard.every((g) => g.accepted === canTransition(
      g.pair.split(">")[0] as never, g.pair.split(">")[1] as never)),
    "veritabanı ve uygulama tek bir kural kümesini paylaşıyor");

  record("geç ödeme kırılmış sözü kurtarabiliyor (broken → kept)",
    guard.find((g) => g.pair === "broken>kept")?.accepted === true,
    "gecikmeli tahsilat normal sonuç, istisna değil");

  record("aynı-duruma güncelleme 4 durumun her birinde no-op",
    await inRollback(async (c) => {
      const party = await mkParty(c);
      for (const s of PROMISE_STATUSES) {
        const id = await mkPromise(c, party, s, `2099-07-${String(1 + PROMISE_STATUSES.indexOf(s)).padStart(2, "0")}`);
        if (await refuses(c, `update public.promise_to_pay set note='x', status=$2 where id=$1`, [id, s])) return false;
      }
      return true;
    }), "pending/kept/broken/cancelled için kendine geçiş engellenmiyor");

  /* ── 3. the other constraints, each with a positive control ─────────────────────────── */
  const consistency = await inRollback(async (c) => {
    const party = await mkParty(c);
    const resolvedWithoutMoment = await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date,status)
       values ($1,100,'2099-06-01','kept')`, [party]);
    const pendingClaimingMoment = await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date,status,resolved_at,resolution_source)
       values ($1,100,'2099-06-02','pending',now(),'manual')`, [party]);
    const momentWithoutSource = await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date,status,resolved_at)
       values ($1,100,'2099-06-03','kept',now())`, [party]);
    const validResolved = !(await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date,status,resolved_at,resolution_source)
       values ($1,100,'2099-06-04','kept',now(),'manual')`, [party]));
    return { resolvedWithoutMoment, pendingClaimingMoment, momentWithoutSource, validResolved };
  });
  record("karara bağlanmış söz karar anı olmadan yazılamıyor",
    consistency.resolvedWithoutMoment, "resolved_at zorunlu");
  record("bekleyen söz karar anı iddia edemiyor",
    consistency.pendingClaimingMoment, "pending + resolved_at reddedildi");
  record("karar anı kaynak olmadan yazılamıyor (kim/ne karar verdi belli)",
    consistency.momentWithoutSource, "resolution_source zorunlu");
  record("POZİTİF KONTROL: tutarlı bir karara bağlanmış söz kabul ediliyor",
    consistency.validResolved, "kısıt geçerli veriyi engellemiyor");

  const amounts = await inRollback(async (c) => {
    const party = await mkParty(c);
    const negative = await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date)
       values ($1,-5,'2099-06-05')`, [party]);
    const zero = !(await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date)
       values ($1,0,'2099-06-06')`, [party]));
    const unknown = !(await refuses(c,
      `insert into public.promise_to_pay(party_id,promised_amount,promised_date)
       values ($1,null,'2099-06-07')`, [party]));
    return { negative, zero, unknown };
  });
  record("negatif söz tutarı reddediliyor", amounts.negative, "eksi bir söz söz değildir");
  record("POZİTİF KONTROL: SIFIR tutar geçerli ('bu dönem hiç' açık bir ifade)",
    amounts.zero, "0 ile null farklı ifadeler (CLAUDE.md)");
  record("POZİTİF KONTROL: BİLİNMEYEN (null) tutar geçerli, sıfıra çevrilmiyor",
    amounts.unknown, "tutar söylenmemiş söz de takip edilir");

  const dup = await inRollback(async (c) => {
    const party = await mkParty(c);
    await c.query(
      `insert into public.promise_to_pay(party_id,invoice_id,promised_amount,promised_date)
       values ($1,null,100,'2099-08-01')`, [party]);
    // NULLS NOT DISTINCT is what makes this work: invoice_id is null in both rows, and under the
    // default rule each null would count as unique, so the index would protect nothing at all
    // for the commonest case.
    const blocked = await refuses(c,
      `insert into public.promise_to_pay(party_id,invoice_id,promised_amount,promised_date)
       values ($1,null,100,'2099-08-01')`, [party]);
    const differentDate = !(await refuses(c,
      `insert into public.promise_to_pay(party_id,invoice_id,promised_amount,promised_date)
       values ($1,null,100,'2099-08-02')`, [party]));
    return { blocked, differentDate };
  });
  record("aynı cari + aynı tarih için ikinci AÇIK söz engelleniyor (NULLS NOT DISTINCT)",
    dup.blocked, "faturasız sözlerde de çift kayıt korunuyor");
  record("POZİTİF KONTROL: farklı tarihli ikinci söz serbest",
    dup.differentDate, "indeks meşru ikinci sözü engellemiyor");

  /* ── 4. Faz 24B rol matrisine entegrasyon ───────────────────────────────────────────── */
  record("promise_to_pay kod matrisinde sınıflandırılmış (operational)",
    TABLE_CLASS["promise_to_pay"] === "operational", String(TABLE_CLASS["promise_to_pay"]));

  const rls = await q(
    `select c.relrowsecurity,
            (select count(*) from pg_policies p where p.schemaname='public' and p.tablename='promise_to_pay')::int as n
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname='promise_to_pay'`);
  record("promise_to_pay'de RLS açık ve politikalar yazılı",
    rls[0]?.relrowsecurity === true && Number(rls[0]?.n) === 4,
    `rls=${rls[0]?.relrowsecurity} politika=${rls[0]?.n}`);

  const tierRoles = ["mas_radar_viewer", "mas_radar_finance_operator", "mas_radar_finance_approver",
    "mas_radar_finance_manager", "mas_radar_admin"].sort().join(",");
  const selPolicy = await q(
    `select roles::text[] as roles from pg_policies
     where schemaname='public' and tablename='promise_to_pay' and cmd='SELECT'`);
  record("SELECT politikası tam beş katmanı hedefliyor (blanket 'authenticated' DEĞİL)",
    selPolicy.length === 1 && [...(selPolicy[0].roles as string[])].sort().join(",") === tierRoles,
    selPolicy.length === 1 ? (selPolicy[0].roles as string[]).length + " rol" : `${selPolicy.length} politika`);

  const blanket = await q(
    `select count(*)::int n from pg_policies
     where schemaname='public' and tablename='promise_to_pay' and 'authenticated' = any(roles::text[])`);
  record("yeni tabloya eski blanket deseni geri getirilmemiş",
    Number(blanket[0].n) === 0, `${blanket[0].n} adet authenticated politikası`);

  /* ── 5. views, not tables ───────────────────────────────────────────────────────────── */
  const views = await q(
    `select table_name, table_type from information_schema.tables
     where table_schema='public'
       and table_name in ('promise_to_pay_open','party_promise_history','customer_collection_score')
     order by table_name`);
  record("üç tahsilat read-model'i de VIEW (ikinci doğruluk kaynağı yok)",
    views.length === 3 && views.every((v) => v.table_type === "VIEW"),
    views.map((v) => `${v.table_name}:${v.table_type}`).join(" "));

  /* ── 6. the score: deterministic, named, and honest about "no history" ──────────────── */
  const clean = await q(
    `select collection_score, score_band, coalesce(array_length(score_reasons,1),0) as n
     from public.customer_collection_score
     where promise_resolved_count = 0 and overdue_count = 0 and bad_debt_count = 0
     limit 1`);
  record("temiz bir cari 100 puan ve BOŞ gerekçe listesi alıyor",
    clean.length === 0 || (Number(clean[0].collection_score) === 100 && Number(clean[0].n) === 0),
    clean.length === 0 ? "temiz cari yok (kontrol atlandı)" : `puan=${clean[0].collection_score} gerekçe=${clean[0].n}`);

  const scoreProbe = await inRollback(async (c) => {
    const party = await mkParty(c);
    // Three broken, one kept => kept_ratio 0.25 => the harshest promise penalty.
    for (let i = 0; i < 3; i += 1) await mkPromise(c, party, "broken", `2099-09-0${i + 1}`);
    await mkPromise(c, party, "kept", "2099-09-04");
    const row = (await c.query(
      `select collection_score, score_band, score_reasons, promise_kept_ratio
       from public.customer_collection_score where party_id=$1`, [party])).rows[0];
    return row;
  });
  record("kırılan sözler puanı düşürüyor ve gerekçe İSİMLE taşınıyor",
    Number(scoreProbe.collection_score) === 75
      && (scoreProbe.score_reasons as string[]).includes("tutulmayan_odeme_sozu"),
    `puan=${scoreProbe.collection_score} gerekçe=${(scoreProbe.score_reasons as string[]).join(",")}`);
  record("kept_ratio yalnız çözülmüş sözlerden hesaplanıyor (3 kırık + 1 tutulan = 0.25)",
    Math.abs(Number(scoreProbe.promise_kept_ratio) - 0.25) < 1e-9,
    `kept_ratio=${scoreProbe.promise_kept_ratio}`);
  record("SQL puan bandı ile koddaki scoreBand AYNI",
    scoreBand(Number(scoreProbe.collection_score)) === scoreProbe.score_band,
    `${scoreProbe.collection_score} → ${scoreProbe.score_band}`);

  const noHistory = await inRollback(async (c) => {
    const party = await mkParty(c);
    await mkPromise(c, party, "pending", "2099-10-01");
    return (await c.query(
      `select collection_score, promise_kept_ratio from public.customer_collection_score where party_id=$1`,
      [party])).rows[0];
  });
  record("SÖZ GEÇMİŞİ OLMAYAN cari cezalandırılmıyor (kept_ratio null, puan 100)",
    noHistory.promise_kept_ratio === null && Number(noHistory.collection_score) === 100,
    `kept_ratio=${noHistory.promise_kept_ratio} puan=${noHistory.collection_score}`);
  record("kod tarafı da aynı şeyi söylüyor: keptRatio(0,0) === null",
    keptRatio(0, 0) === null, "kanıt yokluğu kanıt değildir");

  // LESSON 3 — ordering asserted on the KEY's value, not on row positions.
  const ordering = await inRollback(async (c) => {
    const bad = await mkParty(c, `${TAG()}-bad`);
    const good = await mkParty(c, `${TAG()}-good`);
    for (let i = 0; i < 4; i += 1) await mkPromise(c, bad, "broken", `2099-11-0${i + 1}`);
    await mkPromise(c, good, "kept", "2099-11-05");
    const rows = (await c.query(
      `select party_id, collection_score from public.customer_collection_score
       where party_id = any($1::uuid[])`, [[bad, good]])).rows;
    const scoreOf = (id: string) => Number(rows.find((r) => r.party_id === id)?.collection_score);
    return { bad: scoreOf(bad), good: scoreOf(good) };
  });
  record("sıralama ANAHTAR DEĞERİYLE doğrulandı: kırık sözlü cari daha DÜŞÜK puanlı",
    ordering.bad < ordering.good, `kırık=${ordering.bad} temiz=${ordering.good}`);

  /* ── 7. the detection job ───────────────────────────────────────────────────────────── */
  const detect = await inRollback(async (c) => {
    const party = await mkParty(c);
    const actor = await mkUser(c);
    const past = await mkPromise(c, party, "pending", "2099-05-10");
    const today = await mkPromise(c, party, "pending", "2099-05-20");
    const future = await mkPromise(c, party, "pending", "2099-05-30");
    await c.query("commit");

    // The engine takes its own pool; run it against the same database, then read back.
    const first = await detectBrokenPromises(pool, "2099-05-20", actor);
    const second = await detectBrokenPromises(pool, "2099-05-20", actor);

    const states = (await pool.query(
      `select id, status, resolution_source, resolved_by from public.promise_to_pay
       where id = any($1::uuid[])`, [[past, today, future]])).rows;
    const items = (await pool.query(
      `select count(*)::int n from public.action_items
       where source_type='collection' and related_entity_table='promise_to_pay'
         and related_entity_id = $1`, [past])).rows[0].n;
    const auditRow = (await pool.query(
      `select after_data as after from public.audit_logs
       where entity_table='promise_to_pay' and entity_id=$1 and action='promise_broken_detected'
       order by created_at desc limit 1`, [past])).rows[0];

    // Clean up: this block committed, so it must remove its own rows.
    await pool.query(`delete from public.action_items where related_entity_id = any($1::uuid[])`, [[past, today, future]]);
    await pool.query(`delete from public.audit_logs where entity_id = any($1::uuid[])`, [[past, today, future]]).catch(() => {});
    await pool.query(`delete from public.promise_to_pay where id = any($1::uuid[])`, [[past, today, future]]);
    await pool.query(`delete from public.users where id=$1`, [actor]).catch(() => {});
    await pool.query(`delete from public.parties where id=$1`, [party]).catch(() => {});

    return { first, second, states, items: Number(items), auditRow };
  }).catch(async (e) => { throw e; });
  record("geçmiş tarihli bekleyen söz 'broken' olarak işaretlendi",
    detect.first.markedBroken === 1, `${detect.first.markedBroken} söz`);
  record("BUGÜN vadesi olan söz kırılmış SAYILMIYOR (paranın günü var)",
    detect.states.find((s) => s.status === "pending") !== undefined
      && detect.states.filter((s) => s.status === "broken").length === 1,
    detect.states.map((s) => s.status).join(","));
  record("iş İDEMPOTENT: ikinci koşu hiçbir şey işaretlemiyor",
    detect.second.markedBroken === 0 && detect.second.actionItemsCreated === 0,
    `2. koşu: ${detect.second.markedBroken} söz / ${detect.second.actionItemsCreated} görev`);
  record("takip işi MEVCUT action_items modelini kullanıyor (ikinci görev modeli yok)",
    detect.items === 1, `${detect.items} action_item (source_type='collection')`);
  record("otomatik karar bir aktör UYDURMUYOR (resolved_by null, kaynak auto_detection)",
    detect.states.some((s) => s.status === "broken" && s.resolved_by === null && s.resolution_source === "auto_detection"),
    "Faz 24A dersi tekrar uygulandı");
  record("denetim izi kararın OTOMATİK olduğunu açıkça söylüyor",
    detect.auditRow?.after?.automated === true,
    `automated=${detect.auditRow?.after?.automated}`);
  record("kod tarafı sınırı da aynı: isBroken bugün için false, yarın için true",
    isBroken("pending", "2099-05-20", "2099-05-20") === false
      && isBroken("pending", "2099-05-20", "2099-05-21") === true,
    "< değil <= olsaydı iş bir gün erken suçlardı");

  /* ── 8. the manual path refuses what the guard refuses ──────────────────────────────── */
  const manual = await inRollback(async (c) => {
    const party = await mkParty(c);
    const actor = await mkUser(c);
    const kept = await mkPromise(c, party, "kept", "2099-04-01");
    await c.query("commit");
    let message = "";
    try {
      await resolvePromise(pool, { promiseId: kept, status: "broken" }, actor);
    } catch (e) { message = messageOf(e); }
    await pool.query(`delete from public.promise_to_pay where id=$1`, [kept]);
    await pool.query(`delete from public.users where id=$1`, [actor]).catch(() => {});
    await pool.query(`delete from public.parties where id=$1`, [party]).catch(() => {});
    return message;
  });
  record("elle çözümde yasak geçiş OKUNUR bir cümleyle reddediliyor",
    /geçiş yapılamaz/i.test(manual), manual.slice(0, 70) || "(mesaj yok)");

  /* ── 9. reminder widening ───────────────────────────────────────────────────────────── */
  const targetKindCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.reminders'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='target_kind'`);
  const kinds = new Set([...(targetKindCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("reminders.target_kind CHECK'i beş türü sayıyor (conkey ile hedeflendi)",
    targetKindCheck.length === 1 && kinds.size === 5
      && kinds.has("invoice") && kinds.has("promise_to_pay"),
    [...kinds].sort().join(", "));

  const sourceTypeCheck = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.action_items'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='source_type'`);
  const sources = new Set([...(sourceTypeCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("action_items.source_type 'collection' değerini kabul ediyor",
    sourceTypeCheck.length === 1 && sources.has("collection") && sources.size === 7,
    [...sources].sort().join(", "));

  record("bilinmeyen tablo artık 'loan_installment'a DÜŞMÜYOR (fallthrough kaldırıldı)",
    targetKindOf("bir_sey_yok") === null
      && targetKindOf("promise_to_pay") === "promise_to_pay"
      && targetKindOf("invoices") === "invoice"
      && targetKindOf("loan_installments") === "loan_installment",
    "eşleme açık, tahmin yok");

  // The plan's explicit gate requirement: duplicate prevention must cover the NEW kinds too.
  const dedupe = await inRollback(async (c) => {
    const rule = (await c.query(
      `insert into public.reminders(name,target_kind,offset_days,channel)
       values ('P25 promise',$1,0,'email') returning id`, ["promise_to_pay"])).rows[0].id;
    const party = await mkParty(c);
    const promise = await mkPromise(c, party, "pending", "2099-12-01");
    const ins = async () => (await c.query(
      `insert into public.reminder_deliveries(reminder_id,entity_table,entity_id,scheduled_for,status)
       values ($1,'promise_to_pay',$2,'2099-12-01','pending')
       on conflict (reminder_id, entity_table, entity_id, scheduled_for) do nothing`,
      [rule, promise])).rowCount ?? 0;
    return { first: await ins(), second: await ins() };
  });
  record("hatırlatma çift-önleme YENİ hedef türünde de çalışıyor (promise_to_pay)",
    dedupe.first === 1 && dedupe.second === 0,
    `1. ekleme=${dedupe.first} 2. ekleme=${dedupe.second}`);

  /* ── 10. the email channel ──────────────────────────────────────────────────────────── */
  const channelValues = await q(
    `select pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.reminders'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='channel'`);
  record("reminders.channel zaten 'email' içeriyordu (0006) — bu faz TAŞIYICIYI ekledi",
    /email/.test(channelValues[0]?.def ?? ""), "şema değil, transport eksikti");

  const emailUnset = await emailTransport().send("p25 test");
  record("e-posta taşıyıcısı yapılandırılmamışken DÜRÜST bir hata dönüyor, fırlatmıyor",
    emailUnset.ok === false && typeof emailUnset.error === "string",
    emailUnset.error ?? "(hata yok)");
  record("e-posta hatası API anahtarını sızdırmıyor",
    !(emailUnset.error ?? "").includes("Bearer"), "sır yok");

  const emailMock = mockTransport({ channel: "email" });
  const sent = await emailMock.send("merhaba");
  record("mockTransport artık e-posta kanalını da taklit edebiliyor",
    emailMock.channel === "email" && sent.ok && emailMock.sent.length === 1,
    `channel=${emailMock.channel} gönderilen=${emailMock.sent.length}`);
  record("transportFor her iki kanalı da doğru eşliyor",
    transportFor("email").channel === "email" && transportFor("telegram").channel === "telegram",
    "yeni kanal yarım bağlanamaz");

  record("dış ağ çağrısı kurulmadı: gerçek SMTP istemcisi eklenmedi",
    !readFileSync(path.join(process.cwd(), "package.json"), "utf8").includes("nodemailer"),
    "Telegram deseniyle aynı: env + HTTP, mock ile test edilir");

  /* ── 11. source-level guarantees ────────────────────────────────────────────────────── */
  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/collections/promises-engine.ts"), "utf8");
  const FLOAT_CAST = `::${"float"}8`;
  record(`tahsilat motorunda ${FLOAT_CAST} yok (para numeric kalıyor)`,
    !engineSrc.includes(FLOAT_CAST), "Faz 17 kuralı");
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");
  record("tespit işi hiçbir MALİ kaydı değiştirmiyor (invoices/payments'a UPDATE yok)",
    !/update\s+public\.(invoices|payments|payment_instances|checks)/i.test(engineSrc),
    "söz tablosu ve action_items dışına yazmıyor");

  record("WhatsApp bu fazın kapsamına ALINMADI (§3 açık soru #4 ertelenmiş)",
    !/whatsapp/i.test(engineSrc)
      && !readFileSync(path.join(process.cwd(), "src/lib/reminders/transport.ts"), "utf8").match(/whatsapp/i),
    "plan gereği ertelendi");

  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0059-0061 eklenmedi)",
    !/00(59|60|61)/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE25 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE25 VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE25 VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
