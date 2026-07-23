// Dev/demo state builder: full pipeline on the real workbook so every
// dashboard is populated (used by the E2E smoke; safe to re-run).
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { importWorkbook } from "../src/lib/importers/workbook-importer";
import { cancelInstance, ensureWindow, mapAcceptedCandidates, markInstancePaid, markInstancePartial, markInstanceUnpaid } from "../src/lib/radar/engine";
import { mapCashflowMonths, validateContinuity, writeSnapshots } from "../src/lib/cashflow/engine";
import { mapAcceptedChecks, mapLoans } from "../src/lib/financing/engine";
import {
  calculateMachineRoiSnapshot,
  calculatePartProfitability,
  mapCapacitySheet,
  mapCostSheets,
  mapFinanceCostAllocations,
  mapMachineMinuteAllocations,
  mapMachineRoi,
} from "../src/lib/production/engine";
import { generateDaily, generateMonthly, generateWeekly } from "../src/lib/reports/engine";
import { dispatchPending, scheduleReminders } from "../src/lib/reminders/engine";
import { mockTransport } from "../src/lib/reminders/transport";
import { createAndRun } from "../src/lib/scenarios/engine";
import { createExternalAssumption } from "../src/lib/external-assumptions/engine";
import { createActionFromReview, createActionFromReport, createManualAction, setActionStatus } from "../src/lib/data-quality/engine";
import { archiveRecord } from "../src/lib/archive/engine";
import { refreshMetricSnapshots } from "../src/lib/analytics/snapshots";
import { answerQuestion } from "../src/lib/ai/engine";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev",
});

async function main() {
  await pool.query(
    `truncate public.source_workbooks, public.payments, public.payment_instances,
       public.cashflow_months, public.cashflow_snapshots, public.checks, public.check_events,
       public.loans, public.loan_installments, public.capacity_models, public.cost_models,
       public.production_parts, public.part_profitability_runs, public.scenarios, public.scenario_runs,
       public.reports, public.reminder_deliveries, public.external_assumptions,
       public.machine_roi_snapshots, public.action_items, public.ai_response_snapshots,
       public.metric_snapshots, public.audit_logs restart identity cascade`,
  );
  const r = await importWorkbook(
    pool,
    readFileSync("data/source/mesaili_nakit_akış_tek_vardiya_TEMİZ.xlsx"),
    "TEMİZ.xlsx",
  );
  if (!r.ok) throw new Error("import failed: " + r.error);

  // same controlled review decisions as phase3-verify (documented semantics)
  const dec = (like: string, status: string) =>
    pool.query(
      `update public.mapping_reviews set status=$2, reviewed_at=now()
       where workbook_id=$1 and message like $3`,
      [r.workbookId, status, like],
    );
  await dec("%ÖMER%", "accepted");
  await dec("%ATİLLA%", "rejected");
  await dec("%PRONET%", "accepted");
  await pool.query(
    `update public.mapping_reviews set status='accepted', reviewed_at=now()
     where workbook_id=$1 and issue_type='multiple_day_markers'`,
    [r.workbookId],
  );

  const today = new Date().toISOString().slice(0, 10);
  const pm = await mapAcceptedCandidates(pool, r.workbookId);
  await ensureWindow(pool, today, 24);
  const lifecycle = await pool.query<{id:string;amount:number;due_date:string}>(`select id,amount::float8 amount,to_char(due_date,'YYYY-MM-DD') due_date from public.payment_instances where amount is not null and amount>1000 order by due_date,id limit 8`);
  if(lifecycle.rows[0]) await markInstancePaid(pool,lifecycle.rows[0].id,lifecycle.rows[0].amount);
  if(lifecycle.rows[1]) await markInstancePaid(pool,lifecycle.rows[1].id,lifecycle.rows[1].amount);
  const futurePartial = await pool.query<{id:string;amount:number}>(`select id,amount::float8 amount from public.payment_instances where due_date>=$1 and amount is not null and amount>1000 and status='unpaid' order by due_date limit 1`,[today]);
  if(futurePartial.rows[0]) await markInstancePartial(pool,futurePartial.rows[0].id,Math.max(1,Math.floor(futurePartial.rows[0].amount*.4)));
  if(lifecycle.rows[3]) { await markInstancePaid(pool,lifecycle.rows[3].id,lifecycle.rows[3].amount); await markInstanceUnpaid(pool,lifecycle.rows[3].id); }
  if(lifecycle.rows[4]) await cancelInstance(pool,lifecycle.rows[4].id,"Demo: yaşam döngüsü örneği için iptal edildi.");
  await pool.query(`with future as (select id from public.payment_instances where due_date>=$1 and status='unpaid' order by due_date limit 2) update public.payment_instances i set status='planned',note=concat_ws(' · ',i.note,'Demo yaşam döngüsü') from future f where i.id=f.id`,[today]);
  const cf = await mapCashflowMonths(pool, r.workbookId);
  const cont = await validateContinuity(pool);
  await writeSnapshots(pool, today);

  // Explicit demo-only decisions for known source ambiguities. Mixed personal/company
  // data stays blocked and is never promoted into a financial domain table.
  await pool.query(`update public.mapping_reviews set status='resolved', reviewed_at=now()
    where workbook_id=$1 and issue_type in (
      'duplicate_check','unparsed_row','loan_field_ambiguous','loan_term_mismatch',
      'stale_rate','missing_operation_time','capacity_minutes_reconciliation',
      'break_even_reconciliation','capacity_rate_missing','cost_model_missing'
    )`, [r.workbookId]);

  const checks = await mapAcceptedChecks(pool, r.workbookId);
  const loans = await mapLoans(pool, r.workbookId);
  const capacity = await mapCapacitySheet(pool, r.workbookId);
  const costs = await mapCostSheets(pool, r.workbookId);
  const profitability = await calculatePartProfitability(pool);
  const machineMinutes = await mapMachineMinuteAllocations(pool, r.workbookId);
  const financeAllocations = await mapFinanceCostAllocations(pool, r.workbookId);

  // Machine ROI: prefer the real workbook mapping (it self-blocks while the source sheet
  // has an open/rejected review — e.g. personal/company data mixed — never bypassed here).
  // The manual snapshots below always run too (ON CONFLICT DO NOTHING per machine×year),
  // so every machine has demo-visible ROI even when the workbook path is blocked.
  const roiMap = await mapMachineRoi(pool, r.workbookId);
  const machines = (await pool.query<{ id: string }>("select id from public.machine_assets order by created_at")).rows;
  const roiYears = [new Date().getFullYear(), new Date().getFullYear() - 1];
  let roiSnapshotsCreated = 0;
  for (const [index, m] of machines.entries()) {
    for (const [yearIndex, year] of roiYears.entries()) {
      const revenue = 3_000_000 + index * 800_000 - yearIndex * 300_000;
      const res = await calculateMachineRoiSnapshot(pool, {
        machineAssetId: m.id, year,
        revenue, cost: Math.round(revenue * 0.6), tax: Math.round(revenue * 0.08),
        sourceWorkbookId: r.workbookId,
      });
      if (res.created) roiSnapshotsCreated++;
    }
  }

  // External assumptions: keep the existing interest-rate demo row, add the remaining
  // catalogue types (exact assumption_type enum values — unrecognized strings silently
  // fall back to "other", so these must match supabase/migrations/0016 exactly).
  await createExternalAssumption(pool, {
    assumptionType: "interest_rate",
    label: "Demo politika faizi varsayımı",
    valueNumeric: 40,
    unit: "%",
    currency: "TRY",
    sourceKind: "user",
    sourceName: "Demo veri",
    sourceDate: today,
    reviewStatus: "approved",
    notes: "Yalnız yerel demo/TestSprite doğrulaması için.",
  });
  const moreAssumptions: Array<{ assumptionType: string; label: string; value: number; unit: string; reviewStatus: "approved" | "pending_review" }> = [
    { assumptionType: "fx_rate", label: "Demo USD/TRY kur varsayımı", value: 34.5, unit: "TRY", reviewStatus: "approved" },
    { assumptionType: "inflation_rate", label: "Demo yıllık TÜFE varsayımı", value: 55, unit: "%", reviewStatus: "approved" },
    { assumptionType: "personnel_cost", label: "Demo personel maliyet artışı varsayımı", value: 30, unit: "%", reviewStatus: "pending_review" },
    { assumptionType: "energy_cost", label: "Demo enerji maliyet artışı varsayımı", value: 40, unit: "%", reviewStatus: "pending_review" },
    { assumptionType: "loan_rate", label: "Demo yeni kredi faiz oranı varsayımı", value: 45, unit: "%", reviewStatus: "approved" },
  ];
  let assumptionsCreated = 0;
  for (const a of moreAssumptions) {
    const id = await createExternalAssumption(pool, {
      assumptionType: a.assumptionType, label: a.label, valueNumeric: a.value, unit: a.unit,
      currency: "TRY", sourceKind: "user", sourceName: "Demo veri", sourceDate: today,
      reviewStatus: a.reviewStatus, notes: "Yalnız yerel demo/TestSprite doğrulaması için.",
    });
    if (id) assumptionsCreated++;
  }

  // Reports: keep today's daily, add weekly/monthly + one period back each for history depth.
  await generateDaily(pool, today);
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  await generateDaily(pool, yesterday);
  const weekly = await generateWeekly(pool, today);
  const lastWeekAnchor = new Date(Date.parse(today) - 7 * 86400000).toISOString().slice(0, 10);
  await generateWeekly(pool, lastWeekAnchor);
  const monthStart = `${today.slice(0, 7)}-01`;
  await generateMonthly(pool, monthStart);

  // Reminder deliveries: eligibility is an EXACT date match (scheduled_for === that day's
  // date), so schedule across a trailing window before dispatching — a single "today" call
  // rarely lines up with any due date. dispatchPending is the real send code path; mockTransport
  // is the project's own deterministic test/demo transport (never calls Telegram).
  for (let i = 20; i >= 0; i--) {
    const d = new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10);
    await scheduleReminders(pool, d);
  }
  let dispatchAttempt = 0;
  const transport = mockTransport({ failOn: () => dispatchAttempt++ % 3 === 2 });
  const dispatch = await dispatchPending(pool, transport, today);

  // Scenarios: existing revenue scenario stays; add the remaining representative types so
  // /scenarios/history has depth and /scenarios/compare has ≥2 runs to choose from.
  await createAndRun(pool, {
    name: "Demo gelir -%10",
    scenarioType: "revenue_up_down_percent",
    assumptions: { revenuePct: -0.1 },
  });
  await createAndRun(pool, {
    name: "Demo gider +%10",
    scenarioType: "expense_up_down_percent",
    assumptions: { expensePct: 0.1 },
  });
  await createAndRun(pool, {
    name: "Demo müşteri gecikmesi 1 ay",
    scenarioType: "customer_delay_days",
    assumptions: { customerDelayMonths: 1 },
  });
  await createAndRun(pool, {
    name: "Demo borç servisi dahil",
    scenarioType: "debt_service_overlay",
    assumptions: { includeDebtService: true },
  });

  // Tasks: from an existing open review, from the weekly report just generated, and two
  // manual entries — then a status mix so the queue isn't all "open".
  const openReviews = await pool.query<{ id: string }>(`select id from public.mapping_reviews where status='open' order by created_at limit 2`);
  const taskIds: string[] = [];
  for (const row of openReviews.rows) {
    const id = await createActionFromReview(pool, row.id);
    if (id) taskIds.push(id);
  }
  const reportTaskId = await createActionFromReport(pool, weekly.id);
  if (reportTaskId) taskIds.push(reportTaskId);
  const manual1 = await createManualAction(pool, { title: "Demo: Nisan ayı kasa mutabakatını gözden geçir", severity: "medium", owner: "Demo Kullanıcı", note: "Yalnız yerel demo verisi." });
  const manual2 = await createManualAction(pool, { title: "Demo: Kritik çeklerin banka teyidini al", severity: "high", owner: "Demo Kullanıcı" });
  if (manual1) taskIds.push(manual1);
  if (manual2) taskIds.push(manual2);
  if (taskIds[0]) await setActionStatus(pool, taskIds[0], "in_progress");
  if (taskIds[1]) await setActionStatus(pool, taskIds[1], "done", "Demo: tamamlandı olarak işaretlendi.");

  // Metric trend history: a weekly cadence of snapshot dates ending today, so /overview
  // sparklines and /system trend have more than a single point.
  for (let w = 7; w >= 0; w--) {
    const d = new Date(Date.parse(today) - w * 7 * 86400000).toISOString().slice(0, 10);
    await refreshMetricSnapshots(pool, d);
  }

  // Check lifecycle events: mapAcceptedChecks already wrote "created"; add a few more
  // event types so the check history reads as a real lifecycle, not a single moment.
  const someChecks = (await pool.query<{ id: string }>("select id from public.checks order by maturity_date limit 3")).rows;
  const checkEventPlan: Array<{ type: string; note: string }> = [
    { type: "reminded", note: "Demo: vade hatırlatması gönderildi." },
    { type: "cleared", note: "Demo: banka tahsilatı onaylandı." },
    { type: "bounced", note: "Demo: karşılıksız — yeniden ibraz planlandı." },
  ];
  let checkEventsAdded = 0;
  for (const [index, plan] of checkEventPlan.entries()) {
    const check = someChecks[index];
    if (!check) continue;
    await pool.query(`insert into public.check_events (check_id, event_type, event_note) values ($1,$2,$3)`, [check.id, plan.type, plan.note]);
    checkEventsAdded++;
  }

  // AI Q&A history: forceDeterministic:true guarantees no LLM call — the same deterministic
  // fact-grounded path the app falls back to whenever no API key is configured.
  const aiQuestions = [
    "Önümüzdeki 3 ayda toplam ödeme ne kadar?",
    "İlk negatif kasa ayı ne zaman?",
    "En riskli çek hangisi?",
    "Toplam finansman maliyeti ne kadar?",
    "Bu ay geciken ödeme sayısı kaç?",
  ];
  let aiAnswersCreated = 0;
  for (const question of aiQuestions) {
    await answerQuestion(pool, { question, forceDeterministic: true });
    aiAnswersCreated++;
  }

  // Archive: leave one archived record per archivable module (via the real archiveRecord
  // engine — the same one the "Arşivle" button calls) so /payments/archive, /finance/archive,
  // and the aggregate /system/archive are never empty. The single loan is left alone —
  // archiving it would just move the empty-state to /finance/loans.
  const archivePaymentId = (await pool.query<{ id: string }>("select id from public.payments order by name desc limit 1")).rows[0]?.id;
  if (archivePaymentId) await archiveRecord(pool, "payments", archivePaymentId, "Demo: arşiv ekranını göstermek için arşivlendi.", "Demo Kullanıcı");
  const archiveCheckId = (await pool.query<{ id: string }>("select id from public.checks order by maturity_date desc limit 1")).rows[0]?.id;
  if (archiveCheckId) await archiveRecord(pool, "checks", archiveCheckId, "Demo: arşiv ekranını göstermek için arşivlendi.", "Demo Kullanıcı");

  console.log(
    `SEED OK — payments=${pm.created} · cashflow months=${cf.monthsCreated} lines=${cf.linesCreated} · chain breaks=${cont.breaks}` +
    ` · checks=${checks.created} · loans=${loans.created} installments=${loans.installmentsCreated}` +
    ` · capacity=${capacity.capacityCreated} parts=${capacity.partsCreated} · costs=${costs.created}` +
    ` · profitability=${profitability.runsCreated} · machineMinutes=${machineMinutes.created}` +
    ` · financeAllocations=${financeAllocations.created}` +
    ` · roiSnapshots=${roiSnapshotsCreated} (workbook mapped=${roiMap.perMachineSnapshots}, excluded=${roiMap.excluded.length})` +
    ` · assumptions=${assumptionsCreated + 1} · reminderDispatch(attempted=${dispatch.attempted},sent=${dispatch.sent},failed=${dispatch.failed})` +
    ` · scenarios=4 · tasks=${taskIds.length} · metricSnapshotDates=8 · checkEvents=${checkEventsAdded} · aiAnswers=${aiAnswersCreated}`,
  );
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
