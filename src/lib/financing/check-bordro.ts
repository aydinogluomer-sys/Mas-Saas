// Faz 49 (D3) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü ve Karşılıksız Rücu Riski Motoru.
//
// Kapatılan iş ve muhasebe garantileri:
//   1. Müşteri çeki/senedi (`direction = 'inflow'`):
//      - `in_portfolio` (veya eski `planned`) → `endorsed_to_vendor`: seçilen açık alış faturasını
//        `invoice_allocations` (`source_table = 'checks'`) üzerinden kuruşu kuruşuna kapatır,
//        aynı para birimini (`c.currency === inv.currency`) zorunlu kılar, çeki `liquidity_forecast_daily`
//        nakit giriş tahmininden düşürür (çift sayım sıfır!) ve vadesinde `cleared` olana dek
//        `check_portfolio_and_recourse_summary.contingent_recourse_amount` şarta bağlı rücu riskinde izler.
//      - `in_portfolio` → `in_bank_collection`: seçilen banka hesabına tahsile verir.
//      - `in_portfolio` → `in_bank_collateral`: seçilen aktif kredi limitine (`credit_facilities`)
//        LTV oranıyla (`collateral_records`) teminat olarak bağlar.
//      - `endorsed_to_vendor` → `bounced` (karşılıksız / rücu dönüşü): tedarikçi rücu hakkını kullandığı
//        için `invoice_allocations` kaydını tersler (`reversed_at = now()`, tedarikçi faturası otomatik
//        yeniden açılır) ve aynı atomik işlemde P0 (`severity = 'critical'`) `control_alerts` üretir!
//   2. Kendi keşide çekimiz/senedimiz (`direction = 'outflow'`):
//      - `planned` → `issued_to_vendor` (isteğe bağlı alış faturası kapatmasıyla) → `cleared | bounced | returned`.
//   3. Sıfır kayan nokta: Tüm tutar ve LTV çarpımları `@/lib/money` (`decimal()`, `money()`) ile yürütülür.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { safeSyncDomainEventWithClient } from "@/lib/ledger/posting-engine";
import { decimal, intOrNull, money, moneyOrNull } from "@/lib/money";
import { resolvePromisesForPaidInvoicesWithClient } from "@/lib/receivables/engine";
import { parseOrThrow } from "@/lib/validation";

export const CHECK_BORDRO_TYPES = [
  "customer_receipt",
  "vendor_endorsement",
  "bank_collection",
  "bank_collateral",
  "own_issue",
  "settlement",
  "bounce_return",
] as const;
export type CheckBordroType = (typeof CHECK_BORDRO_TYPES)[number];

export const CHECK_BORDRO_OPERATIONS = [
  "receive_to_portfolio",
  "endorse_to_vendor",
  "send_to_bank_collection",
  "pledge_to_bank_collateral",
  "issue_own_check",
  "mark_cleared",
  "mark_bounced",
  "mark_returned",
] as const;
export type CheckBordroOperation = (typeof CHECK_BORDRO_OPERATIONS)[number];

export const CHECK_STATUS_LABELS_TR: Record<string, string> = {
  planned: "planlı",
  in_portfolio: "portföyde",
  endorsed_to_vendor: "tedarikçiye cirolu",
  in_bank_collection: "bankada tahsilde",
  in_bank_collateral: "bankada teminatta",
  issued_to_vendor: "keşide (verilen)",
  cleared: "tahsil / ödendi",
  bounced: "karşılıksız",
  returned: "iade edildi",
  cancelled: "iptal",
  unknown: "bilinmiyor",
};

export const CHECK_BORDRO_TYPE_LABELS_TR: Record<CheckBordroType, string> = {
  customer_receipt: "Müşteri Çeki/Senedi Giriş (Portföy)",
  vendor_endorsement: "Tedarikçiye Ciro Bordrosu",
  bank_collection: "Bankaya Tahsile Verme Bordrosu",
  bank_collateral: "Bankaya Kredi Teminatına Verme Bordrosu",
  own_issue: "Kendi Çek/Senet Keşide Bordromuz",
  settlement: "Tahsil / Ödeme Kapanış Bordrosu",
  bounce_return: "Karşılıksız / Rücu / İade Bordrosu",
};

export const CHECK_BORDRO_OPERATION_LABELS_TR: Record<CheckBordroOperation, string> = {
  receive_to_portfolio: "Portföye Al / Portföye Geri Çek",
  endorse_to_vendor: "Tedarikçiye Ciro Et (Alış Faturası Kapat)",
  send_to_bank_collection: "Bankaya Tahsile Ver",
  pledge_to_bank_collateral: "Bankaya Kredi Teminatına Ver (LTV)",
  issue_own_check: "Keşide Borç Çeki/Senedi Çıkışı",
  mark_cleared: "Tahsil Edildi / Ödendi Kapat",
  mark_bounced: "Karşılıksız (Bounced / Rücu) İşaretle",
  mark_returned: "İade Edildi İşaretle",
};

export function istanbulTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function generateBordroNo(bordroDate: string, prefix = "BRD"): string {
  const compactDate = bordroDate.replace(/-/g, "");
  const suffix = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `${prefix}-${compactDate}-${suffix}`;
}

export const checkBordroTransitionSchema = z.object({
  operation: z.enum(CHECK_BORDRO_OPERATIONS),
  checkIds: z.array(z.uuid()).min(1, "En az bir çek/senet seçilmelidir.").max(200),
  bordroDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Bordro tarihi YYYY-AA-GG biçiminde olmalıdır.")
    .optional(),
  bordroNo: z.string().trim().min(2).max(60).optional(),
  targetInvoiceId: z.uuid().nullable().optional(),
  targetPartyId: z.uuid().nullable().optional(),
  targetBankAccountId: z.uuid().nullable().optional(),
  targetFacilityId: z.uuid().nullable().optional(),
  ltvRatio: z.coerce.number().gt(0).lte(1).default(0.8),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export type CheckBordroTransitionInput = z.infer<typeof checkBordroTransitionSchema>;

export interface CheckBordroTransitionResult {
  bordroId: string;
  bordroNo: string;
  bordroType: CheckBordroType;
  nextStatus: string;
  processedCount: number;
  totalAmount: number;
  currency: string;
  settledAllocationIds: string[];
  reversedAllocationIds: string[];
  createdCollateralIds: string[];
  releasedCollateralIds: string[];
  raisedAlertIds: string[];
}

interface LockedCheckRow {
  id: string;
  direction: "inflow" | "outflow" | "unknown";
  instrument_type: "check" | "promissory_note";
  status: string;
  amount: string | null;
  currency: string;
  maturity_date: string;
  serial_no: string | null;
  counterparty_label: string | null;
  payer_party_id: string | null;
  payee_party_id: string | null;
  endorsed_to_party_id: string | null;
  collateral_record_id: string | null;
  settled_invoice_id: string | null;
}

const OPERATION_TO_BORDRO_TYPE: Record<CheckBordroOperation, CheckBordroType> = {
  receive_to_portfolio: "customer_receipt",
  endorse_to_vendor: "vendor_endorsement",
  send_to_bank_collection: "bank_collection",
  pledge_to_bank_collateral: "bank_collateral",
  issue_own_check: "own_issue",
  mark_cleared: "settlement",
  mark_bounced: "bounce_return",
  mark_returned: "bounce_return",
};

const OPERATION_TO_NEXT_STATUS: Record<CheckBordroOperation, string> = {
  receive_to_portfolio: "in_portfolio",
  endorse_to_vendor: "endorsed_to_vendor",
  send_to_bank_collection: "in_bank_collection",
  pledge_to_bank_collateral: "in_bank_collateral",
  issue_own_check: "issued_to_vendor",
  mark_cleared: "cleared",
  mark_bounced: "bounced",
  mark_returned: "returned",
};

const ALLOWED_SOURCE_STATUSES: Record<CheckBordroOperation, ReadonlySet<string>> = {
  receive_to_portfolio: new Set([
    "planned",
    "in_bank_collection",
    "in_bank_collateral",
    "endorsed_to_vendor",
    "bounced",
  ]),
  endorse_to_vendor: new Set(["in_portfolio", "planned"]),
  send_to_bank_collection: new Set(["in_portfolio", "planned", "in_bank_collateral"]),
  pledge_to_bank_collateral: new Set(["in_portfolio", "planned"]),
  issue_own_check: new Set(["planned"]),
  mark_cleared: new Set([
    "planned",
    "in_portfolio",
    "endorsed_to_vendor",
    "in_bank_collection",
    "in_bank_collateral",
    "issued_to_vendor",
    "bounced",
  ]),
  mark_bounced: new Set([
    "planned",
    "in_portfolio",
    "endorsed_to_vendor",
    "in_bank_collection",
    "in_bank_collateral",
    "issued_to_vendor",
  ]),
  mark_returned: new Set([
    "planned",
    "in_portfolio",
    "endorsed_to_vendor",
    "in_bank_collection",
    "in_bank_collateral",
    "issued_to_vendor",
    "bounced",
  ]),
};

async function reverseActiveCheckAllocations(
  client: PoolClient,
  checkId: string,
  reason: string,
  actorId: string,
): Promise<string[]> {
  const upd = await client.query<{ id: string }>(
    `update public.invoice_allocations
        set reversed_at = now(),
            reversed_by = $2,
            reversed_reason = $3
      where source_table = 'checks'
        and source_id = $1
        and reversed_at is null
      returning id::text as id`,
    [checkId, actorId, reason],
  );
  return upd.rows.map((r) => r.id);
}

async function releaseActiveCollateralRecord(
  client: PoolClient,
  collateralRecordId: string | null,
  reason: string,
): Promise<string | null> {
  if (!collateralRecordId) return null;
  const upd = await client.query<{ id: string }>(
    `update public.collateral_records
        set released_at = now(),
            release_reason = $2
      where id = $1
        and released_at is null
      returning id::text as id`,
    [collateralRecordId, reason],
  );
  return upd.rowCount === 1 ? upd.rows[0].id : null;
}

async function raiseRecourseControlAlertWithClient(
  client: PoolClient,
  chk: LockedCheckRow,
  vendorName: string | null,
  actorId: string,
): Promise<string> {
  const checkCode = "endorsed_check_bounced_recourse";
  const existing = await client.query<{ id: string }>(
    `select id::text as id
       from public.control_alerts
      where check_code = $1
        and subject_table = 'checks'
        and subject_id = $2
        and status in ('open', 'acknowledged', 'snoozed')
      for update`,
    [checkCode, chk.id],
  );

  if ((existing.rowCount ?? 0) > 0) {
    const existingId = existing.rows[0].id;
    await client.query(
      `update public.control_alerts
          set last_seen_at = now(),
              occurrence_count = occurrence_count + 1
        where id = $1`,
      [existingId],
    );
    return existingId;
  }

  const label = chk.serial_no ? `Çek/Senet ${chk.serial_no}` : `Çek/Senet ${chk.id.slice(0, 8)}`;
  const title = `Ciro edilen müşteri çeki karşılıksız çıktı — rücu borcu (${label})`;
  const detail = [
    `Tedarikçiye (${vendorName ?? "ciro alacaklısı"}) ciro edilen ${chk.amount ?? "?"} ${chk.currency} tutarındaki müşteri çeki vadesinde (${chk.maturity_date}) karşılıksız çıktı.`,
    "Tedarikçi faturası tahsisi terslenerek ticari borç yeniden açıldı; keşideci müşteriden rücu/tahsil takibi başlatılmalıdır.",
  ].join(" ");

  const ins = await client.query<{ id: string }>(
    `insert into public.control_alerts
       (check_code, severity, subject_table, subject_id, subject_label, title, detail, rule_codes, amount)
     values ($1, 'critical', 'checks', $2, $3, $4, $5, $6, $7::numeric)
     returning id::text as id`,
    [
      checkCode,
      chk.id,
      label,
      title,
      detail,
      [checkCode],
      chk.amount,
    ],
  );
  if (ins.rowCount !== 1) {
    throw new DomainError("CONFLICT", "Karşılıksız rücu kontrol uyarısı oluşturulamadı.");
  }
  const alertId = ins.rows[0].id;

  await audit(client, {
    actor: actorId,
    action: "raise_control_alert",
    entityTable: "control_alerts",
    entityId: alertId,
    after: {
      checkCode,
      severity: "critical",
      subjectId: chk.id,
      amount: moneyOrNull(chk.amount),
      currency: chk.currency,
    },
  });

  return alertId;
}

export async function executeCheckBordroTransition(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<CheckBordroTransitionResult> {
  const input = parseOrThrow(checkBordroTransitionSchema, raw, "Çek/senet bordro işlemi");
  const uniqueIds = [...new Set(input.checkIds)];
  const bordroDate = input.bordroDate ?? istanbulTodayISO();
  const bordroType = OPERATION_TO_BORDRO_TYPE[input.operation];
  const nextStatus = OPERATION_TO_NEXT_STATUS[input.operation];
  const allowedFrom = ALLOWED_SOURCE_STATUSES[input.operation];

  const client = await pool.connect();
  try {
    await client.query("begin");

    const chkRes = await client.query<LockedCheckRow>(
      `select id::text as id,
              direction,
              instrument_type,
              status,
              amount::text as amount,
              coalesce(currency, 'TRY') as currency,
              to_char(maturity_date, 'YYYY-MM-DD') as maturity_date,
              serial_no,
              counterparty_label,
              payer_party_id::text as payer_party_id,
              payee_party_id::text as payee_party_id,
              endorsed_to_party_id::text as endorsed_to_party_id,
              collateral_record_id::text as collateral_record_id,
              settled_invoice_id::text as settled_invoice_id
         from public.checks
        where id = any($1::uuid[])
          and archived_at is null
        order by maturity_date asc, id asc
        for update`,
      [uniqueIds],
    );

    if (chkRes.rows.length !== uniqueIds.length) {
      throw new DomainError("NOT_FOUND", "Seçilen çek/senetlerden en az biri bulunamadı veya arşivlenmiş.");
    }

    const checks = chkRes.rows;
    const currencies = new Set(checks.map((c) => c.currency));
    if (currencies.size > 1) {
      throw new DomainError(
        "CONFLICT",
        `Aynı bordroda farklı para birimli çekler birleştirilemez (${[...currencies].join(", ")}).`,
      );
    }
    const currency = checks[0].currency;

    let totalDec = decimal(0);
    for (const c of checks) {
      if (!allowedFrom.has(c.status)) {
        throw new DomainError(
          "CONFLICT",
          `Çek/senet (${c.serial_no ?? c.id.slice(0, 8)}) '${c.status}' durumundan '${nextStatus}' durumuna geçirilemez.`,
        );
      }

      if (
        ["receive_to_portfolio", "endorse_to_vendor", "send_to_bank_collection", "pledge_to_bank_collateral"].includes(
          input.operation,
        ) &&
        c.direction !== "inflow"
      ) {
        throw new DomainError(
          "CONFLICT",
          `Portföy / ciro / banka tahsil / teminat bordroları yalnız müşteri çekleri (inflow) için uygulanabilir (${c.serial_no ?? c.id.slice(0, 8)} yönü: ${c.direction}).`,
        );
      }

      if (input.operation === "issue_own_check" && c.direction !== "outflow") {
        throw new DomainError(
          "CONFLICT",
          `Keşide bordrosu yalnız kendi borç çeklerimiz (outflow) için uygulanabilir (${c.serial_no ?? c.id.slice(0, 8)} yönü: ${c.direction}).`,
        );
      }

      if (
        ["endorse_to_vendor", "pledge_to_bank_collateral"].includes(input.operation) &&
        (c.amount == null || decimal(c.amount).lte(0))
      ) {
        throw new DomainError(
          "CONFLICT",
          `Tutarı bilinmeyen veya sıfır olan çek/senet (${c.serial_no ?? c.id.slice(0, 8)}) ciro veya teminat bordrosuna alınamaz.`,
        );
      }

      if (c.amount != null) {
        totalDec = totalDec.plus(decimal(c.amount));
      }
    }

    // Hedef doğrulamaları (fatura, banka hesabı, kredi limiti)
    let resolvedTargetPartyId: string | null = input.targetPartyId ?? null;
    let resolvedTargetBankId: string | null = null;
    let resolvedTargetFacilityId: string | null = null;
    let lockedInvoice: {
      id: string;
      invoice_no: string;
      party_id: string;
      party_name: string;
      currency: string;
      open_amount: string;
      approval_status: string;
    } | null = null;

    if (input.operation === "endorse_to_vendor" || (input.operation === "issue_own_check" && input.targetInvoiceId)) {
      if (!input.targetInvoiceId) {
        throw new DomainError(
          "VALIDATION_ERROR",
          "Tedarikçiye ciro bordrosunda kapatılacak alış faturası seçilmelidir.",
        );
      }
      const invRes = await client.query<{
        id: string;
        direction: string;
        status: string;
        invoice_no: string;
        party_id: string;
        party_name: string;
        currency: string;
        open_amount: string;
        approval_status: string;
      }>(
        `select i.id::text as id,
                i.direction,
                i.status,
                i.invoice_no,
                i.party_id::text as party_id,
                pa.name as party_name,
                i.currency,
                greatest(0, coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0)))::text as open_amount,
                i.approval_status
           from public.invoices i
           join public.parties pa on pa.id = i.party_id
          where i.id = $1
          for update of i`,
        [input.targetInvoiceId],
      );
      if (invRes.rowCount === 0) {
        throw new DomainError("NOT_FOUND", "Ciro ile kapatılacak alış faturası bulunamadı.");
      }
      const inv = invRes.rows[0];
      if (inv.direction !== "purchase") {
        throw new DomainError(
          "CONFLICT",
          `Müşteri çeki yalnız tedarikçi alış faturasına (purchase) ciro edilebilir (${inv.invoice_no}: ${inv.direction}).`,
        );
      }
      if (!["open", "partial"].includes(inv.status)) {
        throw new DomainError("CONFLICT", `Fatura (${inv.invoice_no}) '${inv.status}' durumunda; ciro ile kapatılamaz.`);
      }
      if (["pending_approval", "rejected"].includes(inv.approval_status)) {
        throw new DomainError(
          "FORBIDDEN",
          `Alış faturası (${inv.invoice_no}) maker-checker onayı bekliyor veya reddedildi; onaylanmadan çek cirosuyla kapatılamaz.`,
        );
      }
      if (inv.currency !== currency) {
        throw new DomainError(
          "CONFLICT",
          `Çapraz-döviz cirosu yasaktır: çek para birimi (${currency}) ile alış faturası para birimi (${inv.currency}) aynı olmalıdır.`,
        );
      }
      if (resolvedTargetPartyId && resolvedTargetPartyId !== inv.party_id) {
        throw new DomainError("CONFLICT", "Seçilen tedarikçi cari kaydı ile alış faturasının carisi uyuşmuyor.");
      }
      const openInvDec = decimal(inv.open_amount);
      if (totalDec.gt(openInvDec)) {
        throw new DomainError(
          "CONFLICT",
          `Bordro çek toplamı (${totalDec.toFixed(2)} ${currency}) alış faturasının açık bakiyesini (${openInvDec.toFixed(2)} ${inv.currency}) aşıyor.`,
        );
      }
      resolvedTargetPartyId = inv.party_id;
      lockedInvoice = inv;
    }

    if (input.operation === "send_to_bank_collection") {
      if (!input.targetBankAccountId) {
        throw new DomainError("VALIDATION_ERROR", "Bankaya tahsil bordrosunda hedef banka hesabı seçilmelidir.");
      }
      const bankRes = await client.query<{ cash_account_id: string; currency: string; is_active: boolean }>(
        `select ba.cash_account_id::text as cash_account_id, ca.currency, ca.is_active
           from public.bank_accounts ba
           join public.cash_accounts ca on ca.id = ba.cash_account_id
          where ba.cash_account_id = $1`,
        [input.targetBankAccountId],
      );
      if (bankRes.rowCount === 0 || !bankRes.rows[0].is_active) {
        throw new DomainError("NOT_FOUND", "Tahsile verilecek aktif banka hesabı bulunamadı.");
      }
      if (bankRes.rows[0].currency !== currency) {
        throw new DomainError(
          "CONFLICT",
          `Çek para birimi (${currency}) ile tahsil banka hesabı para birimi (${bankRes.rows[0].currency}) eşleşmelidir.`,
        );
      }
      resolvedTargetBankId = bankRes.rows[0].cash_account_id;
    }

    if (input.operation === "pledge_to_bank_collateral") {
      if (!input.targetFacilityId) {
        throw new DomainError("VALIDATION_ERROR", "Bankaya teminat bordrosunda hedef kredi limiti seçilmelidir.");
      }
      const facRes = await client.query<{ id: string; name: string; currency: string; status: string }>(
        `select id::text as id, name, currency, status
           from public.credit_facilities
          where id = $1`,
        [input.targetFacilityId],
      );
      if (facRes.rowCount === 0) {
        throw new DomainError("NOT_FOUND", "Teminat bağlanacak kredi limiti bulunamadı.");
      }
      const fac = facRes.rows[0];
      if (fac.status !== "active") {
        throw new DomainError("CONFLICT", `'${fac.status}' durumundaki kredi limitine çek teminatı bağlanamaz.`);
      }
      if (fac.currency !== currency) {
        throw new DomainError(
          "CONFLICT",
          `Çek para birimi (${currency}) ile kredi limiti para birimi (${fac.currency}) eşleşmelidir.`,
        );
      }
      resolvedTargetFacilityId = fac.id;
    }

    const bordroNo = input.bordroNo ?? generateBordroNo(bordroDate);
    const totalAmountStr = totalDec.toFixed(2);

    const insBordro = await client.query<{ id: string }>(
      `insert into public.check_bordros
         (bordro_no, bordro_type, bordro_date, target_party_id, target_bank_account_id, target_facility_id,
          currency, total_amount, notes, created_by)
       values ($1, $2, $3::date, $4, $5, $6, $7, $8::numeric, $9, $10)
       returning id::text as id`,
      [
        bordroNo,
        bordroType,
        bordroDate,
        resolvedTargetPartyId,
        resolvedTargetBankId,
        resolvedTargetFacilityId,
        currency,
        totalAmountStr,
        input.notes ?? null,
        actorId,
      ],
    );
    if (insBordro.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Çek/senet bordro başlığı kaydedilemedi.");
    }
    const bordroId = insBordro.rows[0].id;

    const settledAllocationIds: string[] = [];
    const reversedAllocationIds: string[] = [];
    const createdCollateralIds: string[] = [];
    const releasedCollateralIds: string[] = [];
    const raisedAlertIds: string[] = [];

    for (const c of checks) {
      const priorStatus = c.status;
      let eventType: string = nextStatus;

      if (input.operation === "receive_to_portfolio") {
        eventType = priorStatus === "planned" ? "received_to_portfolio" : "recalled_to_portfolio";
        if (priorStatus === "endorsed_to_vendor") {
          const rev = await reverseActiveCheckAllocations(
            client,
            c.id,
            `Bordro ${bordroNo}: cirodan portföye geri alındı`,
            actorId,
          );
          reversedAllocationIds.push(...rev);
        }
        const rel = await releaseActiveCollateralRecord(
          client,
          c.collateral_record_id,
          `Bordro ${bordroNo}: teminattan portföye geri alındı`,
        );
        if (rel) releasedCollateralIds.push(rel);

        const upd = await client.query(
          `update public.checks
              set status = 'in_portfolio',
                  endorsed_to_party_id = null,
                  collection_bank_account_id = null,
                  collateral_facility_id = null,
                  collateral_record_id = null,
                  collateral_ltv_ratio = null,
                  settled_invoice_id = null,
                  last_bordro_id = $2
            where id = $1`,
          [c.id, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek portföy durumu güncellenemedi.");
      } else if (input.operation === "endorse_to_vendor" && lockedInvoice) {
        eventType = "endorsed_to_vendor";
        const allocAmountStr = decimal(c.amount!).toFixed(2);
        const insAlloc = await client.query<{ id: string }>(
          `insert into public.invoice_allocations
             (invoice_id, source_table, source_id, allocated_amount, allocated_on, notes, created_by)
           values ($1, 'checks', $2, $3::numeric, $4::date, $5, $6)
           returning id::text as id`,
          [
            lockedInvoice.id,
            c.id,
            allocAmountStr,
            bordroDate,
            `Ciro bordrosu ${bordroNo} (${c.serial_no ?? c.id.slice(0, 8)})`,
            actorId,
          ],
        );
        if (insAlloc.rowCount !== 1) {
          throw new DomainError("CONFLICT", "Ciro fatura tahsisi oluşturulamadı.");
        }
        settledAllocationIds.push(insAlloc.rows[0].id);

        const upd = await client.query(
          `update public.checks
              set status = 'endorsed_to_vendor',
                  endorsed_to_party_id = $2,
                  settled_invoice_id = $3,
                  collection_bank_account_id = null,
                  collateral_facility_id = null,
                  collateral_record_id = null,
                  collateral_ltv_ratio = null,
                  last_bordro_id = $4
            where id = $1`,
          [c.id, lockedInvoice.party_id, lockedInvoice.id, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek ciro durumu güncellenemedi.");
      } else if (input.operation === "send_to_bank_collection") {
        eventType = "sent_to_bank_collection";
        const rel = await releaseActiveCollateralRecord(
          client,
          c.collateral_record_id,
          `Bordro ${bordroNo}: teminattan banka tahsiline aktarıldı`,
        );
        if (rel) releasedCollateralIds.push(rel);

        const upd = await client.query(
          `update public.checks
              set status = 'in_bank_collection',
                  collection_bank_account_id = $2,
                  collateral_facility_id = null,
                  collateral_record_id = null,
                  collateral_ltv_ratio = null,
                  last_bordro_id = $3
            where id = $1`,
          [c.id, resolvedTargetBankId, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek banka tahsil durumu güncellenemedi.");
      } else if (input.operation === "pledge_to_bank_collateral") {
        eventType = "pledged_to_bank_collateral";
        const ltvDec = decimal(input.ltvRatio);
        const collateralValStr = decimal(c.amount!).times(ltvDec).toFixed(2);
        const desc = `Teminat bordrosu ${bordroNo} · ${c.instrument_type === "promissory_note" ? "Senet" : "Çek"} ${c.serial_no ?? c.id.slice(0, 8)} (Nominal ${decimal(c.amount!).toFixed(2)} ${currency}, LTV %${ltvDec.times(100).toFixed(0)})`;

        const insCol = await client.query<{ id: string }>(
          `insert into public.collateral_records
             (facility_id, collateral_type, description, value_amount, currency, valuation_date, valuation_source, owner_party_id, created_by)
           values ($1, $2, $3, $4::numeric, $5, $6::date, 'bank', $7, $8)
           returning id::text as id`,
          [
            resolvedTargetFacilityId,
            c.instrument_type,
            desc,
            collateralValStr,
            currency,
            bordroDate,
            c.payer_party_id,
            actorId,
          ],
        );
        if (insCol.rowCount !== 1) {
          throw new DomainError("CONFLICT", "Teminat kaydı (collateral_records) oluşturulamadı.");
        }
        const colId = insCol.rows[0].id;
        createdCollateralIds.push(colId);

        const upd = await client.query(
          `update public.checks
              set status = 'in_bank_collateral',
                  collateral_facility_id = $2,
                  collateral_record_id = $3,
                  collateral_ltv_ratio = $4::numeric,
                  collection_bank_account_id = null,
                  last_bordro_id = $5
            where id = $1`,
          [c.id, resolvedTargetFacilityId, colId, ltvDec.toFixed(4), bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek teminat durumu güncellenemedi.");
      } else if (input.operation === "issue_own_check") {
        eventType = "issued_to_vendor";
        let settledInvId: string | null = c.settled_invoice_id;
        let payeeId: string | null = resolvedTargetPartyId ?? c.payee_party_id;

        if (lockedInvoice && c.amount != null && decimal(c.amount).gt(0)) {
          const insAlloc = await client.query<{ id: string }>(
            `insert into public.invoice_allocations
               (invoice_id, source_table, source_id, allocated_amount, allocated_on, notes, created_by)
             values ($1, 'checks', $2, $3::numeric, $4::date, $5, $6)
             returning id::text as id`,
            [
              lockedInvoice.id,
              c.id,
              decimal(c.amount).toFixed(2),
              bordroDate,
              `Keşide bordrosu ${bordroNo} (${c.serial_no ?? c.id.slice(0, 8)})`,
              actorId,
            ],
          );
          if (insAlloc.rowCount !== 1) {
            throw new DomainError("CONFLICT", "Keşide çeki fatura tahsisi oluşturulamadı.");
          }
          settledAllocationIds.push(insAlloc.rows[0].id);
          settledInvId = lockedInvoice.id;
          payeeId = lockedInvoice.party_id;
        }

        const upd = await client.query(
          `update public.checks
              set status = 'issued_to_vendor',
                  payee_party_id = coalesce($2, payee_party_id),
                  settled_invoice_id = $3,
                  last_bordro_id = $4
            where id = $1`,
          [c.id, payeeId, settledInvId, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Keşide çek durumu güncellenemedi.");
      } else if (input.operation === "mark_cleared") {
        eventType = "cleared";
        const rel = await releaseActiveCollateralRecord(
          client,
          c.collateral_record_id,
          `Bordro ${bordroNo}: teminattaki çek vadesinde tahsil edildi`,
        );
        if (rel) releasedCollateralIds.push(rel);

        const upd = await client.query(
          `update public.checks
              set status = 'cleared',
                  last_bordro_id = $2
            where id = $1`,
          [c.id, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek tahsil/ödeme kapanışı güncellenemedi.");
      } else if (input.operation === "mark_bounced") {
        const wasEndorsed = priorStatus === "endorsed_to_vendor";
        eventType = wasEndorsed ? "recourse_returned" : "bounced";

        const rev = await reverseActiveCheckAllocations(
          client,
          c.id,
          `Bordro ${bordroNo}: çek karşılıksız çıktı (tedarikçi rücu dönüşü)`,
          actorId,
        );
        reversedAllocationIds.push(...rev);

        const rel = await releaseActiveCollateralRecord(
          client,
          c.collateral_record_id,
          `Bordro ${bordroNo}: teminattaki çek karşılıksız çıktı`,
        );
        if (rel) releasedCollateralIds.push(rel);

        const upd = await client.query(
          `update public.checks
              set status = 'bounced',
                  last_bordro_id = $2
            where id = $1`,
          [c.id, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek karşılıksız durumu güncellenemedi.");

        if (wasEndorsed) {
          let vendorName: string | null = null;
          if (c.endorsed_to_party_id) {
            const pRes = await client.query<{ name: string }>(
              `select name from public.parties where id = $1`,
              [c.endorsed_to_party_id],
            );
            vendorName = pRes.rows[0]?.name ?? null;
          }
          const alertId = await raiseRecourseControlAlertWithClient(client, c, vendorName, actorId);
          raisedAlertIds.push(alertId);
        }
      } else {
        // mark_returned
        eventType = "returned";
        const rev = await reverseActiveCheckAllocations(
          client,
          c.id,
          `Bordro ${bordroNo}: çek/senet iade edildi`,
          actorId,
        );
        reversedAllocationIds.push(...rev);

        const rel = await releaseActiveCollateralRecord(
          client,
          c.collateral_record_id,
          `Bordro ${bordroNo}: teminattaki çek/senet iade edildi`,
        );
        if (rel) releasedCollateralIds.push(rel);

        const upd = await client.query(
          `update public.checks
              set status = 'returned',
                  last_bordro_id = $2
            where id = $1`,
          [c.id, bordroId],
        );
        if (upd.rowCount !== 1) throw new DomainError("CONFLICT", "Çek iade durumu güncellenemedi.");
      }

      const insEvt = await client.query(
        `insert into public.check_events
           (check_id, bordro_id, event_type, event_note, created_by)
         values ($1, $2, $3, $4, $5)`,
        [
          c.id,
          bordroId,
          eventType,
          input.notes ? `${bordroNo}: ${input.notes}` : `Bordro ${bordroNo}`,
          actorId,
        ],
      );
      if (insEvt.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Çek bordro geçmiş satırı (check_events) kaydedilemedi.");
      }

      await audit(client, {
        actor: actorId,
        action: `check_bordro_${input.operation}`,
        entityTable: "checks",
        entityId: c.id,
        before: { status: priorStatus },
        after: {
          status: nextStatus,
          bordroId,
          bordroNo,
          bordroType,
          targetInvoiceId: lockedInvoice?.id ?? null,
          targetBankAccountId: resolvedTargetBankId,
          targetFacilityId: resolvedTargetFacilityId,
        },
      });
    }

    if (lockedInvoice) {
      await resolvePromisesForPaidInvoicesWithClient(client, [lockedInvoice.id], actorId);
    }
    await safeSyncDomainEventWithClient(
      client,
      { kind: "check_bordro", bordroId },
      actorId,
    );

    await audit(client, {
      actor: actorId,
      action: "create_check_bordro",
      entityTable: "check_bordros",
      entityId: bordroId,
      after: {
        bordroNo,
        bordroType,
        operation: input.operation,
        bordroDate,
        currency,
        totalAmount: money(totalAmountStr),
        checkCount: checks.length,
        settledAllocationCount: settledAllocationIds.length,
        reversedAllocationCount: reversedAllocationIds.length,
        createdCollateralCount: createdCollateralIds.length,
        raisedAlertCount: raisedAlertIds.length,
      },
    });

    await client.query("commit");

    return {
      bordroId,
      bordroNo,
      bordroType,
      nextStatus,
      processedCount: checks.length,
      totalAmount: money(totalAmountStr),
      currency,
      settledAllocationIds,
      reversedAllocationIds,
      createdCollateralIds,
      releasedCollateralIds,
      raisedAlertIds,
    };
  } catch (e) {
    await client.query("rollback");
    const msg = e instanceof Error ? e.message : "";
    if (!(e instanceof DomainError) && /period_locked/i.test(msg)) {
      throw new DomainError("CONFLICT", msg);
    }
    throw e;
  } finally {
    client.release();
  }
}

/* ── Bordro & Rücu Riski Okuma Modelleri ──────────────────────────────────────────────── */

export interface CheckPortfolioSummaryRow {
  currency: string;
  portfolioCount: number;
  portfolioAmount: number;
  inCollectionCount: number;
  inCollectionAmount: number;
  inCollateralCount: number;
  inCollateralAmount: number;
  collateralBorrowingValue: number;
  endorsedRecourseCount: number;
  contingentRecourseAmount: number;
  ownIssuedCount: number;
  ownIssuedAmount: number;
  bouncedInflowCount: number;
  bouncedInflowAmount: number;
  bouncedRecourseCount: number;
  bouncedRecourseAmount: number;
  bouncedOutflowCount: number;
  bouncedOutflowAmount: number;
  unknownAmountCount: number;
}

export async function loadCheckPortfolioSummary(
  pool: Pick<Pool, "query">,
): Promise<CheckPortfolioSummaryRow[]> {
  let r;
  try {
    r = await pool.query(
      `select currency,
              portfolio_count, portfolio_amount,
              in_collection_count, in_collection_amount,
              in_collateral_count, in_collateral_amount, collateral_borrowing_value,
              endorsed_recourse_count, contingent_recourse_amount,
              own_issued_count, own_issued_amount,
              bounced_inflow_count, bounced_inflow_amount,
              bounced_recourse_count, bounced_recourse_amount,
              bounced_outflow_count, bounced_outflow_amount,
              unknown_amount_count
         from public.check_portfolio_and_recourse_summary`,
    );
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode !== "42P01" && pgCode !== "42703") throw err;
    r = await pool.query(
      `select 'TRY'::text as currency,
              count(*) filter (where direction = 'inflow' and status = 'in_portfolio')::int as portfolio_count,
              coalesce(sum(amount) filter (where direction = 'inflow' and status = 'in_portfolio'), 0) as portfolio_amount,
              count(*) filter (where direction = 'inflow' and status = 'in_collection')::int as in_collection_count,
              coalesce(sum(amount) filter (where direction = 'inflow' and status = 'in_collection'), 0) as in_collection_amount,
              0::int as in_collateral_count,
              0::numeric as in_collateral_amount,
              0::numeric as collateral_borrowing_value,
              count(*) filter (where direction = 'inflow' and status = 'endorsed')::int as endorsed_recourse_count,
              coalesce(sum(amount) filter (where direction = 'inflow' and status = 'endorsed'), 0) as contingent_recourse_amount,
              count(*) filter (where direction = 'outflow' and status in ('issued', 'open'))::int as own_issued_count,
              coalesce(sum(amount) filter (where direction = 'outflow' and status in ('issued', 'open')), 0) as own_issued_amount,
              count(*) filter (where direction = 'inflow' and status = 'bounced')::int as bounced_inflow_count,
              coalesce(sum(amount) filter (where direction = 'inflow' and status = 'bounced'), 0) as bounced_inflow_amount,
              0::int as bounced_recourse_count,
              0::numeric as bounced_recourse_amount,
              count(*) filter (where direction = 'outflow' and status = 'bounced')::int as bounced_outflow_count,
              coalesce(sum(amount) filter (where direction = 'outflow' and status = 'bounced'), 0) as bounced_outflow_amount,
              count(*) filter (where amount is null)::int as unknown_amount_count
         from public.checks
        where archived_at is null`,
    ).catch(() => ({ rows: [] }));
  }

  return r.rows.map((x) => ({
    currency: String(x.currency ?? "TRY"),
    portfolioCount: intOrNull(x.portfolio_count) ?? 0,
    portfolioAmount: moneyOrNull(x.portfolio_amount) ?? 0,
    inCollectionCount: intOrNull(x.in_collection_count) ?? 0,
    inCollectionAmount: moneyOrNull(x.in_collection_amount) ?? 0,
    inCollateralCount: intOrNull(x.in_collateral_count) ?? 0,
    inCollateralAmount: moneyOrNull(x.in_collateral_amount) ?? 0,
    collateralBorrowingValue: moneyOrNull(x.collateral_borrowing_value) ?? 0,
    endorsedRecourseCount: intOrNull(x.endorsed_recourse_count) ?? 0,
    contingentRecourseAmount: moneyOrNull(x.contingent_recourse_amount) ?? 0,
    ownIssuedCount: intOrNull(x.own_issued_count) ?? 0,
    ownIssuedAmount: moneyOrNull(x.own_issued_amount) ?? 0,
    bouncedInflowCount: intOrNull(x.bounced_inflow_count) ?? 0,
    bouncedInflowAmount: moneyOrNull(x.bounced_inflow_amount) ?? 0,
    bouncedRecourseCount: intOrNull(x.bounced_recourse_count) ?? 0,
    bouncedRecourseAmount: moneyOrNull(x.bounced_recourse_amount) ?? 0,
    bouncedOutflowCount: intOrNull(x.bounced_outflow_count) ?? 0,
    bouncedOutflowAmount: moneyOrNull(x.bounced_outflow_amount) ?? 0,
    unknownAmountCount: intOrNull(x.unknown_amount_count) ?? 0,
  }));
}

export interface CheckBordroListItem {
  id: string;
  bordroNo: string;
  bordroType: CheckBordroType;
  bordroDate: string;
  currency: string;
  totalAmount: number;
  targetLabel: string | null;
  notes: string | null;
  checkCount: number;
}

export async function loadRecentCheckBordros(
  pool: Pick<Pool, "query">,
  limit = 20,
): Promise<CheckBordroListItem[]> {
  let r;
  try {
    r = await pool.query(
      `select b.id::text as id,
              b.bordro_no,
              b.bordro_type,
              to_char(b.bordro_date, 'YYYY-MM-DD') as bordro_date,
              b.currency,
              b.total_amount,
              coalesce(pa.name, ca.name, cf.name) as target_label,
              b.notes,
              (select count(*)::int from public.check_events ce where ce.bordro_id = b.id) as check_count
         from public.check_bordros b
         left join public.parties pa on pa.id = b.target_party_id
         left join public.cash_accounts ca on ca.id = b.target_bank_account_id
         left join public.credit_facilities cf on cf.id = b.target_facility_id
        order by b.bordro_date desc, b.created_at desc
        limit $1`,
      [Math.max(1, Math.min(limit, 100))],
    );
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === "42P01" || pgCode === "42703") return [];
    throw err;
  }

  return r.rows.map((x) => ({
    id: x.id,
    bordroNo: x.bordro_no,
    bordroType: x.bordro_type as CheckBordroType,
    bordroDate: x.bordro_date,
    currency: x.currency,
    totalAmount: moneyOrNull(x.total_amount) ?? 0,
    targetLabel: x.target_label ?? null,
    notes: x.notes ?? null,
    checkCount: intOrNull(x.check_count) ?? 0,
  }));
}

export interface CheckBordroTargets {
  openPurchaseInvoices: Array<{
    id: string;
    invoiceNo: string;
    partyName: string;
    openAmount: number;
    currency: string;
    dueDate: string | null;
  }>;
  bankAccounts: Array<{
    id: string;
    name: string;
    bankName: string | null;
    currency: string;
  }>;
  creditFacilities: Array<{
    id: string;
    name: string;
    lenderName: string | null;
    currency: string;
  }>;
}

export async function loadCheckBordroTargets(
  pool: Pick<Pool, "query">,
): Promise<CheckBordroTargets> {
  const { gather } = await import("@/lib/pg-concurrency");
  const [invRes, bankRes, facRes] = await gather(pool, [
    () => pool.query(
      `select i.id::text as id,
              i.invoice_no,
              pa.name as party_name,
              greatest(0, coalesce(i.payable_amount, i.gross_amount) - greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0))) as open_amount,
              i.currency,
              to_char(coalesce(i.due_date, i.issue_date), 'YYYY-MM-DD') as due_date
         from public.invoices i
         join public.parties pa on pa.id = i.party_id
        where i.direction = 'purchase'
          and i.status in ('open', 'partial')
          and i.approval_status not in ('pending_approval', 'rejected')
          and coalesce(i.payable_amount, i.gross_amount) > greatest(coalesce(i.paid_amount, 0), coalesce(i.allocated_amount, 0))
        order by coalesce(i.due_date, i.issue_date) asc, i.invoice_no asc
        limit 150`,
    ).catch(async (err) => {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode !== "42703" && pgCode !== "42P01") throw err;
      return pool.query(
        `select i.id::text as id,
                i.invoice_no,
                pa.name as party_name,
                (i.gross_amount - coalesce(i.allocated_amount, 0)) as open_amount,
                i.currency,
                to_char(coalesce(i.due_date, i.issue_date), 'YYYY-MM-DD') as due_date
           from public.invoices i
           join public.parties pa on pa.id = i.party_id
          where i.direction = 'purchase'
            and i.status in ('open', 'partial')
            and i.gross_amount > coalesce(i.allocated_amount, 0)
          order by coalesce(i.due_date, i.issue_date) asc, i.invoice_no asc
          limit 150`,
      ).catch(() => ({ rows: [] }));
    }),
    () => pool.query(
      `select ba.cash_account_id::text as id,
              ca.name,
              ba.bank_name,
              ca.currency
         from public.bank_accounts ba
         join public.cash_accounts ca on ca.id = ba.cash_account_id
        where ca.is_active = true
        order by ca.name asc`,
    ).catch(() => ({ rows: [] })),
    () => pool.query(
      `select cf.id::text as id,
              cf.name,
              pa.name as lender_name,
              cf.currency
         from public.credit_facilities cf
         left join public.parties pa on pa.id = cf.lender_party_id
        where cf.status = 'active'
        order by cf.name asc`,
    ).catch(() => ({ rows: [] })),
  ]);

  return {
    openPurchaseInvoices: invRes.rows.map((x) => ({
      id: x.id,
      invoiceNo: x.invoice_no,
      partyName: x.party_name,
      openAmount: moneyOrNull(x.open_amount) ?? 0,
      currency: x.currency,
      dueDate: x.due_date ?? null,
    })),
    bankAccounts: bankRes.rows.map((x) => ({
      id: x.id,
      name: x.name,
      bankName: x.bank_name ?? null,
      currency: x.currency,
    })),
    creditFacilities: facRes.rows.map((x) => ({
      id: x.id,
      name: x.name,
      lenderName: x.lender_name ?? null,
      currency: x.currency,
    })),
  };
}

