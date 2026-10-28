// Standart Import V2 — hücre değeri normalizasyonu.
//
// BU DOSYANIN TEK İŞİ: bir Excel hücresini güvenli bir değere çevirmek ya da "çeviremedim"
// demek. Üçüncü bir seçenek yok — özellikle "emin değilim, 0 diyeyim" seçeneği yok.
//
// ═══ NEDEN AYRI BİR MODÜL ═══
//
// P24B sonrası mutabakat denetiminde ölçülen şuydu: legacy veride 308 ödeme örneğinin tutarı
// NULL ve bu NULL'lar toplamlara girmiyor, "bilinmeyen" olarak ayrı sayılıyor. Bu davranış
// doğru ve korunmalı. Tek bir `Number(v) || 0` ifadesi onu sessizce bozar: boş hücre 0 olur,
// nakit açığı olduğundan iyi görünür. Bu yüzden dönüşüm tek yerde toplanmış ve her fonksiyon
// `null` ile `0`'ı ayrı taşıyan bir sonuç tipi döndürüyor.
//
// ═══ BELİRSİZLİK SESSİZ ÇÖZÜLMEZ ═══
//
// `01/02/03` gibi bir tarih üç farklı gün olabilir. `35.000` Türkçe'de 35 bin, İngilizce'de
// 35 tam 0 demektir. Bu modül belirsizliği ya reddeder ya da çözer AMA `ambiguous` bayrağıyla
// işaretler; çağıran taraf inceleme açar. Hiçbir belirsizlik iz bırakmadan kapanmaz.

export type ParseStatus = "ok" | "blank" | "invalid" | "ambiguous";

export interface ParsedValue<T> {
  status: ParseStatus;
  /** `status === "ok"` iken dolu; "blank" iken null (bilinmiyor). */
  value: T | null;
  /** Kullanıcıya ve inceleme kaydına gidecek açıklama. */
  reason?: string;
  /** Ham girdi — inceleme kaydında saklanır. */
  raw?: unknown;
}

const ok = <T>(value: T, raw?: unknown): ParsedValue<T> => ({ status: "ok", value, raw });
const blank = <T>(raw?: unknown): ParsedValue<T> => ({ status: "blank", value: null, raw });
const invalid = <T>(reason: string, raw?: unknown): ParsedValue<T> => ({ status: "invalid", value: null, reason, raw });
const ambiguous = <T>(value: T, reason: string, raw?: unknown): ParsedValue<T> =>
  ({ status: "ambiguous", value, reason, raw });

/**
 * Boş sayılan girdiler.
 *
 * `"-"` bilinçli olarak boş sayılıyor: Türkçe tablolarda "veri yok" için yaygın bir işaret ve
 * onu 0 saymak bu modülün var oluş sebebine aykırı olurdu. Sözleşmede (docs/standard-import-v2.md)
 * açıkça yazılı.
 */
export function isBlank(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "string") {
    const t = raw.trim();
    return t === "" || t === "-" || t === "—" || t === "–";
  }
  return false;
}

/**
 * Standart Excel formül hata belirteçleri ve Türkçe karşılıkları.
 * Faz 3 (§Fuzzy Parsing): müşteri dosyalarındaki formül hataları (#VALUE!, #REF!)
 * finansal hesaplamalarda toleransla 0 kabul edilir.
 */
export const EXCEL_FORMULA_ERRORS: ReadonlySet<string> = new Set([
  "#VALUE!", "#DEĞER!",
  "#REF!", "#BAŞV!",
  "#DIV/0!", "#SAYI/0!",
  "#NAME?", "#AD?",
  "#NUM!", "#SAYI!",
  "#NULL!", "#BOŞ!",
  "#N/A", "#YOK",
]);

export function isExcelFormulaError(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") {
    return EXCEL_FORMULA_ERRORS.has(value.trim().toUpperCase());
  }
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    if ("error" in o && typeof o.error === "string") {
      return true;
    }
  }
  return false;
}

/** ExcelJS zengin metin / formül hücrelerini düz değere indirger. */
export function unwrapCell(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if ("error" in o && typeof o.error === "string") {
      return o.error;
    }
    // Formül hücresi: son hesaplanmış değeri kullanılır. Excel ÇALIŞTIRILMAZ (§32).
    if ("result" in o) {
      if (isExcelFormulaError(o.result)) {
        const resObj = typeof o.result === "object" && o.result !== null ? (o.result as Record<string, unknown>) : null;
        return resObj && "error" in resObj ? resObj.error : o.result;
      }
      return unwrapCell(o.result);
    }
    if ("formula" in o && !("result" in o)) return null; // hesaplanmamış formül → bilinmiyor
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    }
    if ("text" in o && typeof o.text === "string") return o.text;
    if (o instanceof Date) return o;
  }
  return raw;
}

/* ── Metin ───────────────────────────────────────────────────────────────────────────── */

export function parseText(raw: unknown): ParsedValue<string> {
  const v = unwrapCell(raw);
  if (isBlank(v)) return blank(raw);
  if (isExcelFormulaError(v)) return blank(raw);
  const s = String(v).trim();
  return s === "" ? blank(raw) : ok(s, raw);
}

/* ── Sayı ve para ────────────────────────────────────────────────────────────────────── */

const CURRENCY_TOKENS = ["₺", "tl", "try", "$", "usd", "€", "eur", "£", "gbp"];

/** Para/sayı metninden birim ve boşluk temizler; işareti korur. */
function stripNumericNoise(s: string): string {
  let t = s.trim().toLocaleLowerCase("tr-TR");
  for (const tok of CURRENCY_TOKENS) t = t.split(tok).join("");
  // Parantezli negatif muhasebe gösterimi: (1.234) = -1234
  const paren = /^\(\s*(.+?)\s*\)$/.exec(t.trim());
  if (paren) return "-" + paren[1].replace(/[\s ]/g, "");
  return t.replace(/[\s ]/g, "");
}

/**
 * Türk ve İngiliz sayı biçimlerini ayırt eder.
 *
 * Kural:
 *   · İki ayırıcı da varsa SONUNCUSU ondalıktır.  1.234,56 → 1234.56   1,234.56 → 1234.56
 *   · Tek ayırıcı birden fazla kez geçiyorsa binliktir.  1.234.567 → 1234567
 *   · Tek ayırıcı bir kez geçiyorsa:
 *       – ardından 3 hane YOKSA ondalıktır.   35000,5 → 35000.5   35000.50 → 35000.50
 *       – ardından tam 3 hane VARSA belirsizdir: 35.000 hem "35 bin" hem "35,000" olabilir.
 *         Türkçe bağlamda binlik okunur ama `ambiguous` işaretlenir — sessizce geçilmez.
 */
export function parseNumberString(s: string): ParsedValue<number> {
  const t = stripNumericNoise(s);
  if (t === "" || t === "-") return invalid("sayı okunamadı", s);
  if (!/^[-+]?[0-9.,]+$/.test(t)) return invalid("sayı olmayan karakter içeriyor", s);

  const neg = t.startsWith("-");
  const body = t.replace(/^[-+]/, "");
  const dots = (body.match(/\./g) ?? []).length;
  const commas = (body.match(/,/g) ?? []).length;

  const toNumber = (digits: string): number => {
    const n = Number(digits);
    return neg ? -n : n;
  };

  if (dots > 0 && commas > 0) {
    const lastDot = body.lastIndexOf(".");
    const lastComma = body.lastIndexOf(",");
    const decSep = lastDot > lastComma ? "." : ",";
    const thouSep = decSep === "." ? "," : ".";
    const cleaned = body.split(thouSep).join("").replace(decSep, ".");
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return invalid("karışık ayırıcı biçimi çözülemedi", s);
    return ok(toNumber(cleaned), s);
  }

  const sep = dots > 0 ? "." : commas > 0 ? "," : null;
  if (sep === null) {
    if (!/^\d+$/.test(body)) return invalid("sayı okunamadı", s);
    return ok(toNumber(body), s);
  }

  const parts = body.split(sep);
  const count = sep === "." ? dots : commas;

  if (count > 1) {
    // Birden fazla ayırıcı → binlik. Grupların 3'er hane olması beklenir.
    const groupsValid = parts.slice(1).every((p) => /^\d{3}$/.test(p)) && /^\d{1,3}$/.test(parts[0]);
    if (!groupsValid) return invalid("binlik ayırıcı grupları 3 haneli değil", s);
    return ok(toNumber(parts.join("")), s);
  }

  const [head, tail] = parts;
  if (!/^\d+$/.test(head) || !/^\d+$/.test(tail)) return invalid("sayı okunamadı", s);

  if (tail.length !== 3) {
    // 3 hane değilse ondalık okunur — binlik grup 3 haneli olmak zorunda.
    return ok(toNumber(`${head}.${tail}`), s);
  }

  // Tam 3 hane: belirsiz. Türkçe bağlamda binlik çözülür, ama işaretlenir.
  return ambiguous(
    toNumber(head + tail),
    `'${s}' hem binlik (${head + tail}) hem ondalık (${head}.${tail}) okunabilir; ` +
      "Türkçe biçim varsayılarak binlik alındı",
    s,
  );
}

/**
 * Para/sayı hücresi.
 *
 * Hücre GERÇEKTEN sayısal ise (Excel numeric cell) o değer doğrudan kullanılır — biçim
 * belirsizliği diye bir şey yoktur. Yalnız metin hücrelerde ayrıştırma yapılır.
 */
export function parseNumber(raw: unknown): ParsedValue<number> {
  const v = unwrapCell(raw);
  if (isBlank(v)) return blank(raw);
  if (isExcelFormulaError(v)) {
    const vObj = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
    const errStr = vObj && "error" in vObj ? String(vObj.error) : String(v);
    return ambiguous(0, `Excel formül hatası (${errStr}) 0 kabul edildi`, raw);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return invalid("sonlu olmayan sayı", raw);
    return ok(v, raw);
  }
  if (typeof v === "boolean") return invalid("sayı beklenirken mantıksal değer bulundu", raw);
  if (v instanceof Date) return invalid("sayı beklenirken tarih bulundu", raw);
  return parseNumberString(String(v));
}

export function parseInteger(raw: unknown): ParsedValue<number> {
  const n = parseNumber(raw);
  if (n.status === "blank" || n.status === "invalid") return n;
  if (n.value === null) return n;
  if (!Number.isInteger(n.value)) return invalid(`tam sayı beklendi, ${n.value} bulundu`, raw);
  return n;
}

/* ── Tarih ───────────────────────────────────────────────────────────────────────────── */

/** Excel seri numarası → ISO tarih. Epoch 1899-12-30 (1900 artık yıl hatası dahil). */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function isoFrom(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Tarih hücresi → ISO (YYYY-MM-DD).
 *
 * Belirsiz biçimler TAHMİN EDİLMEZ. `01/02/03` üç farklı gün olabilir; bu modül onu reddeder.
 * `31/07/2026` gibi gün > 12 olan ayırıcılı biçimler tek okumaya sahip olduğu için kabul edilir.
 */
export function parseDate(raw: unknown): ParsedValue<string> {
  const v = unwrapCell(raw);
  if (isBlank(v)) return blank(raw);

  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return invalid("geçersiz tarih", raw);
    // ExcelJS tarihi UTC olarak verir; gün kaymasın diye UTC bileşenleri kullanılır.
    return ok(v.toISOString().slice(0, 10), raw);
  }

  if (typeof v === "number") {
    const iso = excelSerialToISO(v);
    return iso ? ok(iso, raw) : invalid(`Excel tarih serisi aralık dışı: ${v}`, raw);
  }

  const s = String(v).trim();

  // ISO — tek okuma.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const r = isoFrom(+iso[1], +iso[2], +iso[3]);
    return r ? ok(r, raw) : invalid(`geçersiz tarih: ${s}`, raw);
  }

  // Ayırıcılı: gg.aa.yyyy / gg/aa/yyyy / gg-aa-yyyy — 4 haneli yıl → tek okuma.
  const dmy4 = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (dmy4) {
    const d = +dmy4[1], m = +dmy4[2], y = +dmy4[3];
    if (d > 12 && m > 12) return invalid(`geçersiz tarih: ${s}`, raw);
    if (m > 12 && d <= 12) {
      // Ay > 12 ise sıra aa/gg olmalı — yine tek okuma.
      const r = isoFrom(y, d, m);
      return r ? ok(r, raw) : invalid(`geçersiz tarih: ${s}`, raw);
    }
    if (d > 12) {
      const r = isoFrom(y, m, d);
      return r ? ok(r, raw) : invalid(`geçersiz tarih: ${s}`, raw);
    }
    // Hem gün hem ay ≤ 12: gg.aa.yyyy Türkçe okunur, ama işaretlenir.
    const r = isoFrom(y, m, d);
    if (!r) return invalid(`geçersiz tarih: ${s}`, raw);
    return ambiguous(r, `'${s}' hem gg/aa hem aa/gg okunabilir; Türkçe biçim (gün/ay) varsayıldı`, raw);
  }

  // 2 haneli yıl → hangi yüzyıl, hangi sıra belli değil. Tahmin edilmez.
  if (/^\d{1,2}[./-]\d{1,2}[./-]\d{1,2}$/.test(s)) {
    return invalid(`belirsiz tarih biçimi: '${s}'. Lütfen YYYY-AA-GG yazın.`, raw);
  }

  return invalid(`tarih okunamadı: '${s}'. Lütfen YYYY-AA-GG yazın.`, raw);
}

/** Dönem hücresi → YYYY-MM. */
export function parseMonth(raw: unknown): ParsedValue<string> {
  const v = unwrapCell(raw);
  if (isBlank(v)) return blank(raw);

  if (v instanceof Date) return ok(v.toISOString().slice(0, 7), raw);
  if (typeof v === "number") {
    const iso = excelSerialToISO(v);
    return iso ? ok(iso.slice(0, 7), raw) : invalid(`Excel tarih serisi aralık dışı: ${v}`, raw);
  }

  const s = String(v).trim();
  const m = /^(\d{4})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const mm = +m[2];
    if (mm < 1 || mm > 12) return invalid(`geçersiz ay: ${s}`, raw);
    return ok(`${m[1]}-${String(mm).padStart(2, "0")}`, raw);
  }
  const full = parseDate(raw);
  if (full.status === "ok" && full.value) return ok(full.value.slice(0, 7), raw);
  return invalid(`dönem okunamadı: '${s}'. Lütfen YYYY-AA yazın (örn. 2026-05).`, raw);
}

/* ── Enum / mantıksal ────────────────────────────────────────────────────────────────── */

export function parseEnum(raw: unknown, allowed: readonly string[]): ParsedValue<string> {
  const t = parseText(raw);
  if (t.status !== "ok" || t.value === null) return t;
  const needle = t.value.toLocaleLowerCase("tr-TR");
  for (const a of allowed) {
    if (a.toLocaleLowerCase("tr-TR") === needle) return ok(a, raw);
  }
  return invalid(`geçersiz değer '${t.value}'. İzin verilenler: ${allowed.join(", ")}`, raw);
}

const TRUE_TOKENS = ["evet", "e", "true", "doğru", "dogru", "x", "var", "aktif", "1"];
const FALSE_TOKENS = ["hayır", "hayir", "h", "false", "yanlış", "yanlis", "yok", "pasif", "0"];

export function parseBoolean(raw: unknown): ParsedValue<boolean> {
  const v = unwrapCell(raw);
  if (isBlank(v)) return blank(raw);
  if (typeof v === "boolean") return ok(v, raw);
  if (typeof v === "number") {
    if (v === 1) return ok(true, raw);
    if (v === 0) return ok(false, raw);
    return invalid(`mantıksal değer beklendi, ${v} bulundu`, raw);
  }
  const s = String(v).trim().toLocaleLowerCase("tr-TR");
  if (TRUE_TOKENS.includes(s)) return ok(true, raw);
  if (FALSE_TOKENS.includes(s)) return ok(false, raw);
  return invalid(`mantıksal değer okunamadı: '${v}'. EVET veya HAYIR yazın.`, raw);
}

/** Yüzde alanı: sözleşme gereği ham sayı olarak saklanır (%3,14 → 3.14). */
export function parsePercent(raw: unknown): ParsedValue<number> {
  const v = unwrapCell(raw);
  if (isBlank(v)) return blank(raw);
  if (typeof v === "string" && v.includes("%")) {
    return parseNumberString(v.replace(/%/g, ""));
  }
  return parseNumber(raw);
}
