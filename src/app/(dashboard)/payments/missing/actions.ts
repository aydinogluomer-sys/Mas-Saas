"use server";

import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { requireActionPermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import {
  isPeriodLockTriggerError,
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { isNumericString, round2 } from "@/lib/money";
import { refreshRiskFlags, setInstanceAmount } from "@/lib/radar/engine";
import { istanbulDateISO } from "@/lib/time/istanbul";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MONEY_AMOUNT = 999_999_999_999.99;

export type InlineMissingAmountResult =
  | { ok: true; instanceId: string; amount: number }
  | { ok: false; error: string };

export type BulkMissingAmountResult =
  | {
      ok: true;
      updatedCount: number;
      skippedLockedCount: number;
      updatedIds: string[];
      amount: number;
    }
  | { ok: false; error: string };

function isNextRedirectError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

/**
 * Parses flexible financial user input ("45000", "45000.50", "45.000,50", "45.000")
 * into an exact 2-decimal number >= 0, rejecting empty, NaN, negative, or malformed strings.
 */
function parseMissingAmountInput(rawAmount: string): number | null {
  const cleaned = String(rawAmount ?? "")
    .replace(/\u00a0/g, " ")
    .trim()
    .replace(/\s+/g, "")
    .replace(/(?:TL|TRY|USD|EUR|GBP|₺|\$|€|£)$/i, "");

  if (!cleaned || cleaned.startsWith("-") || cleaned === "+") {
    return null;
  }

  let normalized = cleaned.startsWith("+") ? cleaned.slice(1) : cleaned;

  if (normalized.includes(",")) {
    if (/^\d{1,3}(,\d{3})+\.\d+$/.test(normalized)) {
      // International thousands comma + dot decimal: "45,000.50"
      normalized = normalized.replace(/,/g, "");
    } else if (
      /^\d{1,3}(\.\d{3})*(,\d+)?$/.test(normalized) ||
      /^\d+(,\d+)?$/.test(normalized)
    ) {
      // Turkish thousands dot + comma decimal: "45.000,50" or "45000,50"
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      return null;
    }
  } else if (/^[1-9]\d{0,2}(\.\d{3})+$/.test(normalized)) {
    // Turkish thousands dot without decimals: "45.000" or "1.250.000"
    normalized = normalized.replace(/\./g, "");
  }

  if (!isNumericString(normalized)) {
    return null;
  }

  let parsed: number;
  try {
    parsed = round2(normalized);
  } catch {
    return null;
  }

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_MONEY_AMOUNT) {
    return null;
  }

  return parsed;
}

function isLockedPeriodFailure(err: unknown): boolean {
  if (isPgPeriodLockedError(err) || isPeriodLockTriggerError(err)) {
    return true;
  }
  if (err instanceof DomainError && err.message === PERIOD_LOCKED_USER_MESSAGE) {
    return true;
  }
  return false;
}

function toActionError(err: unknown): { ok: false; error: string } {
  if (isNextRedirectError(err)) {
    throw err;
  }
  if (isPgPeriodLockedError(err) || isPeriodLockTriggerError(err)) {
    try {
      translatePeriodLockError(err);
    } catch (translated) {
      if (translated instanceof DomainError) {
        return { ok: false, error: translated.message };
      }
    }
    return { ok: false, error: PERIOD_LOCKED_USER_MESSAGE };
  }
  if (err instanceof DomainError) {
    return { ok: false, error: err.message };
  }
  throw err;
}

function revalidateMissingAmountViews(): void {
  revalidatePath("/payments/missing");
  revalidatePath("/payments");
  revalidatePath("/");
  revalidatePath("/data/quality");
}

async function queryLockedMonthsSet(): Promise<Set<string>> {
  const pool = getPool();
  const locked = new Set<string>();
  try {
    const cmRes = await pool.query<{ month_start: string }>(
      `select to_char(month_start, 'YYYY-MM-DD') as month_start
         from public.cashflow_months
        where status = 'locked'`,
    );
    for (const r of cmRes.rows) locked.add(r.month_start);
  } catch {
    // Trigger-level enforcement remains authoritative if table read is unavailable
  }
  try {
    const apRes = await pool.query<{ period_month: string }>(
      `select to_char(period_month, 'YYYY-MM-DD') as period_month
         from public.accounting_periods
        where status = 'locked'`,
    );
    for (const r of apRes.rows) locked.add(r.period_month);
  } catch {
    // Optional relation in older migration snapshots
  }
  return locked;
}

export async function inlineSetMissingAmountAction(input: {
  instanceId: string;
  rawAmount: string;
}): Promise<InlineMissingAmountResult> {
  try {
    const session = await requireActionPermission(
      "payment_instances",
      "update",
      "/payments/missing",
    );
    const instanceId = String(input?.instanceId ?? "").trim();
    if (!UUID_RE.test(instanceId)) {
      return { ok: false, error: "Geçersiz ödeme örneği kimliği." };
    }
    const parsedAmount = parseMissingAmountInput(input?.rawAmount ?? "");
    if (parsedAmount === null) {
      return { ok: false, error: "Geçerli bir tutar girin." };
    }

    const pool = getPool();
    await setInstanceAmount(pool, instanceId, parsedAmount, session.id);
    await refreshRiskFlags(pool, istanbulDateISO()).catch(() => undefined);
    revalidateMissingAmountViews();

    return { ok: true, instanceId, amount: parsedAmount };
  } catch (err) {
    return toActionError(err);
  }
}

export async function bulkSetTemplateMissingAmountsAction(input: {
  paymentId: string;
  rawAmount: string;
}): Promise<BulkMissingAmountResult> {
  try {
    const session = await requireActionPermission(
      "payment_instances",
      "update",
      "/payments/missing",
    );
    const paymentId = String(input?.paymentId ?? "").trim();
    if (!UUID_RE.test(paymentId)) {
      return { ok: false, error: "Geçersiz ödeme şablonu kimliği." };
    }
    const parsedAmount = parseMissingAmountInput(input?.rawAmount ?? "");
    if (parsedAmount === null) {
      return { ok: false, error: "Geçerli bir tutar girin." };
    }

    const pool = getPool();
    const openRows = await pool.query<{
      id: string;
      instance_month: string;
      due_month: string;
    }>(
      `select id::text as id,
              to_char(instance_month, 'YYYY-MM-DD') as instance_month,
              to_char(date_trunc('month', due_date)::date, 'YYYY-MM-DD') as due_month
         from public.payment_instances
        where payment_id = $1::uuid
          and amount is null
          and status in ('unpaid', 'planned', 'late')
          and cancelled_at is null
        order by due_date asc, id asc`,
      [paymentId],
    );

    const lockedMonths = await queryLockedMonthsSet();
    let updatedCount = 0;
    let skippedLockedCount = 0;
    const updatedIds: string[] = [];

    for (const row of openRows.rows) {
      if (lockedMonths.has(row.instance_month) || lockedMonths.has(row.due_month)) {
        skippedLockedCount += 1;
        continue;
      }
      try {
        await setInstanceAmount(pool, row.id, parsedAmount, session.id);
        updatedCount += 1;
        updatedIds.push(row.id);
      } catch (err) {
        if (isLockedPeriodFailure(err)) {
          skippedLockedCount += 1;
          continue;
        }
        throw err;
      }
    }

    if (updatedCount > 0 || skippedLockedCount > 0) {
      await audit(pool, {
        actor: session.id,
        action: "bulk_set_template_missing_amounts",
        entityTable: "payment_instances",
        entityId: null,
        before: null,
        after: {
          paymentId,
          amount: parsedAmount,
          updatedCount,
          skippedLockedCount,
          updatedIds,
        },
      });
    }

    if (updatedCount > 0) {
      await refreshRiskFlags(pool, istanbulDateISO()).catch(() => undefined);
    }
    revalidateMissingAmountViews();

    return {
      ok: true,
      updatedCount,
      skippedLockedCount,
      updatedIds,
      amount: parsedAmount,
    };
  } catch (err) {
    return toActionError(err);
  }
}

export async function bulkSetInstancesByIdsAction(input: {
  instanceIds: string[];
  rawAmount: string;
}): Promise<BulkMissingAmountResult> {
  try {
    const session = await requireActionPermission(
      "payment_instances",
      "update",
      "/payments/missing",
    );
    const uniqueIds = Array.from(
      new Set((input?.instanceIds ?? []).map((id) => String(id).trim()).filter(Boolean)),
    );
    if (
      uniqueIds.length === 0 ||
      uniqueIds.length > 500 ||
      !uniqueIds.every((id) => UUID_RE.test(id))
    ) {
      return { ok: false, error: "Geçerli ödeme örnekleri seçilmelidir." };
    }

    const parsedAmount = parseMissingAmountInput(input?.rawAmount ?? "");
    if (parsedAmount === null) {
      return { ok: false, error: "Geçerli bir tutar girin." };
    }

    const pool = getPool();
    const openRows = await pool.query<{
      id: string;
      instance_month: string;
      due_month: string;
    }>(
      `select id::text as id,
              to_char(instance_month, 'YYYY-MM-DD') as instance_month,
              to_char(date_trunc('month', due_date)::date, 'YYYY-MM-DD') as due_month
         from public.payment_instances
        where id = any($1::uuid[])
          and amount is null
          and status in ('unpaid', 'planned', 'late', 'partial')
          and cancelled_at is null
        order by due_date asc, id asc`,
      [uniqueIds],
    );

    const lockedMonths = await queryLockedMonthsSet();
    let updatedCount = 0;
    let skippedLockedCount = 0;
    const updatedIds: string[] = [];

    for (const row of openRows.rows) {
      if (lockedMonths.has(row.instance_month) || lockedMonths.has(row.due_month)) {
        skippedLockedCount += 1;
        continue;
      }
      try {
        await setInstanceAmount(pool, row.id, parsedAmount, session.id);
        updatedCount += 1;
        updatedIds.push(row.id);
      } catch (err) {
        if (isLockedPeriodFailure(err)) {
          skippedLockedCount += 1;
          continue;
        }
        throw err;
      }
    }

    if (updatedCount > 0 || skippedLockedCount > 0) {
      await audit(pool, {
        actor: session.id,
        action: "bulk_set_instances_missing_amounts",
        entityTable: "payment_instances",
        entityId: null,
        before: null,
        after: {
          requestedCount: uniqueIds.length,
          amount: parsedAmount,
          updatedCount,
          skippedLockedCount,
          updatedIds,
        },
      });
    }

    if (updatedCount > 0) {
      await refreshRiskFlags(pool, istanbulDateISO()).catch(() => undefined);
    }
    revalidateMissingAmountViews();

    return {
      ok: true,
      updatedCount,
      skippedLockedCount,
      updatedIds,
      amount: parsedAmount,
    };
  } catch (err) {
    return toActionError(err);
  }
}
