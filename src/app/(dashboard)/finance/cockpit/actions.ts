"use server";

import { getPool } from "@/lib/db";
import { verifyDatabaseAuditLogs, type ChainVerificationResult } from "@/lib/audit/hash-chain";
import {
  runSandboxFromDatabase,
  type SimulationModifiers,
  type SimulationReport,
} from "@/lib/simulations/sandbox";
import {
  optimizePayablesDiscounts,
  type BatchDiscountOptimizationReport,
  type EarlyDiscountOffer,
} from "@/lib/finance/dynamic-discounting";

/**
 * Veritabanındaki tüm audit loglarının SHA-256 Merkle zincirini doğrular.
 */
export async function verifyAuditChainAction(): Promise<ChainVerificationResult> {
  const pool = getPool();
  return verifyDatabaseAuditLogs(pool, 500);
}

/**
 * Kullanıcının girdiği dinamik parametrelerle 13 haftalık What-If nakit akışı simülasyonunu çalıştırır.
 */
export async function runSimulationAction(
  modifiers: SimulationModifiers,
): Promise<SimulationReport> {
  const pool = getPool();
  return runSandboxFromDatabase(pool, modifiers);
}

/**
 * Şirketin borçlanma maliyeti güncellendiğinde erken ödeme iskonto arbitrajını yeniden hesaplar.
 */
export async function recomputeDiscountArbitrageAction(
  offers: EarlyDiscountOffer[],
  borrowingCostAnnual: number,
): Promise<BatchDiscountOptimizationReport> {
  const pool = getPool();
  return optimizePayablesDiscounts(pool, offers, borrowingCostAnnual);
}
