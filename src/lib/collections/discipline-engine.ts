// Kilit Taşı 2 — Tahsilat Disiplin Döngüsü (Collection Discipline Loop)
//
// promise_to_pay ↔ reminders ↔ customer_collection_score ↔ action_items
//
// Bir müşteri ödeme sözü verdiğinde otomatik hatırlatma akışını kurgular.
// Söz bozulduğunda ise:
//   1. Müşteri tahsilat skorunun ve risk bandının güncel durumunu hesaplar.
//   2. Kredi limiti aşımı ve açık vadeli risk değerlendirmesi yapar.
//   3. Finans ve satış yönetimi için anlık yüksek öncelikli action_item (görev/uyarı) üretir.
//   4. İlgili cache tag'lerini (COLLECTIONS, CONTROLS, INVOICES) geçersiz kılar.

import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { invalidateTags } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import { addDaysISO } from "@/lib/financing/rules";
import { detectBrokenPromises, type BrokenPromiseResult } from "./promises-engine";
import { daysLate } from "./promises";

export type CollectionRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type CollectionRecommendation =
  | "FREEZE_CREDIT"        // Vadeli satışı derhal durdur / peşinat iste
  | "REQUIRE_ADVANCE"       // Asgari %50 nakit peşinat şartı koy
  | "INTENSIVE_FOLLOWUP"   // Günlük arama ve noter/ihtar süreci başlat
  | "STANDARD_COLLECTION";  // Rutin takip akışında tut

export interface CustomerRiskEvaluation {
  partyId: string;
  partyName: string;
  collectionScore: number;
  scoreBand: string;
  scoreReasons: string[];
  openReceivableAmount: number | null;
  overdueAmount: number | null;
  creditLimit: number | null;
  creditLimitCurrency: string;
  creditLimitUtilization: number | null;
  overCreditLimit: boolean | null;
  riskLevel: CollectionRiskLevel;
  recommendation: CollectionRecommendation;
  recommendationText: string;
}

export interface PromiseReminderPlan {
  promiseId: string;
  partyId: string;
  partyName: string;
  promisedDate: string;
  amount: number | null;
  currency: string;
  scheduledDeliveries: Array<{
    targetDate: string;
    offsetDays: number;
    description: string;
  }>;
}

export interface BrokenPromiseHandlingResult {
  promiseId: string;
  partyId: string;
  partyName: string;
  promisedDate: string;
  daysLate: number;
  evaluation: CustomerRiskEvaluation;
  actionItemId: string | null;
  creditRiskWarning: boolean;
}

export interface DisciplineCycleResult {
  scanDate: string;
  detection: BrokenPromiseResult;
  handledBrokenPromises: BrokenPromiseHandlingResult[];
  criticalAlertCount: number;
  creditFreezeRecommendedCount: number;
}

/**
 * Bir ödeme sözü için T-2, T-0, T+1 hatırlatma planını hesaplar (pure function).
 */
export function planPromiseReminders(input: {
  promiseId: string;
  partyId: string;
  partyName: string;
  promisedDate: string;
  amount: number | null;
  currency?: string;
}): PromiseReminderPlan {
  const pDate = input.promisedDate.slice(0, 10);
  return {
    promiseId: input.promiseId,
    partyId: input.partyId,
    partyName: input.partyName,
    promisedDate: pDate,
    amount: input.amount,
    currency: input.currency ?? "TRY",
    scheduledDeliveries: [
      {
        targetDate: addDaysISO(pDate, -2),
        offsetDays: 2,
        description: `${input.partyName} - Ödeme sözüne 2 gün kaldı (${pDate})`,
      },
      {
        targetDate: pDate,
        offsetDays: 0,
        description: `${input.partyName} - Bugün ödeme sözü günü (${pDate})`,
      },
      {
        targetDate: addDaysISO(pDate, 1),
        offsetDays: -1,
        description: `${input.partyName} - Ödeme sözü teyit kontrolü (${pDate} sözü)`,
      },
    ],
  };
}

/**
 * Yeni ödeme sözü girildiğinde disiplin döngüsünü tetikler.
 * İlgili hatırlatma kurallarını doğrular ve önbelleği tazeler.
 */
export async function onPromiseCreated(
  pool: Pool,
  promiseId: string,
  actorId: string,
): Promise<PromiseReminderPlan> {
  const res = await pool.query(
    `select p.id, p.party_id, pa.name as party_name,
            to_char(p.promised_date, 'YYYY-MM-DD') as promised_date,
            p.promised_amount, p.currency
     from public.promise_to_pay p
     join public.parties pa on pa.id = p.party_id
     where p.id = $1`,
    [promiseId],
  );

  if (res.rowCount === 0) {
    throw new DomainError(`Ödeme sözü bulunamadı (ID: ${promiseId})`);
  }

  const row = res.rows[0];
  const plan = planPromiseReminders({
    promiseId: row.id,
    partyId: row.party_id,
    partyName: row.party_name,
    promisedDate: row.promised_date,
    amount: moneyOrNull(row.promised_amount),
    currency: row.currency,
  });

  await audit(pool, {
    actor: actorId,
    action: "promise_reminders_planned",
    entityTable: "promise_to_pay",
    entityId: promiseId,
    after: {
      partyId: row.party_id,
      promisedDate: row.promised_date,
      deliveriesPlanned: plan.scheduledDeliveries.length,
      automated: true,
    },
  });

  invalidateTags([CACHE_TAGS.COLLECTIONS, CACHE_TAGS.REMINDERS]);
  return plan;
}

/**
 * Bir carinin anlık tahsilat skoru ve risk/limit durumunu değerlendirir.
 */
export async function evaluateCustomerRisk(
  pool: Pool,
  partyId: string,
): Promise<CustomerRiskEvaluation> {
  const query = `
    select
      s.party_id,
      s.party_name,
      s.collection_score,
      s.score_band,
      s.score_reasons,
      s.open_receivable_amount,
      s.overdue_amount,
      cp.credit_limit,
      coalesce(cp.credit_limit_currency, 'TRY') as credit_limit_currency,
      case
        when cp.credit_limit is not null and cp.credit_limit > 0 and coalesce(cp.credit_limit_currency, 'TRY') = 'TRY'
          then round(coalesce(s.open_receivable_amount, 0) / cp.credit_limit, 4)
        else null
      end as credit_limit_utilization,
      case
        when cp.credit_limit is null then false
        when coalesce(cp.credit_limit_currency, 'TRY') <> 'TRY' then null
        when coalesce(s.open_receivable_amount, 0) > cp.credit_limit then true
        else false
      end as over_credit_limit
    from public.customer_collection_score s
    left join public.counterparty_profiles cp on cp.party_id = s.party_id
    where s.party_id = $1
  `;

  const res = await pool.query(query, [partyId]);
  if (res.rowCount === 0) {
    // Cari skoru henüz oluşmamışsa partiden temel kaydı çek
    const pRes = await pool.query(`select id, name from public.parties where id=$1`, [partyId]);
    if (pRes.rowCount === 0) throw new DomainError("Cari bulunamadı");
    const pName = pRes.rows[0].name;

    return {
      partyId,
      partyName: pName,
      collectionScore: 100,
      scoreBand: "good",
      scoreReasons: [],
      openReceivableAmount: 0,
      overdueAmount: 0,
      creditLimit: null,
      creditLimitCurrency: "TRY",
      creditLimitUtilization: null,
      overCreditLimit: false,
      riskLevel: "LOW",
      recommendation: "STANDARD_COLLECTION",
      recommendationText: "Müşteri risk profili temiz. Standart tahsilat akışı.",
    };
  }

  const r = res.rows[0];
  const score = Number(r.collection_score);
  const scoreBand = String(r.score_band);
  const reasons = (r.score_reasons ?? []) as string[];
  const openReceivable = moneyOrNull(r.open_receivable_amount);
  const overdueAmount = moneyOrNull(r.overdue_amount);
  const creditLimit = moneyOrNull(r.credit_limit);
  const utilization = r.credit_limit_utilization == null ? null : Number(r.credit_limit_utilization);
  const isOverLimit = r.over_credit_limit === true;

  // Risk ve tavsiye matrisi
  let riskLevel: CollectionRiskLevel = "LOW";
  let recommendation: CollectionRecommendation = "STANDARD_COLLECTION";
  let recommendationText = "Müşteri risk profili iyi düzeyde. Rutin takip sürdürülüyor.";

  if (scoreBand === "critical" || score < 35 || isOverLimit) {
    riskLevel = "CRITICAL";
    recommendation = "FREEZE_CREDIT";
    recommendationText = isOverLimit
      ? "Kredi limiti aşıldı ve tahsilat skoru kritik! Yeni sevkiyatları ve vadeli satışı derhal durdurun; nakit teminat isteyin."
      : "Tahsilat skoru kritik seviyede (<35). Vadeli satışı dondurun, açık hesap bakiyeyi derhal tahsil edin.";
  } else if (scoreBand === "risk" || score < 60 || (utilization != null && utilization >= 0.9)) {
    riskLevel = "HIGH";
    recommendation = "REQUIRE_ADVANCE";
    recommendationText = "Yüksek tahsilat riski / limite yakın kullanım. Yeni siparişlerde asgari %50 peşinat şartı getirin.";
  } else if (scoreBand === "watch" || (overdueAmount != null && overdueAmount > 0)) {
    riskLevel = "MEDIUM";
    recommendation = "INTENSIVE_FOLLOWUP";
    recommendationText = "Vadesi geçmiş bakiye veya dikkat gerektiren ödeme alışkanlığı. Yakın takip ve haftalık mutabakat yapın.";
  }

  return {
    partyId: r.party_id,
    partyName: r.party_name,
    collectionScore: score,
    scoreBand,
    scoreReasons: reasons,
    openReceivableAmount: openReceivable,
    overdueAmount,
    creditLimit,
    creditLimitCurrency: r.credit_limit_currency,
    creditLimitUtilization: utilization,
    overCreditLimit: isOverLimit,
    riskLevel,
    recommendation,
    recommendationText,
  };
}

/**
 * Bozulmuş bir ödeme sözünü işler, müşteri riskini analiz eder ve finans ekibine görev/uyarı atar.
 */
export async function handleBrokenPromise(
  pool: Pool,
  promiseId: string,
  actorId: string,
  todayISO = istanbulDateISO(),
): Promise<BrokenPromiseHandlingResult> {
  const pRes = await pool.query(
    `select p.id, p.party_id, pa.name as party_name,
            to_char(p.promised_date, 'YYYY-MM-DD') as promised_date,
            p.promised_amount, p.currency, p.status
     from public.promise_to_pay p
     join public.parties pa on pa.id = p.party_id
     where p.id = $1`,
    [promiseId],
  );

  if (pRes.rowCount === 0) throw new DomainError(`Ödeme sözü bulunamadı (ID: ${promiseId})`);
  const promise = pRes.rows[0];

  // Eğer hâlâ 'pending' ise broken yap (otomatik veya manuel tetikleme)
  if (promise.status === "pending") {
    await pool.query(
      `update public.promise_to_pay
       set status = 'broken', resolved_at = now(), resolved_by = null,
           resolution_source = 'auto_detection'
       where id = $1`,
      [promiseId],
    );
  }

  const pDate = promise.promised_date;
  const late = daysLate(pDate, todayISO);
  const amountStr = promise.promised_amount ? `${Number(promise.promised_amount).toLocaleString("tr-TR")} ${promise.currency}` : "Belirtilmemiş";

  // Müşteri risk durumunu çek
  const evalResult = await evaluateCustomerRisk(pool, promise.party_id);

  const isCritical = evalResult.riskLevel === "CRITICAL" || late >= 7;
  const severity = isCritical ? "critical" : "warning";
  const title = `SÖZ BOZULDU: ${promise.party_name} (${amountStr}) — [${evalResult.riskLevel}]`;
  const note = `Söz verilen tarih ${pDate} (${late} gün gecikme). Güncel Skor: ${evalResult.collectionScore}/100 (${evalResult.scoreBand}). Aksiyon: ${evalResult.recommendationText}`;

  // Görev (action_items) aç veya güncelle
  const itemRes = await pool.query(
    `insert into public.action_items
       (title, severity, status, source_type, related_entity_table, related_entity_id, note, created_by)
     values ($1, $2, 'open', 'collection', 'promise_to_pay', $3, $4, $5)
     on conflict do nothing
     returning id`,
    [title, severity, promiseId, note, actorId],
  );

  const actionItemId = itemRes.rowCount && itemRes.rowCount > 0 ? itemRes.rows[0].id : null;

  await audit(pool, {
    actor: actorId,
    action: "broken_promise_handled",
    entityTable: "promise_to_pay",
    entityId: promiseId,
    after: {
      partyId: promise.party_id,
      riskLevel: evalResult.riskLevel,
      recommendation: evalResult.recommendation,
      actionItemId,
      creditLimitWarning: evalResult.overCreditLimit === true,
      automated: true,
    },
  });

  // Önbellekleri geçersiz kıl
  invalidateTags([
    CACHE_TAGS.COLLECTIONS,
    CACHE_TAGS.CONTROLS,
    CACHE_TAGS.INVOICES,
    CACHE_TAGS.RECEIVABLES,
  ]);

  return {
    promiseId,
    partyId: promise.party_id,
    partyName: promise.party_name,
    promisedDate: pDate,
    daysLate: late,
    evaluation: evalResult,
    actionItemId,
    creditRiskWarning: evalResult.overCreditLimit === true || evalResult.riskLevel === "CRITICAL",
  };
}

/**
 * Tüm sistemi tarayarak tahsilat disiplin döngüsünü baştan sona icra eder.
 */
export async function runDisciplineCycle(
  pool: Pool,
  todayISO = istanbulDateISO(),
  actorId: string,
): Promise<DisciplineCycleResult> {
  // 1. Günü geçmiş ödeme sözlerini tespit et
  const detection = await detectBrokenPromises(pool, todayISO, actorId);

  // 2. Her bozulmuş söz için risk analizi ve aksiyon oluştur
  const handled: BrokenPromiseHandlingResult[] = [];
  for (const promiseId of detection.promiseIds) {
    const res = await handleBrokenPromise(pool, promiseId, actorId, todayISO);
    handled.push(res);
  }

  const criticalAlertCount = handled.filter((h) => h.evaluation.riskLevel === "CRITICAL").length;
  const creditFreezeRecommendedCount = handled.filter(
    (h) => h.evaluation.recommendation === "FREEZE_CREDIT",
  ).length;

  return {
    scanDate: todayISO,
    detection,
    handledBrokenPromises: handled,
    criticalAlertCount,
    creditFreezeRecommendedCount,
  };
}
