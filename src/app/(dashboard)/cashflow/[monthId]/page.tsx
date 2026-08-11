import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

const GROUPS: Array<[string, string]> = [
  ["customer_income", "MÜŞTERİ GELİRLERİ"],
  ["vendor_payment", "CARİ ÖDEMELER"],
  ["operational_cost", "İŞLETME GİDERLERİ (personel · genel)"],
  ["tax", "VERGİ / SGK"],
  ["loan_payment", "KREDİ / FİNANSMAN"],
  ["bank_balance", "BANKA / HESAP BAKİYELERİ"],
  ["adjustment", "YAN TAKİP (adjustment)"],
];

export default async function CashflowMonthPage({
  params,
}: { params: Promise<{ monthId: string }> }) {
  const { monthId } = await params;
  const pool = getPool();
  const mRes = await pool.query(
    `select cm.id, to_char(cm.month_start,'YYYY-MM') as ym,
            cm.opening_balance::float8 as opening, cm.projected_income::float8 as income,
            cm.projected_expense::float8 as expense, cm.monthly_delta::float8 as delta,
            cm.closing_balance::float8 as closing, cm.status, cm.confidence,
            cm.source_workbook_id, cm.source_sheet_id, ss.sheet_name
     from public.cashflow_months cm
     left join public.source_sheets ss on ss.id = cm.source_sheet_id
     where cm.id = $1`,
    [monthId],
  );
  if (mRes.rowCount === 0) notFound();
  const m = mRes.rows[0];

  const lines = await pool.query(
    `select cl.id, cl.line_type, cl.direction, cl.label, cl.amount::float8 as amount,
            cl.amount_status, p.name as party, ir.row_index
     from public.cashflow_lines cl
     left join public.parties p on p.id = cl.party_id
     left join public.import_rows ir on ir.id = cl.source_row_id
     where cl.cashflow_month_id = $1
     order by cl.line_type, ir.row_index nulls last`,
    [monthId],
  );

  const identity =
    m.opening != null && m.income != null && m.expense != null && m.closing != null
      ? Math.abs(m.opening + m.income - m.expense - m.closing) <= 1
      : null;

  const head: Array<[string, number | null]> = [
    ["DEVİR", m.opening], ["GELİR", m.income], ["GİDER", m.expense],
    ["FARK", m.delta], ["KASA", m.closing],
  ];
  const fmt = (v: number | null) =>
    v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

  const others = lines.rows.filter((l) => !GROUPS.some(([t]) => t === l.line_type));

  return (
    <>
      <Panel
        title={`NAKİT AKIŞ — ${m.ym}`}
        right={
          <span className="flex items-center gap-2">
            {identity == null ? (
              <Badge tone="amber">kimlik doğrulanamadı</Badge>
            ) : identity ? (
              <Badge tone="green">kasa = devir + gelir − gider ✓</Badge>
            ) : (
              <Badge tone="red">kimlik UYUŞMUYOR</Badge>
            )}
            <Link href="/cashflow" className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">
              ← nakit akış
            </Link>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {head.map(([k, v]) => (
            <div key={k} className="border border-line bg-black/40 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
              <div className={`font-mono text-sm tabular-nums ${v != null && v < 0 ? "text-neg" : "text-tone-1"}`}>
                {fmt(v)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-tone-3">
          <span>durum: {m.status} · güven: {m.confidence}</span>
          {m.source_workbook_id && m.source_sheet_id && (
            <Link
              className="underline decoration-line-strong underline-offset-2"
              href={`/data/imports/${m.source_workbook_id}/sheets/${m.source_sheet_id}`}
            >
              kaynak sekme: {m.sheet_name} →
            </Link>
          )}
        </div>
      </Panel>

      {GROUPS.map(([type, title]) => {
        const list = lines.rows.filter((l) => l.line_type === type);
        if (list.length === 0) return null;
        return (
          <Panel key={type} title={`${title} — ${list.length}`}>
            <table className="w-full text-sm">
              <tbody>
                {list.map((l) => (
                  <tr key={l.id} className="border-b border-line-faint">
                    <td className="w-10 py-1 pr-2 font-mono text-xs text-tone-3">
                      {l.row_index != null ? `r${l.row_index}` : "—"}
                    </td>
                    <td className="py-1 pr-2">
                      {l.label}
                      {l.party && <span className="ml-2 font-mono text-[10px] text-info">↔ {l.party}</span>}
                    </td>
                    <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                      {l.amount != null ? fmt(l.amount) : <Badge tone="amber">TUTAR EKSİK</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        );
      })}

      {others.length > 0 && (
        <Panel title={`DİĞER SATIRLAR — ${others.length}`}>
          <table className="w-full text-sm">
            <tbody>
              {others.map((l) => (
                <tr key={l.id} className="border-b border-line-faint">
                  <td className="w-24 py-1 pr-2 font-mono text-[10px] text-tone-3">{l.line_type}</td>
                  <td className="py-1 pr-2">{l.label}</td>
                  <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                    {l.amount != null ? fmt(l.amount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
