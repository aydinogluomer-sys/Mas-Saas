// Faz 35 — document centre engine: create, version, link, verify.
//
// Takes the role-scoped Pool from getPool() like every other engine in this project; it never
// obtains a connection of its own, so RLS applies to documents exactly as it does elsewhere.

import { z } from "zod";
import type { Pool } from "pg";
import { audit } from "@/lib/audit";
import { storeFile, verifyStored, type IntegrityReport } from "./storage";

export const DOC_TYPES = [
  "contract", "invoice_scan", "bank_statement", "receipt", "tax_document",
  "insurance", "correspondence", "report", "other",
] as const;

export const LINK_ENTITIES = [
  "invoices", "payment_instances", "payments", "checks", "loans",
  "bank_transactions", "parties", "contracts_placeholder",
] as const;

export const LINK_KINDS = ["supporting", "contract", "proof_of_payment", "correspondence", "other"] as const;

/** Zod at the boundary — documents arrive from forms and route handlers. */
export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  docType: z.enum(DOC_TYPES).default("other"),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  description: z.string().trim().max(2000).optional(),
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
  fileSha256: string | null;
  byteSize: number | null;
  mimeType: string | null;
  uploadedAt: string | null;
}

const mapDoc = (x: Record<string, unknown>): DocumentRow => ({
  id: x.document_id as string,
  title: x.title as string,
  docType: x.doc_type as string,
  tags: (x.tags as string[] | null) ?? [],
  status: x.status as string,
  versionCount: Number(x.version_count ?? 0),
  // Null, not 0: a document with no attachment yet has NO current version, which is different
  // from "version zero".
  currentVersion: x.version_no == null ? null : Number(x.version_no),
  fileSha256: (x.file_sha256 as string | null) ?? null,
  byteSize: x.byte_size == null ? null : Number(x.byte_size),
  mimeType: (x.mime_type as string | null) ?? null,
  uploadedAt: (x.uploaded_at as string | null) ?? null,
});

export async function createDocument(
  pool: Pool, raw: unknown, actorId: string | null,
): Promise<string> {
  const input = createDocumentSchema.parse(raw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.documents (title, doc_type, tags, description, created_by)
       values ($1, $2, $3::text[], $4, $5) returning id`,
      [input.title, input.docType, input.tags, input.description ?? null, actorId]);
    const id = res.rows[0].id as string;
    await audit(client, {
      actor: actorId, action: "create_document",
      entityTable: "documents", entityId: id,
      after: { title: input.title, docType: input.docType, tags: input.tags },
    });
    await client.query("commit");
    return id;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

export interface AddVersionResult {
  attachmentId: string | null;
  versionNo: number | null;
  /** True when identical bytes were already stored as a version of this document. */
  duplicate: boolean;
  sha256: string;
}

/**
 * Add a new version of a document.
 *
 * Re-uploading IDENTICAL bytes is not an error and does not create a version: the unique
 * (document_id, file_sha256) constraint in 0083 exists because "version 4" that is byte-identical
 * to version 3 records a change that did not happen. The caller is told it was a duplicate rather
 * than being given a fake new version number.
 */
export async function addVersion(
  pool: Pool, documentId: string, bytes: Buffer, originalFilename: string,
  mimeType: string, actorId: string | null,
): Promise<AddVersionResult> {
  const stored = storeFile(bytes);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query(
      `select version_no from public.attachments where document_id = $1 and file_sha256 = $2`,
      [documentId, stored.sha256]);
    if (existing.rowCount) {
      await client.query("commit");
      return {
        attachmentId: null, versionNo: Number(existing.rows[0].version_no),
        duplicate: true, sha256: stored.sha256,
      };
    }
    // Serialised by the row lock on the parent document, so two concurrent uploads cannot both
    // claim the same version number.
    await client.query(`select id from public.documents where id = $1 for update`, [documentId]);
    const next = await client.query(
      `select coalesce(max(version_no), 0) + 1 as v from public.attachments where document_id = $1`,
      [documentId]);
    const versionNo = Number(next.rows[0].v);
    const res = await client.query(
      `insert into public.attachments
         (document_id, version_no, original_filename, storage_path, file_sha256,
          byte_size, mime_type, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
      [documentId, versionNo, originalFilename, stored.storagePath, stored.sha256,
       stored.byteSize, mimeType, actorId]);
    const id = res.rows[0].id as string;
    await audit(client, {
      actor: actorId, action: "add_document_version",
      entityTable: "attachments", entityId: id,
      after: {
        documentId, versionNo, sha256: stored.sha256, byteSize: stored.byteSize,
        // Recorded explicitly: the bytes are on local disk, not in this database.
        storageBackend: "local_disk",
      },
    });
    await client.query("commit");
    return { attachmentId: id, versionNo, duplicate: false, sha256: stored.sha256 };
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

export async function linkDocument(
  pool: Pool, raw: unknown, actorId: string | null,
): Promise<boolean> {
  const input = linkDocumentSchema.parse(raw);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      `insert into public.document_links
         (document_id, entity_table, entity_id, entity_label, link_kind, created_by)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (document_id, entity_table, entity_id, link_kind) do nothing
       returning id`,
      [input.documentId, input.entityTable, input.entityId,
       input.entityLabel ?? null, input.linkKind, actorId]);
    if (res.rowCount) {
      await audit(client, {
        actor: actorId, action: "link_document",
        entityTable: "document_links", entityId: res.rows[0].id,
        after: { documentId: input.documentId, entityTable: input.entityTable, entityId: input.entityId },
      });
    }
    await client.query("commit");
    return (res.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("rollback"); throw e;
  } finally { client.release(); }
}

export async function listDocuments(pool: Pool, limit = 100): Promise<DocumentRow[]> {
  const res = await pool.query(
    `select document_id, title, doc_type, tags, status, version_no,
            file_sha256, byte_size, mime_type,
            to_char(uploaded_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as uploaded_at,
            version_count
       from public.document_current_version
      order by uploaded_at desc nulls last, title
      limit $1`, [limit]);
  return res.rows.map(mapDoc);
}

/** Documents attached to one business record. */
export async function documentsForEntity(
  pool: Pool, entityTable: string, entityId: string,
): Promise<DocumentRow[]> {
  const res = await pool.query(
    `select v.document_id, v.title, v.doc_type, v.tags, v.status, v.version_no,
            v.file_sha256, v.byte_size, v.mime_type,
            to_char(v.uploaded_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as uploaded_at,
            v.version_count
       from public.document_links l
       join public.document_current_version v on v.document_id = l.document_id
      where l.entity_table = $1 and l.entity_id = $2
      order by v.title`, [entityTable, entityId]);
  return res.rows.map(mapDoc);
}

export interface IntegritySweep {
  checked: number;
  missing: IntegrityReport[];
  corrupt: IntegrityReport[];
}

/**
 * Re-hash every stored attachment against its recorded checksum.
 *
 * This is the answer to the cost of local-disk storage: the database cannot restore the bytes, so
 * it must at least be able to tell you exactly which ones are gone or wrong. A silent mismatch is
 * the failure mode that matters — a document that changed without anybody deciding to change it.
 */
export async function sweepIntegrity(pool: Pool, limit = 500): Promise<IntegritySweep> {
  const res = await pool.query(
    `select storage_path, file_sha256, byte_size from public.attachments
      order by uploaded_at desc limit $1`, [limit]);
  const missing: IntegrityReport[] = [];
  const corrupt: IntegrityReport[] = [];
  for (const row of res.rows) {
    const report = verifyStored(
      row.storage_path as string, row.file_sha256 as string, Number(row.byte_size));
    if (!report.present) missing.push(report);
    else if (report.sizeMatches === false || report.hashMatches === false) corrupt.push(report);
  }
  return { checked: res.rowCount ?? 0, missing, corrupt };
}
