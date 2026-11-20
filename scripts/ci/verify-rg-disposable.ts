/**
 * MAS Nexus — Disposable CI Release Gates Verifier (`RG-01`..`RG-15` CI Subset + `G-03`..`G-05`, `F-12`).
 *
 * Runs strictly against an explicitly provisioned disposable PostgreSQL database:
 *   - `MIGRATION_DATABASE_URL` -> disposable DB owner (`postgres`)
 *   - `DATABASE_URL`           -> disposable DB least-privilege runtime role (`mas_radar_app`)
 *
 * SAFETY & HONESTY INVARIANTS:
 * 1. Refuses any non-disposable database (`mas_radar_dev`, `mas_radar_prod`, `postgres`, etc.) via
 *    `isDisposableDatabaseName()` BEFORE opening a single socket, and never prints credentials.
 * 2. Zero outbound network calls (all Telegram/HTTP probes use deterministic mock transports).
 * 3. NEVER fakes physical off-device backup hardware (`RG-03`) on GitHub runners: verifies backup
 *    staging, SHA-256, rollback-safe replacement, `LOCAL_STANDIN` rejection, and sole-verified
 *    retention as `RG-03-TOOLING = PASS`, while explicitly labeling physical USB/NAS verification
 *    as `HOST_GATE_REQUIRED`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

import {
  DISPOSABLE_MARKERS,
  PROTECTED_DB_NAMES,
  databaseNameFromUrl,
  isDisposableDatabaseName,
} from "../db/owner-url";

export type CiGateStatus = "PASS" | "FAIL" | "HOST_GATE_REQUIRED";

export interface CiGateRecord {
  id: string;
  title: string;
  status: CiGateStatus;
  evidence: string;
}

export interface ValidatedDisposableCiRgEnv {
  dbName: string;
  ownerUrl: string;
  appUrl: string;
}

function normalizeLoopbackUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.hostname.toLowerCase() === "localhost") {
    parsed.hostname = "127.0.0.1";
  }
  return parsed.toString();
}

/**
 * Pure fail-closed environment validator for disposable CI release-gate execution (`F-12`).
 * Never prints connection strings or passwords.
 */
export function assertDisposableCiRgEnv(
  procEnv: Readonly<Record<string, string | undefined>> = process.env,
): ValidatedDisposableCiRgEnv {
  const rawOwner = procEnv.MIGRATION_DATABASE_URL?.trim() ?? "";
  const rawApp = procEnv.DATABASE_URL?.trim() ?? "";

  if (!rawOwner || !rawApp) {
    throw new Error(
      "GÜVENLİK DURDURMASI (verify-rg-disposable): MIGRATION_DATABASE_URL ve DATABASE_URL açıkça tanımlanmalıdır.",
    );
  }

  const ownerDb = databaseNameFromUrl(rawOwner);
  const appDb = databaseNameFromUrl(rawApp);

  for (const [label, db] of [
    ["MIGRATION_DATABASE_URL", ownerDb],
    ["DATABASE_URL", appDb],
  ] as const) {
    if (!db || !isDisposableDatabaseName(db)) {
      const shown = db ?? "(okunamadı)";
      const why =
        db !== undefined && PROTECTED_DB_NAMES.includes(db.toLowerCase())
          ? `'${shown}' korunan bir veritabanı — CI RG betiği ona ASLA bağlanmaz.`
          : `'${shown}' disposable işaretlerinden hiçbirini taşımıyor (${DISPOSABLE_MARKERS.join(", ")}).`;
      throw new Error(`GÜVENLİK DURDURMASI (verify-rg-disposable) [${label}]: ${why}`);
    }
  }

  if (ownerDb !== appDb) {
    throw new Error(
      `GÜVENLİK DURDURMASI (verify-rg-disposable): MIGRATION_DATABASE_URL ('${ownerDb}') ve DATABASE_URL ('${appDb}') veritabanı adları eşleşmiyor (mismatch).`,
    );
  }

  return {
    dbName: ownerDb!,
    ownerUrl: normalizeLoopbackUrl(rawOwner),
    appUrl: normalizeLoopbackUrl(rawApp),
  };
}

async function main(): Promise<void> {
  const validated = assertDisposableCiRgEnv(process.env);
  process.env.DATABASE_URL = validated.appUrl;
  process.env.MIGRATION_DATABASE_URL = validated.ownerUrl;

  const [
    { GET: getHealth },
    { GET: getReady },
    { evaluateSelfApprovalEligibility },
    { buildOvernightDeltaAttribution },
    { loadHybridMonthDetail },
    { computeObligationAmounts },
    { isValidIbanChecksum },
    { evaluateRemediationDataQuality },
    { checkSchemaParity, readExpectedSchemaManifest },
    { DomainError },
    { isLoopbackHostname },
    { loadCanonicalTreasuryCashKpi },
    { looksLikeSecret, redactSecrets },
    { evaluateOffDeviceRunLog, jobsStuckAlert, ledgerAlert, reconciliationAlert, runtimeIdentityAlert },
    { assertAccountingPeriodUnlockedWithClient, markInstancePaid },
    { mapInstanceRow, monthSummary },
    { eligibleMaturityDeliveries },
    {
      claimAndDispatchOutbox,
      computeNotificationIdempotencyKey,
      enqueueOutboxNotification,
      evaluateAndRecordOpsIncidents,
      recoverStaleOutboxClaims,
      resolveOpsIncidentVerified,
    },
    {
      ESCALATION_BUCKET_LABELS,
      buildReminderDigestHtml,
      buildReminderMessage,
      classifyEscalationBucket,
      containsUnsubstantiatedLegalClaim,
      daysOverdue,
      isChronicHistoricalOverdue,
      matchesReminderOffset,
      sanitizeReminderLegalWording,
    },
    {
      TELEGRAM_HTML_SAFE_MAX_CHARS,
      escapeTelegramHtml,
      scrubSensitiveTelegramText,
      sendTelegramChatMessage,
      splitTelegramHtmlMessage,
    },
    { loadBoardFinancialPackage },
    { buildDailyReport, istanbulDateISO },
    { getPool },
    { readWorkerScheduleState, runScheduledMaintenance, writeWorkerScheduleStateAtomic },
    { classifyOffDeviceTarget, copyToTargetVerified, planPrune, sha256OfFile },
  ] = await Promise.all([
    import("../../src/app/health/route"),
    import("../../src/app/ready/route"),
    import("../../src/lib/approvals/engine"),
    import("../../src/lib/briefing/delta-attribution"),
    import("../../src/lib/cashflow/live-hybrid"),
    import("../../src/lib/contracts/remediation-contracts"),
    import("../../src/lib/counterparties/rules"),
    import("../../src/lib/data-quality/remediation-metrics"),
    import("../../src/lib/db/schema-parity"),
    import("../../src/lib/domain-error"),
    import("../../src/lib/env"),
    import("../../src/lib/metrics/canonical-kpis"),
    import("../../src/lib/ops/alert-delivery"),
    import("../../src/lib/ops/telemetry-alerts"),
    import("../../src/lib/radar/engine"),
    import("../../src/lib/radar/queries"),
    import("../../src/lib/reminders/engine"),
    import("../../src/lib/reminders/outbox"),
    import("../../src/lib/reminders/rules"),
    import("../../src/lib/reminders/transport"),
    import("../../src/lib/reports/board-pack"),
    import("../../src/lib/reports/rules"),
    import("../../src/lib/db"),
    import("../ops/background-worker"),
    import("../ops/backup-lib"),
  ]);

  const appPool = new Pool({
    connectionString: validated.appUrl,
    max: 2,
    connectionTimeoutMillis: 30_000,
  });
  const ownerPool = new Pool({
    connectionString: validated.ownerUrl,
    max: 3,
    connectionTimeoutMillis: 30_000,
  });

  const gates: CiGateRecord[] = [];
  const tempDirs: string[] = [];

  const mkTemp = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  const recordGate = (id: string, title: string, status: CiGateStatus, evidence: string): void => {
    gates.push({ id, title, status, evidence });
    console.log(`${status.padEnd(20)} [${id} — ${title}]\n                     ${evidence}`);
  };

  try {
    console.log(
      `=== MAS NEXUS — DISPOSABLE CI RELEASE GATES (target='${validated.dbName}') ===\n`,
    );

    // ── RG-01 — Database reliability ──
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

      const catRes = await ownerPool.query<{
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
            `insert into public.schema_migrations (version, name, checksum) values ('9999', 'rg01_ci_probe', '0')`,
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
        r?.db === validated.dbName &&
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
        "Database reliability (disposable PG)",
        ok ? "PASS" : "FAIL",
        `db=${r?.db} user=${r?.usr} super=${r?.rolsuper} bypassrls=${r?.rolbypassrls} inherit=${r?.rolinherit} RLS=${c.rls_tables}/${c.total_tables} invokerViews=${c.invoker_views}/${c.total_views} writableViews=${c.writable_views} ledger42501=${ledgerWriteDenied}`,
      );
    }

    // ── RG-02 — Schema consistency ──
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
        manifest.expectedCount >= 125 &&
        manifest.expectedLatestVersion >= "0125" &&
        /^[0-9a-f]{64}$/.test(liveParity.checksumDigest ?? "") &&
        mockDriftParity.aligned === false &&
        ledgerAlert("115/0115", `${manifest.expectedCount}/${manifest.expectedLatestVersion}`) === true &&
        ledgerAlert("?", "?") === true;

      recordGate(
        "RG-02",
        "Schema consistency & checksum parity",
        ok ? "PASS" : "FAIL",
        `aligned=${liveParity.aligned} ledger=${liveParity.actualCount}/${liveParity.actualLatestVersion} expected=${manifest.expectedCount}/${manifest.expectedLatestVersion} checksum=${liveParity.checksumDigest?.slice(0, 16)}… driftDetected=${!mockDriftParity.aligned}`,
      );
    }

    // ── RG-03-TOOLING & RG-03 — Backup tooling vs physical hardware honesty ──
    {
      const srcTmp = mkTemp("mas-ci-rg03-src-");
      const dstTmp = mkTemp("mas-ci-rg03-dst-");
      const dumpName = "daily-2026-11-20T00-00-00-000Z.dump";
      const srcDump = path.join(srcTmp, dumpName);
      const v1Payload = Buffer.from("PGDMP-CI-RG03-VERIFIED-V1", "utf8");
      fs.writeFileSync(srcDump, v1Payload);

      const copyV1 = copyToTargetVerified(srcDump, dstTmp, { sourceDir: srcTmp });
      const v1Sha = sha256OfFile(path.join(dstTmp, dumpName));

      // Attempt corrupt/unreadable TOC overwrite and prove prior verified v1 survives untouched (F-10)
      fs.writeFileSync(srcDump, Buffer.from("PGDMP-CI-RG03-CORRUPT-V2", "utf8"));
      let corruptRejected = false;
      try {
        copyToTargetVerified(srcDump, dstTmp, {
          sourceDir: srcTmp,
          verifyListable: () => {
            throw new Error("pg_restore: [archiver] input file appears to be corrupt");
          },
        });
      } catch {
        corruptRejected = true;
      }
      const preservedAfterFailure =
        fs.existsSync(path.join(dstTmp, dumpName)) &&
        sha256OfFile(path.join(dstTmp, dumpName)) === v1Sha;

      const sameUncRejected =
        classifyOffDeviceTarget("\\\\nas-backup\\mas_radar_dev", "\\\\nas-backup\\mas_radar_dev")
          .offDeviceSatisfied === false;
      const localStandinRejected =
        classifyOffDeviceTarget(dstTmp, srcTmp).offDeviceSatisfied === false;

      const pruneRes = planPrune(
        [
          {
            name: "daily-2026-11-19T02-00-00-000Z.dump",
            fullPath: "/backups/daily-2026-11-19T02-00-00-000Z.dump",
            bytes: 1024,
            timestamp: new Date("2026-11-19T02:00:00.000Z"),
            timestampSource: "filename",
            label: "daily",
            retentionClass: "rolling",
            immutableReason: null,
            sidecars: [],
          },
          {
            name: "daily-2025-10-01T02-00-00-000Z.dump",
            fullPath: "/backups/daily-2025-10-01T02-00-00-000Z.dump",
            bytes: 1024,
            timestamp: new Date("2025-10-01T02:00:00.000Z"),
            timestampSource: "filename",
            label: "daily",
            retentionClass: "rolling",
            immutableReason: null,
            sidecars: ["/backups/daily-2025-10-01T02-00-00-000Z.dump.sha256"],
          },
        ],
        { daily: 1, weekly: 1, monthly: 1, minAgeHours: 24 },
        new Date("2026-11-20T12:00:00.000Z"),
      );
      const soleVerifiedKept =
        pruneRes.decisions.find((d) => d.entry.name.startsWith("daily-2025-10-01"))?.keep === true;
      const enoentTelemetry = evaluateOffDeviceRunLog(
        JSON.stringify({
          ok: false,
          exitCode: 3,
          stage: "offdevice",
          offDeviceOk: false,
          offDeviceNote: "ENOENT: physical backup drive unmounted",
        }),
      );

      const toolingOk =
        copyV1.sha256Match &&
        copyV1.bytesMatch &&
        corruptRejected &&
        preservedAfterFailure &&
        sameUncRejected &&
        localStandinRejected &&
        soleVerifiedKept &&
        enoentTelemetry.alert === true;

      recordGate(
        "RG-03-TOOLING",
        "Backup staging, rollback-safe promotion & retention guards",
        toolingOk ? "PASS" : "FAIL",
        `sha256Copy=${copyV1.sha256Match} rollbackPreservedV1=${preservedAfterFailure} localStandinRejected=${localStandinRejected} soleVerifiedKept=${soleVerifiedKept} enoentAlert=${enoentTelemetry.alert}`,
      );
      recordGate(
        "RG-03",
        "Physical off-device USB/NAS target verification",
        "HOST_GATE_REQUIRED",
        "GitHub/disposable CI runner cannot mount physical operator USB/NAS media; physical RG-03 remains a host-only release gate and is NEVER faked as PASS in CI.",
      );
    }

    // ── RG-04 & RG-05 + G-04 — Financial correctness, payment accuracy & UNKNOWN != 0 ──
    {
      let summaryOk = false;
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        const payId = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status)
             values ('RG04-SYNTH-PAYMENT', 'monthly', 10, 80000, 'TRY', 'outflow', 'active') returning id`,
          )
        ).rows[0]!.id;
        await client.query(
          `insert into public.payment_instances
             (payment_id, instance_month, due_date, amount, paid_amount, currency, amount_status, status, direction, cancelled_at, cancel_reason)
           values
             ($1, '2098-06-01', '2098-06-10', 80000, 30000, 'TRY', 'known', 'partial', 'outflow', null, null),
             ($1, '2098-07-01', '2098-07-10', 50000, null, 'TRY', 'known', 'cancelled', 'outflow', now(), 'RG04-SYNTH-CANCEL')`,
          [payId],
        );
        const sumJun = await monthSummary(client as unknown as Pool, "2098-06-01");
        const sumJul = await monthSummary(client as unknown as Pool, "2098-07-01");
        summaryOk =
          sumJun.known_total === 80_000 &&
          sumJun.paid_known === 30_000 &&
          sumJun.known_remaining === 50_000 &&
          sumJun.unexplainedGapTry === 0 &&
          sumJul.known_total === 0 &&
          sumJul.known_remaining === 0 &&
          sumJul.cancelledKnownTotal === 50_000 &&
          sumJul.unexplainedGapTry === 0;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      const mappedPartial = mapInstanceRow({
        id: "00000000-0000-4000-8000-000000000055",
        payment_id: "00000000-0000-4000-8000-000000000056",
        name: "RG05-SYNTH-KREDI",
        due_date: "2026-11-10",
        amount: "30000.00",
        amount_status: "known",
        status: "partial",
        paid_amount: "12000.00",
        risk_level: "high",
        risk_reasons: ["overdue"],
        note: null,
        currency: "TRY",
      });

      const daily = buildDailyReport(
        {
          dueSoon: [],
          overdue: [
            {
              name: "RG05-SYNTH-KREDI",
              dueDate: "2026-11-10",
              amount: 30_000,
              originalAmount: 30_000,
              paidAmount: 10_000,
              status: "partial",
              riskLevel: "high",
              riskReasons: ["overdue"],
              currency: "TRY",
            },
          ],
          maturities: [],
          criticalThreshold: 100_000,
        },
        "2026-11-18",
      );
      const reminderMsg = buildReminderMessage(
        {
          id: "r8",
          name: "8-30 Gün",
          targetKind: "payment_instance",
          offsetDays: -8,
          channel: "telegram",
          minAmount: null,
          isActive: true,
        },
        {
          entityTable: "payment_instances",
          entityId: "00000000-0000-4000-8000-000000000055",
          name: "RG05-SYNTH-KREDI",
          dueDate: "2026-11-10",
          amount: 30_000,
          originalAmount: 30_000,
          paidAmount: 10_000,
          outstandingAmount: 20_000,
          status: "partial",
          owner: null,
          provider: "SynthBank",
          riskReasons: ["overdue"],
        },
        "2026-11-18",
      );

      const nullObligation = computeObligationAmounts({
        originalAmount: null,
        paidAmount: null,
        status: "unpaid",
      });

      // F-03 / G-04: 42703 missing unknown_opening_count & NULL opening must NEVER coerce to 0
      const cashOn42703 = await loadCanonicalTreasuryCashKpi({
        async query(sql: string) {
          if (
            sql.includes("unknown_opening_count") &&
            !sql.includes("0::int as unknown_opening_count")
          ) {
            throw Object.assign(new Error("column unknown_opening_count does not exist"), {
              code: "42703",
            });
          }
          return {
            rows: [{ currency: "TRY", available_now: "0.00", account_count: 2, unknown_opening_count: 0 }],
            rowCount: 1,
          };
        },
      } as unknown as Pool);

      const cashOnUnknownOpening = await loadCanonicalTreasuryCashKpi({
        async query() {
          return {
            rows: [
              {
                currency: "TRY",
                available_now: "125000.00",
                account_count: 3,
                unknown_opening_count: 1,
              },
            ],
            rowCount: 1,
          };
        },
      } as unknown as Pool);

      // F-14: live-hybrid surfaces SCHEMA_INCOMPATIBLE instead of silent 0 flows
      const hybridDrift = await loadHybridMonthDetail(
        {
          async query() {
            throw Object.assign(new Error("relation bank_transactions does not exist"), {
              code: "42P01",
            });
          },
        } as unknown as Pool,
        "2026-11",
        "2026-11-20",
      );

      const ok =
        summaryOk &&
        mappedPartial.original_amount === 30_000 &&
        mappedPartial.paid_amount === 12_000 &&
        mappedPartial.remaining_amount === 18_000 &&
        daily.overdueKnownTotal === 20_000 &&
        reminderMsg.includes("30.000 TL") &&
        reminderMsg.includes("10.000 TL") &&
        reminderMsg.includes("20.000 TL") &&
        nullObligation.originalAmount === null &&
        nullObligation.outstandingAmount === null &&
        cashOn42703.availableNowTry === null &&
        cashOn42703.cashSourceStatus === "LEGACY_UNVERIFIED" &&
        cashOnUnknownOpening.availableNowTry === null &&
        cashOnUnknownOpening.cashSourceStatus === "PARTIAL_MISSING_OPENING" &&
        hybridDrift !== null &&
        hybridDrift.sourceStatus === "SCHEMA_INCOMPATIBLE" &&
        hybridDrift.opening === null &&
        hybridDrift.closing === null;

      recordGate(
        "RG-04/RG-05",
        "Financial math, partial/cancelled reconciliation & UNKNOWN != 0 (G-04)",
        ok ? "PASS" : "FAIL",
        `monthSummaryCancelledExcluded=${summaryOk} partialRem=${mappedPartial.remaining_amount} nullPreserved=${nullObligation.outstandingAmount === null} cash42703=${String(cashOn42703.availableNowTry)}(${cashOn42703.cashSourceStatus}) hybridDrift=${String(hybridDrift?.sourceStatus)}`,
      );
    }

    // ── RG-06 — Temporal correctness ──
    {
      const trDate = istanbulDateISO(new Date("2026-11-17T21:30:00Z"));
      const day30Bucket = classifyEscalationBucket("2026-10-19", "2026-11-18");
      const day31Bucket = classifyEscalationBucket("2026-10-18", "2026-11-18");
      const label31 = ESCALATION_BUCKET_LABELS[day31Bucket];

      const rules = [
        { id: "r1", name: "1-7", targetKind: "loan_installment" as const, offsetDays: -1, channel: "telegram" as const, minAmount: null, isActive: true },
        { id: "r8", name: "8-30", targetKind: "loan_installment" as const, offsetDays: -8, channel: "telegram" as const, minAmount: null, isActive: true },
        { id: "r31", name: "31+", targetKind: "loan_installment" as const, offsetDays: -31, channel: "telegram" as const, minAmount: null, isActive: true },
      ];
      const eligible364 = eligibleMaturityDeliveries(
        rules,
        [
          {
            entityTable: "loan_installments",
            entityId: "00000000-0000-4000-8000-000000000364",
            name: "Taksit 364",
            dueDate: "2025-11-19",
            amount: 45_000,
            status: "late",
            owner: null,
            provider: "SynthBank",
            riskReasons: [],
          },
        ],
        "2026-11-18",
      );
      const eligible400 = eligibleMaturityDeliveries(
        rules,
        [
          {
            entityTable: "loan_installments",
            entityId: "00000000-0000-4000-8000-000000000400",
            name: "Taksit 400",
            dueDate: "2025-10-14",
            amount: 45_000,
            status: "late",
            owner: null,
            provider: "SynthBank",
            riskReasons: [],
          },
        ],
        "2026-11-18",
      );

      const scrubbedLegal = sanitizeReminderLegalWording("Hukuki takip başlatıldı - İcra başlatıldı");
      const dbRuleNames = await ownerPool.query<{ name: string }>(
        `select name from public.reminders where offset_days = -31`,
      );
      const dbRulesClean = dbRuleNames.rows.every(
        (r) =>
          r.name.includes("31+") &&
          !r.name.includes("30+") &&
          !containsUnsubstantiatedLegalClaim(r.name),
      );

      const ok =
        trDate === "2026-11-18" &&
        matchesReminderOffset(0, "2026-11-18", trDate) &&
        daysOverdue("2025-11-19", "2026-11-18") === 364 &&
        daysOverdue("2025-10-14", "2026-11-18") === 400 &&
        isChronicHistoricalOverdue("2025-11-19", "2026-11-18") === false &&
        isChronicHistoricalOverdue("2025-10-14", "2026-11-18") === true &&
        day30Bucket === "overdue_8_30" &&
        day31Bucket === "overdue_30_plus" &&
        label31.includes("31+") &&
        !containsUnsubstantiatedLegalClaim(label31) &&
        !containsUnsubstantiatedLegalClaim(scrubbedLegal) &&
        eligible364.length === 1 &&
        eligible364[0]!.ruleId === "r31" &&
        eligible400.length === 1 &&
        eligible400[0]!.ruleId === "r31" &&
        dbRulesClean;

      recordGate(
        "RG-06",
        "Temporal boundaries, Istanbul UTC+3 & legal wording safety",
        ok ? "PASS" : "FAIL",
        `istanbul2130Z=${trDate} day30=${day30Bucket} day31=${day31Bucket} 364d=${eligible364[0]?.ruleId} 400d=${eligible400[0]?.ruleId} legalWordingClean=${!containsUnsubstantiatedLegalClaim(scrubbedLegal) && dbRulesClean}`,
      );
    }

    // ── RG-07 & RG-08 + G-05 — Notification deduplication, crash-window safety & incident lifecycle ──
    {
      let dbOutboxUniqueAndCrashSafe = false;
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        const ins1 = await client.query(
          `insert into public.notification_outbox (stream, channel, recipient_target, idempotency_key, body_text, status)
           values ('ops_incident', 'telegram', '-1001', 'rg07-ci-idem-1', 'probe', 'delivery_uncertain')
           on conflict (idempotency_key) do nothing returning id`,
        );
        const ins2 = await client.query(
          `insert into public.notification_outbox (stream, channel, recipient_target, idempotency_key, body_text, status)
           values ('ops_incident', 'telegram', '-1001', 'rg07-ci-idem-1', 'probe', 'pending')
           on conflict (idempotency_key) do nothing returning id`,
        );

        // Pre-send 'sending' stale claim -> MUST become 'delivery_uncertain' (never failed_retryable)
        const staleSending = await client.query<{ id: string }>(
          `insert into public.notification_outbox
             (stream, channel, recipient_target, idempotency_key, body_text, status, claim_token, claimed_at, metadata)
           values
             ('reminder_digest', 'telegram', '-1001', 'rg07-ci-stale-sending', 'digest', 'claiming',
              '11111111-1111-4111-8111-111111111111', now() - interval '25 minutes',
              '{"dispatchPhase":"sending"}'::jsonb)
           returning id`,
        );
        const staleClaimed = await client.query<{ id: string }>(
          `insert into public.notification_outbox
             (stream, channel, recipient_target, idempotency_key, body_text, status, claim_token, claimed_at, metadata)
           values
             ('reminder_digest', 'telegram', '-1001', 'rg07-ci-stale-claimed', 'digest', 'claiming',
              '22222222-2222-4222-8222-222222222222', now() - interval '25 minutes',
              '{"dispatchPhase":"claimed"}'::jsonb)
           returning id`,
        );

        const recovery = await recoverStaleOutboxClaims(client, 10);
        const postSending = await client.query<{ status: string }>(
          `select status from public.notification_outbox where id = $1`,
          [staleSending.rows[0]!.id],
        );
        const postClaimed = await client.query<{ status: string }>(
          `select status from public.notification_outbox where id = $1`,
          [staleClaimed.rows[0]!.id],
        );

        dbOutboxUniqueAndCrashSafe =
          ins1.rowCount === 1 &&
          ins2.rowCount === 0 &&
          recovery.uncertainCount >= 1 &&
          postSending.rows[0]?.status === "delivery_uncertain" &&
          postClaimed.rows[0]?.status === "failed_retryable";
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      // Real PostgreSQL FOR UPDATE SKIP LOCKED concurrent outbox workers -> exact 1 send, 0 duplicates
      const sentMsgs: string[] = [];
      try {
        await enqueueOutboxNotification(ownerPool, {
          stream: "ops_incident",
          channel: "telegram",
          recipientTarget: "-100111",
          idempotencyKey: "rg07-ci-concurrent-race-1",
          bodyText: "RG07 concurrent outbox probe",
        });
        const slowTransportResolver = () => ({
          channel: "telegram" as const,
          async send(body: string) {
            await new Promise((r) => setTimeout(r, 25));
            sentMsgs.push(body);
            return { ok: true, providerMessageId: "msg-ci-1" };
          },
        });
        await Promise.all([
          claimAndDispatchOutbox(ownerPool, { transportResolver: slowTransportResolver }),
          claimAndDispatchOutbox(ownerPool, { transportResolver: slowTransportResolver }),
        ]);
      } finally {
        await ownerPool
          .query(`delete from public.notification_outbox where idempotency_key = 'rg07-ci-concurrent-race-1'`)
          .catch(() => {});
      }

      const resTimeout = await sendTelegramChatMessage("-100111", "test", {
        token: "123:FAKE_TOKEN_NOT_A_SECRET",
        allowedChatIds: ["-100111"],
        fetchImpl: (async () => {
          throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        }) as typeof fetch,
      });

      let recordedOutboxStatus = "";
      await claimAndDispatchOutbox(
        {
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
                        idempotency_key: computeNotificationIdempotencyKey(["ci-rg07", "1"]),
                        subject: null,
                        body_text: "test",
                        body_format: "plain",
                        metadata: { dispatchPhase: "claimed" },
                        claim_token: "33333333-3333-4333-8333-333333333333",
                        attempt_count: 0,
                        max_attempts: 5,
                      },
                    ],
                    rowCount: 1,
                  };
                }
                return { rows: [{ id: "ob-1" }], rowCount: 1 };
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
        } as unknown as Pool,
        {
          transportResolver: () => ({
            channel: "telegram",
            async send() {
              return resTimeout;
            },
          }),
        },
      );

      const escaped = escapeTelegramHtml("[P1] Synth & Bank <Alert>");
      const digest = buildReminderDigestHtml(
        [{ name: "[P1] Synth & Bank", dueDate: "2026-11-18", amount: null, status: "unpaid", riskReasons: ["missing_amount"] }],
        "2026-11-18",
      );
      const chunks = splitTelegramHtmlMessage(`<b><i>${"Synth &amp; Bank kontrol satırı\n".repeat(140)}</i></b>`);
      const balancedChunks = chunks.every(
        (c) =>
          c.length <= TELEGRAM_HTML_SAFE_MAX_CHARS &&
          (c.match(/<b>/g) ?? []).length === (c.match(/<\/b>/g) ?? []).length,
      );
      const scrubbedIban = scrubSensitiveTelegramText(
        ["IBAN: TR", "33 0006 1005 1978 6457 8413 26"].join(""),
      );
      const redacted = redactSecrets(
        ["postgres://mas_radar_app:", "DummyPass_not_a_secret", "@127.0.0.1:5432/mas_radar_ci_verify"].join(""),
        [],
      );
      const remainingSecrets = looksLikeSecret(redacted, []);

      // RG-08 Incident lifecycle
      const incDir = mkTemp("mas-ci-rg08-");
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
      const resolvedEval = await evaluateAndRecordOpsIncidents(null, [], {
        now: new Date("2026-11-18T08:15:00Z"),
        stateFilePath: stateFile,
      });
      const resolvedRec = resolvedEval.records.find((r) => r.signalKey === "db_reachable");

      const p2Eval = await evaluateAndRecordOpsIncidents(
        null,
        [{ signal: "latest_import_age_days", severity: "P2", value: "120", threshold: "<= 45 gün" }],
        { now: t0, stateFilePath: path.join(incDir, "p2.json") },
      );
      const p2Emitted = p2Eval.notifications.some((n) => n.formattedLine.includes("[OPEN][P2]"));

      let unverifiedResolveRejected = false;
      try {
        await resolveOpsIncidentVerified(null, {
          signalKey: "db_reachable",
          stateFilePath: stateFile,
          evidence: {
            verifiedByCheck: "probe",
            verifiedAtISO: "2026-11-18T08:20:00Z",
            measuredValue: "?",
            threshold: "UP",
            summary: "unverified",
          },
        });
      } catch {
        unverifiedResolveRejected = true;
      }

      const ok =
        dbOutboxUniqueAndCrashSafe &&
        sentMsgs.length === 1 &&
        resTimeout.uncertainOutcome === true &&
        recordedOutboxStatus === "delivery_uncertain" &&
        escaped === "[P1] Synth &amp; Bank &lt;Alert&gt;" &&
        !digest.includes("&amp;amp;") &&
        chunks.length >= 2 &&
        balancedChunks &&
        scrubbedIban.includes("TR** **** **** **** **** **26") &&
        remainingSecrets.length === 0 &&
        unknownEval.records.find((r) => r.signalKey === "db_reachable")?.state === "UNKNOWN" &&
        p2Emitted &&
        resolvedRec?.state === "RESOLVED" &&
        resolvedRec.resolutionEvidence != null &&
        unverifiedResolveRejected;

      recordGate(
        "RG-07/RG-08",
        "Outbox crash-window safety, deduplication & incident lifecycle (G-05)",
        ok ? "PASS" : "FAIL",
        `dbUniqueAndStaleSendingUncertain=${dbOutboxUniqueAndCrashSafe} raceSends=${sentMsgs.length} timeoutStatus='${recordedOutboxStatus}' unknownState=UNKNOWN p2Emitted=${p2Emitted} unverifiedResolveRejected=${unverifiedResolveRejected}`,
      );
    }

    // ── RG-09 & RG-10 — Data-quality transparency & CFO report reliability ──
    {
      let emptyFailedExcluded = false;
      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");
        const emptyWb = await client.query<{ id: string }>(
          `insert into public.source_workbooks (original_filename, status, imported_at)
           values ('rg09_ci_empty.xlsx', 'parsed', now()) returning id`,
        );
        const failedWb = await client.query<{ id: string }>(
          `insert into public.source_workbooks (original_filename, status, imported_at, parse_error)
           values ('rg09_ci_failed.xlsx', 'failed', now(), 'corrupt') returning id`,
        );
        const viewRes = await client.query(
          `select id from public.valid_workbook_imports where id = any($1::uuid[])`,
          [[emptyWb.rows[0]!.id, failedWb.rows[0]!.id]],
        );
        emptyFailedExcluded = viewRes.rowCount === 0;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      const dq = await evaluateRemediationDataQuality(ownerPool, {
        asOf: "2026-11-18T12:00:00Z",
        instanceMonthScope: "2026-11-01",
      });

      const deltaUnknown = buildOvernightDeltaAttribution({
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

      const boardA = await loadBoardFinancialPackage(ownerPool, "2026-11-18");
      const boardB = await loadBoardFinancialPackage(ownerPool, "2026-11-18");

      const ok =
        emptyFailedExcluded &&
        dq.consistency.hasZeroJoinMultiplication === true &&
        dq.sourceTraceability.mutationsPerformed === 0 &&
        deltaUnknown.cashDeltaIdentityBalanced !== true &&
        deltaUnknown.identityUnmeasurable === true &&
        deltaUnknown.realizedBankInflows === null &&
        deltaUnknown.realizedBankOutflows === null &&
        /^[0-9a-f]{64}$/.test(boardA.provenance.contentSha256) &&
        boardA.provenance.contentSha256 === boardB.provenance.contentSha256;

      recordGate(
        "RG-09/RG-10",
        "Valid workbook filter, blank != zero & CFO report provenance",
        ok ? "PASS" : "FAIL",
        `emptyFailedExcluded=${emptyFailedExcluded} zeroJoinMult=${dq.consistency.hasZeroJoinMultiplication} unknownCashBalanced=${deltaUnknown.cashDeltaIdentityBalanced} boardShaReproducible=${boardA.provenance.contentSha256 === boardB.provenance.contentSha256}`,
      );
    }

    // ── RG-11 + G-03 — Multi-entity RLS, >=100k approval gate & fail-closed period lock ──
    {
      let dbTriggerBlocked42501 = false;
      let crossEntityLeaks = -1;
      let positiveEntityASeen = 0;
      let lockedPeriodBlocked = false;
      let selfApprovalBlocked = false;

      const client = await ownerPool.connect();
      try {
        await client.query("BEGIN");

        // Ensure >= 2 active admins for maker-checker self-approval gate
        const a1 = (
          await client.query<{ id: string }>(
            `insert into public.users (username, password_hash, display_name, role, is_active)
             values ('rg11_ci_admin_1', 'x', 'RG11 Admin 1', 'admin', true) returning id`,
          )
        ).rows[0]!.id;
        await client.query(
          `insert into public.users (username, password_hash, display_name, role, is_active)
           values ('rg11_ci_admin_2', 'x', 'RG11 Admin 2', 'admin', true)`,
        );

        try {
          await evaluateSelfApprovalEligibility(
            client as unknown as Pick<PoolClient, "query">,
            a1,
            "Self approval probe",
          );
        } catch (err) {
          selfApprovalBlocked = err instanceof DomainError && err.code === "FORBIDDEN";
        }

        // >= 100k unapproved outflow blocked by DB trigger (42501)
        const payHigh = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, direction, status)
             values ('RG11-CI-HIGH', 'monthly', 15, 150000, 'TRY', 'outflow', 'active') returning id`,
          )
        ).rows[0]!.id;
        const instHigh = (
          await client.query<{ id: string }>(
            `insert into public.payment_instances (payment_id, instance_month, due_date, amount, currency, amount_status, status, direction, approval_status, amount_source)
             values ($1, '2099-11-01', '2099-11-15', 150000, 'TRY', 'known', 'unpaid', 'outflow', 'not_required', 'manual') returning id`,
            [payHigh],
          )
        ).rows[0]!.id;

        await client.query("SAVEPOINT sp_ci_rg11_trig");
        try {
          await client.query(
            `update public.payment_instances set status = 'paid', paid_amount = 150000, paid_at = now() where id = $1`,
            [instHigh],
          );
        } catch (err) {
          dbTriggerBlocked42501 = (err as { code?: string })?.code === "42501";
          await client.query("ROLLBACK TO SAVEPOINT sp_ci_rg11_trig");
        }

        // Fail-closed accounting period lock on status = 'locked' (F-02 / G-03)
        await client.query(
          `insert into public.accounting_periods (period_month, status)
           values ('2097-04-01', 'locked')`,
        );
        try {
          await assertAccountingPeriodUnlockedWithClient(client, "2097-04-15");
        } catch (err) {
          lockedPeriodBlocked =
            err instanceof DomainError &&
            (err.code === "CONFLICT" || err.code === "FORBIDDEN");
        }

        // Multi-entity RESTRICTIVE RLS
        const entA = (
          await client.query<{ id: string }>(
            `insert into public.legal_entities (code, name, is_default, is_active)
             values ('RG11-CI-A', 'RG11 CI Entity A', false, true) returning id`,
          )
        ).rows[0]!.id;
        const entB = (
          await client.query<{ id: string }>(
            `insert into public.legal_entities (code, name, is_default, is_active)
             values ('RG11-CI-B', 'RG11 CI Entity B', false, true) returning id`,
          )
        ).rows[0]!.id;
        const payEntA = (
          await client.query<{ id: string }>(
            `insert into public.payments (name, recurrence_type, due_day, default_amount, currency, legal_entity_id)
             values ('RG11 CI Secret A', 'monthly', 10, 25000, 'TRY', $1) returning id`,
            [entA],
          )
        ).rows[0]!.id;

        await client.query("SET LOCAL ROLE mas_radar_viewer");
        await client.query(`select set_config('app.current_legal_entity_id', $1, true)`, [entA]);
        positiveEntityASeen =
          (
            await client.query<{ cnt: number }>(
              `select count(*)::int as cnt from public.payments where id = $1`,
              [payEntA],
            )
          ).rows[0]?.cnt ?? 0;

        await client.query(`select set_config('app.current_legal_entity_id', $1, true)`, [entB]);
        crossEntityLeaks =
          (
            await client.query<{ cnt: number }>(
              `select count(*)::int as cnt from public.payments where id = $1`,
              [payEntA],
            )
          ).rows[0]?.cnt ?? -1;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }

      // Missing schema (42P01) on accounting_periods MUST fail closed (DomainError CONFLICT)
      let missingSchemaPeriodBlocked = false;
      try {
        await assertAccountingPeriodUnlockedWithClient(
          {
            async query() {
              throw Object.assign(new Error("relation accounting_periods does not exist"), {
                code: "42P01",
              });
            },
          } as unknown as PoolClient,
          "2026-11-15",
        );
      } catch (err) {
        missingSchemaPeriodBlocked =
          err instanceof DomainError &&
          err.code === "CONFLICT" &&
          err.message.includes("SCHEMA_INCOMPATIBLE");
      }

      // App-layer >=100k gate
      let appLayerForbidden = false;
      try {
        await markInstancePaid(
          {
            async connect() {
              return {
                async query(sql: string) {
                  const norm = sql.toLowerCase();
                  if (norm.includes("from public.accounting_periods")) {
                    return { rows: [], rowCount: 0 };
                  }
                  if (norm.includes("from public.payment_instances")) {
                    return {
                      rows: [
                        {
                          id: "00000000-0000-4000-8000-000000000011",
                          status: "unpaid",
                          amount: "150000.00",
                          paid_amount: null,
                          direction: "outflow",
                          currency: "TRY",
                          approval_status: "not_required",
                          due_date: "2026-11-18",
                        },
                      ],
                      rowCount: 1,
                    };
                  }
                  if (norm.includes("from public.approval_rules")) {
                    return {
                      rows: [
                        {
                          code: "outflow_100k",
                          description: ">=100k",
                          trigger_kind: "amount_threshold",
                          threshold_amount: "100000.00",
                          currency: "TRY",
                          applies_to: ["payment_instances"],
                          is_active: true,
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
          } as unknown as Pool,
          "00000000-0000-4000-8000-000000000011",
          150_000,
          "00000000-0000-4000-8000-000000000099",
        );
      } catch (err) {
        appLayerForbidden = err instanceof DomainError && err.code === "FORBIDDEN";
      }

      const ibanOk =
        isValidIbanChecksum(["TR", "330006100519786457841326"].join("")) === true &&
        isValidIbanChecksum(["TR", "000006100519786457841326"].join("")) === false;

      const ok =
        positiveEntityASeen === 1 &&
        crossEntityLeaks === 0 &&
        dbTriggerBlocked42501 &&
        appLayerForbidden &&
        selfApprovalBlocked &&
        lockedPeriodBlocked &&
        missingSchemaPeriodBlocked &&
        ibanOk;

      recordGate(
        "RG-11",
        "Multi-entity RLS, maker-checker >=100k & fail-closed period lock (G-03)",
        ok ? "PASS" : "FAIL",
        `entASeen=${positiveEntityASeen} entBLeaks=${crossEntityLeaks} trigger42501=${dbTriggerBlocked42501} appForbidden=${appLayerForbidden} selfApprovalBlocked=${selfApprovalBlocked} periodLockClosed=${lockedPeriodBlocked && missingSchemaPeriodBlocked} ibanMod97=${ibanOk}`,
      );
    }

    // ── RG-13, RG-14 & RG-15 — Runtime health, environment isolation & evidence integrity ──
    {
      const readyRes = await getReady(new Request("http://127.0.0.1:3000/ready"));
      const readyJson = (await readyRes.json()) as { status?: string };
      const healthRes = await getHealth();
      const healthJson = (await healthRes.json()) as {
        status?: string;
        checks?: {
          runtimeRoleSafe?: boolean;
          schemaParity?: { aligned?: boolean; actualLatestVersion?: string };
        };
      };

      const workerTmp = mkTemp("mas-ci-rg13-worker-");
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
      const afterWorker = await readWorkerScheduleState(statePath);
      const slotProtected = afterWorker.lastHourlySlot === "2026-11-18T13";

      const authSrc = fs.readFileSync(path.resolve("src", "lib", "auth.ts"), "utf8");
      const prodAuthGuardPresent =
        authSrc.includes('process.env.NODE_ENV === "production"') &&
        authSrc.includes("isLoopbackHostname");
      const loopbackOk =
        isLoopbackHostname("127.0.0.1") === true &&
        isLoopbackHostname("localhost") === true &&
        isLoopbackHostname("nexus.masgrup.com") === false;
      const dispGuardOk =
        isDisposableDatabaseName("mas_radar_dev") === false &&
        isDisposableDatabaseName("mas_radar_prod") === false &&
        isDisposableDatabaseName("mas_radar_v2_rg_ci_verify") === true;

      const mandatorySha256 = createHash("sha256")
        .update(fs.readFileSync(path.resolve("tests", "remediation", "mandatory-16-scenarios.test.ts")))
        .digest("hex")
        .toUpperCase();
      const baselineTestIntact =
        mandatorySha256 === "819369DD92B56329EB4796B5FF6626832C52137A3CF91DF8F926E70F0D444569";

      const pnpmNodePath = path.resolve("node_modules", ".pnpm", "node_modules");
      let boundaryOk = false;
      try {
        execFileSync(process.execPath, ["--import", "tsx", "scripts/boundary-verify.ts"], {
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, NODE_PATH: pnpmNodePath },
        });
        boundaryOk = true;
      } catch {
        boundaryOk = false;
      }

      const rg13Ok =
        readyRes.status === 200 &&
        readyJson.status === "ready" &&
        healthRes.status === 200 &&
        healthJson.status === "ok" &&
        healthJson.checks?.runtimeRoleSafe === true &&
        healthJson.checks?.schemaParity?.aligned === true &&
        slotProtected;

      const rg14Ok = prodAuthGuardPresent && loopbackOk && dispGuardOk;
      const rg15Ok = baselineTestIntact && boundaryOk;

      recordGate(
        "RG-13",
        "Runtime health & scheduler outage slot protection",
        rg13Ok ? "PASS" : "FAIL",
        `ready=${readyRes.status} health=${healthRes.status} roleSafe=${String(healthJson.checks?.runtimeRoleSafe)} parity=${String(healthJson.checks?.schemaParity?.actualLatestVersion)} slotUnstampedOnOutage=${slotProtected}`,
      );
      recordGate(
        "RG-14",
        "Environment isolation & disposable target guards",
        rg14Ok ? "PASS" : "FAIL",
        `prodQaBypassBlocked=${prodAuthGuardPresent} loopbackGuard=${loopbackOk} disposableGuard=${dispGuardOk}`,
      );
      recordGate(
        "RG-15",
        "Evidence integrity & architectural boundary gate",
        rg15Ok ? "PASS" : "FAIL",
        `mandatory16Sha256Intact=${baselineTestIntact} (${mandatorySha256.slice(0, 12)}…) boundaryVerify8of8=${boundaryOk}`,
      );
    }
  } finally {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
    await getPool().end().catch(() => {});
    await appPool.end().catch(() => {});
    await ownerPool.end().catch(() => {});
  }

  const passCount = gates.filter((g) => g.status === "PASS").length;
  const hostRequiredCount = gates.filter((g) => g.status === "HOST_GATE_REQUIRED").length;
  const failCount = gates.filter((g) => g.status === "FAIL").length;

  console.log("\n=== DISPOSABLE CI RELEASE GATE SUMMARY ===");
  console.log(
    `PASS: ${passCount} | HOST_GATE_REQUIRED: ${hostRequiredCount} | FAIL: ${failCount} (Total: ${gates.length})`,
  );

  if (failCount > 0) {
    console.error("DISPOSABLE CI RELEASE GATES: FAIL");
    process.exit(1);
  }
  console.log(
    "DISPOSABLE CI RELEASE GATES: ALL CI-COMPATIBLE GATES PASS (Physical RG-03 remains HOST_GATE_REQUIRED)",
  );
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((err) => {
    console.error("VERIFY RG DISPOSABLE FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
