import { z } from "zod";

export const ERP_VENDORS = ["logo", "mikro", "zirve", "parasut", "luca", "generic"] as const;
export type ErpVendor = (typeof ERP_VENDORS)[number];

export const ERP_PAYLOAD_TYPES = ["invoices", "counterparties", "checks", "bank_transactions"] as const;
export type ErpPayloadType = (typeof ERP_PAYLOAD_TYPES)[number];

export interface ErpInvoiceLineDto {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  unit?: string;
}

export interface ErpInvoiceDto {
  externalId: string;
  invoiceNo: string;
  direction: "sales" | "purchase";
  counterpartyName: string;
  counterpartyTaxNo?: string | null;
  issueDate: string; // YYYY-MM-DD
  dueDate?: string | null; // YYYY-MM-DD
  currency: string;
  netAmount: number;
  taxAmount: number;
  grossAmount: number;
  notes?: string | null;
  lines?: ErpInvoiceLineDto[];
}

export interface ErpCounterpartyDto {
  externalId: string;
  code: string;
  name: string;
  taxNo?: string | null;
  taxOffice?: string | null;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  partyType?: "customer" | "vendor" | "company";
  creditLimit?: number | null;
}

export interface ErpCheckDto {
  externalId: string;
  serial: string;
  maturityDate: string; // YYYY-MM-DD
  amount: number;
  currency: string;
  direction: "inflow" | "outflow"; // inflow = müşteri çeki, outflow = borç çeki
  counterpartyName: string;
  bankName?: string | null;
}

export interface ErpIngestionResult {
  ok: boolean;
  vendor: ErpVendor;
  payloadType: ErpPayloadType;
  totalOffered: number;
  imported: number;
  skipped: number;
  updated: number;
  error?: string;
  details?: Array<{ id: string; status: "imported" | "skipped" | "error"; message?: string }>;
}

export interface ErpVendorStatus {
  vendor: ErpVendor;
  name: string;
  category: "desktop_sql" | "cloud_rest" | "desktop_file" | "hybrid";
  supportedData: ErpPayloadType[];
  status: "ready" | "connected" | "pending";
  lastSyncAt: string | null;
  totalImportedInvoices: number;
  description: string;
}

export const erpWebhookPayloadSchema = z.object({
  vendor: z.enum(ERP_VENDORS),
  payloadType: z.enum(ERP_PAYLOAD_TYPES).default("invoices"),
  data: z.array(z.record(z.string(), z.unknown())).min(1, "En az bir veri satırı gereklidir"),
});
export type ErpWebhookPayload = z.infer<typeof erpWebhookPayloadSchema>;
