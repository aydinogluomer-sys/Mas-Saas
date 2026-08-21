// Phase 6B verification on REAL data (TEMİZ). Proves:
//   eligibility → scheduleReminders inserts pending deliveries for firing (rule × instance);
//   duplicate prevention: re-schedule inserts 0 (DB unique key) + raw duplicate insert fails;
//   dispatch success (mock) → status 'sent' + sent_at; dispatch failure (mock) → status
//     'failed' + error LOGGED (never thrown); every attempt logged; sent not re-sent;
//   financial integrity: scheduling+dispatch mutate NO financial table (before==after);
//   Europe/Istanbul date handling.
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { ensureWindow, mapAcceptedCandidates } from "../src/lib/radar/engine";
import { dispatchPending, scheduleReminders } from "../src/lib/reminders/engine";
import { mockTransport } from "../src/lib/reminders/transport";
import { istanbulDateISO } from "../src/lib/reports/rules";
import { ensureSystemActor } from "./db/seed-system-actor";
import { requireOwnerDatabaseUrl } from "./db/owner-url";

const pool = new Pool({
  connectionString: requireOwnerDatabaseUrl(),
});
const fail = (m: string): never => { console.error("PHASE6B VERIFY FAIL:", m); process.exit(1); };
const q = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;
const SRC = process.env.PHASE6B_SRC ?? "data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx";
const TODAY = "2026-07-06"; // eligible dues: 07-05(-1),07-06(0),07-07(1),07-09(3),07-13(7)

async function financialFingerprint(): Promise<string> {
  const rows = await q(`
    select 'payments' t, count(*) c, coalesce(sum(default_amount),0) s from public.payments
    union all select 'instances', count(*), coalesce(sum(amount),0) from public.payment_instances
    union all select 'checks', count(*), coalesce(sum(signed_amount),0) from public.checks
    union all select 'loans', count(*), coalesce(sum(total_payment),0) from public.loans
    union all select 'installments', count(*), coalesce(sum(amount),0) from public.loan_installments
    order by t`);
  return JSON.stringify(rows);
}

async function main() {
  // audit_logs is append-only since 0022 (no UPDATE/DELETE/TRUNCATE, ever) — it is
  // deliberately NOT in the reset below. Each verify run gets a freshly created
  // disposable database instead, so the audit table starts empty without weakening
  // the invariant.
  // audit_logs.actor_id is an FK to public.users(id) since 0032; verify scripts run
  // without a session, so they attribute to the reserved "system" account.
  const actorId = await ensureSystemActor(pool);
  await pool.query(`truncate public.source_workbooks, public.payments, public.payment_instances, public.reminder_deliveries restart identity cascade`);

  const r = await importWorkbook(pool, readFileSync(SRC), "TEMİZ.xlsx", actorId);
  if (!r.ok) fail("import failed");
  await pool.query(`update public.mapping_reviews set status='accepted' where workbook_id=$1
    and issue_type in ('missing_due_day','amount_alignment','unlabeled_amount','multiple_day_markers')`, [r.workbookId]);
  await mapAcceptedCandidates(pool, r.workbookId, actorId);
  await ensureWindow(pool, TODAY, actorId);

  const rules = (await q(`select count(*)::int n from public.reminders where is_active`))[0].n;
  const openInst = (await q(`select count(*)::int n from public.payment_instances where status in ('unpaid','partial')`))[0].n;
  if (rules === 0 || openInst === 0) fail("no rules or no open instances");
  console.log(`setup: ${rules} aktif kural · ${openInst} açık instance`);

  const before = await financialFingerprint();

  // 1) schedule — eligibility → pending deliveries
  const s1 = await scheduleReminders(pool, TODAY);
  console.log("schedule#1:", JSON.stringify(s1));
  if (s1.inserted === 0) fail("no reminders scheduled — eligibility produced nothing");
  const allPending = (await q(`select count(*)::int n from public.reminder_deliveries where status='pending'`))[0].n;
  if (allPending !== s1.inserted) fail("scheduled rows not all pending");

  // eligibility correctness: every scheduled delivery's instance due_date matches an offset
  const bad = await q(`
    select d.id from public.reminder_deliveries d
    join public.reminders r on r.id=d.reminder_id
    join public.payment_instances i on i.id=d.entity_id
    where (i.due_date - r.offset_days) <> $1::date`, [TODAY]);
  if (bad.length > 0) fail(`${bad.length} deliveries scheduled for wrong offset/date`);
  console.log(`eligibility ✓ ${s1.inserted} teslimat, hepsi doğru offset gününde (due − offset = bugün)`);

  // 2) duplicate prevention: re-schedule inserts nothing
  const s2 = await scheduleReminders(pool, TODAY);
  if (s2.inserted !== 0) fail(`duplicate prevention failed: ${s2.inserted} re-inserted`);
  console.log(`duplicate önleme ✓ (schedule#2 inserted=0, skipped=${s2.duplicatesSkipped})`);

  // DB-level unique proof
  const one = (await q(`select reminder_id, entity_table, entity_id, scheduled_for from public.reminder_deliveries limit 1`))[0];
  let uniqueFired = false;
  try {
    await pool.query(
      `insert into public.reminder_deliveries (reminder_id, entity_table, entity_id, scheduled_for)
       values ($1,$2,$3,$4)`, [one.reminder_id, one.entity_table, one.entity_id, one.scheduled_for]);
  } catch (e) { uniqueFired = /duplicate key|unique/i.test((e as Error).message); }
  if (!uniqueFired) fail("DB unique delivery key not enforced");
  console.log("DB benzersiz teslimat anahtarı ✓");

  // 3) dispatch success (mock) → sent + sent_at, message carried
  const okMock = mockTransport();
  const d1 = await dispatchPending(pool, okMock, TODAY);
  console.log("dispatch#1 (mock ok):", JSON.stringify(d1));
  if (d1.sent !== s1.inserted || d1.failed !== 0) fail("mock success dispatch wrong counts");
  const sentRows = await q(`select count(*)::int n from public.reminder_deliveries where status='sent' and sent_at is not null`);
  if (sentRows[0].n !== s1.inserted) fail("sent rows missing sent_at");
  if (okMock.sent.length !== s1.inserted) fail("transport did not receive all messages");
  if (!okMock.sent.every((m) => /tutar:/.test(m) && /durum:/.test(m))) fail("message missing required fields");
  console.log(`gönderim ✓ ${d1.sent} 'sent' + sent_at + mesaj alanları (tutar/durum) taşındı`);

  // 4) idempotent dispatch: no pending left
  const d2 = await dispatchPending(pool, okMock, TODAY);
  if (d2.attempted !== 0) fail("dispatch re-sent already-sent deliveries");
  console.log("tekrar gönderim ✓ (attempted=0, 'sent' yeniden gönderilmez)");

  // 5) failure path: reset one to pending, dispatch with failing mock → 'failed' + error logged
  const target = (await q(`select id from public.reminder_deliveries limit 1`))[0].id;
  await pool.query(`update public.reminder_deliveries set status='pending', sent_at=null where id=$1`, [target]);
  const d3 = await dispatchPending(pool, mockTransport({ failOn: () => true }), TODAY);
  if (d3.failed !== 1 || d3.sent !== 0) fail("failure dispatch wrong counts");
  const failed = (await q(`select status, error from public.reminder_deliveries where id=$1`, [target]))[0];
  if (failed.status !== "failed" || !failed.error) fail("failed delivery not logged with error");
  console.log(`hata yolu ✓ (1 'failed' + error='${failed.error}' loglandı, exception fırlatılmadı)`);

  // 6) FINANCIAL INTEGRITY: no financial table mutated by scheduling/dispatch
  const after = await financialFingerprint();
  if (before !== after) fail("reminder engine MUTATED a financial table — forbidden");
  console.log("mali kayıt bütünlüğü ✓ (planlama+gönderim hiçbir mali tabloyu değiştirmedi)");

  // 7) Istanbul tz sanity
  if (istanbulDateISO(new Date("2026-07-06T22:30:00Z")) !== "2026-07-07") fail("tz handling wrong");
  console.log("Europe/Istanbul tarih sınırı ✓");

  console.log("PHASE6B VERIFY: ALL PASS");
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
