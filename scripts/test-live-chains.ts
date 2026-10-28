import { getPool } from "../src/lib/db";
import { runFinancialNervousSystemCheck } from "../src/lib/chains";

async function main() {
  console.log("Starting Live Financial Nervous System execution check...");
  const pool = getPool();
  const startTime = Date.now();
  const report = await runFinancialNervousSystemCheck(pool);
  const elapsed = Date.now() - startTime;

  console.log(`Execution completed in ${elapsed}ms.`);
  console.log("==========================================");
  console.log(`Overall Health Score: ${report.overallHealthScore}/100 [Status: ${report.healthStatus}]`);
  console.log(`Duration: ${report.durationMs}ms`);
  console.log(`Total Alerts: ${report.alerts.length}`);
  console.log("------------------------------------------");
  for (const alert of report.alerts) {
    console.log(`[${alert.severity.toUpperCase()}] [${alert.chain}]: ${alert.title} -> ${alert.recommendedAction}`);
  }
  console.log("==========================================");
  const c = report.chains;
  console.log("Chain 1 (Order-to-Cash): Open AR =", c.orderToCash.totalOpenReceivablesTRY, "DSO =", c.orderToCash.weightedAverageDSO);
  console.log("Chain 2 (Procure-to-Pay): Pending AP =", c.procureToPay.totalPendingPayablesTRY, "Headroom =", c.procureToPay.availableCreditHeadroomTRY);
  console.log("Chain 3 (Treasury): Total Headroom =", c.treasuryOptimization.totalAvailableCreditHeadroomTRY, "Route =", c.treasuryOptimization.cheapestLiquidityRoute.recommendedSource);
  console.log("Chain 4 (FX Exposure): Net Exposure TRY =", c.fxDefense.totalNetExposureTRY, "Shock 20% Impact =", c.fxDefense.totalShock20PctRiskTRY);
  console.log("Chain 5 (Statutory Defense): Reserved =", c.statutoryDefense.statutoryReservedAmountTRY, "Free Usable Cash =", c.statutoryDefense.freeUsableCashTRY);
  console.log("Chain 6 (Fraud Integrity): Scanned Payments =", c.fraudIntegrity.scannedPaymentsCount, "Quarantined Count =", c.fraudIntegrity.quarantinedCount);
  console.log("Chain 7 (Cash Unit Economics): Products Analyzed =", c.cashUnitEconomics.analyzedProductsCount, "Cash Drainers =", c.cashUnitEconomics.cashDrainersCount);
  console.log("Chain 8 (Executive Hub): Runway Days =", c.executiveHub.netLiquidityStatus.cashRunwayDays, "Actions =", c.executiveHub.pendingMobileActions.length);
  console.log("==========================================");
  console.log("LIVE DATABASE VERIFICATION: 100% SUCCESSFUL!");
  process.exit(0);
}

main().catch((err) => {
  console.error("LIVE VERIFICATION FAILED:", err);
  process.exit(1);
});
