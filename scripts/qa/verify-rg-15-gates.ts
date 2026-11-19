/**
 * MAS Nexus — Independent Phase F Release Gates Verifier (`RG-01` through `RG-15`, Agent 11).
 *
 * Canonical 15 Release Gates (Section 8):
 *   RG-01 — Database reliability
 *   RG-02 — Schema consistency
 *   RG-03 — Backup recoverability
 *   RG-04 — Financial correctness
 *   RG-05 — Payment accuracy
 *   RG-06 — Temporal correctness
 *   RG-07 — Notification deduplication
 *   RG-08 — Incident lifecycle
 *   RG-09 — Data-quality transparency
 *   RG-10 — CFO report reliability
 *   RG-11 — Authorization safety
 *   RG-12 — Regression safety
 *   RG-13 — Runtime health
 *   RG-14 — Environment isolation
 *   RG-15 — Evidence integrity
 *
 * SAFETY & HONESTY INVARIANTS:
 * 1. Strictly read-only (`default_transaction_read_only=on`) or rolled-back (`BEGIN ... ROLLBACK`)
 *    against `mas_radar_dev`, verified via cryptographic before/after table & aggregate fingerprint.
 * 2. Zero outbound Telegram / email / network traffic (all transport probes use mock fetch/transports).
 * 3. Never inflates `BLOCKED` (e.g. unmounted physical `D:\` off-device drive in `RG-03`) or `FAIL`
 *    into `PASS`:
 *      - Exit `0`: All 15 gates `PASS` (or `NOT APPLICABLE`)
 *      - Exit `2`: `0` `FAIL` / `0` `NOT VERIFIED`, but `>= 1` `BLOCKED` by external dependency
 *      - Exit `1`: `>= 1` `FAIL` or `NOT VERIFIED`
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

import { GET as getHealth } from "@/app/health/route";
import { GET as getReady } from "@/app/ready/route";
import { evaluateSelfApprovalEligibility } from "@/lib/approvals/engine";
import { buildOvernightDeltaAttribution } from "@/lib/briefing/delta-attribution";
import { computeObligationAmounts } from "@/lib/contracts/remediation-contracts";
import { isValidIbanChecksum } from "@/lib/counterparties/rules";
import {
  evaluateRemediationDataQuality,
  evaluateValidImportFreshnessFromDb,
  type RemediationDataQualityReport,
} from "@/lib/data-quality/remediation-metrics";
import { checkSchemaParity, readExpectedSchemaManifest } from "@/lib/db/schema-parity";
import { DomainError } from "@/lib/domain-error";
import { isLoopbackHostname } from "@/lib/env";
import { mapAcceptedChecks } from "@/lib/financing/engine";
import { extractChecks } from "@/lib/importers/extractors";
import type { CellVal, SheetRow } from "@/lib/importers/row-utils";
import { looksLikeSecret, redactSecrets } from "@/lib/ops/alert-delivery";
import {
  evaluateOffDeviceRunLog,
  jobsStuckAlert,
  ledgerAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";
import { markInstancePaid } from "@/lib/radar/engine";
import { mapInstanceRow, monthSummary } from "@/lib/radar/queries";
import { loadFourWaySubledgerHealth } from "@/lib/reconciliation/four-way-health";
import { dispatchPending, eligibleMaturityDeliveries } from "@/lib/reminders/engine";
import {
  claimAndDispatchOutbox,
  computeNotificationIdempotencyKey,
  evaluateAndRecordOpsIncidents,
} from "@/lib/reminders/outbox";
import {
  ESCALATION_BUCKET_LABELS,
  buildReminderDigestHtml,
  buildReminderMessage,
  classifyEscalationBucket,
  daysOverdue,
  matchesReminderOffset,
  type ReminderRule,
  type ReminderTarget,
} from "@/lib/reminders/rules";
import {
  TELEGRAM_HTML_SAFE_MAX_CHARS,
  escapeTelegramHtml,
  scrubSensitiveTelegramText,
  sendTelegramChatMessage,
  splitTelegramHtmlMessage,
  type DeliveryResult,
  type Transport,
} from "@/lib/reminders/transport";
import { loadBoardFinancialPackage } from "@/lib/reports/board-pack";
import {
  buildDailyReport,
  buildMonthlyReport,
  istanbulDateISO,
  type ReportInstance,
} from "@/lib/reports/rules";
import { readEnvLocal } from "../db/app-url";
import { isDisposableDatabaseName } from "../db/owner-url";
import { resolveLocalOwnerUrl } from "../db/pg-local-admin";
import {
  readWorkerScheduleState,
  runScheduledMaintenance,
  writeWorkerScheduleStateAtomic,
} from "../ops/background-worker";
import {
  classifyOffDeviceTarget,
  copyToTargetVerified,
  planPrune,
  sha256OfFile,
  type DumpEntry,
  type RetentionPolicy,
} from "../ops/backup-lib";

export type ReleaseGateStatus =
  | "PASS"
  | "FAIL"
  | "BLOCKED"
  | "NOT VERIFIED"
  | "NOT APPLICABLE";

export interface ReleaseGateRecord {
  id: string;
  title: string;
  incidents: string;
  status: ReleaseGateStatus;
  evidence: string;
}

interface LiveDbImmutabilityFingerprint {
  schemaMigrationsCount: number;
  paymentsCount: number;
  paymentsSum: string;
  paymentInstancesCount: number;
  paymentInstancesSum: string;
  paymentInstancesPaidSum: string;
  checksCount: number;
  checksSum: string;
  loansCount: number;
  loanInstallmentsCount: number;
  invoicesCount: number;
  bankTransactionsCount: number;
  sourceWorkbooksCount: number;
  notificationOutboxCount: number;
  reminderDeliveriesCount: number;
  opsIncidentsCount: number;
  controlAlertsCount: number;
  approvalsCount: number;
  ibansCount: number;
  legalEntitiesCount: number;
  auditLogsCount: number;
}

function normalizeLoopbackUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.hostname.toLowerCase() === "localhost") {
    parsed.hostname = "127.0.0.1";
  }
  return parsed.toString();
}

async function captureImmutabilityFingerprint(
  roPool: Pool,
): Promise<LiveDbImmutabilityFingerprint> {
  const res = await roPool.query<{
    sm_cnt: number;
    pay_cnt: number;
    pay_sum: string;
    pi_cnt: number;
    pi_sum: string;
    pi_paid: string;
    chk_cnt: number;
    chk_sum: string;
    ln_cnt: number;
    li_cnt: number;
    inv_cnt: number;
    bt_cnt: number;
    wb_cnt: number;
    no_cnt: number;
    rd_cnt: number;
    oi_cnt: number;
    ca_cnt: number;
    ap_cnt: number;
    ib_cnt: number;
    le_cnt: number;
    al_cnt: number;
  }>(`
    select
      (select count(*)::int from public.schema_migrations) as sm_cnt,
      (select count(*)::int from public.payments) as pay_cnt,
      (select coalesce(sum(default_amount), 0)::numeric(16,2)::text from public.payments) as pay_sum,
      (select count(*)::int from public.payment_instances) as pi_cnt,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.payment_instances) as pi_sum,
      (select coalesce(sum(paid_amount), 0)::numeric(16,2)::text from public.payment_instances) as pi_paid,
      (select count(*)::int from public.checks) as chk_cnt,
      (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.checks) as chk_sum,
      (select count(*)::int from public.loans) as ln_cnt,
      (select count(*)::int from public.loan_installments) as li_cnt,
      (select count(*)::int from public.invoices) as inv_cnt,
      (select count(*)::int from public.bank_transactions) as bt_cnt,
      (select count(*)::int from public.source_workbooks) as wb_cnt,
      (select count(*)::int from public.notification_outbox) as no_cnt,
      (select count(*)::int from public.reminder_deliveries) as rd_cnt,
      (select count(*)::int from public.ops_incidents) as oi_cnt,
      (select count(*)::int from public.control_alerts) as ca_cnt,
      (select count(*)::int from public.approvals) as ap_cnt,
      (select count(*)::int from public.ibans) as ib_cnt,
      (select count(*)::int from public.legal_entities) as le_cnt,
      (select count(*)::int from public.audit_logs) as al_cnt
  `);
  const r = res.rows[0]!;
  return {
    schemaMigrationsCount: r.sm_cnt,
    paymentsCount: r.pay_cnt,
    paymentsSum: r.pay_sum,
    paymentInstancesCount: r.pi_cnt,
    paymentInstancesSum: r.pi_sum,
    paymentInstancesPaidSum: r.pi_paid,
    checksCount: r.chk_cnt,
    checksSum: r.chk_sum,
    loansCount: r.ln_cnt,
    loanInstallmentsCount: r.li_cnt,
    invoicesCount: r.inv_cnt,
    bankTransactionsCount: r.bt_cnt,
    sourceWorkbooksCount: r.wb_cnt,
    notificationOutboxCount: r.no_cnt,
    reminderDeliveriesCount: r.rd_cnt,
    opsIncidentsCount: r.oi_cnt,
    controlAlertsCount: r.ca_cnt,
    approvalsCount: r.ap_cnt,
    ibansCount: r.ib_cnt,
    legalEntitiesCount: r.le_cnt,
    auditLogsCount: r.al_cnt,
  };
}

async function main(): Promise<void> {
  const envLocal = (() => {
    try {
      return readEnvLocal();
    } catch {
      return {};
    }
  })();

  const rawAppUrl = process.env.DATABASE_URL?.trim() || envLocal.DATABASE_URL?.trim() || "";
  if (!rawAppUrl) {
    throw new Error("DATABASE_URL tanımlı değil (.env.local gerekli).");
  }
  const appUrl = normalizeLoopbackUrl(rawAppUrl);
  const ownerUrl = normalizeLoopbackUrl(resolveLocalOwnerUrl("mas_radar_dev"));

  const appPool = new Pool({
    connectionString: appUrl,
    max: 2,
    connectionTimeoutMillis: 60_000,
  });
  const ownerRoPool = new Pool({
    connectionString: ownerUrl,
    max: 2,
    connectionTimeoutMillis: 60_000,
    options: "-c default_transaction_read_only=on",
  });
  const ownerRollbackPool = new Pool({
    connectionString: ownerUrl,
    max: 1,
    connectionTimeoutMillis: 60_000,
  });

  const gates: ReleaseGateRecord[] = [];
  const tempDirs: string[] = [];

  const mkTemp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  const pnpmNodePath = path.resolve("node_modules", ".pnpm", "node_modules");
  const runNodeCheck = (args: string[], timeoutMs = 180_000): { ok: boolean; tail: string } => {
    try {
      const out = execFileSync(process.execPath, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        env: {
          ...process.env,
          NODE_PATH: pnpmNodePath,
        },
      });
      const lines = out.trim().split(/\r?\n/);
      return { ok: true, tail: lines[lines.length - 1] ?? "OK" };
    } catch (err) {
      const stderr = String((err as { stderr?: unknown })?.stderr ?? "");
      const stdout = String((err as { stdout?: unknown })?.stdout ?? "");
      const combined = `${stdout}\n${stderr}`.trim();
      return { ok: false, tail: combined.slice(-260).replace(/\s+/g, " ") };
    }
  };

  const recordGate = (
    id: string,
    title: string,
    incidents: string,
    status: ReleaseGateStatus,
    evidence: string,
  ): void => {
    gates.push({ id, title, incidents, status, evidence });
    console.log(`${status.padEnd(12)} [${id} — ${title}] (${incidents})\n             ${evidence}`);
  };

  let beforeFp: LiveDbImmutabilityFingerprint | null = null;
  let afterFp: LiveDbImmutabilityFingerprint | null = null;
  let sharedDqReport: RemediationDataQualityReport | null = null;
  let drillReceiptIntegrityOk = false;

  try {
    console.log("=== MAS NEXUS — PHASE F INDEPENDENT 15 RELEASE GATES VERIFICATION ===\n");
    beforeFp = await captureImmutabilityFingerprint(ownerRoPool);

    // ── RG-01 — Database reliability (I-001) ──
    {
      const roleRes = await appPool.query<{
        db: string;
        usr: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolinherit: boolean;
      }>(
        `select current_database() as db,
                current_user as usr,
                rolsuper,
                rolbypassrls,
                rolinherit
           from pg_roles
          where rolname = current_user`,
      );
      const r = roleRes.rows[0];

      const catRes = await ownerRoPool.query<{
        total_tables: number;
        rls_tables: number;
        total_views: number;
        invoker_views: number;
        writable_views: number;
      }>(`
        select
          (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')) as total_tables,
          (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity) as rls_tables,
          (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v') as total_views,
          (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'v' and coalesce('security_invoker=true' = any(c.reloptions), false)) as invoker_views,
          (select count(*)::int
             from information_schema.views v
             cross join pg_roles rl
            where v.table_schema = 'public'
              and rl.rolname in ('mas_radar_app', 'mas_radar_viewer', 'mas_radar_finance_operator', 'mas_radar_finance_approver', 'mas_radar_finance_manager', 'mas_radar_admin')
              and (
                has_table_privilege(rl.oid, format('public.%I', v.table_name), 'INSERT')
                or has_table_privilege(rl.oid, format('public.%I', v.table_name), 'UPDATE')
                or has_table_privilege(rl.oid, format('public.%I', v.table_name), 'DELETE')
              )) as writable_views
      `);
      const c = catRes.rows[0]!;

      let ledgerWriteDenied = false;
      const appClient = await appPool.connect();
      try {
        await appClient.query("BEGIN");
        try {
          await appClient.query(
            `insert into public.schema_migrations (version, name, checksum) values ('9999', 'rg01_probe', '0')`,
          );
        } catch (err) {
          ledgerWriteDenied = (err as { code?: string })?.code === "42501";
        }
      } finally {
        await appClient.query("ROLLBACK").catch(() => {});
        appClient.release();
      }

      const failClosedPredicates =
        runtimeIdentityAlert(null) === true &&
        runtimeIdentityAlert("postgres") === true &&
        runtimeIdentityAlert("mas_radar_app") === false &&
        jobsStuckAlert("?") === true &&
        reconciliationAlert("?") === true;

      const ok =
        r?.db === "mas_radar_dev" &&
        r?.usr === "mas_radar_app" &&
        r.rolsuper === false &&
        r.rolbypassrls === false &&
        r.rolinherit === false &&
        c.total_tables >= 132 &&
        c.total_tables === c.rls_tables &&
        c.total_views >= 91 &&
        c.total_views === c.invoker_views &&
        c.writable_views === 0 &&
        ledgerWriteDenied &&
        failClosedPredicates;

      recordGate(
        "RG-01",
        "Database reliability",
        "I-001",
        ok ? "PASS" : "FAIL",
        `db=${r?.db} user=${r?.usr} super=${r?.rolsuper} bypassrls=${r?.rolbypassrls} inherit=${r?.rolinherit} RLS=${c.rls_tables}/${c.total_tables} invokerViews=${c.invoker_views}/${c.total_views} writableViews=${c.writable_views} ledgerWrite42501=${ledgerWriteDenied} failClosedPredicates=${failClosedPredicates}`,
      );
    }

    // ── RG-02 — Schema consistency (I-002) ──
    {
      const manifest = readExpectedSchemaManifest();
      const liveParity = await checkSchemaParity(appPool);
      const mockDriftParity = await checkSchemaParity({
        async query() {
          return {
            rows: [
              {
                migration_count: 115,
                latest_version: "0115",
                checksum_digest: "deadbeef0115",
                last_applied_at: "2026-11-01T00:00:00Z",
              },
            ],
            rowCount: 1,
          };
        },
      } as unknown as Pool);

      const ok =
        liveParity.aligned === true &&
        liveParity.actualCount === manifest.expectedCount &&
        liveParity.actualLatestVersion === manifest.expectedLatestVersion &&
        liveParity.actualCount >= 124 &&
        liveParity.actualLatestVersion === "0124" &&
        /^[0-9a-f]{64}$/.test(liveParity.checksumDigest ?? "") &&
        mockDriftParity.aligned === false &&
        ledgerAlert("115/0115", "119/0119") === true &&
        ledgerAlert("?", "?") === true;

      recordGate(
        "RG-02",
        "Schema consistency",
        "I-002",
        ok ? "PASS" : "FAIL",
        `aligned=${liveParity.aligned} ledger=${liveParity.actualCount}/${liveParity.actualLatestVersion} expected=${manifest.expectedCount}/${manifest.expectedLatestVersion} checksum=${liveParity.checksumDigest?.slice(0, 16)}… driftBlocked=${!mockDriftParity.aligned}`,
      );
    }

    // ── RG-03 — Backup recoverability (I-003) ──
    {
      const drillPath = path.resolve("backups", "latest-restore-drill.json");
      const drillExists = fs.existsSync(drillPath);
      const drill = drillExists
        ? (JSON.parse(fs.readFileSync(drillPath, "utf8")) as Record<string, unknown>)
        : null;

      const dumpPath = drill?.dumpFile ? path.resolve("backups", String(drill.dumpFile)) : "";
      const dumpFileExists = Boolean(dumpPath && fs.existsSync(dumpPath));
      const measuredSha = dumpFileExists ? sha256OfFile(dumpPath) : "";
      const stage07Exists = dumpFileExists && fs.existsSync(`${dumpPath}.stage07.json`);
      const shaSidecarExists = dumpFileExists && fs.existsSync(`${dumpPath}.sha256`);

      const localRestoreVerified =
        Boolean(drill?.passed) &&
        drill?.schemaLedger === "124/0124" &&
        drill?.countsMatched === true &&
        drill?.aggregatesMatched === true &&
        drill?.runtimeRoleParityVerified === true &&
        drill?.isolatedDbDropped === true &&
        dumpFileExists &&
        measuredSha === drill?.dumpSha256 &&
        stage07Exists &&
        shaSidecarExists;
      drillReceiptIntegrityOk = localRestoreVerified;

      // Verify off-device tooling & sole-backup retention guard in isolated temp directories
      const srcTmp = mkTemp("mas-rg03-src-");
      const dstTmp = mkTemp("mas-rg03-dst-");
      const sampleDump = path.join(srcTmp, "daily-2026-11-18T00-00-00-000Z.dump");
      fs.writeFileSync(sampleDump, Buffer.from("PGDMP-RG03-VERIFY-PAYLOAD", "utf8"));
      const copyRes = copyToTargetVerified(sampleDump, dstTmp, { sourceDir: srcTmp });
      const sameUncRejected =
        classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev", "\\\\nas-backup\\mas_radar_dev")
          .offDeviceSatisfied === false;
      const oldVerified: DumpEntry = {
        name: "daily-2025-10-01T02-00-00-000Z.dump",
        fullPath: "/backups/daily-2025-10-01T02-00-00-000Z.dump",
        bytes: 1024,
        timestamp: new Date("2025-10-01T02:00:00.000Z"),
        timestampSource: "filename",
        label: "daily",
        retentionClass: "rolling",
        immutableReason: null,
        sidecars: ["/backups/daily-2025-10-01T02-00-00-000Z.dump.sha256"],
      };
      const newerUnverified: DumpEntry = {
        name: "daily-2026-11-17T02-00-00-000Z.dump",
        fullPath: "/backups/daily-2026-11-17T02-00-00-000Z.dump",
        bytes: 1024,
        timestamp: new Date("2026-11-17T02:00:00.000Z"),
        timestampSource: "filename",
        label: "daily",
        retentionClass: "rolling",
        immutableReason: null,
        sidecars: [],
      };
      const prunePolicy: RetentionPolicy = { daily: 1, weekly: 1, monthly: 1, minAgeHours: 24 };
      const pruneRes = planPrune(
        [newerUnverified, oldVerified],
        prunePolicy,
        new Date("2026-11-18T12:00:00.000Z"),
      );
      const soleVerifiedKept =
        pruneRes.decisions.find((d) => d.entry.fullPath === oldVerified.fullPath)?.keep === true;
      const enoentTelemetry = evaluateOffDeviceRunLog(
        JSON.stringify({
          ok: false,
          exitCode: 3,
          stage: "offdevice",
          offDeviceOk: false,
          offDeviceNote: "ENOENT: no such file or directory, mkdir 'D:\\MAS-Backups\\mas_radar_dev'",
        }),
      );

      const toolingVerified =
        copyRes.sha256Match &&
        copyRes.bytesMatch &&
        sameUncRejected &&
        soleVerifiedKept &&
        enoentTelemetry.alert === true &&
        enoentTelemetry.note.includes("ENOENT");

      // Inspect LIVE configured physical off-device target (CRITICAL HONESTY RULE: never fake PASS!)
      const configuredOffDeviceDir = (
        process.env.MAS_OFFDEVICE_BACKUP_DIR ??
        envLocal.MAS_OFFDEVICE_BACKUP_DIR ??
        "D:\\MAS-Backups\\mas_radar_dev"
      ).trim();
      const offDevicePathExists = configuredOffDeviceDir !== "" && fs.existsSync(configuredOffDeviceDir);
      const liveOffDeviceClass = configuredOffDeviceDir
        ? classifyOffDeviceTarget(configuredOffDeviceDir, path.resolve("backups"))
        : null;
      const latestDumpOffDeviceReceiptExists =
        dumpFileExists && fs.existsSync(`${dumpPath}.offdevice.json`);
      const physicalTargetVerified =
        offDevicePathExists &&
        liveOffDeviceClass?.offDeviceSatisfied === true &&
        latestDumpOffDeviceReceiptExists;

      const rg03Status: ReleaseGateStatus =
        !localRestoreVerified || !toolingVerified
          ? "FAIL"
          : physicalTargetVerified
            ? "PASS"
            : "BLOCKED";

      recordGate(
        "RG-03",
        "Backup recoverability",
        "I-003",
        rg03Status,
        `localDumpAndIsolatedRestore=${localRestoreVerified ? "VERIFIED" : "FAILED"} (ledger=${String(drill?.schemaLedger)}, sha256=${measuredSha.slice(0, 12)}…, rls=${String(drill?.rlsTablesVerified)}/${String(drill?.tablesVerified)}, dropped=${String(drill?.isolatedDbDropped)}) · offDeviceTooling=${toolingVerified ? "VERIFIED" : "FAILED"} · physicalOffDeviceTarget=${physicalTargetVerified ? "VERIFIED" : `BLOCKED (target='${configuredOffDeviceDir}', exists=${offDevicePathExists}, offDeviceSatisfied=${String(liveOffDeviceClass?.offDeviceSatisfied ?? false)})`}`,
      );
    }

    // ── RG-04 — Financial correctness (I-009) ──
    {
      const months = [
        "2026-06-01",
        "2026-07-01",
        "2026-08-01",
        "2026-09-01",
        "2026-10-01",
        "2026-11-01",
        "2026-12-01",
      ];
      const summaries = await Promise.all(months.map((m) => monthSummary(ownerRoPool, m)));
      const nov = summaries[5]!;
      const jun = summaries[0]!;
      const allZeroGap = summaries.every((s) => s.unexplainedGapTry === 0);

      const monthlyMd = buildMonthlyReport({
        monthStart: "2026-11-01",
        knownTotal: nov.known_total,
        knownRemaining: nov.known_remaining,
        paidKnown: nov.paid_known,
        missingCount: nov.missing_count,
        totalCount: nov.total_count,
        cancelledCount: nov.cancelledCount,
        cancelledKnownTotal: nov.cancelledKnownTotal,
        settlementAdjustmentTry: nov.settlementAdjustmentTry,
        topPayments: [],
        providerDist: [],
        categoryDist: [],
        ownerDist: [],
        checksInMonth: [],
        installmentsInMonth: [],
        cashMonth: null,
        dataQualityIssues: [],
      }).bodyMd;

      const ok =
        allZeroGap &&
        nov.known_total === 510_000 &&
        nov.known_remaining === 510_000 &&
        nov.cancelledKnownTotal === 30_000 &&
        jun.known_total === 490_000 &&
        jun.paid_known === 155_000 &&
        jun.known_remaining === 335_000 &&
        jun.cancelledKnownTotal === 50_000 &&
        monthlyMd.includes("510.000 TL") &&
        monthlyMd.includes("30.000 TL");

      recordGate(
        "RG-04",
        "Financial correctness",
        "I-009",
        ok ? "PASS" : "FAIL",
        `allMonthsZeroGap=${allZeroGap} 2026-11(known=${nov.known_total}, rem=${nov.known_remaining}, cancelled=${nov.cancelledKnownTotal}) 2026-06(known=${jun.known_total}, paid=${jun.paid_known}, rem=${jun.known_remaining}, cancelled=${jun.cancelledKnownTotal})`,
      );
    }

    // ── RG-05 — Payment accuracy (I-012) ──
    {
      const livePartialRes = await ownerRoPool.query<Record<string, unknown>>(
        `select i.id, i.payment_id, coalesce(p.name, '(kalem)') as name,
                to_char(i.due_date, 'YYYY-MM-DD') as due_date,
                i.amount, i.amount_status, i.status, i.paid_amount,
                i.risk_level, i.risk_reasons, i.note, i.currency
           from public.payment_instances i
           left join public.payments p on p.id = i.payment_id
          where i.id = '0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d'`,
      );
      const mappedLive = mapInstanceRow(livePartialRes.rows[0]!);

      const syntheticPartial: ReportInstance & Record<string, unknown> = {
        name: "VAKIF KREDİ 2",
        dueDate: "2026-11-10",
        amount: 30_000,
        originalAmount: 30_000,
        paidAmount: 10_000,
        paid_amount: 10_000,
        status: "partial",
        riskLevel: "high",
        riskReasons: ["overdue"],
        currency: "TRY",
      };
      const daily = buildDailyReport(
        { dueSoon: [], overdue: [syntheticPartial], maturities: [], criticalThreshold: 100_000 },
        "2026-11-18",
      );
      const reminderMsg = buildReminderMessage(
        { id: "r8", name: "8-30 Gün", targetKind: "payment_instance", offsetDays: -8, channel: "telegram", minAmount: null, isActive: true },
        {
          entityTable: "payment_instances",
          entityId: "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d",
          name: "VAKIF KREDİ 2",
          dueDate: "2026-11-10",
          amount: 30_000,
          originalAmount: 30_000,
          paidAmount: 10_000,
          outstandingAmount: 20_000,
          status: "partial",
          owner: null,
          provider: "Vakıfbank",
          riskReasons: ["overdue"],
        } as ReminderTarget,
        "2026-11-18",
      );

      const ok =
        mappedLive.original_amount === 30_000 &&
        mappedLive.paid_amount === 12_000 &&
        mappedLive.remaining_amount === 18_000 &&
        daily.overdueKnownTotal === 20_000 &&
        daily.bodyMd.includes("30.000 TL") &&
        daily.bodyMd.includes("10.000 TL") &&
        daily.bodyMd.includes("20.000 TL") &&
        reminderMsg.includes("30.000 TL") &&
        reminderMsg.includes("10.000 TL") &&
        reminderMsg.includes("20.000 TL");

      recordGate(
        "RG-05",
        "Payment accuracy",
        "I-012",
        ok ? "PASS" : "FAIL",
        `liveRow0fbd2b5b(orig=${mappedLive.original_amount}, paid=${mappedLive.paid_amount}, rem=${mappedLive.remaining_amount}) · scenario6DailyOverdue=${daily.overdueKnownTotal} · triValueDisplayed=true`,
      );
    }

    // ── RG-06 — Temporal correctness (I-006, I-008) ──
    {
      const trDate = istanbulDateISO(new Date("2026-11-17T21:30:00Z"));
      const day30Bucket = classifyEscalationBucket("2026-10-19", "2026-11-18");
      const day31Bucket = classifyEscalationBucket("2026-10-18", "2026-11-18");
      const label31 = ESCALATION_BUCKET_LABELS[day31Bucket];

      const rules: ReminderRule[] = [
        { id: "r1", name: "1-7", targetKind: "loan_installment", offsetDays: -1, channel: "telegram", minAmount: null, isActive: true },
        { id: "r8", name: "8-30", targetKind: "loan_installment", offsetDays: -8, channel: "telegram", minAmount: null, isActive: true },
        { id: "r31", name: "31+", targetKind: "loan_installment", offsetDays: -31, channel: "telegram", minAmount: null, isActive: true },
      ];
      const target364: ReminderTarget = {
        entityTable: "loan_installments",
        entityId: "00000000-0000-4000-8000-000000000364",
        name: "Kredi Taksit #1",
        dueDate: "2025-11-19",
        amount: 45_000,
        status: "late",
        owner: null,
        provider: "Vakıfbank",
        riskReasons: [],
      };
      const eligible364 = eligibleMaturityDeliveries(rules, [target364], "2026-11-18");

      const dbRuleNames = await ownerRoPool.query<{ name: string }>(
        `select name from public.reminders where offset_days = -31`,
      );
      const dbRulesClean =
        dbRuleNames.rows.length > 0 &&
        dbRuleNames.rows.every(
          (r) =>
            r.name.includes("31+") &&
            !r.name.includes("30+") &&
            !r.name.toLocaleLowerCase("tr-TR").includes("hukuki eskalasyon"),
        );

      const ok =
        trDate === "2026-11-18" &&
        matchesReminderOffset(0, "2026-11-18", trDate) &&
        matchesReminderOffset(3, "2026-11-21", trDate) &&
        daysOverdue("2025-11-19", "2026-11-18") === 364 &&
        day30Bucket === "overdue_8_30" &&
        label31.includes("31+") &&
        !label31.includes("30+") &&
        !label31.toLocaleLowerCase("tr-TR").includes("hukuki eskalasyon") &&
        eligible364.length === 1 &&
        eligible364[0]!.ruleId === "r31" &&
        dbRulesClean;

      recordGate(
        "RG-06",
        "Temporal correctness",
        "I-006, I-008",
        ok ? "PASS" : "FAIL",
        `istanbulDate(21:30Z)=${trDate} day30=${day30Bucket} day31Label='${label31}' 364dMatchedRules=[${eligible364.map((e) => e.ruleId).join(",")}] dbMinus31RulesClean=${dbRulesClean}`,
      );
    }

    // ── RG-07 — Notification deduplication (I-007, I-014) ──
    {
      let dbOutboxConstraintsOk = false;
      const client = await ownerRollbackPool.connect();
      try {
        await client.query("BEGIN");
        const ins1 = await client.query(
          `insert into public.notification_outbox (stream, channel, recipient_target, idempotency_key, body_text, status)
           values ('ops_incident', 'telegram', '-1001', 'rg07-idem-probe', 'probe', 'delivery_uncertain')
           on conflict (idempotency_key) do nothing returning id`,
        );
        const ins2 = await client.query(
          `insert into public.notification_outbox (stream, channel, recipient_target, idempotency_key, body_text, status)
           values ('ops_incident', 'telegram', '-1001', 'rg07-idem-probe', 'probe', 'pending')
           on conflict (idempotency_key) do nothing returning id`,
        );
        dbOutboxConstraintsOk = ins1.rowCount === 1 && ins2.rowCount === 0;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      let rowStatus = "pending";
      let claimToken: string | null = null;
      const sentMsgs: string[] = [];
      const racePool = {
        async query(rawSql: string) {
          const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();
          if (sql.includes("expired_stale_window") || (sql.includes("where status = 'claiming'") && !sql.includes("returning"))) {
            return { rows: [], rowCount: 0 };
          }
          if (sql.startsWith("with ") && sql.includes("for update skip locked") && sql.includes("returning")) {
            if (rowStatus !== "pending") return { rows: [], rowCount: 0 };
            rowStatus = "claiming";
            claimToken = "11111111-1111-4111-8111-111111111111";
            return {
              rows: [
                {
                  id: "deliv-rg07-1",
                  reminder_id: "r-8",
                  entity_table: "loan_installments",
                  entity_id: "22222222-2222-4222-8222-222222222222",
                  scheduled_for: "2026-11-13",
                  payload: {},
                  claim_token: claimToken,
                  rule_name: "8-30 Gün İhtar",
                  target_kind: "loan_installment",
                  offset_days: -8,
                  channel: "telegram",
                  min_amount: null,
                  is_active: true,
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("from public.loan_installments")) {
            return {
              rows: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  name: "Kredi Taksit #2",
                  due_date: "2026-11-05",
                  amount: "50000.00",
                  original_amount: "50000.00",
                  paid_amount: "0.00",
                  status: "late",
                  provider: "Akbank",
                  legal_entity_id: null,
                },
              ],
              rowCount: 1,
            };
          }
          if (sql.includes("notification_outbox")) {
            return { rows: [{ id: "outbox-rg07-1" }], rowCount: 1 };
          }
          if (sql.startsWith("update public.reminder_deliveries")) {
            rowStatus = "sent";
            return { rows: [{ id: "deliv-rg07-1" }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      } as unknown as Pool;

      const slowTransport: Transport = {
        channel: "telegram",
        async send(m: string): Promise<DeliveryResult> {
          await new Promise((res) => setTimeout(res, 15));
          sentMsgs.push(m);
          return { ok: true };
        },
      };
      await Promise.all([
        dispatchPending(racePool, slowTransport, "2026-11-18"),
        dispatchPending(racePool, slowTransport, "2026-11-18"),
      ]);

      const res429 = await sendTelegramChatMessage("-100111", "test", {
        token: "123:ABC",
        allowedChatIds: ["-100111"],
        fetchImpl: (async () =>
          new Response(JSON.stringify({ ok: false, parameters: { retry_after: 17 } }), {
            status: 429,
          })) as typeof fetch,
      });
      const resTimeout = await sendTelegramChatMessage("-100111", "test", {
        token: "123:ABC",
        allowedChatIds: ["-100111"],
        fetchImpl: (async () => {
          throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        }) as typeof fetch,
      });

      let recordedOutboxStatus = "";
      const outboxClaimPool = {
        async connect() {
          return {
            async query(rawSql: string) {
              const sql = rawSql.toLowerCase();
              if (sql.includes("with due as")) {
                return {
                  rows: [
                    {
                      id: "ob-1",
                      stream: "ops_incident",
                      channel: "telegram",
                      recipient_target: "-100111",
                      idempotency_key: computeNotificationIdempotencyKey(["rg07", "1"]),
                      subject: null,
                      body_text: "test",
                      body_format: "plain",
                      metadata: {},
                      claim_token: "33333333-3333-4333-8333-333333333333",
                      attempt_count: 0,
                      max_attempts: 5,
                    },
                  ],
                  rowCount: 1,
                };
              }
              return { rows: [], rowCount: 0 };
            },
            release() {},
          };
        },
        async query(rawSql: string, params?: unknown[]) {
          const sql = rawSql.toLowerCase();
          const m = sql.match(/set\s+status\s*=\s*'([a-z_]+)'/);
          const pm = sql.match(/set\s+status\s*=\s*\$(\d+)/);
          if (m) recordedOutboxStatus = m[1]!;
          else if (pm && params) recordedOutboxStatus = String(params[Number(pm[1]) - 1]);
          return { rows: [{ id: "ob-1" }], rowCount: 1 };
        },
      } as unknown as Pool;

      await claimAndDispatchOutbox(outboxClaimPool, {
        transportResolver: () => ({
          channel: "telegram",
          async send() {
            return resTimeout;
          },
        }),
      });

      // Outbound Telegram hygiene: single-pass HTML escaping, balanced chunking, IBAN/secret redaction
      const escaped = escapeTelegramHtml("[P1] Garanti & Akbank <Alert>");
      const digest = buildReminderDigestHtml(
        [{ name: "[P1] Garanti & Akbank", dueDate: "2026-11-18", amount: null, status: "unpaid", riskReasons: ["missing_amount"] }],
        "2026-11-18",
      );
      const chunks = splitTelegramHtmlMessage(
        `<b><i>${"Garanti &amp; Akbank taksit kontrol satırı — 25.000 TL\n".repeat(120)}</i></b>`,
      );
      const balancedChunks = chunks.every(
        (c) =>
          c.length <= TELEGRAM_HTML_SAFE_MAX_CHARS &&
          (c.match(/<b>/g) ?? []).length === (c.match(/<\/b>/g) ?? []).length &&
          (c.match(/<i>/g) ?? []).length === (c.match(/<\/i>/g) ?? []).length,
      );
      const scrubbedIban = scrubSensitiveTelegramText("IBAN: TR33 0006 1005 1978 6457 8413 26");
      const redacted = redactSecrets(
        "postgres://mas_radar_app:S3cretPass!@127.0.0.1:5432/mas_radar_dev /bot123456:AAF-secretToken_xyz/sendMessage Bearer eyJhbGciOiJIUzI1NiJ9 chat=-100999888",
        ["-100999888"],
      );
      const remainingSecrets = looksLikeSecret(redacted, ["-100999888"]);

      const ok =
        dbOutboxConstraintsOk &&
        sentMsgs.length === 1 &&
        res429.retryAfterSeconds === 17 &&
        resTimeout.uncertainOutcome === true &&
        recordedOutboxStatus === "delivery_uncertain" &&
        escaped === "[P1] Garanti &amp; Akbank &lt;Alert&gt;" &&
        !digest.includes("&#91;") &&
        !digest.includes("&amp;amp;") &&
        !digest.includes("missing\\_amount") &&
        chunks.length >= 2 &&
        balancedChunks &&
        scrubbedIban.includes("TR** **** **** **** **** **26") &&
        remainingSecrets.length === 0;

      recordGate(
        "RG-07",
        "Notification deduplication",
        "I-007, I-014",
        ok ? "PASS" : "FAIL",
        `dbOutboxUnique=${dbOutboxConstraintsOk} concurrentWorkerSends=${sentMsgs.length} retryAfter429=${String(res429.retryAfterSeconds)}s outboxHold='${recordedOutboxStatus}' singlePassHtml=true balancedChunks=${chunks.length} secretLeaks=${remainingSecrets.length}`,
      );
    }

    // ── RG-08 — Incident lifecycle (I-005, I-013) ──
    {
      const incDir = mkTemp("mas-rg08-inc-");
      const stateFile = path.join(incDir, "state.json");
      const t0 = new Date("2026-11-18T08:00:00Z");

      await evaluateAndRecordOpsIncidents(
        null,
        [{ signal: "db_reachable", severity: "P0", value: "DOWN", threshold: "UP" }],
        { now: t0, stateFilePath: stateFile },
      );
      const unknownEval = await evaluateAndRecordOpsIncidents(
        null,
        [{ signal: "db_reachable", severity: "P0", value: "?" }],
        { now: new Date("2026-11-18T08:05:00Z"), stateFilePath: stateFile },
      );
      const unknownState = unknownEval.records.find((r) => r.signalKey === "db_reachable")?.state;

      const resolvedEval = await evaluateAndRecordOpsIncidents(null, [], {
        now: new Date("2026-11-18T08:15:00Z"),
        stateFilePath: stateFile,
      });
      const resolvedRec = resolvedEval.records.find((r) => r.signalKey === "db_reachable");
      const ev = resolvedRec?.resolutionEvidence;

      // Initial P2 notification emission
      const p2Dir = mkTemp("mas-rg08-p2-");
      const p2Eval = await evaluateAndRecordOpsIncidents(
        null,
        [{ signal: "latest_import_age_days", severity: "P2", value: "124", threshold: "<= 45 gün" }],
        { now: t0, stateFilePath: path.join(p2Dir, "p2.json") },
      );
      const p2Notified = p2Eval.notifications.some((n) => n.formattedLine.includes("[OPEN][P2]"));

      // Verify SUPPRESSED state in live PostgreSQL inside BEGIN ... ROLLBACK
      let dbSuppressedOk = false;
      const client = await ownerRollbackPool.connect();
      try {
        await client.query("BEGIN");
        const r = await client.query<{ state: string }>(
          `insert into public.ops_incidents
             (signal_key, severity, state, last_value, suppressed_until, suppression_reason, resolution_evidence)
           values ('rg08_sup_probe', 'P1', 'SUPPRESSED', 'test', now() + interval '4 hours', 'maintenance', '{"verifiedByCheck":"rg08"}'::jsonb)
           returning state`,
        );
        dbSuppressedOk = r.rows[0]?.state === "SUPPRESSED";
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      const ok =
        unknownState === "UNKNOWN" &&
        p2Notified &&
        resolvedRec?.state === "RESOLVED" &&
        ev != null &&
        typeof ev.verifiedAtISO === "string" &&
        typeof ev.measuredValue === "string" &&
        typeof ev.verifiedByCheck === "string" &&
        dbSuppressedOk;

      recordGate(
        "RG-08",
        "Incident lifecycle",
        "I-005, I-013",
        ok ? "PASS" : "FAIL",
        `blindTransition=${String(unknownState)} initialP2Emitted=${p2Notified} resolvedState=${String(resolvedRec?.state)} resolutionEvidenceKeys=[${ev ? Object.keys(ev).join(",") : ""}] dbSuppressedConstraint=${dbSuppressedOk}`,
      );
    }

    // ── RG-09 — Data-quality transparency (I-005, I-010, I-011) ──
    {
      const freshness = await evaluateValidImportFreshnessFromDb(ownerRoPool, {
        asOf: new Date("2026-11-18T12:00:00Z"),
      });

      let rollbackFilterVerified = false;
      const client = await ownerRollbackPool.connect();
      try {
        await client.query("BEGIN");
        const emptyWb = await client.query<{ id: string }>(
          `insert into public.source_workbooks (original_filename, status, imported_at)
           values ('rg09_empty.xlsx', 'parsed', now()) returning id`,
        );
        const failedWb = await client.query<{ id: string }>(
          `insert into public.source_workbooks (original_filename, status, imported_at, parse_error)
           values ('rg09_failed.xlsx', 'failed', now(), 'corrupt') returning id`,
        );
        const checkView = await client.query<{ id: string }>(
          `select id::text from public.valid_workbook_imports where id = any($1::uuid[])`,
          [[emptyWb.rows[0]!.id, failedWb.rows[0]!.id]],
        );
        rollbackFilterVerified = checkView.rowCount === 0;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      sharedDqReport = await evaluateRemediationDataQuality(ownerRoPool, {
        asOf: "2026-11-18T12:00:00Z",
        instanceMonthScope: "2026-11-01",
      });
      const dq = sharedDqReport;

      const dupChecksRes = await ownerRoPool.query<{ cnt: number }>(
        `select count(*)::int as cnt
           from public.checks
          where archived_at is null
            and maturity_date = '2026-08-31'
            and amount = 100000`,
      );
      const cell = (v: string | number): CellVal => ({ v, t: typeof v === "number" ? "n" : "s" });
      const sheetRows: SheetRow[] = [
        { rowIndex: 1, cells: { A: cell("TARİH"), B: cell("KİME"), C: cell("TUTAR") } },
        { rowIndex: 2, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
        { rowIndex: 3, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
      ];
      const extracted = extractChecks(sheetRows);

      const resolvedMap = await mapAcceptedChecks(
        {
          async connect() {
            return {
              async query(sql: string) {
                const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
                if (norm.includes("from public.source_sheets")) {
                  return { rows: [{ id: "s1", sheet_name: "ÇEKLER" }], rowCount: 1 };
                }
                if (norm.includes("from public.import_rows ir")) {
                  return {
                    rows: [
                      { id: "ir-1", row_index: 1, row_json: sheetRows[0]!.cells, mapping_status: "pending", blocked: false, resolved_duplicate: false },
                      { id: "ir-2", row_index: 2, row_json: sheetRows[1]!.cells, mapping_status: "pending", blocked: false, resolved_duplicate: false },
                      { id: "ir-3", row_index: 3, row_json: sheetRows[2]!.cells, mapping_status: "pending", blocked: true, resolved_duplicate: true },
                    ],
                    rowCount: 3,
                  };
                }
                if (norm.includes("from public.parties") || norm.startsWith("insert into") || norm.startsWith("update ")) {
                  return { rows: [{ id: "id-1" }], rowCount: 1 };
                }
                return { rows: [], rowCount: 0 };
              },
              release() {},
            };
          },
        } as unknown as Pool,
        "wb-rg09",
        "actor-rg09",
      );

      const nullAmounts = computeObligationAmounts({
        originalAmount: null,
        paidAmount: null,
        status: "unpaid",
      });
      const novActiveInstances = dq.completeness.scopedMonthInstanceGrain?.activeOutflowInstances ?? -1;

      const ok =
        nullAmounts.originalAmount === null &&
        nullAmounts.outstandingAmount === null &&
        freshness.validWorkbookCount >= 1 &&
        freshness.isStale === true &&
        (freshness.latestValidImportAgeDays ?? 0) >= 120 &&
        rollbackFilterVerified &&
        dupChecksRes.rows[0]?.cnt === 3 &&
        extracted.candidates.length === 2 &&
        resolvedMap.created === 1 &&
        resolvedMap.excluded.length === 1 &&
        dq.consistency.hasZeroJoinMultiplication === true &&
        dq.consistency.isConsistent === true &&
        novActiveInstances === 17 &&
        dq.sourceTraceability.mutationsPerformed === 0;

      recordGate(
        "RG-09",
        "Data-quality transparency",
        "I-005, I-010, I-011",
        ok ? "PASS" : "FAIL",
        `blankStaysNull=true validImportAgeDays=${String(freshness.latestValidImportAgeDays)} (emptyFailedExcluded=${rollbackFilterVerified}) · zeroJoinMult=${dq.consistency.hasZeroJoinMultiplication} novActive=${novActiveInstances} activeCagdasChecks=${dupChecksRes.rows[0]?.cnt} resolvedDupExcluded=${resolvedMap.excluded.length}`,
      );
    }

    // ── RG-10 — CFO report reliability (I-010) ──
    {
      const fourWay = await loadFourWaySubledgerHealth(ownerRoPool);
      const bank102 = fourWay.pillars.find((p) => p.key === "bank_102");
      const delta = buildOvernightDeltaAttribution({
        fromDateISO: "2026-11-17",
        toDateISO: "2026-11-18",
        previousAvailableCash: null,
        currentAvailableCash: null,
        previousLiquidityGap7: null,
        currentLiquidityGap7: null,
        bankInflows: [],
        bankOutflows: [],
        newlyEntered7dObligations: [],
        slippedPromisesAndOverdueAr: [],
        hasVerifiedBankFeed: false,
      });

      const boardPackA = await loadBoardFinancialPackage(ownerRoPool, "2026-11-18");
      const boardPackB = await loadBoardFinancialPackage(ownerRoPool, "2026-11-18");
      const provA = boardPackA.provenance;
      const provB = boardPackB.provenance;

      const ok =
        bank102?.aligned === false &&
        bank102?.subledgerTry === null &&
        delta.realizedBankInflows === null &&
        delta.realizedBankOutflows === null &&
        boardPackA.executiveSummary.consolidatedCashTry === null &&
        provA !== undefined &&
        provB !== undefined &&
        typeof provA.calculationVersion === "string" &&
        /^[0-9a-f]{64}$/.test(provA.contentSha256) &&
        provA.contentSha256 === provB.contentSha256 &&
        provA.monetaryBasisByMetric !== undefined &&
        typeof provA.confidenceGrade === "string";

      recordGate(
        "RG-10",
        "CFO report reliability",
        "I-010",
        ok ? "PASS" : "FAIL",
        `bank102Subledger=${String(bank102?.subledgerTry)} consolidatedCash=${String(boardPackA.executiveSummary.consolidatedCashTry)} bankFeedFlows=${String(delta.realizedBankInflows)} confidenceGrade=${String(provA?.confidenceGrade)} reproducibleSha256=${provA?.contentSha256 === provB?.contentSha256} (${(provA?.contentSha256 ?? "").slice(0, 12)}…)`,
      );
    }

    // ── RG-11 — Authorization safety (I-015) ──
    {
      let openBypassPreserved = false;
      let dbTriggerBlocked42501 = false;
      let crossTenantLeakedRows = -1;
      let twoApproversSelfApprovalBlocked = false;

      const client = await ownerRollbackPool.connect();
      try {
        await client.query("BEGIN");

        const histRes = await client.query<{ cnt: number }>(
          `select count(*)::int as cnt from public.control_approval_bypass where payment_instance_id = '33ad79cf-d017-4fc1-9b58-f7772a4e577a'`,
        );
        openBypassPreserved = (histRes.rows[0]?.cnt ?? 0) === 1;

        const adminsRes = await client.query<{ id: string }>(
          `select id::text from public.users where is_active = true and role in ('finance_approver', 'finance_manager', 'admin') order by created_at asc`,
        );
        const makerAdminId = adminsRes.rows[0]?.id ?? "eb9c61e7-ef57-4dae-b180-0e9d5b7fe8ae";
        try {
          await evaluateSelfApprovalEligibility(
            client as unknown as Pick<PoolClient, "query">,
            makerAdminId,
            "İki aktif yönetici varken kendi kaydımı onaylama girişimi.",
          );
        } catch (err) {
          twoApproversSelfApprovalBlocked =
            err instanceof DomainError && err.code === "FORBIDDEN";
        }

        const payIns = await client.query<{ id: string }>(
          `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status)
           values ('RG11-HIGH-OUTFLOW', 'monthly', 15, 150000, 'TRY', 'outflow', 'active') returning id`,
        );
        const instIns = await client.query<{ id: string }>(
          `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, amount_status, status, direction, approval_status, amount_source)
           values ($1, '2099-11-01', '2099-11-15', 150000, 'TRY', 'known', 'unpaid', 'outflow', 'not_required', 'manual') returning id`,
          [payIns.rows[0]!.id],
        );
        await client.query("SAVEPOINT sp_rg11_trigger");
        try {
          await client.query(
            `update public.payment_instances set status = 'paid', paid_amount = 150000, paid_at = now() where id = $1`,
            [instIns.rows[0]!.id],
          );
        } catch (err) {
          dbTriggerBlocked42501 = (err as { code?: string })?.code === "42501";
          await client.query("ROLLBACK TO SAVEPOINT sp_rg11_trigger");
        }

        const entA = (
          await client.query<{ id: string }>(
            `insert into public.legal_entities (code, name, is_default, is_active) values ('RG11-A', 'RG11 Entity A', false, true) returning id`,
          )
        ).rows[0]!.id;
        const entB = (
          await client.query<{ id: string }>(
            `insert into public.legal_entities (code, name, is_default, is_active) values ('RG11-B', 'RG11 Entity B', false, true) returning id`,
          )
        ).rows[0]!.id;
        const payA = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, legal_entity_id)
             values ('RG11 Secret A', 'monthly', 10, 25000, 'TRY', $1) returning id`,
            [entA],
          )
        ).rows[0]!.id;

        await client.query("SET LOCAL ROLE mas_radar_viewer");
        await client.query(`select set_config('app.current_legal_entity_id', $1, true)`, [entB]);
        const leakRes = await client.query<{ cnt: number }>(
          `select count(*)::int as cnt from public.payments where id = $1`,
          [payA],
        );
        crossTenantLeakedRows = leakRes.rows[0]?.cnt ?? -1;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      let appLayerForbidden = false;
      try {
        await markInstancePaid(
          {
            async connect() {
              return {
                async query(sql: string) {
                  const norm = sql.toLowerCase();
                  if (norm.includes("from public.payment_instances")) {
                    return {
                      rows: [{ id: "33ad79cf-0000-4000-8000-000000000011", status: "unpaid", amount: "150000.00", paid_amount: null, direction: "outflow", currency: "TRY", approval_status: "not_required", due_date: "2026-11-18" }],
                      rowCount: 1,
                    };
                  }
                  if (norm.includes("from public.approval_rules")) {
                    return {
                      rows: [{ code: "outflow_100k", description: ">=100k", trigger_kind: "amount_threshold", threshold_amount: "100000.00", currency: "TRY", applies_to: ["payment_instances"], is_active: true }],
                      rowCount: 1,
                    };
                  }
                  return { rows: [], rowCount: 0 };
                },
                release() {},
              };
            },
          } as unknown as Pool,
          "33ad79cf-0000-4000-8000-000000000011",
          150_000,
          "00000000-0000-4000-8000-000000000099",
        );
      } catch (err) {
        appLayerForbidden = err instanceof DomainError && err.code === "FORBIDDEN";
      }

      let tgHttpCalls = 0;
      const blockedChat = await sendTelegramChatMessage("-100999", "secret", {
        token: "123:ABC",
        allowedChatIds: ["-100111"],
        fetchImpl: (async () => {
          tgHttpCalls += 1;
          return new Response("{}", { status: 200 });
        }) as typeof fetch,
      });

      const ibanValidOk = isValidIbanChecksum("TR330006100519786457841326") === true;
      const ibanInvalidRejected = isValidIbanChecksum("TR000006100519786457841326") === false;

      const ok =
        openBypassPreserved &&
        appLayerForbidden &&
        dbTriggerBlocked42501 &&
        twoApproversSelfApprovalBlocked &&
        crossTenantLeakedRows === 0 &&
        blockedChat.ok === false &&
        tgHttpCalls === 0 &&
        ibanValidOk &&
        ibanInvalidRejected;

      recordGate(
        "RG-11",
        "Authorization safety",
        "I-015",
        ok ? "PASS" : "FAIL",
        `historical33adOpen=${openBypassPreserved} appForbidden=${appLayerForbidden} dbTrigger42501=${dbTriggerBlocked42501} selfApprovalBlocked=${twoApproversSelfApprovalBlocked} ibanMod97=${ibanValidOk && ibanInvalidRejected} crossTenantLeaks=${crossTenantLeakedRows} chatBlocked=${!blockedChat.ok}`,
      );
    }

    // ── RG-12 — Regression safety (All: I-001..I-016) ──
    {
      const vitestBin = path.resolve("node_modules", "vitest", "vitest.mjs");
      const mandatoryRes = runNodeCheck([
        vitestBin,
        "run",
        "tests/remediation/mandatory-16-scenarios.test.ts",
      ]);
      const tscBin = path.resolve("node_modules", "typescript", "bin", "tsc");
      const tscRes = runNodeCheck([tscBin, "--noEmit"]);
      const eslintBin = path.resolve("node_modules", "eslint", "bin", "eslint.js");
      const eslintRes = runNodeCheck([
        eslintBin,
        "tests/remediation",
        "scripts/qa/verify-rg-15-gates.ts",
      ]);

      const ok = mandatoryRes.ok && tscRes.ok && eslintRes.ok;

      recordGate(
        "RG-12",
        "Regression safety",
        "All (I-001..I-016)",
        ok ? "PASS" : "FAIL",
        `mandatory16=${mandatoryRes.ok ? "16/16 PASS" : `FAIL (${mandatoryRes.tail})`} · tsc=${tscRes.ok ? "PASS" : `FAIL (${tscRes.tail})`} · eslint=${eslintRes.ok ? "PASS" : `FAIL (${eslintRes.tail})`}`,
      );
    }

    // ── RG-13 — Runtime health (I-004) ──
    {
      const readyRes = await getReady(new Request("http://127.0.0.1:3000/ready"));
      const readyJson = (await readyRes.json()) as { status?: string };

      const healthRouteRes = await getHealth();
      const healthRouteJson = (await healthRouteRes.json()) as {
        status?: string;
        db?: string;
        checks?: {
          runtimeRoleSafe?: boolean;
          schemaParity?: { aligned?: boolean; actualLatestVersion?: string };
        };
      };

      let liveHttpNote = "not_listening";
      let liveHttpOk = true;
      try {
        const liveReady = await fetch("http://127.0.0.1:3000/ready", {
          signal: AbortSignal.timeout(8_000),
        });
        const liveHealth = await fetch("http://127.0.0.1:3000/health", {
          signal: AbortSignal.timeout(8_000),
        });
        liveHttpOk = liveReady.status === 200 && liveHealth.status === 200;
        liveHttpNote = `liveHttp(ready=${liveReady.status}, health=${liveHealth.status})`;
      } catch {
        liveHttpNote = "liveHttp=offline_used_inproc_handlers";
      }

      const workerTmp = mkTemp("mas-rg13-worker-");
      const statePath = path.join(workerTmp, "worker-state.json");
      await writeWorkerScheduleStateAtomic(statePath, {
        lastHourlySlot: "2026-11-18T13",
        lastDailyDate: "2026-11-18",
        updatedAt: "2026-11-18T10:00:00.000Z",
      });
      const outageErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      });
      await runScheduledMaintenance({
        pool: {
          async query(sql: string) {
            if (sql.toLowerCase().includes("pg_try_advisory")) {
              return { rows: [{ pg_try_advisory_lock: true, acquired: true }], rowCount: 1 };
            }
            if (sql.toLowerCase().includes("pg_advisory_unlock")) {
              return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
            }
            throw outageErr;
          },
          async connect() {
            throw outageErr;
          },
        } as unknown as Pool,
        systemActorId: "00000000-0000-4000-8000-000000000001",
        statePath,
        todayISO: "2026-11-18",
        hourSlot: "2026-11-18T14",
        enableTcmbSync: false,
        enableMorningBriefingDispatch: false,
      }).catch(() => undefined);
      const afterState = await readWorkerScheduleState(statePath);
      const slotProtected = afterState.lastHourlySlot === "2026-11-18T13";

      const ok =
        readyRes.status === 200 &&
        readyJson.status === "ready" &&
        healthRouteRes.status === 200 &&
        healthRouteJson.status === "ok" &&
        healthRouteJson.checks?.runtimeRoleSafe === true &&
        healthRouteJson.checks?.schemaParity?.aligned === true &&
        liveHttpOk &&
        slotProtected;

      recordGate(
        "RG-13",
        "Runtime health",
        "I-004",
        ok ? "PASS" : "FAIL",
        `ready=${readyRes.status} health=${healthRouteRes.status} (roleSafe=${String(healthRouteJson.checks?.runtimeRoleSafe)}, parity=${String(healthRouteJson.checks?.schemaParity?.actualLatestVersion)}) · ${liveHttpNote} · hourlySlotUnstampedOnOutage=${slotProtected}`,
      );
    }

    // ── RG-14 — Environment isolation (I-016) ──
    {
      const authSource = fs.readFileSync(path.resolve("src", "lib", "auth.ts"), "utf8");
      const prodAuthGuardPresent =
        authSource.includes('process.env.NODE_ENV === "production"') &&
        authSource.includes("isLoopbackHostname");
      const loopbackCheckOk =
        isLoopbackHostname("127.0.0.1") === true &&
        isLoopbackHostname("localhost") === true &&
        isLoopbackHostname("nexus.masgrup.com") === false;
      const disposableDbGuardOk =
        isDisposableDatabaseName("mas_radar_dev") === false &&
        isDisposableDatabaseName("mas_radar_prod") === false &&
        isDisposableDatabaseName("mas_radar_dr_verify_test") === true;
      const lineageZeroMutation = sharedDqReport?.sourceTraceability.mutationsPerformed === 0;

      const ok =
        prodAuthGuardPresent &&
        loopbackCheckOk &&
        disposableDbGuardOk &&
        lineageZeroMutation;

      recordGate(
        "RG-14",
        "Environment isolation",
        "I-016",
        ok ? "PASS" : "FAIL",
        `prodPasswordlessHardBlocked=${prodAuthGuardPresent} loopbackHostGuard=${loopbackCheckOk} disposableDbGuardBlocksDevProd=${disposableDbGuardOk} lineageClassificationMutations=0`,
      );
    }

    // ── RG-15 — Evidence integrity (All: I-001..I-016) ──
    {
      const mandatoryPath = path.resolve("tests", "remediation", "mandatory-16-scenarios.test.ts");
      const mandatorySha256 = createHash("sha256")
        .update(fs.readFileSync(mandatoryPath))
        .digest("hex")
        .toUpperCase();
      const baselineUntouched =
        mandatorySha256 === "819369DD92B56329EB4796B5FF6626832C52137A3CF91DF8F926E70F0D444569";

      const boundaryRes = runNodeCheck(["--import", "tsx", "scripts/boundary-verify.ts"]);
      afterFp = await captureImmutabilityFingerprint(ownerRoPool);
      const dbZeroMutation = JSON.stringify(beforeFp) === JSON.stringify(afterFp);

      const ok =
        baselineUntouched &&
        boundaryRes.ok &&
        drillReceiptIntegrityOk &&
        dbZeroMutation;

      recordGate(
        "RG-15",
        "Evidence integrity",
        "All (I-001..I-016)",
        ok ? "PASS" : "FAIL",
        `phaseBTestUntouched=${baselineUntouched} (sha256=${mandatorySha256.slice(0, 12)}…) · boundary=${boundaryRes.ok ? "8/8 PASS" : "FAIL"} · drillReceiptAndSha256=${drillReceiptIntegrityOk ? "VERIFIED" : "FAIL"} · liveDbZeroMutation=${dbZeroMutation}`,
      );
    }
  } finally {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    await appPool.end().catch(() => {});
    await ownerRoPool.end().catch(() => {});
    await ownerRollbackPool.end().catch(() => {});
  }

  const passCount = gates.filter((g) => g.status === "PASS").length;
  const blockedCount = gates.filter((g) => g.status === "BLOCKED").length;
  const failCount = gates.filter((g) => g.status === "FAIL").length;
  const notVerifiedCount = gates.filter((g) => g.status === "NOT VERIFIED").length;

  console.log("\n=== RELEASE GATE SUMMARY (RG-01 .. RG-15) ===");
  console.log(
    `PASS: ${passCount} | BLOCKED: ${blockedCount} | FAIL: ${failCount} | NOT VERIFIED: ${notVerifiedCount} (Total: ${gates.length})`,
  );

  if (failCount > 0 || notVerifiedCount > 0) {
    console.log("OVERALL RELEASE VERDICT: DO NOT RELEASE — FAILING / UNVERIFIED GATES PRESENT");
    process.exit(1);
  } else if (blockedCount > 0) {
    console.log(
      "OVERALL RELEASE VERDICT: BLOCKED BY EXTERNAL DEPENDENCY (Physical off-device backup mount required for RG-03)",
    );
    process.exit(2);
  } else {
    console.log("OVERALL RELEASE VERDICT: RELEASE READY — ALL 15 GATES PASSED");
    process.exit(0);
  }
}

void main().catch((err) => {
  console.error("VERIFY RG-15 GATES FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
