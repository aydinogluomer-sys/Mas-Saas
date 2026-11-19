"use client";

import { useState } from "react";
import { postManualAdjustmentAction } from "@/app/(dashboard)/finance/ledger/actions";
import { SubmitButton } from "@/components/ui/submit-button";

export interface LedgerAccountOption {
  code: string;
  name: string;
}

export interface CostCenterOption {
  id: string;
  code: string | null;
  name: string;
}

interface DraftLine {
  id: number;
  accountCode: string;
  debit: string;
  credit: string;
  costCenterId: string;
  memo: string;
}

export function MultiLineJournalForm({
  accounts,
  costCenters,
  defaultDate,
}: {
  accounts: LedgerAccountOption[];
  costCenters: CostCenterOption[];
  defaultDate: string;
}) {
  const [lines, setLines] = useState<DraftLine[]>([
    {
      id: 1,
      accountCode: accounts.find((a) => a.code === "770.99")?.code ?? accounts[0]?.code ?? "770.99",
      debit: "",
      credit: "0",
      costCenterId: "",
      memo: "",
    },
    {
      id: 2,
      accountCode: accounts.find((a) => a.code === "257")?.code ?? accounts[1]?.code ?? "257",
      debit: "0",
      credit: "",
      costCenterId: "",
      memo: "",
    },
  ]);

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        id: Date.now() + prev.length,
        accountCode: accounts[0]?.code ?? "770",
        debit: "0",
        credit: "0",
        costCenterId: "",
        memo: "",
      },
    ]);
  };

  const removeLine = (id: number) => {
    if (lines.length <= 2) return;
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const updateLine = (id: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const totalDebit = lines.reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const diff = Math.round((totalDebit - totalCredit) * 100) / 100;
  const isBalanced = totalDebit > 0 && Math.abs(diff) < 0.005;

  return (
    <form
      action={postManualAdjustmentAction}
      className="mb-4 space-y-3 rounded border p-3 text-xs"
      style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
    >
      <div className="grid gap-2 sm:grid-cols-5">
        <label className="font-medium text-tone-2">
          Fiş Tarihi
          <input
            type="date"
            name="entryDate"
            required
            defaultValue={defaultDate}
            className="field-control mt-1 w-full px-2 py-1.5"
          />
        </label>
        <label className="font-medium text-tone-2">
          Para Birimi
          <select name="currency" defaultValue="TRY" className="field-control mt-1 w-full px-2 py-1.5">
            <option value="TRY">TRY</option>
            <option value="USD">USD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
          </select>
        </label>
        <label className="font-medium text-tone-2">
          Kayıt Durumu
          <select name="status" defaultValue="posted" className="field-control mt-1 w-full px-2 py-1.5">
            <option value="posted">Kesinleşmiş (Posted)</option>
            <option value="draft">Taslak (Onay Bekleyen)</option>
          </select>
        </label>
        <label className="font-medium text-tone-2 sm:col-span-2">
          Fiş Açıklaması
          <input
            name="description"
            required
            placeholder="Örn: Aylık Amortisman / Çoklu Masraf Merkezi Tahakkuku"
            className="field-control mt-1 w-full px-2 py-1.5"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded border" style={{ borderColor: "var(--line)", background: "var(--surface-1)" }}>
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase text-tone-3">
              <th className="px-2 py-1.5">TDHP Hesap</th>
              <th className="px-2 py-1.5 text-right">Borç</th>
              <th className="px-2 py-1.5 text-right">Alacak</th>
              <th className="px-2 py-1.5">Masraf Merkezi</th>
              <th className="px-2 py-1.5">Satır Açıklaması</th>
              <th className="w-10 px-2 py-1.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {lines.map((line) => (
              <tr key={line.id}>
                <td className="p-1.5">
                  <select
                    name="lineAccountCode"
                    value={line.accountCode}
                    onChange={(e) => updateLine(line.id, { accountCode: e.target.value })}
                    className="field-control w-full px-2 py-1"
                  >
                    {accounts.length === 0 ? (
                      <>
                        <option value="770.99">770.99 — Amortisman Giderleri</option>
                        <option value="257">257 — Birikmiş Amortismanlar</option>
                      </>
                    ) : (
                      accounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} — {a.name}
                        </option>
                      ))
                    )}
                  </select>
                </td>
                <td className="p-1.5">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="lineDebit"
                    value={line.debit}
                    onChange={(e) => updateLine(line.id, { debit: e.target.value })}
                    placeholder="0.00"
                    className="field-control w-28 px-2 py-1 text-right font-mono"
                  />
                </td>
                <td className="p-1.5">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="lineCredit"
                    value={line.credit}
                    onChange={(e) => updateLine(line.id, { credit: e.target.value })}
                    placeholder="0.00"
                    className="field-control w-28 px-2 py-1 text-right font-mono"
                  />
                </td>
                <td className="p-1.5">
                  <select
                    name="lineCostCenterId"
                    value={line.costCenterId}
                    onChange={(e) => updateLine(line.id, { costCenterId: e.target.value })}
                    className="field-control w-full px-2 py-1"
                  >
                    <option value="">— Masraf merkezi (opsiyonel) —</option>
                    {costCenters.map((cc) => (
                      <option key={cc.id} value={cc.id}>
                        {cc.code ? `${cc.code} · ` : ""}
                        {cc.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-1.5">
                  <input
                    name="lineMemo"
                    value={line.memo}
                    onChange={(e) => updateLine(line.id, { memo: e.target.value })}
                    placeholder="Satır detayı"
                    className="field-control w-full px-2 py-1"
                  />
                </td>
                <td className="p-1.5 text-center">
                  {lines.length > 2 ? (
                    <button
                      type="button"
                      onClick={() => removeLine(line.id)}
                      className="button-ghost px-2 py-0.5 text-[11px] text-neg"
                      aria-label="Satırı sil"
                    >
                      ×
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button type="button" onClick={addLine} className="button-ghost px-2.5 py-1 text-xs">
            + Satır Ekle (Çoklu Bacak)
          </button>
          <span className="font-mono text-[11px] text-tone-2">
            Borç: <strong>{totalDebit.toFixed(2)}</strong> · Alacak: <strong>{totalCredit.toFixed(2)}</strong> ·{" "}
            {isBalanced ? (
              <span className="text-pos">Dengeli (0.00)</span>
            ) : (
              <span className="text-neg">Fark: {diff.toFixed(2)}</span>
            )}
          </span>
        </div>

        <SubmitButton
          pendingLabel="Kaydediliyor…"
          className="button-accent px-3.5 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          Çok Satırlı Yevmiye Fişini Kaydet
        </SubmitButton>
      </div>
    </form>
  );
}

