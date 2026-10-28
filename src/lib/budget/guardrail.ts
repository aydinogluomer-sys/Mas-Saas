/**
 * MAS Nakit Radar — Kilit Taşı 5: Harcama Anında Bütçe Aşım Kilidi
 * (Real-Time Budget Guardrail & Overrun Lock Engine)
 * 
 * budgets ↔ budget_vs_actual ↔ approval_rules
 * 
 * Fatura veya harcama talebi oluşturulduğu anda masraf merkezinin
 * ilgili dönemdeki kalan bütçesini anlık kontrol eder;
 * bütçe aşımı varsa harcamayı doğrudan CFO onay kuyruğuna kilitler.
 */

import type { Pool, PoolClient } from "pg";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";

export interface BudgetCheckInput {
  costCenterId?: string | null;
  projectId?: string | null;
  amount: number;
  currency?: string;
  date?: string; // YYYY-MM-DD
}

export interface BudgetCheckResult {
  allowed: boolean;
  requiresCfoOverride: boolean;
  budgetAllocated: boolean;
  costCenterName?: string;
  budgetAmount: number;
  currentActual: number;
  requestedAmount: number;
  remainingBefore: number;
  overrunAmount: number;
  utilizationAfter: number;
  message: string;
}

/**
 * Harcama talebi öncesinde ilgili masraf merkezi ve proje için kalan bütçe tavanını sorgular.
 */
export async function checkBudgetHeadroom(
  client: Pool | PoolClient,
  input: BudgetCheckInput,
): Promise<BudgetCheckResult> {
  const currency = input.currency ?? "TRY";
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const periodStart = `${date.slice(0, 7)}-01`;

  // Eğer masraf merkezi veya proje belirtilmemişse genel harcama sayılır
  if (!input.costCenterId && !input.projectId) {
    return {
      allowed: true,
      requiresCfoOverride: false,
      budgetAllocated: false,
      budgetAmount: 0,
      currentActual: 0,
      requestedAmount: input.amount,
      remainingBefore: 0,
      overrunAmount: 0,
      utilizationAfter: 0,
      message: "Masraf merkezi/proje tanımlanmamış, bütçe kısıtı uygulanmadı.",
    };
  }

  const res = await client.query<{
    budget_amount: string;
    actual_amount: string | null;
    cost_center_name: string | null;
    project_name: string | null;
  }>(`
    select 
      coalesce(bva.budget_amount, 0) as budget_amount,
      coalesce(bva.actual_amount, 0) as actual_amount,
      bva.cost_center_name,
      bva.project_name
    from public.budget_vs_actual bva
    where bva.period_start = $1::date
      and bva.currency = $2
      and bva.direction = 'expense'
      and ($3::uuid is null or bva.cost_center_id = $3)
      and ($4::uuid is null or bva.project_id = $4)
    limit 1
  `, [periodStart, currency, input.costCenterId ?? null, input.projectId ?? null]);

  if (res.rowCount === 0) {
    // Bu dönem için henüz onaylı bütçe satırı açılmamış
    return {
      allowed: true,
      requiresCfoOverride: false,
      budgetAllocated: false,
      budgetAmount: 0,
      currentActual: 0,
      requestedAmount: input.amount,
      remainingBefore: 0,
      overrunAmount: 0,
      utilizationAfter: 0,
      message: `Bu dönem (${periodStart}) için masraf merkezine tanımlı bütçe bulunamadı.`,
    };
  }

  const row = res.rows[0];
  const budgetAmount = Number(row.budget_amount);
  const currentActual = Number(row.actual_amount ?? 0);
  const requested = input.amount;
  const remainingBefore = Math.max(0, budgetAmount - currentActual);
  const newTotal = currentActual + requested;
  const utilizationAfter = budgetAmount > 0 ? Number((newTotal / budgetAmount).toFixed(4)) : 1;

  if (newTotal > budgetAmount) {
    const overrun = newTotal - budgetAmount;
    const name = row.cost_center_name ?? row.project_name ?? "İlgili Birim";
    return {
      allowed: false,
      requiresCfoOverride: true,
      budgetAllocated: true,
      costCenterName: name,
      budgetAmount,
      currentActual,
      requestedAmount: requested,
      remainingBefore,
      overrunAmount: overrun,
      utilizationAfter,
      message: `BÜTÇE AŞIM BLOKAJI: '${name}' birimi için kalan bütçe ${remainingBefore.toLocaleString("tr-TR")} ${currency}. ` +
               `Talep edilen ${requested.toLocaleString("tr-TR")} ${currency} harcama ile bütçe %${Math.round(utilizationAfter * 100)} doluluğa ulaşacaktır ` +
               `(${overrun.toLocaleString("tr-TR")} ${currency} aşım). Harcama CFO Bütçe Revizyon Onayına yönlendirildi.`,
    };
  }

  return {
    allowed: true,
    requiresCfoOverride: false,
    budgetAllocated: true,
    costCenterName: row.cost_center_name ?? row.project_name ?? "İlgili Birim",
    budgetAmount,
    currentActual,
    requestedAmount: requested,
    remainingBefore,
    overrunAmount: 0,
    utilizationAfter,
    message: `Bütçe uygun. Kalan bütçe: ${(remainingBefore - requested).toLocaleString("tr-TR")} ${currency}.`,
  };
}
