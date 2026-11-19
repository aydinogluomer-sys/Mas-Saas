"use client";

import { useState } from "react";
import { createInvoiceAction } from "@/app/(dashboard)/finance/invoices/actions";

interface OptionItem {
  id: string;
  label: string;
}

interface LineDraft {
  id: number;
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPct: string;
  taxRate: string;
  stopajPct: string;
}

export function MultiLineInvoiceForm({
  parties,
  projects,
  costCenters,
  departments,
  openPaymentInstances,
}: {
  parties: OptionItem[];
  projects: OptionItem[];
  costCenters: OptionItem[];
  departments: OptionItem[];
  openPaymentInstances: OptionItem[];
}) {
  const [currency, setCurrency] = useState("TRY");
  const [lines, setLines] = useState<LineDraft[]>([
    {
      id: 1,
      description: "",
      quantity: "1",
      unit: "ADET",
      unitPrice: "",
      discountPct: "0",
      taxRate: "0.20",
      stopajPct: "0",
    },
  ]);

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      {
        id: Date.now(),
        description: "",
        quantity: "1",
        unit: "ADET",
        unitPrice: "",
        discountPct: "0",
        taxRate: "0.20",
        stopajPct: "0",
      },
    ]);
  };

  const removeLine = (id: number) => {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));
  };

  const updateLine = (id: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  };

  const totals = lines.reduce(
    (acc, l) => {
      const qty = Number(l.quantity) || 0;
      const price = Number(l.unitPrice) || 0;
      const discFrac = Math.min(1, Math.max(0, (Number(l.discountPct) || 0) / 100));
      const taxFrac = Math.max(0, Number(l.taxRate) || 0);
      const stopajFrac = Math.min(1, Math.max(0, (Number(l.stopajPct) || 0) / 100));
      const rawNet = Math.round(qty * price * 100) / 100;
      const disc = Math.round(rawNet * discFrac * 100) / 100;
      const net = Math.round((rawNet - disc) * 100) / 100;
      const tax = Math.round(net * taxFrac * 100) / 100;
      const stopaj = Math.round(net * stopajFrac * 100) / 100;
      acc.net += net;
      acc.discount += disc;
      acc.tax += tax;
      acc.gross += net + tax;
      acc.stopaj += stopaj;
      return acc;
    },
    { net: 0, discount: 0, tax: 0, gross: 0, stopaj: 0 },
  );
  const payable = Math.max(0, totals.gross - totals.stopaj);

  return (
    <form action={createInvoiceAction} className="grid gap-2 text-xs">
      <div className="grid grid-cols-2 gap-1.5">
        <select name="direction" required className="field-control text-xs">
          <option value="sales">Satış Faturası (120)</option>
          <option value="purchase">Alış / Gider Faturası (320)</option>
        </select>
        <select
          name="currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="field-control font-mono text-xs"
        >
          {["TRY", "USD", "EUR", "GBP"].map((cur) => (
            <option key={cur} value={cur}>
              {cur}
            </option>
          ))}
        </select>
      </div>

      <select name="partyId" required className="field-control text-xs">
        <option value="">Karşı taraf (cari) seçin…</option>
        {parties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <input name="invoiceNo" required placeholder="Fatura No (örn. GIB2026000001)" className="field-control font-mono text-xs" />

      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-tone-3">Düzenleme Tarihi</span>
          <input name="issueDate" type="date" required className="field-control font-mono text-xs" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] text-tone-3">Vade Tarihi</span>
          <input name="dueDate" type="date" className="field-control font-mono text-xs" />
        </label>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
        <select name="projectId" defaultValue="" className="field-control text-xs">
          <option value="">Proje (ops.)</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select name="costCenterId" defaultValue="" className="field-control text-xs">
          <option value="">Maliyet Mrk. (ops.)</option>
          {costCenters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select name="departmentId" defaultValue="" className="field-control text-xs">
          <option value="">Departman (ops.)</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {openPaymentInstances.length > 0 ? (
        <select name="linkedPaymentInstanceId" defaultValue="" className="field-control text-xs">
          <option value="">Ödeme Takvimi Eşleşmesi (otomatik veya seçin)…</option>
          {openPaymentInstances.map((pi) => (
            <option key={pi.id} value={pi.id}>
              {pi.label}
            </option>
          ))}
        </select>
      ) : null}

      <div className="mt-1 flex items-center justify-between border-t border-line-faint pt-2">
        <span className="font-mono text-[11px] font-semibold text-tone-2">
          FATURA KALEMLERİ ({lines.length} satır)
        </span>
        <button
          type="button"
          onClick={addLine}
          className="rounded border border-line bg-surface px-2 py-0.5 font-mono text-[11px] text-accent hover:bg-elev"
        >
          + Kalem Ekle
        </button>
      </div>

      <div className="space-y-2">
        {lines.map((line, index) => {
          const discFrac = Math.min(1, Math.max(0, (Number(line.discountPct) || 0) / 100));
          const stopajFrac = Math.min(1, Math.max(0, (Number(line.stopajPct) || 0) / 100));
          return (
            <div key={line.id} className="rounded border border-line-faint bg-elev/30 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-mono text-[10px] text-tone-3">Satır #{index + 1}</span>
                {lines.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeLine(line.id)}
                    className="text-[10px] text-neg hover:underline"
                  >
                    kaldır
                  </button>
                ) : null}
              </div>
              <input
                name="lineDescription"
                required
                value={line.description}
                onChange={(e) => updateLine(line.id, { description: e.target.value })}
                placeholder="Mal / hizmet açıklaması"
                className="field-control mb-1.5 w-full text-xs"
              />
              <input type="hidden" name="lineDiscountRate" value={discFrac.toFixed(4)} />
              <input type="hidden" name="lineIncomeTaxWithholdingRate" value={stopajFrac.toFixed(4)} />
              <div className="grid grid-cols-3 gap-1">
                <input
                  name="lineQuantity"
                  type="number"
                  step="0.0001"
                  required
                  value={line.quantity}
                  onChange={(e) => updateLine(line.id, { quantity: e.target.value })}
                  placeholder="Miktar"
                  className="field-control font-mono text-xs"
                />
                <input
                  name="lineUnit"
                  value={line.unit}
                  onChange={(e) => updateLine(line.id, { unit: e.target.value })}
                  placeholder="Birim"
                  className="field-control text-xs"
                />
                <input
                  name="lineUnitPrice"
                  type="number"
                  step="0.0001"
                  required
                  value={line.unitPrice}
                  onChange={(e) => updateLine(line.id, { unitPrice: e.target.value })}
                  placeholder="Birim fiyat"
                  className="field-control font-mono text-xs"
                />
              </div>
              <div className="mt-1 grid grid-cols-3 gap-1">
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-tone-3">İskonto %</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={line.discountPct}
                    onChange={(e) => updateLine(line.id, { discountPct: e.target.value })}
                    className="field-control font-mono text-xs"
                  />
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-tone-3">KDV Oranı</span>
                  <select
                    name="lineTaxRate"
                    value={line.taxRate}
                    onChange={(e) => updateLine(line.id, { taxRate: e.target.value })}
                    className="field-control font-mono text-xs"
                  >
                    <option value="0.20">%20</option>
                    <option value="0.10">%10</option>
                    <option value="0.01">%1</option>
                    <option value="0">%0</option>
                  </select>
                </label>
                <label className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-tone-3">GV Stopaj %</span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="100"
                    value={line.stopajPct}
                    onChange={(e) => updateLine(line.id, { stopajPct: e.target.value })}
                    className="field-control font-mono text-xs"
                  />
                </label>
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded border border-line-faint bg-surface p-2 font-mono text-[11px] text-tone-2">
        <div className="flex justify-between">
          <span>Net Toplam (İsk. Düşülmüş):</span>
          <span>
            {totals.net.toFixed(2)} {currency}
          </span>
        </div>
        <div className="flex justify-between">
          <span>KDV Toplamı:</span>
          <span>
            {totals.tax.toFixed(2)} {currency}
          </span>
        </div>
        {totals.stopaj > 0 ? (
          <div className="flex justify-between text-warn">
            <span>GV /SMM Stopaj Kesintisi:</span>
            <span>
              -{totals.stopaj.toFixed(2)} {currency}
            </span>
          </div>
        ) : null}
        <div className="mt-1 flex justify-between border-t border-line-faint pt-1 font-semibold text-tone-1">
          <span>Ödenecek Net Brüt:</span>
          <span>
            {payable.toFixed(2)} {currency}
          </span>
        </div>
      </div>

      <button type="submit" className="button-accent w-full py-2 text-xs font-medium">
        Taslak Fatura Oluştur
      </button>
    </form>
  );
}

