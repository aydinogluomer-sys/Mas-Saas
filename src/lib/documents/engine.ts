// Faz 35 + Faz 50 (D4) — document centre engine: create, validated upload, version, link, download & verify.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { parseOrThrow } from "@/lib/validation";
import {
  readStored,
  storeFile,
  validateDocumentUpload,
  verifyStored,
  type IntegrityReport,
  type SafeDocumentExt,
} from "./storage";

export const DOC_TYPES = [
  "contract",
  "invoice_scan",
  "bank_statement",
  "receipt",
  "tax_document",
  "insurance",
  "correspondence",
  "report",
  "other",
] as const;

export const LINK_ENTITIES = [
  "invoices",
  "payment_instances",
  "payments",
  "checks",
  "check_bordros",
  "loans",
  "credit_facilities",
  "reconciliation_signoffs",
  "bank_transactions",
  "parties",
  "contracts_placeholder",
] as const;

export const LINK_KINDS = [
  "supporting",
  "contract",
  "proof_of_payment",
  "correspondence",
  "other",
] as const;

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  docType: z.enum(DOC_TYPES).default("other"),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  description: z.string().trim().max(2000).optional(),
  originalFilename: z.string().trim().min(1).max(240).optional(),
});
export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;

export const linkDocumentSchema = z.object({
  documentId: z.string().uuid(),
  entityTable: z.enum(LINK_ENTITIES),
  entityId: z.string().uuid(),
  entityLabel: z.string().trim().max(300).optional(),
  linkKind: z.enum(LINK_KINDS).default("supporting"),
});

export interface DocumentRow {
  id: string;
  title: string;
  docType: string;
  tags: string[];
  status: string;
  versionCount: number;
  currentVersion: number | null;
  originalFilename: string | null;
  fileSha256: string | null;
  byteSize: number | null;
  mimeType: string | null;
  uploadedAt: string | null;
  storageBackend: string;
  extractedMetadata: Record<string, unknown> | null;
}

const mapDoc = (x: Record<string, unknown>): DocumentRow => ({
  id: x.document_id as string,
  title: x.title as string,
  docType: x.doc_type as string,
  tags: (x.tags as string[] | null) ?? [],
  status: x.status as string,
  versionCount: Number(x.version_count ?? 0),
  currentVersion: x.version_no == null ? null : Number(x.version_no),
  originalFilename: (x.original_filename as string | null) ?? null,
  fileSha256: (x.file_sha256 as string | null) ?? null,
  byteSize: x.byte_size == null ? null : Number(x.byte_size),
  mimeType: (x.mime_type as string | null) ?? null,
  uploadedAt: (x.uploaded_at as string | null) ?? null,
  storageBackend: (x.storage_backend as string | null) ?? "local_cas",
  extractedMetadata:
    x.extracted_metadata && typeof x.extracted_metadata === "object"
      ? (x.extracted_metadata as Record<string, unknown>)
      : null,
});

function buildExtractedMetadata(
  bytes: Buffer,
  cleanName: string,
  mimeType: string,
  sha256Hex: string,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    filename: cleanName,
    mimeType,
    sizeBytes: bytes.byteLength,
    sha256Prefix: sha256Hex.slice(0, 16),
  };
  if (mimeType.includes("xml") || cleanName.toLowerCase().endsWith(".xml")) {
    const snippet = bytes.subarray(0, 16384).toString("utf8");
    const invId = snippet.match(/<(?:[A-Za-z0-9_]+:)?ID>([^<]{3,40})<\/(?:[A-Za-z0-9_]+:)?ID>/)?.[1]?.trim();
    const issueDate = snippet.match(/<(?:[A-Za-z0-9_]+:)?IssueDate>(\d{4}-\d{2}-\d{2})<\/(?:[A-Za-z0-9_]+:)?IssueDate>/)?.[1];
    const payable = snippet.match(/<(?:[A-Za-z0-9_]+:)?PayableAmount[^>]*>([^<]+)<\/(?:[A-Za-z0-9_]+:)?PayableAmount>/)?.[1]?.trim();
    if (invId) base.invoiceNo = invId;
    if (issueDate) base.issueDate = issueDate;
    if (payable) base.payableAmount = payable;
  }
  return base;
}

export async function createDocument(
  pool: Pool,
  raw: unknown,
  actorId: string | null,
): Promise<string> {
  const input = parseOrThrow(createDocumentSchema, raw, "Doküman");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.documents (title, doc_type, tags, description, original_filename, created_by)
       values ($1, $2, $3::text[], $4, $5, $6)
       returning id`,
      [
        input.title,
        input.docType,
        input.tags,
        input.description ?? null,
        input.originalFilename ?? null,
        actorId,
      ],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "create_document",
      entityTable: "documents",
      entityId: id,
      after: { title: input.title, docType: input.docType, tags: input.tags },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface AddVersionResult {
  attachmentId: string | null;
  versionNo: number | null;
  duplicate: boolean;
  sha256: string;
  storagePath: string;
}

export async function addVersion(
  pool: Pool,
  documentId: string,
  bytes: Buffer,
  originalFilename: string,
  mimeType: string,
  actorId: string | null,
  safeExt?: SafeDocumentExt,
): Promise<AddVersionResult> {
  const stored = storeFile(bytes, safeExt);
  const cleanName = originalFilename.replace(/[\r\n\0]/g, "").trim() || "document";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{ version_no: number; storage_path: string }>(
      `select version_no, storage_path from public.attachments where document_id = $1 and file_sha256 = $2`,
      [documentId, stored.sha256],
    );
    if (existing.rowCount) {
      await client.query("commit");
      return {
        attachmentId: null,
        versionNo: Number(existing.rows[0].version_no),
        duplicate: true,
        sha256: stored.sha256,
        storagePath: existing.rows[0].storage_path,
      };
    }

    const docLock = await client.query(`select id from public.documents where id = $1 for update`, [
      documentId,
    ]);
    if (docLock.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Doküman kaydı bulunamadı.");
    }
    const storageBackend = process.env.MAS_S3_WORM_BUCKET ? "s3_worm" : "local_cas";
    const extractedMeta = buildExtractedMetadata(bytes, cleanName, mimeType, stored.sha256);
    await client.query("savepoint doc_meta_0119_sp");
    try {
      await client.query(
        `update public.documents
            set original_filename = $2,
                storage_backend = $3,
                extracted_metadata = coalesce(extracted_metadata, '{}'::jsonb) || $4::jsonb
          where id = $1`,
        [documentId, cleanName, storageBackend, JSON.stringify(extractedMeta)],
      );
      await client.query("release savepoint doc_meta_0119_sp");
    } catch {
      await client.query("rollback to savepoint doc_meta_0119_sp");
      await client.query("release savepoint doc_meta_0119_sp");
      await client.query(`update public.documents set original_filename = $2 where id = $1`, [
        documentId,
        cleanName,
      ]);
    }

    const next = await client.query<{ v: number }>(
      `select coalesce(max(version_no), 0) + 1 as v from public.attachments where document_id = $1`,
      [documentId],
    );
    const versionNo = Number(next.rows[0].v);
    const res = await client.query<{ id: string }>(
      `insert into public.attachments
         (document_id, version_no, original_filename, storage_path, file_sha256,
          byte_size, mime_type, uploaded_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        documentId,
        versionNo,
        cleanName,
        stored.storagePath,
        stored.sha256,
        stored.byteSize,
        mimeType,
        actorId,
      ],
    );
    const id = res.rows[0].id;
    await audit(client, {
      actor: actorId,
      action: "add_document_version",
      entityTable: "attachments",
      entityId: id,
      after: {
        documentId,
        versionNo,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        storageBackend: "local_disk",
      },
    });
    await client.query("commit");
    return {
      attachmentId: id,
      versionNo,
      duplicate: false,
      sha256: stored.sha256,
      storagePath: stored.storagePath,
    };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Faz 50 (D4): Single-step validated upload (creates a new document or adds a version to an
 * existing document, stores content-addressed `<aa>/<bb>/<sha256>.<safeExt>` on local disk,
 * and optionally links it to an invoice/payment/check/bordro/facility/signoff).
 */
export async function uploadValidatedDocument(
  pool: Pool,
  params: {
    existingDocumentId?: string | null;
    title?: string;
    docType?: (typeof DOC_TYPES)[number];
    tags?: string[];
    description?: string;
    bytes: Buffer;
    mimeType: string;
    originalFilename: string;
    entityTable?: (typeof LINK_ENTITIES)[number] | null;
    entityId?: string | null;
    entityLabel?: string;
    linkKind?: (typeof LINK_KINDS)[number];
  },
  actorId: string,
): Promise<{ documentId: string; version: AddVersionResult; linked: boolean }> {
  const validated = validateDocumentUpload(params.bytes, params.mimeType, params.originalFilename);
  const documentId =
    params.existingDocumentId && params.existingDocumentId.trim()
      ? params.existingDocumentId.trim()
      : await createDocument(
          pool,
          {
            title: params.title?.trim() || validated.sanitizedOriginalFilename,
            docType: params.docType ?? "other",
            tags: params.tags ?? [],
            description: params.description,
            originalFilename: validated.sanitizedOriginalFilename,
          },
          actorId,
        );

  const version = await addVersion(
    pool,
    documentId,
    params.bytes,
    validated.sanitizedOriginalFilename,
    validated.mimeType,
    actorId,
    validated.safeExt,
  );

  let linked = false;
  if (params.entityTable && params.entityId) {
    linked = await linkDocument(
      pool,
      {
        documentId,
        entityTable: params.entityTable,
        entityId: params.entityId,
        entityLabel: params.entityLabel,
        linkKind: params.linkKind ?? "supporting",
      },
      actorId,
    );
  }

  return { documentId, version, linked };
}

export async function loadVerifiedDocumentDownload(
  pool: Pool,
  documentId: string,
  versionNo?: number,
): Promise<{
  documentId: string;
  versionNo: number;
  originalFilename: string;
  mimeType: string;
  sha256: string;
  bytes: Buffer;
}> {
  const res = versionNo
    ? await pool.query<{
        version_no: number;
        original_filename: string;
        storage_path: string;
        file_sha256: string;
        mime_type: string;
      }>(
        `select version_no, original_filename, storage_path, file_sha256, mime_type
           from public.attachments
          where document_id = $1 and version_no = $2`,
        [documentId, versionNo],
      )
    : await pool.query<{
        version_no: number;
        original_filename: string;
        storage_path: string;
        file_sha256: string;
        mime_type: string;
      }>(
        `select version_no, original_filename, storage_path, file_sha256, mime_type
           from public.attachments
          where document_id = $1
          order by version_no desc
          limit 1`,
        [documentId],
      );

  if (res.rowCount === 0) {
    throw new DomainError("NOT_FOUND", "Doküman veya yüklü dosya sürümü bulunamadı.");
  }
  const row = res.rows[0];
  const bytes = readStored(row.storage_path, row.file_sha256);
  return {
    documentId,
    versionNo: Number(row.version_no),
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sha256: row.file_sha256,
    bytes,
  };
}

export async function linkDocument(
  pool: Pool,
  raw: unknown,
  actorId: string | null,
): Promise<boolean> {
  const input = parseOrThrow(linkDocumentSchema, raw, "Doküman bağlantısı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query<{ id: string }>(
      `insert into public.document_links
         (document_id, entity_table, entity_id, entity_label, link_kind, created_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (document_id, entity_table, entity_id, link_kind) do nothing
       returning id`,
      [
        input.documentId,
        input.entityTable,
        input.entityId,
        input.entityLabel ?? null,
        input.linkKind,
        actorId,
      ],
    );
    if (res.rowCount) {
      await audit(client, {
        actor: actorId,
        action: "link_document",
        entityTable: "document_links",
        entityId: res.rows[0].id,
        after: {
          documentId: input.documentId,
          entityTable: input.entityTable,
          entityId: input.entityId,
          linkKind: input.linkKind,
        },
      });
    }
    await client.query("commit");
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function listDocuments(pool: Pool, limit = 100): Promise<DocumentRow[]> {
  try {
    const res = await pool.query(
      `select v.document_id, v.title, v.doc_type, v.tags, v.status, v.version_no, v.original_filename,
              v.file_sha256, v.byte_size, v.mime_type,
              to_char(v.uploaded_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as uploaded_at,
              v.version_count,
              d.storage_backend,
              d.extracted_metadata
         from public.document_current_version v
         join public.documents d on d.id = v.document_id
        where d.archived_at is null
        order by v.uploaded_at desc nulls last, v.title
        limit $1`,
      [limit],
    );
    return res.rows.map(mapDoc);
  } catch {
    const res = await pool.query(
      `select document_id, title, doc_type, tags, status, version_no, original_filename,
              file_sha256, byte_size, mime_type,
              to_char(uploaded_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as uploaded_at,
              version_count
         from public.document_current_version
        order by uploaded_at desc nulls last, title
        limit $1`,
      [limit],
    );
    return res.rows.map(mapDoc);
  }
}

export async function listRecentDocumentLinks(pool: Pool, limit = 50) {
  const res = await pool.query(
    `select l.id, l.document_id, d.title, l.entity_table, l.entity_id, l.entity_label, l.link_kind,
            to_char(l.created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at
       from public.document_links l
       join public.documents d on d.id = l.document_id
      order by l.created_at desc
      limit $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    documentId: r.document_id as string,
    documentTitle: r.title as string,
    entityTable: r.entity_table as string,
    entityId: r.entity_id as string,
    entityLabel: (r.entity_label as string | null) ?? null,
    linkKind: r.link_kind as string,
    createdAt: r.created_at as string,
  }));
}

export async function documentsForEntity(
  pool: Pool,
  entityTable: string,
  entityId: string,
): Promise<DocumentRow[]> {
  const res = await pool.query(
    `select v.document_id, v.title, v.doc_type, v.tags, v.status, v.version_no, v.original_filename,
            v.file_sha256, v.byte_size, v.mime_type,
            to_char(v.uploaded_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as uploaded_at,
            v.version_count
       from public.document_links l
       join public.document_current_version v on v.document_id = l.document_id
      where l.entity_table = $1 and l.entity_id = $2
      order by v.title`,
    [entityTable, entityId],
  );
  return res.rows.map(mapDoc);
}

export interface IntegritySweep {
  checked: number;
  missing: IntegrityReport[];
  corrupt: IntegrityReport[];
}

export async function sweepIntegrity(pool: Pool, limit = 500): Promise<IntegritySweep> {
  const res = await pool.query(
    `select storage_path, file_sha256, byte_size from public.attachments
      order by uploaded_at desc limit $1`,
    [limit],
  );
  const missing: IntegrityReport[] = [];
  const corrupt: IntegrityReport[] = [];
  for (const row of res.rows) {
    const report = verifyStored(
      row.storage_path as string,
      row.file_sha256 as string,
      Number(row.byte_size),
    );
    if (!report.present) missing.push(report);
    else if (report.sizeMatches === false || report.hashMatches === false) corrupt.push(report);
  }
  return { checked: res.rowCount ?? 0, missing, corrupt };
}
