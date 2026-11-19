"use client";

import { useMemo, useState } from "react";
import { executeCheckBordroAction } from "@/app/(dashboard)/finance/actions";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import {
  CHECK_BORDRO_OPERATIONS,
  CHECK_BORDRO_OPERATION_LABELS_TR,
  CHECK_STATUS_LABELS_TR,
  type CheckBordroOperation,
  type CheckBordroTargets,
} from "@/lib/financing/check-bordro";
import { formatMoney } from "@/lib/money-format";

export interface BordroCandidateCheck {
  id: string;
  maturityDate: string;
  direction: string;
  instrumentType: "check" | "promissory_note";
  counterparty: string;
  serial: string | null;
  amount: number | null;
  currency: string;
  status: string;
}

const OPERATION_ALLOWED_SOURCES: Record<CheckBordroOperation, ReadonlySet<string>> = {
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
  factor_checks: new Set(["in_portfolio", "planned", "in_bank_collection"]),
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

function isEligibleForOperation(c: BordroCandidateCheck, op: CheckBordroOperation): boolean {
  if (!OPERATION_ALLOWED_SOURCES[op].has(c.status)) return false;
  if (
    op === "receive_to_portfolio" ||
    op === "endorse_to_vendor" ||
    op === "send_to_bank_collection" ||
    op === "pledge_to_bank_collateral" ||
    op === "factor_checks"
  ) {
    return c.direction === "inflow";
  }
  if (op === "issue_own_check") {
    return c.direction === "outflow";
  }
  return c.direction === "inflow" || c.direction === "outflow";
}

export function CheckBordroWorkbench({
  candidates,
  targets,
  defaultBordroDate,
}: {
  candidates: BordroCandidateCheck[];
  targets: CheckBordroTargets;
  defaultBordroDate: string;
}) {
  const [operation, setOperation] = useState<CheckBordroOperation>("endorse_to_vendor");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const eligibleCandidates = useMemo(
    () => candidates.filter((c) => isEligibleForOperation(c, operation)),
    [candidates, operation],
  );

  const eligibleSet = useMemo(
    () => new Set(eligibleCandidates.map((c) => c.id)),
    [eligibleCandidates],
  );

  const activeSelectedIds = useMemo(
    () => selectedIds.filter((id) => eligibleSet.has(id)),
    [selectedIds, eligibleSet],
  );

  const selectedTotalsByCurrency = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of eligibleCandidates) {
      if (!activeSelectedIds.includes(c.id)) continue;
      if (c.amount == null) continue;
      map.set(c.currency, (map.get(c.currency) ?? 0) + c.amount);
    }
    return Array.from(map.entries());
  }, [eligibleCandidates, activeSelectedIds]);

  const toggleId = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const selectAllEligible = () => {
    setSelectedIds(eligibleCandidates.slice(0, 50).map((c) => c.id));
  };

  const clearSelection = () => {
    setSelectedIds([]);
  };

  return (
    <form action={executeCheckBordroAction} className="space-y-4">
      <input type="hidden" name="backTo" value="/finance/checks" />

      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs font-medium text-tone-2">
          Bordro işlemi
          <select
            name="operation"
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value as CheckBordroOperation);
              setSelectedIds([]);
            }}
            className="field-control mt-1 w-full p-2 text-xs"
          >
            {CHECK_BORDRO_OPERATIONS.map((op) => (
              <option key={op} value={op}>
                {CHECK_BORDRO_OPERATION_LABELS_TR[op]}
              </option>
            ))}
          </select>
        </label>

        <label className="text-xs font-medium text-tone-2">
          Bordro tarihi
          <input
            type="date"
            name="bordroDate"
            defaultValue={defaultBordroDate}
            required
            className="field-control mt-1 w-full p-2 text-xs"
          />
        </label>

        <label className="text-xs font-medium text-tone-2">
          Açıklama / Bordro notu
          <input
            type="text"
            name="notes"
            placeholder="Örn: Tedarikçi cari kapama / Kredi teminat bordrosu"
            maxLength={500}
            className="field-control mt-1 w-full p-2 text-xs"
          />
        </label>
      </div>

      {(operation === "endorse_to_vendor" || operation === "issue_own_check") && (
        <div className="rounded border border-edge bg-surface-2 p-3">
          <label className="block text-xs font-medium text-tone-2">
            {operation === "endorse_to_vendor"
              ? "Kapatılacak açık tedarikçi alış faturası (zorunlu — aynı para birimi)"
              : "Kapatılacak açık tedarikçi alış faturası (isteğe bağlı)"}
            <select
              name="targetInvoiceId"
              required={operation === "endorse_to_vendor"}
              defaultValue=""
              className="field-control mt-1 w-full p-2 text-xs"
            >
              <option value="">
                {operation === "endorse_to_vendor"
                  ? "— Tedarikçi alış faturası seçin —"
                  : "— Fatura bağlamadan keşide et —"}
              </option>
              {targets.openPurchaseInvoices.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNo} · {inv.partyName} · Açık:{" "}
                  {formatMoney(inv.openAmount, inv.currency)}
                  {inv.dueDate ? ` · Vade: ${inv.dueDate}` : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-[11px] text-tone-3">
            Ciro edilen çek aynı anda hem tedarikçi faturasını{" "}
            <code className="font-mono">invoice_allocations</code> üzerinden kapatır hem de nakit
            tahmininden düşerek çift sayımı engeller; vadesinde tahsil edilene dek şarta bağlı{" "}
            <strong>rücu riski</strong> olarak izlenir.
          </p>
        </div>
      )}

      {operation === "send_to_bank_collection" && (
        <div className="rounded border border-edge bg-surface-2 p-3">
          <label className="block text-xs font-medium text-tone-2">
            Tahsile verilecek banka hesabı (zorunlu)
            <select
              name="targetBankAccountId"
              required
              defaultValue=""
              className="field-control mt-1 w-full p-2 text-xs"
            >
              <option value="">— Banka hesabı seçin —</option>
              {targets.bankAccounts.map((ba) => (
                <option key={ba.id} value={ba.id}>
                  {ba.name}
                  {ba.bankName ? ` (${ba.bankName})` : ""} · {ba.currency}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {operation === "pledge_to_bank_collateral" && (
        <div className="grid gap-3 rounded border border-edge bg-surface-2 p-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-tone-2 sm:col-span-2">
            Teminata bağlanacak aktif kredi limiti (zorunlu)
            <select
              name="targetFacilityId"
              required
              defaultValue=""
              className="field-control mt-1 w-full p-2 text-xs"
            >
              <option value="">— Kredi limiti (credit_facilities) seçin —</option>
              {targets.creditFacilities.map((cf) => (
                <option key={cf.id} value={cf.id}>
                  {cf.name}
                  {cf.lenderName ? ` · ${cf.lenderName}` : ""} · {cf.currency}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            Teminat marjı / LTV (0.05 – 1.00)
            <input
              type="number"
              name="ltvRatio"
              step="0.05"
              min="0.05"
              max="1.00"
              defaultValue="0.80"
              required
              className="field-control mt-1 w-full p-2 text-xs font-mono"
            />
          </label>
        </div>
      )}

      {operation === "factor_checks" && (
        <div className="grid gap-3 rounded border border-edge bg-surface-2 p-3 sm:grid-cols-3">
          <label className="text-xs font-medium text-tone-2 sm:col-span-2">
            Net nakdin aktarılacağı banka hesabı (102 — zorunlu, aynı para birimi)
            <select
              name="targetBankAccountId"
              required
              defaultValue=""
              className="field-control mt-1 w-full p-2 text-xs"
            >
              <option value="">— Banka hesabı seçin —</option>
              {targets.bankAccounts.map((ba) => (
                <option key={ba.id} value={ba.id}>
                  {ba.name}
                  {ba.bankName ? ` (${ba.bankName})` : ""} · {ba.currency}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-tone-2">
            İskonto faizi + komisyon kesintisi (780)
            <input
              type="number"
              name="discountFeeAmount"
              step="0.01"
              min="0"
              defaultValue="0"
              required
              className="field-control mt-1 w-full p-2 text-xs font-mono"
            />
          </label>
          <p className="text-[11px] text-tone-3 sm:col-span-3">
            Faktoring / iskonto işlemi net tutarı seçilen banka hesabına yatırır (<code className="font-mono">102</code>),
            faiz ve komisyon kesintisini finansman giderine (<code className="font-mono">780</code>) işler ve evrakları{" "}
            <code className="font-mono">101/121</code> portföyünden düşürür.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-tone-2">
            Bu işlem için uygun evrak: <strong>{eligibleCandidates.length}</strong> · Seçilen:{" "}
            <strong>{activeSelectedIds.length}</strong>
            {selectedTotalsByCurrency.length > 0 && (
              <>
                {" "}
                · Toplam:{" "}
                <strong className="font-mono">
                  {selectedTotalsByCurrency
                    .map(([cur, amt]) => formatMoney(amt, cur))
                    .join(" + ")}
                </strong>
              </>
            )}
          </span>
          {eligibleCandidates.length > 0 && (
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectAllEligible}
                className="button-ghost px-2 py-1 text-xs"
              >
                Uygunları seç
              </button>
              {activeSelectedIds.length > 0 && (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="button-ghost px-2 py-1 text-xs"
                >
                  Seçimi temizle
                </button>
              )}
            </span>
          )}
        </div>

        {eligibleCandidates.length === 0 ? (
          <div className="rounded border border-dashed border-edge p-3 text-xs text-tone-3">
            Seçili bordro işlemi ({CHECK_BORDRO_OPERATION_LABELS_TR[operation]}) için uygun durumda
            çek veya senet bulunmuyor.
          </div>
        ) : (
          <div className="max-h-60 overflow-y-auto rounded border border-edge">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-surface-2 text-[11px] text-tone-3">
                <tr>
                  <th className="w-8 px-2 py-1.5">Seç</th>
                  <th className="px-2 py-1.5">Vade</th>
                  <th className="px-2 py-1.5">Tür</th>
                  <th className="px-2 py-1.5">Seri</th>
                  <th className="px-2 py-1.5">Karşı Taraf</th>
                  <th className="px-2 py-1.5">Durum</th>
                  <th className="px-2 py-1.5 text-right">Tutar</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {eligibleCandidates.map((c) => {
                  const checked = activeSelectedIds.includes(c.id);
                  return (
                    <tr key={c.id} className={checked ? "bg-surface-2/70" : undefined}>
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          name="checkIds"
                          value={c.id}
                          checked={checked}
                          onChange={() => toggleId(c.id)}
                          aria-label={`Çek seç ${c.serial ?? c.id}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-mono">{c.maturityDate}</td>
                      <td className="px-2 py-1.5">
                        {c.instrumentType === "promissory_note" ? "Senet" : "Çek"}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{c.serial ?? "—"}</td>
                      <td className="px-2 py-1.5">{c.counterparty}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={STATUS_TONE[c.status] ?? "neutral"}>
                          {CHECK_STATUS_LABELS_TR[c.status] ?? c.status}
                        </Badge>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {c.amount == null ? "—" : formatMoney(c.amount, c.currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={activeSelectedIds.length === 0}
          className="button-accent px-3 py-2 text-xs disabled:opacity-50"
        >
          Bordroyu uygula
        </button>
      </div>
    </form>
  );
}

