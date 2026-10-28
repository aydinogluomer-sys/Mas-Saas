// Standart Import V2 — ürün akışı servisi (plan PHASE 4).
//
// `/data/imports/v2` sayfasının arkasındaki tek katman. Çerçeveden bağımsızdır (Next yok,
// FormData yok) ki dosya güvenliği, önizleme sayaçları ve onay-eşleşmesi veritabanı olmadan
// test edilebilsin. Sayfa yalnız FormData'yı Buffer'a çevirir ve buradaki fonksiyonları çağırır.
//
// AKIŞ (plan §4.1):
//   şablon indir → dosya yükle → şema tespiti → parse+validate → ÖNİZLEME (dryRun)
//   → inceleme listeleri → KULLANICI ONAYI → tek transaction import → sonuç + provenance
//
// ÖNİZLEME İLE ONAY AYNI DOSYA MI? Sunucu yüklenen dosyayı iki istek arasında SAKLAMAZ (disk
// yolu = path traversal yüzeyi, temizlik sorunu, "kim neyi ne zaman sildi" sorusu). Bunun yerine
// onay isteği dosyayı YENİDEN gönderir ve önizlemede gösterilen SHA256'yı da taşır; sunucu
// yeniden hesaplar ve eşleşmiyorsa yazmadan durur. "Önizlediğin dosya ile yazdığın dosya aynı"
// iddiası böylece bir kriptografik özetle kanıtlanır, oturum durumuna güvenilmez.
import { createHash } from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import type { Pool, PoolClient } from "pg";
import { APP_ROLES, ROLE_LABEL, can, type AppRole } from "@/lib/authz/matrix";
import { DATA_SHEETS } from "./contract";
import {
  ExternalKeyBindingConflictError, StaleExternalKeyBindingError, mapWorkbook, type MapperResult,
} from "./mapper";
import {
  parseWorkbook, MERGED_CELLS_KEY, UNKNOWN_COLUMNS_KEY, type Issue, type WorkbookParseResult,
} from "./parser";

/* ── Sınırlar (plan §4.4) ─────────────────────────────────────────────────────────────── */

export const UPLOAD_LIMITS = Object.freeze({
  /** >50 MB → reddedilir. */
  maxBytes: 50 * 1024 * 1024,
  /** Veri sayfalarında toplam >100.000 satır → reddedilir. */
  maxRows: 100_000,
  /** Dosya adı en fazla bu kadar karakter; daha uzunu güvenilmez girdi sayılır. */
  maxFilenameLength: 200,
});

export const ALLOWED_EXTENSIONS: readonly string[] = Object.freeze([".xlsx"]);

export type RejectionCode =
  | "EMPTY_FILE" | "TOO_LARGE" | "BAD_EXTENSION" | "UNSAFE_FILENAME"
  | "CORRUPT_XLSX" | "NOT_V2_SCHEMA" | "TOO_MANY_ROWS"
  | "SHA_MISMATCH" | "STALE_BINDING" | "BINDING_CONFLICT" | "WRITE_FAILED" | "FORBIDDEN_SHEETS";

export interface Rejection {
  code: RejectionCode;
  /** Kullanıcıya gösterilen cümle — teknik ayrıntı değil, ne yapması gerektiği. */
  message: string;
  /** Kanıt/teşhis için; UI'da küçük puntoyla gösterilebilir. */
  detail?: string;
}

/* ── Dosya adı ve boyut ───────────────────────────────────────────────────────────────── */

/**
 * Yüklenen dosyanın adını güvenli bir görüntü adına indirger.
 *
 * Ad yalnız `source_workbooks.original_filename`'e yazılır ve ekranda gösterilir; ASLA bir disk
 * yolu oluşturmakta kullanılmaz. Yine de yol ayraçları, `..`, NUL ve kontrol karakterleri
 * REDDEDİLİR (kabul edilip temizlenmez): böyle bir ad ya bozuk bir istemcinin ya da bir
 * denemenin işaretidir ve "temizlenmiş" hâliyle kaydetmek o izi silerdi.
 */
export function safeFilename(name: string): { ok: true; name: string } | { ok: false; reason: string } {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { ok: false, reason: "dosya adı boş" };
  if (trimmed.length > UPLOAD_LIMITS.maxFilenameLength) return { ok: false, reason: `dosya adı ${UPLOAD_LIMITS.maxFilenameLength} karakterden uzun` };
  if (/[\\/]/.test(trimmed)) return { ok: false, reason: "dosya adında yol ayracı var" };
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return { ok: false, reason: "dosya adında '..' var" };
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return { ok: false, reason: "dosya adında kontrol karakteri var" };
  if (path.basename(trimmed) !== trimmed) return { ok: false, reason: "dosya adı bir yol gibi görünüyor" };
  return { ok: true, name: trimmed };
}

/** Bayt okunmadan önce verilebilecek kararlar: ad, uzantı, boyut. */
export function validateUploadMeta(input: { name: string; size: number }): Rejection | null {
  const fn = safeFilename(input.name);
  if (!fn.ok) {
    return { code: "UNSAFE_FILENAME", message: "Dosya adı kabul edilmedi. Dosyayı yeniden adlandırıp tekrar yükleyin.", detail: fn.reason };
  }
  const ext = path.extname(fn.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { code: "BAD_EXTENSION", message: `Yalnız ${ALLOWED_EXTENSIONS.join(", ")} kabul edilir. Standart şablonu indirip doldurun.`, detail: `uzantı: ${ext || "(yok)"}` };
  }
  if (input.size <= 0) return { code: "EMPTY_FILE", message: "Dosya boş.", detail: `${input.size} bayt` };
  if (input.size > UPLOAD_LIMITS.maxBytes) {
    return { code: "TOO_LARGE", message: `Dosya 50 MB sınırını aşıyor. Dosyayı bölüp parça parça yükleyin.`, detail: `${input.size} bayt` };
  }
  return null;
}

/* ── Güvenli açma ─────────────────────────────────────────────────────────────────────── */

/**
 * XLSX'i belleğe açar. Bozuk/başka türden dosya → temiz red; istisna dışarı sızmaz.
 *
 * FORMÜL YÜRÜTME YOK. ExcelJS formülleri HESAPLAMAZ: formül hücresi `{formula, result}` olarak
 * gelir ve `values.ts unwrapCell` yalnız önbelleğe alınmış `result`'ı okur, sonucu olmayan
 * formül `null` (bilinmiyor) olur. Bu dosya o kuralı DEĞİŞTİRMEZ; yalnız kilitler
 * (service.test.ts "formül asla yürütülmez").
 */
export async function openWorkbook(buf: Buffer): Promise<{ ok: true; wb: ExcelJS.Workbook } | { ok: false; rejection: Rejection }> {
  // ZIP imzası olmayan bir şey XLSX değildir; ExcelJS'in belirsiz hatasını beklemeden söyle.
  if (buf.length < 4 || buf.readUInt32LE(0) !== 0x04034b50) {
    return { ok: false, rejection: { code: "CORRUPT_XLSX", message: "Dosya geçerli bir .xlsx değil (ZIP imzası yok). Excel'den 'Farklı Kaydet → .xlsx' ile kaydedin.", detail: `ilk baytlar: ${buf.subarray(0, 4).toString("hex")}` } };
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, rejection: { code: "CORRUPT_XLSX", message: "Dosya açılamadı — bozuk ya da desteklenmeyen bir .xlsx. Excel'de açıp yeniden kaydetmeyi deneyin.", detail: msg.slice(0, 200) } };
  }
  if (wb.worksheets.length === 0) {
    return { ok: false, rejection: { code: "CORRUPT_XLSX", message: "Dosyada hiç sayfa yok.", detail: "worksheets=0" } };
  }
  return { ok: true, wb };
}

/** Veri sayfalarındaki toplam satır (başlık hariç) — 100k sınırı parse'tan ÖNCE uygulanır. */
export function countDataRows(wb: ExcelJS.Workbook): number {
  const names = new Set<string>(DATA_SHEETS.map((s) => s.name));
  let total = 0;
  for (const ws of wb.worksheets) {
    if (!names.has(ws.name)) continue;
    total += Math.max(0, ws.actualRowCount - 1);
  }
  return total;
}

export const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/* ── Önizleme raporu (plan §4.2) ──────────────────────────────────────────────────────── */

export interface PreviewCounters {
  /** YARATILACAK */ create: number;
  /** GÜNCELLENECEK */ update: number;
  /** İNCELEME */ review: number;
  /** REDDEDİLECEK — satırın kendisi sözleşmeye uymuyor */ reject: number;
  /** Üst kaydı bu dosyada kabul edilmediği için yazılmayacak */ blockedByParent: number;
  /** BELİRLENEMEDİ — kodsuz satır, yeni mi güncelleme mi ancak yazarken belli olur */ undetermined: number;
  /** Hazır ama eşleyicisi olmayan aile — yalnız hazırlık katmanına yazılır */ stagedOnly: number;
  /** Açılacak inceleme kaydı sayısı */ reviewsToOpen: number;
}

export interface IssueRef { sheet: string; row: number | null; column: string | null; message: string }

/**
 * Katman × hedef tablo: bu oturum bu sayfayı YAZABİLİR mi?
 *
 * Etkileşim kapısı gerçek yolda yakaladı: finans operatörü fixture'ı onayladı, `products`
 * (reference sınıfı — operator yalnız okur, 0058) RLS'e takıldı, işlem geri alındı ve kullanıcı
 * "WRITE_FAILED: new row violates row-level security policy" gördü. Doğru sonuç ama yanlış zaman
 * ve yanlış dil: yetki sorunu ÖNİZLEMEDE, sayfa adıyla ve gereken katmanla söylenmeli; onay ise
 * veritabanına hiç gitmeden durmalı. Karar aynı matristen gelir (`can()`), ikinci bir fikir yok.
 */
export interface ForbiddenSheet { sheet: string; table: string; readyRows: number; allowedRoles: string[] }

export function forbiddenSheetsFor(parsed: WorkbookParseResult, role: AppRole | undefined): ForbiddenSheet[] {
  if (!role) return [];
  const out: ForbiddenSheet[] = [];
  for (const sh of parsed.sheets) {
    if (!sh.present || !sh.domainTable || sh.ready === 0) continue;
    if (can(role, sh.domainTable, "insert") && can(role, sh.domainTable, "update")) continue;
    const allowed = APP_ROLES.filter((r) => can(r, sh.domainTable!, "insert") && can(r, sh.domainTable!, "update"));
    out.push({ sheet: sh.sheet, table: sh.domainTable, readyRows: sh.ready, allowedRoles: allowed.map((r) => ROLE_LABEL[r]) });
  }
  return out;
}

export interface PreviewReport {
  filename: string;
  bytes: number;
  sha256: string;
  schema: { name: string | null; version: number | null; template: string | null };
  counters: PreviewCounters;
  lists: {
    /** DESTEKLENMEYEN ALANLAR — sözleşmede olmayan başlıklar (sayfa, başlık) */
    unsupportedFields: Array<{ sheet: string; header: string }>;
    /** Sözleşmede olmayan sayfalar */
    unknownSheets: string[];
    /** TRY-DIŞI FİNANS KAYITLARI */
    nonTryFinance: IssueRef[];
    /** MÜKERRER ŞÜPHELİLER */
    duplicateSuspects: IssueRef[];
    /** MISSING REQUIRED FIELD */
    missingRequired: IssueRef[];
    /**
     * FORMÜL HATALARI — `#REF!`/`#DIV/0!`… taşıyan hücreler. Değer bilinmiyor; satır reddedilir.
     * Ayrı liste çünkü düzeltilecek şey yazılan değer değil, kaynak dosyadaki kırık formül —
     * onaydan ÖNCE görünmezse kullanıcı ancak yazdıktan sonra inceleme kuyruğunda öğrenirdi.
     */
    formulaErrors: IssueRef[];
    /** BİRLEŞTİRİLMİŞ HÜCRELER — değer yalnız aralığın ilk hücresinden okunur; satır incelemeye düşer. */
    mergedCells: IssueRef[];
    /** Bu oturumun katmanıyla YAZILAMAYACAK sayfalar — onay bunlar varken reddedilir. */
    forbiddenSheets: ForbiddenSheet[];
  };
  sheets: Array<{
    sheet: string; family: string; rowsRead: number; ready: number; needsReview: number;
    rejected: number; blockedByParent: number; missingColumns: string[]; unknownHeaders: string[];
  }>;
  stagedOnlyFamilies: string[];
  perTable: MapperResult["perTable"];
}

function issueRef(i: Issue): IssueRef {
  return { sheet: i.sheet, row: i.row ?? null, column: i.column ?? null, message: i.message };
}

/** Tüm sorunlar tek listede — satır sorunları satırlarıyla, sayfa/dosya sorunları bir kez. */
function allIssues(parsed: WorkbookParseResult): Issue[] {
  const seen = new Set<Issue>();
  const out: Issue[] = [];
  for (const s of parsed.sheets) {
    for (const r of s.rows) for (const i of r.issues) if (!seen.has(i)) { seen.add(i); out.push(i); }
    for (const i of s.issues) if (!seen.has(i)) { seen.add(i); out.push(i); }
  }
  for (const i of parsed.issues) if (!seen.has(i)) { seen.add(i); out.push(i); }
  return out;
}

export function buildPreviewReport(
  parsed: WorkbookParseResult, dry: MapperResult, file: { filename: string; bytes: number; sha256: string },
  role?: AppRole,
): PreviewReport {
  const create = Object.values(dry.perTable).reduce((n, t) => n + t.inserted, 0);
  const update = Object.values(dry.perTable).reduce((n, t) => n + t.updated, 0);
  const issues = allIssues(parsed);

  const unsupportedFields: Array<{ sheet: string; header: string }> = [];
  for (const s of parsed.sheets) {
    for (const h of s.unknownHeaders) unsupportedFields.push({ sheet: s.sheet, header: h });
  }

  return {
    filename: file.filename, bytes: file.bytes, sha256: file.sha256,
    schema: { name: parsed.schemaName, version: parsed.schemaVersion, template: parsed.templateVersion },
    counters: {
      create, update,
      review: dry.rowsNeedsReview,
      reject: dry.rowsRejected,
      blockedByParent: dry.rowsBlockedByParent,
      undetermined: dry.rowsUndetermined,
      stagedOnly: dry.rowsStagedOnly,
      reviewsToOpen: dry.reviewsOpened,
    },
    lists: {
      unsupportedFields,
      unknownSheets: [...parsed.unknownSheets],
      // Yalnız "geçerli ama TRY-dışı" finans kayıtları. `invalid_currency` (tanınmayan kod) bir
      // doğrulama hatasıdır ve İNCELEME sayacında görünür; bu listeye karışırsa "TRY-dışı"
      // sayısı şişer ve kullanıcı yanlış bir para birimi politikası sorunu görür.
      nonTryFinance: issues
        .filter((i) => i.type === "unsupported_currency_for_finance_aggregation" || i.type === "currency_mismatch")
        .map(issueRef),
      duplicateSuspects: issues
        .filter((i) => i.type === "duplicate_external_id" || i.type === "duplicate_check")
        .map(issueRef),
      missingRequired: issues.filter((i) => i.type === "missing_required_field").map(issueRef),
      formulaErrors: issues.filter((i) => i.type === "formula_error").map(issueRef),
      mergedCells: issues.filter((i) => i.type === "merged_cell").map(issueRef),
      forbiddenSheets: forbiddenSheetsFor(parsed, role),
    },
    sheets: parsed.sheets.filter((s) => s.present).map((s) => ({
      sheet: s.sheet, family: s.family, rowsRead: s.rowsRead, ready: s.ready, needsReview: s.needsReview,
      rejected: s.rejected, blockedByParent: s.blockedByParent,
      missingColumns: [...s.missingColumns], unknownHeaders: [...s.unknownHeaders],
    })),
    stagedOnlyFamilies: [...dry.stagedOnlyFamilies],
    perTable: dry.perTable,
  };
}

/* ── Ortak hazırlık: bayt → parse edilmiş workbook ────────────────────────────────────── */

async function prepare(
  buf: Buffer, filename: string,
): Promise<{ ok: true; parsed: WorkbookParseResult; sha256: string } | { ok: false; rejection: Rejection }> {
  const meta = validateUploadMeta({ name: filename, size: buf.length });
  if (meta) return { ok: false, rejection: meta };

  const opened = await openWorkbook(buf);
  if (!opened.ok) return opened;

  const rows = countDataRows(opened.wb);
  if (rows > UPLOAD_LIMITS.maxRows) {
    return { ok: false, rejection: { code: "TOO_MANY_ROWS", message: `Dosyada ${rows.toLocaleString("tr-TR")} veri satırı var; sınır 100.000. Dosyayı bölün.`, detail: `rows=${rows}` } };
  }

  const parsed = parseWorkbook(opened.wb);
  if (!parsed.schemaDetected) {
    return { ok: false, rejection: { code: "NOT_V2_SCHEMA", message: "Bu dosya Standart Import V2 şablonu değil. Şablonu bu sayfadan indirip doldurun; eski biçim için 'İçe aktarımlar' sayfasını kullanın.", detail: parsed.rejectionReason } };
  }
  return { ok: true, parsed, sha256: sha256Hex(buf) };
}

/* ── Önizleme ─────────────────────────────────────────────────────────────────────────── */

/**
 * Hiçbir şey yazmadan "bu dosya şunları yapacak" raporu. `client` yalnız OKUR
 * (`import_external_keys` bakışı: kodu olan satır yeni mi güncelleme mi).
 */
export async function previewImport(
  client: Pick<PoolClient, "query">, buf: Buffer, filename: string, actorId: string,
  opts: { role?: AppRole } = {},
): Promise<{ ok: true; report: PreviewReport } | { ok: false; rejection: Rejection }> {
  const prep = await prepare(buf, filename);
  if (!prep.ok) return prep;
  const dry = await mapWorkbook(client as PoolClient, prep.parsed, {
    filename, fileSha256: prep.sha256, actorId, dryRun: true,
  });
  return { ok: true, report: buildPreviewReport(prep.parsed, dry, { filename, bytes: buf.length, sha256: prep.sha256 }, opts.role) };
}

function forbiddenRejection(f: ForbiddenSheet[]): Rejection {
  const detail = f.map((x) => `${x.sheet} → ${x.table} (${x.readyRows} hazır satır; gereken: ${x.allowedRoles.join("/")})`).join(" · ");
  return {
    code: "FORBIDDEN_SHEETS",
    message: `Bu dosyadaki ${f.length} sayfa oturumunuzun katmanıyla yazılamaz (referans verisi: ürün, proje, hesap, makine vb. yalnız yönetici/finans yöneticisi tarafından değiştirilir). Bu sayfaları boşaltıp yeniden yükleyin ya da dosyayı yetkili bir kullanıcıya iletin. Hiçbir şey yazılmadı.`,
    detail,
  };
}

/* ── Onaylı import (tek transaction) ──────────────────────────────────────────────────── */

export interface ImportOutcome {
  workbookId: string;
  sha256: string;
  filename: string;
  result: MapperResult;
}

/**
 * Kullanıcı onayından sonra TEK transaction'da yazar.
 *
 * `expectedSha256` önizlemede gösterilen özettir; yeniden hesaplanan özet eşleşmiyorsa hiçbir
 * sorgu çalışmadan durulur. Yazma sırasında bilinen defter hataları (bayat bağlama, çakışma)
 * ROLLBACK + yapılandırılmış red olarak döner — yarım import yoktur.
 */
export async function confirmImport(
  pool: Pool, buf: Buffer, filename: string, actorId: string, expectedSha256: string,
  opts: { role?: AppRole } = {},
): Promise<{ ok: true; outcome: ImportOutcome } | { ok: false; rejection: Rejection }> {
  const prep = await prepare(buf, filename);
  if (!prep.ok) return prep;
  // Yetki, SHA'dan da önce ve veritabanına gitmeden: katmanın yazamayacağı sayfa varsa dur.
  const forbidden = forbiddenSheetsFor(prep.parsed, opts.role);
  if (forbidden.length > 0) return { ok: false, rejection: forbiddenRejection(forbidden) };
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || expectedSha256 !== prep.sha256) {
    return { ok: false, rejection: {
      code: "SHA_MISMATCH",
      message: "Onayladığınız dosya, önizlediğiniz dosya ile aynı değil. Önizlemeyi yenileyip tekrar onaylayın.",
      detail: `beklenen ${expectedSha256.slice(0, 12)}… · gelen ${prep.sha256.slice(0, 12)}…`,
    } };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await mapWorkbook(client, prep.parsed, { filename, fileSha256: prep.sha256, actorId, dryRun: false });
    await client.query("commit");
    if (!result.workbookId) throw new Error("mapWorkbook workbookId döndürmedi");
    return { ok: true, outcome: { workbookId: result.workbookId, sha256: prep.sha256, filename, result } };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    if (e instanceof StaleExternalKeyBindingError) {
      return { ok: false, rejection: { code: "STALE_BINDING", message: "Defterde bir kod, artık var olmayan bir kayda bağlı. İçe aktarım yazmadan geri alındı; bu bir veri bütünlüğü sorunudur, yöneticiye bildirin.", detail: e.message } };
    }
    if (e instanceof ExternalKeyBindingConflictError) {
      return { ok: false, rejection: { code: "BINDING_CONFLICT", message: "Aynı kod başka bir kayda bağlanmaya çalışıldı. İçe aktarım yazmadan geri alındı.", detail: e.message } };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, rejection: { code: "WRITE_FAILED", message: "İçe aktarım yazılamadı ve tamamen geri alındı. Hiçbir kayıt değişmedi.", detail: msg.slice(0, 300) } };
  } finally {
    client.release();
  }
}

/**
 * Ham hücre değerinin `raw`'da nerede tutulduğunu UI'a açıklamak için: bilinmeyen kolonlar ve
 * birleştirilmiş aralığın ilk olmayan hücrelerinin kaynağı.
 */
export { MERGED_CELLS_KEY, UNKNOWN_COLUMNS_KEY };
