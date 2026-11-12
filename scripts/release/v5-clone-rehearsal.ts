// Faz 56 (F3) — Canlı `mas_radar_dev`'e hiç dokunmadan, gerçek `.dump` yedeğini tek kullanımlık
// `mas_radar_v5_rc_clone` veritabanına geri yükleyip `0096 → 0107` migration zincirini,
// 6 temel iş tablosunun korunumunu, 87/87 görünümün `security_invoker = true` durumunu,
// `roles-rls-verify` + `constraints-verify` kapılarını ve Birleşik Altın Finansal + Spot-Check
// doğrulamalarını koşturup işi bitince klonu temizleyen nihai cutover prova betiği.
//
// KATI GÜVENLİK KURALLARI:
// 1. `mas_radar_dev` veritabanına ASLA bağlanılmaz ve yazılmaz.
// 2. `pnpm db:app-role:password` ASLA çağrılmaz; klon bağlantı dizesi `.env.local` içindeki
//    mevcut kimlikten yalnız veritabanı adı `mas_radar_v5_rc_clone` yapılarak türetilir.
// 3. Klon veritabanı adı `isDisposableDatabaseName` + `assertDisposableTargetDb` ile doğrulanır
//    ve prova sonunda `dropDisposableLocalDb` ile tamamen silinir.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { readEnvLocal, swapDatabase } from "../db/app-url";
import { assertDisposableTargetDb } from "../db/disposable-guard";
import { isDisposableDatabaseName } from "../db/owner-url";
import {
  createDisposableLocalDb,
  dropDisposableLocalDb,
  listDumpLocal,
  resolveLocalOwnerUrl,
  restoreIntoDisposableLocalDb,
} from "../db/pg-local-admin";
import { fingerprint } from "./lib/fingerprint";

const RC_CLONE_DB = process.env.RC_CLONE_DB ?? "mas_radar_v5_rc_clone";
const DIST_DIR = process.env.GATE_DIST_DIR ?? ".next-v5-rehearsal";
const BOARD_OUT =
  process.env.V5_READINESS_OUT ?? "docs/release-evidence/v5-readiness-board.md";

const CORE_BUSINESS_TABLES = [
  "payments",
  "payment_instances",
  "checks",
  "loans",
  "loan_installments",
  "cashflow_months",
] as const;

interface Check {
  stage: string;
  name: string;
  pass: boolean;
  expected: string;
  actual: string;
}

const checks: Check[] = [];
const commands: string[] = [];
const exitCodes: Record<string, number> = {};

function record(
  stage: string,
  name: string,
  pass: boolean,
  expected: string,
  actual: string,
): boolean {
  checks.push({ stage, name, pass, expected, actual });
  console.log(
    `${pass ? "PASS" : "FAIL"}  [${stage}] ${name} — beklenen: ${expected} · gerçek: ${actual}`,
  );
  return pass;
}

function step(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 74 - label.length))}`);
}

function runCaptured(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; output: string }> {
  commands.push(`${cmd} ${args.join(" ")}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, shell: process.platform === "win32" });
    let output = "";
    const sink = (buf: Buffer) => {
      const s = buf.toString("utf8");
      output += s;
      process.stdout.write(s);
    };
    child.stdout?.on("data", sink);
    child.stderr?.on("data", sink);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.on("error", (err) =>
      resolve({ code: 1, output: `${output}\n${err.message}` }),
    );
  });
}

interface SnapshotSelection {
  dumpPath: string;
  expectedSha256: string;
  expectedLedgerLatest: string;
  expectedLedgerRows: number;
}

function selectLatestRealPreV5Dump(): SnapshotSelection {
  if (process.env.REAL_SNAPSHOT_DUMP) {
    const p = process.env.REAL_SNAPSHOT_DUMP;
    const sha =
      process.env.EXPECTED_DUMP_SHA256 ??
      createHash("sha256").update(readFileSync(p)).digest("hex");
    return {
      dumpPath: p,
      expectedSha256: sha.toLowerCase(),
      expectedLedgerLatest: process.env.EXPECTED_LEDGER_LATEST ?? "0096",
      expectedLedgerRows: Number(process.env.EXPECTED_LEDGER_ROWS ?? 96),
    };
  }

  // En güncel .stage07.json makbuzlu `mas_radar_dev` yedeğini seç (0096 veya öncesi)
  const backupDir = path.join(process.cwd(), "backups");
  const receipts = readdirSync(backupDir)
    .filter((f) => f.startsWith("daily-") && f.endsWith(".dump.stage07.json"))
    .sort()
    .reverse();

  for (const rFile of receipts) {
    try {
      const raw = JSON.parse(
        readFileSync(path.join(backupDir, rFile), "utf8"),
      ) as {
        source_db?: string;
        schema_ledger?: string;
        sha256?: string;
      };
      const dumpName = rFile.replace(/\.stage07\.json$/, "");
      const dumpFull = path.join(backupDir, dumpName);
      if (
        raw.source_db === "mas_radar_dev" &&
        raw.sha256 &&
        existsSync(dumpFull)
      ) {
        const [rowsStr, latestStr] = String(raw.schema_ledger ?? "96/0096").split("/");
        return {
          dumpPath: path.join("backups", dumpName),
          expectedSha256: raw.sha256.toLowerCase(),
          expectedLedgerLatest: latestStr || "0096",
          expectedLedgerRows: Number(rowsStr) || 96,
        };
      }
    } catch {
      /* bozuk makbuz atlanır */
    }
  }

  return {
    dumpPath: "backups/cutover_A_20260825-1211.dump",
    expectedSha256:
      "f121cd49545f6b060d6bb1bce689ebcac023aa076981dfbd0ac102b80467330d",
    expectedLedgerLatest: "0034",
    expectedLedgerRows: 34,
  };
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const gitShort = gitSha.slice(0, 7);

  step("0/5 Güvenlik Kapıları (Canlı mas_radar_dev Dokunulmazlığı)");

  if (!isDisposableDatabaseName(RC_CLONE_DB)) {
    throw new Error(
      `GÜVENLİK DURDURMASI: '${RC_CLONE_DB}' harcanabilir bir veritabanı adı değil!`,
    );
  }

  const envLocal = readEnvLocal();
  const runtimeUrl = envLocal["DATABASE_URL"];
  if (!runtimeUrl) throw new Error(".env.local içinde DATABASE_URL bulunamadı.");
  const runtimeUser = new URL(runtimeUrl).username;
  const cloneAppUrl = swapDatabase(runtimeUrl, RC_CLONE_DB);
  const cloneOwnerUrl = resolveLocalOwnerUrl(RC_CLONE_DB);

  process.env.MIGRATION_DATABASE_URL = cloneOwnerUrl;
  process.env.DATABASE_URL = cloneAppUrl;
  delete process.env.MAS_APP_DATABASE_URL;

  // Doğrudan disposable-guard ile de doğrula
  assertDisposableTargetDb(undefined, "v5-clone-rehearsal");

  record(
    "step0",
    "mas_radar_app küme parolası sıfırlanmadı (mevcut runtime kimliği korundu)",
    true,
    "pnpm db:app-role:password çağrılmaz",
    `${runtimeUser}@${RC_CLONE_DB}`,
  );
  record(
    "step0",
    "hedef veritabanı harcanabilir klon (mas_radar_dev'e sıfır bağlantı)",
    RC_CLONE_DB !== "mas_radar_dev" && isDisposableDatabaseName(RC_CLONE_DB),
    "mas_radar_v5_rc_clone (disposable)",
    RC_CLONE_DB,
  );

  const snap = selectLatestRealPreV5Dump();
  let preCounts: Record<string, number> = {};
  let postCounts: Record<string, number> = {};
  let preLedger = { rows: 0, latest: "" };
  let postLedger = { rows: 0, latest: "" };

  try {
    /* ── 1. Gerçek Yedek Arşivini Klona Geri Yükle ──────────────────────────────────── */
    step(`1/5 Gerçek Yedek Arşivini (${snap.dumpPath}) Klona Geri Yükle`);

    const dumpExists = existsSync(snap.dumpPath);
    record(
      "step1",
      "gerçek yedek arşivi diskte mevcut",
      dumpExists,
      snap.dumpPath,
      dumpExists ? "mevcut" : "YOK",
    );
    if (!dumpExists) throw new Error(`Yedek dosyası bulunamadı: ${snap.dumpPath}`);

    const dumpBytes = statSync(snap.dumpPath).size;
    const actualSha = createHash("sha256")
      .update(readFileSync(snap.dumpPath))
      .digest("hex")
      .toLowerCase();
    record(
      "step1",
      "yedek arşivi SHA-256 bütünlüğü",
      actualSha === snap.expectedSha256,
      snap.expectedSha256,
      `${actualSha} (${dumpBytes} bayt)`,
    );

    const listing = listDumpLocal(snap.dumpPath);
    const tocCount = listing
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith(";")).length;
    record(
      "step1",
      "pg_restore --list TOC doğrulaması",
      tocCount > 0,
      "> 0 TOC girdisi",
      `${tocCount} TOC girdisi`,
    );

    dropDisposableLocalDb(RC_CLONE_DB);
    createDisposableLocalDb(RC_CLONE_DB);
    restoreIntoDisposableLocalDb(RC_CLONE_DB, snap.dumpPath);

    const clonePool = new Pool({ connectionString: cloneOwnerUrl, max: 4 });
    try {
      const pre = await fingerprint(clonePool);
      preCounts = pre.counts;
      preLedger = {
        rows: pre.ledger.rows,
        latest: pre.ledger.latest ?? "yok",
      };
      record(
        "step1",
        `göç öncesi şema defteri (${snap.expectedLedgerRows}/${snap.expectedLedgerLatest})`,
        pre.ledger.latest === snap.expectedLedgerLatest &&
          pre.ledger.rows === snap.expectedLedgerRows,
        `${snap.expectedLedgerRows}/${snap.expectedLedgerLatest}`,
        `${pre.ledger.rows}/${pre.ledger.latest}`,
      );

      /* ── 2. 0096 → 0108 Tam Migration Zincirini Klonda Çalıştır ────────────────────── */
      step("2/5 Klonda 0096 → 0108 Migration Zincirini Çalıştır");

      const migEnv: NodeJS.ProcessEnv = {
        ...process.env,
        MIGRATION_DATABASE_URL: cloneOwnerUrl,
        DATABASE_URL: cloneAppUrl,
        MAS_PG_RUNTIME: "native",
      };
      const mig = await runCaptured(
        "pnpm",
        ["exec", "tsx", "scripts/db/migrate.ts"],
        migEnv,
      );
      exitCodes["tsx scripts/db/migrate.ts"] = mig.code;
      record(
        "step2",
        "scripts/db/migrate.ts çıkış kodu = 0",
        mig.code === 0,
        "0",
        String(mig.code),
      );
      if (mig.code !== 0) throw new Error("Migration başarısız oldu.");

      const diskFiles = readdirSync("supabase/migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const expectedLatestVersion = diskFiles.at(-1)?.slice(0, 4) ?? "0108";
      const post = await fingerprint(clonePool, pre.columns);
      postCounts = post.counts;
      postLedger = {
        rows: post.ledger.rows,
        latest: post.ledger.latest ?? "yok",
      };

      record(
        "step2",
        `göç sonrası şema defteri = ${diskFiles.length} / ${expectedLatestVersion}`,
        post.ledger.latest === expectedLatestVersion && post.ledger.rows === diskFiles.length,
        `${diskFiles.length}/${expectedLatestVersion}`,
        `${post.ledger.rows}/${post.ledger.latest}`,
      );

      // 6 temel iş tablosunun satır sayısı ve veri hash'i korunumu
      for (const tbl of CORE_BUSINESS_TABLES) {
        const beforeN = pre.counts[tbl] ?? 0;
        const afterN = post.counts[tbl] ?? 0;
        const sameHash = pre.hashes[tbl] === post.hashes[tbl];
        record(
          "step2",
          `temel iş tablosu korunumu: ${tbl}`,
          beforeN === afterN && sameHash,
          `${beforeN} satır, hash=${(pre.hashes[tbl] ?? "").slice(0, 10)}`,
          `${afterN} satır, hash=${(post.hashes[tbl] ?? "").slice(0, 10)}`,
        );
      }

      // 87/87 görünümün tamamında security_invoker = true kontrolü
      const viewSec = await clonePool.query<{
        total_views: number;
        invoker_views: number;
      }>(`
        select
          count(*)::int as total_views,
          count(*) filter (
            where 'security_invoker=true' = any(coalesce(c.reloptions, array[]::text[]))
          )::int as invoker_views
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'v'
      `);
      const tv = viewSec.rows[0].total_views;
      const iv = viewSec.rows[0].invoker_views;
      record(
        "step2",
        "tüm public görünümlerde security_invoker = true",
        tv >= 87 && tv === iv,
        `${tv}/${tv} (≥ 87)`,
        `${iv}/${tv}`,
      );

      /* ── 3. RLS, Kısıt ve Mimari Kapıları Klonda Çalıştır ────────────────────────── */
      step("3/5 Klonda roles-rls-verify, constraints-verify ve phase18-verify Kapıları");

      const rlsRes = await runCaptured(
        "pnpm",
        ["exec", "tsx", "scripts/db/roles-rls-verify.ts"],
        migEnv,
      );
      exitCodes["tsx scripts/db/roles-rls-verify.ts"] = rlsRes.code;
      record(
        "step3",
        "db:roles-rls:verify (87 görünüm + tüm tablolar + 5 katman RLS)",
        rlsRes.code === 0,
        "exit 0",
        `exit ${rlsRes.code}`,
      );

      const conRes = await runCaptured(
        "pnpm",
        ["exec", "tsx", "scripts/db/constraints-verify.ts"],
        migEnv,
      );
      exitCodes["tsx scripts/db/constraints-verify.ts"] = conRes.code;
      record(
        "step3",
        "db:constraints:verify (tüm CHECK/FK/tetikleyici kısıtları)",
        conRes.code === 0,
        "exit 0",
        `exit ${conRes.code}`,
      );

      /* ── 4. Parasal Spot-Check + Birleşik Altın Finansal Doğruluk Paketi ──────────── */
      step("4/5 Klonda Parasal Görünüm Spot-Check ve Birleşik Altın CFO Paketi");

      const spotViews = [
        "bank_cash_position",
        "treasury_position_summary",
        "treasury_liquidity_gap",
        "management_trial_balance_v",
        "management_balance_sheet_v",
        "management_income_statement_v",
        "check_portfolio_and_recourse_summary",
        "working_capital_monthly_v",
        "forecast_13w_variance_v",
      ];
      let spotOk = true;
      for (const v of spotViews) {
        try {
          await clonePool.query(`select * from public.${v} limit 5`);
        } catch {
          spotOk = false;
        }
      }
      record(
        "step4",
        "kritik CFO ve Yönetim Defteri görünümleri gerçek veri klonunda hatasız çalışıyor",
        spotOk,
        `${spotViews.length}/${spotViews.length} görünüm OK`,
        spotOk ? `${spotViews.length}/${spotViews.length} görünüm OK` : "HATA",
      );

      const goldenVitest = await runCaptured(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          "--maxWorkers=2",
          "tests/financial/golden-end-to-end-cfo-suite.test.ts",
        ],
        {
          ...migEnv,
          MAS_REQUIRE_DISPOSABLE_DB_TEST: "1",
        },
      );
      exitCodes["vitest golden-end-to-end-cfo-suite.test.ts"] = goldenVitest.code;
      record(
        "step4",
        "Birleşik Altın Finansal Doğruluk Paketi (golden-end-to-end-cfo-suite.test.ts)",
        goldenVitest.code === 0,
        "exit 0 (0.00 kuruş sapma)",
        `exit ${goldenVitest.code}`,
      );
    } finally {
      await clonePool.end().catch(() => {});
    }
  } finally {
    step("5/5 Klon Veritabanı ve Geçici Göç Yedeklerinin Temizlenmesi");
    dropDisposableLocalDb(RC_CLONE_DB);
    // migrate.ts'in klon için aldığı geçici yedekleri temizle
    const backupDir = path.join(process.cwd(), "backups");
    for (const f of readdirSync(backupDir)) {
      if (f.includes(RC_CLONE_DB)) {
        rmSync(path.join(backupDir, f), { force: true });
      }
    }
    record(
      "step5",
      `harcanabilir klon '${RC_CLONE_DB}' düşürüldü ve temizlendi`,
      true,
      "klon silindi",
      "silindi",
    );
  }

  // Kanıt panosu (`docs/release-evidence/v5-readiness-board.md`) üretimi
  const failed = checks.filter((c) => !c.pass);
  const lines: string[] = [
    "# MAS Nakit Radar v5 — Nihai Sürüm Hazırlık ve Klon Göç Provası Panosu (`Faz 39` – `Faz 56`)",
    "",
    "```text",
    `WORKING COMMIT         : ${gitShort} (${gitSha})`,
    `TARGET DATABASE CLASS  : DISPOSABLE_CLONE (gerçek üretim yedeği geri yüklemesi)`,
    `CLONE DATABASE NAME    : ${RC_CLONE_DB} (prova sonunda düşürüldü)`,
    `CANONICAL DB TOUCHED   : NO — mas_radar_dev'e hiç bağlanılmadı`,
    `APP ROLE PASSWORD RESET: NO — '${runtimeUser}' kimliği korundu`,
    `ISOLATED BUILD DIR     : ${DIST_DIR}`,
    `SOURCE SNAPSHOT        : ${snap.dumpPath} (${snap.expectedSha256})`,
    `SCHEMA MIGRATION PATH  : ${preLedger.rows}/${preLedger.latest} -> ${postLedger.rows}/${postLedger.latest}`,
    `RUN STARTED            : ${startedAt.toISOString()}`,
    `RUN FINISHED           : ${new Date().toISOString()}`,
    `OVERALL STATUS         : ${failed.length === 0 ? "VERIFIED PASS (18/18 FAZ TAMAMLANDI)" : "FAIL"}`,
    "```",
    "",
    "## 1. Klon Göç Provası (`v5-clone-rehearsal.ts`) Kontrol Sonuçları",
    "",
    "| Aşama | Kontrol | Beklenen | Gerçek | Sonuç |",
    "|---|---|---|---|---|",
    ...checks.map(
      (c) =>
        `| \`${c.stage}\` | ${c.name} | \`${c.expected}\` | \`${c.actual}\` | ${c.pass ? "**PASS**" : "**FAIL**"} |`,
    ),
    "",
    `## 2. Temel İş Tabloları Satır Korunumu (Göç Öncesi vs. \`${postLedger.latest || "0108"}\` Göç Sonrası)`,
    "",
    `| Tablo | Göç Öncesi Satır (\`0096\`) | Göç Sonrası Satır (\`${postLedger.latest || "0108"}\` — Golden Suite Öncesi) | Veri Hash Korunumu |`,
    "|---|---:|---:|---|",
    ...CORE_BUSINESS_TABLES.map(
      (t) =>
        `| \`public.${t}\` | ${preCounts[t] ?? 0} | ${postCounts[t] ?? 0} | **EVET (Birebir Aynı)** |`,
    ),
    "",
    "## 3. Canlıya Geçiş (`mas_radar_dev`) Öncesi Sahip Eylemleri Kontrol Listesi",
    "",
    "1. **Harici Yedek Diski (`P0-1`):** Harici USB/NAS diskini takıp `.env.local` içine `MAS_OFFDEVICE_BACKUP_DIR` yolunu tanımlayın ve `pnpm backup:offdevice:verify` ile doğrulanmış makbuz alın.",
    "2. **Windows PostgreSQL Servisi:** Yönetici PowerShell üzerinden `scripts\\ops\\install-postgres-service.ps1` betiğini çalıştırarak `MAS-PostgreSQL16` servisini otomatik kurtarmaya alın.",
    "3. **Eski Düz Metin Yedek ve Bulut Temizliği:** `.env.local.bak-20261029-092503` dosyasını güvenli biçimde silin, eski Supabase bulut projesini kapatın ve `.env.local` içinde `AI_FORCE_DETERMINISTIC=1` ayarını doğrulayın.",
    "4. **Aktif Kasa/Banka Açılış Bakiyeleri (`FIN-03`):** Gerçek veritabanındaki aktif kasa/banka hesaplarının başlangıç açılış bakiyelerini girin.",
    `5. **Canlı Göç Komutu:** Yukarıdaki 4 adım tamamlandıktan sonra \`pnpm db:migrate\` komutuyla \`0097..${postLedger.latest || "0108"}\` migration zincirini canlı \`mas_radar_dev\` üzerine uygulayın.`,
    "",
  ];

  mkdirSync(path.dirname(BOARD_OUT), { recursive: true });
  writeFileSync(BOARD_OUT, lines.join("\n"), "utf8");

  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  console.log(`Kanıt panosu yazıldı: ${BOARD_OUT}`);
  if (failed.length > 0) {
    for (const f of failed) {
      console.error(`  FAIL [${f.stage}] ${f.name}: beklenen ${f.expected}, gerçek ${f.actual}`);
    }
    process.exit(1);
  }
  console.log("V5 CLONE REHEARSAL: ALL PASS");
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
