// Standart Import V2 — kanonik test fixture'ı.
//
// Kodla üretilir, elle hazırlanmış bir binary'ye bağlı değildir. İçinde bilerek hem "temiz"
// hem "sorunlu" satırlar var: parser'ın yalnız mutlu yolu değil, reddetme ve inceleme
// davranışı da ölçülebilsin.
//
// Beklenen değerler `FIXTURE_ORACLE` içinde SABİT yazılıdır. Oracle'ı üretimden türetmek
// testi kendi kendini doğrulayan bir tautolojiye çevirirdi.
import ExcelJS from "exceljs";
import {
  DATA_SHEETS, META_SHEET, SCHEMA_NAME, SCHEMA_VERSION, TEMPLATE_VERSION, TEMPLATE_ID,
} from "./contract";

type Row = Record<string, unknown>;

/** Her sayfa için fixture satırları. Anahtarlar kanonik kolon adlarıdır. */
const FIXTURE_ROWS: Record<string, Row[]> = {
  "01_ODEMELER": [
    // Temiz: tutarı bilinen aylık ödeme.
    { external_id: "ODM-KIRA", aciklama: "KİRA", karsi_taraf: "Ev sahibi", vade_gunu: 10,
      tutar: 35000, para_birimi: "TRY", tekrar_tipi: "monthly", durum: "active" },
    // Temiz ama tutar BİLİNMİYOR — boş bırakıldı, 0 DEĞİL.
    { external_id: "ODM-ELEKTRIK", aciklama: "MAS ELEKTRİK", vade_gunu: 3,
      tutar: null, para_birimi: "TRY", tekrar_tipi: "monthly" },
    // Temiz: tutar GERÇEKTEN sıfır (bedelsiz sözleşme).
    { external_id: "ODM-BEDELSIZ", aciklama: "Bedelsiz servis sözleşmesi", vade_gunu: 1,
      tutar: 0, para_birimi: "TRY", tekrar_tipi: "monthly" },
    // REDDEDİLMELİ: aylık tekrar ama vade günü yok.
    { external_id: "ODM-GUNSUZ", aciklama: "Vade günü olmayan aylık", tutar: 500,
      para_birimi: "TRY", tekrar_tipi: "monthly" },
  ],
  "02_CEKLER": [
    // Temiz: ödenecek çek, eksi işaret.
    { external_id: "CEK-001", seri_no: "AKR-2026-0031", vade_tarihi: "2026-07-31",
      kime: "AKR", banka: "Deniz", signed_tutar: -45000, para_birimi: "TRY", durum: "planned" },
    // MÜKERRER ŞÜPHESİ: aynı taraf/vade/tutar, seri no ve kod YOK (ikisi de).
    { vade_tarihi: "2026-08-31", kime: "Çağdaş", banka: "Deniz",
      signed_tutar: -100000, para_birimi: "TRY" },
    { vade_tarihi: "2026-08-31", kime: "Çağdaş", banka: "Deniz",
      signed_tutar: -100000, para_birimi: "TRY" },
    // Temiz: tahsil edilecek çek, artı işaret.
    { external_id: "CEK-004", seri_no: "EGE-77", vade_tarihi: "2026-09-19",
      kimden: "EGE GÜNEŞ", banka: "Vakıf", signed_tutar: 120000, para_birimi: "TRY" },
  ],
  "03_KREDILER": [
    { external_id: "KREDI-VAKIF-01", kredi_adi: "Vakıf yatırım kredisi", banka: "Vakıf",
      anapara: 1500000, para_birimi: "TRY", vade_ay: 48, baz_faiz_orani: 3.14,
      uygulanan_faiz_orani: 3.63, bsmv_orani: 10, kkdf_orani: 10,
      ilk_odeme_tarihi: "2024-10-18", taksit_tutari: 71744.12,
      toplam_odeme: 3443717.58, finansman_maliyeti: 1943717.58, durum: "active" },
  ],
  "04_KREDI_TAKSITLERI": [
    { loan_external_id: "KREDI-VAKIF-01", taksit_no: 1, vade_tarihi: "2024-10-18",
      toplam_tutar: 71744.12, durum: "paid", odeme_tarihi: "2024-10-18" },
    { loan_external_id: "KREDI-VAKIF-01", taksit_no: 2, vade_tarihi: "2024-11-18",
      toplam_tutar: 71744.12, durum: "planned" },
    // REDDEDİLMELİ: olmayan krediye referans.
    { loan_external_id: "KREDI-YOK-99", taksit_no: 1, vade_tarihi: "2025-01-18",
      toplam_tutar: 1000, durum: "planned" },
  ],
  "05_NAKIT_AKISI": [
    { external_id: "NA-2026-05-DEVIR", donem: "2026-05", satir_tipi: "opening_balance",
      yon: "balance", tutar: 0, para_birimi: "TRY", aciklama: "Ay başı devir" },
    { external_id: "NA-2026-05-GELIR", donem: "2026-05", satir_tipi: "customer_income",
      yon: "inflow", tutar: 2038775.18, para_birimi: "TRY", karsi_taraf: "Müşteri A" },
    { external_id: "NA-2026-05-GIDER", donem: "2026-05", satir_tipi: "vendor_payment",
      yon: "outflow", tutar: 1558782.24, para_birimi: "TRY", karsi_taraf: "Tedarikçi B" },
    { external_id: "NA-2026-06-GELIR", donem: "2026-06", satir_tipi: "customer_income",
      yon: "inflow", tutar: 1764007, para_birimi: "TRY" },
    { external_id: "NA-2026-06-GIDER", donem: "2026-06", satir_tipi: "operational_cost",
      yon: "outflow", tutar: 1485544.12, para_birimi: "TRY" },
  ],
  "06_BANKA_HESAPLARI": [
    { external_id: "BANKA-VAKIF-TL", banka: "Vakıf", hesap_adi: "Ana vadesiz TL",
      para_birimi: "TRY", hesap_tipi: "vadesiz", guncel_bakiye: 250000,
      bakiye_tarihi: "2026-05-31", aktif: "EVET" },
    { external_id: "BANKA-DENIZ-USD", banka: "Deniz", hesap_adi: "USD hesabı",
      para_birimi: "USD", hesap_tipi: "vadesiz", guncel_bakiye: 12000, aktif: "EVET" },
  ],
  "07_BANKA_HAREKETLERI": [
    { external_id: "HRK-001", account_external_id: "BANKA-VAKIF-TL", islem_tarihi: "2026-05-03",
      aciklama: "Kira ödemesi", yon: "outflow", tutar: 35000, para_birimi: "TRY" },
    { external_id: "HRK-002", account_external_id: "BANKA-VAKIF-TL", islem_tarihi: "2026-05-10",
      aciklama: "Müşteri tahsilatı", yon: "inflow", tutar: 500000, para_birimi: "TRY" },
    { external_id: "HRK-003", account_external_id: "BANKA-DENIZ-USD", islem_tarihi: "2026-05-12",
      yon: "inflow", tutar: 5000, para_birimi: "USD" },
    // REDDEDİLMELİ: olmayan hesaba referans.
    { external_id: "HRK-004", account_external_id: "BANKA-YOK", islem_tarihi: "2026-05-15",
      yon: "outflow", tutar: 100, para_birimi: "TRY" },
    // REDDEDİLMELİ: belirsiz tarih (iki haneli yıl) — tahmin edilmez.
    { external_id: "HRK-005", account_external_id: "BANKA-VAKIF-TL", islem_tarihi: "01/02/03",
      yon: "outflow", tutar: 250, para_birimi: "TRY" },
  ],
  "08_FATURALAR": [
    { external_id: "FTR-001", fatura_tipi: "sales", fatura_no: "A-1001",
      duzenleme_tarihi: "2026-05-02", vade_tarihi: "2026-06-01", karsi_taraf: "Müşteri A",
      net_tutar: 100000, vergi_tutari: 20000, toplam_tutar: 120000, para_birimi: "TRY",
      durum: "issued", project_external_id: "PRJ-001" },
    { external_id: "FTR-002", fatura_tipi: "purchase", duzenleme_tarihi: "2026-05-06",
      karsi_taraf: "Tedarikçi B", toplam_tutar: 45000, para_birimi: "TRY", durum: "paid" },
  ],
  "09_SIPARISLER": [
    { external_id: "SIP-001", siparis_tipi: "sales", siparis_no: "S-77",
      siparis_tarihi: "2026-05-04", beklenen_tarih: "2026-06-15", karsi_taraf: "Müşteri A",
      toplam_tutar: 300000, para_birimi: "TRY", durum: "confirmed", project_external_id: "PRJ-001" },
    { external_id: "SIP-002", siparis_tipi: "purchase", siparis_tarihi: "2026-05-08",
      karsi_taraf: "Tedarikçi C", toplam_tutar: 80000, para_birimi: "TRY", durum: "open" },
  ],
  "10_URUNLER": [
    { external_id: "URN-001", sku: "MT-100", urun_adi: "Flanş M100", birim: "adet",
      standart_maliyet: 120, satis_fiyati: 260, para_birimi: "TRY", aktif: "EVET" },
    { external_id: "URN-002", sku: "MT-200", urun_adi: "Mil 200", birim: "adet",
      standart_maliyet: 340, satis_fiyati: 700, para_birimi: "TRY", aktif: "EVET" },
    // Maliyeti BİLİNMİYOR (boş) — 0 değil.
    { external_id: "URN-003", sku: "MT-300", urun_adi: "Kapak 300", birim: "adet",
      standart_maliyet: null, satis_fiyati: 150, para_birimi: "TRY", aktif: "EVET" },
  ],
  "11_PROJELER": [
    { external_id: "PRJ-001", proje_adi: "Otomotiv parça serisi", musteri: "Müşteri A",
      baslangic_tarihi: "2026-04-01", durum: "active", sozlesme_degeri: 1200000,
      butce_maliyeti: 800000, para_birimi: "TRY" },
    { external_id: "PRJ-002", proje_adi: "Kalıp yenileme", durum: "planned", para_birimi: "TRY" },
  ],
  "12_BUTCE": [
    { external_id: "BTC-001", donem: "2026-05", kategori: "Satış geliri", yon: "inflow",
      tutar: 2000000, para_birimi: "TRY", senaryo: "base_case" },
    { external_id: "BTC-002", donem: "2026-05", kategori: "Malzeme", yon: "outflow",
      tutar: 900000, para_birimi: "TRY", senaryo: "base_case" },
    { external_id: "BTC-003", donem: "2026-06", kategori: "Satış geliri", yon: "inflow",
      tutar: 2100000, para_birimi: "TRY", senaryo: "base_case" },
    // REDDEDİLMELİ: geçersiz senaryo.
    { external_id: "BTC-004", donem: "2026-06", kategori: "Malzeme", yon: "outflow",
      tutar: 950000, para_birimi: "TRY", senaryo: "iyimser" },
  ],
  "13_FX_POZISYONU": [
    { external_id: "FX-001", tarih: "2026-05-31", para_birimi: "USD", pozisyon_tipi: "receivable",
      doviz_tutari: 50000, try_kuru: 41.5, try_karsiligi: null },
    { external_id: "FX-002", tarih: "2026-05-31", para_birimi: "EUR", pozisyon_tipi: "payable",
      doviz_tutari: 20000, try_kuru: 45.2, try_karsiligi: 904000 },
    // Kur BİLİNMİYOR → TL karşılığı hesaplanamaz, uydurulmaz.
    { external_id: "FX-003", tarih: "2026-05-31", para_birimi: "GBP", pozisyon_tipi: "asset",
      doviz_tutari: 10000, try_kuru: null, try_karsiligi: null },
  ],
  "14_KAPASITE": [
    { external_id: "KAP-001", parca_kodu: "MT-100", parca_adi: "Flanş M100", adet: 500,
      torna_dk: 4.5, freze_dk: 2, diger_operasyon_dk: 0, satis_fiyati: 260,
      para_birimi: "TRY", calisma_gunu: 22, vardiya_sayisi: 1 },
    { external_id: "KAP-002", parca_kodu: "MT-200", parca_adi: "Mil 200", adet: 200,
      torna_dk: 12, freze_dk: 0, diger_operasyon_dk: 3, satis_fiyati: 700, para_birimi: "TRY" },
    // İNCELEMEYE DÜŞMELİ: hiçbir operasyon süresi girilmemiş (ölçülmemiş ≠ yok).
    { external_id: "KAP-003", parca_kodu: "MT-300", parca_adi: "Kapak 300", adet: 100,
      torna_dk: null, freze_dk: null, diger_operasyon_dk: null, satis_fiyati: 150, para_birimi: "TRY" },
  ],
  "15_MALIYET": [
    { external_id: "MLY-N-01", senaryo: "normal", maliyet_kategorisi: "Yemek",
      aylik_tutar: 120000, para_birimi: "TRY", personel_sayisi: 12, aylik_calisma_saati: 176 },
    { external_id: "MLY-N-02", senaryo: "normal", maliyet_kategorisi: "Servis",
      aylik_tutar: 80000, para_birimi: "TRY", personel_sayisi: 12, aylik_calisma_saati: 176 },
    { external_id: "MLY-O-01", senaryo: "overtime", maliyet_kategorisi: "Yemek",
      aylik_tutar: 150000, para_birimi: "TRY", personel_sayisi: 12, aylik_calisma_saati: 216 },
  ],
  "16_MAKINE_ROI": [
    { external_id: "MKN-001", makine_adi: "Awea", makine_kodu: "FR-01", alis_tarihi: "2023-03-01",
      alis_bedeli: 78000, para_birimi: "TRY", aylik_gelir: 40000,
      aylik_operasyon_maliyeti: 12000, faydali_omur_ay: 120, aktif: "EVET" },
    // İNCELEMEYE DÜŞMELİ: makine değil, kişisel gider.
    { external_id: "MKN-002", makine_adi: "Aile market gideri", alis_bedeli: 15000,
      para_birimi: "TRY", aktif: "EVET" },
  ],
};

/** Bilerek eklenen, sözleşmede olmayan başlık — `unknown_header` üretmeli. */
const EXTRA_HEADER = { sheet: "01_ODEMELER", header: "Muhasebe Fişi No" };

export async function buildFixtureWorkbook(): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  const fixed = new Date(Date.UTC(2026, 0, 1));
  wb.created = fixed;
  wb.modified = fixed;

  for (const spec of DATA_SHEETS) {
    const ws = wb.addWorksheet(spec.name);
    const headers = spec.columns.map((c) => c.header);
    if (EXTRA_HEADER.sheet === spec.name) headers.push(EXTRA_HEADER.header);
    ws.addRow(headers);

    for (const row of FIXTURE_ROWS[spec.name] ?? []) {
      ws.addRow(spec.columns.map((c) => (c.key in row ? (row[c.key] as ExcelJS.CellValue) : null)));
    }
  }

  const meta = wb.addWorksheet(META_SHEET);
  meta.state = "veryHidden";
  meta.addRow(["schema_name", SCHEMA_NAME]);
  meta.addRow(["schema_version", SCHEMA_VERSION]);
  meta.addRow(["template_version", TEMPLATE_VERSION]);
  meta.addRow(["template_id", TEMPLATE_ID]);
  return wb;
}

/**
 * Sabit test oracle'ı.
 *
 * Bu sayılar ELLE yazıldı ve fixture satırlarından türetilmedi. Üretimden türetilseydi test
 * "kendi hesabımı kendim doğruladım" demekten ibaret olurdu.
 */
export const FIXTURE_ORACLE = {
  schema: { name: SCHEMA_NAME, version: SCHEMA_VERSION },
  sheets: {
    "01_ODEMELER":        { rowsRead: 4, ready: 3, needsReview: 0, rejected: 1 },
    "02_CEKLER":          { rowsRead: 4, ready: 2, needsReview: 2, rejected: 0 },
    "03_KREDILER":        { rowsRead: 1, ready: 1, needsReview: 0, rejected: 0 },
    "04_KREDI_TAKSITLERI":{ rowsRead: 3, ready: 2, needsReview: 0, rejected: 1 },
    "05_NAKIT_AKISI":     { rowsRead: 5, ready: 5, needsReview: 0, rejected: 0 },
    "06_BANKA_HESAPLARI": { rowsRead: 2, ready: 2, needsReview: 0, rejected: 0 },
    "07_BANKA_HAREKETLERI": { rowsRead: 5, ready: 3, needsReview: 0, rejected: 2 },
    "08_FATURALAR":       { rowsRead: 2, ready: 2, needsReview: 0, rejected: 0 },
    "09_SIPARISLER":      { rowsRead: 2, ready: 2, needsReview: 0, rejected: 0 },
    "10_URUNLER":         { rowsRead: 3, ready: 3, needsReview: 0, rejected: 0 },
    "11_PROJELER":        { rowsRead: 2, ready: 2, needsReview: 0, rejected: 0 },
    "12_BUTCE":           { rowsRead: 4, ready: 3, needsReview: 0, rejected: 1 },
    "13_FX_POZISYONU":    { rowsRead: 3, ready: 3, needsReview: 0, rejected: 0 },
    "14_KAPASITE":        { rowsRead: 3, ready: 2, needsReview: 1, rejected: 0 },
    "15_MALIYET":         { rowsRead: 3, ready: 3, needsReview: 0, rejected: 0 },
    "16_MAKINE_ROI":      { rowsRead: 2, ready: 1, needsReview: 0, rejected: 1 },
  } as Record<string, { rowsRead: number; ready: number; needsReview: number; rejected: number }>,

  /** Kaynak hücreden beklenen çözülmüş değerler — SOURCE → PARSED zinciri kanıtı (§42). */
  goldenValues: [
    { sheet: "01_ODEMELER", row: 2, key: "tutar", expected: 35000 },
    { sheet: "01_ODEMELER", row: 3, key: "tutar", expected: null },   // BOŞ = bilinmiyor
    { sheet: "01_ODEMELER", row: 4, key: "tutar", expected: 0 },      // 0 = gerçek sıfır
    { sheet: "02_CEKLER",   row: 2, key: "signed_tutar", expected: -45000 },
    { sheet: "02_CEKLER",   row: 5, key: "signed_tutar", expected: 120000 },
    { sheet: "02_CEKLER",   row: 2, key: "vade_tarihi", expected: "2026-07-31" },
    { sheet: "03_KREDILER", row: 2, key: "anapara", expected: 1500000 },
    { sheet: "03_KREDILER", row: 2, key: "taksit_tutari", expected: 71744.12 },
    { sheet: "03_KREDILER", row: 2, key: "ilk_odeme_tarihi", expected: "2024-10-18" },
    { sheet: "05_NAKIT_AKISI", row: 2, key: "tutar", expected: 0 },   // devir gerçekten 0
    { sheet: "13_FX_POZISYONU", row: 4, key: "try_kuru", expected: null },
    { sheet: "14_KAPASITE", row: 3, key: "freze_dk", expected: 0 },   // 0 = freze işlemi yok
    { sheet: "14_KAPASITE", row: 4, key: "torna_dk", expected: null },// boş = ölçülmemiş
  ] as Array<{ sheet: string; row: number; key: string; expected: unknown }>,

  expectedIssueTypes: [
    "missing_required_field",   // 01 satır 5: aylık ama vade günü yok
    "duplicate_check",          // 02: Çağdaş ×2, seri no yok
    "missing_reference",        // 04 satır 4 ve 07 satır 5
    "invalid_date",             // 07 satır 6: 01/02/03
    "invalid_enum",             // 12 satır 5: 'iyimser'
    "missing_operation_time",   // 14 satır 4
    "personal_data_mixed",      // 16 satır 3
    "unknown_header",           // 01: 'Muhasebe Fişi No'
  ] as const,

  /** Toplam — sayfa oracle'larının toplamı, ayrıca elle doğrulandı. */
  totals: { rowsRead: 48, ready: 39, needsReview: 3, rejected: 6 },
} as const;
