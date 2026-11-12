// Faz 41 (B1) — Deterministic RFC-4180 CSV/TSV parser with UTF-8 BOM & Turkish windows-1254 support.
//
// Why this exists:
//   1. Eliminates the last dependency on unpatched `xlsx@0.18.5` for bank statement CSV parsing.
//   2. Quote-aware delimiter detection: never mistakes decimal commas inside quoted `"1.234,56"`
//      for column separators.
//   3. Preserves every cell as its exact trimmed text (explicit `"0,00"` stays `"0,00"`, never `null`
//      or `0`), letting `src/lib/bank/rules.ts` perform exact decimal/date disambiguation.
//   4. Decodes UTF-8 strictly first, falling back to Turkish `windows-1254` (`iso-8859-9`) when
//      a Turkish bank portal exports legacy 8-bit characters (`İ`, `Ş`, `Ğ`, `Ü`, `Ö`, `Ç`).

export type CsvDelimiter = ";" | "\t" | ",";

export type CsvParseResult =
  | {
      ok: true;
      delimiter: CsvDelimiter;
      encoding: "utf-8" | "windows-1254";
      rows: string[][];
    }
  | {
      ok: false;
      error: string;
    };

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  return sample.includes(0x00);
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function decodeTurkishCsvBuffer(buf: Buffer): { text: string; encoding: "utf-8" | "windows-1254" } {
  try {
    const utf8 = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text: stripBom(utf8), encoding: "utf-8" };
  } catch {
    try {
      const tr = new TextDecoder("windows-1254").decode(buf);
      return { text: stripBom(tr), encoding: "windows-1254" };
    } catch {
      return { text: stripBom(buf.toString("latin1")), encoding: "windows-1254" };
    }
  }
}

/**
 * Counts candidate delimiters OUTSIDE double-quoted spans on the first non-empty logical line.
 * Prevents `"1.234,56"` inside a comma/semicolon file from inflating comma count.
 */
export function detectCsvDelimiter(text: string): CsvDelimiter | null {
  const cleaned = stripBom(text);
  const lines = cleaned.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim() !== "");
  if (!firstLine) return null;

  let inQuotes = false;
  let semicolons = 0;
  let tabs = 0;
  let commas = 0;

  for (let i = 0; i < firstLine.length; i++) {
    const ch = firstLine[i];
    if (ch === '"') {
      if (inQuotes && firstLine[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (inQuotes) continue;
    if (ch === ";") semicolons += 1;
    else if (ch === "\t") tabs += 1;
    else if (ch === ",") commas += 1;
  }

  const counts: Array<[CsvDelimiter, number]> = [
    [";", semicolons],
    ["\t", tabs],
    [",", commas],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : null;
}

/**
 * Deterministic RFC-4180 state-machine parser.
 */
export function parseDelimitedText(text: string, delimiter: CsvDelimiter): string[][] {
  const src = stripBom(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;

  const pushField = () => {
    row.push(fieldWasQuoted ? field : field);
    field = "";
    fieldWasQuoted = false;
  };

  const pushRow = () => {
    // Ignore trailing completely blank newline at EOF
    if (row.length === 1 && row[0] === "" && field === "") {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      fieldWasQuoted = true;
      continue;
    }

    if (ch === delimiter) {
      pushField();
      continue;
    }

    if (ch === "\r") {
      if (src[i + 1] === "\n") i += 1;
      pushField();
      pushRow();
      continue;
    }

    if (ch === "\n") {
      pushField();
      pushRow();
      continue;
    }

    field += ch;
  }

  if (inQuotes) {
    throw new Error("CSV içinde kapatılmamış çift tırnak alanı var.");
  }

  if (field !== "" || fieldWasQuoted || row.length > 0) {
    pushField();
    pushRow();
  }

  return rows;
}

export function parseCsvStatementBuffer(buf: Buffer): CsvParseResult {
  if (buf.length === 0) {
    return { ok: false, error: "empty file (0 bytes)" };
  }
  if (looksBinary(buf)) {
    return {
      ok: false,
      error: "CSV uzantılı ama ikili (NUL bayt) içerik — bozuk ya da yanlış adlandırılmış dosya",
    };
  }

  const { text, encoding } = decodeTurkishCsvBuffer(buf);
  if (text.trim() === "") {
    return { ok: false, error: "CSV boş" };
  }

  const delimiter = detectCsvDelimiter(text);
  if (!delimiter) {
    return {
      ok: false,
      error: "CSV ayırıcı bulunamadı (';', ',' veya sekme bekleniyor) — tek sütunlu bir ekstre okunamaz",
    };
  }

  try {
    const rows = parseDelimitedText(text, delimiter);
    if (rows.length === 0) {
      return { ok: false, error: "CSV ayrıştırıldı ama sayfa üretmedi" };
    }
    return { ok: true, delimiter, encoding, rows };
  } catch (e) {
    return { ok: false, error: `CSV ayrıştırma başarısız: ${(e as Error).message}` };
  }
}

