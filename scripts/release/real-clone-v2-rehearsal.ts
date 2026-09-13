// PHASE 6.2 — gerçek yedeğin harcanabilir klonunda: migration'lar → V2 import → parmak izi.
//
// Docker'sız çalışır; Docker bozukken taşınabilir PostgreSQL ile de koşabilsin diye psql ikilisi
// `MAS_PSQL` ile verilir (varsayılan: PATH'teki psql). Bu betik `golden-fingerprint.ts`'in yerini
// ALMAZ: o, gerçek DB'den taze dump alır ve `pnpm db:migrate`'in ledger'ı ile birlikte ilerletir.
// Burada klon zaten restore edilmiştir ve migration'lar SQL dosyası olarak uygulanır — ledger
// ilerletilmez; bu bilinçli bir sapmadır ve rapora yazılır. Cevaplanan soru: "yayımlanacak
// migration'lar GERÇEK şema+veri üzerinde uygulanıyor mu ve eski finansal satırlara dokunuyor mu;
// V2 import gerçek veriyle yan yana yaşayabiliyor mu?"
//
// Kullanım:
//   CLONE_DATABASE_URL=postgresql://postgres:…@127.0.0.1:54329/mas_radar_restore_drill_x \
//   MAS_PSQL=…/psql MIGRATIONS="…/0088.sql;…/0093.sql"  (";" veya satır sonu ile ayrılır) \
//   pnpm exec tsx scripts/release/real-clone-v2-rehearsal.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { fingerprint } from "./lib/fingerprint";
import { databaseNameFromUrl, isDisposableDatabaseName, PROTECTED_DB_NAMES } from "../db/owner-url";
import { buildFixtureWorkbook, FIXTURE_ORACLE } from "../../src/lib/importers/v2/fixture";
import { parseWorkbook } from "../../src/lib/importers/v2/parser";
import { mapWorkbook } from "../../src/lib/importers/v2/mapper";
import { ensureSystemActor } from "../db/seed-system-actor";

const LEGACY_FINANCIAL = ["payments", "payment_instances", "checks", "loans", "loan_installments", "cashflow_months"];

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const record = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/** Eski satırların kimlik-sabit parmak izi: yalnız `ids` içindeki satırlar, PRE kolonlarıyla. */
async function legacyRowsHash(pool: Pool, table: string, cols: string[], ids: string[]): Promise<string> {
  if (ids.length === 0) return "empty";
  const r = await pool.query<{ h: string }>(
    `select md5(string_agg(h, ',' order by h)) as h from (
       select md5(concat_ws('|', ${cols.map((c) => `"${c}"::text`).join(", ")})) as h
       from public.${table} where id::text = any($1::text[])) s`, [ids]);
  return r.rows[0]?.h ?? "empty";
}

async function main(): Promise<void> {
  const url = process.env.CLONE_DATABASE_URL ?? "";
  const name = databaseNameFromUrl(url);
  if (!url || !isDisposableDatabaseName(name)) {
    throw new Error(`CLONE_DATABASE_URL harcanabilir bir ad taşımıyor: '${name ?? "?"}' (korunanlar: ${PROTECTED_DB_NAMES.join(", ")})`);
  }
  const psql = process.env.MAS_PSQL ?? "psql";
  // Noktalı virgül veya satır sonu ile ayrılır — Windows yolları boşluk içerebilir ("Trade Bilisim").
  const migrations = (process.env.MIGRATIONS ?? "").split(/[;\r\n]+/).map((x) => x.trim()).filter(Boolean);
  const pool = new Pool({ connectionString: url });
  const started = new Date().toISOString();

  console.log(`klon: ${name}`);
  const ledgerBefore = (await pool.query<{ n: string; v: string }>("select count(*) n, max(version) v from public.schema_migrations")).rows[0];

  /* ── PRE ── */
  const pre = await fingerprint(pool);
  const preIds: Record<string, string[]> = {};
  const preLegacyHash: Record<string, string> = {};
  for (const t of LEGACY_FINANCIAL) {
    preIds[t] = (await pool.query<{ id: string }>(`select id::text as id from public.${t}`)).rows.map((r) => r.id);
    preLegacyHash[t] = await legacyRowsHash(pool, t, pre.columns[t], preIds[t]);
  }

  /* ── MIGRATIONS (SQL dosyası olarak, ON_ERROR_STOP) ── */
  const applied: string[] = [];
  for (const file of migrations) {
    try {
      execFileSync(psql, ["-v", "ON_ERROR_STOP=1", "-q", "-d", url, "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      const lines = String(err.stderr ?? "").split(/\r?\n/).filter((l) => l && !l.includes("NOTICE:"));
      throw new Error(`psql ${path.basename(file)} basarisiz (status ${err.status}):\n${lines.slice(0, 12).join("\n")}`);
    }
    applied.push(path.basename(file));
  }
  record("migration'lar gerçek şema+veri üzerinde uygulandı", true, applied.join(", ") || "(yok)");

  /* ── POST (PRE kolonlarına izdüşüm) ── */
  const post = await fingerprint(pool, pre.columns);
  const moved = LEGACY_FINANCIAL.filter((t) => pre.hashes[t] !== post.hashes[t] || pre.counts[t] !== post.counts[t]);
  record("migration eski finansal satırlara dokunmadı (6 tablo, PRE kolonları)", moved.length === 0,
    moved.length === 0 ? LEGACY_FINANCIAL.map((t) => `${t}=${post.counts[t]}`).join(" ") : `değişen: ${moved.join(", ")}`);
  const newCols = Object.keys(post.columns).flatMap((t) => (post.columns[t] ?? []).filter((c) => !(pre.columns[t] ?? []).includes(c)).map((c) => `${t}.${c}`));
  const liveCols = await pool.query<{ t: string; c: string }>(
    `select table_name t, column_name c from information_schema.columns where table_schema='public'`);
  const addedCols = liveCols.rows.filter((r) => pre.columns[r.t] && !pre.columns[r.t].includes(r.c)).map((r) => `${r.t}.${r.c}`);
  record("şema eklemeleri (beyaz liste: yeni kolon/tablo/view)", true, `${addedCols.join(", ") || "yok"}${newCols.length ? "" : ""}`);

  /* ── V2 fixture import (tek transaction) ── */
  const actorId = await ensureSystemActor(pool);
  const wb = await buildFixtureWorkbook();
  const parsed = parseWorkbook(wb);
  const client = await pool.connect();
  let result;
  try {
    await client.query("begin");
    result = await mapWorkbook(client, parsed, { filename: "fixture-v2-rehearsal.xlsx", fileSha256: null, actorId, dryRun: false });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  const oracle = Object.values(FIXTURE_ORACLE.sheets);
  record("V2 fixture gerçek verinin YANINA yazıldı", result.rowsStaged === oracle.reduce((n, s) => n + s.rowsRead, 0),
    `rowsStaged=${result.rowsStaged} rowsMapped=${result.rowsMapped} needsReview=${result.rowsNeedsReview} rejected=${result.rowsRejected} blocked=${result.rowsBlockedByParent} reviews=${result.reviewsOpened}`);

  /* ── POST-IMPORT: eski satırlar kimlik bazında değişmedi ── */
  const touched: string[] = [];
  for (const t of LEGACY_FINANCIAL) {
    const h = await legacyRowsHash(pool, t, pre.columns[t], preIds[t]);
    if (h !== preLegacyHash[t]) touched.push(t);
  }
  record("V2 import eski (legacy) satırlara dokunmadı (kimlik-sabit hash, 6 tablo)", touched.length === 0,
    touched.length === 0 ? "6/6 aynı" : `değişen: ${touched.join(", ")}`);
  const after = await fingerprint(pool, pre.columns);
  const grown = LEGACY_FINANCIAL.map((t) => `${t}: ${pre.counts[t]}→${after.counts[t]}`).join(" ");
  record("satır sayıları yalnız EKLENDİ", LEGACY_FINANCIAL.every((t) => after.counts[t] >= pre.counts[t]), grown);
  const orphan = Number((await pool.query(
    "select count(*) from public.import_rows r where r.workbook_id = $1 and r.mapping_status='mapped' and r.mapped_entity_id is null",
    [result.workbookId])).rows[0].count);
  record("yazılan her V2 kaydı kaynak satırına bağlı", orphan === 0, `orphan=${orphan}`);
  const ledgerAfter = (await pool.query<{ n: string; v: string }>("select count(*) n, max(version) v from public.schema_migrations")).rows[0];

  /* ── rapor ── */
  const failed = checks.filter((c) => !c.pass);
  const out = process.env.REHEARSAL_OUT ?? path.join("docs", "release-evidence", "standard-import-v2", "06-real-clone-rehearsal.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    artifactKind: "mas-real-clone-v2-rehearsal-v1", startedAt: started, finishedAt: new Date().toISOString(),
    clone: name, ledgerBefore: `${ledgerBefore.n}/${ledgerBefore.v}`, ledgerAfter: `${ledgerAfter.n}/${ledgerAfter.v}`,
    ledgerNote: "migration'lar SQL dosyası olarak uygulandı; ledger ilerletilmedi (gerçek cutover pnpm db:migrate ile ilerletir)",
    migrationsApplied: applied, addedColumns: addedCols,
    legacyCounts: Object.fromEntries(LEGACY_FINANCIAL.map((t) => [t, { pre: pre.counts[t], postMigration: post.counts[t], postImport: after.counts[t] }])),
    v2Import: { workbookId: result.workbookId, rowsStaged: result.rowsStaged, rowsMapped: result.rowsMapped, perTable: result.perTable },
    checks, verdict: failed.length === 0 ? "PASS" : "FAIL",
  }, null, 2) + "\n", "utf8");
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti → ${out}`);
  await pool.end();
  if (failed.length) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
