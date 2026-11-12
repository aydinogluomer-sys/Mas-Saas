"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { Badge, STATUS_TONE } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/primitives/data-table";
import { ArchiveForm } from "@/components/system/archive-form";
import { CheckSettleForms } from "@/components/finance/check-settle-forms";
import { formatMoney } from "@/lib/money-format";

export interface CheckRow {
  id: string;
  maturityDate: string;
  direction: string;
  instrumentType?: "check" | "promissory_note";
  counterparty: string;
  bank: string | null;
  serial: string | null;
  amount: number | null;
  currency?: string | null;
  status: string;
  bordroDetail?: string | null;
  lastBordroNo?: string | null;
}

const CHECK_STATUS_TR: Record<string, string> = {
  planned: "planlı",
  in_portfolio: "portföyde",
  endorsed_to_vendor: "tedarikçiye cirolu",
  in_bank_collection: "bankada tahsilde",
  in_bank_collateral: "bankada teminatta",
  issued_to_vendor: "keşide (verilen)",
  cleared: "tahsil edildi",
  bounced: "karşılıksız",
  returned: "iade edildi",
  cancelled: "iptal",
  unknown: "bilinmiyor",
};

const columns: ColumnDef<CheckRow>[] = [
  {
    accessorKey: "maturityDate",
    header: "Vade",
    meta: { label: "Vade" },
    cell: ({ getValue }) => <span className="font-mono">{getValue<string>()}</span>,
  },
  {
    accessorKey: "direction",
    header: "Yön / Tür",
    meta: { label: "Yön / Tür" },
    cell: ({ row, getValue }) => (
      <span className="flex flex-wrap items-center gap-1">
        {getValue<string>() === "inflow" ? (
          <Badge tone="green">Tahsilat</Badge>
        ) : getValue<string>() === "outflow" ? (
          <Badge tone="amber">Ödeme</Badge>
        ) : (
          <Badge tone="neutral">Belirsiz</Badge>
        )}
        {row.original.instrumentType === "promissory_note" ? (
          <Badge tone="blue">Senet</Badge>
        ) : (
          <Badge tone="neutral">Çek</Badge>
        )}
      </span>
    ),
  },
  {
    accessorKey: "counterparty",
    header: "Karşı taraf",
    meta: { label: "Karşı taraf" },
    cell: ({ row, getValue }) => (
      <div className="space-y-0.5">
        <div>{getValue<string>()}</div>
        {row.original.bordroDetail ? (
          <div className="text-[11px] text-tone-3">{row.original.bordroDetail}</div>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: "bank",
    header: "Banka",
    meta: { label: "Banka" },
    cell: ({ getValue }) => getValue<string | null>() ?? "—",
  },
  {
    accessorKey: "serial",
    header: "Seri / Bordro",
    meta: { label: "Seri / Bordro" },
    cell: ({ row, getValue }) => (
      <div className="space-y-0.5">
        <div className="font-mono">{getValue<string | null>() ?? "—"}</div>
        {row.original.lastBordroNo ? (
          <div className="font-mono text-[11px] text-tone-3">{row.original.lastBordroNo}</div>
        ) : null}
      </div>
    ),
  },
  {
    accessorKey: "amount",
    header: "Tutar",
    meta: { label: "Tutar", align: "right" },
    cell: ({ row, getValue }) => {
      const value = getValue<number | null>();
      return value == null ? (
        <Badge tone="amber">Tutar eksik</Badge>
      ) : (
        <span className="font-mono tabular-nums">
          {formatMoney(value, row.original.currency ?? "TRY")}
        </span>
      );
    },
  },
  {
    accessorKey: "status",
    header: "Durum",
    meta: { label: "Durum" },
    cell: ({ getValue }) => {
      const v = getValue<string>();
      return <Badge tone={STATUS_TONE[v] ?? "neutral"}>{CHECK_STATUS_TR[v] ?? v}</Badge>;
    },
  },
  {
    id: "actions",
    header: "İşlem",
    enableSorting: false,
    enableHiding: false,
    meta: { align: "right" },
    cell: ({ row }) => (
      <span className="flex flex-wrap items-center justify-end gap-1">
        <CheckSettleForms id={row.original.id} status={row.original.status} backTo="/finance/checks" />
        <ArchiveForm
          entity="checks"
          id={row.original.id}
          backTo="/finance/checks?flash=archived"
          reason="Çek defterinden arşivlendi"
        />
      </span>
    ),
  },
];

export function ChecksTable({ rows }: { rows: CheckRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={rows}
      stateKey="checks"
      searchPlaceholder="Çek/senet ara (karşı taraf, banka, seri, bordro…)"
      initialSorting={[{ id: "maturityDate", desc: false }]}
      exportFileName="cekler"
      emptyLabel="Çek/senet kaydı yok."
      minWidth={900}
    />
  );
}
