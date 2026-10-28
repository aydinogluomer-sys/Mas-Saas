// PHASE 2.2 Tier 2 — degistirilen SQL yukleyicilerinin harcanabilir bir DB'de gercekten
// CALISTIGINI ve TRY-disi alanlari dondurdugunu olcer (tsc SQL'i goremez).
//
//   DATABASE_URL=…/<disposable> pnpm exec tsx scripts/db/tier2-loaders-smoke.ts
//
// Yalniz OKUR (collectMetricSnapshots dahil — yazan writeMetricSnapshots cagrilmaz). Hedef adi
// disposable isaret tasimak zorundadir; gercek DB'ye karsi calismaz.
import { Pool } from "pg";
import { requireDisposableOwnerDatabaseUrl } from "./owner-url";
import { loadPaymentDashboard, monthSummary, instancesOn, overdueOpen } from "../../src/lib/radar/queries";
import { runRollingTrend, runParetoConcentration } from "../../src/lib/analytics/engine";
import { collectMetricSnapshots } from "../../src/lib/analytics/snapshots";
import { loadReceivableTotals, loadPayableTotals } from "../../src/lib/receivables/engine";
import { loadReceivableRisk, loadPaymentSchedule, loadPaymentCalendar } from "../../src/lib/collections/engine";
import { loadOpenItems } from "../../src/lib/invoices/engine";
import { loadOpenPromises } from "../../src/lib/collections/promises-engine";
import { loadCounterpartyExposure } from "../../src/lib/counterparties/engine";
import { istanbulDateISO } from "../../src/lib/time/istanbul";

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const rec = (name: string, pass: boolean, detail: string) => { checks.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`); };

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("tier2 loaders smoke") });
  const today = istanbulDateISO();
  const m0 = today.slice(0, 7) + "-01";
  try {
    const ms = await monthSummary(pool, m0);
    rec("monthSummary (#2) calisir, foreign_count doner", typeof ms.foreign_count === "number", JSON.stringify(ms));
    const dash = await loadPaymentDashboard(pool, today, new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10));
    rec("loadPaymentDashboard (#3) calisir; flexibility foreignCurrencyCount var",
      dash.flexibility.every((f) => typeof f.foreignCurrencyCount === "number"),
      `buckets=${dash.buckets.length} flex=${dash.flexibility.map((f) => `${f.id}:${f.knownAmount}/${f.foreignCurrencyCount}`).join(",")}`);
    const t = await runRollingTrend(pool, 7, today);
    rec("runRollingTrend (#12) calisir", Array.isArray(t.result.rows), `rows=${t.result.rows.length}`);
    const p = await runParetoConcentration(pool, today);
    rec("runParetoConcentration (#54) calisir; stamp'te TRY-disi taraf sayisi", "parties_with_non_try_open_sales_excluded" in p.stamp.input.rowCounts, JSON.stringify(p.stamp.input.rowCounts));
    const snaps = await collectMetricSnapshots(pool, today);
    const ps = snaps.filter((s) => s.metricKey === "payment_status");
    rec("collectMetricSnapshots (#14) payment_status meta.foreignCurrencyCount", ps.length > 0 && ps.every((s) => typeof (s.meta as { foreignCurrencyCount?: unknown })?.foreignCurrencyCount === "number"), `rows=${ps.length}`);
    const rt = await loadReceivableTotals(pool, today);
    const pt = await loadPayableTotals(pool, today);
    rec("loadReceivable/PayableTotals (#49) foreignCount", typeof rt.foreignCount === "number" && typeof pt.foreignCount === "number" && rt.ageing.every((a) => typeof a.foreignCount === "number"), `rec=${rt.totalOpenAmount}/${rt.foreignCount} pay=${pt.totalOpenAmount}/${pt.foreignCount}`);
    const risks = await loadReceivableRisk(pool, today, 50);
    rec("loadReceivableRisk (#57) currency alani", risks.every((r) => typeof r.currency === "string"), `rows=${risks.length}`);
    const sched = await loadPaymentSchedule(pool, 1_000_000, 50);
    rec("loadPaymentSchedule (#57) foreignCount", typeof sched.foreignCount === "number", `items=${sched.items.length} totalKnown=${sched.totalKnown} foreign=${sched.foreignCount}`);
    const cal = await loadPaymentCalendar(pool, today, new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10));
    rec("loadPaymentCalendar (#55) foreignCurrencyCount", cal.every((c) => typeof c.foreignCurrencyCount === "number"), `days=${cal.length}`);
    const oi = await loadOpenItems(pool, 20);
    rec("loadOpenItems (#53) currency", oi.every((i) => typeof i.currency === "string"), `rows=${oi.length}`);
    const pr = await loadOpenPromises(pool, 20);
    rec("loadOpenPromises (#58) currency", pr.every((x) => typeof x.currency === "string"), `rows=${pr.length}`);
    const ce = await loadCounterpartyExposure(pool, { limit: 20 });
    rec("loadCounterpartyExposure (#60, 0093) creditLimitComparable/foreignCurrencyCount", ce.every((x) => typeof x.creditLimitComparable === "boolean" && typeof x.foreignCurrencyCount === "number"), `rows=${ce.length}`);
    const [ti, ov] = await Promise.all([instancesOn(pool, today), overdueOpen(pool, today)]);
    rec("BASE sorgusu currency secer (#1)", [...ti, ...ov].every((r) => typeof r.currency === "string"), `today=${ti.length} overdue=${ov.length}`);
  } finally {
    await pool.end();
  }
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol gecti.`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
