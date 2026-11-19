"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import {
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  DOC_TYPES,
  LINK_ENTITIES,
  LINK_KINDS,
  linkDocument,
  uploadValidatedDocument,
} from "@/lib/documents/engine";
import { persistDocumentExtraction } from "@/lib/documents/smart-extractor";
import { moneyOrNull } from "@/lib/money";
import { createPayment } from "@/lib/radar/engine";
import { istanbulDateISO } from "@/lib/time/istanbul";
import { parseOrThrow } from "@/lib/validation";

const BASE = "/data/documents";

function domainRedirect(e: unknown): never {
  if (isPgPeriodLockedError(e)) {
    redirect(`${BASE}?error=${encodeURIComponent(PERIOD_LOCKED_USER_MESSAGE)}`);
  }
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  if (e instanceof Error && e.name === "ZodError") {
    redirect(`${BASE}?error=${encodeURIComponent(e.message.slice(0, 240))}`);
  }
  throw e;
}

export async function uploadDocumentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("documents", "insert", BASE);
  await requireActionPermission("attachments", "insert", BASE);

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof File) || fileEntry.size === 0) {
    redirect(`${BASE}?error=${encodeURIComponent("Lütfen yüklenecek bir dosya seçin.")}`);
  }
  const bytes = Buffer.from(await fileEntry.arrayBuffer());
  const existingDocumentId = String(formData.get("existingDocumentId") ?? "").trim() || null;
  const title = String(formData.get("title") ?? "").trim();
  const docTypeRaw = String(formData.get("docType") ?? "other").trim();
  const docType = (DOC_TYPES as readonly string[]).includes(docTypeRaw)
    ? (docTypeRaw as (typeof DOC_TYPES)[number])
    : "other";
  const tagsRaw = String(formData.get("tags") ?? "");
  const tags = tagsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const description = String(formData.get("description") ?? "").trim() || undefined;

  const entityRef = String(formData.get("entityRef") ?? "").trim();
  let entityTable: (typeof LINK_ENTITIES)[number] | null = null;
  let entityId: string | null = null;
  let entityLabel: string | undefined;
  if (entityRef.includes(":")) {
    const [tbl, id, ...labelParts] = entityRef.split(":");
    if ((LINK_ENTITIES as readonly string[]).includes(tbl) && id) {
      entityTable = tbl as (typeof LINK_ENTITIES)[number];
      entityId = id;
      entityLabel = labelParts.join(":") || undefined;
    }
  }
  const linkKindRaw = String(formData.get("linkKind") ?? "supporting").trim();
  const linkKind = (LINK_KINDS as readonly string[]).includes(linkKindRaw)
    ? (linkKindRaw as (typeof LINK_KINDS)[number])
    : "supporting";

  try {
    const pool = getPool();
    const uploaded = await uploadValidatedDocument(
      pool,
      {
        existingDocumentId,
        title: title || undefined,
        docType,
        tags,
        description,
        bytes,
        mimeType: fileEntry.type,
        originalFilename: fileEntry.name,
        entityTable,
        entityId,
        entityLabel,
        linkKind,
      },
      session.id,
    );

    if (can(session.role, "documents", "update")) {
      await persistDocumentExtraction(pool, uploaded.documentId, session.id).catch(
        () => undefined,
      );
    }
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(`${BASE}?result=dokuman-yuklendi-ve-alanlar-cikarildi`);
}

export async function attachToEntityAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("document_links", "insert", BASE);
  const documentId = String(formData.get("documentId") ?? "").trim();
  const entityRef = String(formData.get("entityRef") ?? "").trim();
  const manualEntityTable = String(formData.get("entityTable") ?? "").trim();
  const manualEntityId = String(formData.get("entityId") ?? "").trim();
  const manualEntityLabel = String(formData.get("entityLabel") ?? "").trim();
  const linkKindRaw = String(formData.get("linkKind") ?? "supporting").trim();

  let entityTable = manualEntityTable;
  let entityId = manualEntityId;
  let entityLabel = manualEntityLabel || undefined;
  if (entityRef.includes(":")) {
    const [tbl, id, ...rest] = entityRef.split(":");
    entityTable = tbl;
    entityId = id;
    entityLabel = entityLabel ?? (rest.join(":") || undefined);
  }

  try {
    await linkDocument(
      getPool(),
      {
        documentId,
        entityTable,
        entityId,
        entityLabel,
        linkKind: linkKindRaw || "supporting",
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(`${BASE}?result=kayda-baglandi`);
}

const docIdSchema = z.object({
  documentId: z.string().uuid("Geçerli bir doküman kimliği gerekli."),
});

export async function extractDocumentMetadataAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("documents", "update", BASE);
  let resultLabel = "alan-cikarimi-tamamlandi";
  try {
    const parsed = parseOrThrow(docIdSchema, {
      documentId: String(formData.get("documentId") ?? "").trim(),
    });
    const extracted = await persistDocumentExtraction(
      getPool(),
      parsed.documentId,
      session.id,
    );
    resultLabel = `alan-cikarimi (${extracted.documentClass} · guven:${extracted.confidence})`;
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(`${BASE}?result=${encodeURIComponent(resultLabel)}`);
}

export async function createDraftPaymentFromDocumentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("payments", "insert", BASE);
  let createdPaymentId = "";

  try {
    const parsed = parseOrThrow(docIdSchema, {
      documentId: String(formData.get("documentId") ?? "").trim(),
    });

    const pool = getPool();
    const docRes = await pool.query<{
      id: string;
      title: string;
      original_filename: string | null;
      extracted_metadata: Record<string, unknown> | null;
    }>(
      `select id::text, title, original_filename, extracted_metadata
         from public.documents
        where id = $1`,
      [parsed.documentId],
    );

    const doc = docRes.rows[0];
    if (!doc) {
      throw new DomainError("NOT_FOUND", "Doküman kaydı bulunamadı.");
    }

    const meta = doc.extracted_metadata ?? {};
    const smart =
      meta.smartExtraction && typeof meta.smartExtraction === "object"
        ? (meta.smartExtraction as Record<string, unknown>)
        : {};

    const rawDate =
      (typeof meta.detectedDateIso === "string" ? meta.detectedDateIso : null) ??
      (typeof smart.detectedDateIso === "string" ? smart.detectedDateIso : null) ??
      (typeof meta.issueDate === "string" ? meta.issueDate : null);
    const validDateIso =
      rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate.trim()) ? rawDate.trim() : null;

    // BLANK != ZERO: never invent 0 when amount was not extracted
    const rawAmountCandidate =
      meta.detectedAmount ?? smart.detectedAmount ?? meta.payableAmount ?? null;
    const detectedAmount =
      rawAmountCandidate !== null && rawAmountCandidate !== undefined && rawAmountCandidate !== ""
        ? moneyOrNull(String(rawAmountCandidate).replace(",", "."))
        : null;

    if (!validDateIso && (detectedAmount === null || detectedAmount <= 0)) {
      throw new DomainError(
        "VALIDATION",
        "Taslak ödeme oluşturmak için belgeden en az geçerli bir tarih veya pozitif tutar çıkarılmış olmalıdır.",
      );
    }

    const rawCurrency = String(
      meta.currency ?? smart.currency ?? "TRY",
    )
      .trim()
      .toUpperCase();
    const currency = ["TRY", "USD", "EUR", "GBP"].includes(rawCurrency)
      ? rawCurrency
      : "TRY";

    const supplierName =
      (typeof meta.supplierName === "string" && meta.supplierName.trim()) ||
      (typeof smart.supplierName === "string" && smart.supplierName.trim()) ||
      null;
    const docNo =
      (typeof meta.documentNumber === "string" && meta.documentNumber.trim()) ||
      (typeof smart.documentNumber === "string" && smart.documentNumber.trim()) ||
      (typeof meta.invoiceNo === "string" && meta.invoiceNo.trim()) ||
      null;
    const iban =
      (typeof meta.iban === "string" && meta.iban.trim()) ||
      (typeof smart.iban === "string" && smart.iban.trim()) ||
      null;
    const vkn =
      (typeof meta.vknOrTckn === "string" && meta.vknOrTckn.trim()) ||
      (typeof smart.vknOrTckn === "string" && smart.vknOrTckn.trim()) ||
      null;

    const paymentNameParts = [
      supplierName ?? doc.title,
      docNo ? `(${docNo})` : null,
    ].filter(Boolean);
    const paymentName = paymentNameParts.join(" ").slice(0, 140) || doc.title;

    const todayISO = istanbulDateISO();
    const dueDate = validDateIso ?? todayISO;

    try {
      const created = await createPayment(
        pool,
        {
          name: paymentName,
          recurrence_type: "one_off",
          due_day: null,
          due_date: dueDate,
          default_amount: detectedAmount !== null && detectedAmount > 0 ? detectedAmount : null,
          currency,
          amount_confidence:
            detectedAmount !== null && detectedAmount > 0 ? "known" : "unknown",
          direction: "outflow",
          priority: "normal",
          flexibility_class: null,
          status: "paused",
          category_id: null,
          provider_party_id: null,
          owner_party_id: null,
          cash_account_id: null,
          cost_center_id: null,
          project_id: null,
          department_id: null,
          description: `Doküman Merkezinden çıkarılan taslak ödeme (${doc.original_filename ?? doc.title})`,
          iban,
          tdhp_expense_code: null,
          auto_match_vkn: vkn,
        },
        todayISO,
        session.id,
      );
      createdPaymentId = created.paymentId;
    } catch (payErr) {
      translatePeriodLockError(payErr);
    }

    if (createdPaymentId && can(session.role, "document_links", "insert")) {
      await linkDocument(
        pool,
        {
          documentId: parsed.documentId,
          entityTable: "payments",
          entityId: createdPaymentId,
          entityLabel: `Taslak Ödeme · ${paymentName}`,
          linkKind: "supporting",
        },
        session.id,
      ).catch(() => undefined);
    }
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  revalidatePath("/payments");
  revalidatePath("/payments/items");
  revalidatePath("/payments/missing");
  redirect(`/payments/${createdPaymentId}/edit`);
}

