import { moneyOrNull } from "@/lib/money";
import type {
  ErpCheckDto,
  ErpCounterpartyDto,
  ErpInvoiceDto,
  ErpVendor,
} from "./types";

function parseDateIso(raw: unknown): string {
  if (typeof raw !== "string" && !(raw instanceof Date)) {
    return new Date().toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Match DD.MM.YYYY or DD/MM/YYYY
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = m[2].padStart(2, "0");
    const year = m[3];
    return `${year}-${month}-${day}`;
  }
  return new Date().toISOString().slice(0, 10);
}

function parseNumber(raw: unknown, fallback = 0): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    // Handle Turkish number formatting like 1.250,50
    let clean = raw.trim();
    if (clean.includes(",") && clean.includes(".")) {
      clean = clean.replace(/\./g, "").replace(",", ".");
    } else if (clean.includes(",")) {
      clean = clean.replace(",", ".");
    }
    const n = Number(clean);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function mapLogoInvoicePayload(item: Record<string, unknown>, index: number): ErpInvoiceDto | null {
  const invoiceNo = String(
    item.INVOICE_NUMBER ?? item.FICHENO ?? item.faturaNo ?? item.document_no ?? `LGO-${index + 1}`,
  ).trim();
  const counterpartyName = String(
    item.ARP_NAME ?? item.TITLE ?? item.cariUnvan ?? item.counterparty_name ?? "Tanımsız Logo Cari",
  ).trim();
  const counterpartyTaxNo = item.TAX_NR ?? item.VKN ?? item.vkn ?? item.tax_number ? String(item.TAX_NR ?? item.VKN ?? item.vkn ?? item.tax_number).trim() : null;

  const trcode = Number(item.TRCODE ?? item.trcode ?? 8);
  // Logo TRCODE: 1, 2, 3, 4 = Purchase (Satınalma / Alış), 6, 7, 8, 9 = Sales (Satış)
  const direction: "sales" | "purchase" =
    item.direction === "purchase" || trcode === 1 || trcode === 2 || trcode === 3 || trcode === 4
      ? "purchase"
      : "sales";

  const grossAmount = parseNumber(item.GROSSTOTAL ?? item.TOTAL ?? item.genelToplam ?? item.amount, 0);
  const taxAmount = parseNumber(item.TOTAL_VAT ?? item.VAT ?? item.kdvTutar, grossAmount * 0.2);
  const netAmount = parseNumber(item.NETTOTAL ?? item.SUBTOTAL ?? item.netTutar, grossAmount - taxAmount);

  if (grossAmount <= 0) return null;

  return {
    externalId: String(item.LOGICALREF ?? item.ID ?? item.id ?? invoiceNo),
    invoiceNo,
    direction,
    counterpartyName,
    counterpartyTaxNo,
    issueDate: parseDateIso(item.DATE_ ?? item.DATE ?? item.tarih ?? item.issue_date),
    dueDate: item.DUEDATE ?? item.vadeTarihi ? parseDateIso(item.DUEDATE ?? item.vadeTarihi) : null,
    currency: String(item.CURRENCY ?? item.DOVIZ ?? item.currency ?? "TRY").toUpperCase(),
    netAmount: moneyOrNull(netAmount) ?? 0,
    taxAmount: moneyOrNull(taxAmount) ?? 0,
    grossAmount: moneyOrNull(grossAmount) ?? grossAmount,
    notes: typeof item.GENEXP1 === "string" ? item.GENEXP1 : null,
  };
}

export function mapMikroInvoicePayload(item: Record<string, unknown>, index: number): ErpInvoiceDto | null {
  const invoiceNo = String(
    item.cha_belge_no ?? item.belgeNo ?? item.faturaNo ?? `MKR-${index + 1}`,
  ).trim();
  const counterpartyName = String(
    item.cha_unvan ?? item.cariUnvan ?? item.unvan ?? "Tanımsız Mikro Cari",
  ).trim();
  const counterpartyTaxNo = item.cha_vergi_no ?? item.vergiNo ? String(item.cha_vergi_no ?? item.vergiNo).trim() : null;

  // Mikro cha_cinsi: 0 = Borç / Alış Faturası, 1 = Alacak / Satış Faturası
  const cinsi = Number(item.cha_cinsi ?? item.cinsi ?? 1);
  const direction: "sales" | "purchase" =
    item.direction === "purchase" || cinsi === 0 ? "purchase" : "sales";

  const grossAmount = parseNumber(item.cha_meblag ?? item.tutar ?? item.toplam, 0);
  const taxAmount = parseNumber(item.cha_kdv ?? item.kdv, grossAmount * 0.2);
  const netAmount = parseNumber(item.cha_matrah ?? item.matrah, grossAmount - taxAmount);

  if (grossAmount <= 0) return null;

  return {
    externalId: String(item.cha_Guid ?? item.guid ?? item.id ?? invoiceNo),
    invoiceNo,
    direction,
    counterpartyName,
    counterpartyTaxNo,
    issueDate: parseDateIso(item.cha_tarihi ?? item.tarih),
    dueDate: item.cha_vade ? parseDateIso(item.cha_vade) : null,
    currency: String(item.cha_dimes ?? item.paraBirimi ?? "TRY").toUpperCase(),
    netAmount: moneyOrNull(netAmount) ?? 0,
    taxAmount: moneyOrNull(taxAmount) ?? 0,
    grossAmount: moneyOrNull(grossAmount) ?? grossAmount,
    notes: typeof item.cha_aciklama === "string" ? item.cha_aciklama : null,
  };
}

export function mapZirveInvoicePayload(item: Record<string, unknown>, index: number): ErpInvoiceDto | null {
  const invoiceNo = String(item.faturaNo ?? item.belgeNo ?? `ZRV-${index + 1}`).trim();
  const counterpartyName = String(item.unvan ?? item.cariUnvan ?? "Tanımsız Zirve Cari").trim();
  const counterpartyTaxNo = item.vknTckn ?? item.vergiNo ? String(item.vknTckn ?? item.vergiNo).trim() : null;

  const tip = String(item.faturaTipi ?? item.tip ?? "SATIS").toUpperCase();
  const direction: "sales" | "purchase" =
    item.direction === "purchase" || tip.includes("ALIS") || tip.includes("GIDER") ? "purchase" : "sales";

  const grossAmount = parseNumber(item.toplam ?? item.kdvDahil ?? item.tutar, 0);
  const taxAmount = parseNumber(item.kdv ?? item.kdvTutar, grossAmount * 0.2);
  const netAmount = parseNumber(item.matrah ?? item.kdvHaric, grossAmount - taxAmount);

  if (grossAmount <= 0) return null;

  return {
    externalId: String(item.kayitNo ?? item.id ?? invoiceNo),
    invoiceNo,
    direction,
    counterpartyName,
    counterpartyTaxNo,
    issueDate: parseDateIso(item.tarih ?? item.faturaTarihi),
    dueDate: item.vadeTarihi ? parseDateIso(item.vadeTarihi) : null,
    currency: String(item.doviz ?? item.currency ?? "TRY").toUpperCase(),
    netAmount: moneyOrNull(netAmount) ?? 0,
    taxAmount: moneyOrNull(taxAmount) ?? 0,
    grossAmount: moneyOrNull(grossAmount) ?? grossAmount,
    notes: typeof item.aciklama === "string" ? item.aciklama : null,
  };
}

export function mapParasutInvoicePayload(item: Record<string, unknown>, index: number): ErpInvoiceDto | null {
  const attrs = (item.attributes as Record<string, unknown>) ?? item;
  const rels = (item.relationships as Record<string, unknown>) ?? {};
  const contactData = ((rels.contact as Record<string, unknown>)?.data as Record<string, unknown>) ?? {};

  const invoiceNo = String(attrs.invoice_no ?? attrs.faturaNo ?? `PRS-${index + 1}`).trim();
  const counterpartyName = String(
    attrs.contact_name ?? contactData.name ?? attrs.customer_name ?? "Tanımsız Paraşüt İletişim",
  ).trim();
  const counterpartyTaxNo = attrs.tax_number ?? contactData.tax_number ? String(attrs.tax_number ?? contactData.tax_number).trim() : null;

  const itemType = String(item.type ?? attrs.item_type ?? "").toLowerCase();
  const direction: "sales" | "purchase" =
    itemType.includes("purchase") || attrs.direction === "purchase" ? "purchase" : "sales";

  const grossAmount = parseNumber(attrs.gross_total ?? attrs.payable_amount ?? attrs.total, 0);
  const taxAmount = parseNumber(attrs.total_vat ?? attrs.vat, grossAmount * 0.2);
  const netAmount = parseNumber(attrs.net_total ?? attrs.net, grossAmount - taxAmount);

  if (grossAmount <= 0) return null;

  return {
    externalId: String(item.id ?? attrs.id ?? invoiceNo),
    invoiceNo,
    direction,
    counterpartyName,
    counterpartyTaxNo,
    issueDate: parseDateIso(attrs.issue_date ?? attrs.tarih),
    dueDate: attrs.due_date ? parseDateIso(attrs.due_date) : null,
    currency: String(attrs.currency ?? "TRY").toUpperCase(),
    netAmount: moneyOrNull(netAmount) ?? 0,
    taxAmount: moneyOrNull(taxAmount) ?? 0,
    grossAmount: moneyOrNull(grossAmount) ?? grossAmount,
    notes: typeof attrs.description === "string" ? attrs.description : null,
  };
}

export function mapLucaInvoicePayload(item: Record<string, unknown>, index: number): ErpInvoiceDto | null {
  const invoiceNo = String(item.belgeNo ?? item.evrakNo ?? `LCA-${index + 1}`).trim();
  const counterpartyName = String(item.cariUnvan ?? item.unvan ?? "Tanımsız Luca Cari").trim();
  const counterpartyTaxNo = item.vergiNo ?? item.vkn ? String(item.vergiNo ?? item.vkn).trim() : null;

  const borc = parseNumber(item.borc, 0);
  const alacak = parseNumber(item.alacak, 0);
  const direction: "sales" | "purchase" =
    item.direction === "purchase" || borc > alacak ? "purchase" : "sales";
  const grossAmount = Math.max(borc, alacak, parseNumber(item.tutar, 0));
  const taxAmount = parseNumber(item.kdv, grossAmount * 0.2);
  const netAmount = grossAmount - taxAmount;

  if (grossAmount <= 0) return null;

  return {
    externalId: String(item.islemId ?? item.id ?? invoiceNo),
    invoiceNo,
    direction,
    counterpartyName,
    counterpartyTaxNo,
    issueDate: parseDateIso(item.belgeTarihi ?? item.tarih),
    dueDate: item.vadeTarihi ? parseDateIso(item.vadeTarihi) : null,
    currency: String(item.dovizCinsi ?? item.currency ?? "TRY").toUpperCase(),
    netAmount: moneyOrNull(netAmount) ?? 0,
    taxAmount: moneyOrNull(taxAmount) ?? 0,
    grossAmount: moneyOrNull(grossAmount) ?? grossAmount,
    notes: typeof item.aciklama === "string" ? item.aciklama : null,
  };
}

export function mapGenericInvoicePayload(item: Record<string, unknown>, index: number): ErpInvoiceDto | null {
  const invoiceNo = String(item.invoiceNo ?? item.invoice_no ?? `ERP-${index + 1}`).trim();
  const counterpartyName = String(
    item.counterpartyName ?? item.counterparty_name ?? item.customerName ?? item.vendorName ?? "Tanımsız ERP Cari",
  ).trim();
  const counterpartyTaxNo = item.counterpartyTaxNo ?? item.tax_number ? String(item.counterpartyTaxNo ?? item.tax_number).trim() : null;

  const direction: "sales" | "purchase" =
    String(item.direction).toLowerCase() === "purchase" ? "purchase" : "sales";

  const grossAmount = parseNumber(item.grossAmount ?? item.gross_amount ?? item.amount, 0);
  const taxAmount = parseNumber(item.taxAmount ?? item.tax_amount, grossAmount * 0.2);
  const netAmount = parseNumber(item.netAmount ?? item.net_amount, grossAmount - taxAmount);

  if (grossAmount <= 0) return null;

  return {
    externalId: String(item.externalId ?? item.id ?? invoiceNo),
    invoiceNo,
    direction,
    counterpartyName,
    counterpartyTaxNo,
    issueDate: parseDateIso(item.issueDate ?? item.issue_date ?? item.date),
    dueDate: item.dueDate || item.due_date ? parseDateIso(item.dueDate ?? item.due_date) : null,
    currency: String(item.currency ?? "TRY").toUpperCase(),
    netAmount: moneyOrNull(netAmount) ?? 0,
    taxAmount: moneyOrNull(taxAmount) ?? 0,
    grossAmount: moneyOrNull(grossAmount) ?? grossAmount,
    notes: typeof item.notes === "string" ? item.notes : null,
  };
}

export function mapErpInvoices(vendor: ErpVendor, data: Array<Record<string, unknown>>): ErpInvoiceDto[] {
  const results: ErpInvoiceDto[] = [];
  data.forEach((row, i) => {
    let dto: ErpInvoiceDto | null = null;
    switch (vendor) {
      case "logo":
        dto = mapLogoInvoicePayload(row, i);
        break;
      case "mikro":
        dto = mapMikroInvoicePayload(row, i);
        break;
      case "zirve":
        dto = mapZirveInvoicePayload(row, i);
        break;
      case "parasut":
        dto = mapParasutInvoicePayload(row, i);
        break;
      case "luca":
        dto = mapLucaInvoicePayload(row, i);
        break;
      default:
        dto = mapGenericInvoicePayload(row, i);
        break;
    }
    if (dto) results.push(dto);
  });
  return results;
}

export function mapErpCounterparties(vendor: ErpVendor, data: Array<Record<string, unknown>>): ErpCounterpartyDto[] {
  return data.map((row, i) => {
    const code = String(row.code ?? row.cariKod ?? row.ARP_CODE ?? row.cha_kod ?? `C-${i + 1}`).trim();
    const name = String(row.name ?? row.unvan ?? row.ARP_NAME ?? row.cha_unvan ?? `Cari ${i + 1}`).trim();
    const taxNo = row.taxNo ?? row.vergiNo ?? row.VKN ?? row.vknTckn ?? row.cha_vergi_no ? String(row.taxNo ?? row.vergiNo ?? row.VKN ?? row.vknTckn ?? row.cha_vergi_no).trim() : null;
    const city = typeof row.city === "string" ? row.city : typeof row.sehir === "string" ? row.sehir : null;
    const creditLimit = parseNumber(row.creditLimit ?? row.krediLimiti ?? row.riskLimiti, 0);

    return {
      externalId: String(row.id ?? row.guid ?? code),
      code,
      name,
      taxNo,
      city,
      partyType: "company",
      creditLimit: creditLimit > 0 ? creditLimit : null,
    };
  });
}

export function mapErpChecks(vendor: ErpVendor, data: Array<Record<string, unknown>>): ErpCheckDto[] {
  return data.map((row, i) => {
    const serial = String(row.serial ?? row.cekNo ?? row.SERI_NO ?? `CHK-${i + 1}`).trim();
    const amount = parseNumber(row.amount ?? row.tutar ?? row.MEBLAG, 0);
    const maturityDate = parseDateIso(row.maturityDate ?? row.vadeTarihi ?? row.VADE);
    const counterpartyName = String(row.counterpartyName ?? row.kesideci ?? row.unvan ?? "Tanımsız Çek Keşidecisi").trim();
    const direction: "inflow" | "outflow" =
      String(row.direction).toLowerCase() === "outflow" || row.tip === "BORC" ? "outflow" : "inflow";

    return {
      externalId: String(row.id ?? serial),
      serial,
      maturityDate,
      amount,
      currency: String(row.currency ?? row.doviz ?? "TRY").toUpperCase(),
      direction,
      counterpartyName,
      bankName: typeof row.bankName === "string" ? row.bankName : typeof row.banka === "string" ? row.banka : null,
    };
  });
}
