// Faz 6 — the restore drill. "Backup alındı" is not a claim anybody should accept.
//
// WHAT THIS ANSWERS THAT A BACKUP JOB DOES NOT.
//
// A backup file existing proves one thing: a file exists. The questions that decide whether a bad
// morning is survivable are further down the chain, and each one has to be asked out loud:
//
//   BACKUP EXISTS            a dump was produced, with a size and a checksum
//   BACKUP READABLE          pg_restore can parse the archive — not just `ls` it
//   BACKUP RESTORABLE        it actually loads into an empty database
//   RESTORED DATA MATCHES    counts, aggregates and row hashes equal the source
//   APP CAN START ON RESTORE the application boots against it and critical screens render
//
// The last one is the one that gets skipped, and it is the one that matters. A restore that
// satisfies the database and then fails the application — a missing role, a grant that did not
// survive, an extension nobody remembered — is indistinguishable from a good restore until the
// morning you need it. So this drill does not stop at row counts; it builds the app, starts it
// against the restored copy as the low-privilege runtime role, and runs a critical smoke suite.
//
// REUSES, DOES NOT REINVENT. The dump/restore/fingerprint machinery is Faz 5's
// (scripts/release/lib/fingerprint.ts). This file adds the receipts and the application phase.
//
// Usage:
//   SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \
//   RESTORE_DB=mas_radar_restore_drill \
//     pnpm release:restore-drill
//
// Optional: MAS_PG_CONTAINER, MAS_PG_PORT, SOURCE_HOST_DATABASE_URL, SMOKE_PORT (3250),
//           SMOKE_SPEC, SKIP_APP_SMOKE=1, RECEIPT_OUT, MAS_NEXT_DIST_DIR,
//           RESTORE_DRILL_SKIP_BUILD=1
//
// ── AŞAMA 11 DÜZELTMESİ: bu drill CANLI ÖRNEĞİ İKİ AYRI YOLDAN DÜŞÜREBİLİYORDU ────────────
//
// 1. `pnpm db:app-role:password`. Adım 5 runtime kimliğini yeniden kurmak için onu çağırıyordu.
//    O script `alter role mas_radar_app password …` çalıştırır ve PostgreSQL'de ROLLER KÜME
//    GENELİNDEDİR — hedef veritabanı ne olursa olsun parola bütün veritabanları için değişir.
//    Port 3000'de çalışan üretim örneğinin `.env.local` parolası o anda geçersizleşir ve
//    uygulama düşer. Drill'in kendisi bir kesinti üretemez.
//
//    Doğrusu, `scripts/db/app-url.ts`'in `real-clone-gate` için yazılan deseni: canlı runtime
//    kimliğini `.env.local`'den al, YALNIZ veritabanı adını değiştir, hiçbir dizeyi yazdırma.
//    Bu aynı zamanda DAHA GÜÇLÜ bir test — sentetik bir parolayla değil, uygulamanın gerçekten
//    kullandığı kimlikle bağlanılır, dolayısıyla "restore edilen kopyada GRANT'lar geri geldi mi"
//    sorusu gerçek rol üzerinden cevaplanır.
//
// 2. `pnpm build`. Varsayılan `distDir` `.next`'tir ve drill onu ezerek çalışan üretim
//    sunucusunun derlemesini bozuyordu. `next.config.ts` `MAS_NEXT_DIST_DIR`'i onurlandırıyor;
//    drill artık kendi dizinini kullanır (varsayılan `.next-restore-drill`).
//
// `MAS_RADAR_APP_DB_PASSWORD` hâlâ okunur ama artık YALNIZ `.env.local` yoksa (CI) devreye giren
// bir yedek koldur; parola sıfırlama yolu tamamen kaldırılmıştır.
//
// TWO VANTAGE POINTS AGAIN (same trap as golden-fingerprint.ts): SOURCE_DATABASE_URL is read by
// pg_dump INSIDE the container; SOURCE_HOST_DATABASE_URL is read by this process on the HOST when
// it fingerprints the source. They are the same string on the standard single-container setup and
// diverge on a sandbox published to another port — which is exactly when connecting to the wrong
// database would be most expensive.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { fingerprint, type Fingerprint } from "./lib/fingerprint";
import { isDisposableDatabaseName } from "../db/owner-url";
import { portInUse, readEnvLocal, swapDatabase } from "../db/app-url";

const CONTAINER = process.env.MAS_PG_CONTAINER ?? "mas-radar-pg";
const PORT = process.env.MAS_PG_PORT ?? "5432";
const SOURCE_URL = process.env.SOURCE_DATABASE_URL ?? "";
const SOURCE_HOST_URL = process.env.SOURCE_HOST_DATABASE_URL ?? SOURCE_URL;
const RESTORE_DB = process.env.RESTORE_DB ?? "";
const SMOKE_PORT = process.env.SMOKE_PORT ?? "3250";
const SMOKE_SPEC = process.env.SMOKE_SPEC ?? "tests/visual/golden-ui-smoke.spec.ts";
const BACKUP_PATH = "/tmp/mas_restore_drill.dump";
/** Canlı `.next` ASLA ezilmez — next.config.ts bu değişkeni onurlandırır. */
const DIST_DIR = process.env.MAS_NEXT_DIST_DIR ?? ".next-restore-drill";
const SKIP_BUILD = process.env.RESTORE_DRILL_SKIP_BUILD === "1";

/**
 * Restore edilen kopyaya bağlanacak GERÇEK runtime kimliği.
 *
 * `.env.local`'deki canlı `DATABASE_URL` alınır ve YALNIZ veritabanı adı hedefle değiştirilir.
 * Parola sıfırlanmaz (bkz. dosya başlığı, 1. madde) ve dize hiçbir kolda yazdırılmaz.
 * `.env.local` yoksa (CI) eski davranışın parolası bir yedek kol olarak kullanılır.
 */
function appUrlForRestore(db: string): { url: string; origin: string } {
  try {
    const runtime = readEnvLocal()["DATABASE_URL"];
    if (runtime) return { url: swapDatabase(runtime, db), origin: ".env.local runtime kimliği (parola SIFIRLANMADI)" };
  } catch {
    /* .env.local yok — aşağıdaki yedek kola düşülür. */
  }
  const password = process.env.MAS_RADAR_APP_DB_PASSWORD ?? "ci-only-not-a-secret-0123456789";
  return {
    url: `postgres://mas_radar_app:${password}@127.0.0.1:${PORT}/${db}`,
    origin: "MAS_RADAR_APP_DB_PASSWORD yedek kolu (.env.local yok)",
  };
}

interface Check { name: string; pass: boolean; detail: string }

const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

/** The five headline gates, answered YES only by the evidence below them. */

const gates: Record<string, boolean> = {
  "BACKUP EXISTS": false,
  "BACKUP READABLE": false,
  "BACKUP RESTORABLE": false,
  "RESTORED DATA MATCHES": false,
  "APP CAN START ON RESTORE": false,
};

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}`);
}

function sh(cmd: string): string {
  return docker(["exec", CONTAINER, "sh", "-c", cmd]);
}

async function main(): Promise<void> {
  if (!SOURCE_URL) throw new Error("SOURCE_DATABASE_URL gerekli (yalnız OKUNUR).");
  if (!RESTORE_DB) throw new Error("RESTORE_DB gerekli (harcanabilir işaret taşıyan bir ad).");
  if (!isDisposableDatabaseName(RESTORE_DB)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${RESTORE_DB}' harcanabilir bir ad değil. Bu script hedefi DROP eder.`,
    );
  }

  if (process.env.SKIP_APP_SMOKE !== "1" && (await portInUse(SMOKE_PORT))) {
    throw new Error(
      `Port ${SMOKE_PORT} zaten dinleniyor. Drill başkasının sunucusuyla yarışmaz ve onu ÖLDÜRMEZ; ` +
        "SMOKE_PORT ile boş bir port verin.",
    );
  }

  const restoreUrl = `postgres://postgres:postgres@127.0.0.1:${PORT}/${RESTORE_DB}`;
  const app = appUrlForRestore(RESTORE_DB);
  const appUrl = app.url;

  /* ── 9.1 backup + receipt ────────────────────────────────────────────────────────────── */

  step("1/6 backup al ve makbuzunu çıkar");
  sh(`rm -f ${BACKUP_PATH}`);
  docker(["exec", CONTAINER, "pg_dump", "-Fc", "-f", BACKUP_PATH, "-d", SOURCE_URL]);

  const fileSize = Number(sh(`stat -c %s ${BACKUP_PATH}`).trim());
  const sha256 = sh(`sha256sum ${BACKUP_PATH}`).trim().split(/\s+/)[0];
  const pgDumpVersion = docker(["exec", CONTAINER, "pg_dump", "--version"]).trim();
  const source = new Pool({ connectionString: SOURCE_HOST_URL, max: 4 });
  const srcMeta = (await source.query<{ db: string; sysid: string; ver: string }>(
    `select current_database() db,
            (select system_identifier::text from pg_control_system()) sysid,
            version() ver`)).rows[0];
  const srcLedger = (await source.query<{ rows: number; latest: string | null }>(
    `select count(*)::int rows, max(version) latest from public.schema_migrations`)).rows[0];
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const backupReceipt = {
    timestamp: new Date().toISOString(),
    source_db: srcMeta.db,
    system_identifier: srcMeta.sysid,
    git_sha: gitSha,
    schema_ledger: `${srcLedger.rows}/${srcLedger.latest ?? "yok"}`,
    file_size: fileSize,
    sha256,
    pg_version: srcMeta.ver.split(" ").slice(0, 2).join(" "),
    pg_dump_version: pgDumpVersion,
  };

  gates["BACKUP EXISTS"] = fileSize > 0 && sha256.length === 64;

  record("BACKUP EXISTS — dosya var, boyutu ve sha256'sı ölçüldü",

    gates["BACKUP EXISTS"], `${fileSize} bayt · sha256 ${sha256.slice(0, 16)}…`);

  /* ── readable ────────────────────────────────────────────────────────────────────────── */

  step("2/6 arşiv okunabilir mi (pg_restore --list)");

  const toc = docker(["exec", CONTAINER, "pg_restore", "--list", BACKUP_PATH])
    .split(/\r?\n/).filter((l) => l && !l.startsWith(";")).length;

  gates["BACKUP READABLE"] = toc > 0;

  record("BACKUP READABLE — pg_restore arşivi ayrıştırabiliyor", gates["BACKUP READABLE"], `${toc} TOC girdisi`);

  /* ── 9.3 drop → create → restore, into a SEPARATE database ───────────────────────────── */

  step("3/6 ayrı bir veritabanına restore (hedef her koşuda düşürülür)");
  docker(["exec", CONTAINER, "dropdb", "-U", "postgres", "--force", "--if-exists", RESTORE_DB]);
  docker(["exec", CONTAINER, "createdb", "-U", "postgres", RESTORE_DB]);

  let restoreWarned = false;
  try {
    // `--no-owner` YES, `--no-acl` NO — and the difference is the whole point of this drill.
    //
    // The first version of this script used both, copying golden-fingerprint.ts. The database
    // restored perfectly: 85 tables, every count, aggregate and row hash identical to the source.
    // Then the application refused to boot:
    //
    //     Çalışma zamanı hazırlığı başarısız: error: permission denied for table users
    //
    // `--no-acl` discards the GRANT statements, so `mas_radar_app` came back with no privileges on
    // anything. Measured side by side on the same archive:
    //
    //     with ACL : app SELECT users = true   INSERT users = true   SELECT payments = true
    //     --no-acl : app SELECT users = false  INSERT users = false  SELECT payments = false
    //
    // In golden-fingerprint.ts dropping ACLs is defensible: that clone is only ever touched by the
    // owner, and inheriting stale grants could mask a missing one. In a RESTORE, the grants ARE
    // part of what must come back — a recovery that leaves the application locked out has not
    // recovered anything. This is exactly the failure a row-count-only restore check never sees.
    docker(["exec", CONTAINER, "pg_restore", "--no-owner", "-U", "postgres", "-d", RESTORE_DB, BACKUP_PATH]);
  } catch {
    // pg_restore exits non-zero on benign warnings (absent roles, pre-existing extensions). Whether
    // the restore actually worked is decided by the comparison below, not by this exit code.
    restoreWarned = true;
  }

  const restored = new Pool({ connectionString: restoreUrl, max: 4 });
  const restoredTables = Number((await restored.query(
    `select count(*)::int n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'r'`)).rows[0].n);

  gates["BACKUP RESTORABLE"] = restoredTables > 0;

  record("BACKUP RESTORABLE — arşiv boş bir veritabanına yüklendi",

    gates["BACKUP RESTORABLE"], `${restoredTables} tablo${restoreWarned ? " (pg_restore uyarılarla döndü)" : ""}`);

  /* ── 9.2 counts / aggregates / hashes must match the source ──────────────────────────── */

  step("4/6 restore edilen veri kaynakla aynı mı");

  const srcFp: Fingerprint = await fingerprint(source);
  const dstFp: Fingerprint = await fingerprint(restored, srcFp.columns);
  const countDiff = Object.keys(srcFp.counts).filter((t) => srcFp.counts[t] !== dstFp.counts[t]);
  const aggDiff = Object.keys(srcFp.aggregates).filter((k) => srcFp.aggregates[k] !== dstFp.aggregates[k]);
  const hashDiff = Object.keys(srcFp.hashes).filter((t) => dstFp.hashes[t] !== undefined && srcFp.hashes[t] !== dstFp.hashes[t]);

  record("satır sayıları eşleşiyor", countDiff.length === 0,
    countDiff.length === 0 ? `${Object.keys(srcFp.counts).length} tablo` : `farklı: ${countDiff.slice(0, 6).join(", ")}`);

  record("parasal toplamlar eşleşiyor", aggDiff.length === 0,
    aggDiff.length === 0 ? Object.keys(srcFp.aggregates).length + " toplam" : `farklı: ${aggDiff.join(", ")}`);

  record("satır hash'leri eşleşiyor", hashDiff.length === 0,
    hashDiff.length === 0 ? `${Object.keys(srcFp.hashes).length} tablo` : `farklı: ${hashDiff.slice(0, 6).join(", ")}`);
  // §9.2 item 5: a read that needs no login — the owner connection, straight at the data.

  const ownerRead = Number((await restored.query(`select count(*)::int n from public.payments`)).rows[0].n);

  record("owner ile login gerekmeyen okuma testi", ownerRead === srcFp.counts["payments"],
    `payments=${ownerRead} (kaynak ${srcFp.counts["payments"]})`);

  gates["RESTORED DATA MATCHES"] =
    countDiff.length === 0 && aggDiff.length === 0 && hashDiff.length === 0 && ownerRead === srcFp.counts["payments"];

  const restoreReceipt = {
    timestamp: new Date().toISOString(),
    restored_into: RESTORE_DB,
    from_backup_sha256: sha256,
    tables: restoredTables,
    schema_ledger: `${dstFp.ledger.rows}/${dstFp.ledger.latest ?? "yok"}`,
    counts_match: countDiff.length === 0,
    aggregates_match: aggDiff.length === 0,
    hashes_match: hashDiff.length === 0,
    owner_read_rows: ownerRead,
  };

  /* ── 9.3 the part everyone skips: can the APPLICATION use it ─────────────────────────── */

  let smokeDetail = "atlandı (SKIP_APP_SMOKE=1)";
  if (process.env.SKIP_APP_SMOKE === "1") {

    record("APP CAN START ON RESTORE — atlandı", false, smokeDetail);
  } else {

    step("5/6 uygulamayı restore edilen veritabanına karşı başlat");
    // AŞAMA 11: runtime kimliği YENİDEN KURULMAZ, MEVCUT OLANI KULLANILIR.
    //
    // Eskiden burada `pnpm db:app-role:password` çağrılıyordu. Roller PostgreSQL'de küme
    // genelinde olduğu için o çağrı canlı üretim örneğinin parolasını da değiştiriyor ve
    // port 3000'deki uygulamayı düşürüyordu. Restore artık `--no-acl` KULLANMADIĞI için
    // GRANT'lar arşivin parçası olarak geri geliyor; sorulacak doğru soru "yeni bir parola
    // koyabiliyor muyum" değil, "GERÇEK runtime kimliği bu kopyada çalışıyor mu"dur.
    console.log(`   runtime kimliği kaynağı: ${app.origin}`);
    execFileSync("pnpm", ["exec", "tsx", "scripts/db/seed-system-actor.ts"], {
      stdio: "inherit", shell: process.platform === "win32",
      env: { ...process.env, MIGRATION_DATABASE_URL: restoreUrl },
    });
    if (SKIP_BUILD) {
      console.log(`   derleme atlandı (RESTORE_DRILL_SKIP_BUILD=1) — mevcut '${DIST_DIR}' kullanılıyor`);
    } else {
      // `next build` özel bir distDir için tsconfig.json'ı yeniden yazar (real-clone-gate'te
      // ölçüldü). Release commit'ine build aracı gürültüsü girmesin diye dosya birebir geri alınır.
      const tsconfigPath = path.join(process.cwd(), "tsconfig.json");
      const tsconfigBefore = readFileSync(tsconfigPath, "utf8");
      execFileSync("pnpm", ["build"], {
        stdio: "inherit", shell: process.platform === "win32",
        env: { ...process.env, DATABASE_URL: appUrl, APP_COMMIT_SHA: gitSha, MAS_NEXT_DIST_DIR: DIST_DIR },
      });
      if (readFileSync(tsconfigPath, "utf8") !== tsconfigBefore) {
        writeFileSync(tsconfigPath, tsconfigBefore, "utf8");
        console.log("   (next build tsconfig.json'ı yeniden yazdı; dosya geri alındı)");
      }
    }
    // Server output goes to a file, not /dev/null. The first run of this drill failed with
    // "sunucu hazır olmadı" and nothing else, because stdio was discarded — the actual cause
    // ("permission denied for table users") was sitting in output nobody kept. A drill that
    // cannot say WHY it failed is only half a drill.

    const serverLog = path.join("test-results", "restore-drill-server.log");
    mkdirSync(path.dirname(serverLog), { recursive: true });

    const logFd = openSync(serverLog, "w");

    const server = spawn("pnpm", ["start"], {
      stdio: ["ignore", logFd, logFd], detached: false, shell: process.platform === "win32",
      env: {
        ...process.env,
        DATABASE_URL: appUrl,
        // Ebeveyn ortamda kalmış bir owner URL'i kazanmasın diye klonun kendi owner'ına sabitlenir.
        MIGRATION_DATABASE_URL: restoreUrl,
        APP_COMMIT_SHA: gitSha,
        PORT: SMOKE_PORT,
        MAS_NEXT_DIST_DIR: DIST_DIR,
      },
    });

    const base = `http://127.0.0.1:${SMOKE_PORT}`;

    let up = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const res = await fetch(`${base}/ready`);
        if (res.ok) { up = true; break; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 2000));
    }

    let bootDetail = up ? `${base}/ready = 200` : "sunucu hazır olmadı";
    if (!up) {
      const tail = readFileSync(serverLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
      bootDetail += tail ? ` — sunucu çıktısı: ${tail.slice(0, 300)}` : " (sunucu çıktısı boş)";
    }

    record("uygulama restore edilen veritabanıyla ayağa kalktı", up, bootDetail);

    let smokeOk = false;
    if (up) {

      step("6/6 kritik smoke (restore edilen veriye karşı)");
      try {
        execFileSync("pnpm", ["exec", "playwright", "test", SMOKE_SPEC], {
          stdio: "inherit", shell: process.platform === "win32",
          env: {
            ...process.env, BASE_URL: base,
            MAS_E2E_DATABASE_URL: appUrl, MAS_E2E_OWNER_DATABASE_URL: restoreUrl,
          },
        });
        smokeOk = true;
      } catch {
        smokeOk = false;
      }
    }

    smokeDetail = smokeOk ? `${SMOKE_SPEC} geçti` : `${SMOKE_SPEC} BAŞARISIZ`;

    record("kritik smoke restore edilen veri üzerinde geçiyor", smokeOk, smokeDetail);

    gates["APP CAN START ON RESTORE"] = up && smokeOk;
    // Kill the server AND its child tree. `pnpm start` spawns `next start`; killing only the
    // wrapper leaves the port held and the next drill fails for a reason unrelated to backups.
    try {
      if (process.platform === "win32" && server.pid) {
        execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        server.kill("SIGTERM");
      }
    } catch { /* already gone */ }
  }

  /* ── receipts ────────────────────────────────────────────────────────────────────────── */

  const today = new Date().toISOString().slice(0, 10);

  const out = process.env.RECEIPT_OUT ?? `docs/release-evidence/restore-drill-${today}.md`;

  const yaml = (o: Record<string, unknown>): string =>
    Object.entries(o).map(([k, v]) => `  ${k}: ${typeof v === "string" ? `"${v}"` : String(v)}`).join("\n");

  const failed = checks.filter((c) => !c.pass);

  const allGates = Object.values(gates).every(Boolean);

  const lines = [
    `# Restore drill — ${today}`,
    "",
    "## Faz 6 PASS kapıları",
    "",
    "```text",
    ...Object.entries(gates).map(([k, v]) => `${k} = ${v ? "YES" : "NO"}`),
    "```",
    "",
    "## Backup receipt (§9.1)",
    "",
    "```yaml",
    "backup_receipt:",
    yaml(backupReceipt),
    "```",
    "",
    "## Restore receipt (§9.2)",
    "",
    "```yaml",
    "restore_receipt:",
    yaml(restoreReceipt),
    "```",
    "",
    "## Kontroller",
    "",
    "| Kontrol | Sonuç | Ayrıntı |",
    "|---|---|---|",
    ...checks.map((c) => `| ${c.name} | ${c.pass ? "PASS" : "**FAIL**"} | ${c.detail} |`),
    "",
    "## Çalışma zamanı kimliği ve derleme yalıtımı (AŞAMA 11)",
    "",
    `- Runtime kimliği: ${app.origin} — \`pnpm db:app-role:password\` **çağrılmadı**, küme genelindeki`,
    "  `mas_radar_app` parolası değişmedi, canlı örnek etkilenmedi.",
    `- Derleme dizini: \`${DIST_DIR}\`${SKIP_BUILD ? " (RESTORE_DRILL_SKIP_BUILD=1 — mevcut derleme kullanıldı)" : ""} — canlı \`.next\` ezilmedi.`,
    "",
    "---",
    "",
    "Yeniden üretim:",
    "",
    "```bash",
    "SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \\",
    `RESTORE_DB=${RESTORE_DB} \\`,
    "  pnpm release:restore-drill",
    "```",
    "",
    "Kaynağa yalnız `pg_dump` dokunur; hedef her koşuda düşürülüp yeniden yaratılır.",
    "",
  ];
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n"), "utf8");
  console.log("\n── Faz 6 kapıları ───────────────────────────────────────────────────");
  for (const [k, v] of Object.entries(gates)) console.log(`${k} = ${v ? "YES" : "NO"}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  console.log(`Makbuz: ${out}`);
  console.log(allGates && failed.length === 0 ? "RESTORE DRILL: ALL PASS" : "RESTORE DRILL: FAIL");
  await source.end();
  await restored.end();
  process.exit(allGates && failed.length === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
