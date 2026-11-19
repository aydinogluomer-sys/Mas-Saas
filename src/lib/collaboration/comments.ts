// Faz 61 (0121) — Kayıt Üstü İşbirliği Yorumları ve Canlı @mention Bildirim Çanı Motoru.
//
// Kurallar:
//   * Her yeni yorum `public.entity_comments` tablosuna yazılır ve `audit()` izine bağlanır.
//   * `public.users` tablosundaki hassas alanlara dokunmadan `user_display_label` ve
//     `user_username_label` yardımcılarıyla tüm 5 RLS katmanında yazar bilgisi çözülür.

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { parseOrThrow } from "@/lib/validation";

export interface EntityCommentRow {
  id: string;
  entityTable: string;
  entityId: string;
  body: string;
  mentionedUsernames: string[];
  authorId: string;
  authorUsername: string | null;
  authorDisplayName: string;
  createdAt: string;
}

export interface MentionNotificationRow extends EntityCommentRow {
  bodyPreview: string;
  targetHref: string;
}

export const addEntityCommentSchema = z.object({
  entityTable: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,64}$/, "Geçersiz hedef tablo adı."),
  entityId: z.string().trim().min(1, "Hedef kayıt kimliği zorunlu.").max(120),
  body: z
    .string()
    .trim()
    .min(1, "Yorum metni boş olamaz.")
    .max(4000, "Yorum metni en fazla 4000 karakter olabilir."),
  actorId: z.string().uuid("Geçerli bir kullanıcı kimliği gerekli."),
});

export type AddEntityCommentInput = z.input<typeof addEntityCommentSchema>;

/**
 * Extracts normalized, deduplicated `@username` mentions from a comment body.
 * Ignores email addresses (`info@firma.com`) and trims trailing sentence punctuation (`@atilla.`).
 */
export function extractMentions(body: string): string[] {
  if (!body) return [];
  const seen = new Set<string>();
  const mentions: string[] = [];
  const re = /(?:^|[\s([{"',;:])@([a-zA-Z0-9_.-]{2,40})/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const candidate = m[1].replace(/[.-]+$/, "").toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(candidate)) continue;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      mentions.push(candidate);
    }
  }
  return mentions;
}

/** Maps an entity table name to its canonical dashboard route for notification navigation. */
export function resolveCommentTargetHref(entityTable: string, entityId: string): string {
  const tbl = (entityTable ?? "").trim().toLowerCase();
  const enc = encodeURIComponent(entityId ?? "");
  switch (tbl) {
    case "invoices":
      return `/invoices?focus=${enc}`;
    case "payments":
    case "payment_instances":
    case "payment_runs":
      return `/payments?focus=${enc}`;
    case "checks":
    case "check_bordros":
    case "loans":
    case "loan_installments":
    case "credit_facilities":
      return `/finance?focus=${enc}`;
    case "work_orders":
    case "production_parts":
    case "bom_headers":
    case "machine_assets":
      return `/production?focus=${enc}`;
    case "approvals":
      return `/data/approvals?focus=${enc}`;
    case "documents":
      return `/documents?focus=${enc}`;
    case "scenarios":
    case "scenario_runs":
      return `/scenarios?focus=${enc}`;
    case "management_journal_entries":
    case "intercompany_elimination_runs":
      return `/ledger?focus=${enc}`;
    default:
      return `/overview`;
  }
}

function toIsoString(val: Date | string): string {
  return typeof val === "string" ? val : val.toISOString();
}

export async function addEntityComment(
  pool: Pool,
  rawInput: AddEntityCommentInput,
): Promise<EntityCommentRow> {
  const input = parseOrThrow(addEntityCommentSchema, rawInput, "Kayıt yorumu");
  const mentionedUsernames = extractMentions(input.body);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const ins = await client.query<{
      id: string;
      entity_table: string;
      entity_id: string;
      body: string;
      mentioned_usernames: string[] | null;
      author_id: string;
      author_username: string | null;
      author_display_name: string | null;
      created_at: Date | string;
    }>(
      `insert into public.entity_comments
         (entity_table, entity_id, body, mentioned_usernames, author_id)
       values ($1, $2, $3, $4::text[], $5)
       returning id::text,
                 entity_table,
                 entity_id,
                 body,
                 mentioned_usernames,
                 author_id::text,
                 public.user_username_label(author_id) as author_username,
                 public.user_display_label(author_id) as author_display_name,
                 created_at`,
      [
        input.entityTable,
        input.entityId,
        input.body,
        mentionedUsernames,
        input.actorId,
      ],
    );

    if (ins.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Yorum kaydedilemedi.");
    }
    const r = ins.rows[0];

    await audit(client, {
      actor: input.actorId,
      action: "add_entity_comment",
      entityTable: "entity_comments",
      entityId: r.id,
      after: {
        targetTable: r.entity_table,
        targetId: r.entity_id,
        mentionedUsernames,
        bodyLength: r.body.length,
      },
    });

    await client.query("commit");

    return {
      id: r.id,
      entityTable: r.entity_table,
      entityId: r.entity_id,
      body: r.body,
      mentionedUsernames: Array.isArray(r.mentioned_usernames)
        ? r.mentioned_usernames
        : mentionedUsernames,
      authorId: r.author_id,
      authorUsername: r.author_username,
      authorDisplayName: r.author_display_name ?? r.author_username ?? "Kullanıcı",
      createdAt: toIsoString(r.created_at),
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function listEntityComments(
  pool: Pool,
  entityTable: string,
  entityId: string,
  limit = 30,
): Promise<EntityCommentRow[]> {
  const cleanTable = (entityTable ?? "").trim().toLowerCase();
  const cleanId = (entityId ?? "").trim();
  if (!cleanTable || !cleanId) return [];
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));

  try {
    const res = await pool.query<{
      id: string;
      entity_table: string;
      entity_id: string;
      body: string;
      mentioned_usernames: string[] | null;
      author_id: string;
      author_username: string | null;
      author_display_name: string | null;
      created_at: Date | string;
    }>(
      `select ec.id::text,
              ec.entity_table,
              ec.entity_id,
              ec.body,
              ec.mentioned_usernames,
              ec.author_id::text,
              public.user_username_label(ec.author_id) as author_username,
              public.user_display_label(ec.author_id) as author_display_name,
              ec.created_at
         from public.entity_comments ec
        where ec.entity_table = $1
          and ec.entity_id = $2
        order by ec.created_at desc
        limit $3`,
      [cleanTable, cleanId, safeLimit],
    );

    return res.rows.map((r) => ({
      id: r.id,
      entityTable: r.entity_table,
      entityId: r.entity_id,
      body: r.body,
      mentionedUsernames: Array.isArray(r.mentioned_usernames) ? r.mentioned_usernames : [],
      authorId: r.author_id,
      authorUsername: r.author_username,
      authorDisplayName: r.author_display_name ?? r.author_username ?? "Kullanıcı",
      createdAt: toIsoString(r.created_at),
    }));
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === "42P01" || pgCode === "42883") return [];
    throw err;
  }
}

export async function listRecentMentionNotifications(
  pool: Pool,
  username: string,
  limit = 15,
): Promise<MentionNotificationRow[]> {
  const cleanUsername = (username ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!cleanUsername) return [];
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));

  try {
    const res = await pool.query<{
      id: string;
      entity_table: string;
      entity_id: string;
      body: string;
      mentioned_usernames: string[] | null;
      author_id: string;
      author_username: string | null;
      author_display_name: string | null;
      created_at: Date | string;
    }>(
      `select ec.id::text,
              ec.entity_table,
              ec.entity_id,
              ec.body,
              ec.mentioned_usernames,
              ec.author_id::text,
              public.user_username_label(ec.author_id) as author_username,
              public.user_display_label(ec.author_id) as author_display_name,
              ec.created_at
         from public.entity_comments ec
        where ec.mentioned_usernames @> array[$1]::text[]
        order by ec.created_at desc
        limit $2`,
      [cleanUsername, safeLimit],
    );

    return res.rows.map((r) => {
      const compact = r.body.replace(/\s+/g, " ").trim();
      return {
        id: r.id,
        entityTable: r.entity_table,
        entityId: r.entity_id,
        body: r.body,
        bodyPreview: compact.length > 140 ? `${compact.slice(0, 137)}...` : compact,
        mentionedUsernames: Array.isArray(r.mentioned_usernames) ? r.mentioned_usernames : [],
        authorId: r.author_id,
        authorUsername: r.author_username,
        authorDisplayName: r.author_display_name ?? r.author_username ?? "Kullanıcı",
        createdAt: toIsoString(r.created_at),
        targetHref: resolveCommentTargetHref(r.entity_table, r.entity_id),
      };
    });
  } catch (err) {
    const pgCode = (err as { code?: string })?.code;
    if (pgCode === "42P01" || pgCode === "42883") return [];
    throw err;
  }
}
