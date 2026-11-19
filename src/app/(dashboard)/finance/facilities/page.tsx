import type { QueryResultRow } from "pg";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { isReportingCurrency } from "@/lib/currency-policy";
import { getPool } from "@/lib/db";
import {
  COLLATERAL_TYPES,
  COLLATERAL_TYPE_LABEL,
  COVENANT_TYPES,
  FACILITY_STATUS_LABEL,
  FACILITY_TYPES,
  FACILITY_TYPE_LABEL,
  GUARANTEE_TYPES,
  GUARANTEE_TYPE_LABELS,
  loadFacilityAccrualsAndGuarantees,
  type CollateralType,
  type FacilityStatus,
  type FacilityType,
} from "@/lib/financing/facilities";
import { formatMoney } from "@/lib/money-format";
import { isMissingSchemaError, loadCovenantAndDscrRadar } from "@/lib/financing/covenants-and-dscr";
import {
  accrueFacilityInterestAction,
  addCollateralAction,
  createFacilityAction,
  createLetterOfGuaranteeAction,
  recordFacilityMovementAction,
  returnLetterOfGuaranteeAction,
  upsertCovenantAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<FacilityStatus, Tone> = {
  active: "green",
  suspended: "amber",
  expired: "red",
  closed: "neutral",
};

const COVENANT_RESULT_TR: Record<string, string> = {
  compliant: "uyumlu",
  breached: "ihlal",
  waived: "muaf",
  not_tested: "ölçülmedi",
};

const COVENANT_STATUS_TR: Record<string, string> = {
  active: "aktif",
  inactive: "pasif",
  waived: "muaf",
  closed: "kapalı",
};

const MOVEMENT_TR: Record<string, string> = {
  drawdown: "kullanım (çekiş)",
  repayment: "geri ödeme",
  limit_revision: "limit revizyonu",
};

interface FacilityUtilizationRow {
  facility_id: string;
  facility_name: string;
  facility_type: string;
  currency: string;
  status: string;
  lender_name: string | null;
  limit_amount: string | number;
  drawn_amount: string | number;
  available_amount: string | number;
  utilization_ratio: string | number | null;
  over_limit: boolean;
  expiry_date: string | null;
  days_to_expiry: number | string | null;
  foreign_drawdown_count: number | string | null;
}

interface DebtMaturityLadderRow {
  bucket_label: string;
  installment_due: string | number;
  installment_count: number;
  facility_drawn_expiring: string | number;
  facility_limit_expiring: string | number;
  facility_count: number;
  total_cash_exposure: string | number;
}

interface CollateralRow {
  id: string;
  collateral_type: string;
  description: string | null;
  value_amount: string | number | null;
  currency: string;
  valuation_date: string | null;
  valuation_source: string | null;
  subject_name: string | null;
  released_at: string | Date | null;
}

interface CovenantRow {
  id: string;
  covenant_type: string;
  description: string;
  comparison: string;
  threshold_value: string | number;
  status: string;
  test_frequency: string | null;
  last_test_date: string | null;
  last_test_value: string | number | null;
  last_test_result: string | null;
  subject_name: string | null;
}

interface FacilityMovementRow {
  id: string;
  facility_name: string;
  movement_type: string;
  movement_date: string;
  amount: string | number;
  currency: string;
  notes: string | null;
}

interface IdNameRow {
  id: string;
  name: string;
}

interface CashAccountRow {
  id: string;
  name: string;
  currency: string;
  account_type: string;
}

const fieldCls = "field-control px-2.5 py-1.5 text-xs";

export default async function FacilitiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/facilities");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const session = await getRequestUser();
  const canWrite = session ? can(session.role, "credit_facilities", "insert") : false;
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentMonthIso = todayIso.slice(0, 7);

  const pool = getPool();
  const safeQuery = <R extends QueryResultRow>(sql: string): Promise<{ rows: R[]; rowCount: number }> =>
    pool.query<R>(sql).then(
      (res) => ({ rows: res.rows, rowCount: res.rowCount ?? res.rows.length }),
      (err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      },
    );

  const [
    facilities,
    ladder,
    collateral,
    covenants,
    movements,
    lenders,
    loans,
    cashAccounts,
    dscrRadar,
    accrualsAndGuarantees,
  ] = await Promise.all([
    pool
      .query<FacilityUtilizationRow>(
        `select facility_id, facility_name, facility_type, currency, status, lender_name,
                limit_amount, drawn_amount, available_amount, utilization_ratio, over_limit,
                to_char(expiry_date,'YYYY-MM-DD') as expiry_date, days_to_expiry,
                foreign_drawdown_count
           from public.credit_facility_utilization
          order by status, expiry_date nulls last, facility_name`,
      )
      .then(
        (res): { rows: FacilityUtilizationRow[]; rowCount: number } => ({
          rows: res.rows,
          rowCount: res.rowCount ?? res.rows.length,
        }),
        (
          err: unknown,
        ):
          | Promise<{ rows: FacilityUtilizationRow[]; rowCount: number }>
          | { rows: FacilityUtilizationRow[]; rowCount: number } => {
          const code = (err as { code?: string } | null)?.code;
          if (code === "42703") {
            return safeQuery<FacilityUtilizationRow>(
              `select facility_id, facility_name, facility_type, currency, status, lender_name,
                      limit_amount, drawn_amount, available_amount, utilization_ratio, over_limit,
                      to_char(expiry_date,'YYYY-MM-DD') as expiry_date, days_to_expiry,
                      0::int as foreign_drawdown_count
                 from public.credit_facility_utilization
                order by status, expiry_date nulls last, facility_name`,
            );
          }
          if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
          throw err;
        },
      ),
    safeQuery<DebtMaturityLadderRow>(
      `select bucket_label, installment_due, installment_count, facility_drawn_expiring,
              facility_limit_expiring, facility_count, total_cash_exposure
         from public.debt_maturity_ladder order by sort_order`,
    ),
    safeQuery<CollateralRow>(
      `select c.id, c.collateral_type, c.description, c.value_amount, c.currency,
              to_char(c.valuation_date,'YYYY-MM-DD') as valuation_date, c.valuation_source,
              coalesce(l.name, f.name) as subject_name, c.released_at
         from public.collateral_records c
         left join public.loans l on l.id = c.loan_id
         left join public.credit_facilities f on f.id = c.facility_id
        order by c.created_at desc limit 50`,
    ),
    safeQuery<CovenantRow>(
      `select v.id, v.covenant_type, v.description, v.comparison, v.threshold_value, v.status,
              v.test_frequency,
              to_char(v.last_test_date,'YYYY-MM-DD') as last_test_date,
              v.last_test_value, v.last_test_result,
              coalesce(l.name, f.name) as subject_name
         from public.covenant_records v
         left join public.loans l on l.id = v.loan_id
         left join public.credit_facilities f on f.id = v.facility_id
        order by v.status, v.covenant_type limit 50`,
    ),
    safeQuery<FacilityMovementRow>(
      `select m.id, f.name as facility_name, m.movement_type,
              to_char(m.movement_date,'YYYY-MM-DD') as movement_date,
              m.amount, m.currency, m.notes
         from public.facility_movements m
         join public.credit_facilities f on f.id = m.facility_id
        order by m.movement_date desc, m.created_at desc
        limit 25`,
    ),
    safeQuery<IdNameRow>(
      `select id, name from public.parties
        where is_active and party_type in ('lender', 'bank', 'vendor', 'company', 'other')
        order by name limit 200`,
    ),
    safeQuery<IdNameRow>(
      `select id, name from public.loans where archived_at is null and status = 'active' order by name limit 100`,
    ),
    safeQuery<CashAccountRow>(
      `select id::text as id, name, currency, account_type
         from public.cash_accounts
        where is_active = true
        order by name asc`,
    ),
    loadCovenantAndDscrRadar(pool, { asOfDate: todayIso, currency: "TRY" }),
    loadFacilityAccrualsAndGuarantees(pool),
  ]);

  const { accruals, guarantees } = accrualsAndGuarantees;
  const active = facilities.rows.filter((f) => f.status === "active");
  const activeTry = active.filter((f) => isReportingCurrency(f.currency));
  const foreignActive = active.length - activeTry.length;
  const totalLimit = activeTry.reduce((s, f) => s + Number(f.limit_amount ?? 0), 0);
  const totalDrawn = activeTry.reduce((s, f) => s + Number(f.drawn_amount ?? 0), 0);
  const totalAvailable = activeTry.reduce((s, f) => s + Number(f.available_amount ?? 0), 0);
  const mismatchedDrawdowns = facilities.rows.reduce((s, f) => s + Number(f.foreign_drawdown_count ?? 0), 0);
  const breached = covenants.rows.filter((c) => c.last_test_result === "breached");
  const activeGuarantees = guarantees.filter((g) => g.isActive);
  const expiringSoon = facilities.rows.filter(
    (f) =>
      f.days_to_expiry != null &&
      Number(f.days_to_expiry) >= 0 &&
      Number(f.days_to_expiry) <= 90 &&
      f.status === "active",
  );

  const subjectOptions = [
    ...facilities.rows.map((f) => ({
      value: `facility:${f.facility_id as string}`,
      label: `Limit: ${f.facility_name as string} (${f.currency as string})`,
    })),
    ...loans.rows.map((l) => ({
      value: `loan:${l.id as string}`,
      label: `Kredi: ${l.name as string}`,
    })),
  ];

  const detailsBoxStyle = {
    borderColor: "var(--line)",
    background: "var(--surface-2)",
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Kredi Limitleri, BCH Adat & Teminat Mektupları"
        subtitle="Rotatif/BCH limitleri, 102 ↔ 300 çekiş/geri ödemeler, günlük adat faiz tahakkuku (780/300), 910/911 nazım teminat mektupları ve kovenantlar"
        meta={
          <Badge tone={breached.length > 0 ? "red" : "green"} dot>
            {breached.length > 0 ? `${breached.length} kovenant ihlali` : "kovenant ihlali yok"}
          </Badge>
        }
      />

      {sp.error ? (
        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "color-mix(in oklab, var(--neg) 35%, var(--line))",
            background: "var(--neg-soft)",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div
          className="rounded border px-3 py-2 text-xs"
          style={{
            borderColor: "color-mix(in oklab, var(--pos) 35%, var(--line))",
            background: "var(--pos-soft)",
            color: "var(--pos)",
          }}
        >
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyStat
          label="Toplam limit (aktif, TRY)"
          value={fmtTL(totalLimit)}
          tone="info"
          sub={foreignActive > 0 ? `${foreignActive} limit TRY-dışı — tabloda ayrı dövizli` : undefined}
        />
        <KeyStat
          label="Kullanılan"
          value={fmtTL(totalDrawn)}
          tone={totalDrawn > 0 ? "warn" : "neutral"}
          sub={
            mismatchedDrawdowns > 0
              ? `${mismatchedDrawdowns} çekiş limitin para biriminden farklı`
              : undefined
          }
        />
        <KeyStat label="Kullanılabilir" value={fmtTL(totalAvailable)} tone="pos" />
        <KeyStat
          label="Aktif Teminat Mektubu"
          value={activeGuarantees.length}
          tone="info"
          sub="910 / 911 nazım hesap"
        />
        <KeyStat
          label="90 günde vadesi dolan"
          value={expiringSoon.length}
          tone={expiringSoon.length > 0 ? "warn" : "pos"}
        />
      </div>

      <Panel
        title="NAKİT DSCR & CFADS KÖPRÜSÜ VE KOVENANT ERKEN UYARI RADARI"
        subtitle="DSCR = CFADS / (Anapara + Faiz + BSMV + KKDF) · %10 erken uyarı tamponu · Net Borç / Yönetim EBITDA"
        right={
          <Badge
            tone={dscrRadar.breachedCount > 0 ? "red" : dscrRadar.warningCount > 0 ? "amber" : "green"}
            dot
          >
            {dscrRadar.breachedCount > 0
              ? `${dscrRadar.breachedCount} ihlal`
              : dscrRadar.warningCount > 0
                ? `${dscrRadar.warningCount} erken uyarı (%10 tampon)`
                : "kovenantlar güvenli"}
          </Badge>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <KeyStat
            label="Son 3 Ay Nakit DSCR"
            value={
              dscrRadar.dscrWindows.trailing3m.dscr == null
                ? "—"
                : `${dscrRadar.dscrWindows.trailing3m.dscr.toFixed(2)}x`
            }
            sub={`CFADS: ${fmtTL(dscrRadar.dscrWindows.trailing3m.cfads)} · Borç Servisi: ${fmtTL(dscrRadar.dscrWindows.trailing3m.totalDebtService)}`}
            tone={
              dscrRadar.dscrWindows.trailing3m.dscr == null
                ? "neutral"
                : dscrRadar.dscrWindows.trailing3m.dscr < 1.2
                  ? "neg"
                  : "pos"
            }
          />
          <KeyStat
            label="Gelecek 3 Ay Nakit DSCR"
            value={
              dscrRadar.dscrWindows.forward3m.dscr == null
                ? "—"
                : `${dscrRadar.dscrWindows.forward3m.dscr.toFixed(2)}x`
            }
            sub={`CFADS: ${fmtTL(dscrRadar.dscrWindows.forward3m.cfads)} · Borç Servisi: ${fmtTL(dscrRadar.dscrWindows.forward3m.totalDebtService)}`}
            tone={
              dscrRadar.dscrWindows.forward3m.dscr == null
                ? "neutral"
                : dscrRadar.dscrWindows.forward3m.dscr < 1.2
                  ? "neg"
                  : "pos"
            }
          />
          <KeyStat
            label="Gelecek 12 Ay Nakit DSCR"
            value={
              dscrRadar.dscrWindows.forward12m.dscr == null
                ? "—"
                : `${dscrRadar.dscrWindows.forward12m.dscr.toFixed(2)}x`
            }
            sub={`CFADS: ${fmtTL(dscrRadar.dscrWindows.forward12m.cfads)} · Borç Servisi: ${fmtTL(dscrRadar.dscrWindows.forward12m.totalDebtService)}`}
            tone={
              dscrRadar.dscrWindows.forward12m.dscr == null
                ? "neutral"
                : dscrRadar.dscrWindows.forward12m.dscr < 1.2
                  ? "neg"
                  : "pos"
            }
          />
          <KeyStat
            label="Net Borç / Yönetim EBITDA"
            value={dscrRadar.netDebtToEbitda == null ? "—" : `${dscrRadar.netDebtToEbitda.toFixed(2)}x`}
            sub={`Net Borç: ${dscrRadar.netDebt == null ? "—" : fmtTL(dscrRadar.netDebt)} · EBITDA: ${dscrRadar.managementEbitda == null ? "—" : fmtTL(dscrRadar.managementEbitda)}`}
            tone={
              dscrRadar.netDebtToEbitda == null
                ? "neutral"
                : dscrRadar.netDebtToEbitda > 3.5
                  ? "neg"
                  : "pos"
            }
          />
        </div>
      </Panel>

      {canWrite ? (
        <Panel
          title="LİMİT, BANKA KULLANIMI (102↔300), BCH ADAT, TEMİNAT MEKTUBU VE KOVENANT İŞLEMLERİ"
          subtitle="Kullanım/geri ödemeler drawn_amount değerini atomik günceller; banka hesabı seçildiğinde 102 ↔ 300 yevmiye fişi ve banka hareketi üretir."
        >
          <div className="grid gap-3 lg:grid-cols-2">
            <details className="rounded border p-3" style={detailsBoxStyle} open={facilities.rows.length === 0}>
              <summary className="cursor-pointer text-xs font-semibold text-tone-1">
                + Yeni Kredi Limiti Tanımla
              </summary>
              <form action={createFacilityAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <input
                  name="name"
                  required
                  placeholder="Limit adı (ör. Garanti BBVA Rotatif BCH)"
                  className={`col-span-2 ${fieldCls}`}
                />
                <select name="facilityType" className={fieldCls}>
                  {FACILITY_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {FACILITY_TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <select name="lenderPartyId" className={fieldCls}>
                  <option value="">Banka / Finansör seç (opsiyonel)</option>
                  {lenders.rows.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  name="limitAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  required
                  placeholder="Toplam kredi limiti"
                  className={`${fieldCls} font-mono`}
                />
                <select name="currency" className={fieldCls}>
                  <option value="TRY">TRY</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                </select>
                <input
                  name="interestRate"
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="Yıllık faiz oranı % (opsiyonel)"
                  className={`${fieldCls} font-mono`}
                />
                <input name="expiryDate" type="date" placeholder="Vade bitiş tarihi" className={fieldCls} />
                <button type="submit" className="button-accent col-span-2 px-3 py-1.5 text-xs font-medium">
                  Kredi limitini kaydet
                </button>
              </form>
            </details>

            {facilities.rows.length > 0 ? (
              <details className="rounded border p-3" style={detailsBoxStyle}>
                <summary className="cursor-pointer text-xs font-semibold text-tone-1">
                  + Kullanım (Drawdown 102/300) / Geri Ödeme (300/102) / Limit Revizyonu
                </summary>
                <form action={recordFacilityMovementAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <select name="facilityId" required className={`col-span-2 ${fieldCls}`}>
                    {facilities.rows.map((f) => (
                      <option key={f.facility_id} value={f.facility_id}>
                        {f.facility_name} ({formatMoney(f.drawn_amount, f.currency)} /{" "}
                        {formatMoney(f.limit_amount, f.currency)})
                      </option>
                    ))}
                  </select>
                  <select name="movementType" className={fieldCls}>
                    <option value="drawdown">Kullanım / Çekiş (drawdown)</option>
                    <option value="repayment">Geri Ödeme (repayment)</option>
                    <option value="limit_revision">Limit Revizyonu (limit_revision)</option>
                  </select>
                  <input
                    name="movementDate"
                    type="date"
                    defaultValue={todayIso}
                    required
                    className={fieldCls}
                  />
                  <input
                    name="amount"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="Tutar"
                    className={`${fieldCls} font-mono`}
                  />
                  <select name="currency" className={fieldCls}>
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                    <option value="GBP">GBP</option>
                  </select>
                  <select name="cashAccountId" defaultValue="" className={`col-span-2 ${fieldCls}`}>
                    <option value="">— Banka hesabı seç (seçilirse 102 ↔ 300 fişi + banka hareketi üretir) —</option>
                    {cashAccounts.rows.map((ca) => (
                      <option key={ca.id} value={ca.id}>
                        {ca.name} · {ca.currency} ({ca.account_type})
                      </option>
                    ))}
                  </select>
                  <input
                    name="notes"
                    placeholder="Dekont / açıklama (opsiyonel)"
                    className={`col-span-2 ${fieldCls}`}
                  />
                  <button type="submit" className="button-accent col-span-2 px-3 py-1.5 text-xs font-medium">
                    Hareketi kaydet
                  </button>
                </form>
              </details>
            ) : null}

            {facilities.rows.length > 0 ? (
              <details className="rounded border p-3" style={detailsBoxStyle}>
                <summary className="cursor-pointer text-xs font-semibold text-tone-1">
                  + BCH / Rotatif Kredi Günlük Adat Faiz & BSMV Tahakkuku (780 / 300)
                </summary>
                <form action={accrueFacilityInterestAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <select name="facilityId" required className={`col-span-2 ${fieldCls}`}>
                    {facilities.rows.map((f) => (
                      <option key={f.facility_id} value={f.facility_id}>
                        {f.facility_name} ({f.currency})
                      </option>
                    ))}
                  </select>
                  <input
                    name="accrualMonth"
                    type="month"
                    defaultValue={currentMonthIso}
                    required
                    className={fieldCls}
                  />
                  <input
                    name="daysInPeriod"
                    type="number"
                    min="1"
                    max="31"
                    defaultValue="30"
                    required
                    placeholder="Gün sayısı (ör. 30)"
                    className={`${fieldCls} font-mono`}
                  />
                  <input
                    name="averageUtilizedBalance"
                    type="number"
                    step="0.01"
                    min="0.01"
                    required
                    placeholder="Ortalama kullanılan bakiye"
                    className={`${fieldCls} font-mono`}
                  />
                  <input
                    name="annualRatePct"
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    defaultValue="52.00"
                    placeholder="Yıllık faiz %"
                    className={`${fieldCls} font-mono`}
                  />
                  <input
                    name="bsmvRate"
                    type="number"
                    step="0.005"
                    min="0"
                    defaultValue="0.05"
                    placeholder="BSMV oranı (0.05)"
                    className={`${fieldCls} font-mono`}
                  />
                  <input
                    name="kkdfRate"
                    type="number"
                    step="0.005"
                    min="0"
                    defaultValue="0"
                    placeholder="KKDF oranı (0)"
                    className={`${fieldCls} font-mono`}
                  />
                  <button type="submit" className="button-accent col-span-2 px-3 py-1.5 text-xs font-medium">
                    Adat Faiz & BSMV Tahakkuk Fişi Üret (780 / 300)
                  </button>
                </form>
              </details>
            ) : null}

            <details className="rounded border p-3" style={detailsBoxStyle}>
              <summary className="cursor-pointer text-xs font-semibold text-tone-1">
                + Verilen Teminat Mektubu Kaydet (910 / 911 Nazım & Çeyreklik Komisyon)
              </summary>
              <form action={createLetterOfGuaranteeAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <select name="facilityId" defaultValue="" className={fieldCls}>
                  <option value="">— Bağlı gayrinakdi kredi limiti (opsiyonel) —</option>
                  {facilities.rows.map((f) => (
                    <option key={f.facility_id} value={f.facility_id}>
                      {f.facility_name} ({f.currency})
                    </option>
                  ))}
                </select>
                <select name="guaranteeType" defaultValue="kesin" className={fieldCls}>
                  {GUARANTEE_TYPES.map((gt) => (
                    <option key={gt} value={gt}>
                      {GUARANTEE_TYPE_LABELS[gt]}
                    </option>
                  ))}
                </select>
                <input
                  name="beneficiaryName"
                  required
                  placeholder="Muhatap kurum / şirket (ör. TEDAŞ / BOTAŞ)"
                  className={fieldCls}
                />
                <input
                  name="referenceNo"
                  required
                  placeholder="Mektup referans no (ör. TM-2026-1094)"
                  className={`${fieldCls} font-mono`}
                />
                <input
                  name="amount"
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="Mektup tutarı"
                  className={`${fieldCls} font-mono`}
                />
                <select name="currency" defaultValue="TRY" className={fieldCls}>
                  <option value="TRY">TRY</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                </select>
                <input
                  name="commissionRateAnnual"
                  type="number"
                  step="0.001"
                  min="0"
                  defaultValue="0.015"
                  placeholder="Yıllık komisyon (ör. 0.015 = %1,5)"
                  className={`${fieldCls} font-mono`}
                />
                <input name="issueDate" type="date" defaultValue={todayIso} required className={fieldCls} />
                <input
                  name="expiryDate"
                  type="date"
                  placeholder="Vade tarihi (süresiz ise boş)"
                  className={`col-span-2 ${fieldCls}`}
                />
                <button type="submit" className="button-accent col-span-2 px-3 py-1.5 text-xs font-medium">
                  Teminat Mektubunu ve 910/911 Nazım Fişini Kaydet
                </button>
              </form>
            </details>

            {subjectOptions.length > 0 ? (
              <details className="rounded border p-3" style={detailsBoxStyle}>
                <summary className="cursor-pointer text-xs font-semibold text-tone-1">
                  + Teminat Ekle (İpotek / Rehin / Kefalet / Blokaj)
                </summary>
                <form action={addCollateralAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <select name="subject" required className={`col-span-2 ${fieldCls}`}>
                    {subjectOptions.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select name="collateralType" className={fieldCls}>
                    {COLLATERAL_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {COLLATERAL_TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <select name="valuationSource" className={fieldCls}>
                    <option value="">Değerleme kaynağı (opsiyonel)</option>
                    <option value="bank">Banka ekspertizi</option>
                    <option value="independent">Bağımsız değerleme</option>
                    <option value="internal">Şirket içi</option>
                  </select>
                  <input
                    name="valueAmount"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Değerleme tutarı (boş = değerlenmedi)"
                    className={`${fieldCls} font-mono`}
                  />
                  <select name="currency" className={fieldCls}>
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                  <input name="valuationDate" type="date" className={fieldCls} />
                  <input name="description" placeholder="Teminat tanımı" className={fieldCls} />
                  <button type="submit" className="button-ghost col-span-2 px-3 py-1.5 text-xs font-medium">
                    Teminatı kaydet
                  </button>
                </form>
              </details>
            ) : null}

            {subjectOptions.length > 0 ? (
              <details className="rounded border p-3" style={detailsBoxStyle}>
                <summary className="cursor-pointer text-xs font-semibold text-tone-1">
                  + Kovenant Maddesi ve Ölçüm Ekle / Güncelle
                </summary>
                <form action={upsertCovenantAction} className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <select name="covenantId" className={`col-span-2 ${fieldCls}`}>
                    <option value="">— Yeni kovenant oluştur —</option>
                    {covenants.rows.map((c) => (
                      <option key={c.id} value={c.id}>
                        Güncelle: {c.description} ({c.subject_name ?? "—"})
                      </option>
                    ))}
                  </select>
                  <select name="subject" className={`col-span-2 ${fieldCls}`}>
                    {subjectOptions.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <select name="covenantType" className={fieldCls}>
                    {COVENANT_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <input
                    name="description"
                    required
                    placeholder="Kovenant açıklaması (ör. DSCR >= 1.20)"
                    className={fieldCls}
                  />
                  <select name="comparison" className={fieldCls}>
                    <option value="gte">&gt;= (en az)</option>
                    <option value="lte">&lt;= (en çok)</option>
                    <option value="gt">&gt; (büyük)</option>
                    <option value="lt">&lt; (küçük)</option>
                  </select>
                  <input
                    name="thresholdValue"
                    type="number"
                    step="0.0001"
                    required
                    placeholder="Eşik değeri (ör. 1.20)"
                    className={`${fieldCls} font-mono`}
                  />
                  <input name="lastTestDate" type="date" placeholder="Ölçüm tarihi (opsiyonel)" className={fieldCls} />
                  <input
                    name="lastTestValue"
                    type="number"
                    step="0.0001"
                    placeholder="Son ölçüm değeri (opsiyonel)"
                    className={`${fieldCls} font-mono`}
                  />
                  <button type="submit" className="button-ghost col-span-2 px-3 py-1.5 text-xs font-medium">
                    Kovenantı kaydet
                  </button>
                </form>
              </details>
            ) : null}
          </div>
        </Panel>
      ) : null}

      <Panel title="KREDİ LİMİTLERİ" subtitle="limit / kullanılan / kullanılabilir">
        {facilities.rows.length === 0 ? (
          <EmptyState>Kayıtlı kredi limiti yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Limit adı</th>
                  <th>Tür</th>
                  <th>Banka</th>
                  <th className="text-right">Limit</th>
                  <th className="text-right">Kullanılan</th>
                  <th className="text-right">Kullanılabilir</th>
                  <th className="text-right">Doluluk</th>
                  <th>Vade</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {facilities.rows.map((f) => (
                  <tr key={f.facility_id} className="border-t border-line">
                    <td className="py-2 font-medium text-tone-1">{f.facility_name}</td>
                    <td className="text-xs text-tone-2">
                      {FACILITY_TYPE_LABEL[f.facility_type as FacilityType] ?? f.facility_type}
                    </td>
                    <td className="text-xs text-tone-3">{f.lender_name ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">{formatMoney(f.limit_amount, f.currency)}</td>
                    <td className="text-right font-mono tabular-nums">{formatMoney(f.drawn_amount, f.currency)}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(f.available_amount, f.currency)}
                    </td>
                    <td className="text-right tabular-nums">
                      {f.utilization_ratio == null ? "—" : `%${(Number(f.utilization_ratio) * 100).toFixed(1)}`}
                      {f.over_limit ? <span className="ml-1 text-neg">aşım</span> : null}
                    </td>
                    <td className="text-xs tabular-nums">
                      {f.expiry_date ?? "—"}
                      {f.days_to_expiry != null &&
                      Number(f.days_to_expiry) >= 0 &&
                      Number(f.days_to_expiry) <= 90 ? (
                        <span className="block text-warn">{f.days_to_expiry} gün</span>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[f.status as FacilityStatus] ?? "neutral"}>
                        {FACILITY_STATUS_LABEL[f.status as FacilityStatus] ?? f.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="BCH / ROTATİF ADAT FAİZ TAHAKKUKLARI (780 / 300)"
          subtitle="Dönem içi ortalama kullanılan bakiye × gün × (faiz/360) + BSMV/KKDF"
        >
          {accruals.length === 0 ? (
            <EmptyState>Henüz BCH / rotatif adat faiz tahakkuku kaydı yok.</EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left uppercase text-tone-3">
                    <th className="py-1">Dönem</th>
                    <th>Limit</th>
                    <th className="text-right">Ort. Bakiye</th>
                    <th className="text-right">Faiz + BSMV</th>
                    <th className="text-right">Toplam (780)</th>
                  </tr>
                </thead>
                <tbody>
                  {accruals.map((a) => (
                    <tr key={a.id} className="border-t border-line">
                      <td className="py-1.5 font-mono">{a.accrualMonth}</td>
                      <td>{a.facilityName}</td>
                      <td className="text-right font-mono tabular-nums">
                        {formatMoney(a.averageUtilizedBalance, a.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-tone-2">
                        {formatMoney(a.interestAmount + a.bsmvAmount + a.kkdfAmount, a.currency)}
                      </td>
                      <td className="text-right font-mono font-semibold tabular-nums">
                        {formatMoney(a.totalCharge, a.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </Panel>

        <Panel
          title="TEMİNAT MEKTUPLARI (910 / 911 NAZIM HESAPLAR)"
          subtitle="Gayrinakdi kredi kullanımı, çeyreklik komisyon yükü ve mektup iade kapanışı"
        >
          {guarantees.length === 0 ? (
            <EmptyState>Kayıtlı teminat mektubu yok.</EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left uppercase text-tone-3">
                    <th className="py-1">Ref / Muhatap</th>
                    <th>Tür</th>
                    <th className="text-right">Tutar</th>
                    <th className="text-right">3 Aylık Kom.</th>
                    <th>Durum / İade</th>
                  </tr>
                </thead>
                <tbody>
                  {guarantees.map((g) => (
                    <tr key={g.id} className="border-t border-line">
                      <td className="py-1.5">
                        <span className="font-mono font-medium">{g.referenceNo}</span>
                        <span className="block text-[11px] text-tone-3">{g.beneficiaryName}</span>
                      </td>
                      <td>{GUARANTEE_TYPE_LABELS[g.guaranteeType] ?? g.guaranteeType}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(g.amount, g.currency)}</td>
                      <td className="text-right font-mono tabular-nums text-tone-2">
                        {formatMoney(g.quarterlyCommissionAmount, g.currency)}
                      </td>
                      <td>
                        {g.isActive ? (
                          <div className="flex items-center gap-1.5">
                            <Badge tone="green">aktif</Badge>
                            {canWrite ? (
                              <form action={returnLetterOfGuaranteeAction} className="inline">
                                <input type="hidden" name="guaranteeId" value={g.id} />
                                <input type="hidden" name="returnedDate" value={todayIso} />
                                <button type="submit" className="button-ghost px-2 py-0.5 text-[11px]">
                                  İade Et
                                </button>
                              </form>
                            ) : null}
                          </div>
                        ) : (
                          <Badge tone="neutral">iade ({g.returnedAt ?? "—"})</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </Panel>
      </div>

      {movements.rows.length > 0 ? (
        <Panel title="SON LİMİT HAREKETLERİ" subtitle="kullanım, geri ödeme ve limit revizyonları">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Tarih</th>
                  <th>Limit</th>
                  <th>Tür</th>
                  <th className="text-right">Tutar</th>
                  <th>Not</th>
                </tr>
              </thead>
              <tbody>
                {movements.rows.map((m) => (
                  <tr key={m.id} className="border-t border-line">
                    <td className="py-1.5 text-xs tabular-nums">{m.movement_date}</td>
                    <td className="text-xs">{m.facility_name}</td>
                    <td className="text-xs">{MOVEMENT_TR[m.movement_type] ?? m.movement_type}</td>
                    <td className="text-right font-mono tabular-nums">{formatMoney(m.amount, m.currency)}</td>
                    <td className="text-xs text-tone-3">{m.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel title="BORÇ VADE MERDİVENİ" subtitle="30 / 90 / 180 / 365 gün (TRY)">
        {ladder.rows.length === 0 ? (
          <EmptyState>Borç vade merdiveni kaydı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Vade aralığı</th>
                  <th className="text-right">Taksit</th>
                  <th className="text-right">Vadesi dolan limit (çekilen)</th>
                  <th className="text-right">Vadesi dolan limit (toplam)</th>
                  <th className="text-right">Nakit maruziyeti</th>
                </tr>
              </thead>
              <tbody>
                {ladder.rows.map((b) => (
                  <tr key={b.bucket_label} className="border-t border-line">
                    <td className="py-2">
                      {b.bucket_label}
                      <span className="block text-xs text-tone-3">
                        {b.installment_count} taksit · {b.facility_count} limit
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{fmtTL(Number(b.installment_due))}</td>
                    <td className="text-right tabular-nums">{fmtTL(Number(b.facility_drawn_expiring))}</td>
                    <td className="text-right tabular-nums text-tone-3">
                      {fmtTL(Number(b.facility_limit_expiring))}
                    </td>
                    <td className="text-right font-medium tabular-nums">
                      {fmtTL(Number(b.total_cash_exposure))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="TEMİNATLAR">
        {collateral.rows.length === 0 ? (
          <EmptyState>Kayıtlı teminat yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Tür</th>
                  <th>Konu</th>
                  <th className="text-right">Değer</th>
                  <th>Değerleme</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {collateral.rows.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-2">
                      {COLLATERAL_TYPE_LABEL[c.collateral_type as CollateralType] ?? c.collateral_type}
                      {c.description ? <span className="block text-xs text-tone-3">{c.description}</span> : null}
                    </td>
                    <td className="text-xs">{c.subject_name ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">
                      {c.value_amount == null ? (
                        <span className="text-warn">değerlenmedi</span>
                      ) : (
                        formatMoney(c.value_amount, c.currency)
                      )}
                    </td>
                    <td className="text-xs text-tone-3">
                      {c.valuation_date ?? "—"}
                      {c.valuation_source ? ` · ${c.valuation_source}` : ""}
                    </td>
                    <td>
                      <Badge tone={c.released_at ? "neutral" : "green"}>
                        {c.released_at ? "serbest" : "bağlı"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="KOVENANTLAR" subtitle="madde ve son ölçüm — ölçüm sonucu yaşam döngüsü değildir">
        {covenants.rows.length === 0 ? (
          <EmptyState>Kayıtlı kovenant yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Kovenant</th>
                  <th>Konu</th>
                  <th className="text-right">Eşik</th>
                  <th className="text-right">Son ölçüm</th>
                  <th>Sonuç</th>
                  <th>Madde durumu</th>
                </tr>
              </thead>
              <tbody>
                {covenants.rows.map((v) => (
                  <tr key={v.id} className="border-t border-line">
                    <td className="py-2">
                      {v.description}
                      <span className="block text-xs text-tone-3">{v.covenant_type}</span>
                    </td>
                    <td className="text-xs">{v.subject_name ?? "—"}</td>
                    <td className="text-right text-xs tabular-nums">
                      {v.comparison} {Number(v.threshold_value)}
                    </td>
                    <td className="text-right text-xs tabular-nums">
                      {v.last_test_value == null ? "—" : Number(v.last_test_value)}
                      {v.last_test_date ? <span className="block text-tone-3">{v.last_test_date}</span> : null}
                    </td>
                    <td>
                      {v.last_test_result == null ? (
                        <span className="text-xs text-tone-3">ölçülmedi</span>
                      ) : (
                        <Badge
                          tone={
                            v.last_test_result === "breached"
                              ? "red"
                              : v.last_test_result === "compliant"
                                ? "green"
                                : "neutral"
                          }
                        >
                          {COVENANT_RESULT_TR[v.last_test_result] ?? v.last_test_result}
                        </Badge>
                      )}
                    </td>
                    <td>
                      <Badge tone={v.status === "active" ? "green" : "neutral"}>
                        {COVENANT_STATUS_TR[v.status] ?? v.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </div>
  );
}
