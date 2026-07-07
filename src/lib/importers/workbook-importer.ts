// Workbook importer (Phase 2). Writes ONLY the staging layer:
// source_workbooks → source_sheets → source_cells → import_rows → mapping_reviews.
// Never touches final domain tables (implementation.md rule; Phase 3+ does mapping).
// Contract: every populated cell is preserved; ambiguous rows become reviews.

import type { Pool, PoolClient } from "pg";
import {
  listSheets,
  safeParseWorkbookBuffer,
} from "./workbook-parser";
import {
  cellsToMap,
  cellsToRows,
  hashRow,
  sha256,
  sheetCells,
} from "./row-utils";
import {
  extractCapacity,
  extractChecks,
  extractCostModel,
  extractLoan,
  extractMachineRoi,
  extractMonthlyCashflow,
  extractPaymentMatrix,
  type ReviewIssue,
} from "./extractors";

export interface ImportResult {
  ok: boolean;
  workbookId: string;
  error?: string;
  sheets: number;
  cellsIterated: number;
  cellsInserted: number;
  rowsInserted: number;
  reviewsInserted: number;
  rowsNeedingReview: number;
}

const CHUNK = 800;

async function insertCells(
  client: PoolClient,
  workbookId: string,
  sheetId: string,
  cells: ReturnType<typeof sheetCells>,
): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < cells.length; i += CHUNK) {
    const part = cells.slice(i, i + CHUNK);
    const res = await client.query(
      `insert into public.source_cells
         (workbook_id, sheet_id, row_index, column_index, address,
          raw_value, normalized_value, inferred_type, formula)
       select $1, $2, r, c, a, rv, nv, it, f
       from unnest($3::int[], $4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
            as t(r, c, a, rv, nv, it, f)`,
      [
        workbookId,
        sheetId,
        part.map((x) => x.rowIndex),
        part.map((x) => x.columnIndex),
        part.map((x) => x.address),
        part.map((x) => x.cell.w ?? String(x.cell.v)),
        part.map((x) => String(x.cell.v)),
        part.map((x) => x.cell.t),
        part.map((x) => x.cell.f ?? null),
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

async function insertRows(
  client: PoolClient,
  workbookId: string,
  sheetId: string,
  detectedType: string,
  rows: ReturnType<typeof cellsToRows>,
): Promise<Map<number, string>> {
  const idByRow = new Map<number, string>();
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const res = await client.query(
      `insert into public.import_rows
         (workbook_id, sheet_id, row_index, row_json, row_hash, detected_entity_type)
       select $1, $2, r, j, h, $6
       from unnest($3::int[], $4::jsonb[], $5::text[]) as t(r, j, h)
       returning id, row_index`,
      [
        workbookId,
        sheetId,
        part.map((x) => x.rowIndex),
        part.map((x) => JSON.stringify(x.cells)),
        part.map((x) => hashRow(x.cells)),
        detectedType,
      ],
    );
    for (const row of res.rows) idByRow.set(row.row_index, row.id);
  }
  return idByRow;
}

async function insertReviews(
  client: PoolClient,
  workbookId: string,
  sheetId: string,
  idByRow: Map<number, string>,
  issues: ReviewIssue[],
): Promise<{ reviews: number; flaggedRowIds: string[] }> {
  if (issues.length === 0) return { reviews: 0, flaggedRowIds: [] };
  const res = await client.query(
    `insert into public.mapping_reviews
       (workbook_id, sheet_id, import_row_id, issue_type, severity, message)
     select $1, $2, rid::uuid, it, sev, msg
     from unnest($3::text[], $4::text[], $5::text[], $6::text[]) as t(rid, it, sev, msg)`,
    [
      workbookId,
      sheetId,
      issues.map((i) => (i.rowIndex != null ? idByRow.get(i.rowIndex) ?? null : null)),
      issues.map((i) => i.issue_type),
      issues.map((i) => i.severity),
      issues.map((i) => i.message),
    ],
  );
  const flaggedRowIds = [
    ...new Set(
      issues
        .map((i) => (i.rowIndex != null ? idByRow.get(i.rowIndex) : undefined))
        .filter((x): x is string => !!x),
    ),
  ];
  return { reviews: res.rowCount ?? 0, flaggedRowIds };
}

export async function importWorkbook(
  pool: Pool,
  buf: Buffer,
  originalFilename: string,
): Promise<ImportResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const wbRes = await client.query(
      `insert into public.source_workbooks (original_filename, file_sha256, status)
       values ($1, $2, 'pending') returning id`,
      [originalFilename, sha256(buf)],
    );
    const workbookId: string = wbRes.rows[0].id;

    const parsed = safeParseWorkbookBuffer(buf);
    if (!parsed.ok) {
      await client.query(
        `update public.source_workbooks set status='failed', parse_error=$2 where id=$1`,
        [workbookId, parsed.error],
      );
      await client.query("commit");
      return {
        ok: false,
        workbookId,
        error: parsed.error,
        sheets: 0,
        cellsIterated: 0,
        cellsInserted: 0,
        rowsInserted: 0,
        reviewsInserted: 0,
        rowsNeedingReview: 0,
      };
    }

    const sheets = listSheets(parsed.workbook);
    let cellsIterated = 0;
    let cellsInserted = 0;
    let rowsInserted = 0;
    let reviewsInserted = 0;
    const allFlaggedRowIds: string[] = [];

    for (const s of sheets) {
      const sheetRes = await client.query(
        `insert into public.source_sheets
           (workbook_id, sheet_name, sheet_name_normalized, sheet_index,
            used_range, row_count, column_count, detected_type, parse_confidence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          workbookId,
          s.sheetName,
          s.sheetNameNormalized,
          s.sheetIndex,
          s.usedRange,
          s.rowCount,
          s.columnCount,
          s.detectedType,
          s.parseConfidence,
        ],
      );
      const sheetId: string = sheetRes.rows[0].id;

      const ws = parsed.workbook.Sheets[s.sheetName];
      const cells = sheetCells(ws);
      cellsIterated += cells.length;
      cellsInserted += await insertCells(client, workbookId, sheetId, cells);

      const rows = cellsToRows(cells);
      const idByRow = await insertRows(client, workbookId, sheetId, s.detectedType, rows);
      rowsInserted += idByRow.size;

      let issues: ReviewIssue[] = [];
      if (s.detectedType === "payment_day_matrix") {
        issues = extractPaymentMatrix(rows).issues;
      } else if (s.detectedType === "checks") {
        issues = extractChecks(rows).issues;
      } else if (s.detectedType === "monthly_cashflow") {
        issues = extractMonthlyCashflow(s.sheetName, cellsToMap(cells)).issues;
      } else if (s.detectedType === "loan_calculation") {
        issues = extractLoan(cellsToMap(cells)).issues;
      } else if (s.detectedType === "capacity") {
        issues = extractCapacity(cellsToMap(cells)).issues;
      } else if (s.detectedType === "cost_model_normal") {
        issues = extractCostModel(cellsToMap(cells), "normal").issues;
      } else if (s.detectedType === "cost_model_overtime") {
        issues = extractCostModel(cellsToMap(cells), "overtime").issues;
      } else if (s.detectedType === "machine_roi") {
        issues = extractMachineRoi(cellsToMap(cells)).issues;
      }
      const r = await insertReviews(client, workbookId, sheetId, idByRow, issues);
      reviewsInserted += r.reviews;
      allFlaggedRowIds.push(...r.flaggedRowIds);
    }

    if (allFlaggedRowIds.length > 0) {
      await client.query(
        `update public.import_rows set mapping_status='needs_review' where id = any($1::uuid[])`,
        [allFlaggedRowIds],
      );
    }
    await client.query(
      `update public.source_workbooks set status='parsed',
         notes = $2
       where id=$1`,
      [
        workbookId,
        `sheets=${sheets.length} cells=${cellsInserted} rows=${rowsInserted} reviews=${reviewsInserted}`,
      ],
    );
    await client.query("commit");
    return {
      ok: true,
      workbookId,
      sheets: sheets.length,
      cellsIterated,
      cellsInserted,
      rowsInserted,
      reviewsInserted,
      rowsNeedingReview: allFlaggedRowIds.length,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
