import type { ErpVendor, ErpWebhookPayload } from "./types";

export const DEFAULT_ERP_KEY = "erp_mas_default_live_key_2026";

/**
 * Verify incoming webhook / agent authorization.
 * Accepts X-ERP-API-Key or Bearer token against configured key.
 */
export function verifyErpApiKey(
  providedKey: string | null | undefined,
  expectedKey = DEFAULT_ERP_KEY,
): boolean {
  if (!providedKey) return false;
  const clean = providedKey.replace(/^Bearer\s+/i, "").trim();
  return clean === expectedKey;
}

/**
 * Generate sample payloads for interactive testing and demonstration in the UI.
 */
export function getSampleErpPayload(vendor: ErpVendor): ErpWebhookPayload {
  const today = new Date().toISOString().slice(0, 10);
  const nextMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

  switch (vendor) {
    case "logo":
      return {
        vendor: "logo",
        payloadType: "invoices",
        data: [
          {
            LOGICALREF: `LGO-TX-${Date.now().toString().slice(-5)}`,
            FICHENO: `FAT2026-${Math.floor(1000 + Math.random() * 9000)}`,
            TRCODE: 8, // Satış Faturası
            DATE_: today,
            DUEDATE: nextMonth,
            ARP_CODE: "120.01.042",
            ARP_NAME: "Ege Torna ve Mekanik San. Tic. A.Ş.",
            TAX_NR: "3250918234",
            NETTOTAL: 125000,
            TOTAL_VAT: 25000,
            GROSSTOTAL: 150000,
            CURRENCY: "TRY",
            GENEXP1: "CNC İşleme Parçaları ve Kalıp Sevkiyatı (Logo Otomatik Aktarım)",
          },
          {
            LOGICALREF: `LGO-TX-${(Date.now() + 1).toString().slice(-5)}`,
            FICHENO: `ALF2026-${Math.floor(1000 + Math.random() * 9000)}`,
            TRCODE: 1, // Satınalma Faturası
            DATE_: today,
            DUEDATE: nextMonth,
            ARP_CODE: "320.01.018",
            ARP_NAME: "Çelik Hadde Sanayi Ltd. Şti.",
            TAX_NR: "2480193845",
            NETTOTAL: 80000,
            TOTAL_VAT: 16000,
            GROSSTOTAL: 96000,
            CURRENCY: "TRY",
            GENEXP1: "Ham Çelik Profil ve Hammadde Tedariği",
          },
        ],
      };

    case "mikro":
      return {
        vendor: "mikro",
        payloadType: "invoices",
        data: [
          {
            cha_Guid: `MKR-${Date.now()}`,
            cha_belge_no: `MKR-FT-${Math.floor(1000 + Math.random() * 9000)}`,
            cha_tarihi: today,
            cha_vade: nextMonth,
            cha_kod: "M-120-77",
            cha_unvan: "Bursa Otomotiv Yan Sanayi A.Ş.",
            cha_vergi_no: "1928374650",
            cha_cinsi: 1, // Satış
            cha_matrah: 210000,
            cha_kdv: 42000,
            cha_meblag: 252000,
            cha_dimes: "TRY",
            cha_aciklama: "Otomotiv Yan Parça İhracatı (Mikro Köprüsü)",
          },
        ],
      };

    case "zirve":
      return {
        vendor: "zirve",
        payloadType: "invoices",
        data: [
          {
            kayitNo: `ZRV-${Date.now()}`,
            faturaNo: `ZRV-2026-${Math.floor(1000 + Math.random() * 9000)}`,
            tarih: today,
            vadeTarihi: nextMonth,
            cariKod: "ZR-320-11",
            unvan: "Anadolu Lojistik ve Antrepo Hizmetleri",
            vknTckn: "5849302194",
            faturaTipi: "ALIS",
            kdvHaric: 45000,
            kdv: 9000,
            toplam: 54000,
            doviz: "TRY",
            aciklama: "Konteyner ve Palet Taşımacılığı (Zirve Finansman)",
          },
        ],
      };

    case "parasut":
      return {
        vendor: "parasut",
        payloadType: "invoices",
        data: [
          {
            id: `PRS-INV-${Date.now()}`,
            type: "sales_invoices",
            attributes: {
              invoice_no: `PRS-${Math.floor(1000 + Math.random() * 9000)}`,
              issue_date: today,
              due_date: nextMonth,
              net_total: 65000,
              total_vat: 13000,
              gross_total: 78000,
              currency: "TRY",
              description: "Yazılım Danışmanlığı & Bulut Altyapı Lisansı",
            },
            relationships: {
              contact: {
                data: {
                  name: "Kuzey Bilişim Teknolojileri A.Ş.",
                  tax_number: "6789012345",
                },
              },
            },
          },
        ],
      };

    case "luca":
      return {
        vendor: "luca",
        payloadType: "invoices",
        data: [
          {
            islemId: `LCA-${Date.now()}`,
            belgeNo: `LCA-F-${Math.floor(1000 + Math.random() * 9000)}`,
            belgeTarihi: today,
            vadeTarihi: nextMonth,
            cariUnvan: "Marmara Ambalaj ve Matbaacılık",
            vergiNo: "4728193049",
            borc: 0,
            alacak: 38000,
            tutar: 38000,
            dovizCinsi: "TRY",
            aciklama: "Koli ve Ambalaj Malzemeleri Dökümü (Luca)",
          },
        ],
      };

    default:
      return {
        vendor: "generic",
        payloadType: "invoices",
        data: [
          {
            externalId: `GEN-${Date.now()}`,
            invoiceNo: `GEN-INV-${Math.floor(1000 + Math.random() * 9000)}`,
            direction: "sales",
            counterpartyName: "Standard Kurumsal Müşteri A.Ş.",
            counterpartyTaxNo: "9988776655",
            issueDate: today,
            dueDate: nextMonth,
            currency: "TRY",
            netAmount: 100000,
            taxAmount: 20000,
            grossAmount: 120000,
            notes: "Standart JSON ERP Entegrasyon Akışı",
          },
        ],
      };
  }
}

/**
 * Generate standalone Python / PowerShell script snippet for IT admins.
 */
export function getAgentScriptSnippet(baseUrl: string, apiKey = DEFAULT_ERP_KEY): {
  python: string;
  powershell: string;
} {
  const python = `# MAS Nakit Radar — ERP Otomatik Senkronizasyon Ajanı
# Kurulum: pip install requests pyodbc
import requests, json

WEBHOOK_URL = "${baseUrl}/api/erp/webhook"
API_KEY = "${apiKey}"

def sync_invoices():
    # Buraya Logo/Mikro SQL Server sorgunuzu bağlayabilirsiniz
    payload = {
        "vendor": "logo",
        "payloadType": "invoices",
        "data": [
            {
                "FICHENO": "FAT-00123",
                "ARP_NAME": "Ornek Musteri AS",
                "DATE_": "2026-10-18",
                "GROSSTOTAL": 150000.0,
                "CURRENCY": "TRY"
            }
        ]
    }
    headers = {
        "Content-Type": "application/json",
        "X-ERP-API-Key": API_KEY
    }
    res = requests.post(WEBHOOK_URL, json=payload, headers=headers)
    print("MAS Radar Yanıtı:", res.status_code, res.json())

if __name__ == "__main__":
    sync_invoices()
`;

  const powershell = `# MAS Nakit Radar — Windows PowerShell ERP Zamanlanmış Görev
$WebhookUrl = "${baseUrl}/api/erp/webhook"
$ApiKey = "${apiKey}"

$body = @{
    vendor = "logo"
    payloadType = "invoices"
    data = @(
        @{
            FICHENO = "FAT-$(Get-Random -Minimum 1000 -Maximum 9999)"
            ARP_NAME = "Örnek Cari A.Ş."
            DATE_ = (Get-Date -Format 'yyyy-MM-dd')
            GROSSTOTAL = 125000
            CURRENCY = "TRY"
        }
    )
} | ConvertTo-Json -Depth 5

$headers = @{
    "Content-Type" = "application/json"
    "X-ERP-API-Key" = $ApiKey
}

$response = Invoke-RestMethod -Uri $WebhookUrl -Method Post -Body $body -Headers $headers
Write-Output $response
`;

  return { python, powershell };
}
