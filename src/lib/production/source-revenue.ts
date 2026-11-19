// Parça gelirini KAYNAK satırdan okur — iki ham biçimi de tanır.
//
// `production_parts` fiyat saklamıyor (bkz. domain-map.ts: `14_KAPASITE.satis_fiyati` → no;
// plan §5.2 kolonu domain'e zorlamayı yasaklıyor). Kârlılık motoru geliri her zaman kaynak
// satırdan (`import_rows.row_json`) geri okudu. Ama o satırın İKİ farklı biçimi var ve
// okuyucu yalnız birini tanıyordu:
//
//   LEGACY (workbook-importer.ts) — kolon HARFİ ile, `v` sarmalayıcılı hücre:
//       {"A":{"v":"MT-100","t":"s"}, ..., "I":{"v":130000,"t":"n"}}
//     `I` sütunu legacy kapasite sayfasının FİYAT kolonu: o parçanın ADEDİ İÇİN TOPLAM bedeli
//     (I8 hücresi bu kolonun toplamıdır = teorik toplam gelir; bkz. extractors.ts §5).
//
//   V2 (importers/v2/parser.ts) — SÖZLEŞME ANAHTARI ile, hücre değeri olduğu gibi:
//       {"parca_kodu":"MT-100", "adet":500, "satis_fiyati":260, ...}
//     `satis_fiyati` sözleşmede "Parça BAŞINA satış fiyatı" — BİRİM fiyat.
//
// Okuyucu `row_json->'I'->>'v'` ile yalnız legacy biçimi okuyordu; V2 ile gelen her parçanın
// geliri NULL çıkıyor ve kârlılık SESSİZCE bozuluyordu: marj null, ekranda "veri yok" gibi
// görünüyordu, oysa kullanıcı fiyatı yazmıştı.
//
// ═══ İKİ BİÇİM, TEK SÖZLEŞME ═══
//
// Hangi biçim olduğu TAHMİN EDİLMEZ, anahtarın varlığından okunur: `satis_fiyati` anahtarı
// varsa satır V2'dir (legacy `row_json` yalnız kolon harfi taşır, bu anahtarı asla üretmez).
// V2 anahtarı yoksa legacy `I.v` denenir. İkisi de yoksa gelir BİLİNMİYOR (null) — 0 değil.
//
// V2 hücresi parser'ın KENDİ sayı çözücüsüyle okunur (`parseNumber`). Parça satırı domain'e
// yalnız parser o hücreyi çözebildiyse yazıldığı için burada aynı fonksiyon aynı sonucu
// verir — "aynı source contract" tam olarak bu. SQL tarafında `::numeric` cast KULLANILMAZ:
// V2 ham hücre metin ("1.234,56"), formül nesnesi ({formula, result}) ya da zengin metin
// olabilir; cast bunlardan birinde hata verir ve TÜM kârlılık hesabı düşer. Burada
// çözülemeyen V2 değeri null'dur, hata değil.
//
// ═══ BİRİM FİYAT × ADET ═══
//
// Legacy FİYAT toplam, V2 `satis_fiyati` birim. Birim fiyatı toplam gelirin yerine koymak
// marjı adet katı kadar yanlış hesaplardı — sessizce. Bu yüzden V2 geliri
// satis_fiyati × adet; adet bilinmiyorsa (null) gelir de bilinmiyor. Adet 0 ise gelir 0'dır
// (parça üretilmiyor; bu gerçek bir sıfır). Çarpım ondalık aritmetiğiyle yapılır, float ile
// değil: 71744.12 × 3 float'ta 215232.36000000002 verir.
import type { Pool, PoolClient } from "pg";
import { parseNumber } from "@/lib/importers/v2/values";
import { decimal, money, moneyOrNull, mul } from "@/lib/money";
import {
  convertAmountToTry,
  loadLatestSpotRatesToTry,
  normalizeCurrency,
  type SpotRateMap,
} from "./fx-rates";

export function isMissingSchemaError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

/** V2 sözleşme anahtarı — varlığı satırın V2 olduğunu söyler. */
export const V2_REVENUE_KEY = "satis_fiyati";
/** Legacy kapasite sayfasının FİYAT sütunu (kolon harfi). */
export const LEGACY_REVENUE_COLUMN = "I";

export type RevenueSource = "v2" | "legacy" | "none";

export interface SourceRevenue {
  /** TL cinsinden toplam gelir; bilinmiyorsa null (asla 0'a çevrilmez). */
  revenue: number | null;
  /** Hangi ham biçim okundu — tanı ve test için. */
  source: RevenueSource;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Kaynak satırdan gelir.
 *
 * @param rowJson  `import_rows.row_json` — jsonb'den geldiği hâliyle (nesne).
 * @param quantity `production_parts.quantity` — V2'de birim fiyatı toplama çevirmek için.
 */
export function readSourceRevenue(
  rowJson: unknown,
  quantity: number | null,
  spotRates?: SpotRateMap,
): SourceRevenue {
  if (!isRecord(rowJson)) return { revenue: null, source: "none" };

  // ── V2: sözleşme anahtarı VARSA (değeri null olsa bile) satır V2'dir ────────────────
  if (V2_REVENUE_KEY in rowJson) {
    const parsed = parseNumber(rowJson[V2_REVENUE_KEY]);
    const unitPrice = parsed.status === "ok" || parsed.status === "ambiguous" ? parsed.value : null;
    if (unitPrice === null || quantity === null) return { revenue: null, source: "v2" };
    const nativeTotal = moneyOrNull(mul(unitPrice, quantity));
    if (nativeTotal === null) return { revenue: null, source: "v2" };
    const rawCcy =
      typeof rowJson.para_birimi === "string" ? normalizeCurrency(rowJson.para_birimi) : "TRY";
    if (rawCcy !== "TRY" && spotRates) {
      const conv = convertAmountToTry(nativeTotal, rawCcy, spotRates);
      return { revenue: conv.amountTry, source: "v2" };
    }
    return { revenue: nativeTotal, source: "v2" };
  }

  // ── Legacy: `I.v` — davranış aynen korunur ──────────────────────────────────────────
  const legacyCell = rowJson[LEGACY_REVENUE_COLUMN];
  if (isRecord(legacyCell) && "v" in legacyCell) {
    const v = legacyCell.v;
    if (v === null || v === undefined) return { revenue: null, source: "legacy" };
    const text = typeof v === "number" ? v : String(v);
    return { revenue: moneyOrNull(text), source: "legacy" };
  }

  return { revenue: null, source: "none" };
}

/** `readSourceRevenue` — yalnız tutar. */
export function sourceRevenue(
  rowJson: unknown,
  quantity: number | null,
  spotRates?: SpotRateMap,
): number | null {
  return readSourceRevenue(rowJson, quantity, spotRates).revenue;
}

export interface SourceRevenuePartItem {
  partId: string;
  partCode: string | null;
  partName: string;
  quantity: number | null;
  revenue: number | null;
  source: RevenueSource;
}

export interface SourceRevenueSummary {
  totalPartCount: number;
  v2Count: number;
  legacyCount: number;
  noneCount: number;
  unknownRevenueCount: number;
  totalKnownRevenueTry: number;
  v2RevenueTry: number;
  legacyRevenueTry: number;
  topParts: SourceRevenuePartItem[];
}

function emptySourceRevenueSummary(): SourceRevenueSummary {
  return {
    totalPartCount: 0,
    v2Count: 0,
    legacyCount: 0,
    noneCount: 0,
    unknownRevenueCount: 0,
    totalKnownRevenueTry: 0,
    v2RevenueTry: 0,
    legacyRevenueTry: 0,
    topParts: [],
  };
}

/**
 * Üretim parçalarının kaynak satırlarından (`import_rows.row_json`) V2 ve klasik gelir
 * dağılımını okur. Şema henüz uygulanmadıysa (`42P01` / `42703`) boş özet döner.
 */
export async function loadSourceRevenueSummary(
  pool: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  topLimit = 8,
): Promise<SourceRevenueSummary> {
  const rowsRes = await pool
    .query<{
      id: string;
      part_code: string | null;
      part_name: string;
      quantity: number | string | null;
      unit_sale_price: string | null;
      currency: string | null;
      row_json: unknown;
    }>(
      `select pp.id::text,
              pp.part_code,
              pp.part_name,
              pp.quantity,
              pp.unit_sale_price::text as unit_sale_price,
              pp.currency,
              ir.row_json
         from public.production_parts pp
         left join public.import_rows ir on ir.id = pp.source_row_id
        order by pp.part_code nulls last, pp.part_name`,
    )
    .catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === "42703") {
        return pool
          .query<{
            id: string;
            part_code: string | null;
            part_name: string;
            quantity: number | string | null;
            unit_sale_price: string | null;
            currency: string | null;
            row_json: unknown;
          }>(
            `select pp.id::text,
                    pp.part_code,
                    pp.part_name,
                    pp.quantity,
                    null::text as unit_sale_price,
                    'TRY'::text as currency,
                    ir.row_json
               from public.production_parts pp
               left join public.import_rows ir on ir.id = pp.source_row_id
              order by pp.part_code nulls last, pp.part_name`,
          )
          .catch((e2: unknown) => {
            if (isMissingSchemaError(e2)) return null;
            throw e2;
          });
      }
      if (isMissingSchemaError(err)) return null;
      throw err;
    });

  if (!rowsRes || rowsRes.rows.length === 0) {
    return emptySourceRevenueSummary();
  }

  const spotRates = await loadLatestSpotRatesToTry(pool);

  let v2Count = 0;
  let legacyCount = 0;
  let noneCount = 0;
  let unknownRevenueCount = 0;
  let totalKnownDec = decimal(0);
  let v2RevDec = decimal(0);
  let legacyRevDec = decimal(0);
  const items: SourceRevenuePartItem[] = [];

  for (const row of rowsRes.rows) {
    const qty = row.quantity == null ? null : Number(row.quantity);
    let parsed: SourceRevenue;
    try {
      parsed = readSourceRevenue(row.row_json ?? null, qty, spotRates);
    } catch {
      parsed = { revenue: null, source: "legacy" };
    }

    let effRevenue = parsed.revenue;
    if (effRevenue == null && row.unit_sale_price != null && qty != null) {
      const nativeTotal = moneyOrNull(mul(row.unit_sale_price, qty));
      if (nativeTotal != null) {
        effRevenue = convertAmountToTry(nativeTotal, row.currency ?? "TRY", spotRates).amountTry;
      }
    }

    if (parsed.source === "v2") {
      v2Count++;
      if (effRevenue != null) v2RevDec = v2RevDec.plus(decimal(effRevenue));
    } else if (parsed.source === "legacy") {
      legacyCount++;
      if (effRevenue != null) legacyRevDec = legacyRevDec.plus(decimal(effRevenue));
    } else {
      noneCount++;
    }

    if (effRevenue != null) {
      totalKnownDec = totalKnownDec.plus(decimal(effRevenue));
    } else {
      unknownRevenueCount++;
    }

    items.push({
      partId: row.id,
      partCode: row.part_code,
      partName: row.part_name,
      quantity: qty,
      revenue: effRevenue,
      source: parsed.source,
    });
  }

  const topParts = items
    .filter((it) => it.revenue != null)
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
    .slice(0, Math.max(1, topLimit));

  return {
    totalPartCount: rowsRes.rows.length,
    v2Count,
    legacyCount,
    noneCount,
    unknownRevenueCount,
    totalKnownRevenueTry: money(totalKnownDec.toString()),
    v2RevenueTry: money(v2RevDec.toString()),
    legacyRevenueTry: money(legacyRevDec.toString()),
    topParts,
  };
}
