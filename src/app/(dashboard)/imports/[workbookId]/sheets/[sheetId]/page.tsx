import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { Badge, SHEET_TYPE_TONE } from "@/components/ui/badge";
import { Num, Panel } from "@/components/ui/panel";
import {
  extractChecks,
  extractMonthlyCashflow,
  extractPaymentMatrix,
} from "@/lib/importers/extractors";
import type { CellVal, RowJson, SheetRow } from "@/lib/importers/row-utils";
import {
  ChecksPreview,
  MonthlyCashflowPreviewView,
  PaymentMatrixPreview,
} from "@/components/imports/previews";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 40;
const PREVIEWABLE = new Set(["payment_day_matrix", "monthly_cashflow", "checks"]);

function rowsToSheetRows(dbRows: Array<{ row_index: number; row_json: RowJson }>): SheetRow[] {
  return dbRows.map((r) => ({ rowIndex: r.row_index, cells: r.row_json }));
}

function rowsToCellMap(dbRows: Array<{ row_index: number; row_json: RowJson }>): Record<string, CellVal> {
  const m: Record<string, CellVal> = {};
  for (const r of dbRows) {
    for (const [col, cell] of Object.entries(r.row_json)) m[`${col}${r.row_index}`] = cell;
  }
  return m;
}

export default async function SheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ workbookId: string; sheetId: string }>;
  searchParams: Promise<{ view?: string; page?: string }>;
}) {
  const { workbookId, sheetId } = await params;
  const sp = await searchParams;
  const pool = getPool();

  const sheetRes = await pool.query(
    `select id, sheet_name, detected_type, parse_confidence, used_range, row_count, column_count
     from public.source_sheets where id=$1 and workbook_id=$2`,
    [sheetId, workbookId],
  );
  if (sheetRes.rowCount === 0) notFound();
  const sheet = sheetRes.rows[0];

  const canPreview = PREVIEWABLE.has(sheet.detected_type);
  const view = sp.view === "preview" && canPreview ? "preview" : "raw";
  const page = Math.max(1, Number(sp.page ?? 1) || 1);

  const allRows = await pool.query<{ row_index: number; row_json: RowJson; mapping_status: string }>(
    `select row_index, row_json, mapping_status from public.import_rows
     where sheet_id=$1 order by row_index`,
    [sheetId],
  );
  const totalRows = allRows.rowCount ?? 0;
  const pageRows = allRows.rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const cols = [...new Set(allRows.rows.flatMap((r) => Object.keys(r.row_json)))].sort(
    (a, b) => (a.length - b.length) || (a < b ? -1 : 1),
  );

  const base = `/imports/${workbookId}/sheets/${sheetId}`;
  const tab = (label: string, href: string, active: boolean, disabled = false) =>
    disabled ? (
      <span className="border border-line-faint px-2 py-1 font-mono text-[10px] uppercase text-tone-4">{label}</span>
    ) : (
      <Link href={href}
        className={active ? "button-primary px-2 py-1" : "button-ghost px-2 py-1"}>
        {label}
      </Link>
    );

  let preview: React.ReactNode = null;
  if (view === "preview") {
    const sheetRows = rowsToSheetRows(allRows.rows);
    if (sheet.detected_type === "payment_day_matrix") {
      const r = extractPaymentMatrix(sheetRows);
      preview = <PaymentMatrixPreview candidates={r.candidates} issues={r.issues} />;
    } else if (sheet.detected_type === "checks") {
      const r = extractChecks(sheetRows);
      preview = <ChecksPreview candidates={r.candidates} issues={r.issues} />;
    } else {
      const data = extractMonthlyCashflow(sheet.sheet_name, rowsToCellMap(allRows.rows));
      preview = <MonthlyCashflowPreviewView data={data} />;
    }
  }

  return (
    <>
      <Panel
        title={sheet.sheet_name}
        right={
          <span className="flex items-center gap-2">
            <Badge tone={SHEET_TYPE_TONE[sheet.detected_type] ?? "neutral"}>{sheet.detected_type}</Badge>
            <span className="font-mono text-[10px] text-tone-3">{sheet.used_range}</span>
          </span>
        }
      >
        <div className="flex items-center gap-1">
          {tab("HAM SATIRLAR", `${base}?view=raw`, view === "raw")}
          {tab(
            canPreview ? "ÖNİZLEME" : "ÖNİZLEME YOK (raw-only)",
            `${base}?view=preview`,
            view === "preview",
            !canPreview,
          )}
          <span className="ml-auto font-mono text-[10px] text-tone-3">
            <Num>{totalRows}</Num> satır — önizleme staging&apos;dir, nihai tablolara yazmaz
          </span>
        </div>
      </Panel>

      {view === "raw" ? (
        <Panel title={`HAM VERİ — sayfa ${page}/${Math.max(1, Math.ceil(totalRows / PAGE_SIZE))}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[9px] uppercase text-tone-3">
                  <th className="py-1 pr-2">r</th>
                  <th className="py-1 pr-2">durum</th>
                  {cols.map((c) => <th key={c} className="py-1 pr-2">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr key={r.row_index} className="border-b border-line-faint align-top">
                    <td className="py-1 pr-2 font-mono text-tone-3">{r.row_index}</td>
                    <td className="py-1 pr-2">
                      {r.mapping_status === "needs_review"
                        ? <Badge tone="amber">inceleme</Badge>
                        : <span className="font-mono text-[9px] text-tone-4">{r.mapping_status}</span>}
                    </td>
                    {cols.map((c) => {
                      const cell = r.row_json[c];
                      return (
                        <td key={c} className="max-w-[160px] truncate py-1 pr-2 font-mono tabular-nums"
                          title={cell?.f ? `= ${cell.f}` : undefined}>
                          {cell ? String(cell.w ?? cell.v) : ""}
                          {cell?.f ? <span className="text-info">ƒ</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex gap-2">
            {page > 1 && tab("‹ ÖNCEKİ", `${base}?view=raw&page=${page - 1}`, false)}
            {page * PAGE_SIZE < totalRows && tab("SONRAKİ ›", `${base}?view=raw&page=${page + 1}`, false)}
          </div>
        </Panel>
      ) : (
        <Panel title="ÖNİZLEME — extraction (yalnız görüntüleme)">{preview}</Panel>
      )}
    </>
  );
}
