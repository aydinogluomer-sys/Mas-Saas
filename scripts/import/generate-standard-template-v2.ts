// MAS Nakit Radar — Standart Import V2 şablon üreteci (CLI).
//
// Üretim mantığı `src/lib/importers/v2/template.ts`'tedir; bu dosya yalnız komut satırı
// kabuğudur. Kullanım:  pnpm import:template:v2  [--out <yol>]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DATA_SHEETS, SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION } from "../../src/lib/importers/v2/contract";
import { buildTemplateBuffer, buildTemplateWorkbook, TEMPLATE_FILENAME } from "../../src/lib/importers/v2/template";

export { buildTemplateBuffer, buildTemplateWorkbook };

async function main(): Promise<void> {
  const outArg = process.argv.indexOf("--out");
  const out = outArg > -1 && process.argv[outArg + 1]
    ? process.argv[outArg + 1]
    : path.join("templates", TEMPLATE_FILENAME);

  const { buffer: buf, workbook: wb, zipEntries } = await buildTemplateBuffer();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, buf);

  const sha = createHash("sha256").update(buf).digest("hex");
  console.log(`şablon yazıldı : ${out}`);
  console.log(`bayt           : ${buf.length}`);
  console.log(`sha256         : ${sha}`);
  console.log(`sayfa          : ${wb.worksheets.length} (${DATA_SHEETS.length} veri + README + ÖRNEKLER + META)`);
  console.log(`zip girdisi    : ${zipEntries} (zaman damgaları 2026-01-01T00:00:00Z'ye sabitlendi)`);
  console.log(`şema           : ${SCHEMA_NAME} v${SCHEMA_VERSION} · şablon ${TEMPLATE_VERSION}`);
}

if (process.argv[1] && process.argv[1].includes("generate-standard-template-v2")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
