// Phase 0 spike runner: parse given workbooks, classify every sheet,
// document failures, and emit docs/phase0-parse-report.md as evidence.
// Usage: pnpm spike <file...>

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listSheets, safeParseWorkbook } from "../src/lib/importers/workbook-parser";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: pnpm spike <workbook.xlsx> [...]");
  process.exit(2);
}

const lines: string[] = [
  "# Phase 0 Parse Report",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "Evidence for implementation.md §20 Phase 0 verification:",
  "list all sheets · classify each sheet · no silent discard · invalid workbook failure documented.",
  "",
];

let hadFailure = false;

for (const file of files) {
  const name = basename(file);
  let sha = "n/a";
  try {
    sha = createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16) + "…";
  } catch {
    /* read error handled below by safeParseWorkbook */
  }
  const res = safeParseWorkbook(file);
  lines.push(`## ${name}`, "", `- sha256(16): \`${sha}\``, `- size: ${res.fileSize} bytes`);
  if (!res.ok) {
    hadFailure = true;
    lines.push(`- status: **PARSE FAILED**`, `- error: \`${res.error}\``, "");
    console.log(`✗ ${name}: ${res.error}`);
    continue;
  }
  const sheets = listSheets(res.workbook);
  lines.push(`- status: parsed`, `- sheets: ${sheets.length} (all listed, none discarded)`, "");
  lines.push("| # | sheet | type | conf | range | rows | cols |");
  lines.push("|--:|---|---|---|---|--:|--:|");
  const counts: Record<string, number> = {};
  for (const s of sheets) {
    counts[s.detectedType] = (counts[s.detectedType] ?? 0) + 1;
    lines.push(
      `| ${s.sheetIndex} | ${s.sheetName} | ${s.detectedType} | ${s.parseConfidence} | ${s.usedRange ?? "-"} | ${s.rowCount} | ${s.columnCount} |`,
    );
  }
  lines.push("", `Type counts: ${JSON.stringify(counts)}`, "");
  console.log(`✓ ${name}: ${sheets.length} sheets — ${JSON.stringify(counts)}`);
}

writeFileSync("docs/phase0-parse-report.md", lines.join("\n"));
console.log(`report → docs/phase0-parse-report.md${hadFailure ? " (includes documented failure)" : ""}`);
