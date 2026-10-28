import type { Pool } from "pg";
import { instancesBetween, overdueOpen, type InstanceRow } from "@/lib/radar/queries";
import { markInstancePaid, markInstanceUnpaid } from "@/lib/radar/engine";
import { loadMaturityItems, markCheckCleared } from "@/lib/financing/engine";
import type { MaturityItem } from "@/lib/financing/rules";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { buildProjection, type CashMonth } from "@/lib/radar/rules";
import { loadReconciliationSummary } from "@/lib/bank/engine";
import { addDaysISO } from "@/lib/financing/rules";
import { sumMoney, moneyOrNull } from "@/lib/money";

export interface MiniAppAccount {
  id: string;
  name: string;
  iban: string | null;
  balance: number;
}

export interface MiniAppPayment {
  id: string;
  name: string;
  dueDate: string;
  amount: number | null;
  currency: string;
  status: string;
  riskLevel: string;
  priority: string | null;
  isCheck?: boolean;
}

export interface MiniAppMaturity {
  id: string;
  label: string;
  dueDate: string;
  amount: number | null;
  kind: "check" | "loan_installment";
  direction: "inflow" | "outflow" | "unknown";
}

export interface MiniAppSnapshot {
  todayISO: string;
  netKasa: number;
  bankAccounts: MiniAppAccount[];
  next7DaysOutflow: number;
  next7DaysCount: number;
  overdueCount: number;
  overdueTotal: number;
  runway: {
    firstNegativeMonth: string | null;
    worstMonth: string | null;
    worstBalance: number | null;
    statusText: string;
  };
  urgentPayments: MiniAppPayment[];
  urgentMaturities: MiniAppMaturity[];
  cfoHighlights: Array<{ id: string; title: string; detail: string; tone: "positive" | "warning" | "critical" }>;
}

export async function getMiniAppSnapshot(pool: Pool, todayISO: string): Promise<MiniAppSnapshot> {
  const next7Date = addDaysISO(todayISO, 7);
  const next14Date = addDaysISO(todayISO, 14);

  const [bankSummary, instances7, overdue, maturities, months] = await Promise.all([
    loadReconciliationSummary(pool).catch(() => [] as Awaited<ReturnType<typeof loadReconciliationSummary>>),
    instancesBetween(pool, todayISO, next7Date).catch(() => [] as InstanceRow[]),
    overdueOpen(pool, todayISO).catch(() => [] as InstanceRow[]),
    loadMaturityItems(pool).catch(() => [] as MaturityItem[]),
    loadCashMonths(pool).catch(() => [] as CashMonth[]),
  ]);

  // 1. Calculate Net Kasa
  const bankAccounts: MiniAppAccount[] = bankSummary.map((b) => ({
    id: b.bankAccountId,
    name: b.accountName,
    iban: b.iban,
    balance: b.availableBalance ?? 0,
  }));

  const totalBankBalance = bankAccounts.reduce((sum, b) => sum + b.balance, 0);

  // Latest cashflow closing if available
  const latestMonth = months.length > 0 ? months[0] : null;
  const netKasa = totalBankBalance !== 0 ? totalBankBalance : (latestMonth?.closing ?? 0);

  // 2. Next 7 days outflow calculation
  const openStatuses = new Set(["unpaid", "late", "partial", "planned"]);
  const openInstances7 = instances7.filter((i) => openStatuses.has(i.status));
  const next7DaysOutflow = sumMoney(openInstances7.map((i) => i.amount));
  const next7DaysCount = openInstances7.length;

  // 3. Overdue calculation
  const overdueTotal = sumMoney(overdue.map((i) => i.amount));
  const overdueCount = overdue.length;

  // 4. Runway calculation
  const projection = buildProjection(months);
  let statusText = "Nakit projeksiyonu dengede";
  if (projection.firstNegativeMonth) {
    statusText = `İlk açık ${projection.firstNegativeMonth} ayında`;
  }

  // 5. Urgent Payments list (combines top overdue + upcoming 7 days)
  const urgentPayments: MiniAppPayment[] = [
    ...overdue.slice(0, 5).map((i) => ({
      id: i.id,
      name: i.name,
      dueDate: i.due_date,
      amount: i.amount,
      currency: i.currency || "TRY",
      status: i.status,
      riskLevel: i.risk_level,
      priority: i.priority ?? null,
    })),
    ...openInstances7.slice(0, 10).map((i) => ({
      id: i.id,
      name: i.name,
      dueDate: i.due_date,
      amount: i.amount,
      currency: i.currency || "TRY",
      status: i.status,
      riskLevel: i.risk_level,
      priority: i.priority ?? null,
    })),
  ].slice(0, 12);

  // 6. Urgent maturities (checks & loan installments in next 14 days)
  const urgentMaturities: MiniAppMaturity[] = maturities
    .filter((m) => m.dueDate >= todayISO && m.dueDate <= next14Date && m.direction === "outflow")
    .slice(0, 8)
    .map((m) => ({
      id: m.id,
      label: m.label,
      dueDate: m.dueDate,
      amount: m.amount,
      kind: m.kind,
      direction: m.direction,
    }));

  // 7. CFO Highlights
  const cfoHighlights: MiniAppSnapshot["cfoHighlights"] = [];
  if (overdueCount > 0) {
    cfoHighlights.push({
      id: "overdue",
      title: "Geciken Ödemeler",
      detail: `${overdueCount} adet ödeme vadesi geçmiş (Toplam ₺${Math.round(overdueTotal).toLocaleString("tr-TR")}).`,
      tone: "critical",
    });
  }

  const upcomingCheckCount = urgentMaturities.filter((m) => m.kind === "check").length;
  if (upcomingCheckCount > 0) {
    cfoHighlights.push({
      id: "checks",
      title: "Yaklaşan Çekler",
      detail: `Önümüzdeki 14 gün içinde ${upcomingCheckCount} çek vadesi yaklaşıyor.`,
      tone: "warning",
    });
  }

  if (projection.firstNegativeMonth) {
    cfoHighlights.push({
      id: "runway",
      title: "Nakit Eşiği Uyarısı",
      detail: `Projeksiyona göre ${projection.firstNegativeMonth} döneminde nakit açığı riski bulunuyor.`,
      tone: "warning",
    });
  } else {
    cfoHighlights.push({
      id: "runway_healthy",
      title: "Nakit Pozisyonu Sağlam",
      detail: "İzlenen dönem boyunca likidite pozitif seyrini koruyor.",
      tone: "positive",
    });
  }

  return {
    todayISO,
    netKasa,
    bankAccounts,
    next7DaysOutflow,
    next7DaysCount,
    overdueCount,
    overdueTotal,
    runway: {
      firstNegativeMonth: projection.firstNegativeMonth,
      worstMonth: projection.worstMonth,
      worstBalance: projection.worstBalance,
      statusText,
    },
    urgentPayments,
    urgentMaturities,
    cfoHighlights,
  };
}

export interface MiniAppActionResult {
  success: boolean;
  message: string;
  action: string;
  targetId: string;
}

export async function executeMiniAppAction(
  pool: Pool,
  action: "mark_paid" | "mark_unpaid" | "clear_check",
  targetId: string,
  actorId: string,
  amount?: number | null,
): Promise<MiniAppActionResult> {
  if (!targetId) {
    throw new Error("Hedef ID zorunludur.");
  }

  if (action === "mark_paid") {
    // Check if it's a check ID format ('chk:uuid')
    if (targetId.startsWith("chk:")) {
      const checkId = targetId.slice(4);
      await markCheckCleared(pool, checkId, actorId);
      return {
        success: true,
        message: "Çek başarıyla ödendi / tahsil edildi olarak işaretlendi.",
        action,
        targetId,
      };
    }
    // Otherwise regular payment instance
    await markInstancePaid(pool, targetId, amount ?? null, actorId);
    return {
      success: true,
      message: "Ödeme kalemi başarıyla ödendi olarak işaretlendi.",
      action,
      targetId,
    };
  }

  if (action === "clear_check") {
    const checkId = targetId.startsWith("chk:") ? targetId.slice(4) : targetId;
    await markCheckCleared(pool, checkId, actorId);
    return {
      success: true,
      message: "Çek başarıyla ödendi olarak işaretlendi.",
      action,
      targetId,
    };
  }

  if (action === "mark_unpaid") {
    await markInstanceUnpaid(pool, targetId, actorId);
    return {
      success: true,
      message: "Ödeme kalemi tekrar açık duruma getirildi.",
      action,
      targetId,
    };
  }

  throw new Error(`Bilinmeyen aksiyon türü: ${action}`);
}
