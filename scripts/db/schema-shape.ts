// CI-1 (PRE-PHASE8 CI CLOSURE) — `public` şemasının DETERMİNİSTİK ŞEKLİ.
//
// NEDEN VAR. migrate.ts'in LEDGER_EMPTY_RECOVERY akışı "ledger boş ama şema var" durumunda şemanın
// HANGİ migration'a kadar geldiğini bilmek zorundadır. Eski varsayım "legacy anchor'lar (0001–0019)
// geçiyorsa şema 0019'dadır; 0021+'yı yeniden oynat" idi. Bu, 0093/0094 view kolonlarını
// değiştirdiği andan itibaren yanlış: HEAD'de duran bir şemaya eski `create or replace view`
// tanımları yeniden uygulanınca PostgreSQL "cannot drop columns from view" der (12 migration).
// Geçmiş migration'ları yeniden yazmak yasak; doğru olan şemanın nerede olduğunu ÖLÇMEKTİR.
//
// NE ÖLÇER. Veri değil, ŞEKİL: tablolar/kolonlar (tip, null, default), view tanımları, matview'lar,
// indeksler, kısıtlar, tetikleyiciler, fonksiyonlar (gövde hash'i), RLS bayrakları ve politikalar,
// enum etiketleri, sequence'lar, uzantılar, tablo düzeyi yetkiler (relacl). Hepsi ad ile, OID ile
// değil; sıralı satırlar; sha256. Aynı migration dizisi iki farklı veritabanında aynı digest'i
// üretir — geri kalan her şey (satırlar, sequence değerleri, istatistikler) BİLEREK dışarıda.
//
// KAPSAM `public`. `auth` şeması local-bootstrap.sql'den gelir ve migration'ların konusu değildir;
// `schema_migrations` tablosunun KENDİSİ şekle dahildir (0020'den itibaren var olmalı), satırları değil.

import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

type Q = Pick<PoolClient, "query"> | Pick<Pool, "query">;

export interface SchemaShape {
  digest: string;
  lines: string[];
}

const QUERIES: Array<{ tag: string; sql: string }> = [
  {
    tag: "rel",
    sql: `select c.relkind::text as k, c.relname as n, coalesce(c.relacl::text, '') as acl,
                 c.relrowsecurity as rls, c.relforcerowsecurity as frls
            from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relkind in ('r','p','v','m','S','f')`,
  },
  {
    tag: "col",
    sql: `select c.relname as r, a.attname as n, format_type(a.atttypid, a.atttypmod) as t, a.attnotnull as nn,
                 coalesce(pg_get_expr(d.adbin, d.adrelid), '') as def, a.attidentity::text as ident, a.attgenerated::text as gen
            from pg_attribute a
            join pg_class c on c.oid = a.attrelid
            join pg_namespace ns on ns.oid = c.relnamespace
            left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
           where ns.nspname = 'public' and c.relkind in ('r','p','v','m','f') and a.attnum > 0 and not a.attisdropped`,
  },
  {
    tag: "view",
    sql: `select c.relname as n, md5(pg_get_viewdef(c.oid, true)) as h
            from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relkind in ('v','m')`,
  },
  {
    tag: "idx",
    sql: `select tablename as r, indexname as n, indexdef as d from pg_indexes where schemaname = 'public'`,
  },
  {
    tag: "con",
    sql: `select rel.relname as r, con.conname as n, pg_get_constraintdef(con.oid) as d, con.convalidated as v
            from pg_constraint con
            join pg_class rel on rel.oid = con.conrelid
            join pg_namespace ns on ns.oid = rel.relnamespace
           where ns.nspname = 'public'`,
  },
  {
    tag: "trg",
    sql: `select rel.relname as r, t.tgname as n, pg_get_triggerdef(t.oid) as d, t.tgenabled::text as e
            from pg_trigger t
            join pg_class rel on rel.oid = t.tgrelid
            join pg_namespace ns on ns.oid = rel.relnamespace
           where ns.nspname = 'public' and not t.tgisinternal`,
  },
  {
    tag: "fn",
    sql: `select p.proname as n, pg_get_function_identity_arguments(p.oid) as a, pg_get_function_result(p.oid) as r,
                 md5(p.prosrc) as h, p.prosecdef as sd, p.provolatile::text as v, l.lanname as lang,
                 coalesce(p.proconfig::text, '') as cfg
            from pg_proc p
            join pg_namespace ns on ns.oid = p.pronamespace
            join pg_language l on l.oid = p.prolang
           where ns.nspname = 'public'`,
  },
  {
    tag: "pol",
    sql: `select tablename as r, policyname as n, cmd, permissive, coalesce(roles::text, '') as roles,
                 coalesce(qual, '') as q, coalesce(with_check, '') as w
            from pg_policies where schemaname = 'public'`,
  },
  {
    tag: "enum",
    sql: `select t.typname as n, string_agg(e.enumlabel, ',' order by e.enumsortorder) as labels
            from pg_type t
            join pg_namespace ns on ns.oid = t.typnamespace
            join pg_enum e on e.enumtypid = t.oid
           where ns.nspname = 'public'
           group by t.typname`,
  },
  {
    tag: "dom",
    sql: `select t.typname as n, format_type(t.typbasetype, t.typtypmod) as base, t.typnotnull as nn,
                 coalesce((select string_agg(pg_get_constraintdef(c.oid), ' AND ' order by c.conname) from pg_constraint c where c.contypid = t.oid), '') as chk
            from pg_type t join pg_namespace ns on ns.oid = t.typnamespace
           where ns.nspname = 'public' and t.typtype = 'd'`,
  },
  {
    tag: "ext",
    sql: `select e.extname as n, e.extversion as v from pg_extension e`,
  },
];

/** Satırlar `tag|alan1|alan2…` biçiminde, birleşik ve sıralı; digest sha256. */
export async function schemaShape(q: Q): Promise<SchemaShape> {
  const lines: string[] = [];
  for (const { tag, sql } of QUERIES) {
    const res = await q.query(sql);
    for (const row of res.rows as Array<Record<string, unknown>>) {
      const fields = Object.keys(row).sort().map((k) => `${k}=${String(row[k] ?? "")}`);
      lines.push(`${tag}|${fields.join("|")}`);
    }
  }
  lines.sort();
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  return { digest, lines };
}

/** İki şekil arasındaki farkın kısa özeti (yalnız satır düzeyi; operatöre yön göstermek için). */
export function diffShapes(a: SchemaShape, b: SchemaShape, limit = 12): { onlyInA: string[]; onlyInB: string[] } {
  const sa = new Set(a.lines);
  const sb = new Set(b.lines);
  return {
    onlyInA: a.lines.filter((l) => !sb.has(l)).slice(0, limit),
    onlyInB: b.lines.filter((l) => !sa.has(l)).slice(0, limit),
  };
}
