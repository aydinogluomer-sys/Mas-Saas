// Faz 24A verification — the Approval entity, its guard, and the legacy consolidation.
//
// STANDING RULES INHERITED (Faz 20, 22, 23 — applied from the first line here, not retrofitted):
//   1. Catalog queries that can return more than one row have their CARDINALITY ASSERTED, and
//      constraints are targeted STRUCTURALLY by conkey (the column they actually constrain),
//      never by `like '%status%'`. That pattern passed a broken check in Faz 20.
//   2. No probe passes vacuously. Every probe builds its own rows, and every negative check is
//      paired with a positive control proving the probe can observe success at all.
//   3. Ordering assertions compare the sort KEY's VALUE, never a row position, because ties are
//      normal here and `order by` gives no defined order among equals (Faz 23).
//   Turkish exception text is matched as Turkish (Faz 22).
//
// THE CENTRAL CLAIM OF THIS PHASE is the consolidation: two independent review systems now feed
// ONE entity, and no legacy write path changed behaviour. So the heaviest checks below are not
// about approvals at all — they are about mapping_reviews and external_assumptions still doing
// exactly what they did, including the arbitrary status jumps six gate scripts depend on.
//
// Usage:
//   MIGRATION_DATABASE_URL=... pnpm phase24a:verify
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
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

/* ── fixtures ─────────────────────────────────────────────────────────────────────────── */

async function mkUser(c: PoolClient, tag: string): Promise<string> {
  return (await c.query(
    `insert into public.users(username, password_hash, display_name, role)
     values ($1,'x',$2,'finance_manager') returning id`,
    [`p24a_${tag}_${Math.random().toString(36).slice(2, 8)}`, `P24A ${tag}`])).rows[0].id;
}
async function mkReview(c: PoolClient, status = "open"): Promise<string> {
  const wb = (await c.query(
    `insert into public.source_workbooks(original_filename,status) values ($1,'parsed') returning id`,
    [`p24a_${Math.random().toString(36).slice(2, 8)}.xlsx`])).rows[0].id;
  return (await c.query(
    `insert into public.mapping_reviews(workbook_id,issue_type,severity,message,status)
     values ($1,'p24a_issue','high','Faz 24A probe',$2) returning id`, [wb, status])).rows[0].id;
}
/** An approval in a chosen state, built from scratch — never found. */
async function mkApproval(c: PoolClient, status: string, requester: string): Promise<string> {
  const id = (await c.query(
    `insert into public.approvals
       (subject_table, subject_id, request_kind, status, requested_by, decided_at)
     values ('invoices', gen_random_uuid(), 'other', 'pending', $1, null) returning id`,
    [requester])).rows[0].id;
  if (status === "pending") return id;
  if (status === "reworked") {
    await c.query(`update public.approvals set status='reworked' where id=$1`, [id]);
    return id;
  }
  // approved / rejected need a decider and a moment, per approvals_decision_consistency.
  const checker = await mkUser(c, "checker");
  await c.query(
    `update public.approvals set status=$2, decided_by=$3, decided_at=now() where id=$1`,
    [id, status, checker]);
  return id;
}

const ALL_STATUSES = ["pending", "approved", "rejected", "reworked"] as const;
const ALLOWED = new Set([
  "pending>approved", "pending>rejected", "pending>reworked",
  "reworked>pending", "reworked>rejected",
]);

async function main(): Promise<void> {
  /* ── 1. structure ───────────────────────────────────────────────────────────────────── */
  const tables = await q(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name in ('approvals','approval_steps','approval_rules')
     order by table_name`);
  record("approvals / approval_steps / approval_rules tabloları var",
    tables.length === 3, tables.map((t) => t.table_name).join(", ") || "eksik");

  const viewKind = await q(
    `select table_type from information_schema.tables
     where table_schema='public' and table_name='approval_queue'`);
  record("approval_queue bir VIEW (ikinci doğruluk kaynağı değil)",
    viewKind.length === 1 && viewKind[0].table_type === "VIEW",
    viewKind[0]?.table_type ?? "yok");

  // LESSON 1: target the status CHECK by the column it constrains, and assert cardinality.
  const statusCheck = await q(
    `select c.conname, pg_get_constraintdef(c.oid) as def
     from pg_constraint c
     join pg_attribute a on a.attrelid=c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid='public.approvals'::regclass and c.contype='c'
       and cardinality(c.conkey)=1 and a.attname='status'`);
  record("approvals.status CHECK'i tek ve yapısal olarak hedeflendi",
    statusCheck.length === 1, `${statusCheck.length} aday (tam 1 bekleniyor)`);
  const statusLiterals = new Set(
    [...(statusCheck[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  record("status CHECK tam olarak 4 kanonik değeri sayıyor",
    statusLiterals.size === 4 && ALL_STATUSES.every((s) => statusLiterals.has(s)),
    [...statusLiterals].sort().join(", "));

  /* ── 2. THE 16-PAIR ENUMERATION ─────────────────────────────────────────────────────── */
  // Every (old,new) pair the CHECK admits, tested against a REAL row. The 0027 failure was an
  // allow-list narrower than the CHECK; the only way to know is to try all of them.
  const guardResults = await inRollback(async (c) => {
    const requester = await mkUser(c, "maker");
    const out: { pair: string; accepted: boolean }[] = [];
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        if (from === to) continue;
        const id = await mkApproval(c, from, requester);
        const checker = await mkUser(c, "c2");
        const sql = `update public.approvals
                       set status=$2,
                           decided_by = case when $2 in ('approved','rejected') then $3::uuid else decided_by end,
                           decided_at = case when $2 in ('approved','rejected') then now() else null end
                     where id=$1`;
        const blocked = await refuses(c, sql, [id, to, checker]);
        out.push({ pair: `${from}>${to}`, accepted: !blocked });
      }
    }
    return out;
  });
  const wrong = guardResults.filter((r) => r.accepted !== ALLOWED.has(r.pair));
  record("12 geçişin tamamı allow-list ile birebir örtüşüyor (izinli 5, yasak 7)",
    wrong.length === 0,
    wrong.length === 0
      ? `${guardResults.filter((r) => r.accepted).length} kabul / ${guardResults.filter((r) => !r.accepted).length} ret`
      : wrong.map((w) => `${w.pair}=${w.accepted ? "kabul" : "ret"}`).join(", "));
  record("aynı-duruma güncelleme 4 durumun her birinde no-op",
    await inRollback(async (c) => {
      const requester = await mkUser(c, "same");
      for (const s of ALL_STATUSES) {
        const id = await mkApproval(c, s, requester);
        if (await refuses(c, `update public.approvals set notes='x', status=$2 where id=$1`, [id, s])) return false;
      }
      return true;
    }), "pending/approved/rejected/reworked için kendine geçiş engellenmiyor");

  /* ── 3. maker-checker, with a positive control (LESSON 2) ───────────────────────────── */
  const makerChecker = await inRollback(async (c) => {
    const maker = await mkUser(c, "m");
    const other = await mkUser(c, "o");
    const idSame = await mkApproval(c, "pending", maker);
    const sameBlocked = await refuses(c,
      `update public.approvals set status='approved', decided_by=$2, decided_at=now() where id=$1`,
      [idSame, maker]);
    const idDiff = await mkApproval(c, "pending", maker);
    const diffBlocked = await refuses(c,
      `update public.approvals set status='approved', decided_by=$2, decided_at=now() where id=$1`,
      [idDiff, other]);
    return { sameBlocked, diffAccepted: !diffBlocked };
  });
  record("talep eden kendi onayını veremiyor (maker-checker, DB seviyesinde)",
    makerChecker.sameBlocked, "aynı kullanıcı reddedildi");
  record("POZİTİF KONTROL: farklı bir kontrolör onaylayabiliyor",
    makerChecker.diffAccepted, "sonda boş yere geçen bir kontrol değil");

  const decisionConsistency = await inRollback(async (c) => {
    const maker = await mkUser(c, "dc");
    const id = await mkApproval(c, "pending", maker);
    const checker = await mkUser(c, "dc2");
    const noMoment = await refuses(c,
      `update public.approvals set status='approved', decided_by=$2 where id=$1`, [id, checker]);
    const id2 = await mkApproval(c, "pending", maker);
    const falseMoment = await refuses(c,
      `update public.approvals set decided_at=now() where id=$1`, [id2]);
    return { noMoment, falseMoment };
  });
  record("karar anı olmadan onaylanamıyor", decisionConsistency.noMoment, "decided_at zorunlu");
  record("karara bağlanmamış onay karar anı iddia edemiyor",
    decisionConsistency.falseMoment, "pending + decided_at reddedildi");

  /* ── 4. approval_steps append-only ──────────────────────────────────────────────────── */
  const appendOnly = await inRollback(async (c) => {
    const maker = await mkUser(c, "ao");
    const id = await mkApproval(c, "pending", maker);
    await c.query(
      `insert into public.approval_steps(approval_id, step_no, action, to_status)
       values ($1,1,'requested','pending')`, [id]);
    return {
      insertWorks: true,
      upd: await refuses(c, `update public.approval_steps set note='x' where approval_id=$1`, [id]),
      del: await refuses(c, `delete from public.approval_steps where approval_id=$1`, [id]),
      trunc: await refuses(c, `truncate public.approval_steps`),
    };
  });
  record("POZİTİF KONTROL: approval_steps'e ekleme çalışıyor",
    appendOnly.insertWorks, "salt-ekleme testi boşlukta değil");
  record("approval_steps UPDATE/DELETE/TRUNCATE engelli (0022 deseni)",
    appendOnly.upd && appendOnly.del && appendOnly.trunc,
    `update=${appendOnly.upd} delete=${appendOnly.del} truncate=${appendOnly.trunc}`);

  const stepFk = await q(
    `select count(*)::int n from pg_constraint
     where conrelid='public.approval_steps'::regclass and contype='f'
       and confrelid='public.approvals'::regclass`);
  record("approval_steps.approval_id kasıtlı olarak FK DEĞİL (kanıt cascade ile silinmesin)",
    Number(stepFk[0].n) === 0, "0037/0046 emsali: TRUNCATE CASCADE FK'ları izler");

  /* ── 5. RLS on every new table ──────────────────────────────────────────────────────── */
  const rls = await q(
    `select c.relname, c.relrowsecurity,
            (select count(*) from pg_policies p
              where p.schemaname='public' and p.tablename=c.relname)::int as policies
     from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relname in ('approvals','approval_steps','approval_rules')
     order by c.relname`);
  record("üç yeni tabloda da RLS açık ve politika yazılı (0035'in varsayılanına güvenilmedi)",
    rls.length === 3 && rls.every((r) => r.relrowsecurity && Number(r.policies) > 0),
    rls.map((r) => `${r.relname}:${r.relrowsecurity ? "rls" : "YOK"}/${r.policies}p`).join(" "));

  /* ── 6. THE CONSOLIDATION — legacy behaviour is unchanged ───────────────────────────── */
  // This is the part that matters. Each probe asserts the LEGACY value landed, not just that an
  // approval appeared: the first version of the bridge aborted legacy writes twice, and both
  // times an approvals-only assertion would have been happy.
  const bridge = await inRollback(async (c) => {
    const id = await mkReview(c, "open");
    const r1 = (await c.query(
      `select round_no, status, subject_status from public.approvals
       where subject_table='mapping_reviews' and subject_id=$1`, [id])).rows;

    // ANONYMOUS resolve — exactly how phase4/5/12a/13a write it.
    await c.query(`update public.mapping_reviews set status='resolved', reviewed_at=now() where id=$1`, [id]);
    const legacyAfter = (await c.query(`select status from public.mapping_reviews where id=$1`, [id])).rows[0].status;
    const r2 = (await c.query(
      `select round_no, status, decided_by from public.approvals
       where subject_table='mapping_reviews' and subject_id=$1 order by round_no`, [id])).rows;

    // An illegal jump for the approvals guard (approved → pending): legacy must still win.
    await c.query(`update public.mapping_reviews set status='open' where id=$1`, [id]);
    const legacyBack = (await c.query(`select status from public.mapping_reviews where id=$1`, [id])).rows[0].status;
    const r3 = (await c.query(
      `select round_no, status from public.approvals
       where subject_table='mapping_reviews' and subject_id=$1 order by round_no`, [id])).rows;

    const steps = (await c.query(
      `select count(*)::int n from public.approval_steps s
       where s.approval_id in (select id from public.approvals
                               where subject_table='mapping_reviews' and subject_id=$1)`, [id])).rows[0].n;
    return { r1, legacyAfter, r2, legacyBack, r3, steps: Number(steps) };
  });
  record("mapping_reviews INSERT'i kendiliğinden 1. tur onay üretiyor",
    bridge.r1.length === 1 && bridge.r1[0].status === "pending" && bridge.r1[0].subject_status === "open",
    `tur=${bridge.r1[0]?.round_no} ${bridge.r1[0]?.status}/${bridge.r1[0]?.subject_status}`);
  record("ANONİM 'resolved' yazımı legacy'de BAŞARILI (gate scriptlerinin yazdığı biçim)",
    bridge.legacyAfter === "resolved", `legacy=${bridge.legacyAfter}`);
  record("kararı veren bilinmiyorsa uydurulmuyor (decided_by null kalıyor)",
    bridge.r2.length === 1 && bridge.r2[0].status === "approved" && bridge.r2[0].decided_by === null,
    "sahte atıf yerine boş atıf");
  record("guard'ın reddedeceği legacy sıçraması legacy yazımını ÖLDÜRMÜYOR",
    bridge.legacyBack === "open", `legacy=${bridge.legacyBack}`);
  record("yasak sıçrama yeni bir onay TURU açıyor (1. tur korunuyor)",
    bridge.r3.length === 2 && bridge.r3[0].status === "approved" && bridge.r3[1].status === "pending",
    bridge.r3.map((r) => `t${r.round_no}=${r.status}`).join(" "));
  record("her legacy geçişi için approval_steps izi yazılıyor",
    bridge.steps >= 3, `${bridge.steps} adım`);

  // external_assumptions: reviewed_at PRESERVATION is load-bearing for external_assumptions_check1.
  const ea = await inRollback(async (c) => {
    const id = (await c.query(
      `insert into public.external_assumptions
         (assumption_type,label,value_numeric,unit,source_kind,source_name,source_date)
       values ('interest_rate','P24A',0.45,'oran','manual','TCMB','2026-01-01') returning id`)).rows[0].id;
    const first = (await c.query(
      `select status, subject_status from public.approvals
       where subject_table='external_assumptions' and subject_id=$1`, [id])).rows;
    await c.query(`update public.external_assumptions set review_status='approved', reviewed_at=now() where id=$1`, [id]);
    await c.query(`update public.external_assumptions set review_status='rejected' where id=$1`, [id]);
    const row = (await c.query(
      `select review_status, reviewed_at is not null as kept from public.external_assumptions where id=$1`, [id])).rows[0];
    const rounds = (await c.query(
      `select round_no, status from public.approvals
       where subject_table='external_assumptions' and subject_id=$1 order by round_no`, [id])).rows;
    return { first, row, rounds };
  });
  record("external_assumptions INSERT'i de 1. tur onay üretiyor",
    ea.first.length === 1 && ea.first[0].status === "pending", `${ea.first[0]?.subject_status}`);
  record("reviewed_at KORUMA semantiği bozulmadı (approved dışında taşınmıyor)",
    ea.row.review_status === "rejected" && ea.row.kept === true,
    "external_assumptions_check1 hâlâ sağlanabilir");
  record("external_assumptions'da da yasak sıçrama yeni tur açıyor",
    ea.rounds.length === 2, ea.rounds.map((r) => `t${r.round_no}=${r.status}`).join(" "));

  // The legacy columns must have gained NO guard.
  const legacyGuards = await q(
    `select count(*)::int n from pg_trigger t
     where t.tgrelid in ('public.mapping_reviews'::regclass,'public.external_assumptions'::regclass)
       and not t.tgisinternal and t.tgname like '%transition%'`);
  record("legacy kolonlara transition guard EKLENMEDİ (6 gate scripti çalışmaya devam etsin)",
    Number(legacyGuards[0].n) === 0, "0027 hatası bilerek tekrarlanmadı");

  // Mapping function totality — every legacy value maps somewhere valid.
  const mapping = await q(
    `select v.t, v.s, public.approval_map_legacy_status(v.t, v.s) as mapped
     from (values ('mapping_reviews','open'),('mapping_reviews','accepted'),
                  ('mapping_reviews','rejected'),('mapping_reviews','resolved'),
                  ('external_assumptions','pending_review'),('external_assumptions','approved'),
                  ('external_assumptions','rejected')) v(t,s)`);
  record("her legacy değeri geçerli bir kanonik duruma eşleniyor (7/7)",
    mapping.length === 7 && mapping.every((m) => ALL_STATUSES.includes(m.mapped)),
    mapping.map((m) => `${m.s}→${m.mapped}`).join(" "));

  /* ── 7. rules configuration ─────────────────────────────────────────────────────────── */
  const scopeCheck = await inRollback(async (c) => {
    const noThreshold = await refuses(c,
      `insert into public.approval_rules(code,description,trigger_kind) values ('p24a_a','x','amount_threshold')`);
    const strayThreshold = await refuses(c,
      `insert into public.approval_rules(code,description,trigger_kind,threshold_amount)
       values ('p24a_b','x','new_iban',5000)`);
    const valid = !(await refuses(c,
      `insert into public.approval_rules(code,description,trigger_kind,threshold_amount)
       values ('p24a_c','x','amount_threshold',0)`));
    return { noThreshold, strayThreshold, valid };
  });
  record("amount_threshold kuralı eşiksiz olamıyor", scopeCheck.noThreshold, "CHECK iki yönlü");
  record("eşik, tutara bakmayan bir kurala iliştirilemiyor", scopeCheck.strayThreshold, "kapsam ayrık");
  record("POZİTİF KONTROL: sıfır eşik geçerli bir kural ('her şey onay ister')",
    scopeCheck.valid, "0 ile null farklı ifadeler");

  const seeded = await q(`select code, is_active, threshold_amount from public.approval_rules order by code`);
  record("5 varsayılan kural yüklendi, 3'ü aktif 2'si pasif",
    seeded.length === 5 && seeded.filter((r) => r.is_active).length === 3,
    seeded.map((r) => `${r.code}${r.is_active ? "" : "(pasif)"}`).join(" "));

  const thresholdMatch = await q(
    `select (select threshold_amount from public.approval_rules where code='amount_over_100k')::text as rule_v,
            (select value from public.settings where key='critical_payment_threshold_try') as setting_v`);
  const rv = Number(thresholdMatch[0].rule_v), sv = Number(thresholdMatch[0].setting_v);
  record("100k eşiği settings.critical_payment_threshold_try ile AYNI sayı (ikinci eşik icat edilmedi)",
    Number.isFinite(rv) && Number.isFinite(sv) && rv === sv, `kural=${rv} ayar=${sv}`);

  /* ── 8. LESSON 3: ordering compares the KEY's value, not a row position ─────────────── */
  const ordering = await inRollback(async (c) => {
    const maker = await mkUser(c, "ord");
    const ids: Record<string, string> = {};
    for (const s of ALL_STATUSES) ids[s] = await mkApproval(c, s, maker);
    const rows = (await c.query(
      `select id::text, status,
              case status when 'pending' then 0 when 'reworked' then 1 else 2 end as sort_key
       from public.approval_queue where id = any($1::uuid[])`, [Object.values(ids)])).rows;
    const key = (s: string) => Number(rows.find((r) => r.status === s)?.sort_key);
    return {
      pending: key("pending"), reworked: key("reworked"),
      approved: key("approved"), rejected: key("rejected"),
    };
  });
  record("kuyruk sıralaması ANAHTAR DEĞERİYLE doğrulandı (satır sırasıyla değil)",
    ordering.pending < ordering.reworked && ordering.reworked < ordering.approved,
    `pending=${ordering.pending} reworked=${ordering.reworked} approved=${ordering.approved}`);
  record("approved ve rejected KASITLI olarak eşit öncelikli (beraberlik tasarım gereği)",
    ordering.approved === ordering.rejected,
    "Faz 23 dersi: beraberlikler pozitif olarak test edilir");

  /* ── 9. source-level guarantees ─────────────────────────────────────────────────────── */
  const engineSrc = readFileSync(path.join(process.cwd(), "src/lib/approvals/engine.ts"), "utf8");
  record("motor her kararda karar vereni İSİMLENDİRİYOR (tablo esnek, motor değil)",
    /decided_by\s*=\s*case when \$2 in \('approved','rejected'\) then \$3::uuid/.test(engineSrc),
    "anonim karar yalnız legacy köprüsünden gelebilir");
  record("motor maker-checker'ı okunur bir mesajla da reddediyor",
    /maker-checker/.test(engineSrc) && /DomainError/.test(engineSrc),
    "CHECK + uygulama katmanı birlikte");
  // The needle is assembled rather than written out, and that is NOT stylistic fussiness:
  // phase17:verify scans scripts/ for the literal cast and pins a per-file count, so spelling it
  // here would register this gate as a new offender for a cast it does not contain — it is
  // asserting the ABSENCE of one. Baselining the file instead would claim it legitimately holds
  // float casts, which is worse than assembling a string. Please leave it in pieces.
  const FLOAT_CAST = `::${"float"}8`;
  record(`onay motorunda ${FLOAT_CAST} yok (para numeric kalıyor)`,
    !engineSrc.includes(FLOAT_CAST), "Faz 17 kuralı");
  record("motor audit() ve Zod sınırını kullanıyor",
    /audit\(client/.test(engineSrc) && /parseOrThrow\(/.test(engineSrc), "Faz 18 kuralı");

  // ANCHORS must not have grown — extending it hard-fails a real legacy database.
  const migrateSrc = readFileSync(path.join(process.cwd(), "scripts/db/migrate.ts"), "utf8");
  const anchorBlock = migrateSrc.match(/const ANCHORS[\s\S]*?\];/)?.[0] ?? "";
  record("ANCHORS'a dokunulmadı (0053-0055 eklenmedi)",
    !/005[345]/.test(anchorBlock), "yalnız 0001-0019 legacy tespiti için");

  const migrationFiles = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "supabase/migrations"],
    { encoding: "utf8" }).split("\n").filter((l) => l.endsWith(".sql"));
  record("0053/0054/0055 migration dosyaları mevcut",
    ["0053", "0054", "0055"].every((n) => migrationFiles.some((f) => path.basename(f).startsWith(n))),
    `${migrationFiles.length} migration`);

  /* ── 10. regression surface ─────────────────────────────────────────────────────────── */
  const legacyCols = await q(
    `select count(*)::int n from information_schema.columns
     where table_schema='public'
       and ((table_name='mapping_reviews' and column_name in ('status','reviewed_at','reviewed_by'))
         or (table_name='external_assumptions' and column_name in ('review_status','reviewed_at','reviewed_by')))`);
  record("legacy inceleme kolonlarının hiçbiri kaldırılmadı",
    Number(legacyCols[0].n) === 6, "iki ekran da çalışmaya devam ediyor");

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE24A VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    await pool.end();
    process.exit(1);
  }
  console.log("PHASE24A VERIFY: ALL PASS");
  await pool.end();
}

main().catch(async (e) => {
  console.error("PHASE24A VERIFY FAIL:", messageOf(e));
  await pool.end().catch(() => {});
  process.exit(1);
});
