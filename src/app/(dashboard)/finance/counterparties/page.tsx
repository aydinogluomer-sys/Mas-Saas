// Faz 19 & Faz 50 (D4) — Karşı taraflar (cari hesap), IBAN kasası ve organizasyonel boyutlar.

import Link from "@/components/ui/app-link";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import {
  COUNTERPARTY_SCORECARD_MODEL_CONSTANTS,
  COUNTERPARTY_TIER_LABEL,
  listDimension,
  loadAllActiveIbans,
  loadCounterpartyExposure,
  loadCounterpartyProfile,
  loadCounterpartyScorecards,
  loadPartyCandidates,
  loadUnifiedCounterpartyStatement,
  loadUnresolvedCounterparties,
  type CounterpartyBehavioralTier,
  type CounterpartyScorecard,
} from "@/lib/counterparties/engine";
import { assessExposure, suggestCounterparties } from "@/lib/counterparties/rules";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import {
  addIbanAction,
  createCounterpartyAction,
  createDimensionAction,
  deactivateIbanAction,
  linkCounterpartyAction,
  updateCounterpartyAction,
} from "./actions";

export const dynamic = "force-dynamic";

const BAND_TONE: Record<string, Tone> = {
  none: "neutral", low: "green", watch: "amber", high: "amber", over_limit: "red",
};
const BAND_LABEL: Record<string, string> = {
  none: "risk yok", low: "düşük", watch: "izle", high: "yoğunlaşma", over_limit: "limit aşımı",
};
const APPROVAL_TONE: Record<string, Tone> = {
  approved: "green",
  pending_approval: "amber",
  rejected: "red",
};
const APPROVAL_LABEL: Record<string, string> = {
  approved: "onaylı",
  pending_approval: "onay bekliyor",
  rejected: "reddedildi",
};
const TIER_TONE: Record<CounterpartyBehavioralTier, Tone> = {
  tier_a_reliable: "green",
  tier_b_watch: "blue",
  tier_c_strained: "amber",
  tier_d_critical: "red",
  insufficient_history: "neutral",
};

function fmtNativeAmount(amount: number, currency: string): string {
  const digits = Number.isInteger(amount) ? 0 : 2;
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  }).format(amount);
  return currency === "TRY" ? `${formatted} TL` : `${formatted} ${currency}`;
}

function fmtCurrencyBuckets(buckets: Record<string, number>, itemCount: number): string {
  const entries = Object.entries(buckets);
  if (entries.length === 0) {
    return itemCount > 0 ? `${itemCount} adet · TUTAR EKSİK` : "—";
  }
  return entries.map(([cur, amt]) => fmtNativeAmount(amt, cur)).join(" · ");
}

function fmtSignedDays(days: number): string {
  return days > 0 ? `+${days}g` : `${days}g`;
}

function renderDbtSummary(s: CounterpartyScorecard): string {
  if (
    s.settledInvoiceCount < COUNTERPARTY_SCORECARD_MODEL_CONSTANTS.minSettledInvoicesForDbt ||
    s.medianDbtDays === null ||
    s.p75DbtDays === null
  ) {
    return s.settledInvoiceCount > 0
      ? `— (yetersiz geçmiş · ${s.settledInvoiceCount} fatura)`
      : "— (yetersiz geçmiş)";
  }
  const lateSuffix = s.lateRatio !== null ? ` · %${Math.round(s.lateRatio * 100)} geç` : "";
  return `${fmtSignedDays(s.medianDbtDays)} / ${fmtSignedDays(s.p75DbtDays)} (${s.settledInvoiceCount}f${lateSuffix})`;
}

function renderPromiseSummary(s: CounterpartyScorecard): string {
  const closedCount = s.promiseKeptCount + s.promiseBrokenCount;
  if (closedCount === 0 || s.promiseKeptRatio === null) {
    return s.promisePendingCount > 0 ? `— (${s.promisePendingCount} açık)` : "—";
  }
  const ratioPct = Math.round(s.promiseKeptRatio * 100);
  const pendingSuffix = s.promisePendingCount > 0 ? ` (+${s.promisePendingCount} açık)` : "";
  return `${s.promiseKeptCount} / ${s.promiseBrokenCount} · %${ratioPct}${pendingSuffix}`;
}

export default async function CounterpartiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    warn?: string;
    result?: string;
    tab?: string;
    ledgerParty?: string;
  }>;
}) {
  const denied = await requireRouteAccess("/finance/counterparties");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";

  const sp = await searchParams;
  const tab = sp.tab === "active" ? "active" : "all";
  const pool = getPool();
  const [exposure, unresolved, candidates, activeIbans, projects, costCenters, departments, scorecards] = await Promise.all([
    loadCounterpartyExposure(pool, { withExposureOnly: false, limit: 200 }),
    loadUnresolvedCounterparties(pool, 50),
    loadPartyCandidates(pool),
    loadAllActiveIbans(pool, 100),
    listDimension(pool, "projects", 100),
    listDimension(pool, "cost_centers", 100),
    listDimension(pool, "departments", 100),
    loadCounterpartyScorecards(pool, { limit: 200 }),
  ]);

  const withExposure = exposure.filter((e) => e.itemCount > 0);
  const displayedParties = tab === "active" ? withExposure : exposure;

  const requestedLedgerParty =
    sp.ledgerParty && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.ledgerParty)
      ? sp.ledgerParty
      : null;
  const selectedLedgerPartyId =
    requestedLedgerParty ?? withExposure[0]?.partyId ?? candidates[0]?.id ?? null;
  const selectedLedgerPartyName =
    candidates.find((c) => c.id === selectedLedgerPartyId)?.name ??
    exposure.find((e) => e.partyId === selectedLedgerPartyId)?.partyName ??
    null;
  const [ledgerRows, selectedPartyProfile] = selectedLedgerPartyId
    ? await Promise.all([
        loadUnifiedCounterpartyStatement(pool, selectedLedgerPartyId, 250),
        loadCounterpartyProfile(pool, selectedLedgerPartyId),
      ])
    : [[], null];
  // `overCreditLimit === null` = limit TRY değil, karşılaştırılamadı — aşım sayılmaz, ayrı sayılır.
  const overLimit = withExposure.filter((e) => e.overCreditLimit === true).length;
  const limitNotComparable = withExposure.filter((e) => e.creditLimit != null && !e.creditLimitComparable).length;
  const foreignItems = withExposure.reduce((n, e) => n + e.foreignCurrencyCount, 0);

  const activeExposureIds = new Set(withExposure.map((e) => e.partyId));
  const displayedScorecards =
    tab === "active"
      ? scorecards.filter((s) => s.hasBehavioralSignal || activeExposureIds.has(s.partyId))
      : scorecards;

  const tierACount = scorecards.filter((s) => s.tier === "tier_a_reliable").length;
  const tierBCount = scorecards.filter((s) => s.tier === "tier_b_watch").length;
  const tierCCount = scorecards.filter((s) => s.tier === "tier_c_strained").length;
  const tierDCount = scorecards.filter((s) => s.tier === "tier_d_critical").length;
  const insufficientCount = scorecards.filter((s) => s.tier === "insufficient_history").length;
  const recourseRiskPartyCount = scorecards.filter(
    (s) => s.contingentRecourseCount > 0 || Object.keys(s.contingentRecourseByCurrency).length > 0,
  ).length;
  const M = COUNTERPARTY_SCORECARD_MODEL_CONSTANTS;

  const canInsertParty = can(role, "parties", "insert");
  const canUpdateParty = can(role, "parties", "update");
  const canInsertIban = can(role, "ibans", "insert");
  const canUpdateIban = can(role, "ibans", "update");
  const canInsertDimension = can(role, "cost_centers", "insert");

  return (
    <>
      <PageHeader
        title="Karşı taraflar (cari hesap)"
        subtitle="Risk yoğunlaşması, birleşik cari ekstre (fatura · tahsis · çek · banka), IBAN kasası ve organizasyonel boyutlar"
        meta={
          <Badge tone={overLimit > 0 ? "red" : unresolved.length > 0 ? "amber" : "green"} dot>
            {overLimit > 0 ? `${overLimit} limit aşımı` : `${unresolved.length} eşleşmemiş etiket`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.warn && <div className="mb-3 rounded border border-warn/40 bg-warn/10 p-2 text-sm text-warn">{sp.warn}</div>}
      {sp.result && (
        <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">
          {sp.result === "updated" ? "Cari hesap bilgileri ve profil güncellendi." : sp.result}
        </div>
      )}

      <Panel
        title={`CARİ VE RİSK YOĞUNLAŞMASI — ${displayedParties.length} karşı taraf`}
        right={
          <div className="flex items-center gap-1 text-xs">
            <Link
              href="/finance/counterparties?tab=all"
              className={`rounded border px-2 py-1 ${tab === "all" ? "border-line-strong bg-surface-2 font-semibold text-tone-1" : "border-line-faint text-tone-3 hover:bg-surface-2"}`}
            >
              Tümü ({exposure.length})
            </Link>
            <Link
              href="/finance/counterparties?tab=active"
              className={`rounded border px-2 py-1 ${tab === "active" ? "border-line-strong bg-surface-2 font-semibold text-tone-1" : "border-line-faint text-tone-3 hover:bg-surface-2"}`}
            >
              Aktif Hareketliler ({withExposure.length})
            </Link>
          </div>
        }
      >
        {(foreignItems > 0 || limitNotComparable > 0) && (
          <p className="mb-2 font-mono text-[11px] text-warn">
            {foreignItems > 0 && `${foreignItems} kalem TRY-dışı — toplamda yok. `}
            {limitNotComparable > 0 && `${limitNotComparable} karşı tarafın limiti TRY değil — limit aşımı hesaplanmadı.`}
          </p>
        )}
        {displayedParties.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">
            {tab === "active" ? "Açık kalem taşıyan karşı taraf yok." : "Henüz kayıtlı karşı taraf yok."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-tone-3">
                  <th>Karşı taraf</th><th>Tip</th>
                  <th className="text-right">Risk</th>
                  <th className="text-right">Pay</th>
                  <th className="text-right">Çek</th>
                  <th className="text-right">Taksit</th>
                  <th className="text-right">Ödeme</th>
                  <th className="text-right">Limit</th>
                  <th>Durum</th>
                  <th className="text-right">Ekstre</th>
                </tr>
              </thead>
              <tbody>
                {displayedParties.map((e) => {
                  const a = assessExposure({
                    totalExposure: e.totalExposure,
                    creditLimit: e.creditLimitComparable ? e.creditLimit : null,
                    exposureRatio: e.exposureRatio,
                    unknownAmountCount: e.unknownAmountCount,
                  });
                  return (
                    <tr key={e.partyId} className="border-t border-line-faint">
                      <td className="py-2">
                        {e.partyName}
                        {e.itemCount === 0 && (
                          <span className="ml-2 text-[10px] text-tone-3">hareketsiz</span>
                        )}
                        {e.unknownAmountCount > 0 && (
                          <span className="ml-2 text-[10px] text-warn">{e.unknownAmountCount} TUTAR EKSİK</span>
                        )}
                        {e.foreignCurrencyCount > 0 && (
                          <span className="ml-2 text-[10px] text-warn">{e.foreignCurrencyCount} TRY-DIŞI · TOPLAMDA YOK</span>
                        )}
                      </td>
                      <td className="text-tone-3">{e.partyType}</td>
                      <td className="text-right font-mono tabular-nums">{fmtTL(e.totalExposure)}</td>
                      <td className="text-right tabular-nums">
                        {e.exposureRatio == null ? "—" : `%${(e.exposureRatio * 100).toFixed(1)}`}
                      </td>
                      <td className="text-right tabular-nums">{e.checkCount || "—"}</td>
                      <td className="text-right tabular-nums">{e.loanInstallmentCount || "—"}</td>
                      <td className="text-right tabular-nums">{e.paymentCount || "—"}</td>
                      <td className="text-right font-mono tabular-nums">
                        {e.creditLimit == null
                          ? "—"
                          : e.creditLimitComparable
                            ? fmtTL(e.creditLimit)
                            : <span title="Limit TRY değil; TRY maruziyetle karşılaştırılamaz">{`${e.creditLimit} ${e.creditLimitCurrency ?? ""} · kıyaslanamaz`}</span>}
                      </td>
                      <td>
                        <Badge tone={BAND_TONE[a.band] ?? "neutral"}>{BAND_LABEL[a.band] ?? a.band}</Badge>
                      </td>
                      <td className="text-right font-mono text-xs">
                        <Link
                          href={`/finance/counterparties?tab=${tab}&ledgerParty=${e.partyId}#cari-ekstre`}
                          className="hover:underline"
                          style={{
                            color: e.partyId === selectedLedgerPartyId ? "var(--text-1)" : "var(--text-2)",
                            fontWeight: e.partyId === selectedLedgerPartyId ? 600 : 400,
                          }}
                        >
                          {e.partyId === selectedLedgerPartyId ? "Seçili" : "Ekstre →"}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div id="cari-ekstre" className="mt-4">
        <Panel
          title={`BİRLEŞİK CARİ HESAP EKSTRESİ (FATURA · TAHSİS · ÇEK · BANKA)${selectedLedgerPartyName ? ` — ${selectedLedgerPartyName}` : ""}`}
          subtitle="Seçili karşı tarafın fatura, tahsis, çek/ciro ve IBAN-eşleşen banka hareketleri kronolojik sırada listelenir; yürüyen bakiye her döviz için kendi para biriminde korunur"
          right={
            candidates.length > 0 ? (
              <form method="get" action="/finance/counterparties" className="flex items-center gap-1.5 text-xs">
                <input type="hidden" name="tab" value={tab} />
                <select
                  name="ledgerParty"
                  defaultValue={selectedLedgerPartyId ?? ""}
                  className="field-control px-2 py-1 text-xs"
                >
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="button-ghost px-2.5 py-1 text-xs font-medium"
                >
                  Ekstreyi Göster
                </button>
              </form>
            ) : undefined
          }
        >
          {canUpdateParty && selectedPartyProfile ? (
            <details className="mb-3 rounded border border-line bg-surface-2 p-2.5">
              <summary className="cursor-pointer font-mono text-xs font-semibold text-tone-1">
                ✎ Seçili Cari Kartı ve Kredi Limitini Güncelle ({selectedPartyProfile.name})
              </summary>
              <form action={updateCounterpartyAction} className="mt-2.5 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
                <input type="hidden" name="partyId" value={selectedPartyProfile.partyId} />
                <label className="flex flex-col gap-0.5 sm:col-span-2">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Ticari Ünvan</span>
                  <input name="name" required defaultValue={selectedPartyProfile.name} className="field-control px-2 py-1 text-xs" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Cari Tipi</span>
                  <select name="partyType" defaultValue={selectedPartyProfile.partyType} className="field-control px-2 py-1 text-xs">
                    {["vendor", "customer", "bank", "company", "person", "provider", "internal_owner", "unknown"].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Durum</span>
                  <select name="isActive" defaultValue={selectedPartyProfile.isActive ? "true" : "false"} className="field-control px-2 py-1 text-xs">
                    <option value="true">Aktif</option>
                    <option value="false">Pasif</option>
                  </select>
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">VKN / TCKN</span>
                  <input name="taxNumber" defaultValue={selectedPartyProfile.taxNumber ?? ""} placeholder="Vergi no" className="field-control px-2 py-1 font-mono text-xs" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Vergi Dairesi</span>
                  <input name="taxOffice" defaultValue={selectedPartyProfile.taxOffice ?? ""} placeholder="Vergi dairesi" className="field-control px-2 py-1 text-xs" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Kredi Limiti (TL)</span>
                  <input name="creditLimit" type="number" step="0.01" min="0" defaultValue={selectedPartyProfile.creditLimit ?? ""} className="field-control px-2 py-1 font-mono text-xs tabular-nums" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Vade (Gün)</span>
                  <input name="paymentTermsDays" type="number" min="0" defaultValue={selectedPartyProfile.paymentTermsDays ?? ""} className="field-control px-2 py-1 font-mono text-xs tabular-nums" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Şehir</span>
                  <input name="city" defaultValue={selectedPartyProfile.city ?? ""} className="field-control px-2 py-1 text-xs" />
                </label>
                <label className="flex flex-col gap-0.5 sm:col-span-2">
                  <span className="font-mono text-[10px] uppercase text-tone-3">Adres</span>
                  <input name="addressLine" defaultValue={selectedPartyProfile.addressLine ?? ""} className="field-control px-2 py-1 text-xs" />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="font-mono text-[10px] uppercase text-tone-3">İletişim E-Posta</span>
                  <input name="contactEmail" defaultValue={selectedPartyProfile.contactEmail ?? ""} className="field-control px-2 py-1 text-xs" />
                </label>
                <div className="sm:col-span-4">
                  <button type="submit" className="button-primary px-3 py-1.5 text-xs">
                    Cari Bilgilerini Kaydet
                  </button>
                </div>
              </form>
            </details>
          ) : null}

          {!selectedLedgerPartyId ? (
            <p className="py-2 text-sm text-tone-2">
              Ekstresini görüntülemek için bir karşı taraf seçin.
            </p>
          ) : ledgerRows.length === 0 ? (
            <p className="py-2 text-sm text-tone-2">
              Seçili karşı taraf için henüz fatura, tahsis, çek veya banka hareketi bulunmuyor.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-tone-2">
                    <th className="py-1.5 pr-2">Tarih</th>
                    <th className="py-1.5 pr-2">Hareket Türü</th>
                    <th className="py-1.5 pr-2">Referans</th>
                    <th className="py-1.5 pr-2">Yön</th>
                    <th className="py-1.5 pr-2">Döviz</th>
                    <th className="py-1.5 pr-2 text-right">Borç (Debit)</th>
                    <th className="py-1.5 pr-2 text-right">Alacak (Credit)</th>
                    <th className="py-1.5 text-right">Yürüyen Bakiye</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map((m, idx) => {
                    const cur = m.currency ?? "TRY";
                    const typeTone: Tone =
                      m.movementType === "invoice"
                        ? "blue"
                        : m.movementType === "allocation"
                          ? "green"
                          : m.movementType === "check"
                            ? "amber"
                            : "neutral";
                    const typeLabel =
                      m.movementType === "invoice"
                        ? "Fatura"
                        : m.movementType === "allocation"
                          ? "Tahsis / Ödeme"
                          : m.movementType === "check"
                            ? "Çek / Ciro"
                            : "Banka EFT/Havale";
                    const dirLabel =
                      m.direction === "sales"
                        ? "Satış"
                        : m.direction === "purchase"
                          ? "Alış"
                          : m.direction === "inflow"
                            ? "Giriş"
                            : "Çıkış";
                    return (
                      <tr
                        key={`${m.sourceId}-${m.movementDate}-${m.movementType}-${idx}`}
                        className="border-t border-line text-tone-1"
                      >
                        <td className="py-1.5 pr-2 font-mono">{m.movementDate}</td>
                        <td className="py-1.5 pr-2">
                          <Badge tone={typeTone}>{typeLabel}</Badge>
                        </td>
                        <td className="py-1.5 pr-2 font-mono">{m.reference ?? "—"}</td>
                        <td className="py-1.5 pr-2 text-tone-2">{dirLabel}</td>
                        <td className="py-1.5 pr-2 font-mono">{cur}</td>
                        <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                          {m.debitAmount > 0 ? formatMoney(m.debitAmount, cur) : "—"}
                        </td>
                        <td className="py-1.5 pr-2 text-right font-mono tabular-nums">
                          {m.creditAmount > 0 ? formatMoney(m.creditAmount, cur) : "—"}
                        </td>
                        <td className="py-1.5 text-right font-mono font-semibold tabular-nums">
                          {formatMoney(m.runningBalance, cur)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title="DAVRANIŞSAL ÇALIŞMA SERMAYESİ VE TAHSİLAT GÜVENİLİRLİK KARNESİ (DBT · SÖZ TUTMA · ÇEK/RÜCU)"
          subtitle="Gerçekleşen tahsilat gecikmesi (DBT), ödeme sözü disiplini ve 0102 çek/ciro rücu maruziyeti — dövizler kendi para biriminde tutulur"
          accent={tierDCount > 0 ? "neg" : tierCCount > 0 || recourseRiskPartyCount > 0 ? "warn" : "info"}
          right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
        >
          <div
            className="mb-3 border px-2.5 py-1.5 font-mono text-[11px]"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--line-faint)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text-3)",
            }}
          >
            Kademe eşikleri (model sabiti): en az {M.minSettledInvoicesForDbt} tahsil edilmiş fatura ile DBT yüzdelikleri üretilir · DBT medyan &gt; {M.watchMedianDbtDays}g veya geç oran ≥ %{Math.round(M.strainedLateRatioThreshold * 100)} = C · P75 &gt; {M.criticalP75DbtDays}g = D · söz tutma oranı ≥ %{Math.round(M.reliablePromiseKeptRatioFloor * 100)} (en az {M.minKeptPromisesForReliable} söz, 0 kırılan) = A · ≥ {M.criticalBrokenPromiseCount} kırılan söz ve oran &lt; %{Math.round(M.criticalPromiseKeptRatioCeiling * 100)} = D · karşılıksız çek = D.
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: "Kademe A (Güvenilir)", value: tierACount, tone: "green" as Tone },
              { label: "Kademe B (İzlemede)", value: tierBCount, tone: "blue" as Tone },
              { label: "Kademe C (Gecikmeli)", value: tierCCount, tone: "amber" as Tone },
              { label: "Kademe D (Kritik)", value: tierDCount, tone: "red" as Tone },
              { label: "Yetersiz Geçmiş", value: insufficientCount, tone: "neutral" as Tone },
              { label: "Ciro Rücu Riski Taşıyan", value: recourseRiskPartyCount, tone: recourseRiskPartyCount > 0 ? ("amber" as Tone) : ("neutral" as Tone) },
            ].map((kpi) => (
              <div
                key={kpi.label}
                className="border px-2.5 py-2"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line-faint)",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                <div className="font-mono text-[10px] uppercase" style={{ color: "var(--text-3)" }}>
                  {kpi.label}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="font-mono text-base font-semibold tabular-nums" style={{ color: "var(--text-2)" }}>
                    {kpi.value}
                  </span>
                  <Badge tone={kpi.tone}>{kpi.value} cari</Badge>
                </div>
              </div>
            ))}
          </div>

          {displayedScorecards.length === 0 ? (
            <p className="py-2 text-sm" style={{ color: "var(--text-3)" }}>
              {tab === "active"
                ? "Aktif hareket veya davranışsal tahsilat sinyali taşıyan karşı taraf yok."
                : "Henüz kayıtlı karşı taraf yok."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left" style={{ color: "var(--text-3)" }}>
                    <th className="py-1.5 pr-2">Karşı Taraf</th>
                    <th className="py-1.5 pr-2">Davranışsal Kademe</th>
                    <th className="py-1.5 pr-2 text-right">Medyan / P75 DBT</th>
                    <th className="py-1.5 pr-2 text-right">Ödeme Sözü</th>
                    <th className="py-1.5 pr-2 text-right">Portföy Çeki</th>
                    <th className="py-1.5 pr-2 text-right">Ciro Rücu Riski</th>
                    <th className="py-1.5 pr-2 text-right">Karşılıksız Çek</th>
                    <th className="py-1.5">Önerilen Vade Aksiyonu</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedScorecards.map((s) => (
                    <tr
                      key={s.partyId}
                      className="border-t"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-2)" }}
                    >
                      <td className="py-2 pr-2">
                        <div>
                          <span className="font-medium">{s.partyName}</span>
                          <span className="ml-1.5 font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
                            ({s.partyType})
                          </span>
                        </div>
                        {s.endorsedReceivedCount > 0 && (
                          <div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--text-3)" }}>
                            Ciro edilen tedarikçi çeki: {fmtCurrencyBuckets(s.endorsedReceivedByCurrency, s.endorsedReceivedCount)}
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        <Badge tone={TIER_TONE[s.tier]}>{COUNTERPARTY_TIER_LABEL[s.tier]}</Badge>
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">
                        {renderDbtSummary(s)}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">
                        {renderPromiseSummary(s)}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">
                        {fmtCurrencyBuckets(s.activeCheckPortfolioByCurrency, s.activeCheckCount)}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">
                        {fmtCurrencyBuckets(s.contingentRecourseByCurrency, s.contingentRecourseCount)}
                      </td>
                      <td className="py-2 pr-2 text-right font-mono tabular-nums">
                        {s.bouncedCheckCount === 0 ? (
                          "—"
                        ) : (
                          <span>
                            <Badge tone="red">{s.bouncedCheckCount} adet</Badge>
                            {Object.keys(s.bouncedByCurrency).length > 0 && (
                              <span className="ml-1.5">
                                {fmtCurrencyBuckets(s.bouncedByCurrency, s.bouncedCheckCount)}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="py-2" style={{ color: "var(--text-3)" }}>
                        {s.recommendedTermsAction}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`EŞLEŞMEMİŞ KAYNAK ETİKETLERİ — ${unresolved.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            İçe aktarma bu satırları bir karşı tarafa bağlayamadı ve ham metni korudu. Otomatik
            geri-doldurma YAPILMAZ — eşleştirme incelenmiş, açık bir işlemdir.
          </p>
          {unresolved.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Eşleşmemiş etiket yok.</p>
          ) : (
            unresolved.map((u) => {
              const hints = suggestCounterparties(u.rawLabel, candidates, 0.5, 3);
              const checkRole = u.direction === "inflow" ? "payer" : "payee";
              return (
                <div key={`${u.source}-${u.sourceId}`} className="border-b border-line-faint py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span>
                      <b>{u.rawLabel}</b>
                      <span className="ml-2 text-[10px] text-tone-3">
                        {u.source === "check"
                          ? u.direction === "inflow" ? "müşteri çeki (keşideci)" : "ödeme çeki (lehtar)"
                          : u.source}
                      </span>
                    </span>
                    <span className="font-mono tabular-nums">{fmtTL(u.amount)}</span>
                  </div>
                  {u.source === "check" && hints.length > 0 && (
                    <form action={linkCounterpartyAction} className="mt-1 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="checkId" value={u.sourceId} />
                      <input type="hidden" name="role" value={checkRole} />
                      <select name="partyId" className="rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs">
                        {hints.map((h) => (
                          <option key={h.partyId} value={h.partyId}>
                            {h.name} (%{Math.round(h.score * 100)})
                          </option>
                        ))}
                      </select>
                      <button className="button-ghost px-2 py-0.5 text-xs">
                        eşleştir
                      </button>
                    </form>
                  )}
                  {u.source === "check" && hints.length === 0 && (
                    <span className="text-[11px] text-tone-3">Yeterince benzeyen kayıtlı karşı taraf yok.</span>
                  )}
                  {u.source === "loan" && (
                    <span className="text-[11px] text-tone-3">
                      Kredide ham karşı taraf alanı yok; bu yalnız kredinin kendi adı — insan kararı gerektirir.
                    </span>
                  )}
                </div>
              );
            })
          )}
        </Panel>

        <Panel title="YENİ KARŞI TARAF">
          <p className="mb-2 text-xs text-tone-3">
            Karşı taraf yalnız buradan yaratılır. İçe aktarma hiçbir koşulda sessizce kayıt açmaz.
          </p>
          {canInsertParty ? (
            <form action={createCounterpartyAction} className="grid grid-cols-2 gap-2 text-sm">
              <input name="name" required placeholder="Ünvan" className="col-span-2 rounded border border-line-faint bg-transparent px-2 py-1" />
              <select name="partyType" className="rounded border border-line-faint bg-transparent px-2 py-1">
                {["vendor", "customer", "bank", "company", "person", "provider", "internal_owner", "unknown"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input name="taxNumber" placeholder="Vergi no" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="taxOffice" placeholder="Vergi dairesi" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="city" placeholder="Şehir" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="addressLine" placeholder="Adres" className="col-span-2 rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="creditLimit" type="number" step="0.01" min="0" placeholder="Kredi limiti (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="paymentTermsDays" type="number" min="0" placeholder="Vade (gün)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <button className="button-ghost col-span-2 px-2 py-1 text-xs">Karşı taraf ekle</button>
            </form>
          ) : (
            <p className="text-xs text-tone-3">Yeni cari açmak için finans yöneticisi veya yönetici yetkisi gerekir.</p>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`KARŞI TARAF IBAN KASASI — ${activeIbans.length} aktif IBAN`}>
          <p className="mb-2 text-xs text-tone-3">
            Her yeni veya değişen IBAN `iban_change_events` tablosuna silinemez iz bırakır ve BEC koruması aktifse maker-checker onayına düşer.
          </p>
          {canInsertIban && candidates.length > 0 && (
            <details className="mb-3 rounded border border-line-faint p-2">
              <summary className="cursor-pointer font-mono text-xs font-semibold">+ Yeni IBAN ekle</summary>
              <form action={addIbanAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <select name="partyId" required className="rounded border border-line-faint bg-transparent px-2 py-1 sm:col-span-2">
                  <option value="">Karşı taraf seçin…</option>
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <input name="iban" required placeholder="TR00 0000 0000 0000 0000 0000 00" className="rounded border border-line-faint bg-transparent px-2 py-1 font-mono sm:col-span-2" />
                <input name="bankName" placeholder="Banka adı" className="rounded border border-line-faint bg-transparent px-2 py-1" />
                <input name="accountLabel" placeholder="Hesap etiketi" className="rounded border border-line-faint bg-transparent px-2 py-1" />
                <select name="currency" defaultValue="TRY" className="rounded border border-line-faint bg-transparent px-2 py-1">
                  {["TRY", "USD", "EUR", "GBP"].map((cur) => <option key={cur} value={cur}>{cur}</option>)}
                </select>
                <label className="flex items-center gap-1.5 px-1">
                  <input type="checkbox" name="isPrimary" value="true" />
                  <span>Birincil IBAN</span>
                </label>
                <button className="button-ghost px-2 py-1 text-xs sm:col-span-2">
                  IBAN kaydet
                </button>
              </form>
            </details>
          )}
          {activeIbans.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Kayıtlı aktif IBAN yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-tone-3">
                    <th>Cari</th><th>IBAN</th><th>Banka / Döviz</th><th>Onay</th><th />
                  </tr>
                </thead>
                <tbody>
                  {activeIbans.map((ib) => (
                    <tr key={ib.id} className="border-t border-line-faint">
                      <td className="py-1.5">{ib.partyName}{ib.isPrimary ? <span className="ml-1 text-[10px] text-pos">(birincil)</span> : null}</td>
                      <td className="font-mono">{ib.ibanNormalized}</td>
                      <td className="text-tone-3">{ib.bankName ?? "—"} · {ib.currency}</td>
                      <td>
                        <Badge tone={APPROVAL_TONE[ib.approvalStatus] ?? "neutral"}>
                          {APPROVAL_LABEL[ib.approvalStatus] ?? ib.approvalStatus}
                        </Badge>
                      </td>
                      <td className="text-right">
                        {canUpdateIban && (
                          <form action={deactivateIbanAction} className="inline">
                            <input type="hidden" name="ibanId" value={ib.id} />
                            <button className="text-neg hover:underline">Pasife al</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="ORGANİZASYONEL BOYUTLAR (PROJE · MASRAF MERKEZİ · DEPARTMAN)">
          <p className="mb-2 text-xs text-tone-3">
            Fatura, düzenli ödeme ve bütçe satırlarında kullanılan boyut kodları buradan yönetilir.
          </p>
          {canInsertDimension && (
            <details className="mb-3 rounded border border-line-faint p-2">
              <summary className="cursor-pointer font-mono text-xs font-semibold">+ Yeni boyut ekle</summary>
              <form action={createDimensionAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                <select name="table" required className="rounded border border-line-faint bg-transparent px-2 py-1">
                  <option value="projects">Proje</option>
                  <option value="cost_centers">Masraf Merkezi</option>
                  <option value="departments">Departman</option>
                </select>
                <input name="code" required placeholder="Kod (örn. DEP-URETIM)" className="rounded border border-line-faint bg-transparent px-2 py-1 font-mono" />
                <input name="name" required placeholder="Ad (örn. Üretim)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
                <input name="notes" placeholder="Not (opsiyonel)" className="rounded border border-line-faint bg-transparent px-2 py-1 sm:col-span-2" />
                <button className="button-ghost px-2 py-1 text-xs">
                  Boyut oluştur
                </button>
              </form>
            </details>
          )}
          <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase text-tone-3">Projeler ({projects.length})</div>
              {projects.length === 0 ? <p className="text-tone-3">Yok</p> : projects.slice(0, 8).map((p) => (
                <div key={p.id} className="truncate border-b border-line-faint py-0.5">
                  <span className="font-mono text-[11px]">{p.code}</span> · {p.name}
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase text-tone-3">Masraf Merkezleri ({costCenters.length})</div>
              {costCenters.length === 0 ? <p className="text-tone-3">Yok</p> : costCenters.slice(0, 8).map((c) => (
                <div key={c.id} className="truncate border-b border-line-faint py-0.5">
                  <span className="font-mono text-[11px]">{c.code}</span> · {c.name}
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-mono text-[10px] uppercase text-tone-3">Departmanlar ({departments.length})</div>
              {departments.length === 0 ? <p className="text-tone-3">Yok</p> : departments.slice(0, 8).map((d) => (
                <div key={d.id} className="truncate border-b border-line-faint py-0.5">
                  <span className="font-mono text-[11px]">{d.code}</span> · {d.name}
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
