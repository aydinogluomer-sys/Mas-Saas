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
import { parseNumber } from "@/lib/importers/v2/values";
import { moneyOrNull, mul } from "@/lib/money";

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
export function readSourceRevenue(rowJson: unknown, quantity: number | null): SourceRevenue {
  if (!isRecord(rowJson)) return { revenue: null, source: "none" };

  // ── V2: sözleşme anahtarı VARSA (değeri null olsa bile) satır V2'dir ────────────────
  if (V2_REVENUE_KEY in rowJson) {
    const parsed = parseNumber(rowJson[V2_REVENUE_KEY]);
    // "ambiguous" da kabul: parser aynı hücreyi aynı kuralla çözüp satırı incelemeye
    // düşürmüş, kullanıcı kabul etmişse değer budur. "invalid"/"blank" → bilinmiyor.
    const unitPrice = parsed.status === "ok" || parsed.status === "ambiguous" ? parsed.value : null;
    if (unitPrice === null || quantity === null) return { revenue: null, source: "v2" };
    return { revenue: moneyOrNull(mul(unitPrice, quantity)), source: "v2" };
  }

  // ── Legacy: `I.v` — davranış aynen korunur ──────────────────────────────────────────
  //
  // Eski okuyucu `(row_json->'I'->>'v')::numeric` idi: sayı → değer, boş → null, sayı olmayan
  // metin → HATA. `moneyOrNull` birebir aynı sözleşmeyi uygular (boş metin null, saçma metin
  // TypeError). Legacy yolun hata davranışı BİLEREK yumuşatılmıyor — bu düzeltme V2 içindir.
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
export function sourceRevenue(rowJson: unknown, quantity: number | null): number | null {
  return readSourceRevenue(rowJson, quantity).revenue;
}
