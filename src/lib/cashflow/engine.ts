// Phase 4 engine. Eligibility mirrors Phase 3 semantics (docs/calculation-rules.md):
// month-level open/rejected issue (header/identity, rowIndex 1) → whole month excluded;
// line-level open/rejected issue → only that line excluded; everything else maps.
// Reconciliation rule: cashflow_months values must equal source header cells; the
// importer stores what the extractor read from source, so reconciliation is enforced
// by construction and re-verified in scripts/phase4-verify.ts against source_cells.

import type { Pool } from "pg";
import { extractMonthlyCashflow } from "@/lib/importers/extractors";
import type { CellVal, RowJson } from "@/lib/importers/row-utils";
import {
  buildProjection,
  findContinuityIssues,
  horizonCards,
  type CashMonth,
} from "@/lib/radar/rules";

async function audit(
  client: import("pg").PoolClient,
  action: string,
  entityTable: string,
  entityId: string | null,
  after: unknown,
): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null,$1,$2,$3,null,$4)`,
    [action, entityTable, entityId, JSON.stringify(after ?? null)],
  );
}

export interface CashflowMapResult {
  monthsCreated: number;
  monthsSkippedExisting: number;
  monthsExcluded: Array<{ sheet: string; reason: string }>;
  linesCreated: number;
  linesExcluded: number;
}

export async function mapCashflowMonths(pool: Pool, workbookId: string): Promise<CashflowMapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets
       where workbook_id=$1 and detected_type='monthly_cashflow' order by sheet_index`,
      [workbookId],
    );
    const res: CashflowMapResult = {
      monthsCreated: 0, monthsSkippedExisting: 0, monthsExcluded: [],
      linesCreated: 0, linesExcluded: 0,
    };

    for (const sheet of sheets.rows) {
      const rowsRes = await client.query<{ id: string; row_index: number; row_json: RowJson }>(
        `select id, row_index, row_json from public.import_rows where sheet_id=$1 order by row_index`,
        [sheet.id],
      );
      const idByRow = new Map(rowsRes.rows.map((r) => [r.row_index, r.id]));
      const cellMap: Record<string, CellVal> = {};
      for (const r of rowsRes.rows)
        for (const [col, cell] of Object.entries(r.row_json)) cellMap[`${col}${r.row_index}`] = cell;

      const data = extractMonthlyCashflow(sheet.sheet_name, cellMap);
      if (!data.monthStart) {
        res.monthsExcluded.push({ sheet: sheet.sheet_name, reason: "ay adı çözülemedi" });
        continue;
      }

      // blocking reviews for this sheet
      const blocked = await client.query<{ import_row_id: string | null; issue_type: string }>(
        `select mr.import_row_id, mr.issue_type from public.mapping_reviews mr
         where mr.sheet_id=$1 and mr.status in ('open','rejected')`,
        [sheet.id],
      );
      const headerRowId = idByRow.get(1) ?? null;
      const monthBlocked = blocked.rows.some(
        (b) =>
          b.issue_type === "cashflow_identity_mismatch" ||
          b.issue_type === "cashflow_header_missing" ||
          (b.import_row_id != null && b.import_row_id === headerRowId),
      );
      if (monthBlocked) {
        res.monthsExcluded.push({ sheet: sheet.sheet_name, reason: "açık/ret ay-seviyesi inceleme" });
        continue;
      }
      const blockedRowIds = new Set(
        blocked.rows.map((b) => b.import_row_id).filter((x): x is string => !!x),
      );

      const ins = await client.query(
        `insert into public.cashflow_months
           (month_start, source_workbook_id, source_sheet_id,
            opening_balance, projected_income, projected_expense, monthly_delta, closing_balance,
            confidence, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'source_imported','draft')
         on conflict (month_start) do nothing
         returning id`,
        [data.monthStart, workbookId, sheet.id,
         data.opening, data.income, data.expense, data.delta, data.closing],
      );
      if (ins.rowCount === 0) {
        res.monthsSkippedExisting++;
        continue;
      }
      const monthId: string = ins.rows[0].id;
      res.monthsCreated++;

      for (const line of data.lines) {
        const rowId = idByRow.get(line.rowIndex) ?? null;
        if (rowId && blockedRowIds.has(rowId)) {
          res.linesExcluded++;
          continue;
        }
        await client.query(
          `insert into public.cashflow_lines
             (cashflow_month_id, source_row_id, line_type, direction, party_id, label, amount, amount_status)
           values ($1,$2,$3,$4,
                   (select id from public.parties where normalized_name = lower(replace(replace($5,'İ','i'),'I','ı')) limit 1),
                   $5,$6,$7)`,
          [monthId, rowId, line.line_type, line.direction, line.label, line.amount,
           line.amount == null ? "missing" : "known"],
        );
        res.linesCreated++;
        if (rowId) {
          await client.query(
            `update public.import_rows set mapping_status='mapped',
               mapped_entity_table='cashflow_lines', mapped_entity_id=null
             where id=$1 and mapping_status <> 'mapped'`,
            [rowId],
          );
        }
      }
      await audit(client, "map_cashflow_month", "cashflow_months", monthId, {
        month: data.monthStart, sheet: sheet.sheet_name,
        lines: data.lines.length,
      });
    }
    await client.query("commit");
    return res;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function loadCashMonths(pool: Pool): Promise<Array<CashMonth & { id: string; status: string; sheetId: string | null; workbookId: string | null }>> {
  const r = await pool.query(`
    select id, to_char(month_start,'YYYY-MM-DD') as month_start,
           opening_balance::float8 as opening, projected_income::float8 as income,
           projected_expense::float8 as expense, closing_balance::float8 as closing,
           status, source_sheet_id as "sheetId", source_workbook_id as "workbookId"
    from public.cashflow_months order by month_start`);
  return r.rows.map((x) => ({
    id: x.id, monthStart: x.month_start, opening: x.opening, income: x.income,
    expense: x.expense, closing: x.closing, status: x.status,
    sheetId: x.sheetId, workbookId: x.workbookId,
  }));
}

/** Flags continuity breaks/gaps as mapping_reviews. NEVER mutates month values. */
export async function validateContinuity(pool: Pool): Promise<{ breaks: number; gaps: number; newReviews: number }> {
  const months = await loadCashMonths(pool);
  const { breaks, gaps } = findContinuityIssues(months);
  const client = await pool.connect();
  let newReviews = 0;
  try {
    await client.query("begin");
    for (const b of breaks) {
      const next = months.find((m) => m.monthStart === b.nextMonth)!;
      if (!next.workbookId || !next.sheetId) continue;
      const msg = `Devir zinciri kırık: ${b.prevMonth.slice(0, 7)} kasa ${b.prevClosing ?? "?"} ≠ ${b.nextMonth.slice(0, 7)} devir ${b.nextOpening ?? "?"}${b.diff != null ? ` (fark ${b.diff})` : ""}`;
      const ins = await client.query(
        `insert into public.mapping_reviews (workbook_id, sheet_id, issue_type, severity, message)
         select $1,$2,'continuity_break','high',$3
         where not exists (select 1 from public.mapping_reviews
                           where sheet_id=$2 and issue_type='continuity_break' and status='open')`,
        [next.workbookId, next.sheetId, msg],
      );
      newReviews += ins.rowCount ?? 0;
    }
    for (const g of gaps) {
      const prev = months.find((m) => m.monthStart === g.afterMonth)!;
      if (!prev.workbookId || !prev.sheetId) continue;
      const ins = await client.query(
        `insert into public.mapping_reviews (workbook_id, sheet_id, issue_type, severity, message)
         select $1,$2,'month_gap','medium',$3
         where not exists (select 1 from public.mapping_reviews
                           where sheet_id=$2 and issue_type='month_gap' and status='open')`,
        [prev.workbookId, prev.sheetId, `Ay boşluğu: ${g.afterMonth.slice(0, 7)} sonrası ${g.expected.slice(0, 7)} yok`],
      );
      newReviews += ins.rowCount ?? 0;
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  return { breaks: breaks.length, gaps: gaps.length, newReviews };
}

export async function writeSnapshots(pool: Pool, todayISO: string): Promise<number> {
  const months = await loadCashMonths(pool);
  if (months.length === 0) return 0;
  const anchor = todayISO.slice(0, 7) + "-01";
  const cards = horizonCards(months, anchor);
  const proj = buildProjection(months);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`delete from public.cashflow_snapshots where snapshot_date = $1`, [todayISO]);
    for (const c of cards) {
      await client.query(
        `insert into public.cashflow_snapshots
           (snapshot_date, horizon_months, total_projected_income, total_projected_expense,
            final_projected_balance, first_negative_month, worst_month, worst_balance)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [todayISO, c.horizonMonths, c.knownIncome, c.knownExpense, c.endClosing,
         proj.firstNegativeMonth, proj.worstMonth, proj.worstBalance],
      );
    }
    await client.query("commit");
    return cards.length;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
