/**
 * ETKİLEŞİM KAPISININ KARAR KURALLARI — saf fonksiyon, I/O yok.
 *
 * ═══ NEDEN AYRI BİR MODÜL ═══
 *
 * Kapının kararı ("kırmızı mı, yeşil mi") artık iki modda çalışıyor ve altı ayrı koşulu var.
 * Bu kadar dallanmayı yalnız uçtan uca koşarak doğrulamak, her senaryo için tam bir tarama +
 * Playwright turu gerektirirdi — bu makinede saatler. Karar saf bir fonksiyona alınınca altı
 * senaryonun tamamı milisaniyelerde ve DETERMİNİSTİK biçimde test edilebiliyor.
 *
 * I/O tarafı (`interaction-coverage-gate.ts`) dosya okur, sayar, raporu basar; NE'yi kırmızı
 * sayacağına burası karar verir. İkisini ayırmanın somut faydası şu: "UNTESTED baseline'ın
 * üstünde mi" sorusunun cevabı, 2122 kontrol taramadan da doğrulanabilir olmalı.
 *
 * ═══ İKİ MOD, İKİ FARKLI SÖZ ═══
 *
 *   ratchet  Günlük PR kapısı. Söz: "kapsam GERİLEMEZ." Kalan UNTESTED'ı hoş görür ama
 *            ARTMASINA izin vermez. Bir ekibin 557 test borcunu tek PR'da kapatması gerçekçi
 *            değildir; her PR'ın borcu BÜYÜTMEMESİ gerçekçidir.
 *
 *   strict   TAM ETKİLEŞİM GÜVENCESİ hedefi. Söz: "kanıtlanmamış kontrol YOK." UNTESTED > 0 ise
 *            kırmızı. Bu mod gevşetilmez; sayı gizlemek, allowlist'e taşımak ya da testi
 *            zayıflatmak yerine testin yazılması beklenir.
 *
 *            AMA BİR CUTOVER KABUL KRİTERİ DEĞİLDİR. Kalan UNTESTED, Gap Closure Rehberi'nde
 *            bulunmayan, bu denetim sırasında ortaya çıkarılmış yeni ve geniş bir kalite
 *            hedefidir: izlenen kalite borcu, bilinen ürün hatası değil. Cutover'ın önüne
 *            koyulması rehberin kapsamını sessizce büyütmek olurdu. Strict, cutover SONRASI
 *            sertleştirme hedefi olarak koşar ve borcun büyüklüğünü görünür tutar.
 *
 * Ratchet'in strict'i SESSİZCE İKAME ETMEMESİ önemli: ikisi ayrı komutlardır, ayrı isimleri
 * vardır ve rapor hangi modda koşulduğunu açıkça yazar. Güvenceyi düşürmenin en kolay yolu,
 * gevşek modu varsayılan yapıp adını değiştirmemektir.
 */

export type GateMode = "ratchet" | "strict";

export interface GateCounts {
  discovered: number;
  pass: number;
  fail: number;
  untested: number;
  /** Manifestoda hiçbir kurala uymayan kontroller — her modda kırmızı. */
  unmapped: number;
}

export interface GateBaseline {
  /** Kabul edilen mevcut UNTESTED tavanı. */
  untested: number;
  /** Kabul edilen mevcut PASS tabanı — kapsam bunun altına inemez. */
  pass: number;
  /**
   * Tavan YÜKSELTİLDİYSE gerekçe. Boş bırakılamaz: "gerekçesiz yükseltilemez" kuralı ancak
   * yazılı bir gerekçe zorunlu olduğunda uygulanabilir hâle gelir.
   */
  raisedBecause?: string;
}

export interface GateVerdict {
  red: boolean;
  mode: GateMode;
  /** Kırmızı sebepleri — boşsa yeşil. Her satır tek başına anlaşılır olmalı. */
  reasons: string[];
  /** Kırmızı olmayan ama söylenmesi gereken şeyler (ör. borç azaldı, tavan düşürülebilir). */
  notes: string[];
}

/**
 * Kapının kararı.
 *
 * `previousBaseline` verildiğinde tavanın yükseltilip yükseltilmediği de denetlenir. CI'da bu
 * değer hedef dalın baseline'ıdır; yerelde commit öncesi HEAD'inki. Verilmezse yükseltme
 * denetimi yapılmaz — sessizce geçtiği için değil, karşılaştıracak bir geçmiş olmadığı için;
 * çağıran bunu bilerek yapar.
 */
export function evaluateGate(
  counts: GateCounts,
  baseline: GateBaseline,
  mode: GateMode,
  previousBaseline?: GateBaseline,
): GateVerdict {
  const reasons: string[] = [];
  const notes: string[] = [];

  // ── Her modda geçerli olan iki kural ──────────────────────────────────────────────────
  //
  // FAIL: bir kontrol vaat ettiği işi YAPMIYOR. Bu asla hoş görülmez; ratchet "borç" için
  // vardır, BOZUK için değil.
  if (counts.fail > 0) {
    reasons.push(`FAIL=${counts.fail} — bir kontrol vaat ettiği işi yapmıyor. Hiçbir modda hoş görülmez.`);
  }
  // unmapped: yeni bir kontrol eklendi ama nasıl doğrulanacağı YAZILMADI. Bunu hoş görmek,
  // kapsamın sessizce kaybolmasına izin vermek demektir — kapının varlık sebebinin tersi.
  if (counts.unmapped > 0) {
    reasons.push(
      `Manifestoda karşılığı olmayan kontrol=${counts.unmapped} — yeni kontrol eklenmiş ama ` +
        "doğrulama sınıfı yazılmamış. tests/interaction/manifest.ts'e kural ekleyin.",
    );
  }

  if (mode === "strict") {
    // ── Tam güvence hedefi (cutover kabul kriteri DEĞİL) ────────────────────────────────
    if (counts.untested > 0) {
      reasons.push(
        `UNTESTED=${counts.untested} — strict modda kanıtlanmamış kontrol kabul edilmez. ` +
          "Bu sayıyı testleri yazarak düşürün; allowlist'e taşımak ya da testi gevşetmek çözüm değildir.",
      );
    }
  } else {
    // ── Günlük PR kapısı ────────────────────────────────────────────────────────────────
    if (counts.untested > baseline.untested) {
      reasons.push(
        `UNTESTED=${counts.untested} > baseline=${baseline.untested} — bu değişiklik test borcunu ` +
          "BÜYÜTÜYOR. Yeni kontrolün testini yazın ya da baseline'ı gerekçesiyle güncelleyin.",
      );
    } else if (counts.untested < baseline.untested) {
      notes.push(
        `UNTESTED=${counts.untested}, baseline=${baseline.untested} — borç azalmış. ` +
          "Baseline'ı bu değere ÇEKİN ki kazanım kilitlensin (düşürmek her zaman serbest).",
      );
    }

    // Kapsam gerilemesi: UNTESTED aynı kalsa bile PASS düşebilir (bir test silinirse ve kontrol
    // de silinirse ikisi birden düşer). PASS tabanı bunu ayrıca yakalar.
    if (counts.pass < baseline.pass) {
      reasons.push(
        `PASS=${counts.pass} < baseline=${baseline.pass} — kanıtlanmış kontrol sayısı DÜŞTÜ. ` +
          "Bir doğrulama kaldırılmış ya da çalışmıyor olabilir.",
      );
    }
  }

  // ── Tavan yükseltme denetimi ────────────────────────────────────────────────────────────
  //
  // Baseline DÜŞÜRÜLEBİLİR (kazanımı kilitler) ama gerekçesiz YÜKSELTİLEMEZ. Aksi hâlde kapı
  // kendi kendini etkisizleştirir: kırmızı görünce tavanı bir tık yukarı çekmek yeterli olurdu.
  if (previousBaseline && baseline.untested > previousBaseline.untested) {
    const justification = (baseline.raisedBecause ?? "").trim();
    if (justification.length === 0) {
      reasons.push(
        `Baseline YÜKSELTİLMİŞ (${previousBaseline.untested} → ${baseline.untested}) ama gerekçe yok. ` +
          "baseline.json içindeki `raisedBecause` alanını doldurun; gerekçesiz yükseltme kabul edilmez.",
      );
    } else {
      notes.push(`Baseline yükseltildi (${previousBaseline.untested} → ${baseline.untested}), gerekçe: ${justification}`);
    }
  }

  return { red: reasons.length > 0, mode, reasons, notes };
}
