// Host-to-Host ISO 20022 `pain.002.001.03` (`CstmrPmtStsRpt`) Bank Payment Status Parser & Reconciler.
//
// Invariants:
//   - Strict XXE defense: rejects any XML containing `<!DOCTYPE` or `<!ENTITY`.
//   - Zero `fetch()`, zero `process.env`, zero floating-point casts; exact amounts via `@/lib/money`.
//   - Updates `public.payment_run_items` and `public.payment_runs` atomically with `audit()` after `rowCount` verification.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import {
  defaultHttpClient,
  readCredential,
  type HttpClient,
} from "@/lib/integrations/types";
import { decimal, moneyOrNull } from "@/lib/money";

export type Pain002TxStatus = "ACCP" | "ACSC" | "RJCT" | "PDNG";

export interface Pain002StatusReason {
  code: string | null;
  proprietary: string | null;
  additionalInfo: string | null;
}

export interface Pain002TransactionStatusItem {
  statusId: string | null;
  originalInstructionId: string | null;
  originalEndToEndId: string;
  txStatus: Pain002TxStatus;
  rawTxStatus: string;
  reasonCode: string | null;
  rejectionReason: string | null;
  reasons: Pain002StatusReason[];
  instructedAmount: number | null;
  currency: string | null;
  creditorName: string | null;
  creditorIban: string | null;
}

export interface ParsedPain002StatusReport {
  messageId: string;
  creationDateTime: string | null;
  originalMessageId: string | null;
  originalMessageNameId: string | null;
  groupStatus: Pain002TxStatus | null;
  originalPaymentInfoId: string | null;
  paymentInfoStatus: Pain002TxStatus | null;
  payloadSha256: string;
  transactions: Pain002TransactionStatusItem[];
}

const MAX_PAIN002_BYTES = 16 * 1024 * 1024;

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function firstXmlTagText(xml: string, localTag: string): string | null {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${localTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${localTag}>`,
    "i",
  );
  const m = re.exec(xml);
  if (!m) return null;
  return decodeXmlEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function allXmlBlocks(xml: string, localTag: string): string[] {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${localTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${localTag}>`,
    "gi",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function normalizePain002Status(raw: string | null): Pain002TxStatus | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  if (code === "ACSC" || code === "ACCC") return "ACSC";
  if (code === "ACCP" || code === "ACTC" || code === "ACSP" || code === "ACWC") return "ACCP";
  if (code === "RJCT" || code === "CANC") return "RJCT";
  if (code === "PDNG" || code === "RCVD" || code === "PART") return "PDNG";
  return null;
}

function parseStatusReasons(parentXml: string): Pain002StatusReason[] {
  const blocks = allXmlBlocks(parentXml, "StsRsnInf");
  const reasons: Pain002StatusReason[] = [];
  for (const b of blocks) {
    const rsnBlock = allXmlBlocks(b, "Rsn")[0] ?? "";
    const code = firstXmlTagText(rsnBlock, "Cd");
    const proprietary = firstXmlTagText(rsnBlock, "Prtry");
    const addtlInfos = allXmlBlocks(b, "AddtlInf")
      .map((item) => decodeXmlEntities(item.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")))
      .filter(Boolean);
    reasons.push({
      code: code || null,
      proprietary: proprietary || null,
      additionalInfo: addtlInfos.length > 0 ? addtlInfos.join(" | ") : null,
    });
  }
  return reasons;
}

function formatRejectionSummary(reasons: Pain002StatusReason[]): {
  reasonCode: string | null;
  rejectionReason: string | null;
} {
  if (reasons.length === 0) {
    return { reasonCode: null, rejectionReason: null };
  }
  const primaryCode = reasons.find((r) => r.code)?.code ?? reasons.find((r) => r.proprietary)?.proprietary ?? null;
  const parts: string[] = [];
  for (const r of reasons) {
    const tag = r.code ?? r.proprietary;
    if (tag && r.additionalInfo) {
      parts.push(`[${tag}] ${r.additionalInfo}`);
    } else if (r.additionalInfo) {
      parts.push(r.additionalInfo);
    } else if (tag) {
      parts.push(`[${tag}]`);
    }
  }
  return {
    reasonCode: primaryCode,
    rejectionReason: parts.length > 0 ? parts.join("; ") : null,
  };
}

/**
 * Parses an ISO 20022 `pain.002.001.03` (`CstmrPmtStsRpt`) XML buffer into deterministic status items.
 */
export function parsePain002StatusReport(buf: Buffer): ParsedPain002StatusReport {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new DomainError("VALIDATION", "Boş pain.002 durum raporu işlenemez.");
  }
  if (buf.length > MAX_PAIN002_BYTES) {
    throw new DomainError("VALIDATION", "pain.002 XML dosyası izin verilen maksimum boyutu (16 MB) aşıyor.");
  }

  const xml = buf.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new DomainError(
      "VALIDATION",
      "Güvenlik politikası gereği DTD/ENTITY (XXE) içeren pain.002 XML belgesi reddedildi.",
    );
  }
  if (!/<(?:[A-Za-z0-9_]+:)?CstmrPmtStsRpt\b/i.test(xml)) {
    throw new DomainError(
      "VALIDATION",
      "Geçerli bir ISO 20022 pain.002 (<CstmrPmtStsRpt>) ödeme durum raporu bulunamadı.",
    );
  }

  const payloadSha256 = createHash("sha256").update(buf).digest("hex");
  const grpHdrBlock = allXmlBlocks(xml, "GrpHdr")[0] ?? "";
  const messageId = firstXmlTagText(grpHdrBlock, "MsgId") ?? `PAIN002-${payloadSha256.slice(0, 12)}`;
  const creationDateTime = firstXmlTagText(grpHdrBlock, "CreDtTm");

  const orgnlGrpBlock = allXmlBlocks(xml, "OrgnlGrpInfAndSts")[0] ?? "";
  const originalMessageId = firstXmlTagText(orgnlGrpBlock, "OrgnlMsgId");
  const originalMessageNameId = firstXmlTagText(orgnlGrpBlock, "OrgnlMsgNmId");
  const groupStatus = normalizePain002Status(firstXmlTagText(orgnlGrpBlock, "GrpSts"));

  const pmtBlocks = allXmlBlocks(xml, "OrgnlPmtInfAndSts");
  const firstPmtBlock = pmtBlocks[0] ?? "";
  const originalPaymentInfoId = firstXmlTagText(firstPmtBlock, "OrgnlPmtInfId");
  const paymentInfoStatus = normalizePain002Status(firstXmlTagText(firstPmtBlock, "PmtInfSts"));

  // Collect `<TxInfAndSts>` across `<OrgnlPmtInfAndSts>` (or directly under `<CstmrPmtStsRpt>`)
  const txBlocks =
    pmtBlocks.length > 0
      ? pmtBlocks.flatMap((pb) => {
          const pmtDefaultSts = normalizePain002Status(firstXmlTagText(pb, "PmtInfSts"));
          const pmtReasons = parseStatusReasons(
            pb.replace(/<(?:[A-Za-z0-9_]+:)?TxInfAndSts[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?TxInfAndSts>/gi, ""),
          );
          return allXmlBlocks(pb, "TxInfAndSts").map((tb) => ({
            block: tb,
            inheritedStatus: pmtDefaultSts,
            inheritedReasons: pmtReasons,
          }));
        })
      : allXmlBlocks(xml, "TxInfAndSts").map((tb) => ({
          block: tb,
          inheritedStatus: groupStatus,
          inheritedReasons: parseStatusReasons(orgnlGrpBlock),
        }));

  const transactions: Pain002TransactionStatusItem[] = [];

  for (const { block, inheritedStatus, inheritedReasons } of txBlocks) {
    const statusId = firstXmlTagText(block, "StsId");
    const originalInstructionId = firstXmlTagText(block, "OrgnlInstrId");
    const originalEndToEndId =
      firstXmlTagText(block, "OrgnlEndToEndId") ?? originalInstructionId ?? "";
    if (!originalEndToEndId) {
      throw new DomainError(
        "VALIDATION",
        "pain.002 <TxInfAndSts> kaydında <OrgnlEndToEndId> veya <OrgnlInstrId> bulunamadı.",
      );
    }

    const rawTxStatus = firstXmlTagText(block, "TxSts") ?? inheritedStatus ?? groupStatus ?? "";
    const normalizedSts = normalizePain002Status(rawTxStatus);
    if (!normalizedSts) {
      throw new DomainError(
        "VALIDATION",
        `pain.002 desteklenmeyen veya eksik işlem durumu (<TxSts>): '${rawTxStatus || "(boş)"}'.`,
      );
    }

    const ownReasons = parseStatusReasons(block);
    const effectiveReasons = ownReasons.length > 0 ? ownReasons : inheritedReasons;
    const { reasonCode, rejectionReason } = formatRejectionSummary(effectiveReasons);

    const txRefBlock = allXmlBlocks(block, "OrgnlTxRef")[0] ?? "";
    const amtMatch = txRefBlock.match(
      /<(?:[A-Za-z0-9_]+:)?InstdAmt(?:\s+[^>]*Ccy=["']([A-Z]{3})["'][^>]*)?>\s*([0-9]+(?:[.,][0-9]+)?)\s*<\/(?:[A-Za-z0-9_]+:)?InstdAmt>/i,
    );
    const currency = amtMatch?.[1]?.toUpperCase() ?? null;
    const instructedAmount = amtMatch?.[2]
      ? moneyOrNull(amtMatch[2].replace(",", "."))
      : null;

    const cdtrBlock = allXmlBlocks(txRefBlock, "Cdtr")[0] ?? "";
    const cdtrAcctBlock = allXmlBlocks(txRefBlock, "CdtrAcct")[0] ?? "";
    const creditorName = firstXmlTagText(cdtrBlock, "Nm");
    const rawIban = firstXmlTagText(cdtrAcctBlock, "IBAN");
    const creditorIban = rawIban ? rawIban.replace(/\s+/g, "").toUpperCase() : null;

    transactions.push({
      statusId,
      originalInstructionId,
      originalEndToEndId,
      txStatus: normalizedSts,
      rawTxStatus: rawTxStatus.trim().toUpperCase(),
      reasonCode,
      rejectionReason,
      reasons: effectiveReasons,
      instructedAmount,
      currency,
      creditorName,
      creditorIban,
    });
  }

  return {
    messageId,
    creationDateTime,
    originalMessageId,
    originalMessageNameId,
    groupStatus,
    originalPaymentInfoId,
    paymentInfoStatus,
    payloadSha256,
    transactions,
  };
}

export interface ApplyPain002StatusResult {
  runId: string;
  runCode: string;
  previousRunStatus: string;
  newRunStatus: string;
  messageId: string;
  payloadSha256: string;
  settledItems: number;
  rejectedItems: number;
  pendingItems: number;
  unmatchedItems: number;
  rejections: Array<{
    itemId: string | null;
    originalEndToEndId: string;
    reasonCode: string | null;
    rejectionReason: string | null;
  }>;
}

interface RunItemRow {
  id: string;
  status: "included" | "settled" | "excluded";
  beneficiary_name: string;
  beneficiary_iban: string;
  amount: string;
  currency: string;
}

function matchRunItem(
  tx: Pain002TransactionStatusItem,
  runCode: string,
  orderedItems: RunItemRow[],
  matchedIds: Set<string>,
): RunItemRow | null {
  const e2e = tx.originalEndToEndId.trim();
  const instr = tx.originalInstructionId?.trim() ?? "";

  // 1. Exact UUID match on OrgnlEndToEndId or OrgnlInstrId
  for (const item of orderedItems) {
    if (e2e === item.id || instr === item.id) {
      return item;
    }
    if (instr && instr === `INSTR-${item.id.slice(0, 8)}`) {
      return item;
    }
  }

  // 2. Canonical `bank-export.ts` EndToEndId format: `${runCode}-001` (1-based index)
  const prefix = `${runCode}-`;
  if (e2e.toUpperCase().startsWith(prefix.toUpperCase())) {
    const seqStr = e2e.slice(prefix.length);
    if (/^\d+$/.test(seqStr)) {
      const idx = Number(seqStr) - 1;
      if (idx >= 0 && idx < orderedItems.length) {
        return orderedItems[idx];
      }
    }
  }

  // 3. Fallback match by Beneficiary IBAN + exact amount when OrgnlTxRef is present
  if (tx.creditorIban && tx.instructedAmount !== null) {
    for (const item of orderedItems) {
      if (matchedIds.has(item.id)) continue;
      const itemIban = item.beneficiary_iban.replace(/\s+/g, "").toUpperCase();
      if (
        itemIban === tx.creditorIban &&
        decimal(item.amount).eq(decimal(tx.instructedAmount))
      ) {
        return item;
      }
    }
  }

  return null;
}

/**
 * Applies a parsed ISO 20022 `pain.002.001.03` status report to `public.payment_run_items` and
 * `public.payment_runs` inside an atomic database transaction with full `audit()` lineage.
 */
export async function applyPain002StatusToPaymentRun(
  pool: Pool,
  runId: string,
  buf: Buffer,
  actorId: string | null,
): Promise<ApplyPain002StatusResult> {
  const report = parsePain002StatusReport(buf);
  const client = await pool.connect();

  try {
    await client.query("begin");

    const runRes = await client.query<{
      id: string;
      run_code: string;
      status: string;
      notes: string | null;
    }>(
      `select id::text, run_code, status, notes
         from public.payment_runs
        where id = $1::uuid
        for update`,
      [runId],
    );
    if ((runRes.rowCount ?? 0) === 0) {
      throw new DomainError("NOT_FOUND", "Ödeme listesi (payment_run) bulunamadı.");
    }
    const run = runRes.rows[0];
    if (run.status === "cancelled") {
      throw new DomainError(
        "CONFLICT",
        "İptal edilmiş ödeme listesine pain.002 banka durum raporu uygulanamaz.",
      );
    }

    const itemsRes = await client.query<RunItemRow>(
      `select id::text,
              status,
              beneficiary_name,
              beneficiary_iban,
              amount::text as amount,
              currency
         from public.payment_run_items
        where run_id = $1::uuid
        order by (due_date is null) asc, due_date asc, created_at asc, id asc
        for update`,
      [runId],
    );
    const items = itemsRes.rows;

    let settledItems = 0;
    let rejectedItems = 0;
    let pendingItems = 0;
    let unmatchedItems = 0;
    const matchedIds = new Set<string>();
    const rejections: ApplyPain002StatusResult["rejections"] = [];

    for (const tx of report.transactions) {
      const targetItem = matchRunItem(tx, run.run_code, items, matchedIds);
      if (!targetItem) {
        unmatchedItems += 1;
        if (tx.txStatus === "RJCT") {
          rejections.push({
            itemId: null,
            originalEndToEndId: tx.originalEndToEndId,
            reasonCode: tx.reasonCode,
            rejectionReason: tx.rejectionReason,
          });
        }
        continue;
      }
      matchedIds.add(targetItem.id);

      if (tx.txStatus === "ACSC") {
        if (targetItem.status === "included") {
          const upd = await client.query(
            `update public.payment_run_items
                set status = 'settled',
                    settled_at = coalesce(settled_at, now())
              where id = $1::uuid`,
            [targetItem.id],
          );
          if ((upd.rowCount ?? 0) === 1) {
            const prevStatus = targetItem.status;
            targetItem.status = "settled";
            settledItems += 1;
            await audit(client, {
              actor: actorId,
              action: "pain002_item_settled",
              entityTable: "payment_run_items",
              entityId: targetItem.id,
              before: { status: prevStatus },
              after: {
                status: "settled",
                txStatus: tx.txStatus,
                originalEndToEndId: tx.originalEndToEndId,
                messageId: report.messageId,
              },
            });
          }
        } else if (targetItem.status === "settled") {
          settledItems += 1;
        }
      } else if (tx.txStatus === "RJCT") {
        rejections.push({
          itemId: targetItem.id,
          originalEndToEndId: tx.originalEndToEndId,
          reasonCode: tx.reasonCode,
          rejectionReason: tx.rejectionReason,
        });
        if (targetItem.status === "included") {
          const upd = await client.query(
            `update public.payment_run_items
                set status = 'excluded'
              where id = $1::uuid`,
            [targetItem.id],
          );
          if ((upd.rowCount ?? 0) === 1) {
            const prevStatus = targetItem.status;
            targetItem.status = "excluded";
            rejectedItems += 1;
            await audit(client, {
              actor: actorId,
              action: "pain002_item_rejected",
              entityTable: "payment_run_items",
              entityId: targetItem.id,
              before: { status: prevStatus },
              after: {
                status: "excluded",
                txStatus: tx.txStatus,
                originalEndToEndId: tx.originalEndToEndId,
                reasonCode: tx.reasonCode,
                rejectionReason: tx.rejectionReason,
                messageId: report.messageId,
              },
            });
          }
        } else {
          rejectedItems += 1;
        }
      } else {
        // ACCP or PDNG: bank accepted syntax/profile or payment is pending clearing
        pendingItems += 1;
        await audit(client, {
          actor: actorId,
          action: "pain002_item_pending",
          entityTable: "payment_run_items",
          entityId: targetItem.id,
          before: { status: targetItem.status },
          after: {
            status: targetItem.status,
            txStatus: tx.txStatus,
            originalEndToEndId: tx.originalEndToEndId,
            reasonCode: tx.reasonCode,
            rejectionReason: tx.rejectionReason,
            messageId: report.messageId,
          },
        });
      }
    }

    // Recompute run-level status deterministically
    const activeIncludedCount = items.filter((i) => i.status === "included").length;
    const totalSettledCount = items.filter((i) => i.status === "settled").length;
    const totalExcludedCount = items.filter((i) => i.status === "excluded").length;

    let newRunStatus = run.status;
    const canTransitionRun = run.status === "approved" || run.status === "exported";

    const rejectionNoteSegment =
      rejections.length > 0
        ? `pain.002 (${report.messageId}) red kayıtları: ${rejections
            .map(
              (r) =>
                `${r.originalEndToEndId}${r.rejectionReason ? ` (${r.rejectionReason})` : r.reasonCode ? ` (${r.reasonCode})` : ""}`,
            )
            .join(", ")}`
        : null;

    const mergedNotes = rejectionNoteSegment
      ? run.notes
        ? `${run.notes}\n${rejectionNoteSegment}`
        : rejectionNoteSegment
      : run.notes;

    if (canTransitionRun && activeIncludedCount === 0 && totalSettledCount > 0) {
      newRunStatus = "settled";
      const updRun = await client.query(
        `update public.payment_runs
            set status = 'settled',
                settled_at = coalesce(settled_at, now()),
                notes = $2
          where id = $1::uuid`,
        [runId, mergedNotes],
      );
      if ((updRun.rowCount ?? 0) === 1) {
        await audit(client, {
          actor: actorId,
          action: "apply_pain002_status_report",
          entityTable: "payment_runs",
          entityId: runId,
          before: { status: run.status },
          after: {
            status: "settled",
            messageId: report.messageId,
            payloadSha256: report.payloadSha256,
            settledItems,
            rejectedItems,
            pendingItems,
            unmatchedItems,
          },
        });
      }
    } else if (
      canTransitionRun &&
      activeIncludedCount === 0 &&
      totalSettledCount === 0 &&
      totalExcludedCount > 0 &&
      (rejectedItems > 0 || report.groupStatus === "RJCT")
    ) {
      newRunStatus = "cancelled";
      const cancelReason =
        rejectionNoteSegment?.slice(0, 500) ??
        `pain.002 (${report.messageId}): Tüm kalemler banka tarafından reddedildi (RJCT).`;
      const updRun = await client.query(
        `update public.payment_runs
            set status = 'cancelled',
                cancelled_at = now(),
                cancel_reason = $2,
                notes = $3
          where id = $1::uuid`,
        [runId, cancelReason, mergedNotes],
      );
      if ((updRun.rowCount ?? 0) === 1) {
        await audit(client, {
          actor: actorId,
          action: "apply_pain002_status_report",
          entityTable: "payment_runs",
          entityId: runId,
          before: { status: run.status },
          after: {
            status: "cancelled",
            cancelReason,
            messageId: report.messageId,
            payloadSha256: report.payloadSha256,
            settledItems,
            rejectedItems,
            pendingItems,
            unmatchedItems,
          },
        });
      }
    } else {
      if (mergedNotes !== run.notes) {
        await client.query(
          `update public.payment_runs set notes = $2 where id = $1::uuid`,
          [runId, mergedNotes],
        );
      }
      await audit(client, {
        actor: actorId,
        action: "apply_pain002_status_report",
        entityTable: "payment_runs",
        entityId: runId,
        before: { status: run.status },
        after: {
          status: newRunStatus,
          messageId: report.messageId,
          payloadSha256: report.payloadSha256,
          settledItems,
          rejectedItems,
          pendingItems,
          unmatchedItems,
        },
      });
    }

    await client.query("commit");

    return {
      runId,
      runCode: run.run_code,
      previousRunStatus: run.status,
      newRunStatus,
      messageId: report.messageId,
      payloadSha256: report.payloadSha256,
      settledItems,
      rejectedItems,
      pendingItems,
      unmatchedItems,
      rejections,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Host-to-Host convenience helper: downloads a `pain.002` XML report via `HttpClient` and applies it.
 */
export async function fetchAndApplyPain002Status(
  pool: Pool,
  options: {
    runId: string;
    statusEndpointUrl: string;
    credential?: string | null;
    credentialEnvVar?: string | null;
    actorId: string | null;
  },
  httpClient: HttpClient = defaultHttpClient,
): Promise<ApplyPain002StatusResult> {
  const token =
    options.credential ??
    (options.credentialEnvVar ? readCredential(options.credentialEnvVar) : null);
  if (!token) {
    throw new DomainError("VALIDATION", "Host-to-Host pain.002 kimlik bilgisi tanımlı değil.");
  }
  const res = await httpClient.send({
    url: options.statusEndpointUrl,
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/xml, text/xml",
    },
  });
  if (!res.ok) {
    throw new DomainError(
      res.status === 401 || res.status === 403 ? "FORBIDDEN" : "CONFLICT",
      res.error ?? `Host-to-Host pain.002 HTTP ${res.status}`,
    );
  }
  return applyPain002StatusToPaymentRun(
    pool,
    options.runId,
    Buffer.from(res.body, "utf8"),
    options.actorId,
  );
}
