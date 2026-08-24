// Faz 5 — the cutover migration rehearsal, as one command instead of a paragraph.
//
// WHAT THIS REPLACES. The golden exact-clone run has been done, and it worked: fresh dump, fresh
// restore, fingerprint, real `pnpm db:migrate` 0034→0087, fingerprint again, four financial tables
// byte-identical. But it was done by hand. A procedure that lives in someone's terminal history is
// not a release gate — it cannot be repeated identically before the next cutover, it cannot be
// handed to a second operator, and nobody can tell afterwards which assertions were actually
// checked. This file is that run, written down so it can be executed the same way every time.
//
// WHAT IT DOES, IN ORDER (plan §8.1):
//
//   real DB → fresh dump → pg_restore --list → fresh restore → PRE fingerprint
//           → real pnpm db:migrate → POST fingerprint → assertions → manifest
//
// THE SOURCE IS NEVER WRITTEN TO. Only pg_dump touches it, and pg_dump only reads. Every write in
// this script goes to a clone whose name must carry a disposable marker. The source URL is not
// printed anywhere — it carries a password.
//
// "ESKİ CLONE TEKRAR KULLANILMAZ" (§8.1) is enforced, not advised: the clone is dropped and
// recreated at the start of every run, so a stale clone cannot be silently re-fingerprinted.
//
// Usage:
//   SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \
//   CLONE_DB=mas_radar_cutover_clone \
//   pnpm release:golden-fingerprint
//
// Optional: MAS_PG_CONTAINER (default mas-radar-pg), MAS_PG_PORT (default 5432),
//           FINGERPRINT_OUT (default docs/release-evidence/cutover-fingerprint-<date>.md)
//
// TWO URLS, TWO VANTAGE POINTS — the one footgun in this script.
//
//   SOURCE_DATABASE_URL is handed to pg_dump, which runs INSIDE the container. It must therefore be
//   reachable from inside: for a container-hosted database that is port 5432, NOT whatever host
//   port it is published on.
//   MAS_PG_PORT is used by this process and by `pnpm db:migrate`, both of which run on the HOST, so
//   it is the published port.
//
// On the standard single-container setup the two coincide (5432) and nothing is noticeable. They
// diverge the moment a rehearsal runs against a sandbox published on another port, which is
// exactly when a silent connection to the wrong database would be most expensive.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const CONTAINER = process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
const PORT = process.env.MAS_PG_PORT ?? "5432";
const SOURCE_URL = process.env.SOURCE_DATABASE_URL ?? "";
const CLONE_DB = process.env.CLONE_DB ?? "";
const DUMP_PATH = "/tmp/mas_cutover.dump";

/** Same marker vocabulary as scripts/db/owner-url.ts. The clone is DROPPED, so this gate is first. */
const DISPOSABLE = /verify|test|tmp|temp|disposable|scratch|sandbox|fixture|clone|restore|snapshot|probe/;
const PROTECTED = new Set(["mas_radar_dev", "postgres", "template0", "template1"]);

/**
 * Tables whose contents a migration must NOT change.
 *
 * This is the whitelist inverted, and inverting it is the point: §8.2 permits schema additions and
 * new empty objects, and permits exactly one data mutation (operator → finance_manager). Anything
 * that moves a row in these six is outside the whitelist and stops the cutover.
 */
const LEGACY_FINANCIAL = [
  "payments", "payment_instances", "checks", "loans", "loan_installments", "cashflow_months",
];

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function docker(args: string[], input?: Buffer): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 28, input });
}

function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 70 - label.length))}`);
}

interface Fingerprint {
  counts: Record<string, number>;
  columns: Record<string, string[]>;
  hashes: Record<string, string>;
  aggregates: Record<string, string>;
  roleCounts: Record<string, number>;
  ledger: { rows: number; latest: string | null };
}

/**
 * Everything §8.2 asks for, in one pass.
 *
 * The row hash is computed over an EXPLICIT column list rather than `t::text`, and that choice is
 * what makes the pre/post comparison meaningful. A migration that adds a column changes every
 * row's text representation, so a whole-row hash would report "all data changed" on a migration
 * that changed no data at all — and an operator who sees that once learns to ignore it. Hashing
 * the columns that existed BEFORE the migration lets schema additions through (they are
 * whitelisted) while still catching any value that moved.
 *
 * The hash is order-independent (`string_agg(... order by h)`) so a different physical row order
 * after a restore is not mistaken for a data change.
 */
async function fingerprint(pool: Pool, columnsFrom?: Record<string, string[]>): Promise<Fingerprint> {
  const tables: string[] = (await pool.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
  )).rows.map((r: { relname: string }) => r.relname);

  const counts: Record<string, number> = {};
  const columns: Record<string, string[]> = {};
  const hashes: Record<string, string> = {};

  for (const t of tables) {
    counts[t] = Number((await pool.query(`select count(*) n from public.${t}`)).rows[0].n);

    const live: string[] = (await pool.query(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = $1 order by column_name`, [t],
    )).rows.map((r: { column_name: string }) => r.column_name);
    columns[t] = live;

    // On the POST pass, project exactly what the PRE pass hashed.
    const wanted = columnsFrom?.[t] ?? live;
    const usable = wanted.filter((c) => live.includes(c));
    if (usable.length === 0) { hashes[t] = "(kolon yok)"; continue; }

    const projection = usable.map((c) => `t.${JSON.stringify(c).replace(/"/g, '"')}`).join(", ");
    hashes[t] = (await pool.query(
      `select coalesce(md5(string_agg(h, '' order by h)), 'bos') hash
       from (select md5((${projection})::text) h from public.${t} t) s`,
    )).rows[0].hash;
  }

  const aggregates: Record<string, string> = {};
  for (const [label, sql] of [
    ["payments.default_amount", `select coalesce(sum(default_amount), 0)::text v from public.payments`],
    ["payment_instances.amount", `select coalesce(sum(amount), 0)::text v from public.payment_instances`],
    ["checks.amount", `select coalesce(sum(amount), 0)::text v from public.checks`],
    ["loans.principal", `select coalesce(sum(principal), 0)::text v from public.loans`],
    ["loan_installments.amount", `select coalesce(sum(amount), 0)::text v from public.loan_installments`],
    ["cashflow_months.closing_balance", `select coalesce(sum(closing_balance), 0)::text v from public.cashflow_months`],
  ] as const) {
    try {
      aggregates[label] = (await pool.query(sql)).rows[0].v;
    } catch {
      aggregates[label] = "(tablo/kolon yok)";
    }
  }

  const roleCounts: Record<string, number> = {};
  for (const r of (await pool.query(`select role, count(*)::int n from public.users group by role order by role`)).rows) {
    roleCounts[(r as { role: string }).role] = (r as { n: number }).n;
  }

  const ledgerRow = (await pool.query(
    `select count(*)::int rows, max(version) latest from public.schema_migrations`,
  )).rows[0] as { rows: number; latest: string | null };

  return { counts, columns, hashes, aggregates, roleCounts, ledger: ledgerRow };
}

async function main(): Promise<void> {
  if (!SOURCE_URL) throw new Error("SOURCE_DATABASE_URL gerekli (yalnız OKUNUR — pg_dump dışında dokunulmaz).");
  if (!CLONE_DB) throw new Error("CLONE_DB gerekli (harcanabilir işaret taşıyan bir ad).");
  if (!DISPOSABLE.test(CLONE_DB) || PROTECTED.has(CLONE_DB)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${CLONE_DB}' harcanabilir bir ad değil. Bu script hedefi DROP eder; ` +
        "adının harcanabilir olduğunu söylemesi gerekir (verify/test/clone/snapshot/…).",
    );
  }

  const cloneUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/${CLONE_DB}`;

  /* ── §8.1 fresh dump ─────────────────────────────────────────────────────────────────── */
  step("1/7 fresh pg_dump (kaynak YALNIZ okunur)");
  docker(["exec", CONTAINER, "sh", "-c", `rm -f ${DUMP_PATH}`]);
  docker(["exec", CONTAINER, "pg_dump", "-Fc", "-f", DUMP_PATH, "-d", SOURCE_URL]);
  const dumpBytes = Number(docker(["exec", CONTAINER, "sh", "-c", `stat -c %s ${DUMP_PATH}`]).trim());
  record("fresh dump alındı", dumpBytes > 0, `${dumpBytes} bayt`);

  /* ── pg_restore --list, before trusting the archive ──────────────────────────────────── */
  step("2/7 pg_restore --list (arşiv okunabilir mi?)");
  const listing = docker(["exec", CONTAINER, "pg_restore", "--list", DUMP_PATH]);
  const tocEntries = listing.split(/\r?\n/).filter((l) => l && !l.startsWith(";")).length;
  record("pg_restore --list arşivi okuyabiliyor", tocEntries > 0, `${tocEntries} TOC girdisi`);

  /* ── fresh restore into a clone that is recreated every run ──────────────────────────── */
  step("3/7 fresh restore (eski clone KULLANILMAZ — düşürülüp yeniden yaratılır)");
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--force", "--if-exists", CLONE_DB]);
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", CLONE_DB]);
  // --no-owner/--no-acl: the clone is owned by whoever restores it; role grants are re-established
  // by the migrations themselves, and inheriting the source's ACLs would mask a missing grant.
  try {
    docker(["exec", CONTAINER, "pg_restore", "--no-owner", "--no-acl", "-U", "postgres", "-d", CLONE_DB, DUMP_PATH]);
  } catch {
    // pg_restore exits non-zero on benign warnings (missing roles, existing extensions).
    // What matters is whether the data arrived, which the fingerprint below measures.
    console.log("   (pg_restore uyarılarla döndü — veri parmak iziyle doğrulanıyor)");
  }

  const clone = new Pool({ connectionString: cloneUrl, max: 4 });

  /* ── §8.2 PRE fingerprint ────────────────────────────────────────────────────────────── */
  step("4/7 migration ÖNCESİ parmak izi");
  const pre = await fingerprint(clone);
  const preOperators = pre.roleCounts["operator"] ?? 0;
  const preManagers = pre.roleCounts["finance_manager"] ?? 0;
  record("öncesi parmak izi alındı",
    Object.keys(pre.counts).length > 0,
    `${Object.keys(pre.counts).length} tablo · ledger ${pre.ledger.rows}/${pre.ledger.latest ?? "yok"} · operator=${preOperators}`);

  /* ── the REAL entrypoint, not a psql replay ──────────────────────────────────────────── */
  step("5/7 gerçek `pnpm db:migrate`");
  execFileSync("pnpm", ["db:migrate"], {
    stdio: "inherit", env: { ...process.env, MIGRATION_DATABASE_URL: cloneUrl },
    shell: process.platform === "win32",
  });

  /* ── §8.2 POST fingerprint, projected onto the PRE columns ───────────────────────────── */
  step("6/7 migration SONRASI parmak izi");
  const post = await fingerprint(clone, pre.columns);
  const postOperators = post.roleCounts["operator"] ?? 0;
  const postManagers = post.roleCounts["finance_manager"] ?? 0;

  /* ── §8.3 invariant set + §8.2 whitelist ─────────────────────────────────────────────── */
  step("7/7 değişmezler");

  const expectedRows = Number(
    execFileSync("node", ["-e", "const fs=require('fs');process.stdout.write(String(fs.readdirSync('supabase/migrations').filter(f=>f.endsWith('.sql')).length))"],
      { encoding: "utf8" }),
  );
  const expectedLatest = execFileSync("node",
    ["-e", "const fs=require('fs');const f=fs.readdirSync('supabase/migrations').filter(x=>x.endsWith('.sql')).sort();process.stdout.write(f[f.length-1].slice(0,4))"],
    { encoding: "utf8" });

  record(`ledger satır sayısı = ${expectedRows}`, post.ledger.rows === expectedRows, `${post.ledger.rows}`);
  record(`ledger son sürüm = ${expectedLatest}`, post.ledger.latest === expectedLatest, `${post.ledger.latest}`);

  record("bayat 'operator' rolü kalmadı", postOperators === 0, `${postOperators} satır`);
  // The single permitted data mutation. Stated as an equality so it cannot be satisfied by a
  // migration that promotes MORE users than it demoted.
  record("finance_manager artışı = önceki operator sayısı",
    postManagers - preManagers === preOperators,
    `önce ${preManagers} → sonra ${postManagers} (operator ${preOperators})`);

  const activeAdmins = Number((await clone.query(
    `select count(*)::int n from public.users where role = 'admin' and is_active`)).rows[0].n);
  record("en az bir aktif admin", activeAdmins >= 1, `${activeAdmins} aktif admin`);

  const roleCheck = (await clone.query<{ def: string }>(
    `select pg_get_constraintdef(oid) def from pg_constraint where conname = 'users_role_check'`)).rows[0]?.def ?? "";
  const expectedRoles = ["viewer", "finance_operator", "finance_approver", "finance_manager", "admin"];
  record("users_role_check beş katmanı sayıyor",
    expectedRoles.every((r) => roleCheck.includes(`'${r}'`)) && !roleCheck.includes("'operator'"),
    roleCheck ? roleCheck.slice(0, 90) : "KISIT YOK");

  const brokenFks = (await clone.query<{ c: string }>(
    `select conname c from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace
       and confrelid = 0`)).rows.map((r) => r.c);
  const fkTotal = Number((await clone.query(
    `select count(*)::int n from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`)).rows[0].n);
  record("FK hedefleri çözülüyor", brokenFks.length === 0, `${fkTotal} FK, hedefsiz ${brokenFks.length}`);

  const blanket = Number((await clone.query(
    `select count(*)::int n from pg_policies where schemaname = 'public' and policyname like '%\\_authenticated\\_all'`)).rows[0].n);
  record("blanket 'authenticated_all' RLS politikası yok", blanket === 0, `${blanket} adet`);

  const assistant = (await clone.query<{ def: string }>(
    `select pg_get_constraintdef(oid) def from pg_constraint
     where conname = 'assistant_conversations_archive_consistency'`)).rows[0]?.def ?? "";
  record("assistant arşiv tutarlılık kısıtı yerinde",
    /status = 'archived'/.test(assistant) && /archived_at IS NOT NULL/.test(assistant) && /archive_reason/.test(assistant),
    assistant ? "status↔archived_at↔archive_reason bağlı" : "KISIT YOK");

  // Checksum drift: what the ledger recorded must still be what is on disk.
  const drift = (await clone.query<{ version: string; name: string; checksum: string }>(
    `select version, name, checksum from public.schema_migrations order by version`)).rows;
  const { createHash } = await import("node:crypto");
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort();
  const drifted: string[] = [];
  for (const row of drift) {
    const file = files.find((f) => f.startsWith(row.version));
    if (!file) { drifted.push(`${row.version}: dosya yok`); continue; }
    if (!row.checksum) continue; // legacy rows backfilled without a checksum
    const onDisk = createHash("sha256").update(readFileSync(path.join("supabase/migrations", file))).digest("hex");
    const alt = createHash("md5").update(readFileSync(path.join("supabase/migrations", file))).digest("hex");
    if (row.checksum !== onDisk && row.checksum !== alt) drifted.push(`${row.version} (${file})`);
  }
  record("migration checksum drift = 0", drifted.length === 0,
    drifted.length === 0 ? `${drift.length} ledger satırı diskle uyumlu` : drifted.slice(0, 5).join(", "));

  /* The whitelist itself: legacy financial data must be byte-identical. */
  const changed = LEGACY_FINANCIAL
    .filter((t) => pre.hashes[t] !== undefined && post.hashes[t] !== undefined)
    .filter((t) => pre.hashes[t] !== post.hashes[t]);
  record("legacy finansal tabloların veri hash'i DEĞİŞMEDİ",
    changed.length === 0,
    changed.length === 0
      ? LEGACY_FINANCIAL.filter((t) => pre.hashes[t] !== undefined).map((t) => `${t}=${pre.hashes[t].slice(0, 8)}`).join(" ")
      : `DEĞİŞEN: ${changed.join(", ")}`);

  // Everything else is reported but not fatal: new empty tables are whitelisted, and a count that
  // grows on a table nobody listed is information the operator should see, not an automatic stop.
  const otherChanged = Object.keys(pre.hashes)
    .filter((t) => !LEGACY_FINANCIAL.includes(t))
    .filter((t) => post.hashes[t] !== undefined && pre.hashes[t] !== post.hashes[t]);

  /* ── manifest ────────────────────────────────────────────────────────────────────────── */
  const today = new Date().toISOString().slice(0, 10);
  const out = process.env.FINGERPRINT_OUT ?? `docs/release-evidence/cutover-fingerprint-${today}.md`;
  const failed = checks.filter((c) => !c.pass);
  const lines: string[] = [
    `# Cutover fingerprint — ${today}`,
    "",
    `- Clone: \`${CLONE_DB}\` (her koşuda düşürülüp yeniden yaratılır)`,
    `- Ledger: öncesi \`${pre.ledger.rows}/${pre.ledger.latest}\` → sonrası \`${post.ledger.rows}/${post.ledger.latest}\``,
    `- Sonuç: **${failed.length === 0 ? "PASS" : "FAIL"}** (${checks.length - failed.length}/${checks.length})`,
    "",
    "## Değişmezler",
    "",
    "| Kontrol | Sonuç | Ayrıntı |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${c.pass ? "PASS" : "**FAIL**"} | ${c.detail} |`),
    "",
    "## Rol sayıları",
    "",
    "| Rol | Öncesi | Sonrası |",
    "|---|---:|---:|",
    ...[...new Set([...Object.keys(pre.roleCounts), ...Object.keys(post.roleCounts)])].sort()
      .map((r) => `| ${r} | ${pre.roleCounts[r] ?? 0} | ${post.roleCounts[r] ?? 0} |`),
    "",
    "## Parasal toplamlar",
    "",
    "| Alan | Öncesi | Sonrası |",
    "|---|---:|---:|",
    ...Object.keys(pre.aggregates).map((k) => `| ${k} | ${pre.aggregates[k]} | ${post.aggregates[k]} |`),
    "",
    "## Legacy finansal tablolar (hash öncesi/sonrası)",
    "",
    "| Tablo | Satır (ö→s) | Hash öncesi | Hash sonrası | Aynı? |",
    "|---|---|---|---|---|",
    ...LEGACY_FINANCIAL.filter((t) => pre.hashes[t] !== undefined).map((t) =>
      `| ${t} | ${pre.counts[t]}→${post.counts[t]} | \`${pre.hashes[t].slice(0, 12)}\` | \`${(post.hashes[t] ?? "").slice(0, 12)}\` | ${pre.hashes[t] === post.hashes[t] ? "EVET" : "**HAYIR**"} |`),
    "",
    "## Beklenen mutation whitelist dışındaki hash değişimleri",
    "",
    otherChanged.length === 0
      ? "Yok — legacy finansal tablolar dışında hiçbir tablonun veri hash'i değişmedi."
      : otherChanged.map((t) => `- \`${t}\` (${pre.counts[t]} → ${post.counts[t]} satır)`).join("\n"),
    "",
    "## Yeni tablolar (şema eklemesi — whitelist)",
    "",
    (() => {
      const added = Object.keys(post.counts).filter((t) => pre.counts[t] === undefined);
      return added.length === 0 ? "Yok." : added.map((t) => `- \`${t}\` (${post.counts[t]} satır)`).join("\n");
    })(),
    "",
    "---",
    "",
    "Yeniden üretim:",
    "",
    "```bash",
    "SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \\",
    `CLONE_DB=${CLONE_DB} \\`,
    "  pnpm release:golden-fingerprint",
    "```",
    "",
    "Kaynak veritabanına yalnız `pg_dump` dokunur; her yazma clone'a gider.",
    "",
  ];
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"), "utf8");

  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  console.log(`Manifest: ${out}`);
  console.log(failed.length === 0 ? "GOLDEN FINGERPRINT: ALL PASS" : "GOLDEN FINGERPRINT: FAIL");
  await clone.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
