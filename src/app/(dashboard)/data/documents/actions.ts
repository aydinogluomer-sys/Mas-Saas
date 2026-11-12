"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  DOC_TYPES,
  LINK_ENTITIES,
  LINK_KINDS,
  linkDocument,
  uploadValidatedDocument,
} from "@/lib/documents/engine";

const BASE = "/data/documents";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
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
    await uploadValidatedDocument(
      getPool(),
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
  } catch (e) {
    domainRedirect(e);
  }

  revalidatePath(BASE);
  redirect(`${BASE}?result=dokuman-yuklendi`);
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

