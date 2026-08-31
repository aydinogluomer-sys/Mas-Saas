// P24B — cleanup SONRASI bağımsız inceleme. Hiçbir şey yazmaz.
//
// NEDEN AYRI BİR PROGRAM. Cleanup'ın kendi makbuzu, kendi transaction'ı içinden "her şey yolunda"
// diyor. Bu, doğrulama değil beyandır: aynı kodun aynı ölçümü iki kez okuması bağımsız bir kanıt
// üretmez. Buradaki her sayı YENİ bir bağlantıdan, cleanup bittikten sonra alınır.
//
// KARŞILAŞTIRMA NOKTASI GERÇEK. "Değişen tablolar" iddiası, cleanup öncesi durumun bir kopyasına
// ihtiyaç duyar. O kopya elimizde: USB yedeğinden geri yüklenen disposable klon, cleanup öncesi
// tüm-DB parmak iziyle birebir eşleştiği kanıtlanmış durumda. Yani "önce" tarafı hatırlanan bir
// sayı değil, sorgulanabilir bir veritabanı.
//
// READ-ONLY MOTOR TARAFINDAN ZORLANIR (üç katman): startup option + BEGIN READ ONLY + ROLLBACK.
// İki bağlantı da öyle açılır — inceleme aracının kendisi incelediği şeyi değiştiremez.
//
// BAĞLANTI DİZESİ ASLA BASILMAZ. Yalnız veritabanı adı çıkar.
//
// Kullanım:
//   node --env-file=.env.local --import tsx scripts/qa/p24b-post-cleanup-review.ts <outDir> <preCleanupDb>
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { ownerDatabaseUrl, databaseNameFromUrl } from "../db/owner-url";
import { wholeDbFingerprintMap } from "../db/p24b-cleanup-fingerprint";

const MANIFEST_PATH = path.join(
  "docs", "release-evidence", "final-production-readiness", "p24b-v6", "02-row-evidence-manifest.json",
);
const TABLES = ["action_items", "approvals", "payment_instances", "payments", "users", "settings"] as const;
const FIXTURE_PAYMENT = "7b300bfe-944f-468b-91fa-2de65b7cfee5";
const ATILLA = "atilla";
const SNAPSHOT_DATE = "2026-08-27";

/** Cleanup'ın dokunmasına izin verilen mantıksal yüzeyler. Başka her tablo BLOCKER'dır. */
const EXPECTED_CHANGED = [
  "public.action_items", "public.approvals", "public.payment_instances", "public.payments",
  "public.users", "public.settings", "public.metric_snapshots", "public.audit_logs",
];

interface ManifestRow { table: string; id: string; classification: string }

function die(m: string): never { console.error(`DURDURULDU: ${m}`); process.exit(1); }

async function readOnly<T>(url: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  const c = await pool.connect();
  try {
    await c.query("begin read only");
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await pool.end();
  }
}

async function scalar(c: PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  return (await c.query<{ v: string }>(sql, params)).rows[0]?.v ?? "";
}

async function main(): Promise<void> {
  const outDir = process.argv[2];
  const preDb = process.argv[3];
  if (!outDir || !preDb) die("kullanım: p24b-post-cleanup-review.ts <outDir> <preCleanupDb>");

  const url = ownerDatabaseUrl();
  if (!url) die("MIGRATION_DATABASE_URL tanımlı değil");
  const sourceDb = databaseNameFromUrl(url);
  if (sourceDb !== "mas_radar_dev") die(`bu inceleme mas_radar_dev içindir; hedef '${sourceDb}'`);
  const preUrl = url.replace(/\/[^/]+$/, `/${preDb}`);

  const targets = (JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { rows: ManifestRow[] }).rows
    .filter((r) => r.classification === "DELETE_TARGET");

  const w = (f: string, o: unknown): void => {
    writeFileSync(path.join(outDir, f), JSON.stringify(o, null, 2) + "\n", "utf8");
  };

  /* ── cleanup ÖNCESİ durum: USB yedeğinden geri yüklenen klon ─────────────────────────── */
  const pre = await readOnly(preUrl, async (c) => ({
    db: (await c.query<{ d: string }>("select current_database() d")).rows[0].d,
    map: await wholeDbFingerprintMap(c),
    auditHashes: (await c.query<{ h: string }>("select md5(a::text) h from public.audit_logs a")).rows.map((r) => r.h),
    atilla: await scalar(c, "select md5(u::text) v from public.users u where u.username=$1", [ATILLA]),
  }));

  /* ── cleanup SONRASI gerçek veritabanı ───────────────────────────────────────────────── */
  const post = await readOnly(url, async (c) => {
    const transactionReadOnly = (await c.query<{ transaction_read_only: string }>(
      "show transaction_read_only")).rows[0].transaction_read_only;
    const db = (await c.query<{ d: string }>("select current_database() d")).rows[0].d;
    const ledger = await scalar(c, "select max(version)||'/'||count(*) v from public.schema_migrations");
    const baseTableCount = Number(await scalar(c,
      `select count(*)::text v from information_schema.tables
        where table_type='BASE TABLE' and table_schema = any($1::text[])`, [["public", "auth"]]));

    /* 6 — EXACT manifest kimlikleri. Karar burada verilir; desen araması yalnız destektir. */
    const stillPresent: Array<{ table: string; id: string }> = [];
    for (const r of targets) {
      const idCol = r.table === "settings" ? "key" : "id";
      const cast = r.table === "settings" ? "text" : "uuid";
      const n = await scalar(c, `select count(*)::text v from public.${r.table} x where x.${idCol}=$1::${cast}`, [r.id]);
      if (Number(n) > 0) stillPresent.push({ table: r.table, id: r.id });
    }

    /* 7 — semantik/türev kalıntı taraması. Kör DELETE yok: yalnız SAYAR ve raporlar. */
    const semantic: Record<string, number> = {};
    for (const [k, sql] of Object.entries({
      fixture_payment_by_id: `select count(*)::text v from public.payments where id='${FIXTURE_PAYMENT}'`,
      instances_of_fixture_payment: `select count(*)::text v from public.payment_instances where payment_id='${FIXTURE_PAYMENT}'`,
      orphan_instances: "select count(*)::text v from public.payment_instances where payment_id is null",
      users_p24b: "select count(*)::text v from public.users u where u::text ilike '%p24b%'",
      users_rlsverify: "select count(*)::text v from public.users u where u::text ilike '%rls%verify%'",
      action_items_p24b: "select count(*)::text v from public.action_items a where a::text ilike '%p24b%'",
      approvals_p24b: "select count(*)::text v from public.approvals a where a::text ilike '%p24b%'",
      settings_p24b: "select count(*)::text v from public.settings s where s::text ilike '%p24b%'",
      approvals_null_requested_by: "select count(*)::text v from public.approvals where requested_by is null",
    })) semantic[k] = Number(await scalar(c, sql));

    const counts: Record<string, number> = {};
    for (const t of TABLES) counts[t] = Number(await scalar(c, `select count(*)::text v from public.${t}`));

    /* 9 — işletme metrikleri: düzelmesi beklenen ikisi + dokunulmaması gereken toplamlar. */
    const metrics = {
      taskOpen: await scalar(c,
        `select value_numeric::text v from public.metric_snapshots
          where snapshot_date=$1::date and metric_key='task_status' and dimension_key='open'`, [SNAPSHOT_DATE]),
      unpaidTry: await scalar(c,
        `select value_numeric::text v from public.metric_snapshots
          where snapshot_date=$1::date and metric_key='payment_status' and dimension_key='unpaid'`, [SNAPSHOT_DATE]),
      checks: await scalar(c, "select coalesce(sum(amount),0)::text v from public.checks"),
      loans: await scalar(c, "select coalesce(sum(principal),0)::text v from public.loans"),
      cashflow: await scalar(c, "select coalesce(sum(closing_balance),0)::text v from public.cashflow_months"),
      payments: await scalar(c, "select coalesce(sum(default_amount),0)::text v from public.payments"),
      instances: await scalar(c, "select coalesce(sum(amount),0)::text v from public.payment_instances"),
    };

    const auditRows = (await c.query<{ h: string; action: string }>(
      "select md5(a::text) h, a.action from public.audit_logs a")).rows;

    /* 13 — FK kataloğu ve yetim sondaları. */
    const fk = (await c.query<{ child: string; col: string; parent: string; act: string }>(
      `select c.relname child, a.attname col, p.relname parent, con.confdeltype act
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_class p on p.oid = con.confrelid
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
        where con.contype='f' and p.relname = any($1::text[])
        order by c.relname, a.attname`, [[...TABLES]])).rows;

    const orphans: Record<string, number> = {};
    for (const [k, sql] of Object.entries({
      instances_without_payment:
        "select count(*)::text v from public.payment_instances i where i.payment_id is not null and not exists (select 1 from public.payments p where p.id=i.payment_id)",
      action_items_bad_creator:
        "select count(*)::text v from public.action_items x where x.created_by is not null and not exists (select 1 from public.users u where u.id=x.created_by)",
      approvals_bad_requester:
        "select count(*)::text v from public.approvals x where x.requested_by is not null and not exists (select 1 from public.users u where u.id=x.requested_by)",
      approvals_bad_decider:
        "select count(*)::text v from public.approvals x where x.decided_by is not null and not exists (select 1 from public.users u where u.id=x.decided_by)",
      audit_bad_actor:
        "select count(*)::text v from public.audit_logs x where x.actor is not null and not exists (select 1 from public.users u where u.id=x.actor)",
      sessions_bad_user:
        "select count(*)::text v from public.sessions x where x.user_id is not null and not exists (select 1 from public.users u where u.id=x.user_id)",
    })) orphans[k] = Number(await scalar(c, sql));

    return {
      transactionReadOnly, db, ledger, baseTableCount, stillPresent, semantic, counts, metrics,
      auditRows, fk, orphans,
      atilla: await scalar(c, "select md5(u::text) v from public.users u where u.username=$1", [ATILLA]),
      atillaCount: Number(await scalar(c, "select count(*)::text v from public.users where username=$1", [ATILLA])),
      map: await wholeDbFingerprintMap(c),
    };
  });

  /* ── 14: değişimi TABLO BAZINDA sınıflandır ──────────────────────────────────────────── */
  const changed: string[] = [];
  const allTables = new Set([...Object.keys(pre.map), ...Object.keys(post.map)]);
  for (const t of allTables) if (pre.map[t] !== post.map[t]) changed.push(t);
  changed.sort();
  const unexpectedChanged = changed.filter((t) => !EXPECTED_CHANGED.includes(t));
  const expectedButUnchanged = EXPECTED_CHANGED.filter((t) => !changed.includes(t));

  /* ── 11: audit bütünlüğü — mevcut satırlar hash kümesi olarak karşılaştırılır ─────────── */
  const preSet = new Set(pre.auditHashes);
  const postHashes = post.auditRows.map((r) => r.h);
  const survived = postHashes.filter((h) => preSet.has(h));
  const newHashes = postHashes.filter((h) => !preSet.has(h));
  const newActions = post.auditRows.filter((r) => !preSet.has(r.h)).map((r) => r.action).sort();
  const cleanupEvents = post.auditRows.filter((r) => r.action === "p24b_fixture_cleanup").length;

  w("02-remnant-scan.json", {
    artifactKind: "mas-p24b-remnant-scan-v1",
    expectedOldTargets: targets.length,
    foundRemaining: post.stillPresent.length,
    missingAsExpected: targets.length - post.stillPresent.length,
    stillPresent: post.stillPresent,
    semanticScan: post.semantic,
    counts: post.counts,
    note: "Karar EXACT manifest kimlikleri üzerinden; ilike taramaları yalnız destekleyicidir.",
  });

  w("03-business-metrics.json", {
    artifactKind: "mas-p24b-business-metrics-v1",
    snapshotDate: SNAPSHOT_DATE, metrics: post.metrics,
  });

  w("04-audit-and-atilla.json", {
    artifactKind: "mas-p24b-audit-atilla-v1",
    auditCountBefore: pre.auditHashes.length,
    auditCountAfter: postHashes.length,
    existingRowsSurvivedUnchanged: survived.length,
    existingRowsMutatedOrDeleted: pre.auditHashes.length - survived.length,
    newRows: newHashes.length,
    newActions,
    duplicateCleanupEvents: cleanupEvents > 1,
    cleanupEventCount: cleanupEvents,
    atilla: {
      presentBefore: pre.atilla !== "", presentAfter: post.atillaCount === 1,
      rowHashUnchanged: pre.atilla !== "" && pre.atilla === post.atilla,
    },
  });

  w("05-fk-orphans.json", {
    artifactKind: "mas-p24b-fk-orphans-v1",
    fkCount: post.fk.length, fkContract: post.fk, orphanProbes: post.orphans,
    totalOrphans: Object.values(post.orphans).reduce((a, b) => a + b, 0),
  });

  w("06-change-classification.json", {
    artifactKind: "mas-p24b-change-classification-v1",
    comparedAgainst: { database: pre.db, meaning: "USB yedeğinden geri yüklenen cleanup ÖNCESİ durum" },
    tablesCompared: allTables.size,
    expectedChanged: EXPECTED_CHANGED,
    actualChanged: changed,
    unexpectedChanged,
    expectedButUnchanged,
    perTable: Object.fromEntries(changed.map((t) => [t, { before: pre.map[t] ?? null, after: post.map[t] ?? null }])),
  });

  const summary = {
    ledger: post.ledger, baseTableCount: post.baseTableCount,
    transactionReadOnly: post.transactionReadOnly, database: post.db,
    remainingTargets: post.stillPresent.length,
    unexpectedChangedTables: unexpectedChanged.length,
    totalOrphans: Object.values(post.orphans).reduce((a, b) => a + b, 0),
    auditExistingMutations: pre.auditHashes.length - survived.length,
    atillaHashUnchanged: pre.atilla === post.atilla,
  };
  w("00-review-summary.json", { artifactKind: "mas-p24b-review-summary-v1", ...summary,
    manifestSha256: createHash("sha256").update(readFileSync(MANIFEST_PATH)).digest("hex") });

  const line = (k: string, v: unknown): void => console.log(`${k.padEnd(34)}: ${String(v)}`);
  line("DATABASE", `${post.db} (read_only=${post.transactionReadOnly})`);
  line("LEDGER / BASE_TABLES", `${post.ledger} / ${post.baseTableCount}`);
  line("EXACT_TARGETS_REMAINING", `${post.stillPresent.length}/${targets.length}`);
  line("SEMANTIC_REMNANTS", JSON.stringify(post.semantic));
  line("COUNTS", JSON.stringify(post.counts));
  line("task_open / unpaid_try", `${post.metrics.taskOpen} / ${post.metrics.unpaidTry}`);
  line("AUDIT before→after", `${pre.auditHashes.length} → ${postHashes.length}`);
  line("AUDIT existing unchanged", `${survived.length}/${pre.auditHashes.length}`);
  line("AUDIT new actions", JSON.stringify(newActions));
  line("ATILLA present / hash equal", `${post.atillaCount} / ${pre.atilla === post.atilla}`);
  line("FK count / orphans", `${post.fk.length} / ${Object.values(post.orphans).reduce((a, b) => a + b, 0)}`);
  line("CHANGED TABLES", JSON.stringify(changed));
  line("UNEXPECTED CHANGED", JSON.stringify(unexpectedChanged));
  line("EXPECTED BUT UNCHANGED", JSON.stringify(expectedButUnchanged));
}

main().catch((e) => { console.error(e); process.exit(1); });
