---
name: mas-excel-data-auditor
description: Audit MAS Excel workbooks before implementation. Use when importing, mapping, or debugging Excel/PDF-like cash-flow and payment source data.
allowed-tools: Read Grep Bash
---

# MAS Excel Data Auditor

Audit the source workbook before any normalization.

Required output:

1. `docs/data-map.md` with:
   - workbook filename and checksum
   - all sheet names
   - used ranges
   - detected table regions
   - header candidates
   - row type candidates
   - payment candidate rows
   - amount-like cells
   - due-day columns/cells
   - X-mark payment day markers
   - provider/bank candidates
   - owner/person candidates
   - category candidates
   - anomalies
2. A concise recommendation for mapping into:
   - `source_workbooks`
   - `source_sheets`
   - `source_cells`
   - `import_rows`
   - `payments`
   - `payment_instances`

Rules:

- Do not discard any source sheet/cell.
- Preserve raw data first; normalize second.
- Treat missing amount as unknown, not zero.
- Flag negative amounts.
- Flag unlabeled amount-like values.
- Flag multiple due days on one row.
- Flag duplicate-looking payment names.
- If workbook cannot parse, write exact technical failure into `docs/data-map.md` and stop import implementation until a valid file exists.
