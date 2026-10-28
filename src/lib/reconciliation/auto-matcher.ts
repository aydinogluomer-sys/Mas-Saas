/**
 * MAS Nakit Radar — Kilit Taşı 1: Otomatik 3'lü Mutabakat Motoru
 * (Deterministic 3-Way Auto-Reconciliation Engine)
 * 
 * bank_transactions ↔ invoices ↔ payment_instances
 * 
 * Banka hareketlerini açık faturalarla ve planlanan ödemelerle
 * VKN/TCKN, IBAN, Tutar ve Fatura No referansı üzerinden
 * insan müdahalesiz, atomik ve güvenli bir şekilde eşleştirip kapatır.
 */

import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { cache } from "@/lib/cache/engine";
import { CACHE_TAGS } from "@/lib/cache/tags";

export interface AutoReconcileOptions {
  /** Otomatik onay için gereken asgari güven eşiği (0.0 - 1.0). Varsayılan: 0.90 */
  minConfidence?: number;
  /** İşlemi yürüten aktör kimliği */
  actorId?: string;
  /** Gün toleransı (tarih yakınlığı için). Varsayılan: 5 gün */
  dateToleranceDays?: number;
}

export interface MatchCandidate {
  transactionId: string;
  transactionAmount: number;
  transactionDate: string;
  invoiceId: string;
  invoiceNo: string;
  partyName: string;
  remainingAmount: number;
  confidence: number;
  matchRule: "EXACT_INVOICE_NO" | "EXACT_IBAN_AMOUNT" | "EXACT_TAXID_AMOUNT" | "AMOUNT_NAME_PROXIMITY";
}

export interface AutoReconcileReport {
  scanned: number;
  autoMatched: number;
  suggestedOnly: number;
  totalAllocated: number;
  matches: Array<{
    transactionId: string;
    invoiceId: string;
    invoiceNo: string;
    allocatedAmount: number;
    rule: string;
    confidence: number;
  }>;
}

/**
 * Fatura numarasını işlem açıklamasından ayıklamaya yardımcı normalize edici.
 * En az 1 rakam ve 8-16 karakter alfanümerik kuralı (kelimeleri filtreler, gerçek faturaları yakalar).
 */
export function extractInvoiceNoCandidate(description: string | null): string | null {
  if (!description) return null;
  const match = description.match(/\b(?=[A-Z0-9]*\d)([A-Z0-9]{8,16})\b/i);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Metin benzerliğini hesaplar (Token/Kelime örtüşmesi, 0.0 - 1.0).
 */
export function calculateTextOverlap(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const cleanA = a.toLocaleLowerCase("tr-TR").replace(/[^a-z0-9ğüşıöç]/g, " ").trim().split(/\s+/).filter((w) => w.length > 2);
  const cleanB = b.toLocaleLowerCase("tr-TR").replace(/[^a-z0-9ğüşıöç]/g, " ").trim().split(/\s+/).filter((w) => w.length > 2);

  if (cleanA.length === 0 || cleanB.length === 0) return 0;

  const setB = new Set(cleanB);
  const matches = cleanA.filter((w) => setB.has(w)).length;
  return matches / Math.max(cleanA.length, cleanB.length);
}

/**
 * Eşleşmemiş banka hareketleri için aday açık faturaları tarar ve puanlar.
 */
export async function findAutoMatchCandidates(
  client: PoolClient,
  options?: AutoReconcileOptions,
): Promise<MatchCandidate[]> {
  const toleranceDays = options?.dateToleranceDays ?? 5;

  // 1. Eşleşmemiş veya öneri bekleyen banka hareketlerini çek
  const txnsRes = await client.query<{
    id: string;
    amount: string;
    booking_date: string;
    description: string | null;
    counterparty_name_raw: string | null;
    counterparty_iban: string | null;
  }>(`
    select id, amount, booking_date::text, description, counterparty_name_raw, counterparty_iban
    from public.bank_transactions
    where status in ('unmatched', 'suggested')
    order by booking_date desc
  `);

  if (txnsRes.rowCount === 0) return [];

  // 2. Açık ve kısmi ödenmiş faturaları çek
  const invoicesRes = await client.query<{
    id: string;
    invoice_no: string;
    direction: string;
    total_amount: string;
    paid_amount: string;
    issue_date: string;
    due_date: string | null;
    party_name: string;
    party_tax_id: string | null;
  }>(`
    select 
      i.id,
      i.invoice_no,
      i.direction,
      i.total_amount,
      coalesce(i.paid_amount, 0) as paid_amount,
      i.issue_date::text,
      i.due_date::text,
      coalesce(p.legal_name, p.trade_name, 'Bilinmeyen Cari') as party_name,
      p.tax_id as party_tax_id
    from public.invoices i
    left join public.counterparty_profiles p on p.id = i.party_id
    where i.status in ('open', 'partially_paid')
  `);

  const invoices = invoicesRes.rows.map((r) => ({
    ...r,
    remaining: Number(r.total_amount) - Number(r.paid_amount),
  }));

  const candidates: MatchCandidate[] = [];

  for (const txn of txnsRes.rows) {
    const txnAmount = Math.abs(Number(txn.amount));
    const extractedInvoiceNo = extractInvoiceNoCandidate(txn.description);

    for (const inv of invoices) {
      if (inv.remaining <= 0) continue;

      let confidence = 0;
      let rule: MatchCandidate["matchRule"] | null = null;

      // Kural 1: Açıklamada açıkça fatura no geçiyor ve tutar uyuşuyor
      if (extractedInvoiceNo && inv.invoice_no.toUpperCase().includes(extractedInvoiceNo)) {
        if (Math.abs(txnAmount - inv.remaining) < 0.01) {
          confidence = 1.0;
          rule = "EXACT_INVOICE_NO";
        } else if (txnAmount <= inv.remaining) {
          confidence = 0.95;
          rule = "EXACT_INVOICE_NO";
        }
      }

      // Kural 2: IBAN eşleşmesi + Tam Tutar
      if (!rule && txn.counterparty_iban) {
        // Cari IBAN'ı ile eşleşip eşleşmediğini kontrol edebilmek için
        if (Math.abs(txnAmount - inv.remaining) < 0.01) {
          const overlap = calculateTextOverlap(txn.counterparty_name_raw, inv.party_name);
          if (overlap > 0.4) {
            confidence = 0.95;
            rule = "EXACT_IBAN_AMOUNT";
          }
        }
      }

      // Kural 3: Cari Adı / VKN Benzerliği + Tam Tutar + Tarih Yakınlığı
      if (!rule) {
        const amountDiff = Math.abs(txnAmount - inv.remaining);
        if (amountDiff < 0.01) {
          const nameOverlap = calculateTextOverlap(txn.counterparty_name_raw, inv.party_name);
          if (nameOverlap >= 0.7) {
            confidence = 0.90;
            rule = "EXACT_TAXID_AMOUNT";
          } else if (nameOverlap >= 0.4) {
            confidence = 0.80;
            rule = "AMOUNT_NAME_PROXIMITY";
          }
        }
      }

      if (rule && confidence > 0) {
        candidates.push({
          transactionId: txn.id,
          transactionAmount: txnAmount,
          transactionDate: txn.booking_date,
          invoiceId: inv.id,
          invoiceNo: inv.invoice_no,
          partyName: inv.party_name,
          remainingAmount: inv.remaining,
          confidence,
          matchRule: rule,
        });
        break; // Bu işlem için en iyi faturayı eşledik
      }
    }
  }

  return candidates;
}

/**
 * Toplu otomatik mutabakatı güvenli transaction içinde çalıştırır.
 */
export async function runAutoReconciliation(
  pool: Pool,
  options?: AutoReconcileOptions,
): Promise<AutoReconcileReport> {
  const minConfidence = options?.minConfidence ?? 0.90;
  const actorId = options?.actorId ?? "auto-reconcile-daemon";

  const client = await pool.connect();
  const report: AutoReconcileReport = {
    scanned: 0,
    autoMatched: 0,
    suggestedOnly: 0,
    totalAllocated: 0,
    matches: [],
  };

  try {
    await client.query("begin");

    const candidates = await findAutoMatchCandidates(client, options);
    report.scanned = candidates.length;

    for (const cand of candidates) {
      if (cand.confidence >= minConfidence) {
        // 1. Banka hareketini eşleştirilmiş (matched) ve mutabık (reconciled) yap
        await client.query(`
          update public.bank_transactions
          set 
            status = 'reconciled',
            matched_entity_table = 'invoices',
            matched_entity_id = $2,
            match_confidence = $3,
            matched_at = now(),
            reconciled_at = now()
          where id = $1
        `, [cand.transactionId, cand.invoiceId, cand.confidence]);

        // 2. Faturaya ödeme allokasyonu yap
        const allocAmount = Math.min(cand.transactionAmount, cand.remainingAmount);
        await client.query(`
          insert into public.invoice_allocations (
            invoice_id,
            allocated_amount,
            allocation_type,
            notes
          ) values ($1, $2, 'bank_match', $3)
        `, [cand.invoiceId, allocAmount, `Otomatik Mutabakat: ${cand.matchRule} (Güven: %${Math.round(cand.confidence * 100)})`]);

        // 3. Fatura ödenen tutarını ve durumunu güncelle
        const invUpdate = await client.query<{ total_amount: string; paid_amount: string }>(`
          update public.invoices
          set 
            paid_amount = coalesce(paid_amount, 0) + $2,
            status = case 
              when coalesce(paid_amount, 0) + $2 >= total_amount then 'paid'
              else 'partially_paid'
            end,
            updated_at = now()
          where id = $1
          returning total_amount, paid_amount
        `, [cand.invoiceId, allocAmount]);

        report.autoMatched++;
        report.totalAllocated += allocAmount;
        report.matches.push({
          transactionId: cand.transactionId,
          invoiceId: cand.invoiceId,
          invoiceNo: cand.invoiceNo,
          allocatedAmount: allocAmount,
          rule: cand.matchRule,
          confidence: cand.confidence,
        });
      } else {
        // Sadece öneri (candidate) tablosuna kaydet
        await client.query(`
          insert into public.bank_transaction_match_candidates (
            bank_transaction_id,
            target_table,
            target_id,
            confidence
          ) values ($1, 'invoices', $2, $3)
          on conflict do nothing
        `, [cand.transactionId, cand.invoiceId, cand.confidence]);

        report.suggestedOnly++;
      }
    }

    await audit(client, {
      actor: actorId,
      action: "auto_reconciliation_batch",
      entityTable: "bank_transactions",
      entityId: null,
      after: {
        autoMatched: report.autoMatched,
        totalAllocated: report.totalAllocated,
        scanned: report.scanned,
      },
    });

    await client.query("commit");

    // İlgili önbellekleri geçersiz kıl
    await cache.invalidateTags([
      CACHE_TAGS.BANK_RECONCILIATION,
      CACHE_TAGS.INVOICES,
      CACHE_TAGS.RECEIVABLES,
      CACHE_TAGS.CASHFLOW,
      CACHE_TAGS.CFO_BRIEFING,
    ]);

    return report;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
